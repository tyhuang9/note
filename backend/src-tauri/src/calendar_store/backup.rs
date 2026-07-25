use std::{
    collections::BTreeSet,
    ffi::OsStr,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::calendar::backup::{
    BackupArtifact, BackupError, BackupRepository, RestoreBackupCounts, RestoreCurrentCounts,
    RestoreError, RestoreInspection, RestoreSettingsSnapshot,
};
use async_trait::async_trait;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
    Connection, Executor, Row, SqliteConnection,
};

use super::{
    private_file::{PrivateFileError, PrivateTempFile},
    sqlite::SqliteEventStore,
};

use super::sqlite::MIGRATOR;

const EXPECTED_TABLES: &[(&str, &[&str])] = &[
    (
        "_sqlx_migrations",
        &[
            "version",
            "description",
            "installed_on",
            "success",
            "checksum",
            "execution_time",
        ],
    ),
    (
        "calendars",
        &[
            "id",
            "name",
            "color_token",
            "is_default",
            "is_read_only",
            "source_type",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "events",
        &[
            "id",
            "calendar_id",
            "title",
            "description",
            "location",
            "temporal_kind",
            "start_utc",
            "end_utc",
            "time_zone",
            "start_date",
            "end_date_exclusive",
            "status",
            "revision",
            "created_at",
            "updated_at",
            "rrule",
        ],
    ),
    (
        "calendar_settings",
        &[
            "singleton_id",
            "default_event_duration_minutes",
            "week_starts_on",
            "time_format",
            "default_reminder_minutes",
        ],
    ),
    (
        "reminders",
        &["id", "event_id", "lead_minutes", "created_at", "updated_at"],
    ),
    (
        "reminder_deliveries",
        &[
            "id",
            "event_id",
            "reminder_id",
            "occurrence_key",
            "event_revision",
            "scheduled_utc",
            "status",
            "claimed_at",
            "delivered_at",
            "failed_at",
            "expired_at",
            "error_code",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "reminder_scheduler_state",
        &[
            "singleton_id",
            "checkpoint_utc",
            "horizon_end_utc",
            "system_time_zone",
            "updated_at",
        ],
    ),
    (
        "event_import_sources",
        &[
            "event_id",
            "source_uid",
            "source_sequence",
            "parser_version",
            "imported_at",
        ],
    ),
    (
        "event_overrides",
        &[
            "id",
            "parent_event_id",
            "original_start_key",
            "override_event_id",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "assistant_calendar_create_reconciliation",
        &["singleton_id", "created_at_utc_ms"],
    ),
];

const EXPECTED_INDEXES: &[&str] = &[
    "idx_calendars_one_default",
    "idx_event_import_sources_identity",
    "idx_event_overrides_override_event_id",
    "idx_event_overrides_parent_event_id",
    "idx_events_all_day_range",
    "idx_events_recurrence_candidates",
    "idx_events_timed_range",
    "idx_reminder_deliveries_pending_due",
    "idx_reminders_event_id",
];

const EXPECTED_TRIGGERS: &[&str] = &["cleanup_event_override_replacement"];

type SchemaDefinitions = BTreeSet<(String, String, String)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SnapshotStage {
    AfterVacuum,
    AfterVerification,
    BeforePublish,
}

#[async_trait]
impl BackupRepository for SqliteEventStore {
    async fn create_backup(&self, destination: &Path) -> Result<BackupArtifact, BackupError> {
        create_verified_snapshot(self.pool(), destination, |_| Ok(())).await
    }
}

async fn create_verified_snapshot<F>(
    pool: &sqlx::SqlitePool,
    destination: &Path,
    hook: F,
) -> Result<BackupArtifact, BackupError>
where
    F: Fn(SnapshotStage) -> Result<(), BackupError> + Send + Sync,
{
    let temporary = PrivateTempFile::create(destination, ".note-calendar-backup-", ".sqlite3")
        .map_err(map_private_file_error)?;

    let temporary_path = temporary.path().to_str().ok_or(BackupError::Failed)?;
    sqlx::query("VACUUM INTO ?")
        .bind(temporary_path)
        .execute(pool)
        .await
        .map_err(|_| BackupError::Failed)?;
    hook(SnapshotStage::AfterVacuum)?;

    verify_snapshot(temporary.path()).await?;
    hook(SnapshotStage::AfterVerification)?;

    let byte_size = temporary.sync().map_err(map_private_file_error)?;
    hook(SnapshotStage::BeforePublish)?;

    temporary
        .publish(destination)
        .map_err(map_private_file_error)?;
    Ok(BackupArtifact { byte_size })
}

fn map_private_file_error(error: PrivateFileError) -> BackupError {
    match error {
        PrivateFileError::DestinationExists => BackupError::DestinationExists,
        PrivateFileError::Failed => BackupError::Failed,
    }
}

async fn verify_snapshot(path: &Path) -> Result<(), BackupError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| BackupError::VerificationFailed)?;

    let quick_check: Vec<String> = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_all(&mut connection)
        .await
        .map_err(|_| BackupError::VerificationFailed)?;
    if quick_check.is_empty() || quick_check.iter().any(|result| result != "ok") {
        return Err(BackupError::VerificationFailed);
    }

    let integrity_check: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut connection)
        .await
        .map_err(|_| BackupError::VerificationFailed)?;
    if integrity_check.is_empty() || integrity_check.iter().any(|result| result != "ok") {
        return Err(BackupError::VerificationFailed);
    }

    let foreign_key_violation = sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| BackupError::VerificationFailed)?;
    if foreign_key_violation.is_some() {
        return Err(BackupError::VerificationFailed);
    }

    connection
        .close()
        .await
        .map_err(|_| BackupError::VerificationFailed)
}

