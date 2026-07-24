use std::{
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use chrono::{Days, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    calendar_store::private_file::{PrivateFileError, PrivateTempFile},
};

use super::{
    api::ensure_main_window,
    domain::{EventQueryRange, EventRecord, EventTime, OccurrenceRecord, MAX_QUERY_DAYS},
    error::{ApiError, DomainError, StoreError},
    recurrence::{RecurrenceEngine, Rfc5545RecurrenceEngine},
};

const MAX_EXPORT_CANDIDATES: usize = 10_000;
const MAX_EXPORT_EVENTS: usize = 1_000;
const PRODID: &str = "-//Note//Local Calendar Export//EN";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportError {
    InvalidSelection,
    InProgress,
    TooLarge,
    DestinationExists,
    SerializationFailed,
    Failed,
}

impl From<ExportError> for ApiError {
    fn from(error: ExportError) -> Self {
        match error {
            ExportError::InvalidSelection => Self {
                code: "invalid_export_selection",
                message: "Choose valid dates no more than 366 days apart.",
                field: Some("selection"),
            },
            ExportError::InProgress => Self {
                code: "export_in_progress",
                message: "A calendar export is already in progress.",
                field: None,
            },
            ExportError::TooLarge => Self {
                code: "export_too_large",
                message: "The chosen dates contain too many events to export safely.",
                field: Some("selection"),
            },
            ExportError::DestinationExists => Self {
                code: "export_destination_exists",
                message: "Choose a new file name for this export.",
                field: None,
            },
            ExportError::SerializationFailed => Self {
                code: "export_serialization_failed",
                message: "The calendar data could not be converted to an ICS file.",
                field: None,
            },
            ExportError::Failed => Self {
                code: "export_failed",
                message: "The calendar export could not be created.",
                field: None,
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportIcsRequest {
    pub selection: ExportSelectionRequest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSelectionRequest {
    pub start_date: String,
    pub end_date: String,
    pub time_zone: String,
}

#[derive(Clone, Debug)]
pub struct ExportSelection {
    start_date: NaiveDate,
    end_date: NaiveDate,
    range: EventQueryRange,
}

impl ExportSelection {
    pub fn validated(request: ExportSelectionRequest) -> Result<Self, ExportError> {
        let start_date = NaiveDate::parse_from_str(&request.start_date, "%Y-%m-%d")
            .map_err(|_| ExportError::InvalidSelection)?;
        let end_date = NaiveDate::parse_from_str(&request.end_date, "%Y-%m-%d")
            .map_err(|_| ExportError::InvalidSelection)?;
        let selected_days = end_date.signed_duration_since(start_date).num_days() + 1;
        if !(1..=MAX_QUERY_DAYS).contains(&selected_days) {
            return Err(ExportError::InvalidSelection);
        }
        let end_date_exclusive = end_date
            .checked_add_days(Days::new(1))
            .ok_or(ExportError::InvalidSelection)?;
        let time_zone =
            Tz::from_str(&request.time_zone).map_err(|_| ExportError::InvalidSelection)?;
        let start_utc_ms = resolve_local_midnight(time_zone, start_date)?;
        let end_utc_ms = resolve_local_midnight(time_zone, end_date_exclusive)?;
        let range = EventQueryRange::validated(
            start_utc_ms,
            end_utc_ms,
            &start_date.to_string(),
            &end_date_exclusive.to_string(),
        )
        .map_err(|_| ExportError::InvalidSelection)?;

        Ok(Self {
            start_date,
            end_date,
            range,
        })
    }

    fn default_file_name(&self) -> String {
        format!(
            "note-calendar-{}-to-{}.ics",
            self.start_date.format("%Y-%m-%d"),
            self.end_date.format("%Y-%m-%d")
        )
    }
}

fn resolve_local_midnight(time_zone: Tz, date: NaiveDate) -> Result<i64, ExportError> {
    let local = date
        .and_hms_opt(0, 0, 0)
        .ok_or(ExportError::InvalidSelection)?;
    match time_zone.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok(value.timestamp_millis()),
        LocalResult::None | LocalResult::Ambiguous(_, _) => Err(ExportError::InvalidSelection),
    }
}

#[async_trait]
pub trait IcsExportRepository: Send + Sync {
    async fn list_export_candidates(
        &self,
        range: &EventQueryRange,
        limit: usize,
    ) -> Result<Vec<EventRecord>, StoreError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderedExport {
    content: String,
    event_count: usize,
}

impl RenderedExport {
    #[cfg(test)]
    pub fn content(&self) -> &str {
        &self.content
    }

    #[cfg(test)]
    pub fn event_count(&self) -> usize {
        self.event_count
    }
}

#[derive(Clone)]
pub struct IcsExportService {
    repository: Arc<dyn IcsExportRepository>,
    recurrence: Arc<dyn RecurrenceEngine>,
}

impl IcsExportService {
    pub fn new(repository: Arc<dyn IcsExportRepository>) -> Self {
        Self {
            repository,
            recurrence: Arc::new(Rfc5545RecurrenceEngine),
        }
    }

    pub async fn render(&self, selection: &ExportSelection) -> Result<RenderedExport, ExportError> {
        let candidates = self
            .repository
            .list_export_candidates(&selection.range, MAX_EXPORT_CANDIDATES + 1)
            .await
            .map_err(|_| ExportError::Failed)?;
        if candidates.len() > MAX_EXPORT_CANDIDATES {
            return Err(ExportError::TooLarge);
        }

        let mut serialized_events = Vec::new();
        for master in candidates {
            let projection_limit = MAX_EXPORT_EVENTS
                .saturating_sub(serialized_events.len())
                .saturating_add(1);
            let occurrences = self
                .recurrence
                .project_up_to(&master, &selection.range, projection_limit)
                .map_err(map_projection_error)?;
            for occurrence in occurrences {
                serialized_events.push(serialize_event(&master, &occurrence)?);
                if serialized_events.len() > MAX_EXPORT_EVENTS {
                    return Err(ExportError::TooLarge);
                }
            }
        }

        let event_count = serialized_events.len();
        let content = serialize_calendar(&serialized_events);
        validate_serialized_calendar(&content)?;
        Ok(RenderedExport {
            content,
            event_count,
        })
    }

    async fn create(
        &self,
        selection: &ExportSelection,
        destination: &Path,
    ) -> Result<ExportArtifact, ExportError> {
        let rendered = self.render(selection).await?;
        let temporary = PrivateTempFile::create(destination, ".note-calendar-export-", ".ics")
            .map_err(map_private_file_error)?;
        let byte_size = temporary
            .write_and_sync(rendered.content.as_bytes())
            .map_err(map_private_file_error)?;
        temporary
            .publish(destination)
            .map_err(map_private_file_error)?;
        Ok(ExportArtifact {
            byte_size,
            event_count: rendered.event_count,
        })
    }
}

fn map_projection_error(error: DomainError) -> ExportError {
    match error {
        DomainError::RecurrenceLimitExceeded => ExportError::TooLarge,
        _ => ExportError::SerializationFailed,
    }
}

fn map_private_file_error(error: PrivateFileError) -> ExportError {
    match error {
        PrivateFileError::DestinationExists => ExportError::DestinationExists,
        PrivateFileError::Failed => ExportError::Failed,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExportArtifact {
    byte_size: u64,
    event_count: usize,
}

#[derive(Default)]
struct ExportOperationLock {
    active: AtomicBool,
}

impl ExportOperationLock {
    fn try_begin(&self) -> Result<ExportOperationGuard<'_>, ExportError> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| ExportError::InProgress)?;
        Ok(ExportOperationGuard { operation: self })
    }
}

struct ExportOperationGuard<'a> {
    operation: &'a ExportOperationLock,
}

impl Drop for ExportOperationGuard<'_> {
    fn drop(&mut self) {
        self.operation.active.store(false, Ordering::Release);
    }
}

pub struct IcsExportState {
    service: IcsExportService,
    operation: ExportOperationLock,
}

impl IcsExportState {
    pub fn new(service: IcsExportService) -> Self {
        Self {
            service,
            operation: ExportOperationLock::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportIcsResponse {
    Cancelled,
    Created {
        file_name: String,
        byte_size: u64,
        event_count: usize,
        created_at_utc_ms: i64,
    },
}

fn created_response(
    destination: &Path,
    artifact: ExportArtifact,
    created_at_utc_ms: i64,
) -> Result<ExportIcsResponse, ExportError> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or(ExportError::Failed)?
        .to_owned();
    Ok(ExportIcsResponse::Created {
        file_name,
        byte_size: artifact.byte_size,
        event_count: artifact.event_count,
        created_at_utc_ms,
    })
}

fn selected_path(
    selection: Option<tauri_plugin_dialog::FilePath>,
) -> Result<Option<PathBuf>, ExportError> {
    selection
        .map(|path| path.into_path().map_err(|_| ExportError::Failed))
        .transpose()
}

#[tauri::command]
pub async fn export_ics(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
    request: ExportIcsRequest,
) -> Result<ExportIcsResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let state = &runtime.export;
    let _operation = state.operation.try_begin()?;
    let selection = ExportSelection::validated(request.selection)?;

    let chosen = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Export calendar")
        .set_file_name(selection.default_file_name())
        .add_filter("iCalendar", &["ics"])
        .blocking_save_file();
    let Some(destination) = selected_path(chosen)? else {
        return Ok(ExportIcsResponse::Cancelled);
    };

    let artifact = state.service.create(&selection, &destination).await?;
    created_response(&destination, artifact, Utc::now().timestamp_millis()).map_err(Into::into)
}

fn serialize_calendar(events: &[String]) -> String {
    let mut calendar = IcsWriter::default();
    calendar.line("BEGIN:VCALENDAR");
    calendar.property("PRODID", PRODID);
    calendar.property("VERSION", "2.0");
    calendar.property("CALSCALE", "GREGORIAN");
    for event in events {
        calendar.raw(event);
    }
    calendar.line("END:VCALENDAR");
    calendar.finish()
}

fn validate_serialized_calendar(content: &str) -> Result<(), ExportError> {
    content
        .parse::<icalendar::Calendar>()
        .map(|_| ())
        .map_err(|_| ExportError::SerializationFailed)
}

fn serialize_event(
    master: &EventRecord,
    occurrence: &OccurrenceRecord,
) -> Result<String, ExportError> {
    let uid = occurrence_uid(master, occurrence);
    let created = format_utc_timestamp(master.created_at_utc_ms)?;
    let updated = format_utc_timestamp(master.updated_at_utc_ms)?;
    let mut event = IcsWriter::default();
    event.line("BEGIN:VEVENT");
    event.property("UID", &format!("urn:uuid:{uid}"));
    event.property("DTSTAMP", &updated);
    event.property("CREATED", &created);
    event.property("LAST-MODIFIED", &updated);
    event.property("SEQUENCE", &master.revision.to_string());
    match &occurrence.time {
        EventTime::Timed {
            start_utc_ms,
            end_utc_ms,
            ..
        } => {
            event.property("DTSTART", &format_utc_timestamp(*start_utc_ms)?);
            event.property("DTEND", &format_utc_timestamp(*end_utc_ms)?);
        }
        EventTime::AllDay {
            start_date,
            end_date_exclusive,
        } => {
            event.property(
                "DTSTART;VALUE=DATE",
                &start_date.format("%Y%m%d").to_string(),
            );
            event.property(
                "DTEND;VALUE=DATE",
                &end_date_exclusive.format("%Y%m%d").to_string(),
            );
        }
    }
    event.text_property("SUMMARY", &occurrence.title);
    if let Some(notes) = &occurrence.notes {
        event.text_property("DESCRIPTION", notes);
    }
    if let Some(location) = &occurrence.location {
        event.text_property("LOCATION", location);
    }
    event.property("STATUS", "CONFIRMED");
    event.line("END:VEVENT");
    Ok(event.finish())
}

fn occurrence_uid(master: &EventRecord, occurrence: &OccurrenceRecord) -> Uuid {
    if master.recurrence_rule.is_some() {
        Uuid::new_v5(&master.id.0, occurrence.occurrence_key.as_bytes())
    } else {
        master.id.0
    }
}

fn format_utc_timestamp(timestamp_ms: i64) -> Result<String, ExportError> {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|timestamp| timestamp.format("%Y%m%dT%H%M%SZ").to_string())
        .ok_or(ExportError::SerializationFailed)
}

#[derive(Default)]
struct IcsWriter {
    output: String,
}

impl IcsWriter {
    fn property(&mut self, name: &str, value: &str) {
        self.line(&format!("{name}:{value}"));
    }

    fn text_property(&mut self, name: &str, value: &str) {
        self.property(name, &escape_text(value));
    }

    fn raw(&mut self, value: &str) {
        self.output.push_str(value);
    }

    fn line(&mut self, content: &str) {
        fold_content_line(content, &mut self.output);
        self.output.push_str("\r\n");
    }

    fn finish(self) -> String {
        self.output
    }
}

fn escape_text(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let mut escaped = String::with_capacity(normalized.len());
    for character in normalized.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            ';' => escaped.push_str("\\;"),
            ',' => escaped.push_str("\\,"),
            '\n' => escaped.push_str("\\n"),
            character => escaped.push(character),
        }
    }
    escaped
}

fn fold_content_line(content: &str, output: &mut String) {
    let mut remaining = content;
    let mut first = true;
    while !remaining.is_empty() {
        let maximum = if first { 75 } else { 74 };
        let split_at = utf8_prefix_len(remaining, maximum);
        if !first {
            output.push_str("\r\n ");
        }
        output.push_str(&remaining[..split_at]);
        remaining = &remaining[split_at..];
        first = false;
    }
}

fn utf8_prefix_len(value: &str, maximum: usize) -> usize {
    let mut length = 0;
    for character in value.chars() {
        let next = length + character.len_utf8();
        if next > maximum {
            break;
        }
        length = next;
    }
    length
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::NaiveDate;
    use serde_json::json;

    use super::*;
    use crate::calendar::{
        domain::{
            resolve_timed_event, CalendarId, EventId, OccurrenceOverride,
            OccurrenceOverrideReplacement,
        },
        recurrence::RecurrenceRule,
    };

    #[derive(Default)]
    struct FakeRepository {
        events: Mutex<Vec<EventRecord>>,
    }

    #[async_trait]
    impl IcsExportRepository for FakeRepository {
        async fn list_export_candidates(
            &self,
            _range: &EventQueryRange,
            limit: usize,
        ) -> Result<Vec<EventRecord>, StoreError> {
            Ok(self
                .events
                .lock()
                .unwrap()
                .iter()
                .take(limit)
                .cloned()
                .collect())
        }
    }

    fn selection(start: &str, end: &str, zone: &str) -> ExportSelection {
        ExportSelection::validated(ExportSelectionRequest {
            start_date: start.into(),
            end_date: end.into(),
            time_zone: zone.into(),
        })
        .unwrap()
    }

    fn record(id: Uuid, time: EventTime, rule: Option<&str>) -> EventRecord {
        let recurrence_rule =
            rule.map(|source| RecurrenceRule::validated(source.into(), &time).unwrap());
        EventRecord {
            id: EventId(id),
            calendar_id: CalendarId(
                Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap(),
            ),
            title: "Planning, review; notes \\ follow-up".into(),
            notes: Some("First line\r\nSecond line".into()),
            location: Some("Room 2".into()),
            time,
            recurrence_rule,
            reminder_offsets_minutes: Vec::new(),
            revision: 3,
            created_at_utc_ms: 1_784_646_000_000,
            updated_at_utc_ms: 1_784_649_600_000,
            occurrence_overrides: Vec::new(),
        }
    }

    #[test]
    fn selection_is_inclusive_bounded_and_timezone_resolved() {
        let selected = selection("2024-01-01", "2024-12-31", "America/Chicago");
        assert_eq!(
            selected.range.date_bounds(),
            (
                NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
                NaiveDate::from_ymd_opt(2025, 1, 1).unwrap()
            )
        );
        assert_eq!(
            selected.default_file_name(),
            "note-calendar-2024-01-01-to-2024-12-31.ics"
        );
        for invalid in [
            ("2026-02-02", "2026-02-01", "UTC"),
            ("2026-01-01", "2027-01-02", "UTC"),
            ("2026-01-01", "2026-01-01", "Mars/Olympus"),
            ("01/01/2026", "2026-01-02", "UTC"),
        ] {
            assert_eq!(
                ExportSelection::validated(ExportSelectionRequest {
                    start_date: invalid.0.into(),
                    end_date: invalid.1.into(),
                    time_zone: invalid.2.into(),
                })
                .unwrap_err(),
                ExportError::InvalidSelection
            );
        }
    }

    #[test]
    fn response_and_errors_are_stable_and_path_free() {
        let cancelled = serde_json::to_value(ExportIcsResponse::Cancelled).unwrap();
        assert_eq!(cancelled, json!({ "status": "cancelled" }));
        let created = created_response(
            Path::new("/private/calendar/cal-july.ics"),
            ExportArtifact {
                byte_size: 512,
                event_count: 4,
            },
            1_784_352_600_000,
        )
        .unwrap();
        let serialized = serde_json::to_value(created).unwrap();
        assert_eq!(
            serialized,
            json!({
                "status": "created",
                "fileName": "cal-july.ics",
                "byteSize": 512,
                "eventCount": 4,
                "createdAtUtcMs": 1_784_352_600_000_i64
            })
        );
        assert!(!serialized.to_string().contains("/private/calendar"));

        for (error, code) in [
            (ExportError::InvalidSelection, "invalid_export_selection"),
            (ExportError::InProgress, "export_in_progress"),
            (ExportError::TooLarge, "export_too_large"),
            (ExportError::DestinationExists, "export_destination_exists"),
            (
                ExportError::SerializationFailed,
                "export_serialization_failed",
            ),
            (ExportError::Failed, "export_failed"),
        ] {
            let envelope = serde_json::to_string(&ApiError::from(error)).unwrap();
            assert!(envelope.contains(code));
            assert!(!envelope.contains('/') && !envelope.contains('\\'));
        }
    }

    #[test]
    fn operation_guard_is_exclusive_and_releases() {
        let operation = ExportOperationLock::default();
        let first = operation.try_begin().unwrap();
        assert_eq!(operation.try_begin().err(), Some(ExportError::InProgress));
        drop(first);
        assert!(operation.try_begin().is_ok());
    }

    #[test]
    fn serializer_uses_crlf_escapes_text_and_folds_utf8_by_octet() {
        let id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let mut master = record(
            id,
            EventTime::AllDay {
                start_date: NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
                end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 22).unwrap(),
            },
            None,
        );
        master.title = format!("{}end", "æ—¥".repeat(40));
        let occurrence = OccurrenceRecord {
            event_id: master.id,
            occurrence_key: format!("{}/all-day/2026-07-21", master.id),
            calendar_id: master.calendar_id,
            title: master.title.clone(),
            notes: Some("one,two;three\\four\nfive".into()),
            location: master.location.clone(),
            time: master.time.clone(),
            revision: master.revision,
            recurrence_rule: None,
            reminder_offsets_minutes: Vec::new(),
        };
        let serialized = serialize_calendar(&[serialize_event(&master, &occurrence).unwrap()]);
        let unfolded = icalendar::parser::unfold(&serialized);
        let parsed = icalendar::parser::read_calendar(&unfolded).unwrap();
        assert_eq!(parsed.components.len(), 1);
        assert!(!serialized.replace("\r\n", "").contains('\n'));
        assert!(serialized.ends_with("END:VCALENDAR\r\n"));
        assert!(serialized.contains("DESCRIPTION:one\\,two\\;three\\\\four\\nfive\r\n"));
        assert!(serialized.contains("DTSTART;VALUE=DATE:20260721\r\n"));
        assert!(serialized.contains("DTEND;VALUE=DATE:20260722\r\n"));
        for line in serialized.split("\r\n").filter(|line| !line.is_empty()) {
            assert!(line.len() <= 75, "line has {} octets: {line}", line.len());
            assert!(line.is_char_boundary(line.len()));
        }
    }

    #[tokio::test]
    async fn render_materializes_recurring_dst_instances_as_utc_with_stable_uids() {
        let id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let recurring = record(
            id,
            resolve_timed_event(
                "2026-03-07T09:00:00",
                "2026-03-07T10:00:00",
                "America/Chicago",
            )
            .unwrap(),
            Some("FREQ=DAILY;COUNT=3"),
        );
        let repository = Arc::new(FakeRepository {
            events: Mutex::new(vec![recurring]),
        });
        let service = IcsExportService::new(repository);
        let selected = selection("2026-03-07", "2026-03-09", "America/Chicago");
        let first = service.render(&selected).await.unwrap();
        let second = service.render(&selected).await.unwrap();

        assert_eq!(first, second);
        assert_eq!(first.event_count(), 3);
        assert!(first.content().contains("DTSTART:20260307T150000Z\r\n"));
        assert!(first.content().contains("DTSTART:20260308T140000Z\r\n"));
        assert!(first.content().contains("DTSTART:20260309T140000Z\r\n"));
        assert!(!first.content().contains("RRULE"));
        let uids: Vec<_> = first
            .content()
            .lines()
            .filter(|line| line.starts_with("UID:"))
            .collect();
        assert_eq!(uids.len(), 3);
        assert!(uids.windows(2).all(|pair| pair[0] != pair[1]));
        assert!(uids.iter().all(|uid| *uid != format!("UID:urn:uuid:{id}")));
    }

    #[tokio::test]
    async fn render_materializes_moved_and_cancelled_occurrence_overrides() {
        let id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let mut recurring = record(
            id,
            EventTime::AllDay {
                start_date: NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
                end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 22).unwrap(),
            },
            Some("FREQ=DAILY;COUNT=3"),
        );
        recurring.occurrence_overrides = vec![
            OccurrenceOverride {
                occurrence_key: format!("{}/all-day/2026-07-22", recurring.id),
                replacement: Some(OccurrenceOverrideReplacement {
                    title: "Moved special".into(),
                    notes: None,
                    location: Some("Elsewhere".into()),
                    time: EventTime::AllDay {
                        start_date: NaiveDate::from_ymd_opt(2026, 7, 25).unwrap(),
                        end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 26).unwrap(),
                    },
                    reminder_offsets_minutes: Vec::new(),
                }),
            },
            OccurrenceOverride {
                occurrence_key: format!("{}/all-day/2026-07-23", recurring.id),
                replacement: None,
            },
        ];
        let service = IcsExportService::new(Arc::new(FakeRepository {
            events: Mutex::new(vec![recurring]),
        }));

        let rendered = service
            .render(&selection("2026-07-21", "2026-07-25", "UTC"))
            .await
            .unwrap();

        assert_eq!(rendered.event_count(), 2);
        assert!(rendered.content().contains("SUMMARY:Moved special\r\n"));
        assert!(rendered
            .content()
            .contains("DTSTART;VALUE=DATE:20260725\r\n"));
        assert!(!rendered
            .content()
            .contains("DTSTART;VALUE=DATE:20260722\r\n"));
        assert!(!rendered
            .content()
            .contains("DTSTART;VALUE=DATE:20260723\r\n"));
    }

    #[tokio::test]
    async fn nonrecurring_uid_is_the_master_and_selection_excludes_touching_events() {
        let inside_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let inside = record(
            inside_id,
            resolve_timed_event("2026-07-21T09:00:00", "2026-07-21T10:00:00", "UTC").unwrap(),
            None,
        );
        let outside = record(
            Uuid::parse_str("cccccccc-cccc-4ccc-8ccc-cccccccccccc").unwrap(),
            resolve_timed_event("2026-07-22T00:00:00", "2026-07-22T01:00:00", "UTC").unwrap(),
            None,
        );
        let repository = Arc::new(FakeRepository {
            events: Mutex::new(vec![inside, outside]),
        });
        let service = IcsExportService::new(repository);
        let rendered = service
            .render(&selection("2026-07-21", "2026-07-21", "UTC"))
            .await
            .unwrap();
        assert_eq!(rendered.event_count(), 1);
        assert!(rendered
            .content()
            .contains(&format!("UID:urn:uuid:{inside_id}\r\n")));
        assert!(rendered.content().contains("DTSTART:20260721T090000Z"));
    }

    #[tokio::test]
    async fn invalid_persisted_timestamp_fails_serialization_before_publication() {
        let mut invalid = record(
            Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
            EventTime::AllDay {
                start_date: NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
                end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 22).unwrap(),
            },
            None,
        );
        invalid.updated_at_utc_ms = i64::MAX;
        let service = IcsExportService::new(Arc::new(FakeRepository {
            events: Mutex::new(vec![invalid]),
        }));

        assert_eq!(
            service
                .render(&selection("2026-07-21", "2026-07-21", "UTC"))
                .await,
            Err(ExportError::SerializationFailed)
        );
    }

    #[tokio::test]
    async fn candidate_and_occurrence_caps_fail_without_a_partial_export() {
        let base_time = EventTime::AllDay {
            start_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            end_date_exclusive: NaiveDate::from_ymd_opt(2026, 1, 2).unwrap(),
        };
        let too_many_candidates: Vec<_> = (0..=MAX_EXPORT_CANDIDATES)
            .map(|index| record(Uuid::from_u128(index as u128 + 1), base_time.clone(), None))
            .collect();
        let service = IcsExportService::new(Arc::new(FakeRepository {
            events: Mutex::new(too_many_candidates),
        }));
        assert_eq!(
            service
                .render(&selection("2026-01-01", "2026-01-01", "UTC"))
                .await,
            Err(ExportError::TooLarge)
        );

        let recurring = |id: u128, count: usize| {
            record(
                Uuid::from_u128(id),
                EventTime::AllDay {
                    start_date: NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
                    end_date_exclusive: NaiveDate::from_ymd_opt(2024, 1, 2).unwrap(),
                },
                Some(&format!("FREQ=DAILY;COUNT={count}")),
            )
        };
        let exact_service = IcsExportService::new(Arc::new(FakeRepository {
            events: Mutex::new(vec![
                recurring(20_001, 334),
                recurring(20_002, 333),
                recurring(20_003, 333),
            ]),
        }));
        let leap_year = selection("2024-01-01", "2024-12-31", "UTC");
        assert_eq!(
            exact_service
                .render(&leap_year)
                .await
                .unwrap()
                .event_count(),
            MAX_EXPORT_EVENTS
        );

        let over_service = IcsExportService::new(Arc::new(FakeRepository {
            events: Mutex::new(vec![
                recurring(30_001, 334),
                recurring(30_002, 334),
                recurring(30_003, 333),
            ]),
        }));
        assert_eq!(
            over_service.render(&leap_year).await,
            Err(ExportError::TooLarge)
        );
    }
}
