use std::sync::Arc;

use chrono::NaiveDate;

use crate::calendar_store::{EventRepository, EVENT_MASTER_PAGE_SIZE, MAX_EVENT_MASTER_SCAN};

use super::{
    domain::{
        AgendaDirection, EventDraft, EventId, EventQueryRange, EventRecord, EventSearchQuery,
        EventTime, OccurrenceRecord,
    },
    error::{CalendarError, StoreError},
    recurrence::{
        AgendaOccurrenceSide, RecurrenceEngine, Rfc5545RecurrenceEngine,
        MAX_AGENDA_BOUNDARY_INSPECTIONS, MAX_OCCURRENCES_PER_QUERY,
    },
};

const MAX_SEARCH_MASTER_CANDIDATES: usize = 200;

#[derive(Debug, PartialEq, Eq)]
pub struct EventSearchResult {
    pub occurrences: Vec<OccurrenceRecord>,
    pub has_more_candidates: bool,
}

#[derive(Clone)]
pub struct CalendarService {
    repository: Arc<dyn EventRepository>,
    recurrence: Arc<dyn RecurrenceEngine>,
}

impl CalendarService {
    pub fn new(repository: Arc<dyn EventRepository>) -> Self {
        Self {
            repository,
            recurrence: Arc::new(Rfc5545RecurrenceEngine),
        }
    }

    pub async fn create_event(&self, draft: EventDraft) -> Result<EventRecord, CalendarError> {
        Ok(self.repository.create(draft).await?)
    }

    pub async fn create_assistant_event(
        &self,
        draft: EventDraft,
    ) -> Result<EventRecord, CalendarError> {
        Ok(self.repository.create_assistant_event(draft).await?)
    }

    pub async fn assistant_create_reconciliation_required(&self) -> Result<bool, CalendarError> {
        Ok(self
            .repository
            .assistant_create_reconciliation_required()
            .await?)
    }

    pub async fn acknowledge_assistant_create_reconciliation(&self) -> Result<bool, CalendarError> {
        Ok(self
            .repository
            .acknowledge_assistant_create_reconciliation()
            .await?)
    }

    pub async fn get_event(&self, id: EventId) -> Result<EventRecord, CalendarError> {
        self.repository
            .get(id)
            .await?
            .ok_or(StoreError::NotFound.into())
    }

    pub async fn list_events(
        &self,
        range: EventQueryRange,
    ) -> Result<Vec<OccurrenceRecord>, CalendarError> {
        let mut occurrences = Vec::new();
        let mut scanned_masters = 0_usize;
        let mut after = None;

        loop {
            let remaining_scan = MAX_EVENT_MASTER_SCAN.saturating_sub(scanned_masters);
            if remaining_scan == 0 {
                return Err(StoreError::CandidateLimitExceeded.into());
            }
            let page = self
                .repository
                .list_page(
                    range.clone(),
                    after,
                    EVENT_MASTER_PAGE_SIZE.min(remaining_scan),
                )
                .await?;
            scanned_masters = scanned_masters.saturating_add(page.records.len());

            for master in page.records {
                let remaining = MAX_OCCURRENCES_PER_QUERY.saturating_sub(occurrences.len());
                let projected = self.recurrence.project(&master, &range, remaining)?;
                occurrences.extend(projected);
            }

            let Some(next_after) = page.next_after else {
                break;
            };
            if scanned_masters >= MAX_EVENT_MASTER_SCAN {
                return Err(StoreError::CandidateLimitExceeded.into());
            }
            after = Some(next_after);
        }
        sort_occurrences(&mut occurrences);
        Ok(occurrences)
    }