impl SqliteEventStore {
    pub(crate) async fn stage_restore_snapshot(
        &self,
        source: &Path,
        destination: &Path,
        maximum_bytes: u64,
    ) -> Result<(u64, RestoreInspection), RestoreError> {
        let metadata = source.metadata().map_err(|_| RestoreError::ReadFailed)?;
        if !metadata.is_file() {
            return Err(RestoreError::ReadFailed);
        }
        if same_file::is_same_file(source, self.database_path())
            .map_err(|_| RestoreError::ReadFailed)?
        {
            return Err(RestoreError::InvalidBackup);
        }
        verify_source_file_size(source, metadata.len(), maximum_bytes)?;

        let expected_schema = live_schema_definitions(self.pool()).await?;

        let options = SqliteConnectOptions::new()
            .filename(source)
            .read_only(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let mut source_connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|_| RestoreError::InvalidBackup)?;
        let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&mut source_connection)
            .await
            .map_err(|_| RestoreError::InvalidBackup)?;
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(&mut source_connection)
            .await
            .map_err(|_| RestoreError::InvalidBackup)?;
        let logical_bytes = page_count
            .checked_mul(page_size)
            .and_then(|bytes| u64::try_from(bytes).ok())
            .ok_or(RestoreError::TooLarge)?;
        if logical_bytes > maximum_bytes {
            return Err(RestoreError::TooLarge);
        }

        let temporary = PrivateTempFile::create(destination, ".note-calendar-restore-", ".sqlite3")
            .map_err(|_| RestoreError::ReadFailed)?;
        let temporary_path = temporary.path().to_str().ok_or(RestoreError::ReadFailed)?;
        sqlx::query("VACUUM INTO ?")
            .bind(temporary_path)
            .execute(&mut source_connection)
            .await
            .map_err(|_| RestoreError::InvalidBackup)?;
        source_connection
            .close()
            .await
            .map_err(|_| RestoreError::ReadFailed)?;

        let byte_size = temporary.sync().map_err(|_| RestoreError::ReadFailed)?;
        if byte_size > maximum_bytes {
            return Err(RestoreError::TooLarge);
        }
        let inspection = inspect_restore_snapshot(temporary.path(), &expected_schema).await?;
        temporary
            .publish(destination)
            .map_err(|_| RestoreError::ReadFailed)?;
        Ok((byte_size, inspection))
    }

    pub(crate) async fn current_restore_counts(
        &self,
    ) -> Result<RestoreCurrentCounts, RestoreError> {
        current_counts(self.pool())
            .await
            .map_err(|_| RestoreError::Failed)
    }

    pub(crate) async fn restore_from_snapshot(
        &self,
        staged_path: &Path,
        recovery_path: &Path,
        expected: &RestoreInspection,
    ) -> Result<RestoreCurrentCounts, RestoreError> {
        self.restore_from_snapshot_with_hook(staged_path, recovery_path, expected, |_| Ok(()))
            .await
    }

    async fn restore_from_snapshot_with_hook<F>(
        &self,
        staged_path: &Path,
        recovery_path: &Path,
        expected: &RestoreInspection,
        hook: F,
    ) -> Result<RestoreCurrentCounts, RestoreError>
    where
        F: Fn(RestoreTransactionStage) -> Result<(), RestoreError> + Send + Sync,
    {
        let _dispatch_barrier = self.calendar_mutation_guard().await;
        let expected_schema = live_schema_definitions(self.pool()).await?;
        let verified = inspect_restore_snapshot(staged_path, &expected_schema).await?;
        if &verified != expected {
            return Err(RestoreError::VerificationFailed);
        }

        create_verified_snapshot(self.pool(), recovery_path, |_| Ok(()))
            .await
            .map_err(|_| RestoreError::RecoveryBackupFailed)?;

        let result = replace_live_data(self.database_path(), staged_path, &hook).await;
        match result {
            Ok(()) => {
                self.advance_reminder_data_generation();
                Ok(RestoreCurrentCounts {
                    calendar_count: verified.backup.calendar_count,
                    event_count: verified.backup.event_count,
                    reminder_count: verified.backup.reminder_count,
                })
            }
            Err(error) => {
                let _ = std::fs::remove_file(recovery_path);
                Err(error)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RestoreTransactionStage {
    AfterDelete,
    BeforeCommit,
}

fn sidecar_path(source: &Path, suffix: &str) -> PathBuf {
    let mut path = source.as_os_str().to_os_string();
    path.push(OsStr::new(suffix));
    PathBuf::from(path)
}

fn verify_source_file_size(
    source: &Path,
    main_bytes: u64,
    maximum_bytes: u64,
) -> Result<(), RestoreError> {
    let mut total_bytes = main_bytes;
    for suffix in ["-wal", "-shm", "-journal"] {
        match sidecar_path(source, suffix).metadata() {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(RestoreError::ReadFailed);
                }
                total_bytes = total_bytes
                    .checked_add(metadata.len())
                    .ok_or(RestoreError::TooLarge)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(RestoreError::ReadFailed),
        }
    }
    if total_bytes > maximum_bytes {
        return Err(RestoreError::TooLarge);
    }
    Ok(())
}

async fn inspect_restore_snapshot(
    path: &Path,
    expected_schema: &SchemaDefinitions,
) -> Result<RestoreInspection, RestoreError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(true)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| RestoreError::InvalidBackup)?;

    verify_restore_integrity(&mut connection).await?;
    verify_restore_migrations(&mut connection).await?;
    verify_restore_schema(&mut connection, expected_schema).await?;

    let backup = RestoreBackupCounts {
        calendar_count: scalar_count(&mut connection, "SELECT COUNT(*) FROM calendars").await?,
        event_count: scalar_count(
            &mut connection,
            "SELECT COUNT(*) FROM events
             WHERE NOT EXISTS (
               SELECT 1 FROM event_overrides WHERE override_event_id = events.id
             )",
        )
        .await?,
        timed_event_count: scalar_count(
            &mut connection,
            "SELECT COUNT(*) FROM events WHERE temporal_kind = 'timed'
             AND NOT EXISTS (
               SELECT 1 FROM event_overrides WHERE override_event_id = events.id
             )",
        )
        .await?,
        all_day_event_count: scalar_count(
            &mut connection,
            "SELECT COUNT(*) FROM events WHERE temporal_kind = 'all_day'
             AND NOT EXISTS (
               SELECT 1 FROM event_overrides WHERE override_event_id = events.id
             )",
        )
        .await?,
        recurring_event_count: scalar_count(
            &mut connection,
            "SELECT COUNT(*) FROM events WHERE rrule IS NOT NULL",
        )
        .await?,
        reminder_count: scalar_count(
            &mut connection,
            "SELECT COUNT(*) FROM reminders
             WHERE NOT EXISTS (
               SELECT 1 FROM event_overrides WHERE override_event_id = reminders.event_id
             )",
        )
        .await?,
    };
    let settings = sqlx::query_as::<_, (i64, Option<i64>, String, String)>(
        "SELECT default_event_duration_minutes, default_reminder_minutes,
                week_starts_on, time_format
         FROM calendar_settings WHERE singleton_id = 1",
    )
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| RestoreError::IncompatibleBackup)?
    .map(
        |(
            default_event_duration_minutes,
            default_reminder_minutes,
            week_starts_on,
            time_format,
        )| {
            RestoreSettingsSnapshot {
                default_event_duration_minutes,
                default_reminder_minutes,
                week_starts_on,
                time_format,
            }
        },
    )
    .ok_or(RestoreError::IncompatibleBackup)?;
    let schema_version = MIGRATOR
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .map(|migration| migration.version)
        .max()
        .ok_or(RestoreError::IncompatibleBackup)?;
    connection
        .close()
        .await
        .map_err(|_| RestoreError::VerificationFailed)?;
    Ok(RestoreInspection {
        schema_version,
        backup,
        settings,
    })
}

