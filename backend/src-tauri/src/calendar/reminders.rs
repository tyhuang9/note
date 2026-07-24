use std::{collections::HashMap, str::FromStr, sync::Arc, time::Duration};

use chrono::{Days, LocalResult, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use sqlx::{FromRow, QueryBuilder, Sqlite};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
#[cfg(all(not(test), feature = "desktop-notifications"))]
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::{app_state::AppState, calendar_store::sqlite::SqliteEventStore};

use super::{
    api::ensure_main_window,
    domain::{
        EventId, EventQueryRange, EventRecord, EventTime, OccurrenceRecord,
        MAX_REMINDER_LEAD_MINUTES,
    },
    error::ApiError,
    recurrence::{RecurrenceEngine, Rfc5545RecurrenceEngine},
};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const CLOCK_DRIFT_TOLERANCE_MS: i64 = 2_000;
const HORIZON_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const LOW_WATERMARK_MS: i64 = 24 * 60 * 60 * 1_000;
const GRACE_MS: i64 = 15 * 60 * 1_000;
const MAX_EVENT_CANDIDATES: usize = 2_000;
const MAX_SCHEDULED_DELIVERIES: usize = 10_000;
const MAX_CATCH_UP_DELIVERIES: usize = 3;
const MAX_DUE_DELIVERIES_PER_TICK: usize = 100;
const STATUS_EVENT: &str = crate::events::REMINDER_STATUS_CHANGED;
const STATUS_EVENT_TARGET: &str = "main";
const STALE_DELIVERY_ERROR: &str = "stale_delivery";

type SchedulerResult<T> = Result<T, &'static str>;

#[derive(Clone, Copy, Debug)]
enum WakeReason {
    Mutation,
    Resume,
    Permission,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderCatchUpItem {
    event_id: String,
    occurrence_key: String,
    title: String,
    scheduled_for_utc_ms: i64,
    delivered_at_utc_ms: Option<i64>,
    status: ReminderDeliveryOutcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ReminderDeliveryOutcome {
    Delivered,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentReminderCatchUp {
    items: Vec<ReminderCatchUpItem>,
    delivered_count: usize,
    suppressed_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReminderPermissionStatus {
    Default,
    Granted,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReminderSchedulerStatus {
    WaitingForPermission,
    Ready,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderStatus {
    permission_status: ReminderPermissionStatus,
    scheduler_status: ReminderSchedulerStatus,
    error_code: Option<&'static str>,
    recent_catch_up: RecentReminderCatchUp,
}

impl Default for ReminderStatus {
    fn default() -> Self {
        Self {
            permission_status: ReminderPermissionStatus::Default,
            scheduler_status: ReminderSchedulerStatus::WaitingForPermission,
            error_code: None,
            recent_catch_up: RecentReminderCatchUp::default(),
        }
    }
}

pub struct ReminderState {
    scheduler: Arc<ReminderScheduler>,
    wake_tx: mpsc::UnboundedSender<WakeReason>,
    wake_rx: Mutex<Option<mpsc::UnboundedReceiver<WakeReason>>>,
}

impl ReminderState {
    pub fn new(store: Arc<SqliteEventStore>, app: AppHandle) -> Self {
        let (wake_tx, wake_rx) = mpsc::unbounded_channel();
        Self {
            scheduler: Arc::new(ReminderScheduler::new(store, app)),
            wake_tx,
            wake_rx: Mutex::new(Some(wake_rx)),
        }
    }

    pub fn start(&self) {
        let Ok(mut receiver) = self.wake_rx.try_lock() else {
            return;
        };
        let Some(receiver) = receiver.take() else {
            return;
        };
        let scheduler = self.scheduler.clone();
        tauri::async_runtime::spawn(async move {
            scheduler.run(receiver).await;
        });
    }

    pub fn trigger_mutation(&self) {
        let _ = self.wake_tx.send(WakeReason::Mutation);
    }

    pub fn trigger_resume(&self) {
        let _ = self.wake_tx.send(WakeReason::Resume);
    }

    fn trigger_permission(&self) {
        let _ = self.wake_tx.send(WakeReason::Permission);
    }

    async fn status(&self) -> ReminderStatus {
        self.scheduler.status.lock().await.clone()
    }

    async fn refresh_permission(&self) -> SchedulerResult<ReminderStatus> {
        let permission = permission_status(&self.scheduler.app)?;
        let previous = self.status().await.permission_status;
        self.scheduler.set_permission(permission).await;
        if permission == ReminderPermissionStatus::Granted
            && previous != ReminderPermissionStatus::Granted
        {
            self.trigger_permission();
        }
        Ok(self.status().await)
    }
}

pub fn trigger_reminder_rebuild(window: &WebviewWindow) {
    if let Some(app_state) = window.app_handle().try_state::<AppState>() {
        if let Some(runtime) = app_state.ready_calendar_now() {
            if let Some(state) = runtime.reminders.as_ref() {
                state.trigger_mutation();
            }
        }
    }
}

pub fn trigger_reminder_resume(app: &AppHandle) {
    if let Some(app_state) = app.try_state::<AppState>() {
        if let Some(runtime) = app_state.ready_calendar_now() {
            if let Some(state) = runtime.reminders.as_ref() {
                state.trigger_resume();
            }
        }
    }
}

#[tauri::command]
pub async fn notification_status_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ReminderStatus, ApiError> {
    ensure_main_window(&window)?;
    let runtime = state.calendar_runtime().await?;
    runtime
        .reminders
        .as_ref()
        .ok_or_else(storage_unavailable)?
        .refresh_permission()
        .await
        .map_err(notification_permission_error)
}

#[tauri::command]
pub async fn notification_permission_request(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ReminderStatus, ApiError> {
    ensure_main_window(&window)?;
    let runtime = state.calendar_runtime().await?;
    let reminders = runtime.reminders.as_ref().ok_or_else(storage_unavailable)?;
    request_notification_permission(window.app_handle()).map_err(notification_permission_error)?;
    reminders.trigger_permission();
    reminders
        .refresh_permission()
        .await
        .map_err(notification_permission_error)
}

const fn storage_unavailable() -> ApiError {
    ApiError {
        code: "storage_unavailable",
        message: "Calendar storage is temporarily unavailable.",
        field: None,
    }
}

fn notification_permission_error(_code: &'static str) -> ApiError {
    ApiError {
        code: "notification_permission_failed",
        message: "Note could not read or request desktop notification permission.",

        field: None,
    }
}

struct ReminderScheduler {
    store: Arc<SqliteEventStore>,
    app: AppHandle,
    status: Mutex<ReminderStatus>,
}

impl ReminderScheduler {
    fn new(store: Arc<SqliteEventStore>, app: AppHandle) -> Self {
        Self {
            store,
            app,
            status: Mutex::new(ReminderStatus::default()),
        }
    }

    async fn run(self: Arc<Self>, mut wake_rx: mpsc::UnboundedReceiver<WakeReason>) {
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut rebuild = true;
        let mut recovery = true;
        let mut horizon_end = 0_i64;
        let mut last_wall_ms = Utc::now().timestamp_millis();
        let mut last_tick = std::time::Instant::now();
        let mut last_time_zone: Option<String> = None;

        loop {
            tokio::select! {
                _ = interval.tick() => {}
                reason = wake_rx.recv() => {
                    let Some(reason) = reason else { break; };
                    rebuild = true;
                    recovery |= matches!(reason, WakeReason::Resume | WakeReason::Permission);
                }
            }

            let now = Utc::now().timestamp_millis();
            let elapsed_ms = i64::try_from(last_tick.elapsed().as_millis()).unwrap_or(i64::MAX);
            let expected_wall = last_wall_ms.saturating_add(elapsed_ms);
            if now.abs_diff(expected_wall) > CLOCK_DRIFT_TOLERANCE_MS as u64 {
                rebuild = true;
                recovery = true;
            }
            last_wall_ms = now;
            last_tick = std::time::Instant::now();

            let permission = match permission_status(&self.app) {
                Ok(permission) => permission,
                Err(code) => {
                    self.set_error(ReminderPermissionStatus::Default, code)
                        .await;
                    continue;
                }
            };
            self.set_permission(permission).await;

            let time_zone = match system_time_zone() {
                Ok(zone) => zone,
                Err(code) => {
                    self.set_error(permission, code).await;
                    continue;
                }
            };
            if last_time_zone.as_deref() != Some(time_zone.name()) {
                rebuild = true;
                recovery |= last_time_zone.is_some();
                last_time_zone = Some(time_zone.name().to_owned());
            }
            if horizon_end.saturating_sub(now) <= LOW_WATERMARK_MS {
                rebuild = true;
            }

            if rebuild {
                match self.rebuild(now, time_zone).await {
                    Ok(next_horizon) => {
                        horizon_end = next_horizon;
                        rebuild = false;
                    }
                    Err(code) => {
                        self.set_error(permission, code).await;
                        continue;
                    }
                }
            }

            if permission != ReminderPermissionStatus::Granted {
                self.set_waiting(permission).await;
                continue;
            }

            match self.deliver_due(now, recovery).await {
                Ok(()) => self.set_ready(permission).await,
                Err(code) => self.set_error(permission, code).await,
            }
            recovery = false;
        }
    }

    async fn rebuild(&self, now: i64, time_zone: Tz) -> SchedulerResult<i64> {
        let horizon_end = now
            .checked_add(HORIZON_MS)
            .ok_or("schedule_time_out_of_range")?;
        let schedule_start = now.saturating_sub(GRACE_MS);
        let occurrence_end = horizon_end
            .checked_add(MAX_REMINDER_LEAD_MINUTES * 60_000)
            .ok_or("schedule_time_out_of_range")?;
        let start_date = time_zone
            .timestamp_millis_opt(schedule_start)
            .single()
            .ok_or("system_timezone_unavailable")?
            .date_naive();
        let end_date = time_zone
            .timestamp_millis_opt(occurrence_end)
            .single()
            .ok_or("system_timezone_unavailable")?
            .date_naive()
            .checked_add_days(Days::new(1))
            .ok_or("schedule_time_out_of_range")?;
        let range = EventQueryRange::validated(
            schedule_start,
            occurrence_end,
            &start_date.format("%Y-%m-%d").to_string(),
            &end_date.format("%Y-%m-%d").to_string(),
        )
        .map_err(|_| "schedule_time_out_of_range")?;

        let candidates = self
            .store
            .reminder_schedule_candidates(range.clone(), MAX_EVENT_CANDIDATES + 1)
            .await
            .map_err(|_| "storage_unavailable")?;
        if candidates.len() > MAX_EVENT_CANDIDATES {
            return Err("event_candidate_capacity_exceeded");
        }

        let reminder_ids = load_reminder_ids(&self.store, &candidates).await?;
        let desired = build_desired_deliveries(
            &candidates,
            &reminder_ids,
            &range,
            time_zone,
            schedule_start,
            horizon_end,
        )?;
        reconcile_schedule(&self.store, &desired, now, horizon_end, time_zone.name()).await?;
        Ok(horizon_end)
    }

    async fn deliver_due(&self, now: i64, recovery: bool) -> SchedulerResult<()> {
        let batch = claim_due(&self.store, now, recovery).await?;
        let claimed_generation = batch.reminder_data_generation;
        let mut recent = RecentReminderCatchUp {
            suppressed_count: batch.suppressed_count,
            ..RecentReminderCatchUp::default()
        };
        let has_recovery = recovery && (!batch.items.is_empty() || batch.suppressed_count > 0);
        let mut delivery_failed = false;

        for claimed in batch.items {
            let delivered_at = Utc::now().timestamp_millis();
            let Some(attempt) = dispatch_claimed_delivery(
                &self.store,
                &claimed.id,
                claimed_generation,
                now,
                delivered_at,
                |title, body| show_notification(&self.app, title, body),
            )
            .await?
            else {
                continue;
            };
            let outcome = if attempt.delivered {
                recent.delivered_count += 1;
                ReminderDeliveryOutcome::Delivered
            } else {
                delivery_failed = true;
                ReminderDeliveryOutcome::Failed
            };

            if has_recovery {
                recent.items.push(ReminderCatchUpItem {
                    event_id: attempt.claimed.event_id,
                    occurrence_key: attempt.claimed.occurrence_key,
                    title: attempt.claimed.title,
                    scheduled_for_utc_ms: attempt.claimed.scheduled_utc,
                    delivered_at_utc_ms: matches!(outcome, ReminderDeliveryOutcome::Delivered)
                        .then_some(delivered_at),
                    status: outcome,
                });
            }
        }

        if has_recovery {
            let mut status = self.status.lock().await;
            status.recent_catch_up = recent;
            let snapshot = status.clone();
            drop(status);
            let _ = self
                .app
                .emit_to(STATUS_EVENT_TARGET, STATUS_EVENT, snapshot);
        }
        if delivery_failed {
            Err("notification_delivery_failed")
        } else {
            Ok(())
        }
    }

    async fn set_permission(&self, permission: ReminderPermissionStatus) {
        let mut next = self.status.lock().await.clone();
        next.permission_status = permission;
        if permission != ReminderPermissionStatus::Granted {
            next.scheduler_status = ReminderSchedulerStatus::WaitingForPermission;
            next.error_code = None;
        }
        self.publish(next).await;
    }

    async fn set_waiting(&self, permission: ReminderPermissionStatus) {
        let mut next = self.status.lock().await.clone();
        next.permission_status = permission;
        next.scheduler_status = ReminderSchedulerStatus::WaitingForPermission;
        next.error_code = None;
        self.publish(next).await;
    }

    async fn set_ready(&self, permission: ReminderPermissionStatus) {
        let mut next = self.status.lock().await.clone();
        next.permission_status = permission;
        next.scheduler_status = ReminderSchedulerStatus::Ready;
        next.error_code = None;
        self.publish(next).await;
    }

    async fn set_error(&self, permission: ReminderPermissionStatus, code: &'static str) {
        let mut next = self.status.lock().await.clone();
        next.permission_status = permission;
        next.scheduler_status = ReminderSchedulerStatus::Error;
        next.error_code = Some(code);
        self.publish(next).await;
    }

    async fn publish(&self, next: ReminderStatus) {
        let mut current = self.status.lock().await;
        if *current == next {
            return;
        }
        *current = next.clone();
        drop(current);
        let _ = self.app.emit_to(STATUS_EVENT_TARGET, STATUS_EVENT, next);
    }
}

struct DeliveryAttempt {
    claimed: ClaimedDelivery,
    delivered: bool,
}

async fn dispatch_claimed_delivery<F>(
    store: &SqliteEventStore,
    id: &str,
    expected_generation: u64,
    revalidated_at: i64,
    delivered_at: i64,
    enqueue: F,
) -> SchedulerResult<Option<DeliveryAttempt>>
where
    F: FnOnce(&str, String) -> SchedulerResult<()>,
{
    // The read side is intentionally held only across the final DB
    // revalidation, native enqueue, and outcome write. Calendar mutations take
    // the matching write side, so no edit can commit in the last gap before the
    // notification is handed to the OS.
    let _dispatch_guard = store.reminder_dispatch_guard().await;
    let Some(claimed) =
        revalidate_claimed_delivery(store, id, expected_generation, revalidated_at).await?
    else {
        return Ok(None);
    };
    let delivered = enqueue(&claimed.title, notification_body(claimed.lead_minutes)).is_ok();
    complete_delivery(store, &claimed.id, delivered_at, delivered).await?;
    Ok(Some(DeliveryAttempt { claimed, delivered }))
}

fn notification_body(lead_minutes: i64) -> String {
    match lead_minutes {
        0 => "Starts now".to_owned(),
        1 => "Starts in 1 minute".to_owned(),
        minutes if minutes < 60 => format!("Starts in {minutes} minutes"),
        60 => "Starts in 1 hour".to_owned(),
        minutes if minutes % 1_440 == 0 => format!("Starts in {} day(s)", minutes / 1_440),
        minutes => format!("Starts in {} hour(s)", minutes / 60),
    }
}

#[cfg(all(not(test), feature = "desktop-notifications"))]
fn permission_status(app: &AppHandle) -> SchedulerResult<ReminderPermissionStatus> {
    app.notification()
        .permission_state()
        .map(|state| match state {
            PermissionState::Granted => ReminderPermissionStatus::Granted,
            PermissionState::Denied => ReminderPermissionStatus::Denied,
            PermissionState::Prompt | PermissionState::PromptWithRationale => {
                ReminderPermissionStatus::Default
            }
        })
        .map_err(|_| "notification_permission_failed")
}

#[cfg(any(test, not(feature = "desktop-notifications")))]
fn permission_status(_app: &AppHandle) -> SchedulerResult<ReminderPermissionStatus> {
    Ok(ReminderPermissionStatus::Granted)
}

#[cfg(all(not(test), feature = "desktop-notifications"))]
fn request_notification_permission(app: &AppHandle) -> SchedulerResult<()> {
    app.notification()
        .request_permission()
        .map(|_| ())
        .map_err(|_| "notification_permission_failed")
}

#[cfg(any(test, not(feature = "desktop-notifications")))]
fn request_notification_permission(_app: &AppHandle) -> SchedulerResult<()> {
    Ok(())
}

#[cfg(all(not(test), feature = "desktop-notifications"))]
fn show_notification(app: &AppHandle, title: &str, body: String) -> SchedulerResult<()> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|_| "notification_delivery_failed")
}

#[cfg(any(test, not(feature = "desktop-notifications")))]
fn show_notification(_app: &AppHandle, _title: &str, _body: String) -> SchedulerResult<()> {
    Ok(())
}

fn system_time_zone() -> SchedulerResult<Tz> {
    let name = iana_time_zone::get_timezone().map_err(|_| "system_timezone_unavailable")?;
    Tz::from_str(&name).map_err(|_| "system_timezone_unavailable")
}

#[derive(Clone, Debug)]
struct ReminderDefinition {
    id: String,
    lead_minutes: i64,
}

#[derive(Debug, FromRow)]
struct ReminderDefinitionRow {
    id: String,
    event_id: String,
    occurrence_key: Option<String>,
    lead_minutes: i64,
}

#[derive(Default)]
struct ReminderCatalog {
    master: HashMap<EventId, Vec<ReminderDefinition>>,
    overrides: HashMap<(EventId, String), Vec<ReminderDefinition>>,
}

async fn load_reminder_ids(
    store: &SqliteEventStore,
    events: &[EventRecord],
) -> SchedulerResult<ReminderCatalog> {
    if events.is_empty() {
        return Ok(ReminderCatalog::default());
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT reminders.id,
                COALESCE(event_overrides.parent_event_id, reminders.event_id) AS event_id,
                event_overrides.original_start_key AS occurrence_key,
                reminders.lead_minutes
         FROM reminders
         LEFT JOIN event_overrides
           ON event_overrides.override_event_id = reminders.event_id
         WHERE reminders.event_id IN (",
    );
    let mut separated = query.separated(", ");
    for event in events {
        separated.push_bind(event.id.to_string());
    }
    separated.push_unseparated(") OR event_overrides.parent_event_id IN (");
    let mut separated = query.separated(", ");
    for event in events {
        separated.push_bind(event.id.to_string());
    }
    separated.push_unseparated(") ORDER BY event_id, occurrence_key, lead_minutes");
    let rows = query
        .build_query_as::<ReminderDefinitionRow>()
        .fetch_all(store.pool())
        .await
        .map_err(|_| "storage_unavailable")?;

    let mut definitions = ReminderCatalog::default();
    for row in rows {
        let event_id = EventId::parse(&row.event_id).map_err(|_| "storage_unavailable")?;
        let definition = ReminderDefinition {
            id: row.id,
            lead_minutes: row.lead_minutes,
        };
        if let Some(occurrence_key) = row.occurrence_key {
            definitions
                .overrides
                .entry((event_id, occurrence_key))
                .or_default()
                .push(definition);
        } else {
            definitions
                .master
                .entry(event_id)
                .or_default()
                .push(definition);
        }
    }
    Ok(definitions)
}

#[derive(Clone, Debug)]
struct DesiredDelivery {
    id: String,
    event_id: String,
    reminder_id: String,
    occurrence_key: String,
    event_revision: i64,
    scheduled_utc: i64,
}

fn build_desired_deliveries(
    events: &[EventRecord],
    reminder_ids: &ReminderCatalog,
    range: &EventQueryRange,
    time_zone: Tz,
    schedule_start: i64,
    horizon_end: i64,
) -> SchedulerResult<Vec<DesiredDelivery>> {
    let recurrence = Rfc5545RecurrenceEngine;
    let mut desired = Vec::new();

    for event in events {
        let occurrences = recurrence
            .project_up_to(event, range, MAX_SCHEDULED_DELIVERIES + 1)
            .map_err(|_| "schedule_capacity_exceeded")?;
        for occurrence in occurrences {
            let is_replacement = event.occurrence_overrides.iter().any(|item| {
                item.occurrence_key == occurrence.occurrence_key && item.replacement.is_some()
            });
            let definitions = if is_replacement
                && occurrence.reminder_offsets_minutes != event.reminder_offsets_minutes
            {
                reminder_ids
                    .overrides
                    .get(&(event.id, occurrence.occurrence_key.clone()))
            } else {
                reminder_ids.master.get(&event.id)
            };
            let empty = Vec::new();
            let definitions = definitions.unwrap_or(&empty);
            if definitions
                .iter()
                .map(|definition| definition.lead_minutes)
                .collect::<Vec<_>>()
                != occurrence.reminder_offsets_minutes
            {
                return Err("storage_unavailable");
            }
            append_occurrence_deliveries(
                &mut desired,
                &occurrence,
                definitions,
                time_zone,
                schedule_start,
                horizon_end,
            )?;
        }
    }
    desired.sort_by(|left, right| {
        left.scheduled_utc
            .cmp(&right.scheduled_utc)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(desired)
}

fn append_occurrence_deliveries(
    desired: &mut Vec<DesiredDelivery>,
    occurrence: &OccurrenceRecord,
    definitions: &[ReminderDefinition],
    time_zone: Tz,
    schedule_start: i64,
    horizon_end: i64,
) -> SchedulerResult<()> {
    let occurrence_start = match &occurrence.time {
        EventTime::Timed { start_utc_ms, .. } => *start_utc_ms,
        EventTime::AllDay { start_date, .. } => {
            let midnight = start_date
                .and_hms_opt(0, 0, 0)
                .ok_or("schedule_time_out_of_range")?;
            match time_zone.from_local_datetime(&midnight) {
                LocalResult::Single(value) => value.timestamp_millis(),
                LocalResult::Ambiguous(_, _) => return Err("local_midnight_ambiguous"),
                LocalResult::None => return Err("local_midnight_nonexistent"),
            }
        }
    };

    for reminder in definitions {
        let scheduled_utc = occurrence_start
            .checked_sub(reminder.lead_minutes.saturating_mul(60_000))
            .ok_or("schedule_time_out_of_range")?;
        if scheduled_utc < schedule_start || scheduled_utc >= horizon_end {
            continue;
        }
        if desired.len() >= MAX_SCHEDULED_DELIVERIES {
            return Err("schedule_capacity_exceeded");
        }
        let identity = format!("{}:{}", reminder.id, occurrence.occurrence_key);
        desired.push(DesiredDelivery {
            id: Uuid::new_v5(&Uuid::NAMESPACE_OID, identity.as_bytes()).to_string(),
            event_id: occurrence.event_id.to_string(),
            reminder_id: reminder.id.clone(),
            occurrence_key: occurrence.occurrence_key.clone(),
            event_revision: occurrence.revision,
            scheduled_utc,
        });
    }
    Ok(())
}

async fn reconcile_schedule(
    store: &SqliteEventStore,
    desired: &[DesiredDelivery],
    now: i64,
    horizon_end: i64,
    time_zone: &str,
) -> SchedulerResult<()> {
    let mut transaction = store
        .pool()
        .begin()
        .await
        .map_err(|_| "storage_unavailable")?;
    sqlx::query(
        "CREATE TEMP TABLE IF NOT EXISTS desired_reminder_deliveries (
            id TEXT PRIMARY KEY NOT NULL,
            event_id TEXT NOT NULL,
            reminder_id TEXT NOT NULL,
            occurrence_key TEXT NOT NULL,
            event_revision INTEGER NOT NULL,
            scheduled_utc INTEGER NOT NULL,
            UNIQUE(event_id, occurrence_key, reminder_id)
         )",
    )
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;
    sqlx::query("DELETE FROM desired_reminder_deliveries")
        .execute(&mut *transaction)
        .await
        .map_err(|_| "storage_unavailable")?;

    for chunk in desired.chunks(100) {
        let mut query = QueryBuilder::<Sqlite>::new(
            "INSERT INTO desired_reminder_deliveries (id, event_id, reminder_id, occurrence_key, event_revision, scheduled_utc) ",
        );
        query.push_values(chunk, |mut row, delivery| {
            row.push_bind(&delivery.id)
                .push_bind(&delivery.event_id)
                .push_bind(&delivery.reminder_id)
                .push_bind(&delivery.occurrence_key)
                .push_bind(delivery.event_revision)
                .push_bind(delivery.scheduled_utc);
        });
        query
            .build()
            .execute(&mut *transaction)
            .await
            .map_err(|_| "storage_unavailable")?;
    }

    sqlx::query(
        "UPDATE reminder_deliveries
         SET status = 'failed', failed_at = ?, error_code = 'delivery_state_uncertain', updated_at = ?
         WHERE status = 'claimed'",
    )
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;
    sqlx::query(
        "UPDATE reminder_deliveries
         SET status = 'pending',
             scheduled_utc = (
               SELECT desired.scheduled_utc FROM desired_reminder_deliveries desired
               WHERE desired.event_id = reminder_deliveries.event_id
                 AND desired.occurrence_key = reminder_deliveries.occurrence_key
                 AND desired.reminder_id = reminder_deliveries.reminder_id
             ),
             event_revision = (
               SELECT desired.event_revision FROM desired_reminder_deliveries desired
               WHERE desired.event_id = reminder_deliveries.event_id
                 AND desired.occurrence_key = reminder_deliveries.occurrence_key
                 AND desired.reminder_id = reminder_deliveries.reminder_id
             ),
             claimed_at = NULL, delivered_at = NULL, failed_at = NULL, expired_at = NULL,
             error_code = NULL, updated_at = ?
         WHERE status = 'expired' AND error_code = 'stale_delivery'
           AND EXISTS (
             SELECT 1 FROM desired_reminder_deliveries desired
             WHERE desired.event_id = reminder_deliveries.event_id
               AND desired.occurrence_key = reminder_deliveries.occurrence_key
               AND desired.reminder_id = reminder_deliveries.reminder_id
           )",
    )
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;
    sqlx::query(
        "UPDATE reminder_deliveries
         SET status = 'expired', expired_at = ?, updated_at = ?
         WHERE status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM desired_reminder_deliveries desired
             WHERE desired.event_id = reminder_deliveries.event_id
               AND desired.occurrence_key = reminder_deliveries.occurrence_key
               AND desired.reminder_id = reminder_deliveries.reminder_id
           )",
    )
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;
    sqlx::query(
        "UPDATE reminder_deliveries
         SET scheduled_utc = (
               SELECT desired.scheduled_utc FROM desired_reminder_deliveries desired
               WHERE desired.event_id = reminder_deliveries.event_id
                 AND desired.occurrence_key = reminder_deliveries.occurrence_key
                 AND desired.reminder_id = reminder_deliveries.reminder_id
             ),
             event_revision = (
               SELECT desired.event_revision FROM desired_reminder_deliveries desired
               WHERE desired.event_id = reminder_deliveries.event_id
                 AND desired.occurrence_key = reminder_deliveries.occurrence_key
                 AND desired.reminder_id = reminder_deliveries.reminder_id
             ),
             updated_at = ?
         WHERE status = 'pending'
           AND EXISTS (
             SELECT 1 FROM desired_reminder_deliveries desired
             WHERE desired.event_id = reminder_deliveries.event_id
               AND desired.occurrence_key = reminder_deliveries.occurrence_key
               AND desired.reminder_id = reminder_deliveries.reminder_id
           )",
    )
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;
    sqlx::query(
        "INSERT INTO reminder_deliveries (
           id, event_id, reminder_id, occurrence_key, event_revision, scheduled_utc,
           status, created_at, updated_at
         )
         SELECT desired.id, desired.event_id, desired.reminder_id, desired.occurrence_key,
                desired.event_revision, desired.scheduled_utc, 'pending', ?, ?
         FROM desired_reminder_deliveries desired
         WHERE NOT EXISTS (
           SELECT 1 FROM reminder_deliveries existing
           WHERE existing.event_id = desired.event_id
             AND existing.occurrence_key = desired.occurrence_key
             AND existing.reminder_id = desired.reminder_id
         )",
    )
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;
    sqlx::query(
        "UPDATE reminder_scheduler_state
         SET checkpoint_utc = ?, horizon_end_utc = ?, system_time_zone = ?, updated_at = ?
         WHERE singleton_id = 1",
    )
    .bind(now)
    .bind(horizon_end)
    .bind(time_zone)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;
    transaction
        .commit()
        .await
        .map_err(|_| "storage_unavailable")?;
    Ok(())
}

#[derive(Debug, FromRow)]
struct ClaimedDelivery {
    id: String,
    event_id: String,
    occurrence_key: String,
    scheduled_utc: i64,
    title: String,
    lead_minutes: i64,
}

struct ClaimBatch {
    items: Vec<ClaimedDelivery>,
    suppressed_count: usize,
    reminder_data_generation: u64,
}

async fn claim_due(
    store: &SqliteEventStore,
    now: i64,
    recovery: bool,
) -> SchedulerResult<ClaimBatch> {
    let _dispatch_guard = store.reminder_dispatch_guard().await;
    let mut transaction = store
        .pool()
        .begin()
        .await
        .map_err(|_| "storage_unavailable")?;
    let cutoff = now.saturating_sub(GRACE_MS);
    sqlx::query(
        "UPDATE reminder_deliveries AS deliveries
         SET status = 'expired', expired_at = ?, error_code = 'stale_delivery', updated_at = ?
         WHERE deliveries.status = 'pending'
           AND NOT EXISTS (
             SELECT 1
             FROM events master
             JOIN reminders ON reminders.id = deliveries.reminder_id
             LEFT JOIN event_overrides occurrence_override
               ON occurrence_override.parent_event_id = deliveries.event_id
              AND occurrence_override.original_start_key = deliveries.occurrence_key
             LEFT JOIN events replacement
               ON replacement.id = occurrence_override.override_event_id
             WHERE master.id = deliveries.event_id
               AND master.status = 'confirmed'
               AND master.revision = deliveries.event_revision
               AND (
                 (occurrence_override.id IS NULL AND reminders.event_id = master.id)
                 OR (
                   occurrence_override.override_event_id IS NOT NULL
                   AND replacement.status = 'confirmed'
                   AND reminders.event_id IN (master.id, replacement.id)
                 )
               )
           )",
    )
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;
    let old = sqlx::query(
        "UPDATE reminder_deliveries
         SET status = 'expired', expired_at = ?, updated_at = ?
         WHERE status = 'pending' AND scheduled_utc < ?",
    )
    .bind(now)
    .bind(now)
    .bind(cutoff)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?
    .rows_affected();

    let claim_limit = if recovery {
        MAX_CATCH_UP_DELIVERIES
    } else {
        MAX_DUE_DELIVERIES_PER_TICK
    };
    let candidates = sqlx::query_as::<_, ClaimedDelivery>(
        "SELECT deliveries.id, deliveries.event_id, deliveries.occurrence_key,
                deliveries.scheduled_utc, COALESCE(replacement.title, events.title) AS title,
                reminders.lead_minutes
         FROM reminder_deliveries deliveries
         JOIN events ON events.id = deliveries.event_id
         JOIN reminders ON reminders.id = deliveries.reminder_id
         LEFT JOIN event_overrides
           ON event_overrides.parent_event_id = deliveries.event_id
          AND event_overrides.original_start_key = deliveries.occurrence_key
         LEFT JOIN events replacement ON replacement.id = event_overrides.override_event_id
         WHERE deliveries.status = 'pending'
           AND deliveries.scheduled_utc <= ?
           AND events.status = 'confirmed'
           AND events.revision = deliveries.event_revision
           AND (
             (event_overrides.id IS NULL AND reminders.event_id = events.id)
             OR (
               event_overrides.override_event_id IS NOT NULL
               AND replacement.status = 'confirmed'
               AND reminders.event_id IN (events.id, replacement.id)
             )
           )
         ORDER BY deliveries.scheduled_utc DESC, deliveries.id ASC
         LIMIT ?",
    )
    .bind(now)
    .bind(i64::try_from(claim_limit).unwrap_or(i64::MAX))
    .fetch_all(&mut *transaction)
    .await
    .map_err(|_| "storage_unavailable")?;

    let mut claimed = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let result = sqlx::query(
            "UPDATE reminder_deliveries
             SET status = 'claimed', claimed_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'",
        )
        .bind(now)
        .bind(now)
        .bind(&candidate.id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "storage_unavailable")?;
        if result.rows_affected() == 1 {
            claimed.push(candidate);
        }
    }

    let excess = if recovery {
        sqlx::query(
            "UPDATE reminder_deliveries
             SET status = 'expired', expired_at = ?, updated_at = ?
             WHERE status = 'pending' AND scheduled_utc <= ?",
        )
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "storage_unavailable")?
        .rows_affected()
    } else {
        0
    };
    transaction
        .commit()
        .await
        .map_err(|_| "storage_unavailable")?;

    Ok(ClaimBatch {
        items: claimed,
        suppressed_count: usize::try_from(old.saturating_add(excess)).unwrap_or(usize::MAX),
        reminder_data_generation: store.reminder_data_generation(),
    })
}

async fn revalidate_claimed_delivery(
    store: &SqliteEventStore,
    id: &str,
    expected_generation: u64,
    now: i64,
) -> SchedulerResult<Option<ClaimedDelivery>> {
    let fresh = if store.reminder_data_generation() == expected_generation {
        sqlx::query_as::<_, ClaimedDelivery>(
            "SELECT deliveries.id, deliveries.event_id, deliveries.occurrence_key,
                deliveries.scheduled_utc, COALESCE(replacement.title, events.title) AS title,
                reminders.lead_minutes
         FROM reminder_deliveries deliveries
         JOIN events ON events.id = deliveries.event_id
         JOIN reminders ON reminders.id = deliveries.reminder_id
         LEFT JOIN event_overrides
           ON event_overrides.parent_event_id = deliveries.event_id
          AND event_overrides.original_start_key = deliveries.occurrence_key
         LEFT JOIN events replacement ON replacement.id = event_overrides.override_event_id
         WHERE deliveries.id = ?
           AND deliveries.status = 'claimed'
           AND events.status = 'confirmed'
           AND events.revision = deliveries.event_revision
           AND (
             (event_overrides.id IS NULL AND reminders.event_id = events.id)
             OR (
               event_overrides.override_event_id IS NOT NULL
               AND replacement.status = 'confirmed'
               AND reminders.event_id IN (events.id, replacement.id)
             )
           )",
        )
        .bind(id)
        .fetch_optional(store.pool())
        .await
        .map_err(|_| "storage_unavailable")?
    } else {
        None
    };
    if fresh.is_some() {
        return Ok(fresh);
    }

    sqlx::query(
        "UPDATE reminder_deliveries
         SET status = 'expired', expired_at = ?, error_code = ?, updated_at = ?
         WHERE id = ? AND status = 'claimed'",
    )
    .bind(now)
    .bind(STALE_DELIVERY_ERROR)
    .bind(now)
    .bind(id)
    .execute(store.pool())
    .await
    .map_err(|_| "storage_unavailable")?;
    Ok(None)
}

async fn complete_delivery(
    store: &SqliteEventStore,
    id: &str,
    now: i64,
    delivered: bool,
) -> SchedulerResult<()> {
    let result = if delivered {
        sqlx::query(
            "UPDATE reminder_deliveries
             SET status = 'delivered', delivered_at = ?, updated_at = ?
             WHERE id = ? AND status = 'claimed'",
        )
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(store.pool())
        .await
    } else {
        sqlx::query(
            "UPDATE reminder_deliveries
             SET status = 'failed', failed_at = ?, error_code = 'notification_delivery_failed', updated_at = ?
             WHERE id = ? AND status = 'claimed'",
        )
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(store.pool())
        .await
    }
    .map_err(|_| "storage_unavailable")?;
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err("delivery_state_conflict")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use chrono::NaiveDate;

    use super::*;
    use crate::{
        calendar::domain::{CalendarId, EventDraft},
        calendar_store::EventRepository,
    };

    fn all_day_occurrence(date: NaiveDate) -> OccurrenceRecord {
        let event_id = EventId(Uuid::from_u128(1));
        OccurrenceRecord {
            event_id,
            occurrence_key: format!("{event_id}/all-day/{date}"),
            calendar_id: CalendarId(Uuid::from_u128(2)),
            title: "Day off".into(),
            notes: None,
            location: None,
            time: EventTime::AllDay {
                start_date: date,
                end_date_exclusive: date.succ_opt().unwrap(),
            },
            revision: 1,
            recurrence_rule: None,
            reminder_offsets_minutes: vec![60],
        }
    }

    #[test]
    fn all_day_delivery_uses_current_system_zone_midnight() {
        let occurrence = all_day_occurrence(NaiveDate::from_ymd_opt(2026, 7, 21).unwrap());
        let definitions = vec![ReminderDefinition {
            id: Uuid::from_u128(3).to_string(),
            lead_minutes: 60,
        }];
        let mut desired = Vec::new();
        append_occurrence_deliveries(
            &mut desired,
            &occurrence,
            &definitions,
            Tz::America__Chicago,
            0,
            i64::MAX,
        )
        .unwrap();

        assert_eq!(desired.len(), 1);
        let expected = Tz::America__Chicago
            .with_ymd_and_hms(2026, 7, 21, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis()
            - 60 * 60_000;
        assert_eq!(desired[0].scheduled_utc, expected);
    }

    #[test]
    fn delivery_identity_ignores_event_revision() {
        let occurrence = all_day_occurrence(NaiveDate::from_ymd_opt(2026, 7, 21).unwrap());
        let definitions = vec![ReminderDefinition {
            id: Uuid::from_u128(3).to_string(),
            lead_minutes: 0,
        }];
        let mut first = Vec::new();
        append_occurrence_deliveries(&mut first, &occurrence, &definitions, Tz::UTC, 0, i64::MAX)
            .unwrap();
        let mut edited = occurrence;
        edited.revision = 9;
        edited.title = "Renamed".into();
        let mut second = Vec::new();
        append_occurrence_deliveries(&mut second, &edited, &definitions, Tz::UTC, 0, i64::MAX)
            .unwrap();

        assert_eq!(first[0].id, second[0].id);
        assert_ne!(first[0].event_revision, second[0].event_revision);
    }

    #[test]
    fn schedule_capacity_fails_closed() {
        let occurrence = all_day_occurrence(NaiveDate::from_ymd_opt(2026, 7, 21).unwrap());
        let definitions = vec![ReminderDefinition {
            id: Uuid::from_u128(3).to_string(),
            lead_minutes: 0,
        }];
        let mut desired = vec![
            DesiredDelivery {
                id: String::new(),
                event_id: String::new(),
                reminder_id: String::new(),
                occurrence_key: String::new(),
                event_revision: 1,
                scheduled_utc: 0,
            };
            MAX_SCHEDULED_DELIVERIES
        ];
        assert_eq!(
            append_occurrence_deliveries(
                &mut desired,
                &occurrence,
                &definitions,
                Tz::UTC,
                0,
                i64::MAX,
            ),
            Err("schedule_capacity_exceeded")
        );
    }

    #[test]
    fn reminder_permission_wire_values_remain_stable() {
        assert_eq!(
            serde_json::to_value(ReminderPermissionStatus::Granted).unwrap(),
            serde_json::json!("granted")
        );
        assert_eq!(
            serde_json::to_value(ReminderPermissionStatus::Denied).unwrap(),
            serde_json::json!("denied")
        );
    }

    async fn event_with_reminders(
        store: &SqliteEventStore,
        date: NaiveDate,
        offsets: Vec<i64>,
    ) -> EventRecord {
        store
            .create(
                EventDraft::validated_with_recurrence_and_reminders(
                    "Initial title".into(),
                    None,
                    None,
                    EventTime::AllDay {
                        start_date: date,
                        end_date_exclusive: date.succ_opt().unwrap(),
                    },
                    None,
                    offsets,
                )
                .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn reminder_definitions_for(
        store: &SqliteEventStore,
        event: &EventRecord,
    ) -> Vec<ReminderDefinition> {
        load_reminder_ids(store, std::slice::from_ref(event))
            .await
            .unwrap()
            .master
            .remove(&event.id)
            .unwrap()
    }

    fn scheduler_range(start: NaiveDate, end: NaiveDate) -> EventQueryRange {
        EventQueryRange::validated(
            start
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis(),
            end.and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis(),
            &start.format("%Y-%m-%d").to_string(),
            &end.format("%Y-%m-%d").to_string(),
        )
        .unwrap()
    }

    async fn recurring_event_with_reminders(
        store: &SqliteEventStore,
        date: NaiveDate,
        offsets: Vec<i64>,
    ) -> EventRecord {
        store
            .create(
                EventDraft::validated_with_recurrence_and_reminders(
                    "Recurring title".into(),
                    None,
                    None,
                    EventTime::AllDay {
                        start_date: date,
                        end_date_exclusive: date.succ_opt().unwrap(),
                    },
                    Some("FREQ=DAILY;COUNT=3".into()),
                    offsets,
                )
                .unwrap(),
            )
            .await
            .unwrap()
    }

    fn occurrence_draft(title: &str, date: NaiveDate, offsets: Vec<i64>) -> EventDraft {
        EventDraft::validated_with_recurrence_and_reminders(
            title.into(),
            None,
            None,
            EventTime::AllDay {
                start_date: date,
                end_date_exclusive: date.succ_opt().unwrap(),
            },
            None,
            offsets,
        )
        .unwrap()
    }

    fn desired_delivery(
        event: &EventRecord,
        reminder: &ReminderDefinition,
        occurrence_key: &str,
        scheduled_utc: i64,
    ) -> DesiredDelivery {
        let identity = format!("{}:{occurrence_key}", reminder.id);
        DesiredDelivery {
            id: Uuid::new_v5(&Uuid::NAMESPACE_OID, identity.as_bytes()).to_string(),
            event_id: event.id.to_string(),
            reminder_id: reminder.id.clone(),
            occurrence_key: occurrence_key.to_owned(),
            event_revision: event.revision,
            scheduled_utc,
        }
    }

    async fn claim_one(
        store: &SqliteEventStore,
        event: &EventRecord,
        occurrence_key: &str,
        now: i64,
    ) -> (String, u64) {
        let reminder = reminder_definitions_for(store, event).await.remove(0);
        let delivery = desired_delivery(event, &reminder, occurrence_key, now);
        reconcile_schedule(
            store,
            std::slice::from_ref(&delivery),
            now,
            now + HORIZON_MS,
            "UTC",
        )
        .await
        .unwrap();
        let batch = claim_due(store, now, false).await.unwrap();
        assert_eq!(batch.items.len(), 1);
        (batch.items[0].id.clone(), batch.reminder_data_generation)
    }

    async fn assert_stale_delivery_does_not_enqueue(
        store: &SqliteEventStore,
        delivery_id: &str,
        claimed_generation: u64,
        now: i64,
    ) {
        let enqueue_calls = AtomicUsize::new(0);
        let attempt =
            dispatch_claimed_delivery(store, delivery_id, claimed_generation, now, now, |_, _| {
                enqueue_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap();
        assert!(attempt.is_none());
        assert_eq!(enqueue_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn claim_atomically_expires_stale_pending_and_rebuild_can_rearm_it() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let mut event = event_with_reminders(&store, date, vec![0]).await;
        let reminder = reminder_definitions_for(&store, &event).await.remove(0);
        let now = 2_000_000_000_000_i64;
        let delivery = desired_delivery(&event, &reminder, "atomic-stale", now);
        reconcile_schedule(
            &store,
            std::slice::from_ref(&delivery),
            now,
            now + HORIZON_MS,
            "UTC",
        )
        .await
        .unwrap();
        sqlx::query("UPDATE events SET revision = revision + 1 WHERE id = ?")
            .bind(event.id.to_string())
            .execute(store.pool())
            .await
            .unwrap();

        let batch = claim_due(&store, now, false).await.unwrap();
        assert!(batch.items.is_empty());
        let stale: (String, Option<String>) =
            sqlx::query_as("SELECT status, error_code FROM reminder_deliveries WHERE id = ?")
                .bind(&delivery.id)
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(stale, ("expired".into(), Some(STALE_DELIVERY_ERROR.into())));

        event.revision += 1;
        let refreshed = desired_delivery(&event, &reminder, "atomic-stale", now + 60_000);
        reconcile_schedule(&store, &[refreshed], now + 1, now + HORIZON_MS, "UTC")
            .await
            .unwrap();
        let rearmed: (String, Option<String>, i64) = sqlx::query_as(
            "SELECT status, error_code, event_revision FROM reminder_deliveries WHERE id = ?",
        )
        .bind(&delivery.id)
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!(rearmed, ("pending".into(), None, event.revision));
    }

    #[tokio::test]
    async fn title_edit_after_claim_never_enqueues_stale_notification() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![0]).await;
        let now = 2_000_000_000_000_i64;
        let (delivery_id, generation) = claim_one(&store, &event, "edit-race", now).await;

        store
            .update(
                event.id,
                event.revision,
                EventDraft::validated_with_recurrence_and_reminders(
                    "Edited after claim".into(),
                    None,
                    None,
                    event.time.clone(),
                    None,
                    vec![0],
                )
                .unwrap(),
            )
            .await
            .unwrap();

        assert_stale_delivery_does_not_enqueue(&store, &delivery_id, generation, now + 1).await;
        let state: (String, Option<String>) =
            sqlx::query_as("SELECT status, error_code FROM reminder_deliveries WHERE id = ?")
                .bind(delivery_id)
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(state, ("expired".into(), Some(STALE_DELIVERY_ERROR.into())));
    }

    #[tokio::test]
    async fn event_delete_after_claim_never_enqueues_stale_notification() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![0]).await;
        let now = 2_000_000_000_000_i64;
        let (delivery_id, generation) = claim_one(&store, &event, "delete-race", now).await;

        store.delete(event.id, event.revision).await.unwrap();

        assert_stale_delivery_does_not_enqueue(&store, &delivery_id, generation, now + 1).await;
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM reminder_deliveries WHERE id = ?")
                .bind(delivery_id)
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn occurrence_move_after_claim_never_enqueues_stale_notification() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = recurring_event_with_reminders(&store, date, vec![0]).await;
        let key = format!("{}/all-day/2026-07-22", event.id);
        let now = 2_000_000_000_000_i64;
        let (delivery_id, generation) = claim_one(&store, &event, &key, now).await;

        store
            .update_occurrence(
                event.id,
                &key,
                event.revision,
                occurrence_draft(
                    "Moved after claim",
                    NaiveDate::from_ymd_opt(2026, 7, 25).unwrap(),
                    vec![0],
                ),
            )
            .await
            .unwrap();

        assert_stale_delivery_does_not_enqueue(&store, &delivery_id, generation, now + 1).await;
    }

    #[tokio::test]
    async fn occurrence_cancel_after_claim_never_enqueues_stale_notification() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = recurring_event_with_reminders(&store, date, vec![0]).await;
        let key = format!("{}/all-day/2026-07-22", event.id);
        let now = 2_000_000_000_000_i64;
        let (delivery_id, generation) = claim_one(&store, &event, &key, now).await;

        store
            .delete_occurrence(event.id, &key, event.revision)
            .await
            .unwrap();

        assert_stale_delivery_does_not_enqueue(&store, &delivery_id, generation, now + 1).await;
    }

    #[tokio::test]
    async fn same_identity_restore_style_replacement_never_enqueues_old_claim() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![0]).await;
        let now = 2_000_000_000_000_i64;
        let (delivery_id, generation) = claim_one(&store, &event, "restore-race", now).await;

        {
            let _dispatch_barrier = store.calendar_mutation_guard().await;
            sqlx::query("UPDATE events SET title = ? WHERE id = ?")
                .bind("Restored title with same identifiers and revision")
                .bind(event.id.to_string())
                .execute(store.pool())
                .await
                .unwrap();
            store.advance_reminder_data_generation();
        }

        assert_stale_delivery_does_not_enqueue(&store, &delivery_id, generation, now + 1).await;
    }

    #[test]
    fn sensitive_reminder_status_events_target_only_main() {
        assert_eq!(STATUS_EVENT_TARGET, "main");
        for auxiliary in ["widget", "quick-command", "event-editor"] {
            assert_ne!(STATUS_EVENT_TARGET, auxiliary);
        }
        let status = ReminderStatus {
            recent_catch_up: RecentReminderCatchUp {
                items: vec![ReminderCatchUpItem {
                    event_id: "private-event-id".into(),
                    occurrence_key: "private-occurrence-key".into(),
                    title: "Private title".into(),
                    scheduled_for_utc_ms: 1,
                    delivered_at_utc_ms: Some(2),
                    status: ReminderDeliveryOutcome::Delivered,
                }],
                delivered_count: 1,
                suppressed_count: 0,
            },
            ..ReminderStatus::default()
        };
        assert!(serde_json::to_string(&status)
            .unwrap()
            .contains("Private title"));
    }

    #[tokio::test]
    async fn repeated_rebuild_is_idempotent_and_title_edit_preserves_terminal_delivery() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![0]).await;
        let reminder = reminder_definitions_for(&store, &event).await.remove(0);
        let now = 2_000_000_000_000_i64;
        let delivery = desired_delivery(&event, &reminder, "occurrence-a", now);

        reconcile_schedule(
            &store,
            std::slice::from_ref(&delivery),
            now,
            now + HORIZON_MS,
            "UTC",
        )
        .await
        .unwrap();
        reconcile_schedule(
            &store,
            std::slice::from_ref(&delivery),
            now,
            now + HORIZON_MS,
            "UTC",
        )
        .await
        .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reminder_deliveries")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(count, 1);

        let claimed = claim_due(&store, now, false).await.unwrap();
        assert_eq!(claimed.items.len(), 1);
        complete_delivery(&store, &claimed.items[0].id, now + 1, true)
            .await
            .unwrap();
        let updated = store
            .update(
                event.id,
                event.revision,
                EventDraft::validated_with_recurrence_and_reminders(
                    "Renamed only".into(),
                    None,
                    None,
                    EventTime::AllDay {
                        start_date: date,
                        end_date_exclusive: date.succ_opt().unwrap(),
                    },
                    None,
                    vec![0],
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let retained_reminder = reminder_definitions_for(&store, &updated).await.remove(0);
        assert_eq!(retained_reminder.id, reminder.id);
        let edited_delivery = desired_delivery(&updated, &retained_reminder, "occurrence-a", now);
        reconcile_schedule(&store, &[edited_delivery], now + 2, now + HORIZON_MS, "UTC")
            .await
            .unwrap();

        let terminal: (String, i64, String) =
            sqlx::query_as("SELECT id, event_revision, status FROM reminder_deliveries")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(terminal.0, delivery.id);
        assert_eq!(terminal.1, event.revision);
        assert_eq!(terminal.2, "delivered");
    }

    #[tokio::test]
    async fn occurrence_rebuild_preserves_or_replaces_identity_and_cancellation_expires_pending() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let start = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let parent = recurring_event_with_reminders(&store, start, vec![30]).await;
        let key = format!("{}/all-day/2026-07-22", parent.id);
        let range = scheduler_range(start, start.checked_add_days(Days::new(6)).unwrap());
        let now = 1_700_000_000_000_i64;

        let hydrated = store.get(parent.id).await.unwrap().unwrap();
        let catalog = load_reminder_ids(&store, std::slice::from_ref(&hydrated))
            .await
            .unwrap();
        let initial = build_desired_deliveries(
            std::slice::from_ref(&hydrated),
            &catalog,
            &range,
            Tz::UTC,
            0,
            i64::MAX,
        )
        .unwrap();
        let initial_for_key = initial
            .iter()
            .find(|delivery| delivery.occurrence_key == key)
            .unwrap()
            .clone();
        reconcile_schedule(&store, &initial, now, i64::MAX, "UTC")
            .await
            .unwrap();

        let moved_date = NaiveDate::from_ymd_opt(2026, 7, 25).unwrap();
        let parent = store
            .update_occurrence(
                parent.id,
                &key,
                parent.revision,
                occurrence_draft("Moved title", moved_date, vec![30]),
            )
            .await
            .unwrap();
        let hydrated = store.get(parent.id).await.unwrap().unwrap();
        let catalog = load_reminder_ids(&store, std::slice::from_ref(&hydrated))
            .await
            .unwrap();
        let moved = build_desired_deliveries(
            std::slice::from_ref(&hydrated),
            &catalog,
            &range,
            Tz::UTC,
            0,
            i64::MAX,
        )
        .unwrap();
        let moved_for_key = moved
            .iter()
            .find(|delivery| delivery.occurrence_key == key)
            .unwrap();
        assert_eq!(moved_for_key.id, initial_for_key.id);
        assert_eq!(moved_for_key.reminder_id, initial_for_key.reminder_id);
        assert_ne!(moved_for_key.scheduled_utc, initial_for_key.scheduled_utc);
        reconcile_schedule(&store, &moved, now + 1, i64::MAX, "UTC")
            .await
            .unwrap();
        let stable_rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT id, status, scheduled_utc FROM reminder_deliveries
             WHERE event_id = ? AND occurrence_key = ?",
        )
        .bind(parent.id.to_string())
        .bind(&key)
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(stable_rows.len(), 1);
        assert_eq!(stable_rows[0].0, initial_for_key.id);
        assert_eq!(stable_rows[0].1, "pending");
        assert_eq!(stable_rows[0].2, moved_for_key.scheduled_utc);

        let parent = store
            .update_occurrence(
                parent.id,
                &key,
                parent.revision,
                occurrence_draft("Changed offset", moved_date, vec![60]),
            )
            .await
            .unwrap();
        let hydrated = store.get(parent.id).await.unwrap().unwrap();
        let catalog = load_reminder_ids(&store, std::slice::from_ref(&hydrated))
            .await
            .unwrap();
        let changed = build_desired_deliveries(
            std::slice::from_ref(&hydrated),
            &catalog,
            &range,
            Tz::UTC,
            0,
            i64::MAX,
        )
        .unwrap();
        let changed_for_key = changed
            .iter()
            .find(|delivery| delivery.occurrence_key == key)
            .unwrap();
        assert_ne!(changed_for_key.id, initial_for_key.id);
        assert_ne!(changed_for_key.reminder_id, initial_for_key.reminder_id);
        reconcile_schedule(&store, &changed, now + 2, i64::MAX, "UTC")
            .await
            .unwrap();
        let changed_rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, status FROM reminder_deliveries
             WHERE event_id = ? AND occurrence_key = ? ORDER BY status",
        )
        .bind(parent.id.to_string())
        .bind(&key)
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(changed_rows.len(), 2);
        assert!(changed_rows.contains(&(initial_for_key.id.clone(), "expired".into())));
        assert!(changed_rows.contains(&(changed_for_key.id.clone(), "pending".into())));

        store
            .delete_occurrence(parent.id, &key, parent.revision)
            .await
            .unwrap();
        let hydrated = store.get(parent.id).await.unwrap().unwrap();
        let catalog = load_reminder_ids(&store, std::slice::from_ref(&hydrated))
            .await
            .unwrap();
        let cancelled = build_desired_deliveries(
            std::slice::from_ref(&hydrated),
            &catalog,
            &range,
            Tz::UTC,
            0,
            i64::MAX,
        )
        .unwrap();
        assert!(!cancelled
            .iter()
            .any(|delivery| delivery.occurrence_key == key));

        reconcile_schedule(&store, &cancelled, now + 3, i64::MAX, "UTC")
            .await
            .unwrap();
        let remaining: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, status FROM reminder_deliveries
             WHERE event_id = ? AND occurrence_key = ?",
        )
        .bind(parent.id.to_string())
        .bind(&key)
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(remaining, vec![(initial_for_key.id, "expired".into())]);
    }

    #[tokio::test]
    async fn delivered_occurrence_identity_survives_title_edit_and_later_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let start = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let parent = recurring_event_with_reminders(&store, start, vec![0]).await;
        let key = format!("{}/all-day/2026-07-22", parent.id);
        let range = scheduler_range(start, start.checked_add_days(Days::new(4)).unwrap());
        let hydrated = store.get(parent.id).await.unwrap().unwrap();
        let catalog = load_reminder_ids(&store, std::slice::from_ref(&hydrated))
            .await
            .unwrap();
        let desired = build_desired_deliveries(
            std::slice::from_ref(&hydrated),
            &catalog,
            &range,
            Tz::UTC,
            0,
            i64::MAX,
        )
        .unwrap();
        let original = desired
            .into_iter()
            .find(|delivery| delivery.occurrence_key == key)
            .unwrap();
        reconcile_schedule(
            &store,
            std::slice::from_ref(&original),
            original.scheduled_utc,
            i64::MAX,
            "UTC",
        )
        .await
        .unwrap();
        let claimed = claim_due(&store, original.scheduled_utc, false)
            .await
            .unwrap();
        assert_eq!(claimed.items.len(), 1);
        complete_delivery(
            &store,
            &claimed.items[0].id,
            original.scheduled_utc + 1,
            true,
        )
        .await
        .unwrap();

        let occurrence_date = NaiveDate::from_ymd_opt(2026, 7, 22).unwrap();
        let parent = store
            .update_occurrence(
                parent.id,
                &key,
                parent.revision,
                occurrence_draft("Title only", occurrence_date, vec![0]),
            )
            .await
            .unwrap();
        let hydrated = store.get(parent.id).await.unwrap().unwrap();
        let catalog = load_reminder_ids(&store, std::slice::from_ref(&hydrated))
            .await
            .unwrap();
        let edited = build_desired_deliveries(
            std::slice::from_ref(&hydrated),
            &catalog,
            &range,
            Tz::UTC,
            0,
            i64::MAX,
        )
        .unwrap();
        let edited = edited
            .iter()
            .find(|delivery| delivery.occurrence_key == key)
            .unwrap();
        assert_eq!(edited.id, original.id);
        reconcile_schedule(
            &store,
            std::slice::from_ref(edited),
            original.scheduled_utc + 2,
            i64::MAX,
            "UTC",
        )
        .await
        .unwrap();

        store
            .delete_occurrence(parent.id, &key, parent.revision)
            .await
            .unwrap();
        let hydrated = store.get(parent.id).await.unwrap().unwrap();
        let catalog = load_reminder_ids(&store, std::slice::from_ref(&hydrated))
            .await
            .unwrap();
        let cancelled = build_desired_deliveries(
            std::slice::from_ref(&hydrated),
            &catalog,
            &range,
            Tz::UTC,
            0,
            i64::MAX,
        )
        .unwrap();
        reconcile_schedule(
            &store,
            &cancelled,
            original.scheduled_utc + 3,
            i64::MAX,
            "UTC",
        )
        .await
        .unwrap();

        let terminal: (String, String, i64) = sqlx::query_as(
            "SELECT id, status, event_revision FROM reminder_deliveries WHERE id = ?",
        )
        .bind(&original.id)
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!(terminal.0, original.id);
        assert_eq!(terminal.1, "delivered");
        assert_eq!(terminal.2, original.event_revision);
    }

    #[tokio::test]
    async fn changed_occurrence_expires_old_pending_and_creates_new_identity() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![30]).await;
        let reminder = reminder_definitions_for(&store, &event).await.remove(0);
        let now = 2_000_000_000_000_i64;
        let old = desired_delivery(&event, &reminder, "old-occurrence", now + 60_000);
        reconcile_schedule(&store, &[old], now, now + HORIZON_MS, "UTC")
            .await
            .unwrap();

        let next_date = date.succ_opt().unwrap();
        let updated = store
            .update(
                event.id,
                event.revision,
                EventDraft::validated_with_recurrence_and_reminders(
                    "Initial title".into(),
                    None,
                    None,
                    EventTime::AllDay {
                        start_date: next_date,
                        end_date_exclusive: next_date.succ_opt().unwrap(),
                    },
                    None,
                    vec![30],
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let retained = reminder_definitions_for(&store, &updated).await.remove(0);
        assert_eq!(retained.id, reminder.id);
        let new = desired_delivery(&updated, &retained, "new-occurrence", now + 120_000);
        reconcile_schedule(&store, &[new], now + 1, now + HORIZON_MS, "UTC")
            .await
            .unwrap();

        let states: Vec<(String, String)> = sqlx::query_as(
            "SELECT occurrence_key, status FROM reminder_deliveries ORDER BY occurrence_key",
        )
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(
            states,
            vec![
                ("new-occurrence".into(), "pending".into()),
                ("old-occurrence".into(), "expired".into()),
            ]
        );
    }

    #[tokio::test]
    async fn due_claim_is_bounded_deduplicated_and_expires_outside_grace() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![0, 5, 10, 15, 30]).await;
        let definitions = reminder_definitions_for(&store, &event).await;
        let now = 2_000_000_000_000_i64;
        let mut desired = definitions
            .iter()
            .enumerate()
            .map(|(index, reminder)| {
                desired_delivery(
                    &event,
                    reminder,
                    &format!("occurrence-{index}"),
                    now - i64::try_from(index).unwrap() * 1_000,
                )
            })
            .collect::<Vec<_>>();
        desired.push(desired_delivery(
            &event,
            &definitions[0],
            "outside-grace",
            now - GRACE_MS - 1,
        ));
        reconcile_schedule(&store, &desired, now - GRACE_MS, now + HORIZON_MS, "UTC")
            .await
            .unwrap();

        let first = claim_due(&store, now, true).await.unwrap();
        assert_eq!(first.items.len(), MAX_CATCH_UP_DELIVERIES);
        assert_eq!(first.suppressed_count, 3);
        let second = claim_due(&store, now, true).await.unwrap();
        assert!(second.items.is_empty());
        assert_eq!(second.suppressed_count, 0);
    }

    #[tokio::test]
    async fn ordinary_due_delivery_drains_in_batches_without_suppressing_valid_items() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![0]).await;
        let reminder = reminder_definitions_for(&store, &event).await.remove(0);
        let now = 2_000_000_000_000_i64;
        let desired = (0..=MAX_DUE_DELIVERIES_PER_TICK)
            .map(|index| desired_delivery(&event, &reminder, &format!("ordinary-{index}"), now))
            .collect::<Vec<_>>();
        reconcile_schedule(&store, &desired, now, now + HORIZON_MS, "UTC")
            .await
            .unwrap();

        let first = claim_due(&store, now, false).await.unwrap();
        assert_eq!(first.items.len(), MAX_DUE_DELIVERIES_PER_TICK);
        assert_eq!(first.suppressed_count, 0);
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM reminder_deliveries WHERE status = 'pending'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(pending, 1);

        let second = claim_due(&store, now, false).await.unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.suppressed_count, 0);
    }

    #[tokio::test]
    async fn maximum_schedule_rebuild_stays_bounded_and_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![0]).await;
        let reminder = reminder_definitions_for(&store, &event).await.remove(0);
        let now = 2_000_000_000_000_i64;
        let desired = (0..MAX_SCHEDULED_DELIVERIES)
            .map(|index| {
                desired_delivery(
                    &event,
                    &reminder,
                    &format!("soak-{index}"),
                    now + HORIZON_MS - 1,
                )
            })
            .collect::<Vec<_>>();

        reconcile_schedule(&store, &desired, now, now + HORIZON_MS, "UTC")
            .await
            .unwrap();
        reconcile_schedule(&store, &desired, now + 1, now + HORIZON_MS, "UTC")
            .await
            .unwrap();
        let counts: (i64, i64) =
            sqlx::query_as("SELECT COUNT(*), COUNT(DISTINCT id) FROM reminder_deliveries")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(
            counts,
            (
                MAX_SCHEDULED_DELIVERIES as i64,
                MAX_SCHEDULED_DELIVERIES as i64
            )
        );
    }

    #[tokio::test]
    async fn rebuild_marks_uncertain_claim_failed_and_delete_cascades_audit() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let event = event_with_reminders(&store, date, vec![0]).await;
        let reminder = reminder_definitions_for(&store, &event).await.remove(0);
        let now = 2_000_000_000_000_i64;
        let delivery = desired_delivery(&event, &reminder, "uncertain", now);
        reconcile_schedule(
            &store,
            std::slice::from_ref(&delivery),
            now,
            now + HORIZON_MS,
            "UTC",
        )
        .await
        .unwrap();
        assert_eq!(claim_due(&store, now, false).await.unwrap().items.len(), 1);

        reconcile_schedule(
            &store,
            std::slice::from_ref(&delivery),
            now + 1,
            now + HORIZON_MS,
            "UTC",
        )
        .await
        .unwrap();
        let failed: (String, Option<String>) =
            sqlx::query_as("SELECT status, error_code FROM reminder_deliveries WHERE id = ?")
                .bind(&delivery.id)
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(
            failed,
            ("failed".into(), Some("delivery_state_uncertain".into()))
        );

        store.delete(event.id, event.revision).await.unwrap();
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reminder_deliveries")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
