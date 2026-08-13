use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tokio::sync::watch;
use uuid::Uuid;

use crate::events::{VOICE_MODEL_PROGRESS, VOICE_PROPOSAL, VOICE_SHORTCUT, VOICE_STATE};

mod capture;
mod managed;
mod transcribe;

const QUICK_COMMAND_WINDOW: &str = "quick-command";
const MAIN_WINDOW: &str = "main";
pub(crate) const HOLD_TO_TALK_SHORTCUT: &str = "CmdOrCtrl+Shift+V";
const MAX_PROPOSAL_CHARS: usize = 500;
const MAX_PROPOSALS: usize = 64;
const MAX_MICROPHONE_LABEL_CHARS: usize = 128;
const MAX_SELECTION_NOTICE_CHARS: usize = 160;
const MICROPHONE_SELECTION_FILE: &str = "microphone-selection.json";
const MISSING_MICROPHONE_NOTICE: &str =
    "Saved microphone is unavailable; using the system default when available.";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceMode {
    AssistantCommand,
    NoteDictation,
    QuickCapture,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceSessionState {
    Recording,
    Transcribing,
    Cancelled,
    TimedOut,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VoiceCaptureStartRequest {
    pub(crate) mode: VoiceMode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VoiceSessionRequest {
    pub(crate) session_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VoiceTypedProposalRequest {
    pub(crate) mode: VoiceMode,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VoiceProposalSubmitRequest {
    pub(crate) proposal_id: String,
    pub(crate) mode: VoiceMode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VoiceMicrophoneSelectRequest {
    pub(crate) microphone_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceSession {
    pub(crate) generation: u64,
    pub(crate) session_id: String,
    pub(crate) state: VoiceSessionState,
    pub(crate) mode: VoiceMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceProposalSource {
    Voice,
    Typed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceProposal {
    pub(crate) proposal_id: String,
    pub(crate) text: String,
    pub(crate) mode: VoiceMode,
    pub(crate) source: VoiceProposalSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceTranscript {
    generation: u64,
    session_id: String,
    proposal_id: String,
    transcript: String,
    mode: VoiceMode,
    source: VoiceProposalSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceProposalSubmission {
    pub(crate) accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceStatus {
    pub(crate) microphone_capture: VoiceCapability,
    pub(crate) transcription: VoiceCapability,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceCapability {
    pub(crate) available: bool,
    pub(crate) limitation: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceConfigStatus {
    pub(crate) microphone_capture: VoiceCapability,
    pub(crate) transcription: VoiceCapability,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceMicrophonesStatus {
    pub(crate) available: bool,
    pub(crate) limitation: &'static str,
    pub(crate) devices: Vec<VoiceMicrophone>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) selected_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) selection_notice: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceMicrophone {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) selected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceShortcutStatus {
    pub(crate) hold_to_talk: VoiceShortcutAction,
    pub(crate) assistant: VoiceShortcutAction,
    pub(crate) quick_capture: VoiceShortcutAction,
    pub(crate) agenda: VoiceShortcutAction,
    pub(crate) widget: VoiceShortcutAction,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceShortcutAction {
    pub(crate) status: VoiceShortcutRegistrationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) key: Option<&'static str>,
    pub(crate) message: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceShortcutRegistrationState {
    Registered,
    Unregistered,
    Conflict,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceModelStatus {
    pub(crate) state: managed::VoiceModelState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_code: Option<&'static str>,
    pub(crate) display_name: &'static str,
    pub(crate) expected_download_bytes: u64,
    pub(crate) transcription_available: bool,
}

impl From<managed::VoiceModelStatus> for VoiceModelStatus {
    fn from(status: managed::VoiceModelStatus) -> Self {
        Self {
            state: status.state,
            error_code: status.error_code,
            display_name: status.display_name,
            expected_download_bytes: status.expected_download_bytes,
            transcription_available: status.transcription_available,
        }
    }
}

#[derive(Default)]
struct VoiceRuntime {
    generation: u64,
    active: Option<ActiveVoiceSession>,
    proposals: HashMap<String, VoiceProposal>,
    replay_session: Option<VoiceSession>,
    replay_transcript: Option<VoiceTranscript>,
    shortcut_pressed: bool,
}

struct ActiveVoiceSession {
    session: VoiceSession,
    cancel: watch::Sender<bool>,
}

struct PendingTranscription {
    session: VoiceSession,
    cancel: watch::Receiver<bool>,
    config: Option<(PathBuf, PathBuf)>,
    audio: capture::CapturedAudio,
}

#[derive(Clone)]
struct VoiceConfiguration {
    cli_path: Option<PathBuf>,
    model_path: Option<PathBuf>,
    microphone_key: Option<String>,
    microphone_label: Option<String>,
}

pub(crate) struct VoiceState {
    runtime: Mutex<VoiceRuntime>,
    capture: capture::CaptureController,
    configuration: Mutex<VoiceConfiguration>,
    staging_root: PathBuf,
    settings_root: PathBuf,
    managed_model: managed::ManagedVoiceModel,
    shortcut_status: Mutex<VoiceShortcutRegistrationState>,
}

impl VoiceState {
    pub(crate) fn new(root: PathBuf) -> Self {
        let microphone_selection = load_microphone_selection(&root);
        Self {
            runtime: Mutex::new(VoiceRuntime::default()),
            capture: capture::CaptureController::new(),
            configuration: Mutex::new(VoiceConfiguration {
                cli_path: std::env::var_os("NOTE_WHISPER_CLI").map(PathBuf::from),
                model_path: std::env::var_os("NOTE_WHISPER_MODEL").map(PathBuf::from),
                microphone_key: microphone_selection
                    .as_ref()
                    .and_then(|selection| selection.key.clone()),
                microphone_label: microphone_selection.and_then(|selection| selection.label),
            }),
            staging_root: root.join("transcriptions"),
            settings_root: root.clone(),
            managed_model: managed::ManagedVoiceModel::new(root.join("managed-model")),
            shortcut_status: Mutex::new(VoiceShortcutRegistrationState::Unregistered),
        }
    }

    async fn start(
        &self,
        mode: VoiceMode,
    ) -> (VoiceSession, bool, Option<capture::CaptureDeadlineReceiver>) {
        let mut runtime = lock_runtime(&self.runtime);
        if let Some(active) = runtime.active.as_ref() {
            if matches!(
                active.session.state,
                VoiceSessionState::Recording | VoiceSessionState::Transcribing
            ) {
                return (active.session.clone(), false, None);
            }
        }
        runtime.generation = runtime.generation.wrapping_add(1);
        let mut session = VoiceSession {
            generation: runtime.generation,
            session_id: Uuid::new_v4().to_string(),
            state: VoiceSessionState::Recording,
            mode,
        };
        let deadline = if self.configured() {
            match self.capture.start(
                Uuid::parse_str(&session.session_id).unwrap_or_else(|_| Uuid::new_v4()),
                self.microphone_key_for_start(),
            ) {
                Ok(deadline) => Some(deadline),
                Err(_) => {
                    session.state = VoiceSessionState::Unavailable;
                    None
                }
            }
        } else {
            session.state = VoiceSessionState::Unavailable;
            None
        };
        let (cancel, _) = watch::channel(false);
        runtime.active = Some(ActiveVoiceSession {
            session: session.clone(),
            cancel,
        });
        runtime.replay_session = Some(session.clone());
        runtime.replay_transcript = None;
        (session, true, deadline)
    }

    async fn stop(
        self: Arc<Self>,
        app: tauri::AppHandle,
        session_id: &str,
    ) -> (VoiceSession, bool) {
        let pending = {
            let mut runtime = lock_runtime(&self.runtime);
            let Some(active) = runtime.active.as_mut() else {
                return (
                    VoiceSession {
                        generation: runtime.generation,
                        session_id: sanitize_id(session_id),
                        state: VoiceSessionState::Cancelled,
                        mode: VoiceMode::QuickCapture,
                    },
                    false,
                );
            };
            if active.session.session_id != session_id {
                return (
                    VoiceSession {
                        generation: active.session.generation,
                        session_id: sanitize_id(session_id),
                        state: VoiceSessionState::Cancelled,
                        mode: active.session.mode,
                    },
                    false,
                );
            }
            if active.session.state != VoiceSessionState::Recording {
                return (active.session.clone(), false);
            }
            let Ok(capture_stop) = self.capture.stop() else {
                active.session.state = VoiceSessionState::Unavailable;
                return (active.session.clone(), true);
            };
            match capture_stop {
                capture::CaptureStop::Stopped(capture_id, audio) => {
                    if capture_id.to_string() != active.session.session_id {
                        active.session.state = VoiceSessionState::Cancelled;
                        return (active.session.clone(), true);
                    }
                    active.session.state = VoiceSessionState::Transcribing;
                    PendingTranscription {
                        session: active.session.clone(),
                        cancel: active.cancel.subscribe(),
                        config: self.configuration(),
                        audio,
                    }
                }
                capture::CaptureStop::Deadline(completion) => {
                    match claim_deadline_completion(active, completion) {
                        DeadlineClaim::Ignored => return (active.session.clone(), false),
                        DeadlineClaim::TimedOut(session) => return (session, true),
                        DeadlineClaim::Transcribing {
                            session,
                            cancel,
                            audio,
                        } => PendingTranscription {
                            session,
                            cancel,
                            config: self.configuration(),
                            audio,
                        },
                    }
                }
            }
        };
        let session = pending.session.clone();
        self.spawn_transcription(app, pending);
        (session, true)
    }

    fn spawn_transcription(self: Arc<Self>, app: tauri::AppHandle, pending: PendingTranscription) {
        let state = self.clone();
        let staging_root = self.staging_root.clone();
        tauri::async_runtime::spawn(async move {
            let Some((cli, model)) = pending.config else {
                state.finish_transcription(
                    &app,
                    &pending.session,
                    Err(transcribe::TranscriptionError::InvalidConfiguration),
                );
                return;
            };
            let result =
                transcribe::transcribe(&cli, &model, pending.audio, pending.cancel, &staging_root)
                    .await;
            state.finish_transcription(&app, &pending.session, result);
        });
    }

    fn monitor_capture_deadline(
        self: Arc<Self>,
        app: tauri::AppHandle,
        expected: VoiceSession,
        receiver: capture::CaptureDeadlineReceiver,
    ) {
        tauri::async_runtime::spawn(async move {
            let completion = tokio::task::spawn_blocking(move || {
                capture::CaptureController::wait_for_deadline(receiver)
            })
            .await
            .unwrap_or(Err(capture::CaptureError::Internal));
            self.finish_capture_deadline(&app, &expected, completion);
        });
    }

    fn finish_capture_deadline(
        self: Arc<Self>,
        app: &tauri::AppHandle,
        expected: &VoiceSession,
        completion: Result<capture::CaptureDeadlineCompletion, capture::CaptureError>,
    ) {
        let outcome = {
            let mut runtime = lock_runtime(&self.runtime);
            let Some(active) = runtime.active.as_mut() else {
                return;
            };
            let completion = match completion {
                Ok(completion) => completion,
                Err(_) => {
                    if is_current_recording(active, expected) {
                        active.session.state = VoiceSessionState::TimedOut;
                        emit_state(app, &active.session);
                    }
                    return;
                }
            };
            if !is_current_recording(active, expected) {
                return;
            }
            match claim_deadline_completion(active, completion) {
                DeadlineClaim::Ignored => return,
                DeadlineClaim::TimedOut(session) => {
                    emit_state(app, &session);
                    return;
                }
                DeadlineClaim::Transcribing {
                    session,
                    cancel,
                    audio,
                } => PendingTranscription {
                    session,
                    cancel,
                    config: self.configuration(),
                    audio,
                },
            }
        };
        emit_state(app, &outcome.session);
        self.spawn_transcription(app.clone(), outcome);
    }

    async fn cancel(&self, session_id: &str) -> VoiceSession {
        let mut runtime = lock_runtime(&self.runtime);
        match runtime.active.as_mut() {
            Some(active) if active.session.session_id == session_id => {
                let _ = active.cancel.send(true);
                let _ = self.capture.cancel();
                active.session.state = VoiceSessionState::Cancelled;
                active.session.clone()
            }
            Some(active) => VoiceSession {
                generation: active.session.generation,
                session_id: sanitize_id(session_id),
                state: VoiceSessionState::Cancelled,
                mode: active.session.mode,
            },
            None => VoiceSession {
                generation: runtime.generation,
                session_id: sanitize_id(session_id),
                state: VoiceSessionState::Cancelled,
                mode: VoiceMode::QuickCapture,
            },
        }
    }

    fn create_typed_proposal(&self, request: VoiceTypedProposalRequest) -> VoiceProposal {
        let proposal = VoiceProposal {
            proposal_id: Uuid::new_v4().to_string(),
            text: sanitize_text(&request.text),
            mode: request.mode,
            source: VoiceProposalSource::Typed,
        };
        insert_proposal(&mut lock_runtime(&self.runtime), proposal.clone());
        proposal
    }

    fn proposal_for_submission(&self, proposal_id: &str, mode: VoiceMode) -> Option<VoiceProposal> {
        lock_runtime(&self.runtime)
            .proposals
            .remove(proposal_id)
            .filter(|proposal| proposal.mode == mode)
    }

    fn quick_command_ready(&self) -> VoiceQuickCommandReady {
        let runtime = lock_runtime(&self.runtime);
        let state = runtime
            .active
            .as_ref()
            .map(|active| &active.session)
            .or(runtime.replay_session.as_ref())
            .map(|session| VoiceStateEvent {
                generation: session.generation,
                session_id: session.session_id.clone(),
                state: session.state,
                mode: session.mode,
                source: "quick_command",
            });
        VoiceQuickCommandReady {
            generation: runtime.generation,
            shortcut_pressed: runtime.shortcut_pressed,
            state,
            transcript: runtime
                .replay_transcript
                .as_ref()
                .filter(|transcript| transcript.generation == runtime.generation)
                .cloned(),
        }
    }

    fn configured(&self) -> bool {
        self.configuration().is_some()
    }

    fn microphones_status(&self) -> VoiceMicrophonesStatus {
        let microphones = match self.capture.enumerate() {
            Ok(microphones) => microphones,
            Err(_) => {
                return VoiceMicrophonesStatus {
                    available: false,
                    limitation: "Native microphone enumeration is unavailable on this platform.",
                    devices: Vec::new(),
                    selected_id: None,
                    selection_notice: None,
                }
            }
        };
        let (selected_key, selection_notice) = {
            let mut configuration = self
                .configuration
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let missing = configuration
                .microphone_key
                .as_ref()
                .is_some_and(|key| !microphones.iter().any(|microphone| &microphone.key == key));
            if missing {
                configuration.microphone_key = None;
                configuration.microphone_label = None;
                let _ = self.persist_microphone_selection(&configuration);
            }
            (
                configuration.microphone_key.clone(),
                missing.then(|| bounded_notice(MISSING_MICROPHONE_NOTICE)),
            )
        };
        let mut devices = microphones
            .iter()
            .filter_map(|microphone| {
                let label = sanitize_microphone_label(&microphone.label)?;
                let id = opaque_microphone_id(&microphone.key);
                Some(VoiceMicrophone {
                    selected: selected_key.as_deref() == Some(microphone.key.as_str()),
                    id,
                    label,
                })
            })
            .collect::<Vec<_>>();
        devices.sort_by(|left, right| left.id.cmp(&right.id));
        let selected_id = devices
            .iter()
            .find(|device| device.selected)
            .map(|device| device.id.clone());
        VoiceMicrophonesStatus {
            available: self.capture.supported(),
            limitation: if self.capture.supported() {
                "Native microphone capture is available."
            } else {
                "Native microphone capture is not available on this platform."
            },
            devices,
            selected_id,
            selection_notice,
        }
    }

    fn select_microphone(
        &self,
        microphone_id: &str,
    ) -> Result<VoiceMicrophonesStatus, VoiceApiError> {
        if !valid_microphone_id(microphone_id) {
            return Err(VoiceApiError::invalid_request());
        }
        let microphones = self
            .capture
            .enumerate()
            .map_err(|_| VoiceApiError::microphone_unavailable())?;
        let microphone = microphones
            .iter()
            .find(|microphone| opaque_microphone_id(&microphone.key) == microphone_id)
            .ok_or_else(VoiceApiError::invalid_request)?;
        let label = sanitize_microphone_label(&microphone.label)
            .ok_or_else(VoiceApiError::invalid_request)?;
        {
            let mut configuration = self
                .configuration
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            configuration.microphone_key = Some(microphone.key.clone());
            configuration.microphone_label = Some(label);
            self.persist_microphone_selection(&configuration)
                .map_err(|_| VoiceApiError::microphone_unavailable())?;
        }
        Ok(self.microphones_status())
    }

    fn microphone_key_for_start(&self) -> Option<String> {
        let selected = self
            .configuration
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .microphone_key
            .clone();
        let selected = selected?;
        match self.capture.enumerate() {
            Ok(microphones)
                if microphones
                    .iter()
                    .any(|microphone| microphone.key == selected) =>
            {
                Some(selected)
            }
            Ok(_) => {
                let mut configuration = self
                    .configuration
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                configuration.microphone_key = None;
                configuration.microphone_label = None;
                let _ = self.persist_microphone_selection(&configuration);
                None
            }
            Err(_) => Some(selected),
        }
    }

    fn persist_microphone_selection(&self, configuration: &VoiceConfiguration) -> Result<(), ()> {
        let selection = PersistedMicrophoneSelection {
            key: configuration.microphone_key.clone(),
            label: configuration.microphone_label.clone(),
        };
        let content = serde_json::to_vec(&selection).map_err(|_| ())?;
        fs::create_dir_all(&self.settings_root).map_err(|_| ())?;
        crate::private_file::atomic_write_private(
            &self.settings_root.join(MICROPHONE_SELECTION_FILE),
            &content,
        )
        .map_err(|_| ())
    }

    fn status(&self) -> VoiceStatus {
        let configured = self.configured();
        VoiceStatus {
            microphone_capture: VoiceCapability {
                available: self.capture.supported(),
                limitation: if self.capture.supported() {
                    "Native microphone capture is available."
                } else {
                    "Native microphone capture is not available on this platform."
                },
            },
            transcription: VoiceCapability {
                available: configured,
                limitation: if configured {
                    "Native Whisper transcription is configured."
                } else {
                    "Set NOTE_WHISPER_CLI and NOTE_WHISPER_MODEL to regular local files before transcription can start."
                },
            },
        }
    }

    fn configuration(&self) -> Option<(PathBuf, PathBuf)> {
        let config = self
            .configuration
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cli = config.cli_path.clone()?;
        let model = config.model_path.clone()?;
        let model_is_valid = if model == self.managed_model.model_path() {
            self.managed_model.is_verified_model_path(&model)
        } else {
            safe_regular_file(&model)
        };
        (safe_regular_file(&cli) && model_is_valid).then_some((cli, model))
    }

    fn finish_transcription(
        &self,
        app: &tauri::AppHandle,
        completed: &VoiceSession,
        result: Result<String, transcribe::TranscriptionError>,
    ) {
        match finish_current_transcription(&mut lock_runtime(&self.runtime), completed, result) {
            Some(FinishedTranscription::Terminal(session)) => emit_state(app, &session),
            Some(FinishedTranscription::Transcript(transcript)) => {
                emit_to_quick_command(app, crate::events::VOICE_TRANSCRIPT, transcript);
            }
            None => {}
        }
    }

    pub(crate) async fn shortcut_pressed(self: Arc<Self>, app: tauri::AppHandle) {
        if !self.shortcut_registered() || activate_quick_command_window(&app).is_err() {
            return;
        }
        let Some((session, started, deadline)) = self.shortcut_press_session().await else {
            return;
        };
        if let Some(deadline) = deadline {
            self.clone()
                .monitor_capture_deadline(app.clone(), session.clone(), deadline);
        }
        lock_runtime(&self.runtime).shortcut_pressed = true;
        if should_emit_shortcut_events_after_activation(true, started) {
            emit_to_quick_command(&app, VOICE_SHORTCUT, VoiceShortcutEvent::pressed());
            emit_state(&app, &session);
        }
    }

    pub(crate) async fn shortcut_released(self: Arc<Self>, app: tauri::AppHandle) {
        if !self.shortcut_registered() {
            return;
        }
        lock_runtime(&self.runtime).shortcut_pressed = false;
        let session_id = self.active_recording_session_id();
        if let Some(session_id) = session_id {
            emit_to_quick_command(&app, VOICE_SHORTCUT, VoiceShortcutEvent::released());
            let (session, changed) = self.stop(app.clone(), &session_id).await;
            if changed {
                emit_state(&app, &session);
            }
        }
    }

    async fn shortcut_press_session(
        &self,
    ) -> Option<(VoiceSession, bool, Option<capture::CaptureDeadlineReceiver>)> {
        if self.shortcut_registered() {
            Some(self.start(VoiceMode::QuickCapture).await)
        } else {
            None
        }
    }

    fn active_recording_session_id(&self) -> Option<String> {
        lock_runtime(&self.runtime)
            .active
            .as_ref()
            .filter(|active| active.session.state == VoiceSessionState::Recording)
            .map(|active| active.session.session_id.clone())
    }

    async fn model_status(&self) -> VoiceModelStatus {
        self.managed_model.status().await.into()
    }

    async fn install_model(
        &self,
        app: tauri::AppHandle,
    ) -> Result<VoiceModelStatus, VoiceApiError> {
        let operation_id = Uuid::new_v4().to_string();
        let result = self
            .managed_model
            .install(operation_id, move |progress| {
                emit_to_main(&app, VOICE_MODEL_PROGRESS, progress)
            })
            .await;
        if result.is_ok() {
            self.configuration
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .model_path = Some(self.managed_model.model_path());
        }
        Ok(self.model_status().await)
    }

    async fn cancel_model_install(&self) {
        self.managed_model.cancel_install().await;
    }

    async fn remove_model(&self) -> Result<VoiceModelStatus, VoiceApiError> {
        self.managed_model
            .remove()
            .await
            .map_err(|_| VoiceApiError::invalid_request())?;
        {
            let managed_path = self.managed_model.model_path();
            let mut configuration = self
                .configuration
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if configuration.model_path.as_ref() == Some(&managed_path) {
                configuration.model_path = None;
            }
        }
        Ok(self.model_status().await)
    }

    pub(crate) fn shortcut_registered(&self) -> bool {
        *self
            .shortcut_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            == VoiceShortcutRegistrationState::Registered
    }

    fn set_shortcut_status(&self, status: VoiceShortcutRegistrationState) {
        *self
            .shortcut_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = status;
    }

    fn shortcut_status(&self) -> VoiceShortcutRegistrationState {
        *self
            .shortcut_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct PersistedMicrophoneSelection {
    key: Option<String>,
    label: Option<String>,
}

fn load_microphone_selection(root: &std::path::Path) -> Option<PersistedMicrophoneSelection> {
    let bytes = fs::read(root.join(MICROPHONE_SELECTION_FILE)).ok()?;
    if bytes.len() > 4 * 1024 {
        return None;
    }
    let selection: PersistedMicrophoneSelection = serde_json::from_slice(&bytes).ok()?;
    let valid = selection
        .key
        .as_ref()
        .is_some_and(|key| !key.is_empty() && key.chars().count() <= 1_024)
        && selection
            .label
            .as_deref()
            .and_then(sanitize_microphone_label)
            .is_some();
    valid.then_some(selection)
}

fn opaque_microphone_id(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let mut id = String::with_capacity(20);
    id.push_str("mic-");
    for byte in &digest[..8] {
        use std::fmt::Write as _;
        let _ = write!(id, "{byte:02x}");
    }
    id
}

fn valid_microphone_id(value: &str) -> bool {
    value.len() == 20
        && value.starts_with("mic-")
        && value.as_bytes()[4..].iter().all(u8::is_ascii_hexdigit)
        && value.as_bytes()[4..]
            .iter()
            .all(|byte| !byte.is_ascii_uppercase())
}

fn sanitize_microphone_label(value: &str) -> Option<String> {
    let label = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_MICROPHONE_LABEL_CHARS)
        .collect::<String>();
    (!label.trim().is_empty()).then(|| label.trim().to_owned())
}

fn bounded_notice(value: &str) -> String {
    value.chars().take(MAX_SELECTION_NOTICE_CHARS).collect()
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceShortcutEvent {
    action: &'static str,
    state: &'static str,
}

impl VoiceShortcutEvent {
    const fn pressed() -> Self {
        Self {
            action: "hold_to_talk",
            state: "pressed",
        }
    }

    const fn released() -> Self {
        Self {
            action: "hold_to_talk",
            state: "released",
        }
    }
}

fn ensure_quick_command_window(window: &WebviewWindow) -> Result<(), VoiceApiError> {
    (window.label() == QUICK_COMMAND_WINDOW)
        .then_some(())
        .ok_or_else(VoiceApiError::forbidden_window)
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), VoiceApiError> {
    (window.label() == MAIN_WINDOW)
        .then_some(())
        .ok_or_else(VoiceApiError::forbidden_window)
}

fn emit_to_quick_command<T: Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: T) {
    if let Some(window) = app.get_webview_window(QUICK_COMMAND_WINDOW) {
        let _ = window.emit(event, payload);
    }
}

fn activate_quick_command_window(app: &tauri::AppHandle) -> Result<(), VoiceApiError> {
    let window = match app.get_webview_window(QUICK_COMMAND_WINDOW) {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(
            app,
            QUICK_COMMAND_WINDOW,
            WebviewUrl::App("quick-command.html".into()),
        )
        .title("Note Quick Command")
        .inner_size(520.0, 180.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .visible(false)
        .build()
        {
            Ok(window) => window,
            Err(_) => app
                .get_webview_window(QUICK_COMMAND_WINDOW)
                .ok_or_else(VoiceApiError::quick_command_unavailable)?,
        },
    };
    window
        .unminimize()
        .map_err(|_| VoiceApiError::quick_command_unavailable())?;
    window
        .show()
        .map_err(|_| VoiceApiError::quick_command_unavailable())
}

const fn should_emit_shortcut_events_after_activation(
    activation_succeeded: bool,
    started: bool,
) -> bool {
    activation_succeeded && started
}

fn emit_to_main<T: Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: T) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.emit(event, payload);
    }
}

fn emit_state(app: &tauri::AppHandle, session: &VoiceSession) {
    emit_to_quick_command(
        app,
        VOICE_STATE,
        VoiceStateEvent {
            generation: session.generation,
            session_id: session.session_id.clone(),
            state: session.state,
            mode: session.mode,
            source: "quick_command",
        },
    );
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceStateEvent {
    generation: u64,
    session_id: String,
    state: VoiceSessionState,
    mode: VoiceMode,
    source: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceQuickCommandReady {
    generation: u64,
    shortcut_pressed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<VoiceStateEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transcript: Option<VoiceTranscript>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceApiError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

impl VoiceApiError {
    const fn forbidden_window() -> Self {
        Self {
            code: "forbidden_window",
            message: "This window cannot access native voice controls.",
        }
    }

    const fn invalid_request() -> Self {
        Self {
            code: "invalid_request",
            message: "The native voice request is invalid or exceeds a safety limit.",
        }
    }

    const fn proposal_missing() -> Self {
        Self {
            code: "voice_proposal_missing",
            message: "This voice proposal is no longer available.",
        }
    }

    const fn quick_command_unavailable() -> Self {
        Self {
            code: "quick_command_unavailable",
            message: "The quick-command window could not be activated.",
        }
    }

    const fn microphone_unavailable() -> Self {
        Self {
            code: "microphone_unavailable",
            message: "Native microphone selection is unavailable.",
        }
    }
}

#[tauri::command]
pub(crate) async fn voice_status_get(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceStatus, VoiceApiError> {
    ensure_quick_command_window(&window)?;
    Ok(state.voice.status())
}

/// Registers a fully-mounted quick-command renderer by returning a bounded replay snapshot.
/// Call this only after native event listeners are active; `state` must be applied before a
/// same-generation `transcript`, and generations lower than the already-applied value are stale.
#[tauri::command]
pub(crate) async fn voice_quick_command_ready(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceQuickCommandReady, VoiceApiError> {
    ensure_quick_command_window(&window)?;
    Ok(state.voice.quick_command_ready())
}

#[tauri::command]
pub(crate) async fn voice_capture_start(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
    request: VoiceCaptureStartRequest,
) -> Result<VoiceSession, VoiceApiError> {
    let _timer = crate::performance::Timer::start(crate::performance::Operation::VoiceCapture);
    ensure_quick_command_window(&window)?;
    let (session, _, deadline) = state.voice.start(request.mode).await;
    if let Some(deadline) = deadline {
        state.voice.clone().monitor_capture_deadline(
            window.app_handle().clone(),
            session.clone(),
            deadline,
        );
    }
    emit_state(window.app_handle(), &session);
    Ok(session)
}

#[tauri::command]
pub(crate) async fn voice_capture_stop(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
    request: VoiceSessionRequest,
) -> Result<VoiceSession, VoiceApiError> {
    let _timer = crate::performance::Timer::start(crate::performance::Operation::VoiceCapture);
    ensure_quick_command_window(&window)?;
    let (session, changed) = state
        .voice
        .clone()
        .stop(window.app_handle().clone(), &request.session_id)
        .await;
    if changed {
        emit_state(window.app_handle(), &session);
    }
    Ok(session)
}

#[tauri::command]
pub(crate) async fn voice_capture_cancel(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
    request: VoiceSessionRequest,
) -> Result<VoiceSession, VoiceApiError> {
    ensure_quick_command_window(&window)?;
    let session = state.voice.cancel(&request.session_id).await;
    emit_state(window.app_handle(), &session);
    Ok(session)
}

#[tauri::command]
pub(crate) async fn voice_typed_proposal(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
    request: VoiceTypedProposalRequest,
) -> Result<VoiceProposal, VoiceApiError> {
    ensure_quick_command_window(&window)?;
    if request.text.chars().count() > MAX_PROPOSAL_CHARS || sanitize_text(&request.text).is_empty()
    {
        return Err(VoiceApiError::invalid_request());
    }
    Ok(state.voice.create_typed_proposal(request))
}

#[tauri::command]
pub(crate) async fn voice_proposal_submit(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
    request: VoiceProposalSubmitRequest,
) -> Result<VoiceProposalSubmission, VoiceApiError> {
    ensure_quick_command_window(&window)?;
    let proposal = state
        .voice
        .proposal_for_submission(&request.proposal_id, request.mode)
        .ok_or_else(VoiceApiError::proposal_missing)?;
    emit_to_main(window.app_handle(), VOICE_PROPOSAL, proposal);
    Ok(VoiceProposalSubmission { accepted: true })
}

#[tauri::command]
pub(crate) async fn voice_config_get(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceConfigStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    Ok(VoiceConfigStatus {
        microphone_capture: state.voice.status().microphone_capture,
        transcription: state.voice.status().transcription,
    })
}

#[tauri::command]
pub(crate) async fn voice_microphones_get(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceMicrophonesStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    Ok(state.voice.microphones_status())
}

#[tauri::command]
pub(crate) async fn voice_microphone_select(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
    request: VoiceMicrophoneSelectRequest,
) -> Result<VoiceMicrophonesStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    state.voice.select_microphone(&request.microphone_id)
}

#[tauri::command]
pub(crate) async fn voice_shortcuts_status_get(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceShortcutStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    Ok(shortcut_status(state.voice.shortcut_status()))
}

#[tauri::command]
pub(crate) async fn voice_shortcuts_register(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceShortcutStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    let app = window.app_handle();
    if !cfg!(desktop) {
        state
            .voice
            .set_shortcut_status(VoiceShortcutRegistrationState::Unavailable);
        return Ok(shortcut_status(VoiceShortcutRegistrationState::Unavailable));
    }
    if app.global_shortcut().is_registered(HOLD_TO_TALK_SHORTCUT) {
        state
            .voice
            .set_shortcut_status(VoiceShortcutRegistrationState::Registered);
        return Ok(shortcut_status(VoiceShortcutRegistrationState::Registered));
    }
    match app.global_shortcut().register(HOLD_TO_TALK_SHORTCUT) {
        Ok(()) => {
            state
                .voice
                .set_shortcut_status(VoiceShortcutRegistrationState::Registered);
            Ok(shortcut_status(VoiceShortcutRegistrationState::Registered))
        }
        Err(_) => {
            state
                .voice
                .set_shortcut_status(VoiceShortcutRegistrationState::Conflict);
            Ok(shortcut_status(VoiceShortcutRegistrationState::Conflict))
        }
    }
}

#[tauri::command]
pub(crate) async fn voice_model_status(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceModelStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    Ok(state.voice.model_status().await)
}

#[tauri::command]
pub(crate) async fn voice_model_install(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceModelStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    state.voice.install_model(window.app_handle().clone()).await
}

#[tauri::command]
pub(crate) async fn voice_model_cancel_install(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceModelStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    state.voice.cancel_model_install().await;
    Ok(state.voice.model_status().await)
}

#[tauri::command]
pub(crate) async fn voice_model_remove(
    window: WebviewWindow,
    state: State<'_, crate::app_state::AppState>,
) -> Result<VoiceModelStatus, VoiceApiError> {
    ensure_main_window(&window)?;
    state.voice.remove_model().await
}

fn shortcut_status(status: VoiceShortcutRegistrationState) -> VoiceShortcutStatus {
    let hold_to_talk = VoiceShortcutAction {
        status,
        key: Some(HOLD_TO_TALK_SHORTCUT),
        message: match status {
            VoiceShortcutRegistrationState::Registered => {
                "Press and release support is registered for CmdOrCtrl+Shift+V."
            }
            VoiceShortcutRegistrationState::Unregistered => {
                "Register CmdOrCtrl+Shift+V to enable hold-to-talk."
            }
            VoiceShortcutRegistrationState::Conflict => {
                "CmdOrCtrl+Shift+V is already in use. Retry after releasing the conflicting shortcut."
            }
            VoiceShortcutRegistrationState::Unavailable => {
                "Global hold-to-talk shortcuts are unavailable on this platform."
            }
        },
    };
    VoiceShortcutStatus {
        hold_to_talk,
        assistant: VoiceShortcutAction {
            status: VoiceShortcutRegistrationState::Unavailable,
            key: None,
            message: "Phase 7 action is not started.",
        },
        quick_capture: VoiceShortcutAction {
            status: VoiceShortcutRegistrationState::Unavailable,
            key: None,
            message: "Phase 7 action is not started.",
        },
        agenda: VoiceShortcutAction {
            status: VoiceShortcutRegistrationState::Unavailable,
            key: None,
            message: "Phase 7 action is not started.",
        },
        widget: VoiceShortcutAction {
            status: VoiceShortcutRegistrationState::Unavailable,
            key: None,
            message: "Phase 7 action is not started.",
        },
    }
}

fn lock_runtime(runtime: &Mutex<VoiceRuntime>) -> std::sync::MutexGuard<'_, VoiceRuntime> {
    runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

enum FinishedTranscription {
    Terminal(VoiceSession),
    Transcript(VoiceTranscript),
}

enum DeadlineClaim {
    Ignored,
    TimedOut(VoiceSession),
    Transcribing {
        session: VoiceSession,
        cancel: watch::Receiver<bool>,
        audio: capture::CapturedAudio,
    },
}

fn finish_current_transcription(
    runtime: &mut VoiceRuntime,
    completed: &VoiceSession,
    result: Result<String, transcribe::TranscriptionError>,
) -> Option<FinishedTranscription> {
    let active = runtime.active.as_ref()?;
    if active.session.generation != completed.generation
        || active.session.session_id != completed.session_id
        || active.session.state != VoiceSessionState::Transcribing
    {
        return None;
    }

    let mut session = runtime.active.take()?.session;
    match result {
        Ok(text) => {
            let proposal = VoiceProposal {
                proposal_id: Uuid::new_v4().to_string(),
                text: sanitize_text(&text),
                mode: completed.mode,
                source: VoiceProposalSource::Voice,
            };
            let transcript = VoiceTranscript {
                generation: completed.generation,
                session_id: completed.session_id.clone(),
                proposal_id: proposal.proposal_id.clone(),
                transcript: proposal.text.clone(),
                mode: completed.mode,
                source: VoiceProposalSource::Voice,
            };
            insert_proposal(runtime, proposal);
            // A mounting quick-command renderer replays this matching transcribing state
            // before the bounded transcript, while `active` remains clear for the next start.
            runtime.replay_session = Some(session);
            runtime.replay_transcript = Some(transcript.clone());
            Some(FinishedTranscription::Transcript(transcript))
        }
        Err(error) => {
            session.state = if matches!(error, transcribe::TranscriptionError::Cancelled) {
                VoiceSessionState::Cancelled
            } else {
                VoiceSessionState::Unavailable
            };
            runtime.replay_session = Some(session.clone());
            runtime.replay_transcript = None;
            Some(FinishedTranscription::Terminal(session))
        }
    }
}

fn is_current_recording(active: &ActiveVoiceSession, expected: &VoiceSession) -> bool {
    active.session.generation == expected.generation
        && active.session.session_id == expected.session_id
        && active.session.state == VoiceSessionState::Recording
}

fn claim_deadline_completion(
    active: &mut ActiveVoiceSession,
    completion: capture::CaptureDeadlineCompletion,
) -> DeadlineClaim {
    if active.session.state != VoiceSessionState::Recording
        || completion.id.to_string() != active.session.session_id
    {
        return DeadlineClaim::Ignored;
    }
    if !deadline_audio_should_transcribe(&completion.audio) {
        active.session.state = VoiceSessionState::TimedOut;
        return DeadlineClaim::TimedOut(active.session.clone());
    }
    active.session.state = VoiceSessionState::Transcribing;
    DeadlineClaim::Transcribing {
        session: active.session.clone(),
        cancel: active.cancel.subscribe(),
        audio: completion.audio,
    }
}

fn deadline_audio_should_transcribe(audio: &capture::CapturedAudio) -> bool {
    audio.samples.len() >= capture::MIN_SAMPLES
}

fn insert_proposal(runtime: &mut VoiceRuntime, proposal: VoiceProposal) {
    if runtime.proposals.len() >= MAX_PROPOSALS {
        runtime.proposals.clear();
    }
    runtime
        .proposals
        .insert(proposal.proposal_id.clone(), proposal);
}

fn sanitize_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(MAX_PROPOSAL_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect()
}

fn safe_regular_file(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::events::VOICE_TRANSCRIPT;

    #[test]
    fn requests_reject_unknown_fields_and_unsupported_modes() {
        assert!(serde_json::from_value::<VoiceCaptureStartRequest>(json!({
            "mode": "assistant_command", "unexpected": true
        }))
        .is_err());
        assert!(serde_json::from_value::<VoiceTypedProposalRequest>(json!({
            "mode": "calendar_command", "text": "tomorrow"
        }))
        .is_err());
        assert!(serde_json::from_value::<VoiceProposalSubmitRequest>(json!({
            "proposalId": "x", "mode": "confirmation_response"
        }))
        .is_err());
    }

    #[test]
    fn authorization_is_exactly_window_scoped() {
        assert!(ensure_window_label(
            QUICK_COMMAND_WINDOW,
            QUICK_COMMAND_WINDOW
        ));
        assert!(!ensure_window_label(MAIN_WINDOW, QUICK_COMMAND_WINDOW));
        assert!(ensure_window_label(MAIN_WINDOW, MAIN_WINDOW));
        assert!(!ensure_window_label(QUICK_COMMAND_WINDOW, MAIN_WINDOW));
    }

    #[test]
    fn shortcut_events_require_successful_activation_before_a_new_session() {
        assert!(!should_emit_shortcut_events_after_activation(false, true));
        assert!(!should_emit_shortcut_events_after_activation(true, false));
        assert!(should_emit_shortcut_events_after_activation(true, true));
    }

    #[test]
    fn ready_snapshot_replays_only_the_current_generation_after_listeners_mount() {
        let state = VoiceState::new(std::path::PathBuf::new());
        let current = VoiceSession {
            generation: 9,
            session_id: "current-session".into(),
            state: VoiceSessionState::Transcribing,
            mode: VoiceMode::QuickCapture,
        };
        let stale = VoiceTranscript {
            generation: 8,
            session_id: "stale-session".into(),
            proposal_id: "stale-proposal".into(),
            transcript: "stale".into(),
            mode: VoiceMode::QuickCapture,
            source: VoiceProposalSource::Voice,
        };
        {
            let mut runtime = lock_runtime(&state.runtime);
            runtime.generation = current.generation;
            runtime.shortcut_pressed = true;
            runtime.active = Some(ActiveVoiceSession {
                session: current.clone(),
                cancel: watch::channel(false).0,
            });
            runtime.replay_transcript = Some(stale);
        }

        let ready = state.quick_command_ready();
        assert_eq!(ready.generation, current.generation);
        assert!(ready.shortcut_pressed);
        assert_eq!(ready.state.as_ref().unwrap().session_id, current.session_id);
        assert!(ready.transcript.is_none());
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            json!({
                "generation": 9,
                "shortcutPressed": true,
                "state": {
                    "generation": 9,
                    "sessionId": "current-session",
                    "state": "transcribing",
                    "mode": "quick_capture",
                    "source": "quick_command"
                }
            })
        );
    }

    #[test]
    fn deadline_only_transcribes_current_sessions_with_minimum_audio() {
        let capture_id = Uuid::new_v4();
        let expected = VoiceSession {
            generation: 4,
            session_id: capture_id.to_string(),
            state: VoiceSessionState::Recording,
            mode: VoiceMode::QuickCapture,
        };
        let mut active = ActiveVoiceSession {
            session: expected.clone(),
            cancel: watch::channel(false).0,
        };
        let later = VoiceSession {
            generation: 5,
            ..expected.clone()
        };
        assert!(is_current_recording(&active, &expected));
        assert!(!is_current_recording(&active, &later));
        assert!(!deadline_audio_should_transcribe(&capture::CapturedAudio {
            samples: vec![0; capture::MIN_SAMPLES - 1],
        }));
        assert!(deadline_audio_should_transcribe(&capture::CapturedAudio {
            samples: vec![0; capture::MIN_SAMPLES],
        }));
        let completion = capture::CaptureDeadlineCompletion {
            id: capture_id,
            audio: capture::CapturedAudio {
                samples: vec![0; capture::MIN_SAMPLES],
            },
        };
        assert!(matches!(
            claim_deadline_completion(&mut active, completion.clone()),
            DeadlineClaim::Transcribing { .. }
        ));
        // The deadline monitor and a Stop racing after the worker claim both call the
        // same transition; only the first can move this generation out of Recording.
        assert!(matches!(
            claim_deadline_completion(&mut active, completion),
            DeadlineClaim::Ignored
        ));
        assert_eq!(active.session.state, VoiceSessionState::Transcribing);
    }

    #[tokio::test]
    async fn successful_transcription_releases_the_active_session_for_a_fresh_generation() {
        let state = VoiceState::new(std::path::PathBuf::new());
        let first = VoiceSession {
            generation: 14,
            session_id: "first-session".into(),
            state: VoiceSessionState::Transcribing,
            mode: VoiceMode::QuickCapture,
        };
        {
            let mut runtime = lock_runtime(&state.runtime);
            runtime.generation = first.generation;
            runtime.active = Some(ActiveVoiceSession {
                session: first.clone(),
                cancel: watch::channel(false).0,
            });
        }

        let completed = finish_current_transcription(
            &mut lock_runtime(&state.runtime),
            &first,
            Ok("finished dictation".into()),
        );
        assert!(matches!(
            completed,
            Some(FinishedTranscription::Transcript(_))
        ));
        {
            let runtime = lock_runtime(&state.runtime);
            assert!(runtime.active.is_none());
            assert_eq!(
                runtime
                    .replay_transcript
                    .as_ref()
                    .map(|item| item.generation),
                Some(first.generation)
            );
        }

        let (next, started, _) = state.start(VoiceMode::AssistantCommand).await;
        assert!(started);
        assert!(next.generation > first.generation);
        assert_ne!(next.session_id, first.session_id);
    }

    #[test]
    fn late_transcription_completion_cannot_clear_a_newer_active_session() {
        let first = VoiceSession {
            generation: 20,
            session_id: "first-session".into(),
            state: VoiceSessionState::Transcribing,
            mode: VoiceMode::QuickCapture,
        };
        let second = VoiceSession {
            generation: 21,
            session_id: "second-session".into(),
            state: VoiceSessionState::Transcribing,
            mode: VoiceMode::AssistantCommand,
        };
        let mut runtime = VoiceRuntime {
            generation: second.generation,
            active: Some(ActiveVoiceSession {
                session: second.clone(),
                cancel: watch::channel(false).0,
            }),
            ..VoiceRuntime::default()
        };

        assert!(finish_current_transcription(&mut runtime, &first, Ok("late".into())).is_none());
        assert_eq!(
            runtime.active.as_ref().map(|active| &active.session),
            Some(&second)
        );
        assert!(runtime.replay_transcript.is_none());
    }

    #[tokio::test]
    async fn stale_session_cannot_stop_or_replace_current_generation() {
        let state = VoiceState::new(std::path::PathBuf::new());
        let (first, _, _) = state.start(VoiceMode::QuickCapture).await;
        state.cancel(&first.session_id).await;
        let (second, _, _) = state.start(VoiceMode::AssistantCommand).await;
        let stale = state.cancel(&first.session_id).await;
        assert_eq!(stale.state, VoiceSessionState::Cancelled);
        assert_eq!(stale.generation, second.generation);
        assert_eq!(
            state.cancel(&second.session_id).await.state,
            VoiceSessionState::Cancelled
        );
    }

    #[tokio::test]
    async fn shortcut_press_rejects_unregistered_events_and_reuses_active_generation() {
        let state = VoiceState::new(std::path::PathBuf::new());
        let (cancel, _) = watch::channel(false);
        lock_runtime(&state.runtime).active = Some(ActiveVoiceSession {
            session: VoiceSession {
                generation: 7,
                session_id: "active-session".into(),
                state: VoiceSessionState::Recording,
                mode: VoiceMode::QuickCapture,
            },
            cancel,
        });

        assert!(state.shortcut_press_session().await.is_none());
        state.set_shortcut_status(VoiceShortcutRegistrationState::Registered);
        let (session, started, _) = state.shortcut_press_session().await.unwrap();
        assert!(!started);
        assert_eq!(session.generation, 7);
        assert_eq!(session.session_id, "active-session");
        assert!(state.shortcut_registered());
        lock_runtime(&state.runtime)
            .active
            .as_mut()
            .unwrap()
            .session
            .state = VoiceSessionState::Transcribing;
        assert!(state.active_recording_session_id().is_none());
    }

    #[test]
    fn every_proposal_source_uses_the_same_hard_capacity() {
        let mut runtime = VoiceRuntime::default();
        for index in 0..=MAX_PROPOSALS {
            insert_proposal(
                &mut runtime,
                VoiceProposal {
                    proposal_id: format!("proposal-{index}"),
                    text: "bounded".into(),
                    mode: VoiceMode::QuickCapture,
                    source: VoiceProposalSource::Voice,
                },
            );
        }
        assert_eq!(runtime.proposals.len(), 1);
        assert!(runtime
            .proposals
            .contains_key(&format!("proposal-{MAX_PROPOSALS}")));
    }

    #[test]
    fn proposal_text_and_identifiers_are_sanitized_and_bounded() {
        let state = VoiceState::new(std::path::PathBuf::new());
        assert_eq!(sanitize_text(" hello\u{0000}\nworld "), "hello\nworld");
        assert_eq!(sanitize_id("../x\\bad*id"), "xbadid");
        assert!(serde_json::to_string(&state.status())
            .unwrap()
            .contains("available"));
        assert!(VOICE_TRANSCRIPT.starts_with("note://"));
    }

    fn ensure_window_label(actual: &str, expected: &str) -> bool {
        actual == expected
    }
}
