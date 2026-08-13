use std::{
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use chrono::{NaiveDate, NaiveDateTime, Utc};
use chrono_tz::Tz;
use icalendar::parser::{read_calendar, Component, Property};
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::app_state::AppState;

use super::{
    api::ensure_main_window,
    domain::{
        parse_all_day_event, resolve_timed_event, EventDraft, EventTime, MAX_LOCATION_CHARS,
        MAX_NOTES_CHARS, MAX_TITLE_CHARS,
    },
    error::{ApiError, DomainError, StoreError},
};

const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PHYSICAL_LINES: usize = 20_000;
const MAX_UNFOLDED_LINE_BYTES: usize = 64 * 1024;
const MAX_PROPERTIES: usize = 10_000;
const MAX_COMPONENTS: usize = 2_000;
const MAX_COMPONENT_DEPTH: usize = 8;
const MAX_PREVIEW_ITEMS: usize = 500;
const MAX_DISPLAY_FILE_NAME_CHARS: usize = 255;
const MAX_SOURCE_UID_CHARS: usize = 1_024;
const MAX_SOURCE_SEQUENCE: i64 = i32::MAX as i64;
const IMPORT_PARSER_VERSION: &str = "note-ics-v1";
const SESSION_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImportError {
    InProgress,
    ReadFailed,
    InvalidEncoding,
    TooLarge,
    MalformedCalendar,
    SessionUnavailable,
}

impl From<ImportError> for ApiError {
    fn from(error: ImportError) -> Self {
        match error {
            ImportError::InProgress => Self {
                code: "import_in_progress",
                message: "A calendar import operation is already in progress.",
                field: None,
            },
            ImportError::ReadFailed => Self {
                code: "import_read_failed",
                message: "The selected calendar file could not be read.",
                field: None,
            },
            ImportError::InvalidEncoding => Self {
                code: "import_invalid_encoding",
                message: "The selected calendar file must use UTF-8 text.",
                field: None,
            },
            ImportError::TooLarge => Self {
                code: "import_too_large",
                message: "The selected calendar file exceeds the safe preview limits.",
                field: None,
            },
            ImportError::MalformedCalendar => Self {
                code: "import_malformed_calendar",
                message: "The selected calendar file is not a valid iCalendar file.",
                field: None,
            },
            ImportError::SessionUnavailable => Self {
                code: "import_session_unavailable",
                message: "This calendar import preview is unavailable. Preview the file again.",
                field: None,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct StagedImportEvent {
    pub(crate) source_index: usize,
    pub(crate) draft: EventDraft,
    pub(crate) source_identity: Option<ImportSourceIdentity>,
}

#[derive(Debug)]
struct StagedImportSession {
    id: Uuid,
    accepted: Vec<StagedImportEvent>,
    expires_at: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ImportSourceIdentity {
    pub(crate) uid: String,
    pub(crate) sequence: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportDuplicatePolicy {
    SkipExisting,
    CreateCopies,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImportCommitResult {
    pub(crate) imported_count: usize,
    pub(crate) skipped_count: usize,
}

#[async_trait]
pub(crate) trait IcsImportRepository: Send + Sync {
    async fn source_identities(
        &self,
        source_uids: &[String],
    ) -> Result<Vec<ImportSourceIdentity>, StoreError>;

    async fn commit_import(
        &self,
        events: &[StagedImportEvent],
        duplicate_policy: ImportDuplicatePolicy,
        parser_version: &str,
        committed_at_utc_ms: i64,
    ) -> Result<ImportCommitResult, StoreError>;
}

#[derive(Default)]
struct ImportOperationLock {
    active: AtomicBool,
}

impl ImportOperationLock {
    fn try_begin(&self) -> Result<ImportOperationGuard<'_>, ImportError> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| ImportError::InProgress)?;
        Ok(ImportOperationGuard { operation: self })
    }
}

struct ImportOperationGuard<'a> {
    operation: &'a ImportOperationLock,
}

impl Drop for ImportOperationGuard<'_> {
    fn drop(&mut self) {
        self.operation.active.store(false, Ordering::Release);
    }
}

pub struct IcsImportState {
    repository: Arc<dyn IcsImportRepository>,
    staged: Mutex<Option<StagedImportSession>>,
    operation: ImportOperationLock,
}

impl IcsImportState {
    pub(crate) fn new(repository: Arc<dyn IcsImportRepository>) -> Self {
        Self {
            repository,
            staged: Mutex::new(None),
            operation: ImportOperationLock::default(),
        }
    }

    fn replace_staged(
        &self,
        accepted: Vec<StagedImportEvent>,
        now_utc_ms: i64,
        now: Instant,
    ) -> Result<(Uuid, i64), ImportError> {
        if accepted.len() > MAX_PREVIEW_ITEMS {
            return Err(ImportError::TooLarge);
        }
        let id = Uuid::new_v4();
        let ttl_ms = i64::try_from(SESSION_TTL.as_millis()).map_err(|_| ImportError::TooLarge)?;
        let expires_at_utc_ms = now_utc_ms
            .checked_add(ttl_ms)
            .ok_or(ImportError::TooLarge)?;
        let session = StagedImportSession {
            id,
            accepted,
            expires_at: now + SESSION_TTL,
        };
        let mut staged = self.staged.lock().map_err(|_| ImportError::ReadFailed)?;
        if staged
            .as_ref()
            .is_some_and(|current| current.expires_at <= now)
        {
            staged.take();
        }
        *staged = Some(session);
        Ok((id, expires_at_utc_ms))
    }

    fn staged_for_commit(
        &self,
        session_id: Uuid,
        now: Instant,
    ) -> Result<Vec<StagedImportEvent>, ImportError> {
        let mut staged = self.staged.lock().map_err(|_| ImportError::ReadFailed)?;
        if staged
            .as_ref()
            .is_some_and(|current| current.expires_at <= now)
        {
            staged.take();
            return Err(ImportError::SessionUnavailable);
        }
        staged
            .as_ref()
            .filter(|session| session.id == session_id)
            .map(|session| session.accepted.clone())
            .ok_or(ImportError::SessionUnavailable)
    }

    fn consume_staged(&self, session_id: Uuid) -> Result<(), ImportError> {
        let mut staged = self.staged.lock().map_err(|_| ImportError::ReadFailed)?;
        if staged
            .as_ref()
            .is_some_and(|session| session.id == session_id)
        {
            staged.take();
            Ok(())
        } else {
            Err(ImportError::SessionUnavailable)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportIssue {
    severity: ImportIssueSeverity,
    code: &'static str,
    message: &'static str,
}

impl ImportIssue {
    const fn warning(code: &'static str, message: &'static str) -> Self {
        Self {
            severity: ImportIssueSeverity::Warning,
            code,
            message,
        }
    }

    const fn error(code: &'static str, message: &'static str) -> Self {
        Self {
            severity: ImportIssueSeverity::Error,
            code,
            message,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ImportIssueSeverity {
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ImportItemStatus {
    Accepted,
    Rejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ImportTemporalKind {
    Timed,
    AllDay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportDuplicateStatus {
    None,
    SameRevision,
    SourceChanged,
    Unverified,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewItem {
    source_index: usize,
    status: ImportItemStatus,
    title: String,
    temporal_kind: Option<ImportTemporalKind>,
    start_label: Option<String>,
    end_label: Option<String>,
    time_zone: Option<String>,
    duplicate_status: Option<ImportDuplicateStatus>,
    issues: Vec<ImportIssue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportIcsPreviewResponse {
    Cancelled,
    Previewed {
        session_id: String,
        file_name: String,
        expires_at_utc_ms: i64,
        total_count: usize,
        accepted_count: usize,
        rejected_count: usize,
        warning_count: usize,
        same_revision_count: usize,
        source_changed_count: usize,
        unverified_count: usize,
        items: Vec<ImportPreviewItem>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportIcsCommitRequest {
    session_id: String,
    duplicate_policy: ImportDuplicatePolicy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportIcsCommitResponse {
    Committed {
        duplicate_policy: ImportDuplicatePolicy,
        accepted_count: usize,
        imported_count: usize,
        skipped_count: usize,
        committed_at_utc_ms: i64,
    },
}

#[derive(Debug)]
struct ParsedImport {
    items: Vec<ImportPreviewItem>,
    accepted: Vec<StagedImportEvent>,
}

impl ParsedImport {
    fn response_counts(&self) -> (usize, usize, usize, usize, usize, usize) {
        let accepted = self.accepted.len();
        let rejected = self.items.len().saturating_sub(accepted);
        let warnings = self
            .items
            .iter()
            .flat_map(|item| &item.issues)
            .filter(|issue| issue.severity == ImportIssueSeverity::Warning)
            .count();
        let same_revision = self
            .items
            .iter()
            .filter(|item| item.duplicate_status == Some(ImportDuplicateStatus::SameRevision))
            .count();
        let source_changed = self
            .items
            .iter()
            .filter(|item| item.duplicate_status == Some(ImportDuplicateStatus::SourceChanged))
            .count();
        let unverified = self
            .items
            .iter()
            .filter(|item| item.duplicate_status == Some(ImportDuplicateStatus::Unverified))
            .count();
        (
            accepted,
            rejected,
            warnings,
            same_revision,
            source_changed,
            unverified,
        )
    }
}

#[tauri::command]
pub async fn import_ics_preview(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
) -> Result<ImportIcsPreviewResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let state = &runtime.import;
    let _operation = state.operation.try_begin()?;
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Preview calendar import")
        .add_filter("iCalendar", &["ics"])
        .blocking_pick_file();
    let Some(path) = selected_path(selected)? else {
        return Ok(ImportIcsPreviewResponse::Cancelled);
    };

    let file_name = safe_file_name(&path)?;
    let content = read_bounded_file(&path)?;
    let parsed = classify_import(state.repository.as_ref(), parse_import(&content)?).await?;
    let (
        accepted_count,
        rejected_count,
        warning_count,
        same_revision_count,
        source_changed_count,
        unverified_count,
    ) = parsed.response_counts();
    let total_count = parsed.items.len();
    let now_utc_ms = Utc::now().timestamp_millis();
    let (session_id, expires_at_utc_ms) =
        state.replace_staged(parsed.accepted, now_utc_ms, Instant::now())?;

    Ok(ImportIcsPreviewResponse::Previewed {
        session_id: session_id.to_string(),
        file_name,
        expires_at_utc_ms,
        total_count,
        accepted_count,
        rejected_count,
        warning_count,
        same_revision_count,
        source_changed_count,
        unverified_count,
        items: parsed.items,
    })
}

#[tauri::command]
pub async fn import_ics_commit(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
    request: ImportIcsCommitRequest,
) -> Result<ImportIcsCommitResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let _mutation = app_state.begin_calendar_mutation()?;
    let state = &runtime.import;
    let _operation = state.operation.try_begin()?;
    let response = commit_staged_import(
        state,
        request,
        Utc::now().timestamp_millis(),
        Instant::now(),
    )
    .await?;
    #[cfg(desktop)]
    super::reminders::trigger_reminder_rebuild(&window);
    super::api::emit_calendar_changed(&window);
    Ok(response)
}

async fn commit_staged_import(
    state: &IcsImportState,
    request: ImportIcsCommitRequest,
    committed_at_utc_ms: i64,
    now: Instant,
) -> Result<ImportIcsCommitResponse, ApiError> {
    let session_id = Uuid::parse_str(&request.session_id)
        .map_err(|_| ApiError::from(ImportError::SessionUnavailable))?;
    let accepted = state.staged_for_commit(session_id, now)?;
    let accepted_count = accepted.len();
    let result = state
        .repository
        .commit_import(
            &accepted,
            request.duplicate_policy,
            IMPORT_PARSER_VERSION,
            committed_at_utc_ms,
        )
        .await?;
    if result.imported_count.saturating_add(result.skipped_count) != accepted_count {
        return Err(StoreError::InvalidData.into());
    }
    state.consume_staged(session_id)?;

    Ok(ImportIcsCommitResponse::Committed {
        duplicate_policy: request.duplicate_policy,
        accepted_count,
        imported_count: result.imported_count,
        skipped_count: result.skipped_count,
        committed_at_utc_ms,
    })
}

fn selected_path(
    selected: Option<tauri_plugin_dialog::FilePath>,
) -> Result<Option<PathBuf>, ImportError> {
    selected
        .map(|path| path.into_path().map_err(|_| ImportError::ReadFailed))
        .transpose()
}

fn safe_file_name(path: &Path) -> Result<String, ImportError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or(ImportError::ReadFailed)?;
    let display_name = file_name
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DISPLAY_FILE_NAME_CHARS)
        .collect::<String>();
    if display_name.trim().is_empty() {
        return Err(ImportError::ReadFailed);
    }
    Ok(display_name)
}

fn read_bounded_file(path: &Path) -> Result<String, ImportError> {
    let metadata = fs::metadata(path).map_err(|_| ImportError::ReadFailed)?;
    if !metadata.is_file() {
        return Err(ImportError::ReadFailed);
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(ImportError::TooLarge);
    }
    let bytes = fs::read(path).map_err(|_| ImportError::ReadFailed)?;
    if u64::try_from(bytes.len()).map_err(|_| ImportError::TooLarge)? > MAX_IMPORT_BYTES {
        return Err(ImportError::TooLarge);
    }
    String::from_utf8(bytes).map_err(|_| ImportError::InvalidEncoding)
}

fn parse_import(content: &str) -> Result<ParsedImport, ImportError> {
    let unfolded = validate_and_unfold(content)?;
    let calendar = read_calendar(&unfolded).map_err(|_| ImportError::MalformedCalendar)?;
    let event_components: Vec<_> = calendar
        .components
        .iter()
        .filter(|component| component.name.as_ref().eq_ignore_ascii_case("VEVENT"))
        .collect();
    if event_components.len() > MAX_PREVIEW_ITEMS {
        return Err(ImportError::TooLarge);
    }

    let mut items = Vec::with_capacity(event_components.len());
    let mut accepted = Vec::new();
    for (offset, component) in event_components.into_iter().enumerate() {
        let source_index = offset + 1;
        let parsed = parse_event(component, source_index);
        if let Some(draft) = parsed.draft {
            accepted.push(StagedImportEvent {
                source_index,
                draft,
                source_identity: parsed.source_identity,
            });
        }
        items.push(parsed.item);
    }
    Ok(ParsedImport { items, accepted })
}

async fn classify_import(
    repository: &dyn IcsImportRepository,
    mut parsed: ParsedImport,
) -> Result<ParsedImport, StoreError> {
    use std::collections::{HashMap, HashSet};

    let source_uids = parsed
        .accepted
        .iter()
        .filter_map(|event| {
            event
                .source_identity
                .as_ref()
                .map(|identity| identity.uid.clone())
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let stored = repository.source_identities(&source_uids).await?;
    let mut stored_by_uid: HashMap<String, HashSet<i64>> = HashMap::new();
    for identity in stored {
        stored_by_uid
            .entry(identity.uid)
            .or_default()
            .insert(identity.sequence);
    }

    let mut seen_by_uid: HashMap<String, HashSet<i64>> = HashMap::new();
    for accepted in &parsed.accepted {
        let duplicate_status = match &accepted.source_identity {
            None => ImportDuplicateStatus::Unverified,
            Some(identity) => {
                let stored_sequences = stored_by_uid.get(&identity.uid);
                let seen_sequences = seen_by_uid.get(&identity.uid);
                if stored_sequences.is_some_and(|values| values.contains(&identity.sequence))
                    || seen_sequences.is_some_and(|values| values.contains(&identity.sequence))
                {
                    ImportDuplicateStatus::SameRevision
                } else if stored_sequences.is_some() || seen_sequences.is_some() {
                    ImportDuplicateStatus::SourceChanged
                } else {
                    ImportDuplicateStatus::None
                }
            }
        };
        if let Some(item) = parsed
            .items
            .iter_mut()
            .find(|item| item.source_index == accepted.source_index)
        {
            item.duplicate_status = Some(duplicate_status);
        }
        if let Some(identity) = &accepted.source_identity {
            seen_by_uid
                .entry(identity.uid.clone())
                .or_default()
                .insert(identity.sequence);
        }
    }
    Ok(parsed)
}

fn validate_and_unfold(content: &str) -> Result<String, ImportError> {
    if content.as_bytes().contains(&0) {
        return Err(ImportError::MalformedCalendar);
    }
    let mut unfolded_lines: Vec<String> = Vec::new();
    let mut physical_count = 0usize;
    for physical in content.split('\n') {
        physical_count += 1;
        if physical_count > MAX_PHYSICAL_LINES {
            return Err(ImportError::TooLarge);
        }
        let physical = physical.strip_suffix('\r').unwrap_or(physical);
        if physical.len() > MAX_UNFOLDED_LINE_BYTES {
            return Err(ImportError::TooLarge);
        }
        if physical.starts_with([' ', '\t']) {
            let Some(previous) = unfolded_lines.last_mut() else {
                return Err(ImportError::MalformedCalendar);
            };
            previous.push_str(&physical[1..]);
            if previous.len() > MAX_UNFOLDED_LINE_BYTES {
                return Err(ImportError::TooLarge);
            }
        } else {
            unfolded_lines.push(physical.to_owned());
        }
    }

    let mut property_count = 0usize;
    let mut component_count = 0usize;
    let mut event_count = 0usize;
    let mut stack: Vec<&str> = Vec::new();
    let mut root_count = 0usize;
    for line in &unfolded_lines {
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix("BEGIN:") {
            if name.is_empty()
                || name
                    .bytes()
                    .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'-')
            {
                return Err(ImportError::MalformedCalendar);
            }
            component_count += 1;
            if component_count > MAX_COMPONENTS || stack.len() >= MAX_COMPONENT_DEPTH {
                return Err(ImportError::TooLarge);
            }
            if stack.is_empty() {
                root_count += 1;
                if !name.eq_ignore_ascii_case("VCALENDAR") {
                    return Err(ImportError::MalformedCalendar);
                }
            }
            if name.eq_ignore_ascii_case("VEVENT") {
                event_count += 1;
                if event_count > MAX_PREVIEW_ITEMS {
                    return Err(ImportError::TooLarge);
                }
            }
            stack.push(name);
        } else if let Some(name) = line.strip_prefix("END:") {
            let Some(open) = stack.pop() else {
                return Err(ImportError::MalformedCalendar);
            };
            if !open.eq_ignore_ascii_case(name) {
                return Err(ImportError::MalformedCalendar);
            }
        } else {
            if stack.is_empty() {
                return Err(ImportError::MalformedCalendar);
            }
            property_count += 1;
            if property_count > MAX_PROPERTIES {
                return Err(ImportError::TooLarge);
            }
        }
    }
    if !stack.is_empty() || root_count != 1 {
        return Err(ImportError::MalformedCalendar);
    }

    let mut unfolded = unfolded_lines.join("\r\n");
    unfolded.push_str("\r\n");
    Ok(unfolded)
}

struct ParsedEvent {
    item: ImportPreviewItem,
    draft: Option<EventDraft>,
    source_identity: Option<ImportSourceIdentity>,
}

fn parse_event(component: &Component<'_>, source_index: usize) -> ParsedEvent {
    let mut issues = Vec::new();
    let source_identity = parse_source_identity(component, &mut issues);
    let title_prop = unique_property(component, "SUMMARY", &mut issues);
    let title = title_prop
        .map(|property| property.val.to_string())
        .unwrap_or_default();
    let display_title = if title.chars().count() > MAX_TITLE_CHARS {
        "Untitled event".to_owned()
    } else {
        title.trim().to_owned()
    };
    if title.trim().is_empty() {
        issues.push(ImportIssue::error(
            "missing_title",
            "This event does not have a usable title.",
        ));
    } else if title.chars().count() > MAX_TITLE_CHARS {
        issues.push(ImportIssue::error(
            "oversized_text",
            "This event contains text that exceeds Note's safe field limits.",
        ));
    }

    let notes = unique_property(component, "DESCRIPTION", &mut issues)
        .map(|property| property.val.to_string());
    let location = unique_property(component, "LOCATION", &mut issues)
        .map(|property| property.val.to_string());
    if notes
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_NOTES_CHARS)
        || location
            .as_ref()
            .is_some_and(|value| value.chars().count() > MAX_LOCATION_CHARS)
    {
        issues.push(ImportIssue::error(
            "oversized_text",
            "This event contains text that exceeds Note's safe field limits.",
        ));
    }

    if component.properties.iter().any(|property| {
        property.name.as_ref().eq_ignore_ascii_case("STATUS")
            && property.val.as_ref().eq_ignore_ascii_case("CANCELLED")
    }) {
        issues.push(ImportIssue::error(
            "cancelled_event",
            "Cancelled events are not available for import.",
        ));
    }
    if component.properties.iter().any(|property| {
        ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"]
            .iter()
            .any(|name| property.name.as_ref().eq_ignore_ascii_case(name))
    }) {
        issues.push(ImportIssue::error(
            "unsupported_recurrence",
            "Recurring events and occurrence exceptions are not available for import.",
        ));
    }
    if !component.components.is_empty() {
        issues.push(ImportIssue::warning(
            "alarms_ignored",
            "Embedded alarms and nested event data are not included in this preview.",
        ));
    }
    if component.properties.iter().any(|property| {
        ![
            "UID",
            "DTSTAMP",
            "CREATED",
            "LAST-MODIFIED",
            "SEQUENCE",
            "DTSTART",
            "DTEND",
            "SUMMARY",
            "DESCRIPTION",
            "LOCATION",
            "STATUS",
            "RRULE",
            "RDATE",
            "EXDATE",
            "RECURRENCE-ID",
        ]
        .iter()
        .any(|name| property.name.as_ref().eq_ignore_ascii_case(name))
    }) {
        issues.push(ImportIssue::warning(
            "unsupported_properties_ignored",
            "Some source properties are not included in this preview.",
        ));
    }

    let start = unique_property(component, "DTSTART", &mut issues);
    let end = unique_property(component, "DTEND", &mut issues);
    if start.is_none() {
        issues.push(ImportIssue::error(
            "missing_start",
            "This event does not have a start date or time.",
        ));
    }
    if end.is_none() {
        issues.push(ImportIssue::error(
            "missing_end",
            "This event does not have an explicit end date or time.",
        ));
    }

    let parsed_time = match (start, end) {
        (Some(start), Some(end)) => parse_event_time(start, end, &mut issues),
        _ => None,
    };
    let (temporal_kind, start_label, end_label, time_zone, event_time) = match parsed_time {
        Some(ParsedEventTime::Timed {
            start_label,
            end_label,
            time_zone,
            time,
        }) => (
            Some(ImportTemporalKind::Timed),
            Some(start_label),
            Some(end_label),
            Some(time_zone),
            Some(time),
        ),
        Some(ParsedEventTime::AllDay {
            start_label,
            end_label,
            time,
        }) => (
            Some(ImportTemporalKind::AllDay),
            Some(start_label),
            Some(end_label),
            None,
            Some(time),
        ),
        None => (None, None, None, None, None),
    };

    deduplicate_issues(&mut issues);
    let has_error = issues
        .iter()
        .any(|issue| issue.severity == ImportIssueSeverity::Error);
    let draft = if has_error {
        None
    } else {
        event_time.and_then(|time| {
            match EventDraft::validated_with_recurrence_and_reminders(
                title,
                notes,
                location,
                time,
                None,
                Vec::new(),
            ) {
                Ok(draft) => Some(draft),
                Err(error) => {
                    issues.push(domain_issue(error));
                    None
                }
            }
        })
    };
    let status = if draft.is_some() {
        ImportItemStatus::Accepted
    } else {
        ImportItemStatus::Rejected
    };

    ParsedEvent {
        item: ImportPreviewItem {
            source_index,
            status,
            title: if display_title.is_empty() {
                "Untitled event".to_owned()
            } else {
                display_title
            },
            temporal_kind,
            start_label,
            end_label,
            time_zone,
            duplicate_status: None,
            issues,
        },
        draft,
        source_identity,
    }
}

fn parse_source_identity(
    component: &Component<'_>,
    issues: &mut Vec<ImportIssue>,
) -> Option<ImportSourceIdentity> {
    let uid = unique_identity_property(
        component,
        "UID",
        "duplicate_uid",
        "This event repeats its source identifier.",
        issues,
    );
    let sequence = unique_identity_property(
        component,
        "SEQUENCE",
        "duplicate_sequence",
        "This event repeats its source revision.",
        issues,
    );
    let sequence = match sequence {
        None => 0,
        Some(property) => match property.val.as_ref().trim().parse::<i64>() {
            Ok(value) if (0..=MAX_SOURCE_SEQUENCE).contains(&value) => value,
            _ => {
                issues.push(ImportIssue::error(
                    "invalid_source_sequence",
                    "This event has an invalid source revision.",
                ));
                return None;
            }
        },
    };

    let Some(uid) = uid else {
        if !component
            .properties
            .iter()
            .any(|property| property.name.as_ref().eq_ignore_ascii_case("UID"))
        {
            issues.push(ImportIssue::warning(
                "missing_uid",
                "This event has no source identifier, so duplicates cannot be verified.",
            ));
        }
        return None;
    };
    let uid = uid.val.as_ref().trim();
    if uid.is_empty() {
        issues.push(ImportIssue::error(
            "invalid_source_uid",
            "This event has an invalid source identifier.",
        ));
        return None;
    }
    if uid.chars().count() > MAX_SOURCE_UID_CHARS {
        issues.push(ImportIssue::error(
            "oversized_source_uid",
            "This event's source identifier exceeds Note's safe limit.",
        ));
        return None;
    }

    Some(ImportSourceIdentity {
        uid: uid.to_owned(),
        sequence,
    })
}

fn unique_identity_property<'a>(
    component: &'a Component<'a>,
    name: &str,
    duplicate_code: &'static str,
    duplicate_message: &'static str,
    issues: &mut Vec<ImportIssue>,
) -> Option<&'a Property<'a>> {
    let mut matches = component
        .properties
        .iter()
        .filter(|property| property.name.as_ref().eq_ignore_ascii_case(name));
    let first = matches.next();
    if matches.next().is_some() {
        issues.push(ImportIssue::error(duplicate_code, duplicate_message));
        return None;
    }
    first
}

fn unique_property<'a>(
    component: &'a Component<'a>,
    name: &str,
    issues: &mut Vec<ImportIssue>,
) -> Option<&'a Property<'a>> {
    let mut matches = component
        .properties
        .iter()
        .filter(|property| property.name.as_ref().eq_ignore_ascii_case(name));
    let first = matches.next();
    if matches.next().is_some() {
        issues.push(ImportIssue::error(
            "duplicate_property",
            "This event repeats a property that must occur only once.",
        ));
    }
    first
}

enum ParsedEventTime {
    Timed {
        start_label: String,
        end_label: String,
        time_zone: String,
        time: EventTime,
    },
    AllDay {
        start_label: String,
        end_label: String,
        time: EventTime,
    },
}

enum ParsedDateTime {
    Date(NaiveDate),
    Utc(NaiveDateTime),
    Zoned(NaiveDateTime, String),
    Floating,
    Invalid,
}

fn parse_event_time(
    start: &Property<'_>,
    end: &Property<'_>,
    issues: &mut Vec<ImportIssue>,
) -> Option<ParsedEventTime> {
    let parsed_start = parse_date_time_property(start);
    let parsed_end = parse_date_time_property(end);
    match (parsed_start, parsed_end) {
        (ParsedDateTime::Date(start), ParsedDateTime::Date(end)) => {
            let start_label = start.format("%Y-%m-%d").to_string();
            let end_label = end.format("%Y-%m-%d").to_string();
            match parse_all_day_event(&start_label, &end_label) {
                Ok(time) => Some(ParsedEventTime::AllDay {
                    start_label,
                    end_label,
                    time,
                }),
                Err(_) => {
                    issues.push(ImportIssue::error(
                        "invalid_time_range",
                        "This event's end must be after its start.",
                    ));
                    None
                }
            }
        }
        (ParsedDateTime::Utc(start), ParsedDateTime::Utc(end)) => {
            build_timed_event(start, end, "UTC", issues)
        }
        (ParsedDateTime::Zoned(start, start_zone), ParsedDateTime::Zoned(end, end_zone)) => {
            if start_zone != end_zone {
                issues.push(ImportIssue::error(
                    "mismatched_time_zone",
                    "This event uses different time zones for its start and end.",
                ));
                None
            } else if Tz::from_str(&start_zone).is_err() {
                issues.push(ImportIssue::error(
                    "unknown_time_zone",
                    "This event uses a time zone that Note does not recognize.",
                ));
                None
            } else {
                build_timed_event(start, end, &start_zone, issues)
            }
        }
        (ParsedDateTime::Floating, _) | (_, ParsedDateTime::Floating) => {
            issues.push(ImportIssue::error(
                "floating_time",
                "This event has a floating time without an explicit time zone.",
            ));
            None
        }
        (ParsedDateTime::Invalid, _) => {
            issues.push(ImportIssue::error(
                "malformed_start",
                "This event's start date or time is malformed.",
            ));
            None
        }
        (_, ParsedDateTime::Invalid) => {
            issues.push(ImportIssue::error(
                "malformed_end",
                "This event's end date or time is malformed.",
            ));
            None
        }
        _ => {
            issues.push(ImportIssue::error(
                "mismatched_time_type",
                "This event mixes incompatible start and end value types.",
            ));
            None
        }
    }
}

fn parse_date_time_property(property: &Property<'_>) -> ParsedDateTime {
    let value_type = parameter_value(property, "VALUE");
    let time_zone = parameter_value(property, "TZID");
    if value_type.is_some_and(|value| value.eq_ignore_ascii_case("DATE")) {
        if time_zone.is_some() {
            return ParsedDateTime::Invalid;
        }
        return NaiveDate::parse_from_str(property.val.as_ref(), "%Y%m%d")
            .map(ParsedDateTime::Date)
            .unwrap_or(ParsedDateTime::Invalid);
    }
    if value_type.is_some_and(|value| !value.eq_ignore_ascii_case("DATE-TIME")) {
        return ParsedDateTime::Invalid;
    }

    if property.val.as_ref().ends_with('Z') {
        if time_zone.is_some() {
            return ParsedDateTime::Invalid;
        }
        return NaiveDateTime::parse_from_str(property.val.as_ref(), "%Y%m%dT%H%M%SZ")
            .map(ParsedDateTime::Utc)
            .unwrap_or(ParsedDateTime::Invalid);
    }
    let Ok(value) = NaiveDateTime::parse_from_str(property.val.as_ref(), "%Y%m%dT%H%M%S") else {
        return ParsedDateTime::Invalid;
    };
    match time_zone {
        Some(zone) => ParsedDateTime::Zoned(value, zone.trim_matches('"').to_owned()),
        None => ParsedDateTime::Floating,
    }
}

fn parameter_value<'a>(property: &'a Property<'a>, name: &str) -> Option<&'a str> {
    property
        .params
        .iter()
        .find(|parameter| parameter.key.as_ref().eq_ignore_ascii_case(name))
        .and_then(|parameter| parameter.val.as_ref())
        .map(AsRef::as_ref)
}

fn build_timed_event(
    start: NaiveDateTime,
    end: NaiveDateTime,
    time_zone: &str,
    issues: &mut Vec<ImportIssue>,
) -> Option<ParsedEventTime> {
    let start_label = start.format("%Y-%m-%dT%H:%M:%S").to_string();
    let end_label = end.format("%Y-%m-%dT%H:%M:%S").to_string();
    match resolve_timed_event(&start_label, &end_label, time_zone) {
        Ok(time) => Some(ParsedEventTime::Timed {
            start_label,
            end_label,
            time_zone: time_zone.to_owned(),
            time,
        }),
        Err(DomainError::NonexistentLocalTime { .. }) => {
            issues.push(ImportIssue::error(
                "nonexistent_local_time",
                "This event uses a local time skipped by a clock change.",
            ));
            None
        }
        Err(DomainError::AmbiguousLocalTime { .. }) => {
            issues.push(ImportIssue::error(
                "ambiguous_local_time",
                "This event uses a local time repeated by a clock change.",
            ));
            None
        }
        Err(_) => {
            issues.push(ImportIssue::error(
                "invalid_time_range",
                "This event's end must be after its start.",
            ));
            None
        }
    }
}

fn domain_issue(error: DomainError) -> ImportIssue {
    match error {
        DomainError::InvalidTitle => {
            ImportIssue::error("missing_title", "This event does not have a usable title.")
        }
        DomainError::FieldTooLong { .. } => ImportIssue::error(
            "oversized_text",
            "This event contains text that exceeds Note's safe field limits.",
        ),
        _ => ImportIssue::error(
            "invalid_event",
            "This event cannot be represented safely in Note.",
        ),
    }
}

fn deduplicate_issues(issues: &mut Vec<ImportIssue>) {
    let mut seen = Vec::new();
    issues.retain(|issue| {
        if seen.contains(&issue.code) {
            false
        } else {
            seen.push(issue.code);
            true
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    use async_trait::async_trait;
    use chrono::TimeZone;
    use serde_json::Value;
    use tempfile::tempdir;

    use crate::{
        calendar::domain::EventQueryRange,
        calendar_store::{sqlite::SqliteEventStore, EventRepository},
    };

    use super::*;

    #[derive(Default)]
    struct StubImportRepository {
        identities: Mutex<Vec<ImportSourceIdentity>>,
        fail_commit: AtomicBool,
    }

    #[async_trait]
    impl IcsImportRepository for StubImportRepository {
        async fn source_identities(
            &self,
            source_uids: &[String],
        ) -> Result<Vec<ImportSourceIdentity>, StoreError> {
            Ok(self
                .identities
                .lock()
                .unwrap()
                .iter()
                .filter(|identity| source_uids.contains(&identity.uid))
                .cloned()
                .collect())
        }

        async fn commit_import(
            &self,
            events: &[StagedImportEvent],
            _duplicate_policy: ImportDuplicatePolicy,
            _parser_version: &str,
            _committed_at_utc_ms: i64,
        ) -> Result<ImportCommitResult, StoreError> {
            if self.fail_commit.load(Ordering::Acquire) {
                return Err(StoreError::InvalidData);
            }
            Ok(ImportCommitResult {
                imported_count: events.len(),
                skipped_count: 0,
            })
        }
    }

    fn test_state() -> IcsImportState {
        IcsImportState::new(Arc::new(StubImportRepository::default()))
    }

    fn calendar(events: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n{events}END:VCALENDAR\r\n")
    }

    fn event(properties: &str) -> String {
        format!("BEGIN:VEVENT\r\n{properties}END:VEVENT\r\n")
    }

    fn issue_codes(item: &ImportPreviewItem) -> Vec<&str> {
        item.issues.iter().map(|issue| issue.code).collect()
    }

    #[test]
    fn accepts_folded_crlf_and_unescapes_unicode_text() {
        let source = calendar(&event(concat!(
            "UID:one\r\n",
            "DTSTART:20260720T140000Z\r\n",
            "DTEND:20260720T150000Z\r\n",
            "SUMMARY:Planning ",
            "\r\n session — 東京\r\n",
            "DESCRIPTION:Line one\\nLine two\\, confirmed\r\n",
        )));
        let parsed = parse_import(&source).unwrap();
        assert_eq!(parsed.accepted.len(), 1);
        assert_eq!(parsed.items[0].title, "Planning session — 東京");
        assert!(parsed.items[0].issues.is_empty());
    }

    #[test]
    fn accepts_utc_tzid_and_all_day_events_in_source_order() {
        let source = calendar(&format!(
            "{}{}{}",
            event(concat!(
                "UID:utc\r\n",
                "DTSTART:20260720T140000Z\r\n",
                "DTEND:20260720T150000Z\r\n",
                "SUMMARY:UTC event\r\n",
            )),
            event(concat!(
                "UID:zoned\r\n",
                "DTSTART;TZID=America/Chicago:20260720T090000\r\n",
                "DTEND;TZID=America/Chicago:20260720T100000\r\n",
                "SUMMARY:Zoned event\r\n",
            )),
            event(concat!(
                "UID:day\r\n",
                "DTSTART;VALUE=DATE:20260720\r\n",
                "DTEND;VALUE=DATE:20260722\r\n",
                "SUMMARY:All day\r\n",
            )),
        ));
        let parsed = parse_import(&source).unwrap();
        assert_eq!(parsed.accepted.len(), 3);
        assert_eq!(parsed.items[0].source_index, 1);
        assert_eq!(parsed.items[0].time_zone.as_deref(), Some("UTC"));
        assert_eq!(
            parsed.items[1].time_zone.as_deref(),
            Some("America/Chicago")
        );
        assert_eq!(
            parsed.items[2].temporal_kind,
            Some(ImportTemporalKind::AllDay)
        );
        assert_eq!(parsed.items[2].end_label.as_deref(), Some("2026-07-22"));
    }

    #[test]
    fn rejects_floating_unknown_zone_malformed_and_mismatched_end() {
        let source = calendar(&format!(
            "{}{}{}{}",
            event(concat!(
                "UID:floating\r\nDTSTART:20260720T090000\r\n",
                "DTEND:20260720T100000\r\nSUMMARY:Floating\r\n",
            )),
            event(concat!(
                "UID:zone\r\nDTSTART;TZID=Mars/Olympus:20260720T090000\r\n",
                "DTEND;TZID=Mars/Olympus:20260720T100000\r\nSUMMARY:Unknown\r\n",
            )),
            event(concat!(
                "UID:bad\r\nDTSTART:bad\r\n",
                "DTEND:20260720T100000Z\r\nSUMMARY:Malformed\r\n",
            )),
            event(concat!(
                "UID:mixed\r\nDTSTART;VALUE=DATE:20260720\r\n",
                "DTEND:20260720T100000Z\r\nSUMMARY:Mixed\r\n",
            )),
        ));
        assert!(parsed_all_rejected_with_codes(
            &source,
            &[
                "floating_time",
                "unknown_time_zone",
                "malformed_start",
                "mismatched_time_type",
            ]
        ));
    }

    fn parsed_all_rejected_with_codes(source: &str, codes: &[&str]) -> bool {
        let parsed = parse_import(source).unwrap();
        parsed.accepted.is_empty()
            && parsed.items.len() == codes.len()
            && parsed
                .items
                .iter()
                .zip(codes)
                .all(|(item, code)| issue_codes(item).contains(code))
    }

    #[test]
    fn rejects_recurrence_exceptions_cancelled_missing_end_and_oversized_text() {
        let oversized = "x".repeat(MAX_TITLE_CHARS + 1);
        let source = calendar(&format!(
            "{}{}{}{}",
            event(concat!(
                "UID:repeat\r\nDTSTART:20260720T090000Z\r\n",
                "DTEND:20260720T100000Z\r\nSUMMARY:Repeat\r\nRRULE:FREQ=DAILY\r\n",
            )),
            event(concat!(
                "UID:cancelled\r\nDTSTART:20260720T090000Z\r\n",
                "DTEND:20260720T100000Z\r\nSUMMARY:Cancelled\r\nSTATUS:CANCELLED\r\n",
            )),
            event("UID:no-end\r\nDTSTART:20260720T090000Z\r\nSUMMARY:No end\r\n"),
            event(&format!(
                "UID:large\r\nDTSTART:20260720T090000Z\r\nDTEND:20260720T100000Z\r\nSUMMARY:{oversized}\r\n"
            )),
        ));
        assert!(parsed_all_rejected_with_codes(
            &source,
            &[
                "unsupported_recurrence",
                "cancelled_event",
                "missing_end",
                "oversized_text",
            ]
        ));
    }

    #[test]
    fn reports_bounded_warnings_for_missing_uid_nested_and_ignored_properties() {
        let source = calendar(&event(concat!(
            "DTSTART:20260720T140000Z\r\n",
            "DTEND:20260720T150000Z\r\n",
            "SUMMARY:Warned event\r\n",
            "X-CUSTOM:value\r\n",
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n",
        )));
        let parsed = parse_import(&source).unwrap();
        assert_eq!(parsed.accepted.len(), 1);
        assert_eq!(
            issue_codes(&parsed.items[0]),
            vec![
                "missing_uid",
                "alarms_ignored",
                "unsupported_properties_ignored"
            ]
        );
        assert_eq!(parsed.response_counts(), (1, 0, 3, 0, 0, 0));
    }

    #[test]
    fn rejects_file_level_byte_line_property_component_preview_and_depth_caps() {
        assert_eq!(
            validate_and_unfold(&"x".repeat(MAX_UNFOLDED_LINE_BYTES + 1)),
            Err(ImportError::TooLarge)
        );
        let lines = "\n".repeat(MAX_PHYSICAL_LINES);
        assert_eq!(validate_and_unfold(&lines), Err(ImportError::TooLarge));

        let properties = format!(
            "BEGIN:VCALENDAR\r\n{}END:VCALENDAR\r\n",
            "X-A:1\r\n".repeat(MAX_PROPERTIES + 1)
        );
        assert_eq!(validate_and_unfold(&properties), Err(ImportError::TooLarge));

        let components = format!(
            "BEGIN:VCALENDAR\r\n{}END:VCALENDAR\r\n",
            "BEGIN:X-A\r\nEND:X-A\r\n".repeat(MAX_COMPONENTS)
        );
        assert_eq!(validate_and_unfold(&components), Err(ImportError::TooLarge));

        let events = calendar(
            &event(concat!(
                "UID:x\r\nDTSTART:20260720T140000Z\r\n",
                "DTEND:20260720T150000Z\r\nSUMMARY:X\r\n",
            ))
            .repeat(MAX_PREVIEW_ITEMS + 1),
        );
        assert!(matches!(parse_import(&events), Err(ImportError::TooLarge)));

        let depth = format!(
            "BEGIN:VCALENDAR\r\n{}{}END:VCALENDAR\r\n",
            (0..MAX_COMPONENT_DEPTH)
                .map(|index| format!("BEGIN:X-{index}\r\n"))
                .collect::<String>(),
            (0..MAX_COMPONENT_DEPTH)
                .rev()
                .map(|index| format!("END:X-{index}\r\n"))
                .collect::<String>()
        );
        assert_eq!(validate_and_unfold(&depth), Err(ImportError::TooLarge));
    }

    #[test]
    fn byte_and_utf8_guards_run_before_parsing() {
        let directory = tempdir().unwrap();
        let too_large = directory.path().join("large.ics");
        fs::write(&too_large, vec![b'a'; MAX_IMPORT_BYTES as usize + 1]).unwrap();
        assert_eq!(read_bounded_file(&too_large), Err(ImportError::TooLarge));

        let invalid = directory.path().join("invalid.ics");
        fs::write(&invalid, [0xff, 0xfe]).unwrap();
        assert_eq!(
            read_bounded_file(&invalid),
            Err(ImportError::InvalidEncoding)
        );
    }

    #[test]
    fn api_errors_and_preview_json_never_expose_a_selected_path() {
        let private_path = "/private/calendars/secret-person.ics";
        let error = serde_json::to_string(&ApiError::from(ImportError::ReadFailed)).unwrap();
        assert!(!error.contains(private_path));
        assert_eq!(
            safe_file_name(Path::new("/private/calendars/secret\nperson.ics")).unwrap(),
            "secretperson.ics"
        );

        let mut parsed = parse_import(&calendar(&event(concat!(
            "UID:x\r\nDTSTART:20260720T140000Z\r\n",
            "DTEND:20260720T150000Z\r\nSUMMARY:Private title\r\n",
        ))))
        .unwrap();
        parsed.items[0].duplicate_status = Some(ImportDuplicateStatus::None);
        let state = test_state();
        let (id, expires) = state
            .replace_staged(parsed.accepted, 1_000, Instant::now())
            .unwrap();
        let response = ImportIcsPreviewResponse::Previewed {
            session_id: id.to_string(),
            file_name: "secret-person.ics".to_owned(),
            expires_at_utc_ms: expires,
            total_count: 1,
            accepted_count: 1,
            rejected_count: 0,
            warning_count: 0,
            same_revision_count: 0,
            source_changed_count: 0,
            unverified_count: 0,
            items: parsed.items,
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["status"], Value::String("previewed".to_owned()));
        assert_eq!(json["fileName"], "secret-person.ics");
        assert_eq!(json["items"][0]["duplicateStatus"], "none");
        assert!(!json.to_string().contains(private_path));
    }

    #[test]
    fn replacing_a_session_discards_the_previous_bounded_stage() {
        let state = test_state();
        let now = Instant::now();
        let first = state.replace_staged(Vec::new(), 1_000, now).unwrap().0;
        let second = state.replace_staged(Vec::new(), 2_000, now).unwrap().0;
        assert_ne!(first, second);
        let staged = state.staged.lock().unwrap();
        assert_eq!(staged.as_ref().unwrap().id, second);
        assert_eq!(staged.as_ref().unwrap().accepted.len(), 0);
    }

    #[tokio::test]
    async fn preview_parsing_and_staging_do_not_mutate_calendar_storage() {
        let directory = tempdir().unwrap();
        let store = Arc::new(
            SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
                .await
                .unwrap(),
        );
        let parsed = parse_import(&calendar(&event(concat!(
            "UID:x\r\nDTSTART:20260720T140000Z\r\n",
            "DTEND:20260720T150000Z\r\nSUMMARY:Preview only\r\n",
        ))))
        .unwrap();
        IcsImportState::new(store.clone())
            .replace_staged(parsed.accepted, 1_000, Instant::now())
            .unwrap();

        let range = EventQueryRange::validated(
            1_784_500_000_000,
            1_784_600_000_000,
            "2026-07-19",
            "2026-07-22",
        )
        .unwrap();
        assert!(store.list(range).await.unwrap().is_empty());
    }

    #[test]
    fn resolves_tzid_values_to_the_expected_instants() {
        let source = calendar(&event(concat!(
            "UID:zoned\r\n",
            "DTSTART;TZID=Asia/Kolkata:20260720T090000\r\n",
            "DTEND;TZID=Asia/Kolkata:20260720T100000\r\n",
            "SUMMARY:Offset\r\n",
        )));
        let parsed = parse_import(&source).unwrap();
        let draft = parsed.accepted.into_iter().next().unwrap().draft;
        let (_, _, _, time, _) = draft.into_parts();
        assert_eq!(
            time,
            EventTime::Timed {
                start_utc_ms: Utc
                    .with_ymd_and_hms(2026, 7, 20, 3, 30, 0)
                    .unwrap()
                    .timestamp_millis(),
                end_utc_ms: Utc
                    .with_ymd_and_hms(2026, 7, 20, 4, 30, 0)
                    .unwrap()
                    .timestamp_millis(),
                time_zone: "Asia/Kolkata".to_owned(),
            }
        );
    }

    #[test]
    fn parses_bounded_source_identity_and_default_sequence() {
        let parsed = parse_import(&calendar(&format!(
            "{}{}",
            event(concat!(
                "UID:  Case-Sensitive-ID  \r\n",
                "DTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\n",
                "SUMMARY:Default sequence\r\n",
            )),
            event(concat!(
                "UID:revision\r\nSEQUENCE:2147483647\r\n",
                "DTSTART:20260721T140000Z\r\nDTEND:20260721T150000Z\r\n",
                "SUMMARY:Bounded sequence\r\n",
            )),
        )))
        .unwrap();

        assert_eq!(
            parsed.accepted[0].source_identity,
            Some(ImportSourceIdentity {
                uid: "Case-Sensitive-ID".into(),
                sequence: 0,
            })
        );
        assert_eq!(
            parsed.accepted[1].source_identity,
            Some(ImportSourceIdentity {
                uid: "revision".into(),
                sequence: MAX_SOURCE_SEQUENCE,
            })
        );
    }

    #[test]
    fn rejects_duplicate_invalid_and_oversized_source_identity() {
        let oversized_uid = "x".repeat(MAX_SOURCE_UID_CHARS + 1);
        let source = calendar(&format!(
            "{}{}{}{}{}{}{}",
            event(concat!(
                "UID:first\r\nUID:second\r\n",
                "DTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\nSUMMARY:Duplicate UID\r\n",
            )),
            event(concat!(
                "UID:sequence\r\nSEQUENCE:1\r\nSEQUENCE:2\r\n",
                "DTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\nSUMMARY:Duplicate sequence\r\n",
            )),
            event(concat!(
                "UID:   \r\n",
                "DTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\nSUMMARY:Empty UID\r\n",
            )),
            event(&format!(
                "UID:{oversized_uid}\r\nDTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\nSUMMARY:Large UID\r\n"
            )),
            event(concat!(
                "UID:negative\r\nSEQUENCE:-1\r\n",
                "DTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\nSUMMARY:Negative\r\n",
            )),
            event(concat!(
                "UID:large-sequence\r\nSEQUENCE:2147483648\r\n",
                "DTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\nSUMMARY:Large sequence\r\n",
            )),
            event(concat!(
                "SEQUENCE:not-a-number\r\n",
                "DTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\nSUMMARY:Missing UID invalid sequence\r\n",
            )),
        ));
        let parsed = parse_import(&source).unwrap();
        assert!(parsed.accepted.is_empty());
        for (item, code) in parsed.items.iter().zip([
            "duplicate_uid",
            "duplicate_sequence",
            "invalid_source_uid",
            "oversized_source_uid",
            "invalid_source_sequence",
            "invalid_source_sequence",
            "invalid_source_sequence",
        ]) {
            assert!(issue_codes(item).contains(&code), "missing {code}");
            assert_eq!(item.duplicate_status, None);
        }
    }

    #[tokio::test]
    async fn classifies_stored_in_file_and_unverified_sources() {
        let repository = Arc::new(StubImportRepository::default());
        repository
            .identities
            .lock()
            .unwrap()
            .push(ImportSourceIdentity {
                uid: "stored".into(),
                sequence: 1,
            });
        let source = calendar(&format!(
            "{}{}{}{}{}{}{}",
            basic_source_event("stored", 1, "Stored same"),
            basic_source_event("stored", 2, "Stored changed"),
            basic_source_event("new", 0, "New"),
            event("DTSTART:20260720T140000Z\r\nDTEND:20260720T150000Z\r\nSUMMARY:No UID\r\n",),
            basic_source_event("file", 4, "File first"),
            basic_source_event("file", 4, "File same"),
            basic_source_event("file", 5, "File changed"),
        ));
        let parsed = classify_import(repository.as_ref(), parse_import(&source).unwrap())
            .await
            .unwrap();
        assert_eq!(
            parsed
                .items
                .iter()
                .map(|item| item.duplicate_status)
                .collect::<Vec<_>>(),
            [
                Some(ImportDuplicateStatus::SameRevision),
                Some(ImportDuplicateStatus::SourceChanged),
                Some(ImportDuplicateStatus::None),
                Some(ImportDuplicateStatus::Unverified),
                Some(ImportDuplicateStatus::None),
                Some(ImportDuplicateStatus::SameRevision),
                Some(ImportDuplicateStatus::SourceChanged),
            ]
        );
        assert_eq!(parsed.response_counts(), (7, 0, 1, 2, 2, 1));
    }

    fn basic_source_event(uid: &str, sequence: i64, title: &str) -> String {
        event(&format!(
            "UID:{uid}\r\nSEQUENCE:{sequence}\r\nDTSTART:20260720T140000Z\r\n\
             DTEND:20260720T150000Z\r\nSUMMARY:{title}\r\n"
        ))
    }

    #[tokio::test]
    async fn sqlite_commit_rechecks_both_duplicate_policies_and_audits_unverified() {
        let directory = tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        let seeded = parse_import(&calendar(&basic_source_event("existing", 1, "Seed")))
            .unwrap()
            .accepted;
        store
            .commit_import(
                &seeded,
                ImportDuplicatePolicy::CreateCopies,
                IMPORT_PARSER_VERSION,
                100,
            )
            .await
            .unwrap();

        let candidates = parse_import(&calendar(&format!(
            "{}{}{}{}",
            basic_source_event("existing", 2, "Changed existing"),
            basic_source_event("new", 1, "New first"),
            event("DTSTART:20260721T140000Z\r\nDTEND:20260721T150000Z\r\nSUMMARY:Unverified\r\n",),
            basic_source_event("new", 2, "New later"),
        )))
        .unwrap()
        .accepted;
        let skipped = store
            .commit_import(
                &candidates,
                ImportDuplicatePolicy::SkipExisting,
                IMPORT_PARSER_VERSION,
                200,
            )
            .await
            .unwrap();
        assert_eq!(skipped.imported_count, 2);
        assert_eq!(skipped.skipped_count, 2);

        let copied = store
            .commit_import(
                &candidates,
                ImportDuplicatePolicy::CreateCopies,
                IMPORT_PARSER_VERSION,
                300,
            )
            .await
            .unwrap();
        assert_eq!(copied.imported_count, 4);
        assert_eq!(copied.skipped_count, 0);

        let event_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events")
            .fetch_one(store.pool())
            .await
            .unwrap();
        let audit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_import_sources")
            .fetch_one(store.pool())
            .await
            .unwrap();
        let unverified_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM event_import_sources WHERE source_uid IS NULL AND source_sequence IS NULL",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!(event_count, 7);
        assert_eq!(audit_count, event_count);
        assert_eq!(unverified_count, 2);
        let identities = store
            .source_identities(&["existing".into(), "new".into()])
            .await
            .unwrap();
        assert!(identities
            .iter()
            .any(|identity| identity.uid == "existing" && identity.sequence == 1));
        assert!(identities
            .iter()
            .any(|identity| identity.uid == "new" && identity.sequence == 2));
    }

    #[tokio::test]
    async fn sqlite_import_rolls_back_events_and_audit_rows_together() {
        let directory = tempdir().unwrap();
        let store = SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER reject_controlled_import BEFORE INSERT ON event_import_sources
             WHEN NEW.source_uid = 'fail'
             BEGIN SELECT RAISE(ABORT, 'controlled import failure'); END",
        )
        .execute(store.pool())
        .await
        .unwrap();
        let candidates = parse_import(&calendar(&format!(
            "{}{}",
            basic_source_event("ok", 1, "First"),
            basic_source_event("fail", 1, "Second"),
        )))
        .unwrap()
        .accepted;
        assert!(store
            .commit_import(
                &candidates,
                ImportDuplicatePolicy::CreateCopies,
                IMPORT_PARSER_VERSION,
                100,
            )
            .await
            .is_err());
        let event_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events")
            .fetch_one(store.pool())
            .await
            .unwrap();
        let audit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_import_sources")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!((event_count, audit_count), (0, 0));
    }

    #[tokio::test]
    async fn commit_session_expires_rejects_mismatch_and_replay_but_retains_failures() {
        let repository = Arc::new(StubImportRepository::default());
        let state = IcsImportState::new(repository.clone());
        let now = Instant::now();
        let accepted = parse_import(&calendar(&basic_source_event("retry", 1, "Retry")))
            .unwrap()
            .accepted;
        let session_id = state
            .replace_staged(accepted.clone(), 1_000, now)
            .unwrap()
            .0;

        let mismatch = commit_staged_import(
            &state,
            ImportIcsCommitRequest {
                session_id: Uuid::new_v4().to_string(),
                duplicate_policy: ImportDuplicatePolicy::CreateCopies,
            },
            2_000,
            now,
        )
        .await
        .unwrap_err();
        assert_eq!(mismatch.code, "import_session_unavailable");

        repository.fail_commit.store(true, Ordering::Release);
        let failed = commit_staged_import(
            &state,
            ImportIcsCommitRequest {
                session_id: session_id.to_string(),
                duplicate_policy: ImportDuplicatePolicy::CreateCopies,
            },
            2_000,
            now,
        )
        .await
        .unwrap_err();
        assert_eq!(failed.code, "storage_unavailable");
        assert!(state.staged.lock().unwrap().is_some());

        repository.fail_commit.store(false, Ordering::Release);
        let committed = commit_staged_import(
            &state,
            ImportIcsCommitRequest {
                session_id: session_id.to_string(),
                duplicate_policy: ImportDuplicatePolicy::CreateCopies,
            },
            3_000,
            now,
        )
        .await
        .unwrap();
        assert!(matches!(
            committed,
            ImportIcsCommitResponse::Committed {
                imported_count: 1,
                skipped_count: 0,
                ..
            }
        ));
        let replay = commit_staged_import(
            &state,
            ImportIcsCommitRequest {
                session_id: session_id.to_string(),
                duplicate_policy: ImportDuplicatePolicy::CreateCopies,
            },
            4_000,
            now,
        )
        .await
        .unwrap_err();
        assert_eq!(replay.code, "import_session_unavailable");

        let expired_id = state.replace_staged(accepted, 5_000, now).unwrap().0;
        let expired = commit_staged_import(
            &state,
            ImportIcsCommitRequest {
                session_id: expired_id.to_string(),
                duplicate_policy: ImportDuplicatePolicy::SkipExisting,
            },
            6_000,
            now + SESSION_TTL,
        )
        .await
        .unwrap_err();
        assert_eq!(expired.code, "import_session_unavailable");
        assert!(state.staged.lock().unwrap().is_none());
    }

    #[test]
    fn commit_request_rejects_unknown_fields_and_errors_are_path_free() {
        assert!(
            serde_json::from_value::<ImportIcsCommitRequest>(serde_json::json!({
                "sessionId": Uuid::new_v4().to_string(),
                "duplicatePolicy": "skipExisting",
                "path": "/private/secret.ics"
            }))
            .is_err()
        );
        let error = ApiError::from(ImportError::SessionUnavailable);
        assert_eq!(error.code, "import_session_unavailable");
        assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
    }
}
