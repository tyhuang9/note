use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::Notify;

use crate::{
    assistant::AssistantState,
    calendar::{
        backup::{BackupService, BackupState, RestoreService},
        error::{ApiError, StoreError},
        export::{IcsExportService, IcsExportState},
        import::IcsImportState,
        service::CalendarService,
        settings::SettingsService,
    },
    calendar_store::sqlite::SqliteEventStore,
    models_ai::ModelsAiRuntime,
    mutation::MutationGate,
    notes::NotesService,
    voice::VoiceState,
};

#[cfg(desktop)]
use crate::calendar::reminders::ReminderState;

const CALENDAR_READY_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct CalendarRuntime {
    pub(crate) calendar: CalendarService,
    pub(crate) settings: SettingsService,
    pub(crate) import: IcsImportState,
    pub(crate) export: IcsExportState,
    pub(crate) backup: BackupState,
    #[cfg(desktop)]
    pub(crate) reminders: Option<ReminderState>,
}

impl CalendarRuntime {
    fn new(
        store: Arc<SqliteEventStore>,
        app_data_dir: &Path,
        app: Option<tauri::AppHandle>,
    ) -> Self {
        Self {
            calendar: CalendarService::new(store.clone()),
            settings: SettingsService::new(store.clone()),
            import: IcsImportState::new(store.clone()),
            export: IcsExportState::new(IcsExportService::new(store.clone())),
            backup: BackupState::new(
                BackupService::new(store.clone()),
                RestoreService::new(
                    store.clone(),
                    app_data_dir.join("calendar-restore-staging"),
                    app_data_dir.join("calendar-backups"),
                ),
            ),
            #[cfg(desktop)]
            reminders: app.map(|app| ReminderState::new(store.clone(), app)),
        }
    }
}

