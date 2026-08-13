//! Explicit, main-window-only migration and application-backup contracts.
//!
//! This module deliberately keeps Cal source selection, archive parsing, and
//! recovery coordination on the native side. Renderer callers receive only
//! opaque sessions and display-safe metadata, never filesystem paths.

use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, FromRow, SqliteConnection};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::MutexGuard;
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    app_state::AppState,
    calendar::{
        api::{ensure_main_window, mutation_busy_api_error},
        backup::{BackupRepository, RestoreInspection},
        domain::{parse_all_day_event, EventDraft, EventTime},
        error::ApiError,
        import::{
            IcsImportRepository, ImportDuplicatePolicy, ImportSourceIdentity, StagedImportEvent,
        },
    },
    calendar_store::{private_file::PrivateTempFile, sqlite::SqliteEventStore},
    notes::NotesService,
    private_file::atomic_write_private,
};

pub(crate) const CAL_IMPORT_SESSION_TTL_MS: i64 = 15 * 60 * 1_000;
pub(crate) const UNIFIED_BACKUP_FORMAT: &str = "note-unified-backup-v1";
pub(crate) const UNIFIED_BACKUP_FILE_NAME: &str = "note-unified-backup-v1.zip";

const MAX_CAL_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CAL_IMPORT_EVENTS: usize = 500;
const CAL_IMPORT_PARSER_VERSION: &str = "note-cal-sqlite-v1";
const UNIFIED_MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const UNIFIED_MAX_ENTRY_BYTES: u64 = 128 * 1024 * 1024;
const UNIFIED_RESTORE_SESSION_TTL_MS: i64 = 15 * 60 * 1_000;
const UNIFIED_RESTORE_INTENT_FILE_NAME: &str = "unified-restore-intent.json";
const UNIFIED_ALLOWED_ENTRIES: &[&str] = &[
    "manifest.json",
    "note-data.json",
    "calendar.sqlite3",
    "widget-state.json",
    "voice-config.json",
    "asset-metadata.json",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CalImportError {
    ReadFailed,
    TooLarge,
    InvalidSource,
    IntegrityFailed,
    SessionUnavailable,
    SourceChanged,
    UnsupportedSource,
    RecoveryBackupFailed,
    VerificationFailed,
    Failed,
}

impl From<CalImportError> for ApiError {
    fn from(error: CalImportError) -> Self {
        let (code, message) = match error {
            CalImportError::ReadFailed => (
                "cal_import_read_failed",
                "The selected Cal database could not be read.",
            ),
            CalImportError::TooLarge => (
                "cal_import_too_large",
                "The selected Cal database exceeds the safe import limits.",
            ),
            CalImportError::InvalidSource => (
                "cal_import_invalid_source",
                "The selected file is not a valid Cal calendar database.",
            ),
            CalImportError::IntegrityFailed => (
                "cal_import_integrity_failed",
                "The selected Cal database failed integrity verification.",
            ),
            CalImportError::SessionUnavailable => (
                "cal_import_session_unavailable",
                "This Cal import preview is unavailable. Choose the database again.",
            ),
            CalImportError::SourceChanged => (
                "cal_import_source_changed",
                "The selected Cal database changed after preview. Choose it again.",
            ),
            CalImportError::UnsupportedSource => (
                "cal_import_unsupported_source",
                "The selected Cal database contains calendar data that Note cannot safely import.",
            ),
            CalImportError::RecoveryBackupFailed => (
                "cal_import_recovery_backup_failed",
                "Note could not create the required recovery backup. Nothing was imported.",
            ),
            CalImportError::VerificationFailed => (
                "cal_import_verification_failed",
                "The import could not be verified. Your recovery backup was kept.",
            ),
            CalImportError::Failed => (
                "cal_import_failed",
                "The Cal data import could not be completed.",
            ),
        };
        Self {
            code,
            message,
            field: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UnifiedBackupError {
    ReadFailed,
    DestinationExists,
    InvalidBackup,
    TooLarge,
    VerificationFailed,
    SessionUnavailable,
    RecoveryBackupFailed,
    RecoveryRequired,
    Failed,
}

impl From<UnifiedBackupError> for ApiError {
    fn from(error: UnifiedBackupError) -> Self {
        let (code, message) = match error {
            UnifiedBackupError::ReadFailed => (
                "unified_backup_read_failed",
                "The selected backup could not be read.",
            ),
            UnifiedBackupError::DestinationExists => (
                "unified_backup_destination_exists",
                "Choose a new file name for this backup.",
            ),
            UnifiedBackupError::InvalidBackup => (
                "unified_backup_invalid",
                "The selected file is not a valid Note unified backup.",
            ),
            UnifiedBackupError::TooLarge => (
                "unified_backup_too_large",
                "The selected backup exceeds the safe restore limits.",
            ),
            UnifiedBackupError::VerificationFailed => (
                "unified_backup_verification_failed",
                "The selected backup failed verification.",
            ),
            UnifiedBackupError::SessionUnavailable => (
                "unified_backup_session_unavailable",
                "This restore preview is unavailable. Choose the backup again.",
            ),
            UnifiedBackupError::RecoveryBackupFailed => (
                "unified_backup_recovery_failed",
                "Note could not create the required recovery backup. Nothing was restored.",
            ),
            UnifiedBackupError::RecoveryRequired => (
                "unified_backup_recovery_required",
                "The restore could not be rolled back automatically. Your recovery backup is available.",
            ),
            UnifiedBackupError::Failed => (
                "unified_backup_failed",
                "The unified backup operation could not be completed.",
            ),
        };
        Self {
            code,
            message,
            field: None,
        }
    }
}

pub(crate) struct MigrationState {
    cal_import: CalImportState,
    unified: UnifiedBackupState,
}

impl MigrationState {
    pub(crate) fn new(
        store: Arc<SqliteEventStore>,
        app_data_dir: &Path,
        recovery_pending: Arc<AtomicBool>,
    ) -> Self {
        Self {
            cal_import: CalImportState {
                store: store.clone(),
                recovery_directory: app_data_dir.join("calendar-backups"),
                session: Mutex::new(None),
            },
            unified: UnifiedBackupState::new_with_recovery_pending(
                store,
                app_data_dir.to_owned(),
                recovery_pending,
            ),
        }
    }
}

struct CalImportState {
    store: Arc<SqliteEventStore>,
    recovery_directory: PathBuf,
    session: Mutex<Option<CalImportSession>>,
}

struct CalImportSession {
    id: Uuid,
    source: CalSourceIdentity,
    candidates: Vec<CalImportCandidate>,
    expires_at: Instant,
}

struct CalSourceIdentity {
    canonical_path: PathBuf,
    handle: same_file::Handle,
    fingerprint: String,
    event_count: usize,
}

struct CalImportCandidate {
    provenance_uid: String,
    provenance_sequence: i64,
    draft: EventDraft,
    preview: CalImportPreviewItem,
}

struct UnifiedBackupState {
    store: Arc<SqliteEventStore>,
    app_data_dir: PathBuf,
    recovery_directory: PathBuf,
    recovery_pending: Arc<AtomicBool>,
    restore_session: Mutex<Option<UnifiedRestoreSession>>,
}

struct UnifiedRestoreSession {
    id: Uuid,
    source: ArchiveSourceIdentity,
    staged_entries: BTreeMap<String, Vec<u8>>,
    expires_at: Instant,
}

struct ArchiveSourceIdentity {
    canonical_path: PathBuf,
    handle: same_file::Handle,
    fingerprint: String,
}

struct StagedUnifiedCalendarRestore {
    path: PathBuf,
    inspection: RestoreInspection,
}

#[derive(Clone, Copy)]
enum UnifiedRestoreStage {
    NotePublish,
    CalendarPublish,
    NoteRollback,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum UnifiedRestoreIntentPhase {
    Prepared,
    NotePublished,
    CalendarPublished,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnifiedRestoreIntent {
    version: u8,
    recovery_backup_file_name: String,
    phase: UnifiedRestoreIntentPhase,
}

impl Drop for StagedUnifiedCalendarRestore {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnifiedManifest {
    format: String,
    version: u8,
    created_at_utc_ms: i64,
    entries: Vec<UnifiedManifestEntry>,
    consistency_marker: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnifiedManifestEntry {
    path: String,
    byte_size: u64,
    sha256: String,
}

impl UnifiedBackupState {
    fn new(store: Arc<SqliteEventStore>, app_data_dir: PathBuf) -> Self {
        Self::new_with_recovery_pending(store, app_data_dir, Arc::new(AtomicBool::new(false)))
    }

    fn new_with_recovery_pending(
        store: Arc<SqliteEventStore>,
        app_data_dir: PathBuf,
        recovery_pending: Arc<AtomicBool>,
    ) -> Self {
        Self {
            store,
            recovery_directory: app_data_dir.join("unified-backups"),
            app_data_dir,
            recovery_pending,
            restore_session: Mutex::new(None),
        }
    }
}

async fn create_unified_archive(
    state: &UnifiedBackupState,
    notes: &NotesService,
    destination: &Path,
    now_utc_ms: i64,
) -> Result<UnifiedBackupCreateResponse, UnifiedBackupError> {
    let staging = state.app_data_dir.join("unified-backup-staging");
    prepare_unified_private_directory(&staging)?;
    let snapshot_path = staging.join(format!("calendar-{}.sqlite3", Uuid::new_v4()));
    state
        .store
        .create_backup(&snapshot_path)
        .await
        .map_err(|_| UnifiedBackupError::VerificationFailed)?;
    let result = (|| {
        let mut entries = BTreeMap::new();
        if let Some(note_data) = notes
            .unified_backup_snapshot()
            .map_err(|_| UnifiedBackupError::Failed)?
        {
            entries.insert("note-data.json".to_owned(), note_data);
        }
        let calendar = read_regular_bounded(&snapshot_path, UNIFIED_MAX_ENTRY_BYTES)?;
        entries.insert("calendar.sqlite3".to_owned(), calendar);
        for name in [
            "widget-state.json",
            "voice-config.json",
            "asset-metadata.json",
        ] {
            let path = state.app_data_dir.join(name);
            if let Some(json) = read_optional_safe_json(&path)? {
                entries.insert(name.to_owned(), json);
            }
        }
        write_unified_archive(destination, entries, now_utc_ms)
    })();
    let _ = fs::remove_file(snapshot_path);
    result
}

fn write_unified_archive(
    destination: &Path,
    entries: BTreeMap<String, Vec<u8>>,
    now_utc_ms: i64,
) -> Result<UnifiedBackupCreateResponse, UnifiedBackupError> {
    let temporary = PrivateTempFile::create(destination, ".note-unified-backup-", ".zip")
        .map_err(map_unified_private_error)?;
    let manifest = manifest_for_entries(&entries, now_utc_ms)?;
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|_| UnifiedBackupError::Failed)?;
    let file = File::options()
        .read(true)
        .write(true)
        .truncate(true)
        .open(temporary.path())
        .map_err(|_| UnifiedBackupError::Failed)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("manifest.json", options)
        .map_err(|_| UnifiedBackupError::Failed)?;
    zip.write_all(&manifest_bytes)
        .map_err(|_| UnifiedBackupError::Failed)?;
    for (name, contents) in &entries {
        zip.start_file(name, options)
            .map_err(|_| UnifiedBackupError::Failed)?;
        zip.write_all(contents)
            .map_err(|_| UnifiedBackupError::Failed)?;
    }
    zip.finish().map_err(|_| UnifiedBackupError::Failed)?;
    let byte_size = temporary.sync().map_err(|_| UnifiedBackupError::Failed)?;
    temporary
        .publish(destination)
        .map_err(map_unified_private_error)?;
    Ok(UnifiedBackupCreateResponse::Created {
        file_name: safe_unified_file_name(destination)?,
        byte_size,
        created_at_utc_ms: now_utc_ms,
    })
}

fn manifest_for_entries(
    entries: &BTreeMap<String, Vec<u8>>,
    created_at_utc_ms: i64,
) -> Result<UnifiedManifest, UnifiedBackupError> {
    let manifest_entries = entries
        .iter()
        .map(|(path, contents)| UnifiedManifestEntry {
            path: path.clone(),
            byte_size: u64::try_from(contents.len()).unwrap_or(u64::MAX),
            sha256: sha256_bytes(contents),
        })
        .collect::<Vec<_>>();
    let consistency_marker = consistency_marker(&manifest_entries);
    Ok(UnifiedManifest {
        format: UNIFIED_BACKUP_FORMAT.to_owned(),
        version: 1,
        created_at_utc_ms,
        entries: manifest_entries,
        consistency_marker,
    })
}

fn consistency_marker(entries: &[UnifiedManifestEntry]) -> String {
    let mut digest = Sha256::new();
    for entry in entries {
        digest.update(entry.path.as_bytes());
        digest.update([0]);
        digest.update(entry.sha256.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_regular_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, UnifiedBackupError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UnifiedBackupError::ReadFailed)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(UnifiedBackupError::ReadFailed);
    }
    if metadata.len() > maximum {
        return Err(UnifiedBackupError::TooLarge);
    }
    let file = File::open(path).map_err(|_| UnifiedBackupError::ReadFailed)?;
    let mut contents = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.take(maximum.saturating_add(1))
        .read_to_end(&mut contents)
        .map_err(|_| UnifiedBackupError::ReadFailed)?;
    if contents.len() as u64 > maximum {
        return Err(UnifiedBackupError::TooLarge);
    }
    Ok(contents)
}

fn read_optional_safe_json(path: &Path) -> Result<Option<Vec<u8>>, UnifiedBackupError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(UnifiedBackupError::ReadFailed)
        }
        Ok(_) => {
            let bytes = read_regular_bounded(path, 1024 * 1024)?;
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|_| UnifiedBackupError::InvalidBackup)?;
            Ok(Some(bytes))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(UnifiedBackupError::ReadFailed),
    }
}

fn map_unified_private_error(
    error: crate::calendar_store::private_file::PrivateFileError,
) -> UnifiedBackupError {
    match error {
        crate::calendar_store::private_file::PrivateFileError::DestinationExists => {
            UnifiedBackupError::DestinationExists
        }
        crate::calendar_store::private_file::PrivateFileError::Failed => UnifiedBackupError::Failed,
    }
}

fn safe_unified_file_name(path: &Path) -> Result<String, UnifiedBackupError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .ok_or(UnifiedBackupError::Failed)
}

fn archive_source_identity(path: &Path) -> Result<ArchiveSourceIdentity, UnifiedBackupError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UnifiedBackupError::ReadFailed)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(UnifiedBackupError::ReadFailed);
    }
    if metadata.len() > UNIFIED_MAX_ARCHIVE_BYTES {
        return Err(UnifiedBackupError::TooLarge);
    }
    let canonical_path = fs::canonicalize(path).map_err(|_| UnifiedBackupError::ReadFailed)?;
    let metadata =
        fs::symlink_metadata(&canonical_path).map_err(|_| UnifiedBackupError::ReadFailed)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(UnifiedBackupError::ReadFailed);
    }
    let handle = same_file::Handle::from_path(&canonical_path)
        .map_err(|_| UnifiedBackupError::ReadFailed)?;
    let fingerprint =
        sha256_file(&canonical_path, metadata.len()).map_err(|_| UnifiedBackupError::ReadFailed)?;
    Ok(ArchiveSourceIdentity {
        canonical_path,
        handle,
        fingerprint,
    })
}

