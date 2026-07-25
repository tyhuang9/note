use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use chrono::{NaiveDate, Utc};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    FromRow, QueryBuilder, Sqlite, SqlitePool, Transaction,
};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use uuid::Uuid;

#[cfg(desktop)]
use crate::calendar::export::IcsExportRepository;
#[cfg(desktop)]
use crate::calendar::import::{
    IcsImportRepository, ImportCommitResult, ImportDuplicatePolicy, ImportSourceIdentity,
    StagedImportEvent,
};

use crate::calendar::{
    domain::{
        CalendarId, EventDraft, EventId, EventQueryRange, EventRecord, EventTime,
        OccurrenceOverride, OccurrenceOverrideReplacement,
    },
    error::{CalendarError, DomainError, StoreError},
    recurrence::{validate_occurrence_key, RecurrenceRule},
    settings::{CalendarSettings, CalendarSettingsPatch},
};

#[cfg(test)]
use super::MAX_EVENT_MASTER_SCAN;
use super::{
    EventListPage, EventRepository, EventSearchPage, SettingsRepository, EVENT_MASTER_PAGE_SIZE,
};

const DEFAULT_CALENDAR_ID: &str = "00000000-0000-4000-8000-000000000001";
const MAX_OVERRIDES_PER_MASTER: usize = 1_000;
const MAX_OVERRIDES_PER_QUERY: usize = 5_000;
const SQLITE_BIND_CHUNK: usize = 400;
pub(crate) static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub struct SqliteEventStore {
    pool: SqlitePool,
    database_path: PathBuf,
    reminder_dispatch_barrier: Arc<RwLock<()>>,
    reminder_data_generation: Arc<AtomicU64>,
}

impl SqliteEventStore {
    pub async fn open(database_path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = database_path.parent() {
            std::fs::create_dir_all(parent).map_err(StoreError::Io)?;
        }

        let options = SqliteConnectOptions::new()
            .filename(database_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(options)
            .await
            .map_err(StoreError::Database)?;

        MIGRATOR.run(&pool).await.map_err(StoreError::Migration)?;
        seed_default_calendar(&pool).await?;
        verify_integrity(&pool).await?;

        Ok(Self {
            pool,
            database_path: database_path.to_owned(),
            reminder_dispatch_barrier: Arc::new(RwLock::new(())),
            reminder_data_generation: Arc::new(AtomicU64::new(0)),
        })
    }

    pub(crate) fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub(crate) fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub(crate) async fn reminder_dispatch_guard(&self) -> OwnedRwLockReadGuard<()> {
        self.reminder_dispatch_barrier.clone().read_owned().await
    }

    pub(crate) async fn calendar_mutation_guard(&self) -> OwnedRwLockWriteGuard<()> {
        self.reminder_dispatch_barrier.clone().write_owned().await
    }

    pub(crate) fn reminder_data_generation(&self) -> u64 {
        self.reminder_data_generation.load(Ordering::Acquire)
    }

    pub(crate) fn advance_reminder_data_generation(&self) {
        self.reminder_data_generation.fetch_add(1, Ordering::AcqRel);
    }

    async fn hydrate_overrides(
        &self,
        mut events: Vec<EventRecord>,
    ) -> Result<Vec<EventRecord>, StoreError> {
        if events.is_empty() {
            return Ok(events);
        }

        let mut links = Vec::new();
        for parent_chunk in events.chunks(SQLITE_BIND_CHUNK) {
            let remaining = MAX_OVERRIDES_PER_QUERY
                .checked_sub(links.len())
                .ok_or(StoreError::OverrideLimitExceeded)?;
            let mut query = QueryBuilder::<Sqlite>::new(
                "SELECT parent_event_id, original_start_key, override_event_id \
                 FROM event_overrides WHERE parent_event_id IN (",
            );
            let mut separated = query.separated(", ");
            for event in parent_chunk {
                separated.push_bind(event.id.to_string());
            }
            separated.push_unseparated(") ORDER BY parent_event_id, original_start_key LIMIT ");
            query.push_bind(i64::try_from(remaining + 1).unwrap_or(i64::MAX));
            let mut chunk_links = query
                .build_query_as::<OverrideLinkRow>()
                .fetch_all(&self.pool)
                .await
                .map_err(StoreError::Database)?;
            links.append(&mut chunk_links);
            if links.len() > MAX_OVERRIDES_PER_QUERY {
                return Err(StoreError::OverrideLimitExceeded);
            }
        }

        let replacement_ids = links
            .iter()
            .filter_map(|link| link.override_event_id.as_ref())
            .collect::<Vec<_>>();
        let mut replacements = HashMap::new();
        for id_chunk in replacement_ids.chunks(SQLITE_BIND_CHUNK) {
            let mut query = QueryBuilder::<Sqlite>::new(
                "SELECT id, calendar_id, title, description, location, temporal_kind, \
                 start_utc, end_utc, time_zone, start_date, end_date_exclusive, \
                 rrule, revision, created_at, updated_at, \
                 COALESCE((SELECT group_concat(lead_minutes, ',') FROM \
                   (SELECT lead_minutes FROM reminders WHERE event_id = events.id ORDER BY lead_minutes)), '') AS reminder_offsets \
                 FROM events WHERE status = 'confirmed' AND id IN (",
            );
            let mut separated = query.separated(", ");
            for id in id_chunk {
                separated.push_bind(*id);
            }
            separated.push_unseparated(")");
            for row in query
                .build_query_as::<EventRow>()
                .fetch_all(&self.pool)
                .await
                .map_err(StoreError::Database)?
            {
                let record: EventRecord = row.try_into()?;
                if record.recurrence_rule.is_some() {
                    return Err(StoreError::InvalidData);
                }
                replacements.insert(record.id.to_string(), record);
            }
        }

        let positions = events
            .iter()
            .enumerate()
            .map(|(index, event)| (event.id.to_string(), index))
            .collect::<HashMap<_, _>>();
        let mut per_master = HashMap::<String, usize>::new();
        for link in links {
            let count = per_master.entry(link.parent_event_id.clone()).or_default();
            *count += 1;
            if *count > MAX_OVERRIDES_PER_MASTER {
                return Err(StoreError::OverrideLimitExceeded);
            }
            let position = positions
                .get(&link.parent_event_id)
                .copied()
                .ok_or(StoreError::InvalidData)?;
            let replacement = link
                .override_event_id
                .map(|id| {
                    let record = replacements.remove(&id).ok_or(StoreError::InvalidData)?;
                    Ok(OccurrenceOverrideReplacement {
                        title: record.title,
                        notes: record.notes,
                        location: record.location,
                        time: record.time,
                        reminder_offsets_minutes: record.reminder_offsets_minutes,
                    })
                })
                .transpose()?;
            events[position]
                .occurrence_overrides
                .push(OccurrenceOverride {
                    occurrence_key: link.original_start_key,
                    replacement,
                });
        }
        if !replacements.is_empty() {
            return Err(StoreError::InvalidData);
        }
        Ok(events)
    }

    pub(crate) async fn reminder_schedule_candidates(
        &self,
        range: EventQueryRange,
        limit: usize,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let (start_utc_ms, end_utc_ms) = range.instant_bounds();
        let (start_date, end_date_exclusive) = range.date_bounds();
        let rows = sqlx::query_as::<_, EventRow>(
            "SELECT id, calendar_id, title, description, location, temporal_kind,
                    start_utc, end_utc, time_zone, start_date, end_date_exclusive,
                    rrule, revision, created_at, updated_at,
                    COALESCE((SELECT group_concat(lead_minutes, ',') FROM
                      (SELECT lead_minutes FROM reminders WHERE event_id = events.id ORDER BY lead_minutes)), '') AS reminder_offsets
             FROM events
             WHERE status = 'confirmed'
               AND NOT EXISTS (
                 SELECT 1 FROM event_overrides private_override
                 WHERE private_override.override_event_id = events.id
               )
               AND (
                 EXISTS (SELECT 1 FROM reminders WHERE event_id = events.id)
                 OR EXISTS (
                   SELECT 1 FROM event_overrides reminder_override
                   JOIN reminders override_reminder
                     ON override_reminder.event_id = reminder_override.override_event_id
                   WHERE reminder_override.parent_event_id = events.id
                 )
               )
               AND (
                 (
                   rrule IS NOT NULL
                   AND (
                     (temporal_kind = 'timed' AND start_utc < ?)
                     OR (temporal_kind = 'all_day' AND start_date < ?)
                   )
                 )
                 OR
                 (
                   rrule IS NULL
                   AND (
                     (temporal_kind = 'timed' AND start_utc < ? AND end_utc > ?)
                     OR (temporal_kind = 'all_day' AND start_date < ? AND end_date_exclusive > ?)
                   )
                 )
                 OR EXISTS (
                   SELECT 1 FROM event_overrides visible_override
                   JOIN events replacement ON replacement.id = visible_override.override_event_id
                   WHERE visible_override.parent_event_id = events.id
                     AND replacement.status = 'confirmed'
                     AND (
                       (replacement.temporal_kind = 'timed' AND replacement.start_utc < ? AND replacement.end_utc > ?)
                       OR (replacement.temporal_kind = 'all_day' AND replacement.start_date < ? AND replacement.end_date_exclusive > ?)
                     )
                 )
               )
             ORDER BY updated_at ASC, id ASC
             LIMIT ?",
        )
        .bind(end_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(end_utc_ms)
        .bind(start_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(start_date.format("%Y-%m-%d").to_string())
        .bind(end_utc_ms)
        .bind(start_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(start_date.format("%Y-%m-%d").to_string())
        .bind(i64::try_from(limit).unwrap_or(i64::MAX))
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::Database)?;

        let events = rows
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, _>>()?;
        self.hydrate_overrides(events).await
    }

    async fn event_in_transaction(
        transaction: &mut Transaction<'_, Sqlite>,
        id: EventId,
    ) -> Result<EventRecord, StoreError> {
        let row = sqlx::query_as::<_, EventRow>(EVENT_SELECT_BY_ID)
            .bind(id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(StoreError::Database)?
            .ok_or(StoreError::NotFound)?;
        row.try_into()
    }

    async fn distinguish_missing_or_conflict(
        transaction: &mut Transaction<'_, Sqlite>,
        id: EventId,
    ) -> Result<StoreError, StoreError> {
        let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM events WHERE id = ?)")
            .bind(id.to_string())
            .fetch_one(&mut **transaction)
            .await
            .map_err(StoreError::Database)?;
        Ok(if exists == 1 {
            StoreError::RevisionConflict
        } else {
            StoreError::NotFound
        })
    }

    async fn insert_event_in_transaction(
        transaction: &mut Transaction<'_, Sqlite>,
        draft: EventDraft,
    ) -> Result<EventRecord, StoreError> {
        let default_calendar_id = default_calendar_id(transaction).await?;
        let id = EventId(Uuid::new_v4());
        let now = Utc::now().timestamp_millis();
        let reminder_offsets = draft.reminder_offsets_minutes().to_vec();
        let columns = EventWriteColumns::from(draft);

        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, description, location, temporal_kind,
                start_utc, end_utc, time_zone, start_date, end_date_exclusive,
                rrule, status, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, ?, ?)",
        )
        .bind(id.to_string())
        .bind(default_calendar_id.to_string())
        .bind(columns.title)
        .bind(columns.notes)
        .bind(columns.location)
        .bind(columns.temporal_kind)
        .bind(columns.start_utc)
        .bind(columns.end_utc)
        .bind(columns.time_zone)
        .bind(columns.start_date)
        .bind(columns.end_date_exclusive)
        .bind(columns.rrule)
        .bind(now)
        .bind(now)
        .execute(&mut **transaction)
        .await
        .map_err(StoreError::Database)?;

        reconcile_reminders(transaction, id, &reminder_offsets, now).await?;
        Self::event_in_transaction(transaction, id).await
    }
}

#[async_trait]
impl EventRepository for SqliteEventStore {
    async fn create(&self, draft: EventDraft) -> Result<EventRecord, StoreError> {
        let _dispatch_barrier = self.calendar_mutation_guard().await;
        let mut transaction = self.pool.begin().await.map_err(StoreError::Database)?;
        let created = Self::insert_event_in_transaction(&mut transaction, draft).await?;
        transaction.commit().await.map_err(StoreError::Database)?;
        self.advance_reminder_data_generation();
        Ok(created)
    }

