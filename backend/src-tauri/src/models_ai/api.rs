use std::sync::{Mutex, OnceLock};

use tauri::{Emitter, State, WebviewWindow};
use tokio::sync::watch;
use uuid::Uuid;

use crate::app_state::AppState;

use super::{
    client::{OllamaModel, ProviderClient},
    contracts::{
        ChatRequest, ChatResponse, CredentialMutationResponse, CredentialSetRequest, ExecutionMode,
        LegacyMigrationRequest, LegacyMigrationResponse, ManagedModelRequest, ModelProgressEvent,
        ModelProgressState, ModelsAiError, ModelsAiStateResponse, OllamaService,
        OllamaStatusResponse, ProviderIdRequest, ProviderKind, ProviderModelsResponse,
        ProviderTestResponse, ProviderTestStatus, SettingsSaveRequest, MANAGED_MODEL_ID,
        MANAGED_MODEL_RUNTIME_NAME, MAX_CHAT_AGGREGATE_BYTES, MAX_MESSAGES, MAX_MESSAGE_BYTES,
        OLLAMA_PROVIDER_ID,
    },
};

struct PullOperation {
    id: String,
    cancel: watch::Sender<bool>,
}
static ACTIVE_PULL: OnceLock<Mutex<Option<PullOperation>>> = OnceLock::new();
fn pulls() -> &'static Mutex<Option<PullOperation>> {
    ACTIVE_PULL.get_or_init(|| Mutex::new(None))
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), ModelsAiError> {
    ensure_main_window_label(window.label())
}
fn ensure_main_window_label(label: &str) -> Result<(), ModelsAiError> {
    if label == "main" {
        Ok(())
    } else {
        Err(ModelsAiError::forbidden_window())
    }
}
fn client() -> Result<ProviderClient, ModelsAiError> {
    ProviderClient::new()
}

fn enabled_provider(
    state: &AppState,
    id: &str,
) -> Result<super::contracts::ProviderDto, ModelsAiError> {
    state
        .models_ai
        .store
        .enabled_provider_snapshot(id)
        .map(|snapshot| snapshot.0)
}
fn base(provider: &super::contracts::ProviderDto) -> Result<&str, ModelsAiError> {
    provider
        .base_url
        .as_deref()
        .ok_or_else(ModelsAiError::unsupported)
}
fn validate_chat(request: &ChatRequest) -> Result<(), ModelsAiError> {
    if request.messages.is_empty() || request.messages.len() > MAX_MESSAGES {
        return Err(ModelsAiError::invalid("messages"));
    }
    let mut total = 0usize;
    for message in &request.messages {
        if message.content.trim().is_empty() || message.content.len() > MAX_MESSAGE_BYTES {
            return Err(ModelsAiError::invalid("messages"));
        }
        total = total.saturating_add(message.content.len());
    }
    if total > MAX_CHAT_AGGREGATE_BYTES {
        Err(ModelsAiError::invalid("messages"))
    } else {
        Ok(())
    }
}
fn require_managed(request: &ManagedModelRequest) -> Result<(), ModelsAiError> {
    if request.model_id == MANAGED_MODEL_ID {
        Ok(())
    } else {
        Err(ModelsAiError::model_not_managed())
    }
}
fn pull_id() -> Option<String> {
    pulls()
        .lock()
        .ok()
        .and_then(|pull| pull.as_ref().map(|entry| entry.id.clone()))
}

fn managed_digest(models: &[OllamaModel]) -> Option<&str> {
    models
        .iter()
        .find(|model| model.name == MANAGED_MODEL_RUNTIME_NAME)
        .and_then(|model| model.digest.as_deref())
}

fn managed_owned(models: &[OllamaModel], persisted_digest: Option<&str>) -> bool {
    persisted_digest.is_some_and(|expected| managed_digest(models) == Some(expected))
}

