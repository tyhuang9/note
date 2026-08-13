use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{app_state::AppState, calendar_store::sqlite::SqliteEventStore};

use super::{api::ensure_main_window, error::ApiError};

const MAX_RESTORE_BYTES: u64 = 512 * 1024 * 1024;
const RESTORE_SESSION_TTL_MS: i64 = 15 * 60 * 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupError {
    InProgress,
    DestinationExists,
    VerificationFailed,
    Failed,
}

impl From<BackupError> for ApiError {
    fn from(error: BackupError) -> Self {
        match error {
            BackupError::InProgress => Self {
                code: "backup_in_progress",
                message: "A calendar backup is already in progress.",
                field: None,
            },
            BackupError::DestinationExists => Self {
                code: "backup_destination_exists",
                message: "Choose a new file name for this backup.",
                field: None,
            },
            BackupError::VerificationFailed => Self {
                code: "backup_verification_failed",
                message: "The backup could not be verified and was not saved.",
                field: None,
            },
            BackupError::Failed => Self {
                code: "backup_failed",
                message: "The calendar backup could not be created.",
                field: None,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackupArtifact {
    pub byte_size: u64,
}

#[async_trait]
pub trait BackupRepository: Send + Sync {
    async fn create_backup(&self, destination: &Path) -> Result<BackupArtifact, BackupError>;
}

#[derive(Clone)]
pub struct BackupService {
    repository: Arc<dyn BackupRepository>,
}

impl BackupService {
    pub fn new(repository: Arc<dyn BackupRepository>) -> Self {
        Self { repository }
    }

    async fn create(&self, destination: &Path) -> Result<BackupResponse, BackupError> {
        let artifact = self.repository.create_backup(destination).await?;
        created_response(destination, artifact, Utc::now().timestamp_millis())
    }
}

#[derive(Default)]
struct BackupOperationLock {
    active: AtomicBool,
}

impl BackupOperationLock {
    fn try_begin(&self) -> Result<BackupOperationGuard<'_>, BackupError> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| BackupError::InProgress)?;
        Ok(BackupOperationGuard { operation: self })
    }

    fn try_begin_restore(&self) -> Result<BackupOperationGuard<'_>, RestoreError> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| RestoreError::InProgress)?;
        Ok(BackupOperationGuard { operation: self })
    }
}

struct BackupOperationGuard<'a> {
    operation: &'a BackupOperationLock,
}

impl Drop for BackupOperationGuard<'_> {
    fn drop(&mut self) {
        self.operation.active.store(false, Ordering::Release);
    }
}

pub struct BackupState {
    service: BackupService,
    restore: RestoreService,
    operation: BackupOperationLock,
}