    async fn create_assistant_event(&self, draft: EventDraft) -> Result<EventRecord, StoreError> {
        let _dispatch_barrier = self.calendar_mutation_guard().await;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(StoreError::Database)?;
        let reconciliation_required: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM assistant_calendar_create_reconciliation WHERE singleton_id = 1
             )",
        )
        .fetch_one(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;
        if reconciliation_required == 1 {
            return Err(StoreError::AssistantCreateReconciliationRequired);
        }

        sqlx::query(
            "INSERT INTO assistant_calendar_create_reconciliation (
                singleton_id, created_at_utc_ms
             ) VALUES (1, ?)",
        )
        .bind(Utc::now().timestamp_millis())
        .execute(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;

        let created = match Self::insert_event_in_transaction(&mut transaction, draft).await {
            Ok(created) => created,
            Err(error) => {
                return match transaction.rollback().await {
                    Ok(()) => Err(error),
                    Err(_) => Err(StoreError::AssistantCreateOutcomeUnknown),
                };
            }
        };
        transaction
            .commit()
            .await
            .map_err(|_| StoreError::AssistantCreateOutcomeUnknown)?;
        self.advance_reminder_data_generation();
        Ok(created)
    }

    async fn assistant_create_reconciliation_required(&self) -> Result<bool, StoreError> {
        let required: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM assistant_calendar_create_reconciliation WHERE singleton_id = 1
             )",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(StoreError::Database)?;
        Ok(required == 1)
    }

    async fn acknowledge_assistant_create_reconciliation(&self) -> Result<bool, StoreError> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(StoreError::Database)?;
        let result = sqlx::query(
            "DELETE FROM assistant_calendar_create_reconciliation WHERE singleton_id = 1",
        )
        .execute(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;
        transaction.commit().await.map_err(StoreError::Database)?;
        Ok(result.rows_affected() == 1)
    }

    async fn get(&self, id: EventId) -> Result<Option<EventRecord>, StoreError> {
        let event = sqlx::query_as::<_, EventRow>(EVENT_SELECT_BY_ID)
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(StoreError::Database)?
            .map(TryInto::try_into)
            .transpose()?;
        let Some(event) = event else {
            return Ok(None);
        };
        Ok(self.hydrate_overrides(vec![event]).await?.pop())
    }

    #[cfg(test)]
    async fn list(&self, range: EventQueryRange) -> Result<Vec<EventRecord>, StoreError> {
        let mut records = Vec::new();
        let mut after = None;
        loop {
            let remaining = MAX_EVENT_MASTER_SCAN.saturating_sub(records.len());
            if remaining == 0 {
                return Err(StoreError::CandidateLimitExceeded);
            }
            let page = self
                .list_page(range.clone(), after, EVENT_MASTER_PAGE_SIZE.min(remaining))
                .await?;
            records.extend(page.records);
            let Some(next_after) = page.next_after else {
                sort_event_records_type_first(&mut records);
                return Ok(records);
            };
            if records.len() >= MAX_EVENT_MASTER_SCAN {
                return Err(StoreError::CandidateLimitExceeded);
            }
            after = Some(next_after);
        }
    }

    async fn list_page(
        &self,
        range: EventQueryRange,
        after: Option<EventId>,
        limit: usize,
    ) -> Result<EventListPage, StoreError> {
        if limit == 0 || limit > EVENT_MASTER_PAGE_SIZE {
            return Err(StoreError::InvalidData);
        }
        let (start_utc_ms, end_utc_ms) = range.instant_bounds();
        let (start_date, end_date_exclusive) = range.date_bounds();
        let after = after.map(|id| id.to_string()).unwrap_or_default();
        let mut rows = sqlx::query_as::<_, EventRow>(
            "SELECT id, calendar_id, title, description, location, temporal_kind,
                    start_utc, end_utc, time_zone, start_date, end_date_exclusive,
                    rrule, revision, created_at, updated_at,
                    COALESCE((SELECT group_concat(lead_minutes, ',') FROM
                      (SELECT lead_minutes FROM reminders WHERE event_id = events.id ORDER BY lead_minutes)), '') AS reminder_offsets
             FROM events
             WHERE status = 'confirmed'
               AND NOT EXISTS (
                 SELECT 1 FROM event_overrides private_override
                 WHERE private_override.override_event_id = events.id
               )
               AND events.id > ?
               AND (
                 (
                   rrule IS NOT NULL
                   AND (
                     (temporal_kind = 'timed' AND start_utc < ?)
                     OR (temporal_kind = 'all_day' AND start_date < ?)
                   )
                 )
                 OR
                 (
                   rrule IS NULL
                   AND (
                     (temporal_kind = 'timed' AND start_utc < ? AND end_utc > ?)
                     OR
                     (temporal_kind = 'all_day' AND start_date < ? AND end_date_exclusive > ?)
                   )
                 )
                 OR EXISTS (
                   SELECT 1 FROM event_overrides visible_override
                   JOIN events replacement ON replacement.id = visible_override.override_event_id
                   WHERE visible_override.parent_event_id = events.id
                     AND replacement.status = 'confirmed'
                     AND (
                       (replacement.temporal_kind = 'timed' AND replacement.start_utc < ? AND replacement.end_utc > ?)
                       OR (replacement.temporal_kind = 'all_day' AND replacement.start_date < ? AND replacement.end_date_exclusive > ?)
                     )
                 )
               )
             ORDER BY events.id ASC
             LIMIT ?",
        )
        .bind(after)
        .bind(end_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(end_utc_ms)
        .bind(start_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(start_date.format("%Y-%m-%d").to_string())
        .bind(end_utc_ms)
        .bind(start_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(start_date.format("%Y-%m-%d").to_string())
        .bind(i64::try_from(limit + 1).map_err(|_| StoreError::InvalidData)?)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::Database)?;

        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let events = rows
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, _>>()?;
        let events = self.hydrate_overrides(events).await?;
        let next_after = has_more.then(|| events.last().expect("bounded page is non-empty").id);
        Ok(EventListPage {
            records: events,
            next_after,
        })
    }

    async fn list_all_page(
        &self,
        after: Option<EventId>,
        limit: usize,
    ) -> Result<EventListPage, StoreError> {
        if limit == 0 || limit > EVENT_MASTER_PAGE_SIZE {
            return Err(StoreError::InvalidData);
        }
        let after = after.map(|id| id.to_string()).unwrap_or_default();
        let mut rows = sqlx::query_as::<_, EventRow>(
            "SELECT id, calendar_id, title, description, location, temporal_kind,
                    start_utc, end_utc, time_zone, start_date, end_date_exclusive,
                    rrule, revision, created_at, updated_at,
                    COALESCE((SELECT group_concat(lead_minutes, ',') FROM
                      (SELECT lead_minutes FROM reminders WHERE event_id = events.id ORDER BY lead_minutes)), '') AS reminder_offsets
             FROM events
             WHERE status = 'confirmed'
               AND NOT EXISTS (
                 SELECT 1 FROM event_overrides private_override
                 WHERE private_override.override_event_id = events.id
               )
               AND events.id > ?
             ORDER BY events.id ASC
             LIMIT ?",
        )
        .bind(after)
        .bind(i64::try_from(limit + 1).map_err(|_| StoreError::InvalidData)?)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::Database)?;

        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let events = rows
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, _>>()?;
        let events = self.hydrate_overrides(events).await?;
        let next_after = has_more.then(|| events.last().expect("bounded page is non-empty").id);
        Ok(EventListPage {
            records: events,
            next_after,
        })
    }

    async fn search(
        &self,
        query: &str,
        range: EventQueryRange,
        candidate_limit: usize,
    ) -> Result<EventSearchPage, StoreError> {
        let (start_utc_ms, end_utc_ms) = range.instant_bounds();
        let (start_date, end_date_exclusive) = range.date_bounds();
        let pattern = literal_like_pattern(query);
        let fetch_limit = candidate_limit.saturating_add(1);
        let mut rows = sqlx::query_as::<_, EventRow>(
            "SELECT id, calendar_id, title, description, location, temporal_kind,
                    start_utc, end_utc, time_zone, start_date, end_date_exclusive,
                    rrule, revision, created_at, updated_at,
                    COALESCE((SELECT group_concat(lead_minutes, ',') FROM
                      (SELECT lead_minutes FROM reminders WHERE event_id = events.id ORDER BY lead_minutes)), '') AS reminder_offsets
             FROM events
             WHERE status = 'confirmed'
               AND NOT EXISTS (
                 SELECT 1 FROM event_overrides private_override
                 WHERE private_override.override_event_id = events.id
               )
               AND (
                 title LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR location LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR description LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR EXISTS (
                   SELECT 1 FROM event_overrides matching_override
                   JOIN events replacement ON replacement.id = matching_override.override_event_id
                   WHERE matching_override.parent_event_id = events.id
                     AND (
                       replacement.title LIKE ? ESCAPE '\\' COLLATE NOCASE
                       OR replacement.location LIKE ? ESCAPE '\\' COLLATE NOCASE
                       OR replacement.description LIKE ? ESCAPE '\\' COLLATE NOCASE
                     )
                 )
               )
               AND (
                 (
                   rrule IS NOT NULL
                   AND (
                     (temporal_kind = 'timed' AND start_utc < ?)
                     OR (temporal_kind = 'all_day' AND start_date < ?)
                   )
                 )
                 OR
                 (
                   rrule IS NULL
                   AND (
                     (temporal_kind = 'timed' AND start_utc < ? AND end_utc > ?)
                     OR
                     (temporal_kind = 'all_day' AND start_date < ? AND end_date_exclusive > ?)
                   )
                 )
                 OR EXISTS (
                   SELECT 1 FROM event_overrides visible_override
                   JOIN events replacement ON replacement.id = visible_override.override_event_id
                   WHERE visible_override.parent_event_id = events.id
                     AND replacement.status = 'confirmed'
                     AND (
                       (replacement.temporal_kind = 'timed' AND replacement.start_utc < ? AND replacement.end_utc > ?)
                       OR (replacement.temporal_kind = 'all_day' AND replacement.start_date < ? AND replacement.end_date_exclusive > ?)
                     )
                 )
               )
             ORDER BY
               CASE temporal_kind WHEN 'all_day' THEN 0 ELSE 1 END ASC,
               start_date ASC,
               start_utc ASC,
               id ASC
             LIMIT ?",
        )
        .bind(&pattern)
        .bind(&pattern)
        .bind(&pattern)
        .bind(&pattern)
        .bind(&pattern)
        .bind(&pattern)
        .bind(end_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(end_utc_ms)
        .bind(start_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(start_date.format("%Y-%m-%d").to_string())
        .bind(end_utc_ms)
        .bind(start_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(start_date.format("%Y-%m-%d").to_string())
        .bind(i64::try_from(fetch_limit).unwrap_or(i64::MAX))
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::Database)?;

        let has_more_candidates = rows.len() > candidate_limit;
        rows.truncate(candidate_limit);

        let events = rows
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(EventSearchPage {
            records: self.hydrate_overrides(events).await?,
            has_more_candidates,
        })
    }

    async fn update(
        &self,
        id: EventId,
        expected_revision: i64,
        event: EventDraft,
    ) -> Result<EventRecord, StoreError> {
        let _dispatch_barrier = self.calendar_mutation_guard().await;
        // Reserve SQLite's single writer slot before reading the revision. A
        // competing update then observes the committed winner (or proceeds
        // after its rollback) instead of failing a deferred read-to-write
        // promotion with SQLITE_BUSY(_SNAPSHOT).
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(StoreError::Database)?;
        let now = Utc::now().timestamp_millis();
        let current = Self::event_in_transaction(&mut transaction, id).await?;
        if current.revision != expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        let reminder_offsets = event.reminder_offsets_minutes().to_vec();
        let columns = EventWriteColumns::from(event);
        if !same_recurrence_identity(&current, &columns) {
            sqlx::query("DELETE FROM event_overrides WHERE parent_event_id = ?")
                .bind(id.to_string())
                .execute(&mut *transaction)
                .await
                .map_err(StoreError::Database)?;
        }
        let result = sqlx::query(
            "UPDATE events
             SET title = ?, description = ?, location = ?, temporal_kind = ?,
                 start_utc = ?, end_utc = ?, time_zone = ?, start_date = ?,
                 end_date_exclusive = ?, rrule = ?, revision = revision + 1,
                 updated_at = MAX(?, updated_at + 1)
             WHERE id = ? AND revision = ?",
        )
        .bind(columns.title)
        .bind(columns.notes)
        .bind(columns.location)
        .bind(columns.temporal_kind)
        .bind(columns.start_utc)
        .bind(columns.end_utc)
        .bind(columns.time_zone)
        .bind(columns.start_date)
        .bind(columns.end_date_exclusive)
        .bind(columns.rrule)
        .bind(now)
        .bind(id.to_string())
        .bind(expected_revision)
        .execute(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;

        if result.rows_affected() == 0 {
            return Err(Self::distinguish_missing_or_conflict(&mut transaction, id).await?);
        }

        reconcile_reminders(&mut transaction, id, &reminder_offsets, now).await?;

        let updated = Self::event_in_transaction(&mut transaction, id).await?;
        transaction.commit().await.map_err(StoreError::Database)?;
        self.advance_reminder_data_generation();
        Ok(updated)
    }

    async fn delete(&self, id: EventId, expected_revision: i64) -> Result<(), StoreError> {
        let _dispatch_barrier = self.calendar_mutation_guard().await;
        let mut transaction = self.pool.begin().await.map_err(StoreError::Database)?;
        let result = sqlx::query("DELETE FROM events WHERE id = ? AND revision = ?")
            .bind(id.to_string())
            .bind(expected_revision)
            .execute(&mut *transaction)
            .await
            .map_err(StoreError::Database)?;

        if result.rows_affected() == 0 {
            return Err(Self::distinguish_missing_or_conflict(&mut transaction, id).await?);
        }

        transaction.commit().await.map_err(StoreError::Database)?;
        self.advance_reminder_data_generation();
        Ok(())
    }

    async fn update_occurrence(
        &self,
        id: EventId,
        occurrence_key: &str,
        expected_revision: i64,
        event: EventDraft,
    ) -> Result<EventRecord, CalendarError> {
        let _dispatch_barrier = self.calendar_mutation_guard().await;
        let mut transaction = self.pool.begin().await.map_err(StoreError::Database)?;
        let parent = Self::event_in_transaction(&mut transaction, id).await?;
        if parent.revision != expected_revision {
            return Err(StoreError::RevisionConflict.into());
        }
        validate_occurrence_key(&parent, occurrence_key)?;

        let now = Utc::now().timestamp_millis();
        let reminder_offsets = event.reminder_offsets_minutes().to_vec();
        let columns = EventWriteColumns::from(event);
        if columns.rrule.is_some() {
            return Err(DomainError::InvalidRecurrenceRule.into());
        }
        let existing = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, override_event_id FROM event_overrides
             WHERE parent_event_id = ? AND original_start_key = ?",
        )
        .bind(id.to_string())
        .bind(occurrence_key)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;
        if existing.is_none() {
            ensure_override_capacity(&mut transaction, id).await?;
        }
        let replacement_id = existing
            .as_ref()
            .and_then(|(_, replacement_id)| replacement_id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        if existing
            .as_ref()
            .and_then(|(_, replacement_id)| replacement_id.as_ref())
            .is_some()
        {
            let result = sqlx::query(
                "UPDATE events
                 SET title = ?, description = ?, location = ?, temporal_kind = ?,
                     start_utc = ?, end_utc = ?, time_zone = ?, start_date = ?,
                     end_date_exclusive = ?, rrule = NULL, revision = revision + 1,
                     updated_at = MAX(?, updated_at + 1)
                 WHERE id = ?",
            )
            .bind(columns.title)
            .bind(columns.notes)
            .bind(columns.location)
            .bind(columns.temporal_kind)
            .bind(columns.start_utc)
            .bind(columns.end_utc)
            .bind(columns.time_zone)
            .bind(columns.start_date)
            .bind(columns.end_date_exclusive)
            .bind(now)
            .bind(&replacement_id)
            .execute(&mut *transaction)
            .await
            .map_err(StoreError::Database)?;
            if result.rows_affected() != 1 {
                return Err(StoreError::InvalidData.into());
            }
        } else {
            sqlx::query(
                "INSERT INTO events (
                    id, calendar_id, title, description, location, temporal_kind,
                    start_utc, end_utc, time_zone, start_date, end_date_exclusive,
                    rrule, status, revision, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'confirmed', 1, ?, ?)",
            )
            .bind(&replacement_id)
            .bind(parent.calendar_id.to_string())
            .bind(columns.title)
            .bind(columns.notes)
            .bind(columns.location)
            .bind(columns.temporal_kind)
            .bind(columns.start_utc)
            .bind(columns.end_utc)
            .bind(columns.time_zone)
            .bind(columns.start_date)
            .bind(columns.end_date_exclusive)
            .bind(now)
            .bind(now)
            .execute(&mut *transaction)
            .await
            .map_err(StoreError::Database)?;
        }
        let replacement_event_id =
            EventId(Uuid::parse_str(&replacement_id).map_err(|_| StoreError::InvalidData)?);
        reconcile_reminders(
            &mut transaction,
            replacement_event_id,
            &reminder_offsets,
            now,
        )
        .await?;

        match existing {
            Some((override_id, _)) => {
                sqlx::query(
                    "UPDATE event_overrides
                     SET override_event_id = ?, updated_at = MAX(?, updated_at + 1)
                     WHERE id = ?",
                )
                .bind(&replacement_id)
                .bind(now)
                .bind(override_id)
                .execute(&mut *transaction)
                .await
                .map_err(StoreError::Database)?;
            }
            None => {
                sqlx::query(
                    "INSERT INTO event_overrides (
                       id, parent_event_id, original_start_key, override_event_id,
                       created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(id.to_string())
                .bind(occurrence_key)
                .bind(&replacement_id)
                .bind(now)
                .bind(now)
                .execute(&mut *transaction)
                .await
                .map_err(StoreError::Database)?;
            }
        }

        let result = sqlx::query(
            "UPDATE events
             SET revision = revision + 1, updated_at = MAX(?, updated_at + 1)
             WHERE id = ? AND revision = ?",
        )
        .bind(now)
        .bind(id.to_string())
        .bind(expected_revision)
        .execute(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;
        if result.rows_affected() != 1 {
            return Err(Self::distinguish_missing_or_conflict(&mut transaction, id)
                .await?
                .into());
        }
        let updated = Self::event_in_transaction(&mut transaction, id).await?;
        transaction.commit().await.map_err(StoreError::Database)?;
        self.advance_reminder_data_generation();
        Ok(updated)
    }

    async fn delete_occurrence(
        &self,
        id: EventId,
        occurrence_key: &str,
        expected_revision: i64,
    ) -> Result<(), CalendarError> {
        let _dispatch_barrier = self.calendar_mutation_guard().await;
        let mut transaction = self.pool.begin().await.map_err(StoreError::Database)?;
        let parent = Self::event_in_transaction(&mut transaction, id).await?;
        if parent.revision != expected_revision {
            return Err(StoreError::RevisionConflict.into());
        }
        validate_occurrence_key(&parent, occurrence_key)?;
        let now = Utc::now().timestamp_millis();
        let existing = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, override_event_id FROM event_overrides
             WHERE parent_event_id = ? AND original_start_key = ?",
        )
        .bind(id.to_string())
        .bind(occurrence_key)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;
        if existing.is_none() {
            ensure_override_capacity(&mut transaction, id).await?;
        }
        let replacement_id = existing
            .as_ref()
            .and_then(|(_, replacement_id)| replacement_id.clone());
        match existing {
            Some((override_id, _)) => {
                sqlx::query(
                    "UPDATE event_overrides
                     SET override_event_id = NULL, updated_at = MAX(?, updated_at + 1)
                     WHERE id = ?",
                )
                .bind(now)
                .bind(override_id)
                .execute(&mut *transaction)
                .await
                .map_err(StoreError::Database)?;
            }
            None => {
                sqlx::query(
                    "INSERT INTO event_overrides (
                       id, parent_event_id, original_start_key, override_event_id,
                       created_at, updated_at
                     ) VALUES (?, ?, ?, NULL, ?, ?)",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(id.to_string())
                .bind(occurrence_key)
                .bind(now)
                .bind(now)
                .execute(&mut *transaction)
                .await
                .map_err(StoreError::Database)?;
            }
        }
        if let Some(replacement_id) = replacement_id {
            sqlx::query("DELETE FROM events WHERE id = ?")
                .bind(replacement_id)
                .execute(&mut *transaction)
                .await
                .map_err(StoreError::Database)?;
        }
        let result = sqlx::query(
            "UPDATE events
             SET revision = revision + 1, updated_at = MAX(?, updated_at + 1)
             WHERE id = ? AND revision = ?",
        )
        .bind(now)
        .bind(id.to_string())
        .bind(expected_revision)
        .execute(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;
        if result.rows_affected() != 1 {
            return Err(Self::distinguish_missing_or_conflict(&mut transaction, id)
                .await?
                .into());
        }
        transaction.commit().await.map_err(StoreError::Database)?;
        self.advance_reminder_data_generation();
        Ok(())
    }
}

// Keyset pages are intentionally scanned by immutable event ID so no master is
// skipped between pages. Restore the repository's established presentation
// order only after every bounded page has been collected.
#[cfg(test)]
fn sort_event_records_type_first(records: &mut [EventRecord]) {
    records.sort_by(|left, right| match (&left.time, &right.time) {
        (
            EventTime::AllDay {
                start_date: left_start,
                ..
            },
            EventTime::AllDay {
                start_date: right_start,
                ..
            },
        ) => left_start
            .cmp(right_start)
            .then_with(|| left.id.0.cmp(&right.id.0)),
        (EventTime::AllDay { .. }, EventTime::Timed { .. }) => std::cmp::Ordering::Less,
        (EventTime::Timed { .. }, EventTime::AllDay { .. }) => std::cmp::Ordering::Greater,
        (
            EventTime::Timed {
                start_utc_ms: left_start,
                ..
            },
            EventTime::Timed {
                start_utc_ms: right_start,
                ..
            },
        ) => left_start
            .cmp(right_start)
            .then_with(|| left.id.0.cmp(&right.id.0)),
    });
}

#[cfg(desktop)]
#[async_trait]
impl IcsImportRepository for SqliteEventStore {
    async fn source_identities(
        &self,
        source_uids: &[String],
    ) -> Result<Vec<ImportSourceIdentity>, StoreError> {
        if source_uids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT DISTINCT source_uid, source_sequence FROM event_import_sources \
             WHERE source_uid IN (",
        );
        let mut separated = query.separated(", ");
        for uid in source_uids {
            separated.push_bind(uid);
        }
        separated.push_unseparated(")");
        let rows = query
            .build_query_as::<(String, i64)>()
            .fetch_all(&self.pool)
            .await
            .map_err(StoreError::Database)?;
        Ok(rows
            .into_iter()
            .map(|(uid, sequence)| ImportSourceIdentity { uid, sequence })
            .collect())
    }

    async fn commit_import(
        &self,
        events: &[StagedImportEvent],
        duplicate_policy: ImportDuplicatePolicy,
        parser_version: &str,
        committed_at_utc_ms: i64,
    ) -> Result<ImportCommitResult, StoreError> {
        let _dispatch_barrier = self.calendar_mutation_guard().await;
        let mut transaction = self.pool.begin().await.map_err(StoreError::Database)?;
        let default_calendar_id = default_calendar_id(&mut transaction).await?;
        let mut imported_count = 0usize;
        let mut skipped_count = 0usize;

        for staged in events {
            if duplicate_policy == ImportDuplicatePolicy::SkipExisting {
                if let Some(identity) = &staged.source_identity {
                    let exists: i64 = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM event_import_sources WHERE source_uid = ?)",
                    )
                    .bind(&identity.uid)
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(StoreError::Database)?;
                    if exists == 1 {
                        skipped_count += 1;
                        continue;
                    }
                }
            }

            let id = EventId(Uuid::new_v4());
            let reminder_offsets = staged.draft.reminder_offsets_minutes().to_vec();
            let columns = EventWriteColumns::from(staged.draft.clone());
            sqlx::query(
                "INSERT INTO events (
                    id, calendar_id, title, description, location, temporal_kind,
                    start_utc, end_utc, time_zone, start_date, end_date_exclusive,
                    rrule, status, revision, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, ?, ?)",
            )
            .bind(id.to_string())
            .bind(default_calendar_id.to_string())
            .bind(columns.title)
            .bind(columns.notes)
            .bind(columns.location)
            .bind(columns.temporal_kind)
            .bind(columns.start_utc)
            .bind(columns.end_utc)
            .bind(columns.time_zone)
            .bind(columns.start_date)
            .bind(columns.end_date_exclusive)
            .bind(columns.rrule)
            .bind(committed_at_utc_ms)
            .bind(committed_at_utc_ms)
            .execute(&mut *transaction)
            .await
            .map_err(StoreError::Database)?;

            reconcile_reminders(&mut transaction, id, &reminder_offsets, committed_at_utc_ms)
                .await?;
            sqlx::query(
                "INSERT INTO event_import_sources (
                    event_id, source_uid, source_sequence, parser_version, imported_at
                 ) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(id.to_string())
            .bind(
                staged
                    .source_identity
                    .as_ref()
                    .map(|identity| identity.uid.as_str()),
            )
            .bind(
                staged
                    .source_identity
                    .as_ref()
                    .map(|identity| identity.sequence),
            )
            .bind(parser_version)
            .bind(committed_at_utc_ms)
            .execute(&mut *transaction)
            .await
            .map_err(StoreError::Database)?;
            imported_count += 1;
        }

        transaction.commit().await.map_err(StoreError::Database)?;
        self.advance_reminder_data_generation();
        Ok(ImportCommitResult {
            imported_count,
            skipped_count,
        })
    }
}

#[cfg(desktop)]
#[async_trait]
impl IcsExportRepository for SqliteEventStore {
    async fn list_export_candidates(
        &self,
        range: &EventQueryRange,
        limit: usize,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let (start_utc_ms, end_utc_ms) = range.instant_bounds();
        let (start_date, end_date_exclusive) = range.date_bounds();
        let rows = sqlx::query_as::<_, EventRow>(
            "SELECT id, calendar_id, title, description, location, temporal_kind,
                    start_utc, end_utc, time_zone, start_date, end_date_exclusive,
                    rrule, revision, created_at, updated_at,
                    COALESCE((SELECT group_concat(lead_minutes, ',') FROM
                      (SELECT lead_minutes FROM reminders WHERE event_id = events.id ORDER BY lead_minutes)), '') AS reminder_offsets
             FROM events
             WHERE status = 'confirmed'
               AND NOT EXISTS (
                 SELECT 1 FROM event_overrides private_override
                 WHERE private_override.override_event_id = events.id
               )
               AND (
                 (
                   rrule IS NOT NULL
                   AND (
                     (temporal_kind = 'timed' AND start_utc < ?)
                     OR (temporal_kind = 'all_day' AND start_date < ?)
                   )
                 )
                 OR
                 (
                   rrule IS NULL
                   AND (
                     (temporal_kind = 'timed' AND start_utc < ? AND end_utc > ?)
                     OR (temporal_kind = 'all_day' AND start_date < ? AND end_date_exclusive > ?)
                   )
                 )
                 OR EXISTS (
                   SELECT 1 FROM event_overrides visible_override
                   JOIN events replacement ON replacement.id = visible_override.override_event_id
                   WHERE visible_override.parent_event_id = events.id
                     AND replacement.status = 'confirmed'
                     AND (
                       (replacement.temporal_kind = 'timed' AND replacement.start_utc < ? AND replacement.end_utc > ?)
                       OR (replacement.temporal_kind = 'all_day' AND replacement.start_date < ? AND replacement.end_date_exclusive > ?)
                     )
                 )
               )
             ORDER BY
               CASE temporal_kind WHEN 'all_day' THEN 0 ELSE 1 END ASC,
               start_date ASC,
               start_utc ASC,
               id ASC
             LIMIT ?",
        )
        .bind(end_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(end_utc_ms)
        .bind(start_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(start_date.format("%Y-%m-%d").to_string())
        .bind(end_utc_ms)
        .bind(start_utc_ms)
        .bind(end_date_exclusive.format("%Y-%m-%d").to_string())
        .bind(start_date.format("%Y-%m-%d").to_string())
        .bind(i64::try_from(limit).unwrap_or(i64::MAX))
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::Database)?;

        let events = rows
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, _>>()?;
        self.hydrate_overrides(events).await
    }
}

#[async_trait]
impl SettingsRepository for SqliteEventStore {
    async fn get_settings(&self) -> Result<CalendarSettings, StoreError> {
        let row = sqlx::query_as::<_, SettingsRow>(
            "SELECT default_event_duration_minutes, week_starts_on, time_format,
                    default_reminder_minutes
             FROM calendar_settings WHERE singleton_id = 1",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::Database)?
        .ok_or(StoreError::InvalidData)?;
        row.try_into()
    }

    async fn update_settings(
        &self,
        patch: CalendarSettingsPatch,
    ) -> Result<CalendarSettings, StoreError> {
        let mut transaction = self.pool.begin().await.map_err(StoreError::Database)?;

        let current = settings_in_transaction(&mut transaction).await?;
        if patch.is_empty() {
            transaction.commit().await.map_err(StoreError::Database)?;
            return Ok(current);
        }

        sqlx::query(
            "UPDATE calendar_settings
             SET default_event_duration_minutes = COALESCE(?, default_event_duration_minutes),
                 week_starts_on = COALESCE(?, week_starts_on),
                 time_format = COALESCE(?, time_format),
                 default_reminder_minutes = CASE WHEN ? THEN ? ELSE default_reminder_minutes END
             WHERE singleton_id = 1",
        )
        .bind(patch.default_event_duration_minutes())
        .bind(patch.week_starts_on())
        .bind(patch.time_format())
        .bind(patch.default_reminder_minutes().is_some())
        .bind(patch.default_reminder_minutes().flatten())
        .execute(&mut *transaction)
        .await
        .map_err(StoreError::Database)?;

        let updated = settings_in_transaction(&mut transaction).await?;
        transaction.commit().await.map_err(StoreError::Database)?;
        Ok(updated)
    }
}

async fn settings_in_transaction(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<CalendarSettings, StoreError> {
    let row = sqlx::query_as::<_, SettingsRow>(
        "SELECT default_event_duration_minutes, week_starts_on, time_format,
                default_reminder_minutes
         FROM calendar_settings WHERE singleton_id = 1",
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(StoreError::Database)?
    .ok_or(StoreError::InvalidData)?;
    row.try_into()
}

fn literal_like_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len() + 2);
    escaped.push('%');
    for character in query.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.push('%');
    escaped
}

async fn default_calendar_id(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<CalendarId, StoreError> {
    let value: String = sqlx::query_scalar(
        "SELECT id FROM calendars WHERE is_default = 1 AND is_read_only = 0 LIMIT 1",
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(StoreError::Database)?
    .ok_or(StoreError::InvalidData)?;
    let id = Uuid::parse_str(&value).map_err(|_| StoreError::InvalidData)?;
    Ok(CalendarId(id))
}

async fn seed_default_calendar(pool: &SqlitePool) -> Result<(), StoreError> {
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO calendars (
            id, name, color_token, is_default, is_read_only, source_type, created_at, updated_at
         ) VALUES (?, 'Personal', 'calendar-default', 1, 0, 'local', ?, ?)
         ON CONFLICT DO NOTHING",
    )
    .bind(DEFAULT_CALENDAR_ID)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(StoreError::Database)?;
    Ok(())
}

async fn verify_integrity(pool: &SqlitePool) -> Result<(), StoreError> {
    let result: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(pool)
        .await
        .map_err(StoreError::Database)?;
    if result == "ok" {
        Ok(())
    } else {
        Err(StoreError::InvalidData)
    }
}

const EVENT_SELECT_BY_ID: &str =
    "SELECT id, calendar_id, title, description, location, temporal_kind,
            start_utc, end_utc, time_zone, start_date, end_date_exclusive,
            rrule, revision, created_at, updated_at,
            COALESCE((SELECT group_concat(lead_minutes, ',') FROM
              (SELECT lead_minutes FROM reminders WHERE event_id = events.id ORDER BY lead_minutes)), '') AS reminder_offsets
     FROM events WHERE id = ?
       AND NOT EXISTS (
         SELECT 1 FROM event_overrides private_override
         WHERE private_override.override_event_id = events.id
       )";

#[derive(Debug, FromRow)]
struct OverrideLinkRow {
    parent_event_id: String,
    original_start_key: String,
    override_event_id: Option<String>,
}

#[derive(Debug, FromRow)]
struct EventRow {
    id: String,
    calendar_id: String,
    title: String,
    description: Option<String>,
    location: Option<String>,
    temporal_kind: String,
    start_utc: Option<i64>,
    end_utc: Option<i64>,
    time_zone: Option<String>,
    start_date: Option<String>,
    end_date_exclusive: Option<String>,
    rrule: Option<String>,
    revision: i64,
    created_at: i64,
    updated_at: i64,
    reminder_offsets: String,
}

#[derive(Debug, FromRow)]
struct SettingsRow {
    default_event_duration_minutes: i64,
    week_starts_on: String,
    time_format: String,
    default_reminder_minutes: Option<i64>,
}

impl TryFrom<SettingsRow> for CalendarSettings {
    type Error = StoreError;

    fn try_from(row: SettingsRow) -> Result<Self, Self::Error> {
        CalendarSettings::from_persisted(
            row.default_event_duration_minutes,
            &row.week_starts_on,
            &row.time_format,
            row.default_reminder_minutes,
        )
    }
}

impl TryFrom<EventRow> for EventRecord {
    type Error = StoreError;

    fn try_from(row: EventRow) -> Result<Self, Self::Error> {
        let id = EventId(Uuid::parse_str(&row.id).map_err(|_| StoreError::InvalidData)?);
        let calendar_id =
            CalendarId(Uuid::parse_str(&row.calendar_id).map_err(|_| StoreError::InvalidData)?);
        let time = match row.temporal_kind.as_str() {
            "timed" => {
                let time_zone = row.time_zone.ok_or(StoreError::InvalidData)?;
                chrono_tz::Tz::from_str(&time_zone).map_err(|_| StoreError::InvalidData)?;
                EventTime::Timed {
                    start_utc_ms: row.start_utc.ok_or(StoreError::InvalidData)?,
                    end_utc_ms: row.end_utc.ok_or(StoreError::InvalidData)?,
                    time_zone,
                }
            }
            "all_day" => EventTime::AllDay {
                start_date: NaiveDate::from_str(
                    row.start_date.as_deref().ok_or(StoreError::InvalidData)?,
                )
                .map_err(|_| StoreError::InvalidData)?,
                end_date_exclusive: NaiveDate::from_str(
                    row.end_date_exclusive
                        .as_deref()
                        .ok_or(StoreError::InvalidData)?,
                )
                .map_err(|_| StoreError::InvalidData)?,
            },
            _ => return Err(StoreError::InvalidData),
        };
        let recurrence_rule = row
            .rrule
            .map(|source| RecurrenceRule::validated(source, &time))
            .transpose()
            .map_err(|_| StoreError::InvalidData)?;

        Ok(Self {
            id,
            calendar_id,
            title: row.title,
            notes: row.description,
            location: row.location,
            time,
            recurrence_rule,
            reminder_offsets_minutes: parse_reminder_offsets(&row.reminder_offsets)?,
            revision: row.revision,
            created_at_utc_ms: row.created_at,
            updated_at_utc_ms: row.updated_at,
            occurrence_overrides: Vec::new(),
        })
    }
}

fn parse_reminder_offsets(value: &str) -> Result<Vec<i64>, StoreError> {
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let offsets = value
        .split(',')
        .map(|part| part.parse::<i64>().map_err(|_| StoreError::InvalidData))
        .collect::<Result<Vec<_>, _>>()?;
    crate::calendar::domain::validate_reminder_offsets(offsets).map_err(|_| StoreError::InvalidData)
}

async fn reconcile_reminders(
    transaction: &mut Transaction<'_, Sqlite>,
    event_id: EventId,
    offsets: &[i64],
    now: i64,
) -> Result<(), StoreError> {
    let canonical = offsets
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    sqlx::query(
        "DELETE FROM reminders
         WHERE event_id = ?
           AND instr(',' || ? || ',', ',' || lead_minutes || ',') = 0",
    )
    .bind(event_id.to_string())
    .bind(canonical)
    .execute(&mut **transaction)
    .await
    .map_err(StoreError::Database)?;

    for offset in offsets {
        sqlx::query(
            "INSERT INTO reminders (id, event_id, lead_minutes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(event_id, lead_minutes) DO UPDATE SET updated_at = excluded.updated_at",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(event_id.to_string())
        .bind(offset)
        .bind(now)
        .bind(now)
        .execute(&mut **transaction)
        .await
        .map_err(StoreError::Database)?;
    }
    Ok(())
}

async fn ensure_override_capacity(
    transaction: &mut Transaction<'_, Sqlite>,
    parent_id: EventId,
) -> Result<(), StoreError> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM event_overrides WHERE parent_event_id = ?")
            .bind(parent_id.to_string())
            .fetch_one(&mut **transaction)
            .await
            .map_err(StoreError::Database)?;
    if count >= i64::try_from(MAX_OVERRIDES_PER_MASTER).unwrap_or(i64::MAX) {
        Err(StoreError::OverrideLimitExceeded)
    } else {
        Ok(())
    }
}

struct EventWriteColumns {
    title: String,
    notes: Option<String>,
    location: Option<String>,
    temporal_kind: &'static str,
    start_utc: Option<i64>,
    end_utc: Option<i64>,
    time_zone: Option<String>,
    start_date: Option<String>,
    end_date_exclusive: Option<String>,
    rrule: Option<String>,
}

impl From<EventDraft> for EventWriteColumns {
    fn from(event: EventDraft) -> Self {
        let (title, notes, location, time, recurrence_rule) = event.into_parts();
        let rrule = recurrence_rule.map(|rule| rule.source().to_owned());
        match time {
            EventTime::Timed {
                start_utc_ms,
                end_utc_ms,
                time_zone,
            } => Self {
                title,
                notes,
                location,
                temporal_kind: "timed",
                start_utc: Some(start_utc_ms),
                end_utc: Some(end_utc_ms),
                time_zone: Some(time_zone),
                start_date: None,
                end_date_exclusive: None,
                rrule,
            },
            EventTime::AllDay {
                start_date,
                end_date_exclusive,
            } => Self {
                title,
                notes,
                location,
                temporal_kind: "all_day",
                start_utc: None,
                end_utc: None,
                time_zone: None,
                start_date: Some(start_date.format("%Y-%m-%d").to_string()),
                end_date_exclusive: Some(end_date_exclusive.format("%Y-%m-%d").to_string()),
                rrule,
            },
        }
    }
}

fn same_recurrence_identity(current: &EventRecord, updated: &EventWriteColumns) -> bool {
    if current.recurrence_rule.as_ref().map(|rule| rule.source()) != updated.rrule.as_deref() {
        return false;
    }
    match &current.time {
        EventTime::Timed {
            start_utc_ms,
            time_zone,
            ..
        } => {
            updated.temporal_kind == "timed"
                && updated.start_utc == Some(*start_utc_ms)
                && updated.time_zone.as_deref() == Some(time_zone.as_str())
        }
        EventTime::AllDay { start_date, .. } => {
            updated.temporal_kind == "all_day"
                && updated.start_date.as_deref()
                    == Some(start_date.format("%Y-%m-%d").to_string().as_str())
        }
    }
}

#[cfg(test)]
mod integration_tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Arc;

    use super::*;
    use crate::calendar::{
        domain::{
            parse_all_day_event, resolve_timed_event, zoned_date_start_utc_ms, EventDraft,
            EventQueryRange, EventSearchQuery, EventTime,
        },
        error::StoreError,
        service::CalendarService,
    };
    use crate::calendar_store::EventRepository;

    fn timed(title: &str, start: &str, end: &str, time_zone: &str) -> EventDraft {
        EventDraft::validated(
            title.into(),
            Some("Keep this private".into()),
            Some("Room 2".into()),
            resolve_timed_event(start, end, time_zone).unwrap(),
        )
        .unwrap()
    }

    fn all_day(title: &str, start: &str, end_exclusive: &str) -> EventDraft {
        EventDraft::validated(
            title.into(),
            None,
            None,
            parse_all_day_event(start, end_exclusive).unwrap(),
        )
        .unwrap()
    }

    fn recurring_all_day(
        title: &str,
        start: &str,
        end_exclusive: &str,
        recurrence_rule: &str,
    ) -> EventDraft {
        EventDraft::validated_with_recurrence(
            title.into(),
            None,
            None,
            parse_all_day_event(start, end_exclusive).unwrap(),
            Some(recurrence_rule.into()),
        )
        .unwrap()
    }

    fn july_query() -> EventQueryRange {
        EventQueryRange::validated(
            1_782_864_000_000,
            1_785_542_400_000,
            "2026-07-01",
            "2026-08-01",
        )
        .unwrap()
    }

    #[tokio::test]
    async fn timed_and_all_day_records_round_trip_and_list_stably() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();

        let timed_record = store
            .create(timed(
                "Dentist",
                "2026-07-21T15:00:00",
                "2026-07-21T15:45:00",
                "America/Chicago",
            ))
            .await
            .unwrap();
        let all_day_record = store
            .create(all_day("Day off", "2026-07-21", "2026-07-22"))
            .await
            .unwrap();

        assert_eq!(
            store.get(timed_record.id).await.unwrap(),
            Some(timed_record.clone())
        );
        assert_eq!(
            store.get(all_day_record.id).await.unwrap(),
            Some(all_day_record.clone())
        );
        assert!(matches!(timed_record.time, EventTime::Timed { .. }));
        assert!(matches!(all_day_record.time, EventTime::AllDay { .. }));
        assert_eq!(timed_record.calendar_id, all_day_record.calendar_id);

        let first = store.list(july_query()).await.unwrap();
        let second = store.list(july_query()).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 2);
        // The repository deliberately provides deterministic type-first order; the UI regroups by day.
        assert_eq!(first[0].id, all_day_record.id);
        assert_eq!(first[1].id, timed_record.id);
    }

    #[tokio::test]
    async fn half_open_queries_include_intersections_and_exclude_touching_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let timed_record = store
            .create(timed(
                "Boundary",
                "2026-07-21T15:00:00",
                "2026-07-21T16:00:00",
                "UTC",
            ))
            .await
            .unwrap();
        let all_day_record = store
            .create(all_day("Boundary day", "2026-07-21", "2026-07-22"))
            .await
            .unwrap();

        let intersecting = EventQueryRange::validated(
            1_784_645_999_999,
            1_784_646_000_001,
            "2026-07-21",
            "2026-07-22",
        )
        .unwrap();
        let results = store.list(intersecting).await.unwrap();
        assert!(results.iter().any(|event| event.id == timed_record.id));
        assert!(results.iter().any(|event| event.id == all_day_record.id));

        let touching_end = EventQueryRange::validated(
            1_784_649_600_000,
            1_784_649_600_001,
            "2026-07-22",
            "2026-07-23",
        )
        .unwrap();
        let results = store.list(touching_end).await.unwrap();
        assert!(!results.iter().any(|event| event.id == timed_record.id));
        assert!(!results.iter().any(|event| event.id == all_day_record.id));
    }

    #[tokio::test]
    async fn overnight_timed_event_persists_and_intersects_both_adjacent_civil_days() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let overnight = store
            .create(timed(
                "Overnight",
                "2026-07-21T23:30:00",
                "2026-07-22T00:30:00",
                "America/Chicago",
            ))
            .await
            .unwrap();

        assert_eq!(
            store.get(overnight.id).await.unwrap(),
            Some(overnight.clone())
        );

        let time_zone: chrono_tz::Tz = "America/Chicago".parse().unwrap();
        for (start, end, expected) in [
            ("2026-07-21", "2026-07-22", true),
            ("2026-07-22", "2026-07-23", true),
            ("2026-07-23", "2026-07-24", false),
        ] {
            let start_date = NaiveDate::parse_from_str(start, "%Y-%m-%d").unwrap();
            let end_date = NaiveDate::parse_from_str(end, "%Y-%m-%d").unwrap();
            let range = EventQueryRange::validated(
                zoned_date_start_utc_ms(start_date, time_zone).unwrap(),
                zoned_date_start_utc_ms(end_date, time_zone).unwrap(),
                start,
                end,
            )
            .unwrap();
            let contains_overnight = store
                .list(range)
                .await
                .unwrap()
                .iter()
                .any(|event| event.id == overnight.id);
            assert_eq!(contains_overnight, expected, "civil day {start}");
        }
    }

    #[tokio::test]
    async fn concurrent_updates_conflict_and_delete_requires_current_revision() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let record = store
            .create(all_day("Original", "2026-07-21", "2026-07-22"))
            .await
            .unwrap();

        let left = store.update(
            record.id,
            record.revision,
            all_day("Left", "2026-07-21", "2026-07-22"),
        );
        let right = store.update(
            record.id,
            record.revision,
            all_day("Right", "2026-07-21", "2026-07-22"),
        );
        let (left, right) = tokio::join!(left, right);
        assert!(
        matches!(
            (&left, &right),
            (Ok(_), Err(StoreError::RevisionConflict)) | (Err(StoreError::RevisionConflict), Ok(_))
        ),
        "expected exactly one successful update and one revision conflict, got left={left:?}, right={right:?}"
    );

        let current = store.get(record.id).await.unwrap().unwrap();
        assert_eq!(current.revision, 2);
        assert!(current.updated_at_utc_ms > record.updated_at_utc_ms);
        assert!(matches!(
            store.delete(record.id, 1).await,
            Err(StoreError::RevisionConflict)
        ));
        store.delete(record.id, current.revision).await.unwrap();
        assert_eq!(store.get(record.id).await.unwrap(), None);
        assert!(matches!(
            store.delete(record.id, current.revision).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn concurrent_recurrence_identity_updates_conflict_before_override_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let record = store
            .create(recurring_all_day(
                "Recurring",
                "2026-07-21",
                "2026-07-22",
                "FREQ=DAILY;COUNT=5",
            ))
            .await
            .unwrap();

        let left = store.update(
            record.id,
            record.revision,
            all_day("Left", "2026-07-21", "2026-07-22"),
        );
        let right = store.update(
            record.id,
            record.revision,
            all_day("Right", "2026-07-21", "2026-07-22"),
        );
        let (left, right) = tokio::join!(left, right);

        assert!(
        matches!(
            (&left, &right),
            (Ok(_), Err(StoreError::RevisionConflict)) | (Err(StoreError::RevisionConflict), Ok(_))
        ),
        "expected override cleanup to preserve optimistic concurrency, got left={left:?}, right={right:?}"
    );
        let current = store.get(record.id).await.unwrap().unwrap();
        assert_eq!(current.revision, 2);
        assert!(current.recurrence_rule.is_none());
    }

    #[tokio::test]
    async fn reopening_is_idempotent_preserves_data_and_restores_missing_seed() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("calendar.sqlite3");
        let store = SqliteEventStore::open(&database_path).await.unwrap();
        let event = store
            .create(all_day("Persisted", "2026-07-21", "2026-07-22"))
            .await
            .unwrap();
        drop(store);

        let reopened = SqliteEventStore::open(&database_path).await.unwrap();
        assert_eq!(reopened.get(event.id).await.unwrap(), Some(event));
        drop(reopened);

        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .foreign_keys(false);
        let inspection_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("DELETE FROM events")
            .execute(&inspection_pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM calendars")
            .execute(&inspection_pool)
            .await
            .unwrap();
        inspection_pool.close().await;

        let restored = SqliteEventStore::open(&database_path).await.unwrap();
        let restored_event = restored
            .create(all_day("After restore", "2026-07-23", "2026-07-24"))
            .await
            .unwrap();
        assert_eq!(
            restored_event.calendar_id.to_string(),
            "00000000-0000-4000-8000-000000000001"
        );
    }

    #[tokio::test]
    async fn recurring_master_round_trips_and_service_projects_bounded_occurrences() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let master = store
            .create(recurring_all_day(
                "Daily focus",
                "2026-07-01",
                "2026-07-02",
                "FREQ=DAILY;COUNT=31",
            ))
            .await
            .unwrap();
        assert_eq!(
            master.recurrence_rule.as_ref().map(|rule| rule.source()),
            Some("FREQ=DAILY;COUNT=31")
        );
        assert_eq!(store.get(master.id).await.unwrap(), Some(master.clone()));

        let query = EventQueryRange::validated(
            1_784_534_400_000,
            1_784_793_600_000,
            "2026-07-20",
            "2026-07-23",
        )
        .unwrap();
        let candidates = store.list(query.clone()).await.unwrap();
        assert_eq!(candidates, vec![master.clone()]);

        let service = CalendarService::new(Arc::new(store));
        let occurrences = service.list_events(query).await.unwrap();
        assert_eq!(occurrences.len(), 3);
        assert!(occurrences.iter().all(|item| item.event_id == master.id));
        assert_eq!(
            occurrences
                .iter()
                .map(|item| item.occurrence_key.clone())
                .collect::<Vec<_>>(),
            [
                format!("{}/all-day/2026-07-20", master.id),
                format!("{}/all-day/2026-07-21", master.id),
                format!("{}/all-day/2026-07-22", master.id),
            ]
        );
    }

    #[tokio::test]
    async fn search_matches_all_text_fields_case_insensitively() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let title = store
            .create(all_day("Project PHOENIX", "2026-07-10", "2026-07-11"))
            .await
            .unwrap();
        let location = store
            .create(
                EventDraft::validated(
                    "Location match".into(),
                    None,
                    Some("Phoenix Hall".into()),
                    parse_all_day_event("2026-07-11", "2026-07-12").unwrap(),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let notes = store
            .create(
                EventDraft::validated(
                    "Notes match".into(),
                    Some("Call the phoenix team".into()),
                    None,
                    parse_all_day_event("2026-07-12", "2026-07-13").unwrap(),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        store
            .create(all_day("Unrelated", "2026-07-13", "2026-07-14"))
            .await
            .unwrap();

        let matches = store.search("pHoEnIx", july_query(), 20).await.unwrap();
        let ids = matches
            .records
            .iter()
            .map(|event| event.id)
            .collect::<Vec<_>>();
        assert_eq!(matches.records.len(), 3);
        assert!(!matches.has_more_candidates);
        assert!(ids.contains(&title.id));
        assert!(ids.contains(&location.id));
        assert!(ids.contains(&notes.id));
    }

    #[tokio::test]
    async fn search_treats_sql_like_metacharacters_as_literal_text() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let literal = store
            .create(all_day(
                r"Literal 100% _ \ marker",
                "2026-07-10",
                "2026-07-11",
            ))
            .await
            .unwrap();
        store
            .create(all_day(
                "Ordinary 100 percent marker",
                "2026-07-11",
                "2026-07-12",
            ))
            .await
            .unwrap();

        for query in ["%", "_", r"\"] {
            let matches = store.search(query, july_query(), 20).await.unwrap();
            assert_eq!(matches.records.len(), 1, "query {query:?} must be literal");
            assert_eq!(matches.records[0].id, literal.id);
            assert!(!matches.has_more_candidates);
        }
    }

    #[tokio::test]
    async fn repository_search_reports_exact_candidate_exhaustion_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        for index in 0..200 {
            store
                .create(recurring_all_day(
                    &format!("Candidate boundary ended {index:03}"),
                    "2026-01-01",
                    "2026-01-02",
                    "FREQ=DAILY;COUNT=1",
                ))
                .await
                .unwrap();
        }

        let exact = store
            .search("candidate boundary", july_query(), 200)
            .await
            .unwrap();
        assert_eq!(exact.records.len(), 200);
        assert!(!exact.has_more_candidates);

        let live = store
            .create(recurring_all_day(
                "Candidate boundary live",
                "2026-07-21",
                "2026-07-22",
                "FREQ=DAILY;COUNT=1",
            ))
            .await
            .unwrap();
        let capped = store
            .search("candidate boundary", july_query(), 200)
            .await
            .unwrap();
        assert_eq!(capped.records.len(), 200);
        assert!(capped.has_more_candidates);
        assert!(capped.records.iter().all(|event| event.id != live.id));

        let all = store
            .search("candidate boundary", july_query(), 201)
            .await
            .unwrap();
        assert_eq!(all.records.len(), 201);
        assert!(!all.has_more_candidates);
        assert_eq!(all.records[200].id, live.id);
    }

    #[tokio::test]
    async fn search_projects_recurring_masters_and_preserves_stable_identities() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let master = store
            .create(recurring_all_day(
                "Searchable planning",
                "2026-07-01",
                "2026-07-02",
                "FREQ=DAILY;COUNT=31",
            ))
            .await
            .unwrap();
        let service = CalendarService::new(Arc::new(store));
        let range = EventQueryRange::validated(
            1_784_534_400_000,
            1_784_793_600_000,
            "2026-07-20",
            "2026-07-23",
        )
        .unwrap();
        let query = EventSearchQuery::validated("planning".into(), 10).unwrap();

        let first = service
            .search_events(query.clone(), range.clone())
            .await
            .unwrap();
        let second = service.search_events(query, range).await.unwrap();

        assert_eq!(first, second);
        assert!(!first.has_more_candidates);
        assert_eq!(first.occurrences.len(), 3);
        assert!(first
            .occurrences
            .iter()
            .all(|item| item.event_id == master.id));
        assert_eq!(
            first
                .occurrences
                .iter()
                .map(|item| item.occurrence_key.as_str())
                .collect::<Vec<_>>(),
            [
                format!("{}/all-day/2026-07-20", master.id),
                format!("{}/all-day/2026-07-21", master.id),
                format!("{}/all-day/2026-07-22", master.id),
            ]
        );
    }

    #[tokio::test]
    async fn search_result_limit_truncates_large_projection_without_overflow() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        store
            .create(recurring_all_day(
                "Long search series",
                "2026-07-01",
                "2026-07-02",
                "FREQ=DAILY;COUNT=100",
            ))
            .await
            .unwrap();
        let service = CalendarService::new(Arc::new(store));
        let range =
            EventQueryRange::validated(0, 70 * 86_400_000, "2026-07-01", "2026-09-09").unwrap();
        let query = EventSearchQuery::validated("search series".into(), 50).unwrap();

        let results = service.search_events(query, range).await.unwrap();
        assert!(!results.has_more_candidates);
        assert_eq!(results.occurrences.len(), 50);
        assert!(results
            .occurrences
            .windows(2)
            .all(|pair| pair[0].occurrence_key < pair[1].occurrence_key));
    }
}