    pub async fn has_agenda_occurrences(
        &self,
        direction: AgendaDirection,
        boundary_date: NaiveDate,
        boundary_utc_ms: i64,
    ) -> Result<bool, CalendarError> {
        let side = match direction {
            AgendaDirection::Before => AgendaOccurrenceSide::Before,
            AgendaDirection::After => AgendaOccurrenceSide::After,
        };
        let mut remaining_inspections = MAX_AGENDA_BOUNDARY_INSPECTIONS;
        let mut scanned_masters = 0_usize;
        let mut after = None;

        loop {
            let remaining_scan = MAX_EVENT_MASTER_SCAN.saturating_sub(scanned_masters);
            if remaining_scan == 0 {
                return Err(StoreError::CandidateLimitExceeded.into());
            }
            let page = self
                .repository
                .list_all_page(after, EVENT_MASTER_PAGE_SIZE.min(remaining_scan))
                .await?;
            scanned_masters = scanned_masters.saturating_add(page.records.len());

            for master in page.records {
                if self.recurrence.has_occurrence_on_side(
                    &master,
                    boundary_date,
                    boundary_utc_ms,
                    side,
                    &mut remaining_inspections,
                )? {
                    return Ok(true);
                }
            }

            let Some(next_after) = page.next_after else {
                return Ok(false);
            };
            if scanned_masters >= MAX_EVENT_MASTER_SCAN {
                return Err(StoreError::CandidateLimitExceeded.into());
            }
            after = Some(next_after);
        }
    }

    pub async fn search_events(
        &self,
        query: EventSearchQuery,
        range: EventQueryRange,
    ) -> Result<EventSearchResult, CalendarError> {
        let search_page = self
            .repository
            .search(query.value(), range.clone(), MAX_SEARCH_MASTER_CANDIDATES)
            .await?;
        let needle = query.value().to_lowercase();
        let mut occurrences = Vec::new();
        for master in search_page.records {
            let master_matches = text_fields_match(
                &master.title,
                master.notes.as_deref(),
                master.location.as_deref(),
                &needle,
            );
            let mut projected = self
                .recurrence
                .project_up_to(&master, &range, query.limit())?;
            if !master_matches {
                projected.retain(|occurrence| {
                    text_fields_match(
                        &occurrence.title,
                        occurrence.notes.as_deref(),
                        occurrence.location.as_deref(),
                        &needle,
                    )
                });
            }
            occurrences.extend(projected);
        }
        sort_occurrences(&mut occurrences);
        occurrences.truncate(query.limit());
        Ok(EventSearchResult {
            occurrences,
            has_more_candidates: search_page.has_more_candidates,
        })
    }

    pub async fn update_event(
        &self,
        id: EventId,
        expected_revision: i64,
        event: EventDraft,
    ) -> Result<EventRecord, CalendarError> {
        Ok(self.repository.update(id, expected_revision, event).await?)
    }

    pub async fn delete_event(
        &self,
        id: EventId,
        expected_revision: i64,
    ) -> Result<(), CalendarError> {
        Ok(self.repository.delete(id, expected_revision).await?)
    }

    pub async fn update_occurrence(
        &self,
        id: EventId,
        occurrence_key: &str,
        expected_revision: i64,
        event: EventDraft,
    ) -> Result<EventRecord, CalendarError> {
        self.repository
            .update_occurrence(id, occurrence_key, expected_revision, event)
            .await
    }

    pub async fn delete_occurrence(
        &self,
        id: EventId,
        occurrence_key: &str,
        expected_revision: i64,
    ) -> Result<(), CalendarError> {
        self.repository
            .delete_occurrence(id, occurrence_key, expected_revision)
            .await
    }
}

fn text_fields_match(
    title: &str,
    notes: Option<&str>,
    location: Option<&str>,
    lowercase_needle: &str,
) -> bool {
    title.to_lowercase().contains(lowercase_needle)
        || notes.is_some_and(|value| value.to_lowercase().contains(lowercase_needle))
        || location.is_some_and(|value| value.to_lowercase().contains(lowercase_needle))
}

fn sort_occurrences(occurrences: &mut [OccurrenceRecord]) {
    occurrences.sort_by(|left, right| {
        occurrence_sort_key(left)
            .cmp(&occurrence_sort_key(right))
            .then_with(|| left.event_id.to_string().cmp(&right.event_id.to_string()))
            .then_with(|| left.occurrence_key.cmp(&right.occurrence_key))
    });
}