impl BackupState {
    pub fn new(service: BackupService, restore: RestoreService) -> Self {
        Self {
            service,
            restore,
            operation: BackupOperationLock::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreError {
    InProgress,
    ReadFailed,
    TooLarge,
    InvalidBackup,
    IncompatibleBackup,
    VerificationFailed,
    SessionUnavailable,
    RecoveryBackupFailed,
    Failed,
}

impl From<RestoreError> for ApiError {
    fn from(error: RestoreError) -> Self {
        let (code, message) = match error {
            RestoreError::InProgress => (
                "restore_in_progress",
                "A calendar restore is already in progress.",
            ),
            RestoreError::ReadFailed => (
                "restore_read_failed",
                "The selected calendar backup could not be read.",
            ),
            RestoreError::TooLarge => (
                "restore_too_large",
                "The selected calendar backup is too large to restore.",
            ),
            RestoreError::InvalidBackup => (
                "restore_invalid_backup",
                "The selected file is not a valid calendar backup.",
            ),
            RestoreError::IncompatibleBackup => (
                "restore_incompatible_backup",
                "The selected backup is not compatible with this version of Note.",
            ),
            RestoreError::VerificationFailed => (
                "restore_verification_failed",
                "The selected calendar backup failed integrity verification.",
            ),
            RestoreError::SessionUnavailable => (
                "restore_session_unavailable",
                "This restore preview is no longer available. Choose the backup again.",
            ),
            RestoreError::RecoveryBackupFailed => (
                "restore_recovery_backup_failed",
                "Note could not create the required recovery backup. Nothing was restored.",
            ),
            RestoreError::Failed => (
                "restore_failed",
                "The calendar backup could not be restored. Your current data was kept.",
            ),
        };
        Self {
            code,
            message,
            field: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBackupCounts {
    pub(crate) calendar_count: i64,
    pub(crate) event_count: i64,
    pub(crate) timed_event_count: i64,
    pub(crate) all_day_event_count: i64,
    pub(crate) recurring_event_count: i64,
    pub(crate) reminder_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCurrentCounts {
    pub(crate) calendar_count: i64,
    pub(crate) event_count: i64,
    pub(crate) reminder_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSettingsSnapshot {
    pub(crate) default_event_duration_minutes: i64,
    pub(crate) default_reminder_minutes: Option<i64>,
    pub(crate) week_starts_on: String,
    pub(crate) time_format: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RestoreInspection {
    pub(crate) schema_version: i64,
    pub(crate) backup: RestoreBackupCounts,
    pub(crate) settings: RestoreSettingsSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RestorePreviewResponse {
    Cancelled,
    Previewed {
        session_id: String,
        file_name: String,
        byte_size: u64,
        expires_at_utc_ms: i64,
        schema_version: i64,
        backup: RestoreBackupCounts,
        current: RestoreCurrentCounts,
        settings: Box<RestoreSettingsSnapshot>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreCommitRequest {
    session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RestoreCommitResponse {
    Restored {
        calendar_count: i64,
        event_count: i64,
        reminder_count: i64,
        recovery_backup_file_name: String,
        restored_at_utc_ms: i64,
    },
}

struct RestoreSession {
    id: Uuid,
    staged_path: PathBuf,
    expires_at_utc_ms: i64,
    inspection: RestoreInspection,
}

impl Drop for RestoreSession {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.staged_path);
    }
}

pub struct RestoreService {
    store: Arc<SqliteEventStore>,
    staging_directory: PathBuf,
    backup_directory: PathBuf,
    session: Mutex<Option<RestoreSession>>,
}

impl RestoreService {
    pub fn new(
        store: Arc<SqliteEventStore>,
        staging_directory: PathBuf,
        backup_directory: PathBuf,
    ) -> Self {
        cleanup_stale_restore_stages(&staging_directory);
        Self {
            store,
            staging_directory,
            backup_directory,
            session: Mutex::new(None),
        }
    }

    async fn preview(&self, source: &Path) -> Result<RestorePreviewResponse, RestoreError> {
        self.preview_at(source, Utc::now().timestamp_millis()).await
    }

    async fn cancel(&self) {
        self.session.lock().await.take();
    }

    async fn preview_at(
        &self,
        source: &Path,
        now_utc_ms: i64,
    ) -> Result<RestorePreviewResponse, RestoreError> {
        prepare_private_directory(&self.staging_directory)?;
        let id = Uuid::new_v4();
        let staged_path = self.staging_directory.join(format!("restore-{id}.sqlite3"));
        let file_name = safe_file_name(source)?;
        // Read the live summary before publishing a stage so a live-store failure cannot
        // leave an unowned staged file behind.
        let current = self.store.current_restore_counts().await?;
        let (byte_size, inspection) = self
            .store
            .stage_restore_snapshot(source, &staged_path, MAX_RESTORE_BYTES)
            .await?;
        let expires_at_utc_ms = now_utc_ms.saturating_add(RESTORE_SESSION_TTL_MS);

        let response = RestorePreviewResponse::Previewed {
            session_id: id.to_string(),
            file_name,
            byte_size,
            expires_at_utc_ms,
            schema_version: inspection.schema_version,
            backup: inspection.backup.clone(),
            current,
            settings: Box::new(inspection.settings.clone()),
        };
        let replacement = RestoreSession {
            id,
            staged_path,
            expires_at_utc_ms,
            inspection,
        };
        *self.session.lock().await = Some(replacement);
        Ok(response)
    }

    async fn commit(
        &self,
        request: RestoreCommitRequest,
    ) -> Result<RestoreCommitResponse, RestoreError> {
        self.commit_at(request, Utc::now().timestamp_millis()).await
    }

    async fn commit_at(
        &self,
        request: RestoreCommitRequest,
        now_utc_ms: i64,
    ) -> Result<RestoreCommitResponse, RestoreError> {
        let requested_id =
            Uuid::parse_str(&request.session_id).map_err(|_| RestoreError::SessionUnavailable)?;
        let mut session = self.session.lock().await;
        if session
            .as_ref()
            .is_some_and(|candidate| candidate.expires_at_utc_ms <= now_utc_ms)
        {
            session.take();
            return Err(RestoreError::SessionUnavailable);
        }
        let staged = session
            .as_ref()
            .filter(|candidate| candidate.id == requested_id)
            .ok_or(RestoreError::SessionUnavailable)?;

        prepare_private_directory(&self.backup_directory)
            .map_err(|_| RestoreError::RecoveryBackupFailed)?;
        let recovery_file_name = format!(
            "note-calendar-before-restore-{}-{}.sqlite3",
            Utc::now().format("%Y%m%dT%H%M%SZ"),
            Uuid::new_v4()
        );
        let recovery_path = self.backup_directory.join(&recovery_file_name);
        let counts = self
            .store
            .restore_from_snapshot(&staged.staged_path, &recovery_path, &staged.inspection)
            .await?;

        session.take();
        Ok(RestoreCommitResponse::Restored {
            calendar_count: counts.calendar_count,
            event_count: counts.event_count,
            reminder_count: counts.reminder_count,
            recovery_backup_file_name: recovery_file_name,
            restored_at_utc_ms: now_utc_ms,
        })
    }
}

fn safe_file_name(path: &Path) -> Result<String, RestoreError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .ok_or(RestoreError::ReadFailed)
}

fn prepare_private_directory(path: &Path) -> Result<(), RestoreError> {
    fs::create_dir_all(path).map_err(|_| RestoreError::Failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| RestoreError::Failed)?;
    }
    Ok(())
}

fn cleanup_stale_restore_stages(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let owned_stage = (name.starts_with("restore-")
            || name.starts_with(".note-calendar-restore-"))
            && name.ends_with(".sqlite3");
        if owned_stage && entry.file_type().is_ok_and(|file_type| file_type.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BackupResponse {
    Cancelled,
    Created {
        file_name: String,
        byte_size: u64,
        created_at_utc_ms: i64,
    },
}

fn default_backup_file_name() -> String {
    format!(
        "note-calendar-backup-{}.sqlite3",
        Utc::now().format("%Y%m%dT%H%M%SZ")
    )
}

fn created_response(
    destination: &Path,
    artifact: BackupArtifact,
    created_at_utc_ms: i64,
) -> Result<BackupResponse, BackupError> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or(BackupError::Failed)?
        .to_owned();

    Ok(BackupResponse::Created {
        file_name,
        byte_size: artifact.byte_size,
        created_at_utc_ms,
    })
}

fn selected_path(
    selection: Option<tauri_plugin_dialog::FilePath>,
) -> Result<Option<PathBuf>, BackupError> {
    selection
        .map(|path| path.into_path().map_err(|_| BackupError::Failed))
        .transpose()
}

#[tauri::command]
pub async fn backup_create(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
) -> Result<BackupResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let state = &runtime.backup;
    let _operation = state.operation.try_begin()?;

    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save calendar backup")
        .set_file_name(default_backup_file_name())
        .add_filter("SQLite database", &["sqlite3"])
        .blocking_save_file();
    let Some(destination) = selected_path(selection)? else {
        return Ok(BackupResponse::Cancelled);
    };

    state.service.create(&destination).await.map_err(Into::into)
}

fn selected_restore_path(
    selection: Option<tauri_plugin_dialog::FilePath>,
) -> Result<Option<PathBuf>, RestoreError> {
    selection
        .map(|path| path.into_path().map_err(|_| RestoreError::ReadFailed))
        .transpose()
}

#[tauri::command]
pub async fn backup_restore_preview(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
) -> Result<RestorePreviewResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let state = &runtime.backup;
    let _operation = state.operation.try_begin_restore()?;
    state.restore.cancel().await;
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose calendar backup to restore")
        .add_filter("SQLite database", &["sqlite", "sqlite3", "db"])
        .blocking_pick_file();
    let Some(source) = selected_restore_path(selection)? else {
        return Ok(RestorePreviewResponse::Cancelled);
    };
    state.restore.preview(&source).await.map_err(Into::into)
}

#[tauri::command]
pub async fn backup_restore_commit(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
    request: RestoreCommitRequest,
) -> Result<RestoreCommitResponse, ApiError> {
    ensure_main_window(&window)?;
    let runtime = app_state.calendar_runtime().await?;
    let _mutation = app_state.begin_calendar_mutation()?;
    let state = &runtime.backup;
    let _operation = state.operation.try_begin_restore()?;
    let restored = state
        .restore
        .commit(request)
        .await
        .map_err(ApiError::from)?;
    #[cfg(desktop)]
    super::reminders::trigger_reminder_rebuild(&window);
    super::api::emit_calendar_changed(&window);
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn response_serde_is_discriminated_and_never_contains_a_path() {
        assert_eq!(selected_path(None).unwrap(), None);
        let cancelled = serde_json::to_value(BackupResponse::Cancelled).unwrap();
        assert_eq!(cancelled, json!({ "status": "cancelled" }));

        let created = created_response(
            Path::new("/private/calendar/backups/note-calendar-backup.sqlite3"),
            BackupArtifact { byte_size: 4096 },
            1_784_352_600_000,
        )
        .unwrap();
        let serialized = serde_json::to_value(created).unwrap();
        assert_eq!(
            serialized,
            json!({
                "status": "created",
                "fileName": "note-calendar-backup.sqlite3",
                "byteSize": 4096,
                "createdAtUtcMs": 1_784_352_600_000_i64
            })
        );
        assert!(!serialized.to_string().contains("/private/calendar"));
    }

    #[test]
    fn backup_errors_are_stable_safe_envelopes_without_paths() {
        for (error, expected_code) in [
            (BackupError::InProgress, "backup_in_progress"),
            (BackupError::DestinationExists, "backup_destination_exists"),
            (
                BackupError::VerificationFailed,
                "backup_verification_failed",
            ),
            (BackupError::Failed, "backup_failed"),
        ] {
            let api_error = ApiError::from(error);
            let serialized = serde_json::to_string(&api_error).unwrap();
            assert_eq!(api_error.code, expected_code);
            assert!(!serialized.contains('/') && !serialized.contains('\\'));
        }
    }

    #[test]
    fn operation_guard_is_exclusive_and_releases_on_every_drop() {
        let operation = BackupOperationLock::default();
        let first = operation.try_begin().unwrap();
        assert_eq!(operation.try_begin().err(), Some(BackupError::InProgress));
        assert_eq!(
            operation.try_begin_restore().err(),
            Some(RestoreError::InProgress)
        );
        drop(first);
        assert!(operation.try_begin().is_ok());
    }

    #[test]
    fn default_file_name_is_utc_and_sqlite_filtered() {
        let name = default_backup_file_name();
        assert!(name.starts_with("note-calendar-backup-"));
        assert!(name.ends_with("Z.sqlite3"));
        assert_eq!(
            name.len(),
            "note-calendar-backup-YYYYMMDDTHHMMSSZ.sqlite3".len()
        );
    }

    #[test]
    fn restore_errors_and_requests_are_path_free_and_strict() {
        for (error, code) in [
            (RestoreError::InProgress, "restore_in_progress"),
            (RestoreError::ReadFailed, "restore_read_failed"),
            (RestoreError::TooLarge, "restore_too_large"),
            (RestoreError::InvalidBackup, "restore_invalid_backup"),
            (
                RestoreError::IncompatibleBackup,
                "restore_incompatible_backup",
            ),
            (
                RestoreError::VerificationFailed,
                "restore_verification_failed",
            ),
            (
                RestoreError::SessionUnavailable,
                "restore_session_unavailable",
            ),
            (
                RestoreError::RecoveryBackupFailed,
                "restore_recovery_backup_failed",
            ),
            (RestoreError::Failed, "restore_failed"),
        ] {
            let api = ApiError::from(error);
            assert_eq!(api.code, code);
            let serialized = serde_json::to_string(&api).unwrap();
            assert!(!serialized.contains('/') && !serialized.contains('\\'));
        }

        assert!(serde_json::from_value::<RestoreCommitRequest>(json!({
            "sessionId": Uuid::nil().to_string(),
            "path": "/private/backup.sqlite3"
        }))
        .is_err());
        assert_eq!(selected_restore_path(None).unwrap(), None);
    }

    async fn restore_service_fixture(
        directory: &Path,
    ) -> (RestoreService, PathBuf, Arc<SqliteEventStore>) {
        let source_path = directory.join("source.sqlite3");
        let live_path = directory.join("live.sqlite3");
        let source = SqliteEventStore::open(&source_path).await.unwrap();
        let live = Arc::new(SqliteEventStore::open(&live_path).await.unwrap());
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_date, end_date_exclusive,
                status, revision, created_at, updated_at
             ) VALUES (?, '00000000-0000-4000-8000-000000000001', 'Restore me',
                       'all_day', '2026-08-01', '2026-08-02', 'confirmed', 1, 1, 1)",
        )
        .bind(Uuid::new_v4().to_string())
        .execute(source.pool())
        .await
        .unwrap();
        let service = RestoreService::new(
            live.clone(),
            directory.join("restore-staging"),
            directory.join("backups"),
        );
        (service, source_path, live)
    }

    #[tokio::test]
    async fn restore_session_expires_cleans_replays_and_rejects_mismatch() {
        let directory = tempfile::tempdir().unwrap();
        let (service, source_path, _) = restore_service_fixture(directory.path()).await;
        let response = service.preview_at(&source_path, 100).await.unwrap();
        let RestorePreviewResponse::Previewed { session_id, .. } = response else {
            panic!("expected preview")
        };
        let staged_path = service
            .session
            .lock()
            .await
            .as_ref()
            .unwrap()
            .staged_path
            .clone();
        assert!(staged_path.exists());

        let mismatch = service
            .commit_at(
                RestoreCommitRequest {
                    session_id: Uuid::new_v4().to_string(),
                },
                101,
            )
            .await;
        assert_eq!(mismatch, Err(RestoreError::SessionUnavailable));
        assert!(staged_path.exists());

        let expired = service
            .commit_at(
                RestoreCommitRequest {
                    session_id: session_id.clone(),
                },
                100 + RESTORE_SESSION_TTL_MS,
            )
            .await;
        assert_eq!(expired, Err(RestoreError::SessionUnavailable));
        assert!(service.session.lock().await.is_none());
        assert!(!staged_path.exists());

        let response = service.preview_at(&source_path, 1_000).await.unwrap();
        let RestorePreviewResponse::Previewed { session_id, .. } = response else {
            panic!("expected preview")
        };
        let restored = service
            .commit_at(
                RestoreCommitRequest {
                    session_id: session_id.clone(),
                },
                1_001,
            )
            .await;
        assert!(matches!(
            restored,
            Ok(RestoreCommitResponse::Restored { .. })
        ));
        assert_eq!(
            service
                .commit_at(RestoreCommitRequest { session_id }, 1_002)
                .await,
            Err(RestoreError::SessionUnavailable)
        );
    }

    #[tokio::test]
    async fn failed_restore_retains_session_for_retry_and_replacement_cleans_old_stage() {
        let directory = tempfile::tempdir().unwrap();
        let (mut service, source_path, _) = restore_service_fixture(directory.path()).await;
        let response = service.preview_at(&source_path, 100).await.unwrap();
        let RestorePreviewResponse::Previewed { session_id, .. } = response else {
            panic!("expected preview")
        };
        let first_stage = service
            .session
            .lock()
            .await
            .as_ref()
            .unwrap()
            .staged_path
            .clone();

        let blocked_backup_path = directory.path().join("backup-path-is-file");
        std::fs::write(&blocked_backup_path, b"blocked").unwrap();
        service.backup_directory = blocked_backup_path;
        assert_eq!(
            service
                .commit_at(
                    RestoreCommitRequest {
                        session_id: session_id.clone(),
                    },
                    101,
                )
                .await,
            Err(RestoreError::RecoveryBackupFailed)
        );
        assert!(service.session.lock().await.is_some());
        assert!(first_stage.exists());

        let replacement = service.preview_at(&source_path, 102).await.unwrap();
        assert!(matches!(
            replacement,
            RestorePreviewResponse::Previewed { .. }
        ));
        assert!(!first_stage.exists());
        let replacement_stage = service
            .session
            .lock()
            .await
            .as_ref()
            .unwrap()
            .staged_path
            .clone();
        service.cancel().await;
        assert!(service.session.lock().await.is_none());
        assert!(!replacement_stage.exists());
    }

    #[tokio::test]
    async fn startup_removes_only_app_owned_stale_restore_stages() {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join("restore-staging");
        fs::create_dir_all(&staging).unwrap();
        let published = staging.join("restore-stale.sqlite3");
        let temporary = staging.join(".note-calendar-restore-stale.sqlite3");
        let unrelated = staging.join("keep.txt");
        fs::write(&published, b"stale").unwrap();
        fs::write(&temporary, b"stale").unwrap();
        fs::write(&unrelated, b"keep").unwrap();
        let live = Arc::new(
            SqliteEventStore::open(&directory.path().join("live.sqlite3"))
                .await
                .unwrap(),
        );

        let _service = RestoreService::new(live, staging, directory.path().join("backups"));

        assert!(!published.exists());
        assert!(!temporary.exists());
        assert!(unrelated.exists());
    }

    #[tokio::test]
    async fn live_count_failure_does_not_publish_an_unowned_stage() {
        let directory = tempfile::tempdir().unwrap();
        let (service, source_path, live) = restore_service_fixture(directory.path()).await;
        live.pool().close().await;
        assert_eq!(
            service.preview_at(&source_path, 100).await,
            Err(RestoreError::Failed)
        );
        let staged_files = std::fs::read_dir(directory.path().join("restore-staging"))
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(staged_files, 0);
    }

    #[test]
    fn restore_preview_response_never_serializes_a_source_path() {
        let response = RestorePreviewResponse::Previewed {
            session_id: Uuid::nil().to_string(),
            file_name: "backup.sqlite3".into(),
            byte_size: 4096,
            expires_at_utc_ms: 100,
            schema_version: 7,
            backup: RestoreBackupCounts {
                calendar_count: 1,
                event_count: 2,
                timed_event_count: 1,
                all_day_event_count: 1,
                recurring_event_count: 0,
                reminder_count: 1,
            },
            current: RestoreCurrentCounts {
                calendar_count: 1,
                event_count: 3,
                reminder_count: 2,
            },
            settings: Box::new(RestoreSettingsSnapshot {
                default_event_duration_minutes: 60,
                default_reminder_minutes: None,
                week_starts_on: "monday".into(),
                time_format: "system".into(),
            }),
        };
        let serialized = serde_json::to_value(response).unwrap();
        assert_eq!(serialized["fileName"], "backup.sqlite3");
        assert!(!serialized.to_string().contains("/private"));
    }
}