#[derive(Clone)]
enum CalendarState {
    Loading,
    Ready {
        runtime: Arc<CalendarRuntime>,
        initialization_duration_ms: u64,
    },
    Unavailable {
        initialization_duration_ms: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CalendarReadinessStatus {
    Loading,
    Ready {
        #[serde(rename = "initializationDurationMs")]
        initialization_duration_ms: u64,
    },
    Unavailable {
        #[serde(rename = "initializationDurationMs")]
        initialization_duration_ms: u64,
    },
}

impl CalendarState {
    fn status(&self) -> CalendarReadinessStatus {
        match self {
            Self::Loading => CalendarReadinessStatus::Loading,
            Self::Ready {
                initialization_duration_ms,
                ..
            } => CalendarReadinessStatus::Ready {
                initialization_duration_ms: *initialization_duration_ms,
            },
            Self::Unavailable {
                initialization_duration_ms,
            } => CalendarReadinessStatus::Unavailable {
                initialization_duration_ms: *initialization_duration_ms,
            },
        }
    }
}

#[async_trait]
trait CalendarInitializer: Send + Sync {
    async fn open(&self, database_path: &Path) -> Result<Arc<SqliteEventStore>, StoreError>;
}

struct SqliteCalendarInitializer;

#[async_trait]
impl CalendarInitializer for SqliteCalendarInitializer {
    async fn open(&self, database_path: &Path) -> Result<Arc<SqliteEventStore>, StoreError> {
        SqliteEventStore::open(database_path).await.map(Arc::new)
    }
}

struct CalendarReadiness {
    app_data_dir: PathBuf,
    initializer: Arc<dyn CalendarInitializer>,
    state: RwLock<CalendarState>,
    changed: Notify,
    initializing: AtomicBool,
}

impl CalendarReadiness {
    fn new(app_data_dir: PathBuf, initializer: Arc<dyn CalendarInitializer>) -> Arc<Self> {
        Arc::new(Self {
            app_data_dir,
            initializer,
            state: RwLock::new(CalendarState::Loading),
            changed: Notify::new(),
            initializing: AtomicBool::new(false),
        })
    }

    fn status(&self) -> CalendarReadinessStatus {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .status()
    }

    fn ready_now(&self) -> Option<Arc<CalendarRuntime>> {
        match &*self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
        {
            CalendarState::Ready { runtime, .. } => Some(runtime.clone()),
            CalendarState::Loading | CalendarState::Unavailable { .. } => None,
        }
    }

    fn start(self: &Arc<Self>, app: Option<tauri::AppHandle>) {
        if self.ready_now().is_some()
            || self
                .initializing
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
        *self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = CalendarState::Loading;
        self.changed.notify_waiters();

        let readiness = self.clone();
        tauri::async_runtime::spawn(async move {
            readiness.initialize(app).await;
        });
    }

    async fn initialize(&self, app: Option<tauri::AppHandle>) {
        let started = Instant::now();
        let database_path = self.app_data_dir.join("calendar.sqlite3");
        let next = match self.initializer.open(&database_path).await {
            Ok(store) => CalendarState::Ready {
                runtime: Arc::new(CalendarRuntime::new(store, &self.app_data_dir, app)),
                initialization_duration_ms: elapsed_ms(started),
            },
            Err(_) => CalendarState::Unavailable {
                initialization_duration_ms: elapsed_ms(started),
            },
        };
        let ready = matches!(next, CalendarState::Ready { .. });
        *self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
        self.initializing.store(false, Ordering::Release);
        self.changed.notify_waiters();

        #[cfg(desktop)]
        if ready {
            if let Some(runtime) = self.ready_now() {
                if let Some(reminders) = runtime.reminders.as_ref() {
                    reminders.start();
                }
            }
        }
    }

    async fn wait(&self, timeout: Duration) -> Result<Arc<CalendarRuntime>, ApiError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.changed.notified();
            let state = self
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            match state {
                CalendarState::Ready { runtime, .. } => return Ok(runtime),
                CalendarState::Unavailable { .. } => return Err(storage_unavailable()),
                CalendarState::Loading => {}
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(calendar_loading());
            }
        }
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

const fn calendar_loading() -> ApiError {
    ApiError {
        code: "calendar_loading",
        message: "Calendar storage is still starting. Try again shortly.",
        field: None,
    }
}

const fn storage_unavailable() -> ApiError {
    ApiError {
        code: "storage_unavailable",
        message: "Calendar storage is temporarily unavailable.",
        field: None,
    }
}

pub(crate) struct AppState {
    // Notes and calendar writes are independently admitted. Calendar commands
    // wait for readiness before taking their gate, so startup cannot block notes.
    pub(crate) note_mutations: MutationGate,
    pub(crate) calendar_mutations: MutationGate,
    pub(crate) notes: NotesService,
    pub(crate) assistant: AssistantState,
    pub(crate) models_ai: ModelsAiRuntime,
    pub(crate) voice: Arc<VoiceState>,
    calendar: Arc<CalendarReadiness>,
}

impl AppState {
    pub(crate) fn new(app_data_dir: PathBuf) -> Self {
        Self::new_with_initializer(app_data_dir, Arc::new(SqliteCalendarInitializer))
    }

    fn new_with_initializer(
        app_data_dir: PathBuf,
        initializer: Arc<dyn CalendarInitializer>,
    ) -> Self {
        Self {
            note_mutations: MutationGate::default(),
            calendar_mutations: MutationGate::default(),
            notes: NotesService::new(app_data_dir.clone()),
            assistant: AssistantState::default(),
            models_ai: ModelsAiRuntime::new(&app_data_dir),
            voice: Arc::new(VoiceState::new(app_data_dir.join("voice"))),
            calendar: CalendarReadiness::new(app_data_dir, initializer),
        }
    }

    pub(crate) fn start_calendar_initialization(&self, app: Option<tauri::AppHandle>) {
        self.calendar.start(app);
    }

    pub(crate) fn calendar_readiness(&self) -> CalendarReadinessStatus {
        self.calendar.status()
    }

    pub(crate) async fn calendar_runtime(&self) -> Result<Arc<CalendarRuntime>, ApiError> {
        self.calendar.wait(CALENDAR_READY_TIMEOUT).await
    }

    pub(crate) fn ready_calendar_now(&self) -> Option<Arc<CalendarRuntime>> {
        self.calendar.ready_now()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;
    use crate::calendar::domain::{parse_all_day_event, EventDraft};

    struct ControlledInitializer {
        calls: AtomicUsize,
        started: Notify,
        release: Notify,
        fail_first: bool,
    }

    #[async_trait]
    impl CalendarInitializer for ControlledInitializer {
        async fn open(&self, database_path: &Path) -> Result<Arc<SqliteEventStore>, StoreError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            self.release.notified().await;
            if self.fail_first && call == 0 {
                Err(StoreError::InvalidData)
            } else {
                SqliteEventStore::open(database_path).await.map(Arc::new)
            }
        }
    }

    #[test]
    fn constructing_app_state_never_runs_calendar_io_or_touches_notes() {
        let directory = tempfile::tempdir().unwrap();
        let note_data = br#"{"folders":[],"pages":[],"blocks":[]}"#;
        let note_path = directory.path().join("note-data.json");
        fs::write(&note_path, note_data).unwrap();
        let initializer = Arc::new(ControlledInitializer {
            calls: AtomicUsize::new(0),
            started: Notify::new(),
            release: Notify::new(),
            fail_first: false,
        });

        let state =
            AppState::new_with_initializer(directory.path().to_path_buf(), initializer.clone());

        assert_eq!(initializer.calls.load(Ordering::SeqCst), 0);
        assert_eq!(state.calendar_readiness(), CalendarReadinessStatus::Loading);
        assert_eq!(fs::read(note_path).unwrap(), note_data);
        assert!(!directory.path().join("calendar.sqlite3").exists());
    }

    #[tokio::test]
    async fn blocked_initializer_keeps_loading_bounded_then_becomes_ready() {
        let directory = tempfile::tempdir().unwrap();
        let initializer = Arc::new(ControlledInitializer {
            calls: AtomicUsize::new(0),
            started: Notify::new(),
            release: Notify::new(),
            fail_first: false,
        });
        let state =
            AppState::new_with_initializer(directory.path().to_path_buf(), initializer.clone());

        state.start_calendar_initialization(None);
        initializer.started.notified().await;
        let error = match state.calendar.wait(Duration::from_millis(1)).await {
            Ok(_) => panic!("blocked initialization unexpectedly became ready"),
            Err(error) => error,
        };
        assert_eq!(error.code, "calendar_loading");
        initializer.release.notify_one();
        state.calendar.wait(Duration::from_secs(2)).await.unwrap();
        assert!(matches!(
            state.calendar_readiness(),
            CalendarReadinessStatus::Ready { .. }
        ));
    }

    #[tokio::test]
    async fn loading_calendar_readiness_does_not_block_note_admission() {
        let directory = tempfile::tempdir().unwrap();
        let initializer = Arc::new(ControlledInitializer {
            calls: AtomicUsize::new(0),
            started: Notify::new(),
            release: Notify::new(),
            fail_first: false,
        });
        let state =
            AppState::new_with_initializer(directory.path().to_path_buf(), initializer.clone());

        state.start_calendar_initialization(None);
        initializer.started.notified().await;
        let _calendar_admission = state.calendar_mutations.begin().unwrap();
        let readiness =
            tokio::time::timeout(Duration::from_millis(1), state.calendar_runtime()).await;
        assert!(readiness.is_err());
        assert!(state.note_mutations.begin().is_ok());

        initializer.release.notify_one();
    }

    #[tokio::test]
    async fn failed_initializer_is_unavailable_and_can_be_retried() {
        let directory = tempfile::tempdir().unwrap();
        let initializer = Arc::new(ControlledInitializer {
            calls: AtomicUsize::new(0),
            started: Notify::new(),
            release: Notify::new(),
            fail_first: true,
        });
        let state =
            AppState::new_with_initializer(directory.path().to_path_buf(), initializer.clone());

        state.start_calendar_initialization(None);
        initializer.started.notified().await;
        initializer.release.notify_one();
        let error = match state.calendar.wait(Duration::from_secs(1)).await {
            Ok(_) => panic!("failed initialization unexpectedly became ready"),
            Err(error) => error,
        };
        assert_eq!(error.code, "storage_unavailable");
        assert!(matches!(
            state.calendar_readiness(),
            CalendarReadinessStatus::Unavailable { .. }
        ));

        state.start_calendar_initialization(None);
        initializer.started.notified().await;
        initializer.release.notify_one();
        state.calendar.wait(Duration::from_secs(2)).await.unwrap();
        assert_eq!(initializer.calls.load(Ordering::SeqCst), 2);
        assert!(matches!(
            state.calendar_readiness(),
            CalendarReadinessStatus::Ready { .. }
        ));
    }

    #[test]
    fn readiness_status_is_structured_and_path_free() {
        let serialized = serde_json::to_string(&CalendarReadinessStatus::Unavailable {
            initialization_duration_ms: 42,
        })
        .unwrap();
        assert_eq!(
            serialized,
            r#"{"state":"unavailable","initializationDurationMs":42}"#
        );
        assert!(!serialized.contains('/'));
        assert!(!serialized.contains('\\'));
    }

    #[tokio::test]
    async fn assistant_reconciliation_marker_survives_app_state_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let first = AppState::new(directory.path().to_path_buf());
        first.start_calendar_initialization(None);
        let first_runtime = first.calendar_runtime().await.unwrap();
        let draft = EventDraft::validated(
            "Durable assistant create".into(),
            None,
            None,
            parse_all_day_event("2026-07-25", "2026-07-26").unwrap(),
        )
        .unwrap();
        first_runtime
            .calendar
            .create_assistant_event(draft)
            .await
            .unwrap();
        drop(first_runtime);
        drop(first);

        let reopened = AppState::new(directory.path().to_path_buf());
        reopened.start_calendar_initialization(None);
        let reopened_runtime = reopened.calendar_runtime().await.unwrap();
        assert!(reopened_runtime
            .calendar
            .assistant_create_reconciliation_required()
            .await
            .unwrap());
    }
}