#[tauri::command]
pub(crate) async fn models_ai_state_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ModelsAiStateResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    state.models_ai.store.state()
}
#[tauri::command]
pub(crate) async fn models_ai_settings_save(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: SettingsSaveRequest,
) -> Result<ModelsAiStateResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    state.models_ai.store.save_settings(request)
}
#[tauri::command]
pub(crate) async fn models_ai_migrate_legacy(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: LegacyMigrationRequest,
) -> Result<LegacyMigrationResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    state.models_ai.store.migrate_legacy(request)
}
#[tauri::command]
pub(crate) async fn models_ai_credential_set(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CredentialSetRequest,
) -> Result<CredentialMutationResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    state
        .models_ai
        .store
        .set_credential(&request.provider_id, &request.credential)
}
#[tauri::command]
pub(crate) async fn models_ai_credential_delete(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ProviderIdRequest,
) -> Result<CredentialMutationResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    state
        .models_ai
        .store
        .delete_credential(&request.provider_id)
}

#[tauri::command]
pub(crate) async fn models_ai_provider_test(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ProviderIdRequest,
) -> Result<ProviderTestResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    let (provider, credential) = state
        .models_ai
        .store
        .enabled_provider_snapshot(&request.provider_id)?;
    let start = std::time::Instant::now();
    match provider.kind {
        ProviderKind::Ollama => {
            client()?.ollama_version(base(&provider)?).await?;
        }
        ProviderKind::OpenaiCompatible => {
            client()?
                .openai_models(base(&provider)?, credential.as_deref())
                .await?;
        }
        _ => return Err(ModelsAiError::unsupported()),
    }
    Ok(ProviderTestResponse {
        provider_id: provider.id,
        status: ProviderTestStatus::Reachable,
        latency_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
        message: "Provider is reachable.",
    })
}

#[tauri::command]
pub(crate) async fn models_ai_provider_list_models(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ProviderIdRequest,
) -> Result<ProviderModelsResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    let (provider, credential) = state
        .models_ai
        .store
        .enabled_provider_snapshot(&request.provider_id)?;
    let names = match provider.kind {
        ProviderKind::Ollama => client()?
            .ollama_models(base(&provider)?)
            .await?
            .into_iter()
            .map(|model| model.name)
            .collect(),
        ProviderKind::OpenaiCompatible => {
            client()?
                .openai_models(base(&provider)?, credential.as_deref())
                .await?
        }
        _ => return Err(ModelsAiError::unsupported()),
    };
    let (models, state_revision) = state
        .models_ai
        .store
        .replace_discovered_models(&provider.id, names)?;
    Ok(ProviderModelsResponse {
        provider_id: provider.id,
        models,
        state_revision,
    })
}

#[tauri::command]
pub(crate) async fn models_ai_chat(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ChatRequest,
) -> Result<ChatResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    validate_chat(&request)?;
    let (provider, credential) = state
        .models_ai
        .store
        .enabled_provider_snapshot(&request.provider_id)?;
    let model = state.models_ai.store.model(&request.model_id)?;
    if model.provider_id != provider.id || model.execution_mode != ExecutionMode::ChatOnly {
        return Err(ModelsAiError::model_not_found());
    }
    let content = match provider.kind {
        ProviderKind::Ollama => {
            if request.model_id != MANAGED_MODEL_ID && model.runtime_name.is_empty() {
                return Err(ModelsAiError::model_not_found());
            }
            client()?
                .ollama_chat(base(&provider)?, &model.runtime_name, &request.messages)
                .await?
        }
        ProviderKind::OpenaiCompatible => {
            client()?
                .openai_chat(
                    base(&provider)?,
                    &model.runtime_name,
                    &request.messages,
                    credential.as_deref(),
                )
                .await?
        }
        _ => return Err(ModelsAiError::unsupported()),
    };
    Ok(ChatResponse {
        provider_id: provider.id,
        model_id: model.id,
        content,
        execution_mode: ExecutionMode::ChatOnly,
    })
}