async fn verify_restore_integrity(connection: &mut SqliteConnection) -> Result<(), RestoreError> {
    let quick_check: Vec<String> = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| RestoreError::VerificationFailed)?;
    if quick_check.is_empty() || quick_check.iter().any(|result| result != "ok") {
        return Err(RestoreError::VerificationFailed);
    }
    let integrity_check: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| RestoreError::VerificationFailed)?;
    if integrity_check.is_empty() || integrity_check.iter().any(|result| result != "ok") {
        return Err(RestoreError::VerificationFailed);
    }
    let foreign_key_violation = sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| RestoreError::VerificationFailed)?;
    if foreign_key_violation.is_some() {
        return Err(RestoreError::VerificationFailed);
    }
    Ok(())
}

async fn verify_restore_migrations(connection: &mut SqliteConnection) -> Result<(), RestoreError> {
    let applied: Vec<(i64, bool, Vec<u8>)> =
        sqlx::query_as("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| RestoreError::IncompatibleBackup)?;
    let compiled: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .collect();
    if applied.len() != compiled.len()
        || applied
            .iter()
            .zip(compiled)
            .any(|((version, success, checksum), migration)| {
                !success
                    || *version != migration.version
                    || migration.checksum != checksum.as_slice()
            })
    {
        return Err(RestoreError::IncompatibleBackup);
    }
    Ok(())
}

fn expected_object_names() -> BTreeSet<(String, String)> {
    let mut expected = BTreeSet::new();
    for (table, _) in EXPECTED_TABLES {
        expected.insert(("table".to_owned(), (*table).to_owned()));
    }
    for index in EXPECTED_INDEXES {
        expected.insert(("index".to_owned(), (*index).to_owned()));
    }
    for trigger in EXPECTED_TRIGGERS {
        expected.insert(("trigger".to_owned(), (*trigger).to_owned()));
    }
    expected
}

async fn live_schema_definitions(
    pool: &sqlx::SqlitePool,
) -> Result<SchemaDefinitions, RestoreError> {
    let definitions = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT type, name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_autoindex_%'
           AND name NOT LIKE 'sqlite_stat%'
         ORDER BY type, name",
    )
    .fetch_all(pool)
    .await
    .map_err(|_| RestoreError::Failed)?;
    let definitions = definitions
        .into_iter()
        .map(|(object_type, name, sql)| {
            sql.map(|sql| (object_type, name, sql))
                .ok_or(RestoreError::Failed)
        })
        .collect::<Result<SchemaDefinitions, _>>()?;
    let names: BTreeSet<(String, String)> = definitions
        .iter()
        .map(|(object_type, name, _)| (object_type.clone(), name.clone()))
        .collect();
    if names != expected_object_names() {
        return Err(RestoreError::Failed);
    }
    Ok(definitions)
}

async fn verify_restore_schema(
    connection: &mut SqliteConnection,
    expected_definitions: &SchemaDefinitions,
) -> Result<(), RestoreError> {
    let definitions = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT type, name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_autoindex_%'
           AND name NOT LIKE 'sqlite_stat%'
         ORDER BY type, name",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| RestoreError::IncompatibleBackup)?;
    let actual = definitions
        .into_iter()
        .map(|(object_type, name, sql)| {
            sql.map(|sql| (object_type, name, sql))
                .ok_or(RestoreError::IncompatibleBackup)
        })
        .collect::<Result<SchemaDefinitions, _>>()?;
    if &actual != expected_definitions {
        return Err(RestoreError::IncompatibleBackup);
    }

    for (table, expected_columns) in EXPECTED_TABLES {
        let sql = format!("PRAGMA table_info(\"{table}\")");
        let rows = sqlx::query(&sql)
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| RestoreError::IncompatibleBackup)?;
        let columns: Vec<String> = rows
            .iter()
            .map(|row| row.try_get::<String, _>("name"))
            .collect::<Result<_, _>>()
            .map_err(|_| RestoreError::IncompatibleBackup)?;
        if columns != *expected_columns {
            return Err(RestoreError::IncompatibleBackup);
        }
    }
    Ok(())
}