fn archive_source_still_matches(source: &ArchiveSourceIdentity) -> Result<(), UnifiedBackupError> {
    let current = archive_source_identity(&source.canonical_path)?;
    if current.canonical_path != source.canonical_path
        || current.handle != source.handle
        || current.fingerprint != source.fingerprint
    {
        return Err(UnifiedBackupError::SessionUnavailable);
    }
    Ok(())
}

fn parse_unified_archive(path: &Path) -> Result<BTreeMap<String, Vec<u8>>, UnifiedBackupError> {
    let file = File::open(path).map_err(|_| UnifiedBackupError::ReadFailed)?;
    let mut zip = ZipArchive::new(file).map_err(|_| UnifiedBackupError::InvalidBackup)?;
    if zip.is_empty() || zip.len() > UNIFIED_ALLOWED_ENTRIES.len() {
        return Err(UnifiedBackupError::InvalidBackup);
    }
    let mut entries = BTreeMap::new();
    let mut expanded_bytes = 0_u64;
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|_| UnifiedBackupError::InvalidBackup)?;
        let name = entry.name().to_owned();
        if name.len() > 128
            || name.contains('\\')
            || name.starts_with('/')
            || name.contains("..")
            || !UNIFIED_ALLOWED_ENTRIES.contains(&name.as_str())
            || entry.is_dir()
            || entry.is_symlink()
            || entry.enclosed_name().as_deref() != Some(Path::new(&name))
            || entries.contains_key(&name)
        {
            return Err(UnifiedBackupError::InvalidBackup);
        }
        if entry.size() > UNIFIED_MAX_ENTRY_BYTES {
            return Err(UnifiedBackupError::TooLarge);
        }
        expanded_bytes = expanded_bytes
            .checked_add(entry.size())
            .ok_or(UnifiedBackupError::TooLarge)?;
        if expanded_bytes > UNIFIED_MAX_ARCHIVE_BYTES {
            return Err(UnifiedBackupError::TooLarge);
        }
        let mut contents = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
        entry
            .take(UNIFIED_MAX_ENTRY_BYTES.saturating_add(1))
            .read_to_end(&mut contents)
            .map_err(|_| UnifiedBackupError::InvalidBackup)?;
        if contents.len() as u64 > UNIFIED_MAX_ENTRY_BYTES {
            return Err(UnifiedBackupError::TooLarge);
        }
        entries.insert(name, contents);
    }
    validate_unified_entries(&entries)?;
    Ok(entries)
}

fn validate_unified_entries(entries: &BTreeMap<String, Vec<u8>>) -> Result<(), UnifiedBackupError> {
    let manifest_bytes = entries
        .get("manifest.json")
        .ok_or(UnifiedBackupError::InvalidBackup)?;
    let manifest: UnifiedManifest =
        serde_json::from_slice(manifest_bytes).map_err(|_| UnifiedBackupError::InvalidBackup)?;
    if manifest.format != UNIFIED_BACKUP_FORMAT
        || manifest.version != 1
        || manifest.created_at_utc_ms < 0
    {
        return Err(UnifiedBackupError::InvalidBackup);
    }
    let mut declared = HashSet::new();
    for entry in &manifest.entries {
        if !UNIFIED_ALLOWED_ENTRIES.contains(&entry.path.as_str())
            || entry.path == "manifest.json"
            || !declared.insert(&entry.path)
        {
            return Err(UnifiedBackupError::InvalidBackup);
        }
        let actual = entries
            .get(&entry.path)
            .ok_or(UnifiedBackupError::InvalidBackup)?;
        if entry.byte_size != actual.len() as u64 || entry.sha256 != sha256_bytes(actual) {
            return Err(UnifiedBackupError::VerificationFailed);
        }
    }
    let actual: HashSet<_> = entries
        .keys()
        .filter(|name| name.as_str() != "manifest.json")
        .collect();
    if actual.len() != declared.len() || actual.iter().any(|name| !declared.contains(*name)) {
        return Err(UnifiedBackupError::InvalidBackup);
    }
    if manifest.consistency_marker != consistency_marker(&manifest.entries) {
        return Err(UnifiedBackupError::VerificationFailed);
    }
    if let Some(note_data) = entries.get("note-data.json") {
        NotesService::validate_unified_backup_snapshot(note_data)
            .map_err(|_| UnifiedBackupError::InvalidBackup)?;
    }
    for name in [
        "widget-state.json",
        "voice-config.json",
        "asset-metadata.json",
    ] {
        if let Some(json) = entries.get(name) {
            serde_json::from_slice::<serde_json::Value>(json)
                .map_err(|_| UnifiedBackupError::InvalidBackup)?;
        }
    }
    Ok(())
}

async fn validate_unified_calendar_payload(
    state: &UnifiedBackupState,
    calendar: &[u8],
) -> Result<(), UnifiedBackupError> {
    stage_unified_calendar_payload(state, calendar)
        .await
        .map(drop)
}

async fn stage_unified_calendar_payload(
    state: &UnifiedBackupState,
    calendar: &[u8],
) -> Result<StagedUnifiedCalendarRestore, UnifiedBackupError> {
    let staging = state.app_data_dir.join("unified-backup-staging");
    prepare_unified_private_directory(&staging)?;
    let source_placeholder = staging.join(format!("calendar-source-{}.sqlite3", Uuid::new_v4()));
    let temporary =
        PrivateTempFile::create(&source_placeholder, ".note-unified-calendar-", ".sqlite3")
            .map_err(|_| UnifiedBackupError::VerificationFailed)?;
    temporary
        .write_and_sync(calendar)
        .map_err(|_| UnifiedBackupError::VerificationFailed)?;
    let verified_path = staging.join(format!("calendar-verified-{}.sqlite3", Uuid::new_v4()));
    let result = state
        .store
        .stage_restore_snapshot(temporary.path(), &verified_path, UNIFIED_MAX_ENTRY_BYTES)
        .await;
    let (_, inspection) = match result {
        Ok(staged) => staged,
        Err(_) => {
            let _ = fs::remove_file(&verified_path);
            return Err(UnifiedBackupError::VerificationFailed);
        }
    };
    Ok(StagedUnifiedCalendarRestore {
        path: verified_path,
        inspection,
    })
}

fn prepare_unified_private_directory(path: &Path) -> Result<(), UnifiedBackupError> {
    fs::create_dir_all(path).map_err(|_| UnifiedBackupError::Failed)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| UnifiedBackupError::Failed)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(UnifiedBackupError::Failed);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| UnifiedBackupError::Failed)?;
    }
    Ok(())
}

fn unified_restore_intent_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(UNIFIED_RESTORE_INTENT_FILE_NAME)
}

fn safe_recovery_backup_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.ends_with(".zip")
        && Path::new(value)
            .file_name()
            .is_some_and(|name| name == value)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
}

fn write_unified_restore_intent(
    app_data_dir: &Path,
    intent: &UnifiedRestoreIntent,
) -> Result<(), UnifiedBackupError> {
    if intent.version != 1 || !safe_recovery_backup_file_name(&intent.recovery_backup_file_name) {
        return Err(UnifiedBackupError::Failed);
    }
    let bytes = serde_json::to_vec(intent).map_err(|_| UnifiedBackupError::Failed)?;
    atomic_write_private(&unified_restore_intent_path(app_data_dir), &bytes)
        .map_err(|_| UnifiedBackupError::Failed)
}

fn read_unified_restore_intent(
    app_data_dir: &Path,
) -> Result<Option<UnifiedRestoreIntent>, UnifiedBackupError> {
    let path = unified_restore_intent_path(app_data_dir);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(UnifiedBackupError::RecoveryRequired),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4 * 1024 {
        return Err(UnifiedBackupError::RecoveryRequired);
    }
    let bytes = fs::read(path).map_err(|_| UnifiedBackupError::RecoveryRequired)?;
    let intent: UnifiedRestoreIntent =
        serde_json::from_slice(&bytes).map_err(|_| UnifiedBackupError::RecoveryRequired)?;
    if intent.version != 1 || !safe_recovery_backup_file_name(&intent.recovery_backup_file_name) {
        return Err(UnifiedBackupError::RecoveryRequired);
    }
    Ok(Some(intent))
}

fn remove_unified_restore_intent(app_data_dir: &Path) -> Result<(), UnifiedBackupError> {
    let path = unified_restore_intent_path(app_data_dir);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(UnifiedBackupError::RecoveryRequired)
        }
        Ok(_) => {
            fs::remove_file(&path).map_err(|_| UnifiedBackupError::RecoveryRequired)?;
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                let directory =
                    File::open(parent).map_err(|_| UnifiedBackupError::RecoveryRequired)?;
                directory
                    .sync_all()
                    .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(UnifiedBackupError::RecoveryRequired),
    }
}