#[tauri::command]
pub(crate) async fn models_ai_ollama_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<OllamaStatusResponse, ModelsAiError> {
    let _timer = crate::performance::Timer::start(crate::performance::Operation::ModelStatus);
    ensure_main_window(&window)?;
    let provider = state.models_ai.store.provider(OLLAMA_PROVIDER_ID)?;
    let persisted_digest = state.models_ai.store.managed_digest()?;
    let operation_id = pull_id();
    match (
        client()?.ollama_version(base(&provider)?).await,
        client()?.ollama_models(base(&provider)?).await,
    ) {
        (Ok(version), Ok(models)) => {
            let installed = models
                .iter()
                .any(|model| model.name == MANAGED_MODEL_RUNTIME_NAME);
            let owned = managed_owned(&models, persisted_digest.as_deref());
            Ok(OllamaStatusResponse {
                service: OllamaService::Ready,
                version: Some(version),
                available_models: models.into_iter().map(|model| model.name).collect(),
                managed_model_installed: installed,
                managed_model_owned_by_note: owned,
                can_remove: installed && owned,
                pull_in_progress: operation_id.is_some(),
                operation_id,
                error: None,
            })
        }
        (Err(error), _) | (_, Err(error)) => Ok(OllamaStatusResponse {
            service: if matches!(
                error.code,
                super::contracts::ModelsAiErrorCode::ProviderInvalidResponse
                    | super::contracts::ModelsAiErrorCode::ProviderResponseTooLarge
            ) {
                OllamaService::Error
            } else {
                OllamaService::Unavailable
            },
            version: None,
            available_models: Vec::new(),
            managed_model_installed: false,
            managed_model_owned_by_note: false,
            can_remove: false,
            pull_in_progress: operation_id.is_some(),
            operation_id,
            error: Some(error),
        }),
    }
}

#[tauri::command]
pub(crate) async fn models_ai_ollama_pull(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ManagedModelRequest,
) -> Result<OllamaStatusResponse, ModelsAiError> {
    let _timer = crate::performance::Timer::start(crate::performance::Operation::ModelInstall);
    ensure_main_window(&window)?;
    require_managed(&request)?;
    let provider = enabled_provider(&state, OLLAMA_PROVIDER_ID)?;
    let base_url = base(&provider)?.to_owned();
    let client = client()?;
    let preflight_models = client.ollama_models(&base_url).await?;
    let installed = preflight_models
        .iter()
        .any(|model| model.name == MANAGED_MODEL_RUNTIME_NAME);
    if installed {
        // An already-installed model is external unless a prior successful pull
        // wrote the ownership marker; never infer ownership from its presence.
        if state.models_ai.store.managed_digest()?.as_deref() != managed_digest(&preflight_models) {
            state.models_ai.store.set_managed_digest(None)?;
        }
        return models_ai_ollama_status(window, state).await;
    }
    state.models_ai.store.set_managed_digest(None)?;
    let operation_id = Uuid::new_v4().to_string();
    let (sender, receiver) = watch::channel(false);
    {
        let mut active = pulls().lock().map_err(|_| ModelsAiError::pull_busy())?;
        if active.is_some() {
            return Err(ModelsAiError::pull_busy());
        }
        *active = Some(PullOperation {
            id: operation_id.clone(),
            cancel: sender,
        });
    }
    let emit = |state: ModelProgressState, error: Option<ModelsAiError>| {
        let _ = window.emit_to(
            "main",
            "note://model-progress",
            ModelProgressEvent {
                operation_id: operation_id.clone(),
                model_id: MANAGED_MODEL_ID.into(),
                state,
                completed_bytes: None,
                total_bytes: None,
                error,
            },
        );
    };
    emit(ModelProgressState::Starting, None);
    let result = client
        .ollama_pull_lines(
            &base_url,
            MANAGED_MODEL_RUNTIME_NAME,
            receiver,
            |completed_bytes, total_bytes| {
                let _ = window.emit_to(
                    "main",
                    "note://model-progress",
                    ModelProgressEvent {
                        operation_id: operation_id.clone(),
                        model_id: MANAGED_MODEL_ID.into(),
                        state: ModelProgressState::Downloading,
                        completed_bytes,
                        total_bytes,
                        error: None,
                    },
                );
                Ok(())
            },
        )
        .await;
    let final_result = if result.is_ok() {
        emit(ModelProgressState::Verifying, None);
        let verified_models = client.ollama_models(&base_url).await;
        let digest = verified_models
            .as_ref()
            .ok()
            .and_then(|models| managed_digest(models));
        let ownership = digest
            .ok_or_else(ModelsAiError::pull_failed)
            .and_then(|digest| state.models_ai.store.set_managed_digest(Some(digest)));
        match ownership {
            Ok(()) => {
                emit(ModelProgressState::Complete, None);
                Ok(())
            }
            Err(error) => {
                emit(ModelProgressState::Failed, Some(error.clone()));
                Err(error)
            }
        }
    } else if matches!(result, Err(ref error) if error.code == super::contracts::ModelsAiErrorCode::ModelPullCancelled)
    {
        emit(ModelProgressState::Cancelled, None);
        result
    } else {
        emit(
            ModelProgressState::Failed,
            Some(ModelsAiError::pull_failed()),
        );
        result
    };
    *pulls().lock().map_err(|_| ModelsAiError::pull_busy())? = None;
    final_result?;
    models_ai_ollama_status(window, state).await
}