async fn scalar_count(connection: &mut SqliteConnection, query: &str) -> Result<i64, RestoreError> {
    sqlx::query_scalar(query)
        .fetch_one(connection)
        .await
        .map_err(|_| RestoreError::IncompatibleBackup)
}

async fn current_counts(pool: &sqlx::SqlitePool) -> Result<RestoreCurrentCounts, sqlx::Error> {
    Ok(RestoreCurrentCounts {
        calendar_count: sqlx::query_scalar("SELECT COUNT(*) FROM calendars")
            .fetch_one(pool)
            .await?,
        event_count: sqlx::query_scalar(
            "SELECT COUNT(*) FROM events
             WHERE NOT EXISTS (
               SELECT 1 FROM event_overrides WHERE override_event_id = events.id
             )",
        )
        .fetch_one(pool)
        .await?,
        reminder_count: sqlx::query_scalar(
            "SELECT COUNT(*) FROM reminders
             WHERE NOT EXISTS (
               SELECT 1 FROM event_overrides WHERE override_event_id = reminders.event_id
             )",
        )
        .fetch_one(pool)
        .await?,
    })
}

async fn replace_live_data<F>(
    live_path: &Path,
    staged_path: &Path,
    hook: &F,
) -> Result<(), RestoreError>
where
    F: Fn(RestoreTransactionStage) -> Result<(), RestoreError> + Send + Sync,
{
    let options = SqliteConnectOptions::new()
        .filename(live_path)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| RestoreError::Failed)?;
    let staged_path = staged_path.to_str().ok_or(RestoreError::Failed)?;
    let attach_result = sqlx::query("ATTACH DATABASE ? AS restore_stage")
        .bind(staged_path)
        .execute(&mut connection)
        .await;
    if attach_result.is_err() {
        let _ = connection.close().await;
        return Err(RestoreError::Failed);
    }

    let transaction_result = replace_attached_data(&mut connection, hook).await;
    let _ = connection.execute("DETACH DATABASE restore_stage").await;
    let _ = connection.close().await;
    transaction_result
}

async fn replace_attached_data<F>(
    connection: &mut SqliteConnection,
    hook: &F,
) -> Result<(), RestoreError>
where
    F: Fn(RestoreTransactionStage) -> Result<(), RestoreError> + Send + Sync,
{
    connection
        .execute("BEGIN IMMEDIATE")
        .await
        .map_err(|_| RestoreError::Failed)?;
    let result = async {
        connection.execute("PRAGMA defer_foreign_keys = ON").await?;
        for table in [
            "assistant_calendar_create_reconciliation",
            "reminder_deliveries",
            "reminders",
            "event_import_sources",
            "event_overrides",
            "events",
            "calendar_settings",
            "reminder_scheduler_state",
            "calendars",
        ] {
            connection
                .execute(format!("DELETE FROM {table}").as_str())
                .await?;
        }
        hook(RestoreTransactionStage::AfterDelete)
            .map_err(|_| sqlx::Error::Protocol("restore hook failed".to_owned()))?;

        for statement in RESTORE_INSERTS {
            connection.execute(*statement).await?;
        }
        hook(RestoreTransactionStage::BeforeCommit)
            .map_err(|_| sqlx::Error::Protocol("restore hook failed".to_owned()))?;
        Ok::<(), sqlx::Error>(())
    }
    .await;

    if result.is_ok() {
        if connection.execute("COMMIT").await.is_ok() {
            Ok(())
        } else {
            let _ = connection.execute("ROLLBACK").await;
            Err(RestoreError::Failed)
        }
    } else {
        let _ = connection.execute("ROLLBACK").await;
        Err(RestoreError::Failed)
    }
}