#[cfg(test)]
mod override_and_settings_tests {
    use std::sync::Arc;

    use super::*;
    use crate::{
        calendar::{
            domain::{parse_all_day_event, EventDraft, EventSearchQuery},
            error::CalendarError,
            service::CalendarService,
            settings::CalendarSettingsPatch,
        },
        calendar_store::{EventRepository, SettingsRepository},
    };

    fn recurring(title: &str) -> EventDraft {
        EventDraft::validated_with_recurrence_and_reminders(
            title.into(),
            Some("Parent notes".into()),
            Some("Room 1".into()),
            parse_all_day_event("2026-07-21", "2026-07-22").unwrap(),
            Some("FREQ=DAILY;COUNT=5".into()),
            vec![30],
        )
        .unwrap()
    }

    fn replacement(title: &str, start: &str, end: &str) -> EventDraft {
        EventDraft::validated_with_recurrence_and_reminders(
            title.into(),
            Some("Override notes".into()),
            Some("Room 2".into()),
            parse_all_day_event(start, end).unwrap(),
            None,
            vec![60],
        )
        .unwrap()
    }

    fn range(start: &str, end: &str) -> EventQueryRange {
        let start_date = NaiveDate::parse_from_str(start, "%Y-%m-%d").unwrap();
        let end_date = NaiveDate::parse_from_str(end, "%Y-%m-%d").unwrap();
        EventQueryRange::validated(
            start_date
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis(),
            end_date
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis(),
            start,
            end,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn occurrence_replacements_cancellations_and_revisions_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("calendar.sqlite3");
        let store = SqliteEventStore::open(&path).await.unwrap();
        let parent = store.create(recurring("Daily standup")).await.unwrap();
        let key = format!("{}/all-day/2026-07-22", parent.id);

        let updated = store
            .update_occurrence(
                parent.id,
                &key,
                parent.revision,
                replacement("Special planning", "2026-07-28", "2026-07-29"),
            )
            .await
            .unwrap();
        assert_eq!(updated.revision, parent.revision + 1);
        assert_eq!(
            store
                .get(parent.id)
                .await
                .unwrap()
                .unwrap()
                .occurrence_overrides
                .len(),
            1
        );

        let service = CalendarService::new(Arc::new(store.clone()));
        let original = service
            .list_events(range("2026-07-21", "2026-07-26"))
            .await
            .unwrap();
        assert_eq!(original.len(), 4);
        assert!(!original.iter().any(|item| item.occurrence_key == key));
        let moved = service
            .search_events(
                EventSearchQuery::validated("special".into(), 10).unwrap(),
                range("2026-07-27", "2026-07-30"),
            )
            .await
            .unwrap();
        assert_eq!(moved.occurrences.len(), 1);
        assert_eq!(moved.occurrences[0].event_id, parent.id);
        assert_eq!(moved.occurrences[0].occurrence_key, key);
        assert_eq!(moved.occurrences[0].revision, updated.revision);
        assert_eq!(moved.occurrences[0].reminder_offsets_minutes, vec![60]);

        assert!(matches!(
            store
                .delete_occurrence(parent.id, &key, parent.revision)
                .await,
            Err(CalendarError::Store(StoreError::RevisionConflict))
        ));
        store
            .delete_occurrence(parent.id, &key, updated.revision)
            .await
            .unwrap();
        let cancelled = store.get(parent.id).await.unwrap().unwrap();
        assert_eq!(cancelled.revision, updated.revision + 1);
        assert_eq!(cancelled.occurrence_overrides.len(), 1);

        drop(service);
        drop(store);
        let reopened = SqliteEventStore::open(&path).await.unwrap();
        let reopened_parent = reopened.get(parent.id).await.unwrap().unwrap();
        assert_eq!(reopened_parent.revision, cancelled.revision);
        assert_eq!(reopened_parent.occurrence_overrides.len(), 1);
        reopened
            .delete(parent.id, reopened_parent.revision)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events")
                .fetch_one(reopened.pool())
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn settings_and_reminder_offsets_persist_at_the_validated_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("calendar.sqlite3");
        let store = SqliteEventStore::open(&path).await.unwrap();
        let defaults = store.get_settings().await.unwrap();
        assert_eq!(defaults.default_event_duration_minutes, 60);
        assert_eq!(defaults.default_reminder_minutes, None);

        let patch = CalendarSettingsPatch::validated_values_with_reminder(
            Some(45),
            Some("sunday"),
            Some("24h"),
            Some(Some(50_400)),
        )
        .unwrap();
        let updated = store.update_settings(patch).await.unwrap();
        assert_eq!(updated.default_event_duration_minutes, 45);
        assert_eq!(updated.default_reminder_minutes, Some(50_400));

        let event = store
            .create(
                EventDraft::validated_with_recurrence_and_reminders(
                    "Long lead".into(),
                    None,
                    None,
                    parse_all_day_event("2026-07-21", "2026-07-22").unwrap(),
                    None,
                    vec![0, 50_400],
                )
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(event.reminder_offsets_minutes, vec![0, 50_400]);
        drop(store);

        let reopened = SqliteEventStore::open(&path).await.unwrap();
        assert_eq!(reopened.get_settings().await.unwrap(), updated);
        assert_eq!(
            reopened
                .get(event.id)
                .await
                .unwrap()
                .unwrap()
                .reminder_offsets_minutes,
            vec![0, 50_400]
        );
    }

    #[tokio::test]
    async fn migrations_enable_integrity_checks_foreign_keys_and_sql_constraints() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(store.pool())
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA quick_check")
                .fetch_one(store.pool())
                .await
                .unwrap(),
            "ok"
        );
        assert!(sqlx::query(
            "UPDATE calendar_settings SET default_reminder_minutes = 50401 WHERE singleton_id = 1"
        )
        .execute(store.pool())
        .await
        .is_err());
    }
}

