#[cfg(desktop)]
pub mod backup;
#[cfg(desktop)]
pub(crate) mod private_file;
pub mod sqlite;

use async_trait::async_trait;

use crate::calendar::{
    domain::{EventDraft, EventId, EventQueryRange, EventRecord},
    error::{CalendarError, StoreError},
    settings::{CalendarSettings, CalendarSettingsPatch},
};

/// Maximum number of event masters read by one SQL statement while resolving
/// an occurrence query. The service may advance through several pages, but it
/// also enforces [`MAX_EVENT_MASTER_SCAN`] across the complete request.
pub const EVENT_MASTER_PAGE_SIZE: usize = 128;

/// Hard per-request ceiling for recurrence master inspection. Reaching this
/// limit is reported as an error instead of returning an incomplete calendar.
pub const MAX_EVENT_MASTER_SCAN: usize = 4_096;

#[derive(Debug)]
pub struct EventListPage {
    pub records: Vec<EventRecord>,
    /// Present only when another SQL page exists. This is an internal keyset
    /// cursor and is never exposed across the Tauri boundary.
    pub next_after: Option<EventId>,
}

#[async_trait]
pub trait EventRepository: Send + Sync {
    async fn create(&self, draft: EventDraft) -> Result<EventRecord, StoreError>;
    async fn get(&self, id: EventId) -> Result<Option<EventRecord>, StoreError>;
    #[cfg(test)]
    async fn list(&self, range: EventQueryRange) -> Result<Vec<EventRecord>, StoreError>;
    async fn list_page(
        &self,
        range: EventQueryRange,
        after: Option<EventId>,
        limit: usize,
    ) -> Result<EventListPage, StoreError>;
    async fn list_all_page(
        &self,
        after: Option<EventId>,
        limit: usize,
    ) -> Result<EventListPage, StoreError>;
    async fn search(
        &self,
        query: &str,
        range: EventQueryRange,
        candidate_limit: usize,
    ) -> Result<Vec<EventRecord>, StoreError>;
    async fn update(
        &self,
        id: EventId,
        expected_revision: i64,
        event: EventDraft,
    ) -> Result<EventRecord, StoreError>;
    async fn delete(&self, id: EventId, expected_revision: i64) -> Result<(), StoreError>;
    async fn update_occurrence(
        &self,
        id: EventId,
        occurrence_key: &str,
        expected_revision: i64,
        event: EventDraft,
    ) -> Result<EventRecord, CalendarError>;
    async fn delete_occurrence(
        &self,
        id: EventId,
        occurrence_key: &str,
        expected_revision: i64,
    ) -> Result<(), CalendarError>;
}

#[async_trait]
pub trait SettingsRepository: Send + Sync {
    async fn get_settings(&self) -> Result<CalendarSettings, StoreError>;
    async fn update_settings(
        &self,
        patch: CalendarSettingsPatch,
    ) -> Result<CalendarSettings, StoreError>;
}
