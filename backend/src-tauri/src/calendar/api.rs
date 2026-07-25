use std::str::FromStr;

use chrono::{Days, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::Emitter;
use tauri::{Manager, State, WebviewWindow};

use crate::{
    app_state::{AppState, CalendarReadinessStatus},
    events::CALENDAR_CHANGED,
};

use super::{
    domain::{
        parse_all_day_event, resolve_timed_event, zoned_date_start_utc_ms, AgendaDirection,
        AgendaPageQuery, EventDraft, EventId, EventQueryRange, EventRecord, EventSearchQuery,
        EventTime, OccurrenceRecord,
    },
    error::{ApiError, DomainError, StoreError},
    settings::{CalendarSettings, SettingsUpdateRequest},
};

pub(crate) const fn mutation_busy_api_error() -> ApiError {
    ApiError {
        code: "data_operation_in_progress",
        message: "Another local data operation is still finishing. Try again.",
        field: None,
    }
}

pub(crate) fn emit_calendar_changed(window: &WebviewWindow) {
    let _ = window.app_handle().emit(CALENDAR_CHANGED, ());
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListEventsRequest {
    pub start_utc_ms: i64,
    pub end_utc_ms: i64,
    pub start_date: String,
    pub end_date_exclusive: String,
}

const WIDGET_AGENDA_DAYS: u64 = 7;
const WIDGET_AGENDA_LIMIT: usize = 50;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetAgendaRequest {
    pub display_time_zone: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetAgendaItemResponse {
    pub event_id: String,
    pub occurrence_key: String,
    pub title: String,
    pub time: EventTimeResponse,
}

impl From<OccurrenceRecord> for WidgetAgendaItemResponse {
    fn from(record: OccurrenceRecord) -> Self {
        let occurrence: OccurrenceResponse = record.into();
        Self {
            event_id: occurrence.event_id,
            occurrence_key: occurrence.occurrence_key,
            title: occurrence.title,
            time: occurrence.time,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgendaPageRequest {
    pub direction: AgendaDirection,
    pub anchor_date: Option<String>,
    pub cursor: Option<String>,
    pub display_time_zone: String,
    pub limit: i64,
}

impl AgendaPageRequest {
    fn into_domain(self) -> Result<AgendaPageQuery, DomainError> {
        AgendaPageQuery::validated(
            self.direction,
            self.anchor_date.as_deref(),
            self.cursor.as_deref(),
            &self.display_time_zone,
            self.limit,
        )
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchEventsRequest {
    pub query: String,
    pub start_utc_ms: i64,
    pub end_utc_ms: i64,
    pub start_date: String,
    pub end_date_exclusive: String,
    pub limit: i64,
}

impl SearchEventsRequest {
    fn into_domain(self) -> Result<(EventSearchQuery, EventQueryRange), DomainError> {
        let query = EventSearchQuery::validated(self.query, self.limit)?;
        let range = EventQueryRange::validated(
            self.start_utc_ms,
            self.end_utc_ms,
            &self.start_date,
            &self.end_date_exclusive,
        )?;
        Ok((query, range))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetEventRequest {
    pub event_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventDraftRequest {
    pub title: String,
    pub notes: Option<String>,
    pub location: Option<String>,
    pub time: EventTimeRequest,
    #[serde(default)]
    pub recurrence_rule: RecurrenceRuleRequest,
    #[serde(default)]
    pub reminder_offsets_minutes: ReminderOffsetsRequest,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum RecurrenceRuleRequest {
    #[default]
    Missing,
    Clear,
    Set(String),
}

impl<'de> Deserialize<'de> for RecurrenceRuleRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer)
            .map(|value| value.map(Self::Set).unwrap_or(Self::Clear))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum ReminderOffsetsRequest {
    #[default]
    Missing,
    Set(Vec<i64>),
}

impl<'de> Deserialize<'de> for ReminderOffsetsRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Vec::<i64>::deserialize(deserializer).map(Self::Set)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "temporalKind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EventTimeRequest {
    Timed {
        local_start: String,
        local_end: String,
        time_zone: String,
    },
    AllDay {
        start_date: String,
        end_date_exclusive: String,
    },
}

impl EventDraftRequest {
    pub(crate) fn into_domain(
        self,
        inherited_rule: Option<String>,
        inherited_reminders: Vec<i64>,
    ) -> Result<EventDraft, DomainError> {
        let recurrence_rule = match self.recurrence_rule {
            RecurrenceRuleRequest::Missing => inherited_rule,
            RecurrenceRuleRequest::Clear => None,
            RecurrenceRuleRequest::Set(source) => Some(source),
        };
        let reminder_offsets_minutes = match self.reminder_offsets_minutes {
            ReminderOffsetsRequest::Missing => inherited_reminders,
            ReminderOffsetsRequest::Set(offsets) => offsets,
        };
        let time = match self.time {
            EventTimeRequest::Timed {
                local_start,
                local_end,
                time_zone,
            } => resolve_timed_event(&local_start, &local_end, &time_zone)?,
            EventTimeRequest::AllDay {
                start_date,
                end_date_exclusive,
            } => parse_all_day_event(&start_date, &end_date_exclusive)?,
        };
        EventDraft::validated_with_recurrence_and_reminders(
            self.title,
            self.notes,
            self.location,
            time,
            recurrence_rule,
            reminder_offsets_minutes,
        )
    }

    fn into_occurrence_domain(
        mut self,
        inherited_reminders: Vec<i64>,
    ) -> Result<EventDraft, DomainError> {
        if matches!(self.recurrence_rule, RecurrenceRuleRequest::Set(_)) {
            return Err(DomainError::InvalidRecurrenceRule);
        }
        self.recurrence_rule = RecurrenceRuleRequest::Clear;
        self.into_domain(None, inherited_reminders)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateEventRequest {
    pub event_id: String,
    pub expected_revision: i64,
    pub event: EventDraftRequest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteEventRequest {
    pub event_id: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateOccurrenceRequest {
    pub event_id: String,
    pub occurrence_key: String,
    pub expected_revision: i64,
    pub event: EventDraftRequest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteOccurrenceRequest {
    pub event_id: String,
    pub occurrence_key: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResponse {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub notes: Option<String>,
    pub location: Option<String>,
    pub time: EventTimeResponse,
    pub recurrence_rule: Option<String>,
    pub reminder_offsets_minutes: Vec<i64>,
    pub revision: i64,
    pub created_at_utc_ms: i64,
    pub updated_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "temporalKind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EventTimeResponse {
    Timed {
        start_utc_ms: i64,
        end_utc_ms: i64,
        time_zone: String,
    },
    AllDay {
        start_date: String,
        end_date_exclusive: String,
    },
}

impl From<EventRecord> for EventResponse {
    fn from(record: EventRecord) -> Self {
        let time = match record.time {
            EventTime::Timed {
                start_utc_ms,
                end_utc_ms,
                time_zone,
            } => EventTimeResponse::Timed {
                start_utc_ms,
                end_utc_ms,
                time_zone,
            },
            EventTime::AllDay {
                start_date,
                end_date_exclusive,
            } => EventTimeResponse::AllDay {
                start_date: start_date.format("%Y-%m-%d").to_string(),
                end_date_exclusive: end_date_exclusive.format("%Y-%m-%d").to_string(),
            },
        };

        Self {
            id: record.id.to_string(),
            calendar_id: record.calendar_id.to_string(),
            title: record.title,
            notes: record.notes,
            location: record.location,
            time,
            recurrence_rule: record.recurrence_rule.map(|rule| rule.source().to_owned()),
            reminder_offsets_minutes: record.reminder_offsets_minutes,
            revision: record.revision,
            created_at_utc_ms: record.created_at_utc_ms,
            updated_at_utc_ms: record.updated_at_utc_ms,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceResponse {
    pub event_id: String,
    pub occurrence_key: String,
    pub calendar_id: String,
    pub title: String,
    pub notes: Option<String>,
    pub location: Option<String>,
    pub time: EventTimeResponse,
    pub revision: i64,
    pub recurrence_rule: Option<String>,
    pub reminder_offsets_minutes: Vec<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaPageResponse {
    pub days: Vec<AgendaDayResponse>,
    pub next_cursor: Option<String>,
    pub exhausted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaDayResponse {
    pub date: String,
    pub occurrences: Vec<OccurrenceResponse>,
}

impl From<OccurrenceRecord> for OccurrenceResponse {
    fn from(record: OccurrenceRecord) -> Self {
        let time = match record.time {
            EventTime::Timed {
                start_utc_ms,
                end_utc_ms,
                time_zone,
            } => EventTimeResponse::Timed {
                start_utc_ms,
                end_utc_ms,
                time_zone,
            },
            EventTime::AllDay {
                start_date,
                end_date_exclusive,
            } => EventTimeResponse::AllDay {
                start_date: start_date.format("%Y-%m-%d").to_string(),
                end_date_exclusive: end_date_exclusive.format("%Y-%m-%d").to_string(),
            },
        };

        Self {
            event_id: record.event_id.to_string(),
            occurrence_key: record.occurrence_key,
            calendar_id: record.calendar_id.to_string(),
            title: record.title,
            notes: record.notes,
            location: record.location,
            time,
            revision: record.revision,
            recurrence_rule: record.recurrence_rule.map(|rule| rule.source().to_owned()),
            reminder_offsets_minutes: record.reminder_offsets_minutes,
        }
    }
}

pub(crate) fn ensure_main_window(window: &WebviewWindow) -> Result<(), ApiError> {
    ensure_window_label(window.label())
}

pub(crate) fn ensure_widget_window_label(label: &str) -> Result<(), ApiError> {
    if label == "widget" {
        Ok(())
    } else {
        Err(ApiError::forbidden_window())
    }
}

pub(crate) fn ensure_window_label(label: &str) -> Result<(), ApiError> {
    if label == "main" {
        Ok(())
    } else {
        Err(ApiError::forbidden_window())
    }
}

fn validate_expected_revision(revision: i64) -> Result<(), ApiError> {
    if revision >= 1 {
        Ok(())
    } else {
        Err(DomainError::InvalidRange {
            field: "expectedRevision",
        }
        .into())
    }
}

#[tauri::command]
pub async fn calendar_list_events(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ListEventsRequest,
) -> Result<Vec<OccurrenceResponse>, ApiError> {
    ensure_main_window(&window)?;
    let range = EventQueryRange::validated(
        request.start_utc_ms,
        request.end_utc_ms,
        &request.start_date,
        &request.end_date_exclusive,
    )?;
    state
        .calendar_runtime()
        .await?
        .calendar
        .list_events(range)
        .await
        .map(|records| records.into_iter().map(Into::into).collect())
        .map_err(Into::into)
}

#[tauri::command]
pub async fn calendar_widget_agenda(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: WidgetAgendaRequest,
) -> Result<Vec<WidgetAgendaItemResponse>, ApiError> {
    ensure_widget_window_label(window.label())?;
    let range = widget_agenda_range(Utc::now().timestamp_millis(), &request.display_time_zone)?;
    let mut items = state
        .calendar_runtime()
        .await?
        .calendar
        .list_events(range)
        .await
        .map_err(ApiError::from)?;
    items.truncate(WIDGET_AGENDA_LIMIT);
    Ok(items.into_iter().map(Into::into).collect())
}

fn widget_agenda_range(
    now_utc_ms: i64,
    display_time_zone: &str,
) -> Result<EventQueryRange, ApiError> {
    let time_zone = Tz::from_str(display_time_zone).map_err(|_| DomainError::InvalidTimeZone {
        field: "displayTimeZone",
    })?;
    let local_now = time_zone
        .timestamp_millis_opt(now_utc_ms)
        .single()
        .ok_or(DomainError::InvalidRange { field: "nowUtcMs" })?;
    let start_date = local_now.date_naive();
    let end_date_exclusive = start_date
        .checked_add_days(Days::new(WIDGET_AGENDA_DAYS))
        .ok_or(DomainError::InvalidRange {
            field: "displayTimeZone",
        })?;
    EventQueryRange::validated(
        now_utc_ms,
        zoned_date_start_utc_ms(end_date_exclusive, time_zone)?,
        &start_date.format("%Y-%m-%d").to_string(),
        &end_date_exclusive.format("%Y-%m-%d").to_string(),
    )
    .map_err(Into::into)
}

/// Lists one recurrence-aware civil-date page. Both the page query and the
/// follow-up exhaustion proof use bounded keyset scans. When Cal cannot prove
/// the boundary within its safety ceilings it returns an explicit error rather
/// than claiming there are no more events.
#[tauri::command]
pub async fn calendar_agenda_page(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: AgendaPageRequest,
) -> Result<AgendaPageResponse, ApiError> {
    ensure_main_window(&window)?;
    let direction = request.direction;
    let (range, start_date, end_date_exclusive, display_time_zone, next_cursor, hard_exhausted) =
        request.into_domain()?.into_parts();
    let runtime = state.calendar_runtime().await?;
    let records = runtime
        .calendar
        .list_events(range)
        .await
        .map_err(ApiError::from)?;
    let occurrences: Vec<OccurrenceResponse> = records.into_iter().map(Into::into).collect();
    let mut days = Vec::new();
    let mut date = start_date;
    while date < end_date_exclusive {
        let next_date = date
            .checked_add_days(Days::new(1))
            .ok_or(DomainError::InvalidRange { field: "cursor" })?;
        let day_start_utc_ms = zoned_date_start_utc_ms(date, display_time_zone)?;
        let day_end_utc_ms = zoned_date_start_utc_ms(next_date, display_time_zone)?;
        let date_key = date.format("%Y-%m-%d").to_string();
        days.push(AgendaDayResponse {
            date: date_key.clone(),
            occurrences: occurrences
                .iter()
                .filter(|occurrence| {
                    occurrence_intersects_agenda_day(
                        occurrence,
                        &date_key,
                        day_start_utc_ms,
                        day_end_utc_ms,
                    )
                })
                .cloned()
                .collect(),
        });
        date = next_date;
    }
    let continuation_boundary = match direction {
        AgendaDirection::Before => start_date,
        AgendaDirection::After => end_date_exclusive,
    };
    let exhausted = if hard_exhausted {
        true
    } else {
        let boundary_utc_ms = zoned_date_start_utc_ms(continuation_boundary, display_time_zone)?;
        !runtime
            .calendar
            .has_agenda_occurrences(direction, continuation_boundary, boundary_utc_ms)
            .await
            .map_err(ApiError::from)?
    };
    Ok(AgendaPageResponse {
        days,
        next_cursor: (!exhausted).then_some(next_cursor).flatten(),
        exhausted,
    })
}

fn occurrence_intersects_agenda_day(
    occurrence: &OccurrenceResponse,
    date: &str,
    day_start_utc_ms: i64,
    day_end_utc_ms: i64,
) -> bool {
    match &occurrence.time {
        EventTimeResponse::Timed {
            start_utc_ms,
            end_utc_ms,
            ..
        } => *start_utc_ms < day_end_utc_ms && *end_utc_ms > day_start_utc_ms,
        EventTimeResponse::AllDay {
            start_date,
            end_date_exclusive,
        } => start_date.as_str() <= date && end_date_exclusive.as_str() > date,
    }
}

#[tauri::command]
pub async fn calendar_search(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: SearchEventsRequest,
) -> Result<Vec<OccurrenceResponse>, ApiError> {
    ensure_main_window(&window)?;
    let (query, range) = request.into_domain()?;
    state
        .calendar_runtime()
        .await?
        .calendar
        .search_events(query, range)
        .await
        .map(|result| result.occurrences.into_iter().map(Into::into).collect())
        .map_err(Into::into)
}

#[tauri::command]
pub async fn calendar_get_event(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: GetEventRequest,
) -> Result<EventResponse, ApiError> {
    ensure_main_window(&window)?;
    get_event_authorized(&state, request).await
}

pub(crate) async fn get_event_authorized(
    state: &AppState,
    request: GetEventRequest,
) -> Result<EventResponse, ApiError> {
    let id = EventId::parse(&request.event_id)?;
    state
        .calendar_runtime()
        .await?
        .calendar
        .get_event(id)
        .await
        .map(Into::into)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn calendar_create_event(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: EventDraftRequest,
) -> Result<EventResponse, ApiError> {
    ensure_main_window(&window)?;
    create_event_authorized(&window, &state, request).await
}

pub(crate) async fn create_event_authorized(
    window: &WebviewWindow,
    state: &AppState,
    request: EventDraftRequest,
) -> Result<EventResponse, ApiError> {
    let draft = request.into_domain(None, Vec::new())?;
    let runtime = state.calendar_runtime().await?;
    let _mutation = state
        .calendar_mutations
        .begin()
        .map_err(|_| mutation_busy_api_error())?;
    let created = runtime
        .calendar
        .create_event(draft)
        .await
        .map_err(ApiError::from)?;
    #[cfg(desktop)]
    super::reminders::trigger_reminder_rebuild(window);
    emit_calendar_changed(window);
    Ok(created.into())
}

#[tauri::command]
pub async fn calendar_update_event(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: UpdateEventRequest,
) -> Result<EventResponse, ApiError> {
    ensure_main_window(&window)?;
    update_event_authorized(&window, &state, request).await
}

pub(crate) async fn update_event_authorized(
    window: &WebviewWindow,
    state: &AppState,
    request: UpdateEventRequest,
) -> Result<EventResponse, ApiError> {
    validate_expected_revision(request.expected_revision)?;
    let id = EventId::parse(&request.event_id)?;
    let runtime = state.calendar_runtime().await?;
    let _mutation = state
        .calendar_mutations
        .begin()
        .map_err(|_| mutation_busy_api_error())?;
    let current = runtime
        .calendar
        .get_event(id)
        .await
        .map_err(ApiError::from)?;
    if current.revision != request.expected_revision {
        return Err(StoreError::RevisionConflict.into());
    }
    let inherited_rule = current.recurrence_rule.map(|rule| rule.source().to_owned());
    let event = request
        .event
        .into_domain(inherited_rule, current.reminder_offsets_minutes)?;
    let updated = runtime
        .calendar
        .update_event(id, request.expected_revision, event)
        .await
        .map_err(ApiError::from)?;
    #[cfg(desktop)]
    super::reminders::trigger_reminder_rebuild(window);
    emit_calendar_changed(window);
    Ok(updated.into())
}

#[tauri::command]
pub async fn calendar_delete_event(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: DeleteEventRequest,
) -> Result<(), ApiError> {
    ensure_main_window(&window)?;
    delete_event_authorized(&window, &state, request).await
}

pub(crate) async fn delete_event_authorized(
    window: &WebviewWindow,
    state: &AppState,
    request: DeleteEventRequest,
) -> Result<(), ApiError> {
    validate_expected_revision(request.expected_revision)?;
    let id = EventId::parse(&request.event_id)?;
    let runtime = state.calendar_runtime().await?;
    let _mutation = state
        .calendar_mutations
        .begin()
        .map_err(|_| mutation_busy_api_error())?;
    runtime
        .calendar
        .delete_event(id, request.expected_revision)
        .await
        .map_err(ApiError::from)?;
    #[cfg(desktop)]
    super::reminders::trigger_reminder_rebuild(window);
    emit_calendar_changed(window);
    Ok(())
}

#[tauri::command]
pub async fn calendar_update_occurrence(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: UpdateOccurrenceRequest,
) -> Result<EventResponse, ApiError> {
    ensure_main_window(&window)?;
    update_occurrence_authorized(&window, &state, request).await
}

pub(crate) async fn update_occurrence_authorized(
    window: &WebviewWindow,
    state: &AppState,
    request: UpdateOccurrenceRequest,
) -> Result<EventResponse, ApiError> {
    validate_expected_revision(request.expected_revision)?;
    let id = EventId::parse(&request.event_id)?;
    let runtime = state.calendar_runtime().await?;
    let _mutation = state
        .calendar_mutations
        .begin()
        .map_err(|_| mutation_busy_api_error())?;
    let current = runtime
        .calendar
        .get_event(id)
        .await
        .map_err(ApiError::from)?;
    if current.revision != request.expected_revision {
        return Err(StoreError::RevisionConflict.into());
    }
    let event = request
        .event
        .into_occurrence_domain(current.reminder_offsets_minutes)?;
    let updated = runtime
        .calendar
        .update_occurrence(
            id,
            &request.occurrence_key,
            request.expected_revision,
            event,
        )
        .await
        .map_err(ApiError::from)?;
    #[cfg(desktop)]
    super::reminders::trigger_reminder_rebuild(window);
    emit_calendar_changed(window);
    Ok(updated.into())
}

#[tauri::command]
pub async fn calendar_delete_occurrence(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: DeleteOccurrenceRequest,
) -> Result<(), ApiError> {
    ensure_main_window(&window)?;
    delete_occurrence_authorized(&window, &state, request).await
}

pub(crate) async fn delete_occurrence_authorized(
    window: &WebviewWindow,
    state: &AppState,
    request: DeleteOccurrenceRequest,
) -> Result<(), ApiError> {
    validate_expected_revision(request.expected_revision)?;
    let id = EventId::parse(&request.event_id)?;
    let runtime = state.calendar_runtime().await?;
    let _mutation = state
        .calendar_mutations
        .begin()
        .map_err(|_| mutation_busy_api_error())?;
    runtime
        .calendar
        .delete_occurrence(id, &request.occurrence_key, request.expected_revision)
        .await
        .map_err(ApiError::from)?;
    #[cfg(desktop)]
    super::reminders::trigger_reminder_rebuild(window);
    emit_calendar_changed(window);
    Ok(())
}

#[tauri::command]
pub async fn calendar_get_settings(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CalendarSettings, ApiError> {
    ensure_main_window(&window)?;
    state
        .calendar_runtime()
        .await?
        .settings
        .get()
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn calendar_update_settings(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: SettingsUpdateRequest,
) -> Result<CalendarSettings, ApiError> {
    ensure_main_window(&window)?;
    let patch = request.into_patch()?;
    let runtime = state.calendar_runtime().await?;
    let _mutation = state
        .calendar_mutations
        .begin()
        .map_err(|_| mutation_busy_api_error())?;
    let updated = runtime
        .settings
        .update(patch)
        .await
        .map_err(ApiError::from)?;
    #[cfg(desktop)]
    super::reminders::trigger_reminder_rebuild(&window);
    emit_calendar_changed(&window);
    Ok(updated)
}

#[tauri::command]
pub async fn calendar_readiness_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CalendarReadinessStatus, ApiError> {
    ensure_main_window(&window)?;
    Ok(state.calendar_readiness())
}

#[tauri::command]
pub async fn calendar_retry_initialization(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CalendarReadinessStatus, ApiError> {
    ensure_main_window(&window)?;
    state.start_calendar_initialization(Some(window.app_handle().clone()));
    Ok(state.calendar_readiness())
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::calendar::{
        domain::{CalendarId, EventId},
        recurrence::RecurrenceRule,
    };

    #[test]
    fn request_temporal_discriminator_deserializes_camel_case() {
        let timed: EventDraftRequest = serde_json::from_value(json!({
            "title": "Dentist",
            "notes": null,
            "location": "Suite 3",
            "time": {
                "temporalKind": "timed",
                "localStart": "2026-07-21T15:00:00",
                "localEnd": "2026-07-21T15:45:00",
                "timeZone": "America/Chicago"
            }
        }))
        .unwrap();
        assert!(matches!(timed.time, EventTimeRequest::Timed { .. }));

        let all_day: EventDraftRequest = serde_json::from_value(json!({
            "title": "Day off",
            "notes": null,
            "location": null,
            "time": {
                "temporalKind": "allDay",
                "startDate": "2026-07-21",
                "endDateExclusive": "2026-07-22"
            }
        }))
        .unwrap();
        assert!(matches!(all_day.time, EventTimeRequest::AllDay { .. }));
    }

    #[test]
    fn agenda_page_request_uses_camel_case_and_rejects_unknown_fields() {
        let request: AgendaPageRequest = serde_json::from_value(json!({
            "direction": "after",
            "anchorDate": "2026-07-21",
            "displayTimeZone": "America/Chicago",
            "limit": 30
        }))
        .unwrap();
        let (_, start, end, _, next_cursor, exhausted) =
            request.into_domain().unwrap().into_parts();
        assert_eq!(start.format("%Y-%m-%d").to_string(), "2026-07-21");
        assert_eq!(end.format("%Y-%m-%d").to_string(), "2026-08-20");
        assert!(next_cursor.is_some());
        assert!(!exhausted);

        assert!(serde_json::from_value::<AgendaPageRequest>(json!({
            "direction": "after",
            "anchorDate": "2026-07-21",
            "displayTimeZone": "UTC",
            "limit": 30,
            "startDate": "2026-07-01"
        }))
        .is_err());
    }

    #[test]
    fn recurrence_write_contract_distinguishes_missing_clear_and_replace() {
        fn request(recurrence: Option<serde_json::Value>) -> EventDraftRequest {
            let mut value = json!({
                "title": "Dentist",
                "notes": null,
                "location": null,
                "time": {
                    "temporalKind": "timed",
                    "localStart": "2026-07-21T15:00:00",
                    "localEnd": "2026-07-21T15:45:00",
                    "timeZone": "America/Chicago"
                }
            });
            if let Some(recurrence) = recurrence {
                value
                    .as_object_mut()
                    .unwrap()
                    .insert("recurrenceRule".into(), recurrence);
            }
            serde_json::from_value(value).unwrap()
        }

        let inherited = Some("FREQ=DAILY;COUNT=4".to_owned());
        let preserved = request(None)
            .into_domain(inherited.clone(), Vec::new())
            .unwrap();
        assert_eq!(
            preserved
                .into_parts()
                .4
                .map(|rule| rule.source().to_owned()),
            inherited
        );

        let cleared = request(Some(serde_json::Value::Null))
            .into_domain(Some("FREQ=DAILY;COUNT=4".into()), Vec::new())
            .unwrap();
        assert_eq!(cleared.into_parts().4, None);

        let replaced = request(Some(json!("FREQ=DAILY;COUNT=2")))
            .into_domain(Some("FREQ=DAILY;COUNT=4".into()), Vec::new())
            .unwrap();
        assert_eq!(
            replaced.into_parts().4.map(|rule| rule.source().to_owned()),
            Some("FREQ=DAILY;COUNT=2".into())
        );
    }

    #[test]
    fn search_request_deserializes_camel_case_and_validates_every_boundary() {
        fn request(query: &str, limit: i64) -> SearchEventsRequest {
            serde_json::from_value(json!({
                "query": query,
                "startUtcMs": 1_784_534_400_000_i64,
                "endUtcMs": 1_784_793_600_000_i64,
                "startDate": "2026-07-20",
                "endDateExclusive": "2026-07-23",
                "limit": limit
            }))
            .unwrap()
        }

        assert!(request(" Planning ", 50).into_domain().is_ok());
        assert_eq!(
            request("  ", 10).into_domain(),
            Err(DomainError::InvalidSearchQuery)
        );
        assert_eq!(
            request("planning", 0).into_domain(),
            Err(DomainError::InvalidSearchLimit)
        );
        assert_eq!(
            request("planning", 51).into_domain(),
            Err(DomainError::InvalidSearchLimit)
        );

        let mut invalid_range = request("planning", 10);
        invalid_range.end_utc_ms = invalid_range.start_utc_ms;
        assert_eq!(
            invalid_range.into_domain(),
            Err(DomainError::InvalidRange { field: "endUtcMs" })
        );
    }

    #[test]
    fn occurrence_response_serializes_master_identity_and_local_occurrence_key() {
        let event_id = EventId(Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap());
        let calendar_id =
            CalendarId(Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap());
        let time = EventTime::AllDay {
            start_date: NaiveDate::from_ymd_opt(2026, 7, 22).unwrap(),
            end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 23).unwrap(),
        };
        let response = OccurrenceResponse::from(OccurrenceRecord {
            event_id,
            occurrence_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/all-day/2026-07-22".into(),
            calendar_id,
            title: "Day off".into(),
            notes: None,
            location: None,
            recurrence_rule: Some(
                RecurrenceRule::validated("FREQ=DAILY;COUNT=2".into(), &time).unwrap(),
            ),
            reminder_offsets_minutes: vec![10],
            time,
            revision: 3,
        });

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "eventId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "occurrenceKey": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/all-day/2026-07-22",
                "calendarId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "title": "Day off",
                "notes": null,
                "location": null,
                "time": {
                    "temporalKind": "allDay",
                    "startDate": "2026-07-22",
                    "endDateExclusive": "2026-07-23"
                },
                "revision": 3,
                "recurrenceRule": "FREQ=DAILY;COUNT=2"
                ,"reminderOffsetsMinutes": [10]
            })
        );
    }

    #[test]
    fn canonical_event_response_serializes_exact_contract() {
        let id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let calendar_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let response = EventResponse::from(EventRecord {
            id: EventId(id),
            calendar_id: CalendarId(calendar_id),
            title: "Day off".into(),
            notes: None,
            location: None,
            time: EventTime::AllDay {
                start_date: NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
                end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 22).unwrap(),
            },
            recurrence_rule: None,
            reminder_offsets_minutes: Vec::new(),
            revision: 1,
            created_at_utc_ms: 100,
            updated_at_utc_ms: 100,
            occurrence_overrides: Vec::new(),
        });

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "calendarId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "title": "Day off",
                "notes": null,
                "location": null,
                "time": {
                    "temporalKind": "allDay",
                    "startDate": "2026-07-21",
                    "endDateExclusive": "2026-07-22"
                },
                "recurrenceRule": null,
                "reminderOffsetsMinutes": [],
                "revision": 1,
                "createdAtUtcMs": 100,
                "updatedAtUtcMs": 100
            })
        );
    }

    #[test]
    fn canonical_timed_response_contains_utc_instants_and_iana_zone() {
        let id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let calendar_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let response = EventResponse::from(EventRecord {
            id: EventId(id),
            calendar_id: CalendarId(calendar_id),
            title: "Dentist".into(),
            notes: Some("Bring insurance card".into()),
            location: Some("Suite 3".into()),
            time: EventTime::Timed {
                start_utc_ms: 1_784_664_000_000,
                end_utc_ms: 1_784_666_700_000,
                time_zone: "America/Chicago".into(),
            },
            recurrence_rule: None,
            reminder_offsets_minutes: vec![0, 30],
            revision: 3,
            created_at_utc_ms: 100,
            updated_at_utc_ms: 200,
            occurrence_overrides: Vec::new(),
        });

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "calendarId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "title": "Dentist",
                "notes": "Bring insurance card",
                "location": "Suite 3",
                "time": {
                    "temporalKind": "timed",
                    "startUtcMs": 1_784_664_000_000_i64,
                    "endUtcMs": 1_784_666_700_000_i64,
                    "timeZone": "America/Chicago"
                },
                "recurrenceRule": null,
                "reminderOffsetsMinutes": [0, 30],
                "revision": 3,
                "createdAtUtcMs": 100,
                "updatedAtUtcMs": 200
            })
        );
    }

    #[test]
    fn api_errors_use_stable_safe_envelopes() {
        assert_eq!(
            ApiError::from(DomainError::AmbiguousLocalTime {
                field: "time.localStart"
            }),
            ApiError {
                code: "ambiguous_local_time",
                message: "That local time occurs twice because the clock moves backward.",
                field: Some("time.localStart")
            }
        );
        assert_eq!(
            ApiError::from(crate::calendar::error::StoreError::NotFound).code,
            "not_found"
        );
        assert_eq!(
            ApiError::from(DomainError::InvalidRecurrenceRule),
            ApiError {
                code: "invalid_recurrence_rule",
                message: "Use a supported daily, weekly, monthly, or yearly recurrence rule.",
                field: Some("recurrenceRule")
            }
        );
        assert_eq!(
            ApiError::from(DomainError::InvalidSearchQuery),
            ApiError {
                code: "invalid_search_query",
                message: "Enter a search term.",
                field: Some("query")
            }
        );
        assert_eq!(
            ApiError::from(DomainError::InvalidSearchLimit),
            ApiError {
                code: "invalid_search_limit",
                message: "Search can return between 1 and 50 results.",
                field: Some("limit")
            }
        );
        assert_eq!(
            ApiError::from(DomainError::FieldTooLong {
                field: "query",
                maximum: 200,
            }),
            ApiError {
                code: "field_too_long",
                message: "Search cannot exceed 200 characters.",
                field: Some("query")
            }
        );
    }

    #[test]
    fn request_contract_rejects_extra_fields_and_keeps_commands_least_privileged() {
        assert!(serde_json::from_value::<GetEventRequest>(json!({
            "eventId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sql": "DROP TABLE events"
        }))
        .is_err());
        assert_eq!(ensure_window_label("main"), Ok(()));
        assert_eq!(
            ensure_window_label("settings"),
            Err(ApiError::forbidden_window())
        );
        assert_eq!(ensure_widget_window_label("widget"), Ok(()));
        assert_eq!(
            ensure_widget_window_label("main"),
            Err(ApiError::forbidden_window())
        );
    }

    #[test]
    fn widget_agenda_range_is_server_bounded_to_seven_civil_days() {
        let now = 1_774_941_600_000;
        let range = widget_agenda_range(now, "America/Chicago").unwrap();
        let (start, end) = range.date_bounds();
        assert_eq!(end.signed_duration_since(start).num_days(), 7);
        assert_eq!(range.instant_bounds().0, now);
        assert!(range.instant_bounds().1 > now);
        assert_eq!(WIDGET_AGENDA_LIMIT, 50);
    }

    #[test]
    fn widget_agenda_dto_serializes_only_minimum_fields() {
        let item = WidgetAgendaItemResponse {
            event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
            occurrence_key: "2026-04-01T15:00:00Z".to_owned(),
            title: "Private title".to_owned(),
            time: EventTimeResponse::Timed {
                start_utc_ms: 1,
                end_utc_ms: 2,
                time_zone: "UTC".to_owned(),
            },
        };
        let value = serde_json::to_value(item).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 4);
        assert!(object.contains_key("eventId"));
        assert!(object.contains_key("occurrenceKey"));
        assert!(object.contains_key("title"));
        assert!(object.contains_key("time"));
        for forbidden in [
            "notes",
            "location",
            "calendarId",
            "recurrenceRule",
            "reminderOffsetsMinutes",
            "revision",
            "settings",
        ] {
            assert!(!object.contains_key(forbidden));
        }
    }
}