#[cfg(test)]
mod assistant_reconciliation_tests {
    use super::*;
    use crate::{
        calendar::domain::{parse_all_day_event, EventDraft},
        calendar_store::EventRepository,
    };

    fn assistant_draft(title: &str) -> EventDraft {
        EventDraft::validated_with_recurrence_and_reminders(
            title.into(),
            Some("private notes that must not enter the marker".into()),
            Some("Private room".into()),
            parse_all_day_event("2026-07-25", "2026-07-26").unwrap(),
            None,
            vec![10],
        )
        .unwrap()
    }

    #[tokio::test]
    async fn reconciliation_migration_is_minimal_and_clean_startup_is_clear() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();

        assert!(!store
            .assistant_create_reconciliation_required()
            .await
            .unwrap());
        let columns: String = sqlx::query_scalar(
            "SELECT group_concat(name, ',')
             FROM pragma_table_info('assistant_calendar_create_reconciliation')",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!(columns, "singleton_id,created_at_utc_ms");
        let schema: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'assistant_calendar_create_reconciliation'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        for forbidden in [
            "token",
            "payload",
            "prompt",
            "provider",
            "event_id",
            "run_id",
            "tool_call_id",
        ] {
            assert!(!schema.to_lowercase().contains(forbidden));
        }
    }