const RESTORE_INSERTS: &[&str] = &[
    "INSERT INTO calendars (id, name, color_token, is_default, is_read_only, source_type, created_at, updated_at)
     SELECT id, name, color_token, is_default, is_read_only, source_type, created_at, updated_at FROM restore_stage.calendars",
    "INSERT INTO events (id, calendar_id, title, description, location, temporal_kind, start_utc, end_utc, time_zone, start_date, end_date_exclusive, status, revision, created_at, updated_at, rrule)
     SELECT id, calendar_id, title, description, location, temporal_kind, start_utc, end_utc, time_zone, start_date, end_date_exclusive, status, revision, created_at, updated_at, rrule FROM restore_stage.events",
    "INSERT INTO event_overrides (id, parent_event_id, original_start_key, override_event_id, created_at, updated_at)
     SELECT id, parent_event_id, original_start_key, override_event_id, created_at, updated_at FROM restore_stage.event_overrides",
    "INSERT INTO calendar_settings (singleton_id, default_event_duration_minutes, week_starts_on, time_format, default_reminder_minutes)
     SELECT singleton_id, default_event_duration_minutes, week_starts_on, time_format, default_reminder_minutes FROM restore_stage.calendar_settings",
    "INSERT INTO reminders (id, event_id, lead_minutes, created_at, updated_at)
     SELECT id, event_id, lead_minutes, created_at, updated_at FROM restore_stage.reminders",
    "INSERT INTO reminder_deliveries (id, event_id, reminder_id, occurrence_key, event_revision, scheduled_utc, status, claimed_at, delivered_at, failed_at, expired_at, error_code, created_at, updated_at)
     SELECT id, event_id, reminder_id, occurrence_key, event_revision, scheduled_utc, status, claimed_at, delivered_at, failed_at, expired_at, error_code, created_at, updated_at FROM restore_stage.reminder_deliveries",
    "INSERT INTO reminder_scheduler_state (singleton_id, checkpoint_utc, horizon_end_utc, system_time_zone, updated_at)
     SELECT singleton_id, checkpoint_utc, horizon_end_utc, system_time_zone, updated_at FROM restore_stage.reminder_scheduler_state",
    "INSERT INTO event_import_sources (event_id, source_uid, source_sequence, parser_version, imported_at)
     SELECT event_id, source_uid, source_sequence, parser_version, imported_at FROM restore_stage.event_import_sources",
    "INSERT INTO assistant_calendar_create_reconciliation (singleton_id, created_at_utc_ms)
     SELECT singleton_id, created_at_utc_ms FROM restore_stage.assistant_calendar_create_reconciliation",
];

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use sqlx::Executor;
    use uuid::Uuid;

    use super::*;
    use crate::calendar_store::sqlite::SqliteEventStore;

    const DEFAULT_CALENDAR_ID: &str = "00000000-0000-4000-8000-000000000001";

    async fn insert_full_restore_fixture(
        store: &SqliteEventStore,
        prefix: &str,
    ) -> (String, String) {
        let timed_id = Uuid::new_v4().to_string();
        let all_day_id = Uuid::new_v4().to_string();
        let override_event_id = Uuid::new_v4().to_string();
        let reminder_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO assistant_calendar_create_reconciliation (
                singleton_id, created_at_utc_ms
             ) VALUES (1, ?)",
        )
        .bind(if prefix == "backup" { 111_i64 } else { 222_i64 })
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_utc, end_utc, time_zone,
                status, revision, created_at, updated_at
             ) VALUES (?, ?, ?, 'timed', 1784646000000, 1784649600000,
                       'America/Chicago', 'confirmed', 2, 10, 11)",
        )
        .bind(&timed_id)
        .bind(DEFAULT_CALENDAR_ID)
        .bind(format!("{prefix} timed"))
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_date, end_date_exclusive,
                rrule, status, revision, created_at, updated_at
             ) VALUES (?, ?, ?, 'all_day', '2026-07-24', '2026-07-25',
                       'FREQ=DAILY;COUNT=3', 'confirmed', 1, 12, 13)",
        )
        .bind(&all_day_id)
        .bind(DEFAULT_CALENDAR_ID)
        .bind(format!("{prefix} all day"))
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_date, end_date_exclusive,
                status, revision, created_at, updated_at
             ) VALUES (?, ?, ?, 'all_day', '2026-07-30', '2026-07-31',
                       'confirmed', 1, 19, 20)",
        )
        .bind(&override_event_id)
        .bind(DEFAULT_CALENDAR_ID)
        .bind(format!("{prefix} replacement"))
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO event_overrides (
                id, parent_event_id, original_start_key, override_event_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 21, 22)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&all_day_id)
        .bind(format!("{all_day_id}/all-day/2026-07-25"))
        .bind(&override_event_id)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO reminders (id, event_id, lead_minutes, created_at, updated_at)
             VALUES (?, ?, 15, 14, 15)",
        )
        .bind(&reminder_id)
        .bind(&timed_id)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO reminder_deliveries (
                id, event_id, reminder_id, occurrence_key, event_revision, scheduled_utc,
                status, claimed_at, delivered_at, created_at, updated_at
             ) VALUES (?, ?, ?, '1784646000000', 2, 1784645100000,
                       'delivered', 1784645100001, 1784645100002, 16, 17)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&timed_id)
        .bind(&reminder_id)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO event_import_sources (
                event_id, source_uid, source_sequence, parser_version, imported_at
             ) VALUES (?, 'opaque-uid', 4, 'note-ics-v1', 18)",
        )
        .bind(&all_day_id)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE calendar_settings
             SET default_event_duration_minutes = 45,
                 default_reminder_minutes = 30,
                 week_starts_on = 'sunday', time_format = '24h'
             WHERE singleton_id = 1",
        )
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE reminder_scheduler_state
             SET checkpoint_utc = 100, horizon_end_utc = 200,
                 system_time_zone = 'America/Chicago', updated_at = 300
             WHERE singleton_id = 1",
        )
        .execute(store.pool())
        .await
        .unwrap();
        (timed_id, all_day_id)
    }

    fn temporary_backups(directory: &Path) -> Vec<String> {
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(".note-calendar-backup-"))
            .collect()
    }

    #[tokio::test]
    async fn snapshot_reopens_with_events_settings_and_migrations() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("calendar.sqlite3");
        let destination = directory.path().join("manual.sqlite3");
        let store = SqliteEventStore::open(&source_path).await.unwrap();

        let timed_id = Uuid::new_v4().to_string();
        let all_day_id = Uuid::new_v4().to_string();
        let recurring_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_utc, end_utc, time_zone,
                status, revision, created_at, updated_at
             ) VALUES (?, ?, 'Timed backup', 'timed', 1784646000000, 1784649600000,
                       'America/Chicago', 'confirmed', 1, 1, 1)",
        )
        .bind(&timed_id)
        .bind(DEFAULT_CALENDAR_ID)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_date, end_date_exclusive,
                status, revision, created_at, updated_at
             ) VALUES (?, ?, 'All-day backup', 'all_day', '2026-07-22', '2026-07-23',
                       'confirmed', 1, 1, 1)",
        )
        .bind(&all_day_id)
        .bind(DEFAULT_CALENDAR_ID)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_date, end_date_exclusive,
                rrule, status, revision, created_at, updated_at
             ) VALUES (?, ?, 'Recurring backup', 'all_day', '2026-07-24', '2026-07-25',
                       'FREQ=DAILY;COUNT=3', 'confirmed', 1, 1, 1)",
        )
        .bind(&recurring_id)
        .bind(DEFAULT_CALENDAR_ID)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE calendar_settings
             SET default_event_duration_minutes = 45,
                 week_starts_on = 'sunday', time_format = '24h'
             WHERE singleton_id = 1",
        )
        .execute(store.pool())
        .await
        .unwrap();

        let artifact = store.create_backup(&destination).await.unwrap();
        assert!(artifact.byte_size > 0);
        assert_eq!(artifact.byte_size, destination.metadata().unwrap().len());

        let reopened = SqliteEventStore::open(&destination).await.unwrap();
        let titles: Vec<String> =
            sqlx::query_scalar("SELECT title FROM events WHERE id IN (?, ?, ?) ORDER BY title")
                .bind(&timed_id)
                .bind(&all_day_id)
                .bind(&recurring_id)
                .fetch_all(reopened.pool())
                .await
                .unwrap();
        assert_eq!(
            titles,
            vec!["All-day backup", "Recurring backup", "Timed backup"]
        );
        let recurrence: String = sqlx::query_scalar("SELECT rrule FROM events WHERE id = ?")
            .bind(&recurring_id)
            .fetch_one(reopened.pool())
            .await
            .unwrap();
        assert_eq!(recurrence, "FREQ=DAILY;COUNT=3");
        let settings: (i64, String, String) = sqlx::query_as(
            "SELECT default_event_duration_minutes, week_starts_on, time_format
             FROM calendar_settings WHERE singleton_id = 1",
        )
        .fetch_one(reopened.pool())
        .await
        .unwrap();
        assert_eq!(settings, (45, "sunday".into(), "24h".into()));
        let migrations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
                .fetch_one(reopened.pool())
                .await
                .unwrap();
        assert_eq!(migrations as usize, MIGRATOR.migrations.len());
    }

    #[tokio::test]
    async fn committed_wal_content_is_included_in_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("calendar.sqlite3");
        let destination = directory.path().join("wal-backup.sqlite3");
        let store = SqliteEventStore::open(&source_path).await.unwrap();

        let event_id = Uuid::new_v4().to_string();
        let mut connection = store.pool().acquire().await.unwrap();
        connection
            .execute("PRAGMA wal_autocheckpoint = 0")
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO events (
                id, calendar_id, title, temporal_kind, start_date, end_date_exclusive,
                status, revision, created_at, updated_at
             ) VALUES (?, ?, 'Committed in WAL', 'all_day', '2026-07-26', '2026-07-27',
                       'confirmed', 1, 1, 1)",
        )
        .bind(&event_id)
        .bind(DEFAULT_CALENDAR_ID)
        .execute(&mut *connection)
        .await
        .unwrap();
        drop(connection);
        assert!(
            source_path
                .with_extension("sqlite3-wal")
                .metadata()
                .unwrap()
                .len()
                > 0
        );

        store.create_backup(&destination).await.unwrap();
        let options = SqliteConnectOptions::new()
            .filename(&destination)
            .read_only(true);
        let mut backup = SqliteConnection::connect_with(&options).await.unwrap();
        let title: String = sqlx::query_scalar("SELECT title FROM events WHERE id = ?")
            .bind(event_id)
            .fetch_one(&mut backup)
            .await
            .unwrap();
        assert_eq!(title, "Committed in WAL");
    }

    #[tokio::test]
    async fn destination_is_never_clobbered_even_if_it_appears_before_publish() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("calendar.sqlite3");
        let destination = directory.path().join("existing.sqlite3");
        let store = SqliteEventStore::open(&source_path).await.unwrap();
        let original = b"do not overwrite";
        let injected = AtomicBool::new(false);

        let result = create_verified_snapshot(store.pool(), &destination, |stage| {
            if stage == SnapshotStage::BeforePublish && !injected.swap(true, Ordering::SeqCst) {
                std::fs::write(&destination, original).unwrap();
            }
            Ok(())
        })
        .await;

        assert_eq!(result, Err(BackupError::DestinationExists));
        assert_eq!(std::fs::read(&destination).unwrap(), original);
        assert!(temporary_backups(directory.path()).is_empty());
    }

    #[tokio::test]
    async fn injected_failure_cleans_temporary_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("calendar.sqlite3");
        let destination = directory.path().join("never-published.sqlite3");
        let store = SqliteEventStore::open(&source_path).await.unwrap();

        let result = create_verified_snapshot(store.pool(), &destination, |stage| {
            if stage == SnapshotStage::AfterVacuum {
                Err(BackupError::Failed)
            } else {
                Ok(())
            }
        })
        .await;

        assert_eq!(result, Err(BackupError::Failed));
        assert!(!destination.exists());
        assert!(temporary_backups(directory.path()).is_empty());
    }

    #[tokio::test]
    async fn verification_rejects_non_database_and_foreign_key_violations() {
        let directory = tempfile::tempdir().unwrap();
        let invalid = directory.path().join("invalid.sqlite3");
        std::fs::write(&invalid, b"calendar content is not sqlite").unwrap();
        assert_eq!(
            verify_snapshot(&invalid).await,
            Err(BackupError::VerificationFailed)
        );

        let foreign_key_invalid = directory.path().join("foreign-key-invalid.sqlite3");
        let options = SqliteConnectOptions::new()
            .filename(&foreign_key_invalid)
            .create_if_missing(true)
            .foreign_keys(false);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        connection
            .execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
            .await
            .unwrap();
        connection
            .execute(
                "CREATE TABLE child (
                    id INTEGER PRIMARY KEY,
                    parent_id INTEGER NOT NULL REFERENCES parent(id)
                 )",
            )
            .await
            .unwrap();
        connection
            .execute("INSERT INTO child (id, parent_id) VALUES (1, 999)")
            .await
            .unwrap();
        connection.close().await.unwrap();
        assert_eq!(
            verify_snapshot(&foreign_key_invalid).await,
            Err(BackupError::VerificationFailed)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn published_snapshot_is_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("calendar.sqlite3");
        let destination = directory.path().join("private.sqlite3");
        let store = SqliteEventStore::open(&source_path).await.unwrap();

        store.create_backup(&destination).await.unwrap();

        assert_eq!(
            destination.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn restore_preview_stages_wal_and_reports_exact_data_without_live_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.sqlite3");
        let live_path = directory.path().join("live.sqlite3");
        let staged_path = directory.path().join("staged.sqlite3");
        let source = SqliteEventStore::open(&source_path).await.unwrap();
        let live = SqliteEventStore::open(&live_path).await.unwrap();
        insert_full_restore_fixture(&source, "backup").await;
        insert_full_restore_fixture(&live, "live").await;

        let mut connection = source.pool().acquire().await.unwrap();
        connection
            .execute("PRAGMA wal_autocheckpoint = 0")
            .await
            .unwrap();
        sqlx::query("UPDATE events SET location = 'committed WAL' WHERE title = 'backup timed'")
            .execute(&mut *connection)
            .await
            .unwrap();
        drop(connection);
        assert!(
            source_path
                .with_extension("sqlite3-wal")
                .metadata()
                .unwrap()
                .len()
                > 0
        );

        let before = live.current_restore_counts().await.unwrap();
        let (bytes, inspection) = live
            .stage_restore_snapshot(&source_path, &staged_path, 512 * 1024 * 1024)
            .await
            .unwrap();
        assert!(bytes > 0);
        let latest_schema_version = MIGRATOR
            .iter()
            .filter(|migration| !migration.migration_type.is_down_migration())
            .map(|migration| migration.version)
            .max()
            .unwrap();
        assert_eq!(inspection.schema_version, latest_schema_version);
        assert_eq!(inspection.backup.calendar_count, 1);
        assert_eq!(inspection.backup.event_count, 2);
        assert_eq!(inspection.backup.timed_event_count, 1);
        assert_eq!(inspection.backup.all_day_event_count, 1);
        assert_eq!(inspection.backup.recurring_event_count, 1);
        assert_eq!(inspection.backup.reminder_count, 1);
        assert_eq!(inspection.settings.default_event_duration_minutes, 45);
        assert_eq!(inspection.settings.default_reminder_minutes, Some(30));
        assert_eq!(inspection.settings.week_starts_on, "sunday");
        assert_eq!(inspection.settings.time_format, "24h");
        assert_eq!(live.current_restore_counts().await.unwrap(), before);

        let options = SqliteConnectOptions::new()
            .filename(&staged_path)
            .read_only(true)
            .immutable(true);
        let mut staged = SqliteConnection::connect_with(&options).await.unwrap();
        let location: String =
            sqlx::query_scalar("SELECT location FROM events WHERE title = 'backup timed'")
                .fetch_one(&mut staged)
                .await
                .unwrap();
        assert_eq!(location, "committed WAL");
    }

    #[tokio::test]
    async fn restore_replaces_all_owned_tables_atomically_and_keeps_recovery_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.sqlite3");
        let live_path = directory.path().join("live.sqlite3");
        let staged_path = directory.path().join("staged.sqlite3");
        let recovery_path = directory.path().join("recovery.sqlite3");
        let source = SqliteEventStore::open(&source_path).await.unwrap();
        let live = SqliteEventStore::open(&live_path).await.unwrap();
        let (source_timed, source_all_day) = insert_full_restore_fixture(&source, "backup").await;
        let (live_timed, _) = insert_full_restore_fixture(&live, "live").await;
        let (_, inspection) = live
            .stage_restore_snapshot(&source_path, &staged_path, 512 * 1024 * 1024)
            .await
            .unwrap();

        let restored = live
            .restore_from_snapshot(&staged_path, &recovery_path, &inspection)
            .await
            .unwrap();
        assert_eq!(restored.calendar_count, 1);
        assert_eq!(restored.event_count, 2);
        assert_eq!(restored.reminder_count, 1);
        assert!(recovery_path.exists());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events WHERE id IN (?, ?)")
                .bind(&source_timed)
                .bind(&source_all_day)
                .fetch_one(live.pool())
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM events WHERE id = ?")
                .bind(&live_timed)
                .fetch_one(live.pool())
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM reminder_deliveries")
                .fetch_one(live.pool())
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM event_import_sources")
                .fetch_one(live.pool())
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM event_overrides")
                .fetch_one(live.pool())
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT replacement.title
                 FROM event_overrides overrides
                 JOIN events replacement ON replacement.id = overrides.override_event_id
                 WHERE overrides.parent_event_id = ?"
            )
            .bind(&source_all_day)
            .fetch_one(live.pool())
            .await
            .unwrap(),
            "backup replacement"
        );
        assert_eq!(
            sqlx::query_as::<_, (i64, i64, String, i64)>(
                "SELECT checkpoint_utc, horizon_end_utc, system_time_zone, updated_at
                 FROM reminder_scheduler_state WHERE singleton_id = 1"
            )
            .fetch_one(live.pool())
            .await
            .unwrap(),
            (100, 200, "America/Chicago".into(), 300)
        );
        assert_eq!(
            sqlx::query_as::<_, (i64, Option<i64>, String, String)>(
                "SELECT default_event_duration_minutes, default_reminder_minutes,
                        week_starts_on, time_format
                 FROM calendar_settings WHERE singleton_id = 1"
            )
            .fetch_one(live.pool())
            .await
            .unwrap(),
            (45, Some(30), "sunday".into(), "24h".into())
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT created_at_utc_ms
                 FROM assistant_calendar_create_reconciliation WHERE singleton_id = 1"
            )
            .fetch_one(live.pool())
            .await
            .unwrap(),
            111
        );

        let recovery = SqliteConnectOptions::new()
            .filename(&recovery_path)
            .read_only(true)
            .immutable(true);
        let mut recovery = SqliteConnection::connect_with(&recovery).await.unwrap();
        let recovered_title: String = sqlx::query_scalar("SELECT title FROM events WHERE id = ?")
            .bind(&live_timed)
            .fetch_one(&mut recovery)
            .await
            .unwrap();
        assert_eq!(recovered_title, "live timed");
        let recovered_marker: i64 = sqlx::query_scalar(
            "SELECT created_at_utc_ms
             FROM assistant_calendar_create_reconciliation WHERE singleton_id = 1",
        )
        .fetch_one(&mut recovery)
        .await
        .unwrap();
        assert_eq!(recovered_marker, 222);
    }

    #[tokio::test]
    async fn injected_restore_failure_rolls_back_live_data_and_removes_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.sqlite3");
        let live_path = directory.path().join("live.sqlite3");
        let staged_path = directory.path().join("staged.sqlite3");
        let recovery_path = directory.path().join("recovery.sqlite3");
        let source = SqliteEventStore::open(&source_path).await.unwrap();
        let live = SqliteEventStore::open(&live_path).await.unwrap();
        insert_full_restore_fixture(&source, "backup").await;
        let (live_timed, _) = insert_full_restore_fixture(&live, "live").await;
        let (_, inspection) = live
            .stage_restore_snapshot(&source_path, &staged_path, 512 * 1024 * 1024)
            .await
            .unwrap();

        let result = live
            .restore_from_snapshot_with_hook(&staged_path, &recovery_path, &inspection, |stage| {
                if stage == RestoreTransactionStage::AfterDelete {
                    Err(RestoreError::Failed)
                } else {
                    Ok(())
                }
            })
            .await;
        assert_eq!(result, Err(RestoreError::Failed));
        assert!(!recovery_path.exists());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM events WHERE id = ?")
                .bind(live_timed)
                .fetch_one(live.pool())
                .await
                .unwrap(),
            "live timed"
        );
    }

    #[tokio::test]
    async fn restore_validation_rejects_invalid_lineage_integrity_and_size() {
        let directory = tempfile::tempdir().unwrap();
        let live_path = directory.path().join("live.sqlite3");
        let valid_path = directory.path().join("valid.sqlite3");
        let live = SqliteEventStore::open(&live_path).await.unwrap();
        let valid = SqliteEventStore::open(&valid_path).await.unwrap();
        insert_full_restore_fixture(&valid, "backup").await;

        let too_small_stage = directory.path().join("too-small.sqlite3");
        assert_eq!(
            live.stage_restore_snapshot(&valid_path, &too_small_stage, 1)
                .await,
            Err(RestoreError::TooLarge)
        );

        assert_eq!(
            live.stage_restore_snapshot(
                &live_path,
                &directory.path().join("live-stage.sqlite3"),
                512 * 1024 * 1024,
            )
            .await,
            Err(RestoreError::InvalidBackup)
        );

        let invalid = directory.path().join("invalid.sqlite3");
        std::fs::write(&invalid, b"not sqlite").unwrap();
        assert!(matches!(
            live.stage_restore_snapshot(
                &invalid,
                &directory.path().join("invalid-stage.sqlite3"),
                1024
            )
            .await,
            Err(RestoreError::InvalidBackup)
        ));

        let checksum = directory.path().join("checksum.sqlite3");
        valid.create_backup(&checksum).await.unwrap();
        let options = SqliteConnectOptions::new().filename(&checksum);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        let latest_version = MIGRATOR
            .iter()
            .filter(|migration| !migration.migration_type.is_down_migration())
            .map(|migration| migration.version)
            .max()
            .unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = ?")
            .bind(latest_version)
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        let expected_schema = live_schema_definitions(live.pool()).await.unwrap();
        assert_eq!(
            inspect_restore_snapshot(&checksum, &expected_schema).await,
            Err(RestoreError::IncompatibleBackup)
        );

        let schema = directory.path().join("schema.sqlite3");
        valid.create_backup(&schema).await.unwrap();
        let options = SqliteConnectOptions::new().filename(&schema);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        connection
            .execute("CREATE TABLE unexpected (id INTEGER)")
            .await
            .unwrap();
        connection.close().await.unwrap();
        assert_eq!(
            inspect_restore_snapshot(&schema, &expected_schema).await,
            Err(RestoreError::IncompatibleBackup)
        );

        let altered_ddl = directory.path().join("altered-ddl.sqlite3");
        valid.create_backup(&altered_ddl).await.unwrap();
        let options = SqliteConnectOptions::new().filename(&altered_ddl);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        connection
            .execute("PRAGMA writable_schema = ON")
            .await
            .unwrap();
        sqlx::query(
            "UPDATE sqlite_schema
             SET sql = replace(sql,
                 'name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200)',
                 'name TEXT NOT NULL')
             WHERE type = 'table' AND name = 'calendars'",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();
        assert_eq!(
            inspect_restore_snapshot(&altered_ddl, &expected_schema).await,
            Err(RestoreError::IncompatibleBackup)
        );

        let foreign_key = directory.path().join("foreign-key.sqlite3");
        valid.create_backup(&foreign_key).await.unwrap();
        let options = SqliteConnectOptions::new()
            .filename(&foreign_key)
            .foreign_keys(false);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query(
            "INSERT INTO reminders (id, event_id, lead_minutes, created_at, updated_at)
             VALUES ('orphan', 'missing', 5, 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();
        assert_eq!(
            inspect_restore_snapshot(&foreign_key, &expected_schema).await,
            Err(RestoreError::VerificationFailed)
        );

        let sidecar_source = directory.path().join("sidecar.sqlite3");
        valid.create_backup(&sidecar_source).await.unwrap();
        let main_bytes = sidecar_source.metadata().unwrap().len();
        std::fs::write(sidecar_path(&sidecar_source, "-wal"), [0_u8; 8]).unwrap();
        assert_eq!(
            live.stage_restore_snapshot(
                &sidecar_source,
                &directory.path().join("sidecar-stage.sqlite3"),
                main_bytes + 4,
            )
            .await,
            Err(RestoreError::TooLarge)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_stage_and_recovery_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.sqlite3");
        let live_path = directory.path().join("live.sqlite3");
        let staged_path = directory.path().join("staged.sqlite3");
        let recovery_path = directory.path().join("recovery.sqlite3");
        let _source = SqliteEventStore::open(&source_path).await.unwrap();
        let live = SqliteEventStore::open(&live_path).await.unwrap();
        let (_, inspection) = live
            .stage_restore_snapshot(&source_path, &staged_path, 512 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            staged_path.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        live.restore_from_snapshot(&staged_path, &recovery_path, &inspection)
            .await
            .unwrap();
        assert_eq!(
            recovery_path.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