pub(crate) fn unified_restore_intent_is_pending(app_data_dir: &Path) -> bool {
    !matches!(
        fs::symlink_metadata(unified_restore_intent_path(app_data_dir)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

impl UnifiedBackupState {
    async fn preview_restore_at(
        &self,
        source: &Path,
        now_utc_ms: i64,
        now: Instant,
    ) -> Result<UnifiedBackupRestorePreviewResponse, UnifiedBackupError> {
        let source_identity = archive_source_identity(source)?;
        let entries = parse_unified_archive(&source_identity.canonical_path)?;
        if let Some(calendar) = entries.get("calendar.sqlite3") {
            validate_unified_calendar_payload(self, calendar).await?;
        }
        let id = Uuid::new_v4();
        let expires_at_utc_ms = now_utc_ms
            .checked_add(UNIFIED_RESTORE_SESSION_TTL_MS)
            .ok_or(UnifiedBackupError::Failed)?;
        *self
            .restore_session
            .lock()
            .map_err(|_| UnifiedBackupError::Failed)? = Some(UnifiedRestoreSession {
            id,
            source: source_identity,
            staged_entries: entries.clone(),
            expires_at: now + Duration::from_millis(UNIFIED_RESTORE_SESSION_TTL_MS as u64),
        });
        Ok(UnifiedBackupRestorePreviewResponse::Previewed {
            session_id: id.to_string(),
            file_name: safe_unified_file_name(source)?,
            byte_size: fs::metadata(source)
                .map_err(|_| UnifiedBackupError::ReadFailed)?
                .len(),
            expires_at_utc_ms,
            has_note_data: entries.contains_key("note-data.json"),
            has_calendar_snapshot: entries.contains_key("calendar.sqlite3"),
        })
    }

    // This consumes the renderer-facing preview before checking its source.
    // A future restore commit must use this helper so an expired, replaced, or
    // otherwise invalidated archive can never be replayed.
    fn consume_restore_session_at(
        &self,
        session_id: &str,
        now: Instant,
    ) -> Result<UnifiedRestoreSession, UnifiedBackupError> {
        let id = Uuid::parse_str(session_id).map_err(|_| UnifiedBackupError::SessionUnavailable)?;
        let mut guard = self
            .restore_session
            .lock()
            .map_err(|_| UnifiedBackupError::Failed)?;
        if guard
            .as_ref()
            .is_some_and(|candidate| candidate.expires_at <= now)
        {
            guard.take();
            return Err(UnifiedBackupError::SessionUnavailable);
        }
        let session = guard
            .take()
            .filter(|candidate| candidate.id == id)
            .ok_or(UnifiedBackupError::SessionUnavailable)?;
        drop(guard);
        archive_source_still_matches(&session.source)?;
        Ok(session)
    }

    async fn commit_restore_at(
        &self,
        notes: &NotesService,
        request: UnifiedBackupRestoreCommitRequest,
        now_utc_ms: i64,
        now: Instant,
    ) -> Result<UnifiedBackupRestoreCommitResponse, UnifiedBackupError> {
        self.commit_restore_at_with_hook(notes, request, now_utc_ms, now, |_| Ok(()))
            .await
    }

    async fn commit_restore_at_with_hook<F>(
        &self,
        notes: &NotesService,
        request: UnifiedBackupRestoreCommitRequest,
        now_utc_ms: i64,
        now: Instant,
        hook: F,
    ) -> Result<UnifiedBackupRestoreCommitResponse, UnifiedBackupError>
    where
        F: Fn(UnifiedRestoreStage) -> Result<(), UnifiedBackupError>,
    {
        let session = self.consume_restore_session_at(&request.session_id, now)?;
        let note_data = session.staged_entries.get("note-data.json").cloned();
        if let Some(note_data) = &note_data {
            NotesService::validate_unified_backup_snapshot(note_data)
                .map_err(|_| UnifiedBackupError::VerificationFailed)?;
        }
        let calendar = match session.staged_entries.get("calendar.sqlite3") {
            Some(calendar) => Some(stage_unified_calendar_payload(self, calendar).await?),
            None => None,
        };
        if note_data.is_none() && calendar.is_none() {
            return Err(UnifiedBackupError::InvalidBackup);
        }

        // Capture the Note state separately so a calendar transaction failure
        // can restore the first store. The recovery ZIP below is the durable,
        // user-recoverable record and is created before either live store is
        // replaced.
        let previous_note = if note_data.is_some() {
            notes
                .unified_backup_snapshot()
                .map_err(|_| UnifiedBackupError::RecoveryBackupFailed)?
        } else {
            None
        };
        prepare_unified_private_directory(&self.recovery_directory)
            .map_err(|_| UnifiedBackupError::RecoveryBackupFailed)?;
        let recovery_file_name = format!(
            "note-before-unified-restore-{}-{}.zip",
            now_utc_ms,
            Uuid::new_v4()
        );
        let recovery_path = self.recovery_directory.join(&recovery_file_name);
        create_unified_archive(self, notes, &recovery_path, now_utc_ms)
            .await
            .map_err(|_| UnifiedBackupError::RecoveryBackupFailed)?;
        let mut intent = UnifiedRestoreIntent {
            version: 1,
            recovery_backup_file_name: recovery_file_name.clone(),
            phase: UnifiedRestoreIntentPhase::Prepared,
        };
        write_unified_restore_intent(&self.app_data_dir, &intent)
            .map_err(|_| UnifiedBackupError::RecoveryBackupFailed)?;
        // The intent is now durable, so fail closed before the first live
        // publication. Any later interruption is reconciled from its verified
        // recovery artifact before normal commands may write again.
        self.recovery_pending.store(true, Ordering::Release);

        if let Some(note_data) = &note_data {
            hook(UnifiedRestoreStage::NotePublish)
                .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
            notes
                .restore_unified_backup_snapshot(note_data)
                .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
            intent.phase = UnifiedRestoreIntentPhase::NotePublished;
            write_unified_restore_intent(&self.app_data_dir, &intent)
                .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
        }
        if let Some(calendar) = &calendar {
            if hook(UnifiedRestoreStage::CalendarPublish).is_err()
                || self
                    .store
                    .restore_staged_snapshot_after_recovery(&calendar.path, &calendar.inspection)
                    .await
                    .is_err()
            {
                if note_data.is_some()
                    && (hook(UnifiedRestoreStage::NoteRollback).is_err()
                        || rollback_unified_note(notes, previous_note.as_deref()).is_err())
                {
                    return Err(UnifiedBackupError::RecoveryRequired);
                }
                return Err(UnifiedBackupError::RecoveryRequired);
            }
            intent.phase = UnifiedRestoreIntentPhase::CalendarPublished;
            write_unified_restore_intent(&self.app_data_dir, &intent)
                .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
        }

        verify_unified_restore_targets(self, notes, note_data.as_deref(), calendar.as_ref())
            .await
            .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
        remove_unified_restore_intent(&self.app_data_dir)
            .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
        self.recovery_pending.store(false, Ordering::Release);

        // Optional widget/voice/asset metadata is backup-only in v1. It is
        // intentionally never restored, so credentials, models, and other
        // machine-specific configuration remain untouched by construction.
        Ok(UnifiedBackupRestoreCommitResponse::Restored {
            note_data_restored: note_data.is_some(),
            calendar_restored: calendar.is_some(),
            recovery_backup_file_name: recovery_file_name,
            restored_at_utc_ms: now_utc_ms,
        })
    }
}

fn rollback_unified_note(
    notes: &NotesService,
    previous_note: Option<&[u8]>,
) -> Result<(), UnifiedBackupError> {
    match previous_note {
        Some(previous_note) => notes
            .restore_unified_backup_snapshot(previous_note)
            .map_err(|_| UnifiedBackupError::Failed),
        None => notes
            .clear_unified_backup_snapshot()
            .map_err(|_| UnifiedBackupError::Failed),
    }
}

async fn verify_unified_restore_targets(
    state: &UnifiedBackupState,
    notes: &NotesService,
    note_data: Option<&[u8]>,
    calendar: Option<&StagedUnifiedCalendarRestore>,
) -> Result<(), UnifiedBackupError> {
    match (note_data, notes.unified_backup_snapshot()) {
        (Some(_), Ok(Some(snapshot))) => {
            NotesService::validate_unified_backup_snapshot(&snapshot)
                .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
        }
        (None, Ok(None)) => {}
        _ => return Err(UnifiedBackupError::RecoveryRequired),
    }
    if let Some(calendar) = calendar {
        let current = state
            .store
            .current_restore_counts()
            .await
            .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
        if current.calendar_count != calendar.inspection.backup.calendar_count
            || current.event_count != calendar.inspection.backup.event_count
            || current.reminder_count != calendar.inspection.backup.reminder_count
        {
            return Err(UnifiedBackupError::RecoveryRequired);
        }
    }
    Ok(())
}

async fn recover_unified_restore_intent_at(
    app_data_dir: &Path,
    store: Arc<SqliteEventStore>,
) -> Result<(), UnifiedBackupError> {
    let intent = read_unified_restore_intent(app_data_dir)?.ok_or(UnifiedBackupError::Failed)?;
    let recovery_path = app_data_dir
        .join("unified-backups")
        .join(&intent.recovery_backup_file_name);
    let source = archive_source_identity(&recovery_path)
        .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
    let entries = parse_unified_archive(&source.canonical_path)
        .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
    let note_data = entries.get("note-data.json").map(Vec::as_slice);
    if let Some(note_data) = note_data {
        NotesService::validate_unified_backup_snapshot(note_data)
            .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
    }
    let state = UnifiedBackupState::new(store, app_data_dir.to_owned());
    let calendar_bytes = entries
        .get("calendar.sqlite3")
        .ok_or(UnifiedBackupError::RecoveryRequired)?;
    let calendar = stage_unified_calendar_payload(&state, calendar_bytes)
        .await
        .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
    let notes = NotesService::new(app_data_dir.to_owned());

    match note_data {
        Some(note_data) => notes
            .restore_unified_backup_snapshot(note_data)
            .map_err(|_| UnifiedBackupError::RecoveryRequired)?,
        None => notes
            .clear_unified_backup_snapshot()
            .map_err(|_| UnifiedBackupError::RecoveryRequired)?,
    }
    write_unified_restore_intent(
        app_data_dir,
        &UnifiedRestoreIntent {
            version: 1,
            recovery_backup_file_name: intent.recovery_backup_file_name.clone(),
            phase: UnifiedRestoreIntentPhase::NotePublished,
        },
    )?;
    state
        .store
        .restore_staged_snapshot_after_recovery(&calendar.path, &calendar.inspection)
        .await
        .map_err(|_| UnifiedBackupError::RecoveryRequired)?;
    write_unified_restore_intent(
        app_data_dir,
        &UnifiedRestoreIntent {
            version: 1,
            recovery_backup_file_name: intent.recovery_backup_file_name,
            phase: UnifiedRestoreIntentPhase::CalendarPublished,
        },
    )?;
    verify_unified_restore_targets(&state, &notes, note_data, Some(&calendar)).await?;
    remove_unified_restore_intent(app_data_dir)
}

pub(crate) async fn recover_unified_restore_intent(
    app_data_dir: &Path,
    store: Arc<SqliteEventStore>,
    recovery_pending: Arc<AtomicBool>,
) -> Result<(), ()> {
    match recover_unified_restore_intent_at(app_data_dir, store).await {
        Ok(()) => {
            recovery_pending.store(false, Ordering::Release);
            Ok(())
        }
        Err(_) => Err(()),
    }
}

#[derive(FromRow)]
struct CalSourceEventRow {
    id: String,
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
}

impl CalImportCandidate {
    fn staged(&self) -> StagedImportEvent {
        StagedImportEvent {
            source_index: 0,
            draft: self.draft.clone(),
            source_identity: Some(ImportSourceIdentity {
                uid: self.provenance_uid.clone(),
                sequence: self.provenance_sequence,
            }),
        }
    }
}

impl CalImportState {
    async fn preview_at(
        &self,
        source: &Path,
        now_utc_ms: i64,
        now: Instant,
    ) -> Result<CalImportPreviewResponse, CalImportError> {
        let (source, candidates) = inspect_cal_source(source).await?;
        let source_uids: Vec<_> = candidates
            .iter()
            .map(|candidate| candidate.provenance_uid.clone())
            .collect();
        let existing = self
            .store
            .source_identities(&source_uids)
            .await
            .map_err(|_| CalImportError::Failed)?;
        let existing_uids: std::collections::HashSet<_> =
            existing.into_iter().map(|identity| identity.uid).collect();
        let existing_count = candidates
            .iter()
            .filter(|candidate| existing_uids.contains(&candidate.provenance_uid))
            .count();
        let file_name = safe_file_name(&source.canonical_path)?;
        let id = Uuid::new_v4();
        let expires_at_utc_ms = now_utc_ms
            .checked_add(CAL_IMPORT_SESSION_TTL_MS)
            .ok_or(CalImportError::Failed)?;
        *self.session.lock().map_err(|_| CalImportError::Failed)? = Some(CalImportSession {
            id,
            source,
            candidates,
            expires_at: now + Duration::from_millis(CAL_IMPORT_SESSION_TTL_MS as u64),
        });
        let (event_count, items) = self
            .session
            .lock()
            .map_err(|_| CalImportError::Failed)?
            .as_ref()
            .map(|session| {
                (
                    session.source.event_count,
                    session
                        .candidates
                        .iter()
                        .map(|candidate| candidate.preview.clone())
                        .collect(),
                )
            })
            .ok_or(CalImportError::Failed)?;
        Ok(CalImportPreviewResponse::Previewed {
            session_id: id.to_string(),
            file_name,
            expires_at_utc_ms,
            total_count: event_count,
            accepted_count: event_count,
            existing_count,
            items,
        })
    }

    fn consume_for_commit(
        &self,
        session_id: &str,
        now: Instant,
    ) -> Result<CalImportSession, CalImportError> {
        let id = Uuid::parse_str(session_id).map_err(|_| CalImportError::SessionUnavailable)?;
        let mut session = self.session.lock().map_err(|_| CalImportError::Failed)?;
        if session
            .as_ref()
            .is_some_and(|candidate| candidate.expires_at <= now)
        {
            session.take();
            return Err(CalImportError::SessionUnavailable);
        }
        let session = session
            .take()
            .filter(|candidate| candidate.id == id)
            .ok_or(CalImportError::SessionUnavailable)?;
        Ok(session)
    }

    async fn commit_at(
        &self,
        request: CalImportCommitRequest,
        now_utc_ms: i64,
        now: Instant,
    ) -> Result<CalImportCommitResponse, CalImportError> {
        let session = self.consume_for_commit(&request.session_id, now)?;
        source_still_matches(&session.source)?;
        fs::create_dir_all(&self.recovery_directory)
            .map_err(|_| CalImportError::RecoveryBackupFailed)?;
        let recovery_backup_file_name = format!(
            "note-calendar-before-cal-import-{}-{}.sqlite3",
            Utc::now().format("%Y%m%dT%H%M%SZ"),
            Uuid::new_v4()
        );
        let recovery_path = self.recovery_directory.join(&recovery_backup_file_name);
        self.store
            .create_backup(&recovery_path)
            .await
            .map_err(|_| CalImportError::RecoveryBackupFailed)?;
        let before = self
            .store
            .current_restore_counts()
            .await
            .map_err(|_| CalImportError::Failed)?;
        let staged: Vec<_> = session
            .candidates
            .iter()
            .map(CalImportCandidate::staged)
            .collect();
        let accepted_count = staged.len();
        let result = self
            .store
            .commit_import(
                &staged,
                ImportDuplicatePolicy::SkipExisting,
                CAL_IMPORT_PARSER_VERSION,
                now_utc_ms,
            )
            .await
            .map_err(|_| CalImportError::Failed)?;
        if result.imported_count.saturating_add(result.skipped_count) != accepted_count {
            return Err(CalImportError::VerificationFailed);
        }
        let after = self
            .store
            .current_restore_counts()
            .await
            .map_err(|_| CalImportError::VerificationFailed)?;
        if after.event_count
            != before.event_count.saturating_add(
                i64::try_from(result.imported_count)
                    .map_err(|_| CalImportError::VerificationFailed)?,
            )
        {
            return Err(CalImportError::VerificationFailed);
        }
        Ok(CalImportCommitResponse::Committed {
            accepted_count,
            imported_count: result.imported_count,
            skipped_count: result.skipped_count,
            recovery_backup_file_name,
            committed_at_utc_ms: now_utc_ms,
        })
    }
}

fn safe_file_name(path: &Path) -> Result<String, CalImportError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && name.chars().count() <= 255)
        .map(ToOwned::to_owned)
        .ok_or(CalImportError::ReadFailed)
}

fn source_identity(path: &Path) -> Result<(PathBuf, same_file::Handle, String), CalImportError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| CalImportError::ReadFailed)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CalImportError::ReadFailed);
    }
    if metadata.len() > MAX_CAL_SOURCE_BYTES {
        return Err(CalImportError::TooLarge);
    }
    let canonical_path = fs::canonicalize(path).map_err(|_| CalImportError::ReadFailed)?;
    let metadata = fs::symlink_metadata(&canonical_path).map_err(|_| CalImportError::ReadFailed)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CalImportError::ReadFailed);
    }
    let handle =
        same_file::Handle::from_path(&canonical_path).map_err(|_| CalImportError::ReadFailed)?;
    let fingerprint = sha256_file(&canonical_path, metadata.len())?;
    Ok((canonical_path, handle, fingerprint))
}