    #[tokio::test]
    async fn marker_is_inserted_before_event_mutation_and_commits_with_the_event() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER require_assistant_marker_before_event
             BEFORE INSERT ON events
             WHEN NOT EXISTS (
               SELECT 1 FROM assistant_calendar_create_reconciliation WHERE singleton_id = 1
             )
             BEGIN
               SELECT RAISE(ABORT, 'assistant reconciliation marker missing');
             END",
        )
        .execute(store.pool())
        .await
        .unwrap();

        let created = store
            .create_assistant_event(assistant_draft("Marker first"))
            .await
            .unwrap();
        assert!(store.get(created.id).await.unwrap().is_some());
        assert!(store
            .assistant_create_reconciliation_required()
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn definitive_event_insert_failure_rolls_back_the_marker() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER reject_assistant_event
             BEFORE INSERT ON events
             BEGIN
               SELECT RAISE(ABORT, 'forced insert failure');
             END",
        )
        .execute(store.pool())
        .await
        .unwrap();

        assert!(matches!(
            store
                .create_assistant_event(assistant_draft("Rollback"))
                .await,
            Err(StoreError::Database(_))
        ));
        assert!(!store
            .assistant_create_reconciliation_required()
            .await
            .unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events")
                .fetch_one(store.pool())
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn successful_marker_survives_repository_reopen_until_acknowledged() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("calendar.sqlite3");
        let store = SqliteEventStore::open(&path).await.unwrap();
        let created = store
            .create_assistant_event(assistant_draft("Persisted marker"))
            .await
            .unwrap();
        drop(store);

        let reopened = SqliteEventStore::open(&path).await.unwrap();
        assert_eq!(
            reopened.get(created.id).await.unwrap().unwrap().title,
            "Persisted marker"
        );
        assert!(reopened
            .assistant_create_reconciliation_required()
            .await
            .unwrap());
        assert!(reopened
            .acknowledge_assistant_create_reconciliation()
            .await
            .unwrap());
        assert!(!reopened
            .assistant_create_reconciliation_required()
            .await
            .unwrap());
        assert!(!reopened
            .acknowledge_assistant_create_reconciliation()
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn concurrent_assistant_creates_admit_exactly_one_event() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();

        let left_store = store.clone();
        let right_store = store.clone();
        let (left, right) = tokio::join!(
            left_store.create_assistant_event(assistant_draft("Left")),
            right_store.create_assistant_event(assistant_draft("Right")),
        );
        assert!(matches!(
            (&left, &right),
            (
                Ok(_),
                Err(StoreError::AssistantCreateReconciliationRequired)
            ) | (
                Err(StoreError::AssistantCreateReconciliationRequired),
                Ok(_)
            )
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events")
                .fetch_one(store.pool())
                .await
                .unwrap(),
            1
        );
        assert!(store
            .assistant_create_reconciliation_required()
            .await
            .unwrap());
    }
}