#[tauri::command]
pub(crate) async fn models_ai_ollama_cancel_pull(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<OllamaStatusResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    let sender = {
        let active = pulls().lock().map_err(|_| ModelsAiError::pull_busy())?;
        active
            .as_ref()
            .map(|pull| pull.cancel.clone())
            .ok_or_else(ModelsAiError::pull_cancelled)?
    };
    let _ = sender.send(true);
    models_ai_ollama_status(window, state).await
}

#[tauri::command]
pub(crate) async fn models_ai_ollama_remove(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ManagedModelRequest,
) -> Result<OllamaStatusResponse, ModelsAiError> {
    ensure_main_window(&window)?;
    require_managed(&request)?;
    let expected_digest = state
        .models_ai
        .store
        .managed_digest()?
        .ok_or_else(ModelsAiError::model_not_owned)?;
    let provider = enabled_provider(&state, OLLAMA_PROVIDER_ID)?;
    let client = client()?;
    let installed_models = client.ollama_models(base(&provider)?).await?;
    if managed_digest(&installed_models) != Some(expected_digest.as_str()) {
        state.models_ai.store.set_managed_digest(None)?;
        return Err(ModelsAiError::model_not_owned());
    }
    client
        .ollama_delete(base(&provider)?, MANAGED_MODEL_RUNTIME_NAME)
        .await?;
    state.models_ai.store.set_managed_digest(None)?;
    models_ai_ollama_status(window, state).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_models_ai_command_is_main_only_at_native_boundary() {
        assert!(ensure_main_window_label("main").is_ok());
        assert_eq!(
            ensure_main_window_label("widget").unwrap_err(),
            ModelsAiError::forbidden_window()
        );
    }
    #[test]
    fn chat_limits_are_checked_before_network() {
        let request = ChatRequest {
            provider_id: "x".into(),
            model_id: "y".into(),
            messages: Vec::new(),
        };
        assert!(validate_chat(&request).is_err());
    }

    #[test]
    fn managed_provenance_requires_the_current_validated_digest() {
        let digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let model = |digest: Option<&str>| OllamaModel {
            name: MANAGED_MODEL_RUNTIME_NAME.into(),
            digest: digest.map(str::to_owned),
        };
        assert_eq!(managed_digest(&[model(Some(digest))]), Some(digest));
        assert_eq!(managed_digest(&[model(None)]), None);
        assert!(!managed_owned(&[model(Some(digest))], None));
        assert!(!managed_owned(&[model(None)], Some(digest)));
        assert!(!managed_owned(
            &[model(Some(digest))],
            Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        ));
        assert!(managed_owned(&[model(Some(digest))], Some(digest)));
        assert_ne!(
            managed_digest(&[model(Some(digest))]),
            Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        assert_eq!(
            managed_digest(&[OllamaModel {
                name: "external:latest".into(),
                digest: Some(digest.into())
            }]),
            None
        );
    }
}