fn sha256_file(path: &Path, expected_len: u64) -> Result<String, CalImportError> {
    let mut file = File::open(path).map_err(|_| CalImportError::ReadFailed)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| CalImportError::ReadFailed)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or(CalImportError::TooLarge)?;
        if total > MAX_CAL_SOURCE_BYTES {
            return Err(CalImportError::TooLarge);
        }
        digest.update(&buffer[..read]);
    }
    if total != expected_len {
        return Err(CalImportError::SourceChanged);
    }
    Ok(format!("{:x}", digest.finalize()))
}

async fn inspect_cal_source(
    source: &Path,
) -> Result<(CalSourceIdentity, Vec<CalImportCandidate>), CalImportError> {
    let (canonical_path, handle, fingerprint) = source_identity(source)?;
    let options = SqliteConnectOptions::new()
        .filename(&canonical_path)
        .read_only(true)
        .immutable(true)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| CalImportError::InvalidSource)?;
    for pragma in ["PRAGMA quick_check", "PRAGMA integrity_check"] {
        let result: Vec<String> = sqlx::query_scalar(pragma)
            .fetch_all(&mut connection)
            .await
            .map_err(|_| CalImportError::IntegrityFailed)?;
        if result.is_empty() || result.iter().any(|row| row != "ok") {
            return Err(CalImportError::IntegrityFailed);
        }
    }
    if sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| CalImportError::IntegrityFailed)?
        .is_some()
    {
        return Err(CalImportError::IntegrityFailed);
    }
    for table in [
        "calendars",
        "events",
        "event_overrides",
        "event_import_sources",
        "reminders",
    ] {
        let table: Option<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
                .bind(table)
                .fetch_optional(&mut connection)
                .await
                .map_err(|_| CalImportError::InvalidSource)?;
        if table.is_none() {
            return Err(CalImportError::InvalidSource);
        }
    }
    let calendar_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendars")
        .fetch_one(&mut connection)
        .await
        .map_err(|_| CalImportError::InvalidSource)?;
    let reminder_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reminders")
        .fetch_one(&mut connection)
        .await
        .map_err(|_| CalImportError::InvalidSource)?;
    let override_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_overrides")
        .fetch_one(&mut connection)
        .await
        .map_err(|_| CalImportError::InvalidSource)?;
    // Note currently has one local calendar and its import transaction cannot
    // preserve per-calendar ownership, reminder timing, or occurrence override
    // semantics. Fail closed instead of dropping those source records.
    if calendar_count != 1 || reminder_count != 0 || override_count != 0 {
        return Err(CalImportError::UnsupportedSource);
    }
    let rows = sqlx::query_as::<_, CalSourceEventRow>(
        "SELECT id, title, description, location, temporal_kind, start_utc, end_utc,
                time_zone, start_date, end_date_exclusive, rrule
         FROM events WHERE status = 'confirmed' AND NOT EXISTS (
            SELECT 1 FROM event_overrides WHERE override_event_id = events.id
         ) ORDER BY id ASC LIMIT ?",
    )
    .bind((MAX_CAL_IMPORT_EVENTS + 1) as i64)
    .fetch_all(&mut connection)
    .await
    .map_err(|_| CalImportError::InvalidSource)?;
    if rows.len() > MAX_CAL_IMPORT_EVENTS {
        return Err(CalImportError::TooLarge);
    }
    let candidates = rows
        .into_iter()
        .map(|row| candidate_from_source_row(row, &fingerprint))
        .collect::<Result<Vec<_>, _>>()?;
    let event_count = candidates.len();
    connection
        .close()
        .await
        .map_err(|_| CalImportError::ReadFailed)?;
    Ok((
        CalSourceIdentity {
            canonical_path,
            handle,
            fingerprint,
            event_count,
        },
        candidates,
    ))
}

fn candidate_from_source_row(
    row: CalSourceEventRow,
    fingerprint: &str,
) -> Result<CalImportCandidate, CalImportError> {
    if row.id.is_empty() || row.id.chars().count() > 900 {
        return Err(CalImportError::InvalidSource);
    }
    let (time, temporal_kind, start_label, end_label) = match row.temporal_kind.as_str() {
        "timed" => {
            let start_utc_ms = row.start_utc.ok_or(CalImportError::InvalidSource)?;
            let end_utc_ms = row.end_utc.ok_or(CalImportError::InvalidSource)?;
            let time_zone = row.time_zone.ok_or(CalImportError::InvalidSource)?;
            (
                EventTime::Timed {
                    start_utc_ms,
                    end_utc_ms,
                    time_zone,
                },
                CalImportTemporalKind::Timed,
                start_utc_ms.to_string(),
                end_utc_ms.to_string(),
            )
        }
        "all_day" => {
            let start = row.start_date.ok_or(CalImportError::InvalidSource)?;
            let end = row
                .end_date_exclusive
                .ok_or(CalImportError::InvalidSource)?;
            (
                parse_all_day_event(&start, &end).map_err(|_| CalImportError::InvalidSource)?,
                CalImportTemporalKind::AllDay,
                start,
                end,
            )
        }
        _ => return Err(CalImportError::InvalidSource),
    };
    let draft = EventDraft::validated_with_recurrence_and_reminders(
        row.title.clone(),
        row.description,
        row.location,
        time,
        row.rrule,
        Vec::new(),
    )
    .map_err(|_| CalImportError::InvalidSource)?;
    // Keep the duplicate key stable across later source-database revisions. The
    // source snapshot fingerprint is retained as a bounded provenance sequence
    // while the immutable Cal event ID remains the duplicate key.
    let (provenance_uid, provenance_sequence) = provenance_for(&row.id, fingerprint)?;
    Ok(CalImportCandidate {
        provenance_uid,
        provenance_sequence,
        draft,
        preview: CalImportPreviewItem {
            source_event_id: row.id,
            title: row.title,
            temporal_kind,
            start_label,
            end_label,
        },
    })
}

fn provenance_for(
    source_event_id: &str,
    fingerprint: &str,
) -> Result<(String, i64), CalImportError> {
    let provenance_uid = format!("cal-sqlite-v1:{source_event_id}");
    if provenance_uid.chars().count() > 1024 || fingerprint.len() < 8 {
        return Err(CalImportError::InvalidSource);
    }
    let provenance_sequence = i64::from(
        u32::from_str_radix(&fingerprint[..8], 16).map_err(|_| CalImportError::InvalidSource)?
            & 0x7fff_ffff,
    );
    Ok((provenance_uid, provenance_sequence))
}

fn source_still_matches(source: &CalSourceIdentity) -> Result<(), CalImportError> {
    let (path, handle, fingerprint) = source_identity(&source.canonical_path)?;
    if path != source.canonical_path || handle != source.handle || fingerprint != source.fingerprint
    {
        return Err(CalImportError::SourceChanged);
    }
    Ok(())
}