fn occurrence_sort_key(occurrence: &OccurrenceRecord) -> (u8, i64, String) {
    match &occurrence.time {
        EventTime::AllDay { start_date, .. } => (0, 0, start_date.format("%Y-%m-%d").to_string()),
        EventTime::Timed { start_utc_ms, .. } => (1, *start_utc_ms, String::new()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use chrono::NaiveDate;
    use uuid::Uuid;

    use super::*;
    use crate::{
        calendar::{
            domain::{CalendarId, EventTime, OccurrenceOverride, OccurrenceOverrideReplacement},
            error::{DomainError, StoreError},
            recurrence::RecurrenceRule,
        },
        calendar_store::{EventRepository, EventSearchPage},
    };

    struct StubRepository {
        records: Vec<EventRecord>,
    }

    struct LimitRecordingRecurrenceEngine {
        limits: Arc<Mutex<Vec<usize>>>,
    }

    impl RecurrenceEngine for LimitRecordingRecurrenceEngine {
        fn project(
            &self,
            _event: &EventRecord,
            _range: &EventQueryRange,
            _limit: usize,
        ) -> Result<Vec<OccurrenceRecord>, DomainError> {
            panic!("search must use truncating projection")
        }

        fn project_up_to(
            &self,
            _event: &EventRecord,
            _range: &EventQueryRange,
            limit: usize,
        ) -> Result<Vec<OccurrenceRecord>, DomainError> {
            self.limits.lock().unwrap().push(limit);
            Ok(Vec::new())
        }

        fn has_occurrence_on_side(
            &self,
            _event: &EventRecord,
            _boundary_date: NaiveDate,
            _boundary_utc_ms: i64,
            _side: AgendaOccurrenceSide,
            _remaining_inspections: &mut usize,
        ) -> Result<bool, DomainError> {
            Ok(false)
        }
    }

    #[async_trait]
    impl EventRepository for StubRepository {
        async fn create(&self, _draft: EventDraft) -> Result<EventRecord, StoreError> {
            Err(StoreError::InvalidData)
        }

        async fn create_assistant_event(
            &self,
            _draft: EventDraft,
        ) -> Result<EventRecord, StoreError> {
            Err(StoreError::InvalidData)
        }

        async fn assistant_create_reconciliation_required(&self) -> Result<bool, StoreError> {
            Ok(false)
        }

        async fn acknowledge_assistant_create_reconciliation(&self) -> Result<bool, StoreError> {
            Ok(false)
        }

        async fn get(&self, id: EventId) -> Result<Option<EventRecord>, StoreError> {
            Ok(self.records.iter().find(|record| record.id == id).cloned())
        }

        async fn list(&self, _range: EventQueryRange) -> Result<Vec<EventRecord>, StoreError> {
            Ok(self.records.clone())
        }

        async fn list_page(
            &self,
            _range: EventQueryRange,
            after: Option<EventId>,
            limit: usize,
        ) -> Result<crate::calendar_store::EventListPage, StoreError> {
            let mut records = self.records.clone();
            records.sort_by_key(|record| record.id.to_string());
            if let Some(after) = after {
                records.retain(|record| record.id.to_string() > after.to_string());
            }
            let has_more = records.len() > limit;
            records.truncate(limit);
            let next_after = has_more.then(|| records.last().expect("non-empty page").id);
            Ok(crate::calendar_store::EventListPage {
                records,
                next_after,
            })
        }

        async fn list_all_page(
            &self,
            after: Option<EventId>,
            limit: usize,
        ) -> Result<crate::calendar_store::EventListPage, StoreError> {
            self.list_page(
                EventQueryRange::validated(0, 1, "2026-01-01", "2026-01-02").unwrap(),
                after,
                limit,
            )
            .await
        }

        async fn search(
            &self,
            _query: &str,
            _range: EventQueryRange,
            candidate_limit: usize,
        ) -> Result<EventSearchPage, StoreError> {
            let mut records = self.records.clone();
            let has_more_candidates = records.len() > candidate_limit;
            records.truncate(candidate_limit);
            Ok(EventSearchPage {
                records,
                has_more_candidates,
            })
        }

        async fn update(
            &self,
            _id: EventId,
            _expected_revision: i64,
            _event: EventDraft,
        ) -> Result<EventRecord, StoreError> {
            Err(StoreError::InvalidData)
        }

        async fn delete(&self, _id: EventId, _expected_revision: i64) -> Result<(), StoreError> {
            Err(StoreError::InvalidData)
        }

        async fn update_occurrence(
            &self,
            _id: EventId,
            _occurrence_key: &str,
            _expected_revision: i64,
            _event: EventDraft,
        ) -> Result<EventRecord, CalendarError> {
            Err(StoreError::InvalidData.into())
        }

        async fn delete_occurrence(
            &self,
            _id: EventId,
            _occurrence_key: &str,
            _expected_revision: i64,
        ) -> Result<(), CalendarError> {
            Err(StoreError::InvalidData.into())
        }
    }

    #[tokio::test]
    async fn synthetic_calendar_operations_record_local_duration_samples() {
        let start_date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(
            crate::calendar_store::sqlite::SqliteEventStore::open(
                &directory.path().join("calendar.sqlite3"),
            )
            .await
            .unwrap(),
        );
        let service = CalendarService::new(store);
        for number in 1..=1_000 {
            service
                .create_event(
                    EventDraft::validated(
                        format!("Synthetic {number}"),
                        None,
                        None,
                        EventTime::AllDay {
                            start_date,
                            end_date_exclusive: start_date.succ_opt().unwrap(),
                        },
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
        }
        let range = EventQueryRange::validated(
            1_784_620_800_000,
            1_784_707_200_000,
            "2026-07-21",
            "2026-07-22",
        )
        .unwrap();
        let mut list_samples = Vec::new();
        let mut search_samples = Vec::new();
        let mut crud_samples = Vec::new();
        for _ in 0..11 {
            let started = std::time::Instant::now();
            let listed = service.list_events(range.clone()).await.unwrap();
            list_samples.push(started.elapsed().as_millis());
            assert_eq!(listed.len(), 1_000);
            let started = std::time::Instant::now();
            let searched = service
                .search_events(
                    EventSearchQuery::validated("synthetic".into(), 50).unwrap(),
                    range.clone(),
                )
                .await
                .unwrap();
            search_samples.push(started.elapsed().as_millis());
            assert!(!searched.occurrences.is_empty());
            let started = std::time::Instant::now();
            let created = service
                .create_event(
                    EventDraft::validated(
                        "Synthetic CRUD".into(),
                        None,
                        None,
                        EventTime::AllDay {
                            start_date,
                            end_date_exclusive: start_date.succ_opt().unwrap(),
                        },
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
            service
                .delete_event(created.id, created.revision)
                .await
                .unwrap();
            crud_samples.push(started.elapsed().as_millis());
        }
        for (operation, samples) in [
            ("calendar.list", &mut list_samples),
            ("calendar.search", &mut search_samples),
            ("calendar.crud", &mut crud_samples),
        ] {
            samples.sort_unstable();
            let p50 = samples[samples.len() / 2];
            let p95 = samples[(samples.len() * 95).div_ceil(100) - 1];
            println!("performance_sample operation={operation} p50_ms={p50} p95_ms={p95}");
            assert!(operation
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'.'));
        }
    }

    #[tokio::test]
    async fn aggregate_limit_applies_to_nonrecurring_records() {
        let start_date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let records = (1..=1_001_u128)
            .map(|number| EventRecord {
                id: EventId(Uuid::from_u128(number)),
                calendar_id: CalendarId(Uuid::from_u128(u128::MAX)),
                title: format!("Event {number}"),
                notes: None,
                location: None,
                time: EventTime::AllDay {
                    start_date,
                    end_date_exclusive: start_date.succ_opt().unwrap(),
                },
                recurrence_rule: None,
                reminder_offsets_minutes: Vec::new(),
                revision: 1,
                created_at_utc_ms: 1,
                updated_at_utc_ms: 1,
                occurrence_overrides: Vec::new(),
            })
            .collect();
        let service = CalendarService::new(Arc::new(StubRepository { records }));
        let range = EventQueryRange::validated(
            1_784_620_800_000,
            1_784_707_200_000,
            "2026-07-21",
            "2026-07-22",
        )
        .unwrap();

        assert!(matches!(
            service.list_events(range).await,
            Err(CalendarError::Domain(DomainError::RecurrenceLimitExceeded))
        ));
    }

    #[tokio::test]
    async fn exact_aggregate_limit_allows_later_master_with_no_visible_occurrence() {
        let visible_date = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let mut records = (1..=MAX_OCCURRENCES_PER_QUERY as u128)
            .map(|number| EventRecord {
                id: EventId(Uuid::from_u128(number)),
                calendar_id: CalendarId(Uuid::from_u128(u128::MAX)),
                title: format!("Event {number}"),
                notes: None,
                location: None,
                time: EventTime::AllDay {
                    start_date: visible_date,
                    end_date_exclusive: visible_date.succ_opt().unwrap(),
                },
                recurrence_rule: None,
                reminder_offsets_minutes: Vec::new(),
                revision: 1,
                created_at_utc_ms: 1,
                updated_at_utc_ms: 1,
                occurrence_overrides: Vec::new(),
            })
            .collect::<Vec<_>>();
        let ended_date = NaiveDate::from_ymd_opt(2026, 7, 1).unwrap();
        let ended_time = EventTime::AllDay {
            start_date: ended_date,
            end_date_exclusive: ended_date.succ_opt().unwrap(),
        };
        records.push(EventRecord {
            id: EventId(Uuid::from_u128(MAX_OCCURRENCES_PER_QUERY as u128 + 1)),
            calendar_id: CalendarId(Uuid::from_u128(u128::MAX)),
            title: "Ended series".into(),
            notes: None,
            location: None,
            recurrence_rule: Some(
                RecurrenceRule::validated("FREQ=DAILY;COUNT=1".into(), &ended_time).unwrap(),
            ),
            reminder_offsets_minutes: Vec::new(),
            time: ended_time,
            revision: 1,
            created_at_utc_ms: 1,
            updated_at_utc_ms: 1,
            occurrence_overrides: Vec::new(),
        });

        let service = CalendarService::new(Arc::new(StubRepository { records }));
        let range = EventQueryRange::validated(
            1_784_620_800_000,
            1_784_707_200_000,
            "2026-07-21",
            "2026-07-22",
        )
        .unwrap();

        assert_eq!(
            service.list_events(range).await.unwrap().len(),
            MAX_OCCURRENCES_PER_QUERY
        );
    }

    #[tokio::test]
    async fn search_sorts_projected_occurrences_then_caps_results() {
        let start_date = NaiveDate::from_ymd_opt(2026, 7, 20).unwrap();
        let time = EventTime::AllDay {
            start_date,
            end_date_exclusive: start_date.succ_opt().unwrap(),
        };
        let recurring_id = EventId(Uuid::from_u128(2));
        let later_id = EventId(Uuid::from_u128(1));
        let records = vec![
            EventRecord {
                id: later_id,
                calendar_id: CalendarId(Uuid::from_u128(u128::MAX)),
                title: "Planning later".into(),
                notes: None,
                location: None,
                time: EventTime::AllDay {
                    start_date: NaiveDate::from_ymd_opt(2026, 7, 23).unwrap(),
                    end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 24).unwrap(),
                },
                recurrence_rule: None,
                reminder_offsets_minutes: Vec::new(),
                revision: 1,
                created_at_utc_ms: 1,
                updated_at_utc_ms: 1,
                occurrence_overrides: Vec::new(),
            },
            EventRecord {
                id: recurring_id,
                calendar_id: CalendarId(Uuid::from_u128(u128::MAX)),
                title: "Planning series".into(),
                notes: None,
                location: None,
                recurrence_rule: Some(
                    RecurrenceRule::validated("FREQ=DAILY;COUNT=5".into(), &time).unwrap(),
                ),
                reminder_offsets_minutes: Vec::new(),
                time,
                revision: 1,
                created_at_utc_ms: 1,
                updated_at_utc_ms: 1,
                occurrence_overrides: Vec::new(),
            },
        ];
        let service = CalendarService::new(Arc::new(StubRepository { records }));
        let range = EventQueryRange::validated(
            1_784_534_400_000,
            1_784_880_000_000,
            "2026-07-20",
            "2026-07-24",
        )
        .unwrap();
        let query = EventSearchQuery::validated("planning".into(), 3).unwrap();

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
            .all(|occurrence| occurrence.event_id == recurring_id));
        assert_eq!(
            first
                .occurrences
                .iter()
                .map(|occurrence| occurrence.occurrence_key.as_str())
                .collect::<Vec<_>>(),
            [
                format!("{recurring_id}/all-day/2026-07-20"),
                format!("{recurring_id}/all-day/2026-07-21"),
                format!("{recurring_id}/all-day/2026-07-22"),
            ]
        );
    }

    #[tokio::test]
    async fn search_bounds_projection_for_each_master_to_the_requested_limit() {
        let start_date = NaiveDate::from_ymd_opt(2026, 7, 20).unwrap();
        let records = (1..=2_u128)
            .map(|number| EventRecord {
                id: EventId(Uuid::from_u128(number)),
                calendar_id: CalendarId(Uuid::from_u128(u128::MAX)),
                title: "Bounded planning".into(),
                notes: None,
                location: None,
                time: EventTime::AllDay {
                    start_date,
                    end_date_exclusive: start_date.succ_opt().unwrap(),
                },
                recurrence_rule: None,
                reminder_offsets_minutes: Vec::new(),
                revision: 1,
                created_at_utc_ms: 1,
                updated_at_utc_ms: 1,
                occurrence_overrides: Vec::new(),
            })
            .collect();
        let limits = Arc::new(Mutex::new(Vec::new()));
        let service = CalendarService {
            repository: Arc::new(StubRepository { records }),
            recurrence: Arc::new(LimitRecordingRecurrenceEngine {
                limits: limits.clone(),
            }),
        };
        let range = EventQueryRange::validated(
            1_784_448_000_000,
            1_784_534_400_000,
            "2026-07-20",
            "2026-07-21",
        )
        .unwrap();

        service
            .search_events(
                EventSearchQuery::validated("planning".into(), 7).unwrap(),
                range,
            )
            .await
            .unwrap();

        assert_eq!(*limits.lock().unwrap(), [7, 7]);
    }

    #[tokio::test]
    async fn search_propagates_exact_candidate_exhaustion_after_projection() {
        let ended_start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let mut ended = (1..=200_u128)
            .map(|number| {
                let mut record = all_day_series(number, ended_start, "FREQ=DAILY;COUNT=1");
                record.title = format!("Candidate boundary ended {number:03}");
                record
            })
            .collect::<Vec<_>>();
        let range = EventQueryRange::validated(
            1_784_620_800_000,
            1_784_707_200_000,
            "2026-07-21",
            "2026-07-22",
        )
        .unwrap();
        let query = EventSearchQuery::validated("candidate boundary".into(), 20).unwrap();

        let exact = CalendarService::new(Arc::new(StubRepository {
            records: ended.clone(),
        }))
        .search_events(query.clone(), range.clone())
        .await
        .unwrap();
        assert!(exact.occurrences.is_empty());
        assert!(!exact.has_more_candidates);

        let mut live = all_day_series(
            201,
            NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
            "FREQ=DAILY;COUNT=1",
        );
        live.title = "Candidate boundary live".into();
        ended.push(live);
        let exhausted = CalendarService::new(Arc::new(StubRepository { records: ended }))
            .search_events(query, range)
            .await
            .unwrap();
        assert!(exhausted.occurrences.is_empty());
        assert!(exhausted.has_more_candidates);
    }

    fn all_day_series(number: u128, start: NaiveDate, rule: &str) -> EventRecord {
        let time = EventTime::AllDay {
            start_date: start,
            end_date_exclusive: start.succ_opt().unwrap(),
        };
        EventRecord {
            id: EventId(Uuid::from_u128(number)),
            calendar_id: CalendarId(Uuid::from_u128(u128::MAX)),
            title: format!("Series {number}"),
            notes: None,
            location: None,
            recurrence_rule: Some(RecurrenceRule::validated(rule.into(), &time).unwrap()),
            reminder_offsets_minutes: Vec::new(),
            time,
            revision: 1,
            created_at_utc_ms: 1,
            updated_at_utc_ms: 1,
            occurrence_overrides: Vec::new(),
        }
    }

    #[tokio::test]
    async fn list_events_keyset_pages_past_ended_series_without_omission() {
        let ended_start = NaiveDate::from_ymd_opt(2026, 7, 1).unwrap();
        let mut records = (1..=EVENT_MASTER_PAGE_SIZE as u128 + 2)
            .map(|number| all_day_series(number, ended_start, "FREQ=DAILY;COUNT=1"))
            .collect::<Vec<_>>();
        let visible_id = EventId(Uuid::from_u128(10_000));
        records.push(all_day_series(
            10_000,
            NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
            "FREQ=DAILY;COUNT=2",
        ));
        let service = CalendarService::new(Arc::new(StubRepository { records }));

        let occurrences = service
            .list_events(
                EventQueryRange::validated(
                    1_784_620_800_000,
                    1_784_793_600_000,
                    "2026-07-21",
                    "2026-07-23",
                )
                .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(occurrences.len(), 2);
        assert!(occurrences
            .iter()
            .all(|occurrence| occurrence.event_id == visible_id));
    }

    #[tokio::test]
    async fn list_events_reports_master_scan_ceiling_instead_of_truncating() {
        let start = NaiveDate::from_ymd_opt(2026, 7, 1).unwrap();
        let records = (1..=MAX_EVENT_MASTER_SCAN as u128 + 1)
            .map(|number| all_day_series(number, start, "FREQ=DAILY;COUNT=1"))
            .collect();
        let service = CalendarService::new(Arc::new(StubRepository { records }));
        let range = EventQueryRange::validated(
            1_784_620_800_000,
            1_784_707_200_000,
            "2026-07-21",
            "2026-07-22",
        )
        .unwrap();

        assert!(matches!(
            service.list_events(range).await,
            Err(CalendarError::Store(StoreError::CandidateLimitExceeded))
        ));
    }

    #[tokio::test]
    async fn agenda_exhaustion_is_based_on_actual_recurrence_data() {
        let ended = all_day_series(
            1,
            NaiveDate::from_ymd_opt(2026, 7, 1).unwrap(),
            "FREQ=DAILY;COUNT=2",
        );
        let service = CalendarService::new(Arc::new(StubRepository {
            records: vec![ended],
        }));
        let boundary = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();

        assert!(service
            .has_agenda_occurrences(AgendaDirection::Before, boundary, 1_784_620_800_000)
            .await
            .unwrap());
        assert!(!service
            .has_agenda_occurrences(AgendaDirection::After, boundary, 1_784_620_800_000)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn agenda_exhaustion_accounts_for_cancelled_and_moved_occurrences() {
        let boundary = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let boundary_utc_ms = 1_784_620_800_000;
        let mut cancelled = all_day_series(
            1,
            NaiveDate::from_ymd_opt(2026, 7, 20).unwrap(),
            "FREQ=DAILY;COUNT=1",
        );
        cancelled.occurrence_overrides.push(OccurrenceOverride {
            occurrence_key: format!("{}/all-day/2026-07-20", cancelled.id),
            replacement: None,
        });
        let cancelled_service = CalendarService::new(Arc::new(StubRepository {
            records: vec![cancelled],
        }));
        assert!(!cancelled_service
            .has_agenda_occurrences(AgendaDirection::Before, boundary, boundary_utc_ms)
            .await
            .unwrap());
        assert!(!cancelled_service
            .has_agenda_occurrences(AgendaDirection::After, boundary, boundary_utc_ms)
            .await
            .unwrap());

        let mut moved = all_day_series(
            2,
            NaiveDate::from_ymd_opt(2026, 7, 1).unwrap(),
            "FREQ=DAILY;COUNT=1",
        );
        moved.occurrence_overrides.push(OccurrenceOverride {
            occurrence_key: format!("{}/all-day/2026-07-01", moved.id),
            replacement: Some(OccurrenceOverrideReplacement {
                title: "Moved".into(),
                notes: None,
                location: None,
                time: EventTime::AllDay {
                    start_date: NaiveDate::from_ymd_opt(2026, 7, 25).unwrap(),
                    end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 26).unwrap(),
                },
                reminder_offsets_minutes: Vec::new(),
            }),
        });
        let moved_service = CalendarService::new(Arc::new(StubRepository {
            records: vec![moved],
        }));
        assert!(moved_service
            .has_agenda_occurrences(AgendaDirection::After, boundary, boundary_utc_ms)
            .await
            .unwrap());
        assert!(!moved_service
            .has_agenda_occurrences(AgendaDirection::Before, boundary, boundary_utc_ms)
            .await
            .unwrap());
    }
}
