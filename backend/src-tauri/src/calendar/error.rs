use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("event title is invalid")]
    InvalidTitle,
    #[error("event or query range is invalid")]
    InvalidRange { field: &'static str },
    #[error("time zone is invalid")]
    InvalidTimeZone { field: &'static str },
    #[error("local time does not exist")]
    NonexistentLocalTime { field: &'static str },
    #[error("local time is ambiguous")]
    AmbiguousLocalTime { field: &'static str },
    #[error("identifier is invalid")]
    InvalidIdentifier { field: &'static str },
    #[error("field exceeds its maximum length")]
    FieldTooLong { field: &'static str, maximum: usize },
    #[error("search query is invalid")]
    InvalidSearchQuery,
    #[error("search result limit is invalid")]
    InvalidSearchLimit,
    #[error("agenda cursor or selector is invalid")]
    InvalidAgendaCursor { field: &'static str },
    #[error("calendar setting is invalid")]
    InvalidSetting { field: &'static str },
    #[error("recurrence rule is invalid or unsupported")]
    InvalidRecurrenceRule,
    #[error("recurrence expansion exceeded its safety limit")]
    RecurrenceLimitExceeded,
    #[error("occurrence key is invalid for this recurrence")]
    InvalidOccurrenceKey,
    #[error("reminder offsets are invalid")]
    InvalidReminderOffsets,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("calendar record was not found")]
    NotFound,
    #[error("calendar record has changed")]
    RevisionConflict,
    #[error("calendar storage is unavailable")]
    Database(#[source] sqlx::Error),
    // Include SQLx's non-sensitive migration detail at startup. Without it, a
    // missing or edited migration is indistinguishable from a database outage
    // and makes a recoverable upgrade problem impossible to diagnose.
    #[error("calendar storage migration failed: {0}")]
    Migration(#[source] sqlx::migrate::MigrateError),
    #[error("calendar storage directory is unavailable")]
    Io(#[source] std::io::Error),
    #[error("calendar storage contains invalid data")]
    InvalidData,
    #[error("calendar occurrence overrides exceeded the safety limit")]
    OverrideLimitExceeded,
    #[error("calendar event candidate scan exceeded the safety limit")]
    CandidateLimitExceeded,
}

#[derive(Debug, Error)]
pub enum CalendarError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<&'static str>,
}

impl ApiError {
    pub const fn forbidden_window() -> Self {
        Self {
            code: "forbidden_window",
            message: "This window cannot access calendar data.",
            field: None,
        }
    }
}

impl From<DomainError> for ApiError {
    fn from(error: DomainError) -> Self {
        match error {
            DomainError::InvalidTitle => Self {
                code: "invalid_title",
                message: "Enter a title between 1 and 500 characters.",
                field: Some("title"),
            },
            DomainError::InvalidRange { field } => Self {
                code: "invalid_range",
                message: "The end must be after the start, and the selected dates cannot span more than 366 days.",
                field: Some(field),
            },
            DomainError::InvalidTimeZone { field } => Self {
                code: "invalid_time_zone",
                message: "Choose a valid IANA time zone.",
                field: Some(field),
            },
            DomainError::NonexistentLocalTime { field } => Self {
                code: "nonexistent_local_time",
                message: "That local time does not exist because the clock moves forward.",
                field: Some(field),
            },
            DomainError::AmbiguousLocalTime { field } => Self {
                code: "ambiguous_local_time",
                message: "That local time occurs twice because the clock moves backward.",
                field: Some(field),
            },
            DomainError::InvalidIdentifier { field } => Self {
                code: "invalid_event_id",
                message: "The event identifier is invalid.",
                field: Some(field),
            },
            DomainError::FieldTooLong { field, .. } => Self {
                code: "field_too_long",
                message: match field {
                    "query" => "Search cannot exceed 200 characters.",
                    "location" => "Location cannot exceed 2,000 characters.",
                    _ => "Notes cannot exceed 20,000 characters.",
                },
                field: Some(field),
            },
            DomainError::InvalidSearchQuery => Self {
                code: "invalid_search_query",
                message: "Enter a search term.",
                field: Some("query"),
            },
            DomainError::InvalidSearchLimit => Self {
                code: "invalid_search_limit",
                message: "Search can return between 1 and 50 results.",
                field: Some("limit"),
            },
            DomainError::InvalidAgendaCursor { field } => Self {
                code: "invalid_agenda_cursor",
                message: "Use one valid agenda anchor or an unmodified agenda cursor.",
                field: Some(field),
            },
            DomainError::InvalidSetting { field } => Self {
                code: "invalid_setting",
                message: "Choose a valid value for this setting.",
                field: Some(field),
            },
            DomainError::InvalidRecurrenceRule => Self {
                code: "invalid_recurrence_rule",
                message: "Use a supported daily, weekly, monthly, or yearly recurrence rule.",
                field: Some("recurrenceRule"),
            },
            DomainError::RecurrenceLimitExceeded => Self {
                code: "recurrence_limit_exceeded",
                message: "This recurrence produces too many events for the selected dates.",
                field: Some("recurrenceRule"),
            },
            DomainError::InvalidOccurrenceKey => Self {
                code: "invalid_occurrence_key",
                message: "That occurrence is not part of the current recurring series.",
                field: Some("occurrenceKey"),
            },
            DomainError::InvalidReminderOffsets => Self {
                code: "invalid_reminder_offsets",
                message: "Choose up to five unique reminders between 0 and 50,400 minutes.",
                field: Some("reminderOffsetsMinutes"),
            },
        }
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound => Self {
                code: "not_found",
                message: "That event no longer exists.",
                field: Some("eventId"),
            },
            StoreError::RevisionConflict => Self {
                code: "revision_conflict",
                message: "That event changed since it was opened. Reload it and try again.",
                field: Some("expectedRevision"),
            },
            StoreError::Database(_)
            | StoreError::Migration(_)
            | StoreError::Io(_)
            | StoreError::InvalidData => Self {
                code: "storage_unavailable",
                message: "Calendar storage is temporarily unavailable.",
                field: None,
            },
            StoreError::OverrideLimitExceeded => Self {
                code: "recurrence_limit_exceeded",
                message: "This recurrence has too many edited occurrences to load safely.",
                field: Some("recurrenceRule"),
            },
            StoreError::CandidateLimitExceeded => Self {
                code: "event_candidate_limit_exceeded",
                message: "The selected dates contain too many event series to load safely.",
                field: None,
            },
        }
    }
}

impl From<CalendarError> for ApiError {
    fn from(error: CalendarError) -> Self {
        match error {
            CalendarError::Domain(error) => error.into(),
            CalendarError::Store(error) => error.into(),
        }
    }
}