#[tauri::command]
pub async fn cal_import_preview(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
) -> Result<CalImportPreviewResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Preview Cal data import")
        .add_filter("SQLite database", &["sqlite", "sqlite3", "db"])
        .blocking_pick_file();
    let Some(source) = selected
        .map(|path| path.into_path().map_err(|_| CalImportError::ReadFailed))
        .transpose()?
    else {
        return Ok(CalImportPreviewResponse::Cancelled);
    };
    runtime
        .migration
        .cal_import
        .preview_at(&source, Utc::now().timestamp_millis(), Instant::now())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn cal_import_commit(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
    request: CalImportCommitRequest,
) -> Result<CalImportCommitResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let _mutation = app_state.begin_calendar_mutation()?;
    let response = runtime
        .migration
        .cal_import
        .commit_at(request, Utc::now().timestamp_millis(), Instant::now())
        .await?;
    #[cfg(desktop)]
    crate::calendar::reminders::trigger_reminder_rebuild(&window);
    crate::calendar::api::emit_calendar_changed(&window);
    Ok(response)
}

#[tauri::command]
pub async fn unified_backup_create(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
) -> Result<UnifiedBackupCreateResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save Note unified backup")
        .set_file_name(UNIFIED_BACKUP_FILE_NAME)
        .add_filter("Note unified backup", &["zip"])
        .blocking_save_file();
    let Some(destination) = selected
        .map(|path| path.into_path().map_err(|_| UnifiedBackupError::Failed))
        .transpose()?
    else {
        return Ok(UnifiedBackupCreateResponse::Cancelled);
    };
    let (_note_mutation, _calendar_mutation) = begin_unified_backup_mutations(&app_state)?;
    create_unified_archive(
        &runtime.migration.unified,
        &app_state.notes,
        &destination,
        Utc::now().timestamp_millis(),
    )
    .await
    .map_err(Into::into)
}

fn begin_unified_backup_mutations(
    app_state: &AppState,
) -> Result<(MutexGuard<'_, ()>, MutexGuard<'_, ()>), ApiError> {
    // Keep both snapshots inside the fixed Note -> calendar order used by
    // restore, but do not hold data locks while a native file dialog is open.
    let note_mutation = app_state
        .begin_note_mutation()
        .map_err(|_| mutation_busy_api_error())?;
    let calendar_mutation = app_state.begin_calendar_mutation()?;
    Ok((note_mutation, calendar_mutation))
}

#[tauri::command]
pub async fn unified_backup_restore_preview(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
) -> Result<UnifiedBackupRestorePreviewResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose Note unified backup")
        .add_filter("Note unified backup", &["zip"])
        .blocking_pick_file();
    let Some(source) = selected
        .map(|path| path.into_path().map_err(|_| UnifiedBackupError::ReadFailed))
        .transpose()?
    else {
        return Ok(UnifiedBackupRestorePreviewResponse::Cancelled);
    };
    runtime
        .migration
        .unified
        .preview_restore_at(&source, Utc::now().timestamp_millis(), Instant::now())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn unified_backup_restore_commit(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
    request: UnifiedBackupRestoreCommitRequest,
) -> Result<UnifiedBackupRestoreCommitResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    // Keep a fixed order for the only command that coordinates both mutable
    // stores. No other write can interleave after these admissions succeed.
    let _note_mutation = app_state
        .begin_note_mutation()
        .map_err(|_| mutation_busy_api_error())?;
    let _calendar_mutation = app_state.begin_calendar_mutation()?;
    let response = runtime
        .migration
        .unified
        .commit_restore_at(
            &app_state.notes,
            request,
            Utc::now().timestamp_millis(),
            Instant::now(),
        )
        .await?;
    #[cfg(desktop)]
    crate::calendar::reminders::trigger_reminder_rebuild(&window);
    crate::calendar::api::emit_calendar_changed(&window);
    Ok(response)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalImportPreviewItem {
    pub(crate) source_event_id: String,
    pub(crate) title: String,
    pub(crate) temporal_kind: CalImportTemporalKind,
    pub(crate) start_label: String,
    pub(crate) end_label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CalImportTemporalKind {
    Timed,
    AllDay,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum CalImportPreviewResponse {
    Cancelled,
    Previewed {
        session_id: String,
        file_name: String,
        expires_at_utc_ms: i64,
        total_count: usize,
        accepted_count: usize,
        existing_count: usize,
        items: Vec<CalImportPreviewItem>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalImportCommitRequest {
    pub(crate) session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum CalImportCommitResponse {
    Committed {
        accepted_count: usize,
        imported_count: usize,
        skipped_count: usize,
        recovery_backup_file_name: String,
        committed_at_utc_ms: i64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum UnifiedBackupCreateResponse {
    Cancelled,
    Created {
        file_name: String,
        byte_size: u64,
        created_at_utc_ms: i64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum UnifiedBackupRestorePreviewResponse {
    Cancelled,
    Previewed {
        session_id: String,
        file_name: String,
        byte_size: u64,
        expires_at_utc_ms: i64,
        has_note_data: bool,
        has_calendar_snapshot: bool,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UnifiedBackupRestoreCommitRequest {
    pub(crate) session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum UnifiedBackupRestoreCommitResponse {
    Restored {
        note_data_restored: bool,
        calendar_restored: bool,
        recovery_backup_file_name: String,
        restored_at_utc_ms: i64,
    },
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;
    use crate::calendar::{api::ensure_window_label, error::ApiError};

    #[test]
    fn public_contracts_are_discriminated_strict_and_path_free() {
        assert!(serde_json::from_value::<CalImportCommitRequest>(json!({
            "sessionId": "00000000-0000-0000-0000-000000000000",
            "path": "C:\\\\private\\\\cal.sqlite3"
        }))
        .is_err());
        assert!(
            serde_json::from_value::<UnifiedBackupRestoreCommitRequest>(json!({
                "sessionId": "00000000-0000-0000-0000-000000000000",
                "path": "C:\\\\private\\\\backup.zip"
            }))
            .is_err()
        );
        let response = CalImportPreviewResponse::Previewed {
            session_id: "opaque".into(),
            file_name: "calendar.sqlite3".into(),
            expires_at_utc_ms: 1,
            total_count: 1,
            accepted_count: 1,
            existing_count: 0,
            items: Vec::new(),
        };
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(serialized.contains("calendar.sqlite3"));
        assert!(!serialized.contains("C:\\\\private"));
        assert_eq!(UNIFIED_BACKUP_FORMAT, "note-unified-backup-v1");
        assert_eq!(UNIFIED_BACKUP_FILE_NAME, "note-unified-backup-v1.zip");
    }

    #[test]
    fn source_identity_rejects_non_regular_and_changed_sources() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            source_identity(directory.path()),
            Err(CalImportError::ReadFailed)
        );
        let source = directory.path().join("cal.sqlite3");
        fs::write(&source, b"first").unwrap();
        let (canonical_path, handle, fingerprint) = source_identity(&source).unwrap();
        let identity = CalSourceIdentity {
            canonical_path,
            handle,
            fingerprint,
            event_count: 0,
        };
        assert_eq!(source_still_matches(&identity), Ok(()));
        fs::write(&source, b"second").unwrap();
        assert_eq!(
            source_still_matches(&identity),
            Err(CalImportError::SourceChanged)
        );
    }

    #[cfg(unix)]
    #[test]
    fn source_identity_rejects_symlink_sources() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.sqlite3");
        let link = directory.path().join("link.sqlite3");
        fs::write(&target, b"source").unwrap();
        symlink(&target, &link).unwrap();
        assert_eq!(source_identity(&link), Err(CalImportError::ReadFailed));
    }

    #[test]
    fn cal_import_is_bound_to_the_main_window_label() {
        assert_eq!(ensure_window_label("main"), Ok(()));
        assert_eq!(
            ensure_window_label("widget"),
            Err(ApiError::forbidden_window())
        );
    }

    #[test]
    fn stable_duplicate_key_preserves_event_identity_across_source_updates() {
        let (first_uid, first_sequence) = provenance_for(
            "a0d1d7e7-1c00-4a00-8000-000000000001",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        let (updated_uid, updated_sequence) = provenance_for(
            "a0d1d7e7-1c00-4a00-8000-000000000001",
            "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        )
        .unwrap();
        assert_eq!(first_uid, updated_uid);
        assert_ne!(first_sequence, updated_sequence);
    }

    async fn seed_source_event(store: &SqliteEventStore) -> String {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_date, end_date_exclusive,
                status, revision, created_at, updated_at
             ) VALUES (?, '00000000-0000-4000-8000-000000000001', 'Cal import',
                       'all_day', '2026-08-01', '2026-08-02', 'confirmed', 1, 1, 1)",
        )
        .bind(&id)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(store.pool())
            .await
            .unwrap();
        id
    }

    async fn commit_fixture() -> (tempfile::TempDir, SqliteEventStore, CalImportState) {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("cal.sqlite3");
        let source = SqliteEventStore::open(&source_path).await.unwrap();
        seed_source_event(&source).await;
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("note.sqlite3"))
                .await
                .unwrap(),
        );
        let state = CalImportState {
            store: target,
            recovery_directory: directory.path().join("backups"),
            session: Mutex::new(None),
        };
        (directory, source, state)
    }

    async fn preview_session_id(state: &CalImportState, source: &SqliteEventStore) -> String {
        let response = state
            .preview_at(source.database_path(), 1_000, Instant::now())
            .await
            .unwrap();
        let CalImportPreviewResponse::Previewed { session_id, .. } = response else {
            panic!("preview unexpectedly cancelled")
        };
        session_id
    }

    #[tokio::test]
    async fn commit_creates_verified_recovery_then_imports_and_checks_delta() {
        let (directory, source, state) = commit_fixture().await;
        let session_id = preview_session_id(&state, &source).await;
        let response = state
            .commit_at(CalImportCommitRequest { session_id }, 1_001, Instant::now())
            .await
            .unwrap();
        let CalImportCommitResponse::Committed {
            imported_count,
            skipped_count,
            recovery_backup_file_name,
            ..
        } = response;
        assert_eq!((imported_count, skipped_count), (1, 0));
        assert!(directory
            .path()
            .join("backups")
            .join(recovery_backup_file_name)
            .is_file());
        assert_eq!(
            state
                .store
                .current_restore_counts()
                .await
                .unwrap()
                .event_count,
            1
        );
    }

    #[tokio::test]
    async fn duplicate_commit_skips_stable_destination_provenance() {
        let (_directory, source, state) = commit_fixture().await;
        let first = preview_session_id(&state, &source).await;
        state
            .commit_at(
                CalImportCommitRequest { session_id: first },
                1_001,
                Instant::now(),
            )
            .await
            .unwrap();
        let second = preview_session_id(&state, &source).await;
        let response = state
            .commit_at(
                CalImportCommitRequest { session_id: second },
                1_002,
                Instant::now(),
            )
            .await
            .unwrap();
        let CalImportCommitResponse::Committed {
            imported_count,
            skipped_count,
            ..
        } = response;
        assert_eq!((imported_count, skipped_count), (0, 1));
        assert_eq!(
            state
                .store
                .current_restore_counts()
                .await
                .unwrap()
                .event_count,
            1
        );
    }

    #[tokio::test]
    async fn changed_source_after_preview_is_refused_and_consumed_before_recovery() {
        let (directory, source, state) = commit_fixture().await;
        let session_id = preview_session_id(&state, &source).await;
        sqlx::query(
            "UPDATE events SET title = 'changed' WHERE id = (SELECT id FROM events LIMIT 1)",
        )
        .execute(source.pool())
        .await
        .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(source.pool())
            .await
            .unwrap();
        assert!(matches!(
            state
                .commit_at(
                    CalImportCommitRequest {
                        session_id: session_id.clone()
                    },
                    1_001,
                    Instant::now(),
                )
                .await,
            Err(CalImportError::SourceChanged)
        ));
        assert!(!directory.path().join("backups").exists());
        assert!(matches!(
            state
                .commit_at(CalImportCommitRequest { session_id }, 1_002, Instant::now(),)
                .await,
            Err(CalImportError::SessionUnavailable)
        ));
    }

    #[tokio::test]
    async fn recovery_failure_prevents_destination_mutation() {
        let (directory, source, mut state) = commit_fixture().await;
        let blocked = directory.path().join("backups-is-file");
        fs::write(&blocked, b"blocked").unwrap();
        state.recovery_directory = blocked;
        let session_id = preview_session_id(&state, &source).await;
        assert!(matches!(
            state
                .commit_at(CalImportCommitRequest { session_id }, 1_001, Instant::now())
                .await,
            Err(CalImportError::RecoveryBackupFailed)
        ));
        assert_eq!(
            state
                .store
                .current_restore_counts()
                .await
                .unwrap()
                .event_count,
            0
        );
    }

    #[tokio::test]
    async fn transaction_failure_retains_zero_counts_after_creating_recovery() {
        let (directory, source, state) = commit_fixture().await;
        sqlx::query(
            "CREATE TRIGGER reject_cal_import BEFORE INSERT ON event_import_sources
             BEGIN SELECT RAISE(ABORT, 'controlled import failure'); END",
        )
        .execute(state.store.pool())
        .await
        .unwrap();
        let session_id = preview_session_id(&state, &source).await;
        assert!(matches!(
            state
                .commit_at(CalImportCommitRequest { session_id }, 1_001, Instant::now())
                .await,
            Err(CalImportError::Failed)
        ));
        assert_eq!(
            state
                .store
                .current_restore_counts()
                .await
                .unwrap()
                .event_count,
            0
        );
        assert_eq!(
            fs::read_dir(directory.path().join("backups"))
                .unwrap()
                .count(),
            1
        );
    }

    fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, contents) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(contents).unwrap();
        }
        zip.finish().unwrap();
    }

    fn write_duplicate_name_zip(path: &Path) {
        fn u16_le(target: &mut Vec<u8>, value: u16) {
            target.extend(value.to_le_bytes());
        }
        fn u32_le(target: &mut Vec<u8>, value: u32) {
            target.extend(value.to_le_bytes());
        }
        let name = b"manifest.json";
        let mut bytes = Vec::new();
        let mut offsets = Vec::new();
        for _ in 0..2 {
            offsets.push(bytes.len() as u32);
            u32_le(&mut bytes, 0x0403_4b50);
            u16_le(&mut bytes, 20);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u32_le(&mut bytes, 0);
            u32_le(&mut bytes, 0);
            u32_le(&mut bytes, 0);
            u16_le(&mut bytes, name.len() as u16);
            u16_le(&mut bytes, 0);
            bytes.extend(name);
        }
        let central_offset = bytes.len() as u32;
        for offset in offsets {
            u32_le(&mut bytes, 0x0201_4b50);
            u16_le(&mut bytes, 20);
            u16_le(&mut bytes, 20);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u32_le(&mut bytes, 0);
            u32_le(&mut bytes, 0);
            u32_le(&mut bytes, 0);
            u16_le(&mut bytes, name.len() as u16);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u16_le(&mut bytes, 0);
            u32_le(&mut bytes, 0);
            u32_le(&mut bytes, offset);
            bytes.extend(name);
        }
        let central_size = bytes.len() as u32 - central_offset;
        u32_le(&mut bytes, 0x0605_4b50);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 2);
        u16_le(&mut bytes, 2);
        u32_le(&mut bytes, central_size);
        u32_le(&mut bytes, central_offset);
        u16_le(&mut bytes, 0);
        fs::write(path, bytes).unwrap();
    }

    fn write_claimed_size_zip(path: &Path, claimed_size: u32) {
        fn u16_le(target: &mut Vec<u8>, value: u16) {
            target.extend(value.to_le_bytes());
        }
        fn u32_le(target: &mut Vec<u8>, value: u32) {
            target.extend(value.to_le_bytes());
        }

        let name = b"manifest.json";
        let mut bytes = Vec::new();
        u32_le(&mut bytes, 0x0403_4b50);
        u16_le(&mut bytes, 20);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u32_le(&mut bytes, 0);
        u32_le(&mut bytes, 0);
        u32_le(&mut bytes, claimed_size);
        u16_le(&mut bytes, name.len() as u16);
        u16_le(&mut bytes, 0);
        bytes.extend(name);

        let central_offset = bytes.len() as u32;
        u32_le(&mut bytes, 0x0201_4b50);
        u16_le(&mut bytes, 20);
        u16_le(&mut bytes, 20);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u32_le(&mut bytes, 0);
        u32_le(&mut bytes, 0);
        u32_le(&mut bytes, claimed_size);
        u16_le(&mut bytes, name.len() as u16);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u32_le(&mut bytes, 0);
        u32_le(&mut bytes, 0);
        bytes.extend(name);

        let central_size = bytes.len() as u32 - central_offset;
        u32_le(&mut bytes, 0x0605_4b50);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 0);
        u16_le(&mut bytes, 1);
        u16_le(&mut bytes, 1);
        u32_le(&mut bytes, central_size);
        u32_le(&mut bytes, central_offset);
        u16_le(&mut bytes, 0);
        fs::write(path, bytes).unwrap();
    }

    fn valid_manifest(entries: BTreeMap<String, Vec<u8>>) -> Vec<u8> {
        serde_json::to_vec(&manifest_for_entries(&entries, 1).unwrap()).unwrap()
    }

    fn note_data(is_dark_mode: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "folders": [],
            "pages": [],
            "blocks": [],
            "isDarkMode": is_dark_mode,
        }))
        .unwrap()
    }

    async fn write_unified_restore_archive(
        path: &Path,
        restored_note: Option<&[u8]>,
        restored_calendar: Option<&SqliteEventStore>,
    ) {
        let mut entries = BTreeMap::new();
        if let Some(note) = restored_note {
            entries.insert("note-data.json".to_owned(), note.to_vec());
        }
        if let Some(calendar) = restored_calendar {
            let snapshot = path.parent().unwrap().join(format!(
                "restore-calendar-source-{}.sqlite3",
                Uuid::new_v4()
            ));
            calendar.create_backup(&snapshot).await.unwrap();
            entries.insert("calendar.sqlite3".to_owned(), fs::read(&snapshot).unwrap());
            fs::remove_file(snapshot).unwrap();
        }
        let manifest = valid_manifest(entries.clone());
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(&manifest).unwrap();
        for (name, content) in entries {
            zip.start_file(name, options).unwrap();
            zip.write_all(&content).unwrap();
        }
        zip.finish().unwrap();
    }

    async fn preview_restore_session(state: &UnifiedBackupState, archive: &Path) -> String {
        let response = state
            .preview_restore_at(archive, 1_000, Instant::now())
            .await
            .unwrap();
        let UnifiedBackupRestorePreviewResponse::Previewed { session_id, .. } = response else {
            panic!("restore preview unexpectedly cancelled")
        };
        session_id
    }

    async fn recovery_intent_fixture(
        phase: UnifiedRestoreIntentPhase,
    ) -> (
        tempfile::TempDir,
        Arc<SqliteEventStore>,
        NotesService,
        String,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
                .await
                .unwrap(),
        );
        let source = SqliteEventStore::open(&directory.path().join("recovery-source.sqlite3"))
            .await
            .unwrap();
        seed_source_event(&source).await;
        let notes = NotesService::new(directory.path().to_owned());
        notes
            .restore_unified_backup_snapshot(&note_data(false))
            .unwrap();
        let recovery_directory = directory.path().join("unified-backups");
        fs::create_dir(&recovery_directory).unwrap();
        let recovery_name = "note-before-unified-restore-2000-test.zip".to_owned();
        write_unified_restore_archive(
            &recovery_directory.join(&recovery_name),
            Some(&note_data(true)),
            Some(&source),
        )
        .await;
        write_unified_restore_intent(
            directory.path(),
            &UnifiedRestoreIntent {
                version: 1,
                recovery_backup_file_name: recovery_name.clone(),
                phase,
            },
        )
        .unwrap();
        match phase {
            UnifiedRestoreIntentPhase::Prepared => {}
            UnifiedRestoreIntentPhase::NotePublished => {
                notes
                    .restore_unified_backup_snapshot(&note_data(true))
                    .unwrap();
            }
            UnifiedRestoreIntentPhase::CalendarPublished => {
                recover_unified_restore_intent_at(directory.path(), target.clone())
                    .await
                    .unwrap();
                // Simulate a crash after the second durable phase write: both
                // stores are already on the new values, while the valid
                // recovery artifact remains available for startup convergence.
                write_unified_restore_intent(
                    directory.path(),
                    &UnifiedRestoreIntent {
                        version: 1,
                        recovery_backup_file_name: recovery_name.clone(),
                        phase,
                    },
                )
                .unwrap();
            }
        }
        (directory, target, notes, recovery_name)
    }

    #[tokio::test]
    async fn durable_journal_recovery_converges_after_every_crash_phase() {
        for phase in [
            UnifiedRestoreIntentPhase::Prepared,
            UnifiedRestoreIntentPhase::NotePublished,
            UnifiedRestoreIntentPhase::CalendarPublished,
        ] {
            let (directory, target, notes, _) = recovery_intent_fixture(phase).await;
            assert!(unified_restore_intent_is_pending(directory.path()));
            recover_unified_restore_intent_at(directory.path(), target.clone())
                .await
                .unwrap();
            assert!(!unified_restore_intent_is_pending(directory.path()));
            let restored_note = notes.unified_backup_snapshot().unwrap().unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&restored_note).unwrap()["isDarkMode"],
                true
            );
            assert_eq!(
                target.current_restore_counts().await.unwrap().event_count,
                1
            );
        }
    }

    #[tokio::test]
    async fn journal_recovery_refuses_corrupt_or_missing_recovery_archives() {
        for contents in [Some(b"not a zip".as_slice()), None] {
            let directory = tempfile::tempdir().unwrap();
            let target = Arc::new(
                SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
                    .await
                    .unwrap(),
            );
            let recovery_directory = directory.path().join("unified-backups");
            fs::create_dir(&recovery_directory).unwrap();
            let recovery_name = "note-before-unified-restore-2000-test.zip";
            if let Some(contents) = contents {
                fs::write(recovery_directory.join(recovery_name), contents).unwrap();
            }
            write_unified_restore_intent(
                directory.path(),
                &UnifiedRestoreIntent {
                    version: 1,
                    recovery_backup_file_name: recovery_name.to_owned(),
                    phase: UnifiedRestoreIntentPhase::NotePublished,
                },
            )
            .unwrap();
            assert_eq!(
                recover_unified_restore_intent_at(directory.path(), target.clone()).await,
                Err(UnifiedBackupError::RecoveryRequired)
            );
            assert!(unified_restore_intent_is_pending(directory.path()));
            assert_eq!(
                target.current_restore_counts().await.unwrap().event_count,
                0
            );
        }
    }

    #[test]
    fn unified_backup_mutation_admission_is_note_then_calendar_and_releases_on_failure() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().to_owned());
        let held_note = state.note_mutations.begin().unwrap();
        assert_eq!(
            begin_unified_backup_mutations(&state).err().unwrap().code,
            "data_operation_in_progress"
        );
        assert!(state.calendar_mutations.begin().is_ok());
        drop(held_note);

        let held_calendar = state.calendar_mutations.begin().unwrap();
        assert_eq!(
            begin_unified_backup_mutations(&state).err().unwrap().code,
            "data_operation_in_progress"
        );
        assert!(state.note_mutations.begin().is_ok());
        drop(held_calendar);
        assert!(begin_unified_backup_mutations(&state).is_ok());
    }

    #[tokio::test]
    async fn post_intent_failure_blocks_live_mutations_until_verified_recovery_clears_guard() {
        let directory = tempfile::tempdir().unwrap();
        let app_state = AppState::new(directory.path().to_owned());
        app_state.start_calendar_initialization(None);
        let runtime = app_state.calendar_runtime().await.unwrap();
        let source = SqliteEventStore::open(&directory.path().join("source-calendar.sqlite3"))
            .await
            .unwrap();
        seed_source_event(&source).await;
        app_state
            .notes
            .restore_unified_backup_snapshot(&note_data(false))
            .unwrap();
        let archive = directory.path().join("restore.zip");
        let replacement_note = note_data(true);
        write_unified_restore_archive(&archive, Some(&replacement_note), Some(&source)).await;
        let session_id = preview_restore_session(&runtime.migration.unified, &archive).await;

        assert_eq!(
            runtime
                .migration
                .unified
                .commit_restore_at_with_hook(
                    &app_state.notes,
                    UnifiedBackupRestoreCommitRequest { session_id },
                    2_000,
                    Instant::now(),
                    |stage| match stage {
                        UnifiedRestoreStage::CalendarPublish => Err(UnifiedBackupError::Failed),
                        _ => Ok(()),
                    },
                )
                .await,
            Err(UnifiedBackupError::RecoveryRequired)
        );
        assert!(app_state
            .unified_restore_recovery_pending
            .load(Ordering::Acquire));
        assert!(unified_restore_intent_is_pending(directory.path()));
        assert_eq!(
            app_state.begin_note_mutation().err().unwrap().code,
            crate::error::NativeErrorCode::RecoveryRequired
        );
        assert_eq!(
            app_state.begin_calendar_mutation().err().unwrap().code,
            "unified_backup_recovery_required"
        );
        assert_eq!(
            app_state.calendar_runtime().await.err().unwrap().code,
            "unified_backup_recovery_required"
        );

        recover_unified_restore_intent(
            directory.path(),
            runtime.migration.unified.store.clone(),
            app_state.unified_restore_recovery_pending.clone(),
        )
        .await
        .unwrap();
        assert!(!app_state
            .unified_restore_recovery_pending
            .load(Ordering::Acquire));
        assert!(!unified_restore_intent_is_pending(directory.path()));
        assert!(app_state.begin_note_mutation().is_ok());
        assert!(app_state.begin_calendar_mutation().is_ok());
        assert!(app_state.calendar_runtime().await.is_ok());
    }

    #[tokio::test]
    async fn unified_restore_creates_verified_recovery_before_note_then_calendar_publish() {
        let directory = tempfile::tempdir().unwrap();
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("note-calendar.sqlite3"))
                .await
                .unwrap(),
        );
        let source = SqliteEventStore::open(&directory.path().join("source-calendar.sqlite3"))
            .await
            .unwrap();
        seed_source_event(&source).await;
        let notes = NotesService::new(directory.path().to_owned());
        notes
            .restore_unified_backup_snapshot(&note_data(false))
            .unwrap();
        let previous_note = notes.unified_backup_snapshot().unwrap().unwrap();
        let replacement_note = note_data(true);
        let archive = directory.path().join("restore.zip");
        write_unified_restore_archive(&archive, Some(&replacement_note), Some(&source)).await;
        let state = UnifiedBackupState::new(target.clone(), directory.path().to_owned());
        let session_id = preview_restore_session(&state, &archive).await;
        let recovery_directory = state.recovery_directory.clone();

        let response = state
            .commit_restore_at_with_hook(
                &notes,
                UnifiedBackupRestoreCommitRequest { session_id },
                2_000,
                Instant::now(),
                |stage| {
                    if matches!(stage, UnifiedRestoreStage::NotePublish) {
                        assert_eq!(
                            notes.unified_backup_snapshot().unwrap().unwrap(),
                            previous_note
                        );
                        let recovery = fs::read_dir(&recovery_directory)
                            .unwrap()
                            .next()
                            .unwrap()
                            .unwrap()
                            .path();
                        let recovery_entries = parse_unified_archive(&recovery).unwrap();
                        assert_eq!(recovery_entries.get("note-data.json"), Some(&previous_note));
                        assert!(recovery_entries.contains_key("calendar.sqlite3"));
                    }
                    Ok(())
                },
            )
            .await
            .unwrap();
        let UnifiedBackupRestoreCommitResponse::Restored {
            note_data_restored,
            calendar_restored,
            recovery_backup_file_name,
            ..
        } = response;
        assert!(note_data_restored && calendar_restored);
        assert!(recovery_directory.join(recovery_backup_file_name).is_file());
        assert_ne!(
            notes.unified_backup_snapshot().unwrap().unwrap(),
            previous_note
        );
        assert_eq!(
            target.current_restore_counts().await.unwrap().event_count,
            1
        );
    }

    #[tokio::test]
    async fn unified_restore_creates_missing_note_data_without_touching_absent_calendar() {
        let directory = tempfile::tempdir().unwrap();
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("note-calendar.sqlite3"))
                .await
                .unwrap(),
        );
        let notes = NotesService::new(directory.path().to_owned());
        let replacement_note = note_data(true);
        let archive = directory.path().join("note-only.zip");
        write_unified_restore_archive(&archive, Some(&replacement_note), None).await;
        let state = UnifiedBackupState::new(target.clone(), directory.path().to_owned());
        let session_id = preview_restore_session(&state, &archive).await;
        let response = state
            .commit_restore_at(
                &notes,
                UnifiedBackupRestoreCommitRequest { session_id },
                2_000,
                Instant::now(),
            )
            .await
            .unwrap();
        let UnifiedBackupRestoreCommitResponse::Restored {
            note_data_restored,
            calendar_restored,
            ..
        } = response;
        assert!(note_data_restored);
        assert!(!calendar_restored);
        assert!(notes.unified_backup_snapshot().unwrap().is_some());
        assert_eq!(
            target.current_restore_counts().await.unwrap().event_count,
            0
        );
    }

    #[tokio::test]
    async fn calendar_publish_failure_rolls_note_back_after_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("note-calendar.sqlite3"))
                .await
                .unwrap(),
        );
        let source = SqliteEventStore::open(&directory.path().join("source-calendar.sqlite3"))
            .await
            .unwrap();
        seed_source_event(&source).await;
        let notes = NotesService::new(directory.path().to_owned());
        notes
            .restore_unified_backup_snapshot(&note_data(false))
            .unwrap();
        let previous_note = notes.unified_backup_snapshot().unwrap().unwrap();
        let archive = directory.path().join("restore.zip");
        let replacement_note = note_data(true);
        write_unified_restore_archive(&archive, Some(&replacement_note), Some(&source)).await;
        let state = UnifiedBackupState::new(target.clone(), directory.path().to_owned());
        let session_id = preview_restore_session(&state, &archive).await;
        assert_eq!(
            state
                .commit_restore_at_with_hook(
                    &notes,
                    UnifiedBackupRestoreCommitRequest { session_id },
                    2_000,
                    Instant::now(),
                    |stage| match stage {
                        UnifiedRestoreStage::CalendarPublish => Err(UnifiedBackupError::Failed),
                        _ => Ok(()),
                    },
                )
                .await,
            Err(UnifiedBackupError::RecoveryRequired)
        );
        assert_eq!(
            notes.unified_backup_snapshot().unwrap().unwrap(),
            previous_note
        );
        assert_eq!(
            target.current_restore_counts().await.unwrap().event_count,
            0
        );
        assert_eq!(fs::read_dir(&state.recovery_directory).unwrap().count(), 1);
        assert!(unified_restore_intent_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn note_publish_failure_leaves_calendar_untouched_after_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("note-calendar.sqlite3"))
                .await
                .unwrap(),
        );
        let source = SqliteEventStore::open(&directory.path().join("source-calendar.sqlite3"))
            .await
            .unwrap();
        seed_source_event(&source).await;
        let notes = NotesService::new(directory.path().to_owned());
        notes
            .restore_unified_backup_snapshot(&note_data(false))
            .unwrap();
        let previous_note = notes.unified_backup_snapshot().unwrap().unwrap();
        let archive = directory.path().join("restore.zip");
        let replacement_note = note_data(true);
        write_unified_restore_archive(&archive, Some(&replacement_note), Some(&source)).await;
        let state = UnifiedBackupState::new(target.clone(), directory.path().to_owned());
        let session_id = preview_restore_session(&state, &archive).await;
        assert_eq!(
            state
                .commit_restore_at_with_hook(
                    &notes,
                    UnifiedBackupRestoreCommitRequest { session_id },
                    2_000,
                    Instant::now(),
                    |stage| match stage {
                        UnifiedRestoreStage::NotePublish => Err(UnifiedBackupError::Failed),
                        _ => Ok(()),
                    },
                )
                .await,
            Err(UnifiedBackupError::RecoveryRequired)
        );
        assert_eq!(
            notes.unified_backup_snapshot().unwrap().unwrap(),
            previous_note
        );
        assert_eq!(
            target.current_restore_counts().await.unwrap().event_count,
            0
        );
        assert_eq!(fs::read_dir(&state.recovery_directory).unwrap().count(), 1);
        assert!(unified_restore_intent_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn rollback_failure_returns_path_free_recovery_required_code() {
        let directory = tempfile::tempdir().unwrap();
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("note-calendar.sqlite3"))
                .await
                .unwrap(),
        );
        let source = SqliteEventStore::open(&directory.path().join("source-calendar.sqlite3"))
            .await
            .unwrap();
        seed_source_event(&source).await;
        let notes = NotesService::new(directory.path().to_owned());
        notes
            .restore_unified_backup_snapshot(&note_data(false))
            .unwrap();
        let previous_note = notes.unified_backup_snapshot().unwrap().unwrap();
        let archive = directory.path().join("restore.zip");
        let replacement_note = note_data(true);
        write_unified_restore_archive(&archive, Some(&replacement_note), Some(&source)).await;
        let state = UnifiedBackupState::new(target.clone(), directory.path().to_owned());
        let session_id = preview_restore_session(&state, &archive).await;
        assert_eq!(
            state
                .commit_restore_at_with_hook(
                    &notes,
                    UnifiedBackupRestoreCommitRequest { session_id },
                    2_000,
                    Instant::now(),
                    |stage| match stage {
                        UnifiedRestoreStage::CalendarPublish
                        | UnifiedRestoreStage::NoteRollback => Err(UnifiedBackupError::Failed),
                        _ => Ok(()),
                    },
                )
                .await,
            Err(UnifiedBackupError::RecoveryRequired)
        );
        let error: ApiError = UnifiedBackupError::RecoveryRequired.into();
        assert_eq!(error.code, "unified_backup_recovery_required");
        assert!(!error
            .message
            .contains(&directory.path().display().to_string()));
        assert_ne!(
            notes.unified_backup_snapshot().unwrap().unwrap(),
            previous_note
        );
        assert_eq!(
            target.current_restore_counts().await.unwrap().event_count,
            0
        );
        assert_eq!(fs::read_dir(&state.recovery_directory).unwrap().count(), 1);
    }

    #[test]
    fn archive_reader_rejects_zip_slip_duplicate_unexpected_and_checksum_failures() {
        let directory = tempfile::tempdir().unwrap();
        let traversal = directory.path().join("traversal.zip");
        write_test_zip(&traversal, &[("../manifest.json", b"{}")]);
        assert_eq!(
            parse_unified_archive(&traversal),
            Err(UnifiedBackupError::InvalidBackup)
        );

        let duplicate = directory.path().join("duplicate.zip");
        write_duplicate_name_zip(&duplicate);
        assert_eq!(
            parse_unified_archive(&duplicate),
            Err(UnifiedBackupError::InvalidBackup)
        );

        let unexpected = directory.path().join("unexpected.zip");
        write_test_zip(&unexpected, &[("credentials.json", b"{}")]);
        assert_eq!(
            parse_unified_archive(&unexpected),
            Err(UnifiedBackupError::InvalidBackup)
        );

        let note_data = br#"{"folders":[],"pages":[],"blocks":[]}"#.to_vec();
        let mut declared = BTreeMap::new();
        declared.insert("note-data.json".to_owned(), note_data.clone());
        let mut manifest: UnifiedManifest =
            serde_json::from_slice(&valid_manifest(declared)).unwrap();
        manifest.entries[0].sha256 = "00".repeat(32);
        let checksum = directory.path().join("checksum.zip");
        write_test_zip(
            &checksum,
            &[
                ("manifest.json", &serde_json::to_vec(&manifest).unwrap()),
                ("note-data.json", &note_data),
            ],
        );
        assert_eq!(
            parse_unified_archive(&checksum),
            Err(UnifiedBackupError::VerificationFailed)
        );
    }

    #[test]
    fn archive_reader_rejects_file_and_claimed_expansion_oversize() {
        let directory = tempfile::tempdir().unwrap();
        let oversized_file = directory.path().join("oversized-file.zip");
        let file = File::create(&oversized_file).unwrap();
        file.set_len(UNIFIED_MAX_ARCHIVE_BYTES + 1).unwrap();
        assert!(matches!(
            archive_source_identity(&oversized_file),
            Err(UnifiedBackupError::TooLarge)
        ));

        let claimed_expansion = directory.path().join("claimed-expansion.zip");
        write_claimed_size_zip(
            &claimed_expansion,
            u32::try_from(UNIFIED_MAX_ENTRY_BYTES + 1).unwrap(),
        );
        assert_eq!(
            parse_unified_archive(&claimed_expansion),
            Err(UnifiedBackupError::TooLarge)
        );
    }

    #[test]
    fn archive_reader_rejects_manifest_and_json_validation_failures() {
        let directory = tempfile::tempdir().unwrap();
        let valid_note_data = br#"{"folders":[],"pages":[],"blocks":[]}"#.to_vec();

        let missing_manifest = directory.path().join("missing-manifest.zip");
        write_test_zip(&missing_manifest, &[("note-data.json", &valid_note_data)]);
        assert_eq!(
            parse_unified_archive(&missing_manifest),
            Err(UnifiedBackupError::InvalidBackup)
        );

        let mut declared = BTreeMap::new();
        declared.insert("note-data.json".to_owned(), valid_note_data.clone());
        let mut unsupported_version: UnifiedManifest =
            serde_json::from_slice(&valid_manifest(declared)).unwrap();
        unsupported_version.version = 2;
        let unsupported_version_path = directory.path().join("unsupported-version.zip");
        let unsupported_version_bytes = serde_json::to_vec(&unsupported_version).unwrap();
        write_test_zip(
            &unsupported_version_path,
            &[
                ("manifest.json", &unsupported_version_bytes),
                ("note-data.json", &valid_note_data),
            ],
        );
        assert_eq!(
            parse_unified_archive(&unsupported_version_path),
            Err(UnifiedBackupError::InvalidBackup)
        );

        let mut declared = BTreeMap::new();
        declared.insert("note-data.json".to_owned(), valid_note_data.clone());
        let mut wrong_marker: UnifiedManifest =
            serde_json::from_slice(&valid_manifest(declared)).unwrap();
        wrong_marker.consistency_marker = "00".repeat(32);
        let wrong_marker_path = directory.path().join("wrong-marker.zip");
        let wrong_marker_bytes = serde_json::to_vec(&wrong_marker).unwrap();
        write_test_zip(
            &wrong_marker_path,
            &[
                ("manifest.json", &wrong_marker_bytes),
                ("note-data.json", &valid_note_data),
            ],
        );
        assert_eq!(
            parse_unified_archive(&wrong_marker_path),
            Err(UnifiedBackupError::VerificationFailed)
        );

        let invalid_note_data = b"not-json".to_vec();
        let mut declared = BTreeMap::new();
        declared.insert("note-data.json".to_owned(), invalid_note_data.clone());
        let invalid_note_path = directory.path().join("invalid-note.json.zip");
        let invalid_note_manifest = valid_manifest(declared);
        write_test_zip(
            &invalid_note_path,
            &[
                ("manifest.json", &invalid_note_manifest),
                ("note-data.json", &invalid_note_data),
            ],
        );
        assert_eq!(
            parse_unified_archive(&invalid_note_path),
            Err(UnifiedBackupError::InvalidBackup)
        );

        let invalid_widget_state = b"not-json".to_vec();
        let mut declared = BTreeMap::new();
        declared.insert("widget-state.json".to_owned(), invalid_widget_state.clone());
        let invalid_widget_path = directory.path().join("invalid-widget.json.zip");
        let invalid_widget_manifest = valid_manifest(declared);
        write_test_zip(
            &invalid_widget_path,
            &[
                ("manifest.json", &invalid_widget_manifest),
                ("widget-state.json", &invalid_widget_state),
            ],
        );
        assert_eq!(
            parse_unified_archive(&invalid_widget_path),
            Err(UnifiedBackupError::InvalidBackup)
        );
    }

    #[tokio::test]
    async fn created_archive_excludes_credentials_and_unallowlisted_app_files() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("models-ai-credentials.v1.json"),
            br#"{"secret":"must-not-archive"}"#,
        )
        .unwrap();
        fs::write(directory.path().join("recording.wav"), b"must-not-archive").unwrap();
        let store = Arc::new(
            SqliteEventStore::open(&directory.path().join("calendar.sqlite3"))
                .await
                .unwrap(),
        );
        let state = UnifiedBackupState::new(store, directory.path().to_owned());
        let notes = NotesService::new(directory.path().to_owned());
        let archive = directory.path().join("backup.zip");
        create_unified_archive(&state, &notes, &archive, 1)
            .await
            .unwrap();
        let mut zip = ZipArchive::new(File::open(&archive).unwrap()).unwrap();
        let names = (0..zip.len())
            .map(|index| zip.by_index(index).unwrap().name().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["manifest.json", "calendar.sqlite3"]);
        assert!(!fs::read(&archive)
            .unwrap()
            .windows(18)
            .any(|window| window == b"must-not-archive"));
    }

    #[tokio::test]
    async fn archive_preview_rejects_invalid_calendar_sqlite_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("invalid-calendar.zip");
        let calendar = b"not a sqlite database".to_vec();
        let mut declared = BTreeMap::new();
        declared.insert("calendar.sqlite3".to_owned(), calendar.clone());
        let manifest = valid_manifest(declared);
        write_test_zip(
            &archive,
            &[
                ("manifest.json", &manifest),
                ("calendar.sqlite3", &calendar),
            ],
        );
        let store = Arc::new(
            SqliteEventStore::open(&directory.path().join("note.sqlite3"))
                .await
                .unwrap(),
        );
        let state = UnifiedBackupState::new(store, directory.path().to_owned());
        assert_eq!(
            state.preview_restore_at(&archive, 1, Instant::now()).await,
            Err(UnifiedBackupError::VerificationFailed)
        );
        assert!(state.restore_session.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn restore_preview_hides_paths_and_session_is_one_use_expiring_and_identity_bound() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("restore-source.zip");
        let note_data = br#"{"folders":[],"pages":[],"blocks":[]}"#.to_vec();
        let mut declared = BTreeMap::new();
        declared.insert("note-data.json".to_owned(), note_data.clone());
        let manifest = valid_manifest(declared);
        write_test_zip(
            &archive,
            &[("manifest.json", &manifest), ("note-data.json", &note_data)],
        );
        let store = Arc::new(
            SqliteEventStore::open(&directory.path().join("note.sqlite3"))
                .await
                .unwrap(),
        );
        let state = UnifiedBackupState::new(store, directory.path().to_owned());
        let now = Instant::now();
        let response = state.preview_restore_at(&archive, 1, now).await.unwrap();
        let UnifiedBackupRestorePreviewResponse::Previewed {
            session_id,
            file_name,
            ..
        } = &response
        else {
            panic!("restore preview unexpectedly cancelled")
        };
        assert_eq!(file_name, "restore-source.zip");
        let serialized = serde_json::to_string(&response).unwrap();
        let canonical = archive.canonicalize().unwrap().display().to_string();
        assert!(!serialized.contains(&canonical));
        assert!(!serialized.contains(&canonical.replace('\\', "\\\\")));
        let staged = state
            .consume_restore_session_at(session_id, Instant::now())
            .unwrap();
        assert!(staged.staged_entries.contains_key("note-data.json"));
        assert!(matches!(
            state.consume_restore_session_at(session_id, Instant::now()),
            Err(UnifiedBackupError::SessionUnavailable)
        ));

        let response = state
            .preview_restore_at(&archive, 2, Instant::now())
            .await
            .unwrap();
        let UnifiedBackupRestorePreviewResponse::Previewed { session_id, .. } = response else {
            panic!("restore preview unexpectedly cancelled")
        };
        fs::write(&archive, b"archive was replaced after preview").unwrap();
        assert!(matches!(
            state.consume_restore_session_at(&session_id, Instant::now()),
            Err(UnifiedBackupError::SessionUnavailable)
        ));
        assert!(state.restore_session.lock().unwrap().is_none());

        write_test_zip(
            &archive,
            &[("manifest.json", &manifest), ("note-data.json", &note_data)],
        );
        let response = state
            .preview_restore_at(&archive, 3, Instant::now())
            .await
            .unwrap();
        let UnifiedBackupRestorePreviewResponse::Previewed { session_id, .. } = response else {
            panic!("restore preview unexpectedly cancelled")
        };
        assert!(matches!(
            state.consume_restore_session_at(
                &session_id,
                Instant::now() + Duration::from_millis(UNIFIED_RESTORE_SESSION_TTL_MS as u64),
            ),
            Err(UnifiedBackupError::SessionUnavailable)
        ));
        assert!(state.restore_session.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn preview_counts_existing_destination_provenance() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("cal.sqlite3");
        let source = SqliteEventStore::open(&source_path).await.unwrap();
        seed_source_event(&source).await;
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("note.sqlite3"))
                .await
                .unwrap(),
        );
        let (_, candidates) = inspect_cal_source(&source_path).await.unwrap();
        target
            .commit_import(
                &[candidates[0].staged()],
                ImportDuplicatePolicy::SkipExisting,
                CAL_IMPORT_PARSER_VERSION,
                1,
            )
            .await
            .unwrap();
        let state = CalImportState {
            store: target,
            recovery_directory: directory.path().join("backups"),
            session: Mutex::new(None),
        };
        let preview = state
            .preview_at(&source_path, 1, Instant::now())
            .await
            .unwrap();
        let CalImportPreviewResponse::Previewed { existing_count, .. } = preview else {
            panic!("preview unexpectedly cancelled")
        };
        assert_eq!(existing_count, 1);
    }

    #[tokio::test]
    async fn unsupported_source_is_rejected_before_staging_a_session() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("cal.sqlite3");
        let source = SqliteEventStore::open(&source_path).await.unwrap();
        let event_id = seed_source_event(&source).await;
        sqlx::query(
            "INSERT INTO reminders (id, event_id, lead_minutes, created_at, updated_at)
             VALUES (?, ?, 10, 1, 1)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(event_id)
        .execute(source.pool())
        .await
        .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(source.pool())
            .await
            .unwrap();
        let target = Arc::new(
            SqliteEventStore::open(&directory.path().join("note.sqlite3"))
                .await
                .unwrap(),
        );
        let state = CalImportState {
            store: target,
            recovery_directory: directory.path().join("backups"),
            session: Mutex::new(None),
        };
        assert!(matches!(
            state.preview_at(&source_path, 1, Instant::now()).await,
            Err(CalImportError::UnsupportedSource)
        ));
        assert!(state.session.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn session_is_expiring_and_one_use_before_any_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(
            SqliteEventStore::open(&directory.path().join("note.sqlite3"))
                .await
                .unwrap(),
        );
        let state = CalImportState {
            store,
            recovery_directory: directory.path().join("backups"),
            session: Mutex::new(None),
        };
        let source = directory.path().join("cal.sqlite3");
        fs::write(&source, b"session").unwrap();
        let (canonical_path, handle, fingerprint) = source_identity(&source).unwrap();
        let id = Uuid::new_v4();
        *state.session.lock().unwrap() = Some(CalImportSession {
            id,
            source: CalSourceIdentity {
                canonical_path,
                handle,
                fingerprint,
                event_count: 0,
            },
            candidates: Vec::new(),
            expires_at: Instant::now() + Duration::from_secs(1),
        });
        assert!(state
            .consume_for_commit(&id.to_string(), Instant::now())
            .is_ok());
        assert!(matches!(
            state.consume_for_commit(&id.to_string(), Instant::now()),
            Err(CalImportError::SessionUnavailable)
        ));
        let expired = Uuid::new_v4();
        *state.session.lock().unwrap() = Some(CalImportSession {
            id: expired,
            source: CalSourceIdentity {
                canonical_path: source.clone(),
                handle: same_file::Handle::from_path(&source).unwrap(),
                fingerprint: sha256_file(&source, fs::metadata(&source).unwrap().len()).unwrap(),
                event_count: 0,
            },
            candidates: Vec::new(),
            expires_at: Instant::now() - Duration::from_secs(1),
        });
        assert!(matches!(
            state.consume_for_commit(&expired.to_string(), Instant::now()),
            Err(CalImportError::SessionUnavailable)
        ));
    }
}
