use serde::{Deserialize, Serialize};

pub(crate) const SCHEMA_VERSION: u8 = 1;
pub(crate) const OLLAMA_PROVIDER_ID: &str = "ollama-local";
pub(crate) const LLAMA_HARNESS_PROVIDER_ID: &str = "llama-harness";
pub(crate) const OPENAI_LOCAL_PROVIDER_ID: &str = "openai-compatible-local";
pub(crate) const NATIVE_WHISPER_PROVIDER_ID: &str = "native-whisper";
pub(crate) const MANAGED_MODEL_ID: &str = "ollama-local:lfm2.5-thinking:1.2b-q4_K_M";
pub(crate) const MANAGED_MODEL_RUNTIME_NAME: &str = "lfm2.5-thinking:1.2b-q4_K_M";
pub(crate) const MANAGED_MODEL_NAME: &str = "LFM2.5 Thinking 1.2B";
pub(crate) const MANAGED_MODEL_EXPECTED_BYTES: u64 = 731_000_000;

pub(crate) const MAX_PROVIDERS: usize = 32;
pub(crate) const MAX_MODELS: usize = 256;
pub(crate) const MAX_MESSAGES: usize = 32;
pub(crate) const MAX_ID_BYTES: usize = 160;
pub(crate) const MAX_NAME_BYTES: usize = 256;
pub(crate) const MAX_URL_BYTES: usize = 2_048;
pub(crate) const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
pub(crate) const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_CHAT_AGGREGATE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderKind {
    Ollama,
    LlamaHarness,
    OpenaiCompatible,
    SpeechToText,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DataSharing {
    Local,
    Remote,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ManagedRemoval {
    NoteManagedOnly,
    NotSupported,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StructuredToolSupport {
    Reliable,
    Unverified,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionMode {
    Tools,
    ChatOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChatRole {
    System,
    User,
    Assistant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderTestStatus {
    Reachable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OllamaService {
    Ready,
    Unavailable,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelProgressState {
    Starting,
    Downloading,
    Verifying,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MigrationStatus {
    Completed,
    AlreadyCompleted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelsAiErrorCode {
    ForbiddenWindow,
    InvalidRequest,
    RevisionConflict,
    StorageUnavailable,
    ProviderNotFound,
    ProviderDisabled,
    ProviderUnsupported,
    InsecureTransport,
    CredentialUnavailable,
    ProviderUnavailable,
    ProviderTimeout,
    ProviderInvalidResponse,
    ProviderResponseTooLarge,
    ModelNotFound,
    ModelNotManaged,
    ModelNotOwned,
    ModelPullBusy,
    ModelPullCancelled,
    ModelPullFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelsAiError {
    pub(crate) code: ModelsAiErrorCode,
    pub(crate) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) field: Option<&'static str>,
}

impl ModelsAiError {
    pub(crate) const fn new(
        code: ModelsAiErrorCode,
        message: &'static str,
        field: Option<&'static str>,
    ) -> Self {
        Self {
            code,
            message,
            field,
        }
    }

    pub(crate) const fn forbidden_window() -> Self {
        Self::new(
            ModelsAiErrorCode::ForbiddenWindow,
            "This window cannot access AI model settings.",
            None,
        )
    }

    pub(crate) const fn invalid(field: &'static str) -> Self {
        Self::new(
            ModelsAiErrorCode::InvalidRequest,
            "The AI model request is invalid or exceeds a safety limit.",
            Some(field),
        )
    }

    pub(crate) const fn revision_conflict() -> Self {
        Self::new(
            ModelsAiErrorCode::RevisionConflict,
            "AI settings changed. Reload them before saving again.",
            Some("expectedRevision"),
        )
    }

    pub(crate) const fn storage() -> Self {
        Self::new(
            ModelsAiErrorCode::StorageUnavailable,
            "AI model settings could not be stored safely.",
            None,
        )
    }

    pub(crate) const fn provider_not_found() -> Self {
        Self::new(
            ModelsAiErrorCode::ProviderNotFound,
            "The selected AI provider is unavailable.",
            Some("providerId"),
        )
    }

    pub(crate) const fn provider_disabled() -> Self {
        Self::new(
            ModelsAiErrorCode::ProviderDisabled,
            "Enable the selected AI provider before using it.",
            Some("providerId"),
        )
    }

    pub(crate) const fn unsupported() -> Self {
        Self::new(
            ModelsAiErrorCode::ProviderUnsupported,
            "This provider is not available through Note's native model service.",
            Some("providerId"),
        )
    }

    pub(crate) const fn insecure_transport() -> Self {
        Self::new(
            ModelsAiErrorCode::InsecureTransport,
            "Remote OpenAI-compatible providers must use HTTPS.",
            Some("baseUrl"),
        )
    }

    pub(crate) const fn credential() -> Self {
        Self::new(
            ModelsAiErrorCode::CredentialUnavailable,
            "The provider credential could not be stored or read safely.",
            None,
        )
    }

    pub(crate) const fn unavailable() -> Self {
        Self::new(
            ModelsAiErrorCode::ProviderUnavailable,
            "The AI provider is not reachable.",
            None,
        )
    }

    pub(crate) const fn timeout() -> Self {
        Self::new(
            ModelsAiErrorCode::ProviderTimeout,
            "The AI provider did not respond within Note's time limit.",
            None,
        )
    }

    pub(crate) const fn invalid_response() -> Self {
        Self::new(
            ModelsAiErrorCode::ProviderInvalidResponse,
            "The AI provider returned an invalid response.",
            None,
        )
    }

    pub(crate) const fn response_too_large() -> Self {
        Self::new(
            ModelsAiErrorCode::ProviderResponseTooLarge,
            "The AI provider response exceeded Note's safety limit.",
            None,
        )
    }

    pub(crate) const fn model_not_found() -> Self {
        Self::new(
            ModelsAiErrorCode::ModelNotFound,
            "The selected AI model is unavailable.",
            Some("modelId"),
        )
    }

    pub(crate) const fn model_not_managed() -> Self {
        Self::new(
            ModelsAiErrorCode::ModelNotManaged,
            "Note can only install or remove its pinned Ollama model.",
            Some("modelId"),
        )
    }

    pub(crate) const fn model_not_owned() -> Self {
        Self::new(
            ModelsAiErrorCode::ModelNotOwned,
            "Note will not remove a model it did not install.",
            Some("modelId"),
        )
    }

    pub(crate) const fn pull_busy() -> Self {
        Self::new(
            ModelsAiErrorCode::ModelPullBusy,
            "A Note-managed model download is already running.",
            None,
        )
    }

    pub(crate) const fn pull_cancelled() -> Self {
        Self::new(
            ModelsAiErrorCode::ModelPullCancelled,
            "The model download was cancelled.",
            None,
        )
    }

    pub(crate) const fn pull_failed() -> Self {
        Self::new(
            ModelsAiErrorCode::ModelPullFailed,
            "Ollama could not download the Note-managed model.",
            None,
        )
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ProviderCapabilities {
    pub(crate) chat: bool,
    pub(crate) embeddings: bool,
    pub(crate) speech_to_text: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDto {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: ProviderKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) base_url: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) data_sharing: DataSharing,
    pub(crate) credential_configured: bool,
    pub(crate) capabilities: ProviderCapabilities,
    pub(crate) managed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ModelCapabilities {
    pub(crate) chat: bool,
    pub(crate) embeddings: bool,
    pub(crate) vision: bool,
    pub(crate) speech_to_text: bool,
    pub(crate) streaming: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ModelLicense {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ModelDto {
    pub(crate) id: String,
    pub(crate) provider_id: String,
    pub(crate) runtime_name: String,
    pub(crate) name: String,
    pub(crate) capabilities: ModelCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) context_window_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) estimated_memory_bytes: Option<u64>,
    pub(crate) platforms: Vec<String>,
    pub(crate) license: ModelLicense,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_download_bytes: Option<u64>,
    pub(crate) managed_removal: ManagedRemoval,
    pub(crate) owned_by_note: bool,
    pub(crate) structured_tool_support: StructuredToolSupport,
    pub(crate) execution_mode: ExecutionMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelsAiStateResponse {
    pub(crate) schema_version: u8,
    pub(crate) revision: u64,
    pub(crate) legacy_migration_completed: bool,
    pub(crate) providers: Vec<ProviderDto>,
    pub(crate) models: Vec<ModelDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_chat_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_embedding_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) selected_llama_harness_agent_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ProviderSettingsInput {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: ProviderKind,
    pub(crate) base_url: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) data_sharing: DataSharing,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SettingsSaveRequest {
    pub(crate) expected_revision: u64,
    pub(crate) default_chat_model_id: Option<String>,
    pub(crate) default_embedding_model_id: Option<String>,
    pub(crate) selected_llama_harness_agent_id: Option<String>,
    pub(crate) providers: Vec<ProviderSettingsInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CredentialSetRequest {
    pub(crate) provider_id: String,
    pub(crate) credential: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ProviderIdRequest {
    pub(crate) provider_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialMutationResponse {
    pub(crate) provider_id: String,
    pub(crate) credential_configured: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LegacyCredentialInput {
    pub(crate) provider_id: String,
    pub(crate) credential: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LegacyProviderKind {
    Ollama,
    LmStudio,
    OpenaiCompatible,
    Openai,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LegacyProviderInput {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) kind: LegacyProviderKind,
    pub(crate) base_url: String,
    pub(crate) enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LegacyModelCapabilities {
    pub(crate) chat: bool,
    pub(crate) embeddings: bool,
    pub(crate) vision: bool,
    pub(crate) tools: bool,
    pub(crate) streaming: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LegacyModelInput {
    pub(crate) id: String,
    pub(crate) provider_id: String,
    pub(crate) name: String,
    pub(crate) capabilities: LegacyModelCapabilities,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LegacySettingsInput {
    pub(crate) default_chat_model_id: Option<String>,
    pub(crate) default_embedding_model_id: Option<String>,
    pub(crate) providers: Vec<LegacyProviderInput>,
    pub(crate) models: Vec<LegacyModelInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LegacyMigrationRequest {
    pub(crate) legacy_settings: Option<LegacySettingsInput>,
    pub(crate) legacy_credentials: Vec<LegacyCredentialInput>,
    pub(crate) selected_llama_harness_agent_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyMigrationResponse {
    pub(crate) status: MigrationStatus,
    pub(crate) migrated_provider_ids: Vec<String>,
    pub(crate) migrated_credential_provider_ids: Vec<String>,
    pub(crate) state: ModelsAiStateResponse,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderTestResponse {
    pub(crate) provider_id: String,
    pub(crate) status: ProviderTestStatus,
    pub(crate) latency_ms: u64,
    pub(crate) message: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderModelsResponse {
    pub(crate) provider_id: String,
    pub(crate) models: Vec<ModelDto>,
    pub(crate) state_revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ChatMessageInput {
    pub(crate) role: ChatRole,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ChatRequest {
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) messages: Vec<ChatMessageInput>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatResponse {
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) content: String,
    pub(crate) execution_mode: ExecutionMode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ManagedModelRequest {
    pub(crate) model_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OllamaStatusResponse {
    pub(crate) service: OllamaService,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    pub(crate) available_models: Vec<String>,
    pub(crate) managed_model_installed: bool,
    pub(crate) managed_model_owned_by_note: bool,
    pub(crate) can_remove: bool,
    pub(crate) pull_in_progress: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<ModelsAiError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProgressEvent {
    pub(crate) operation_id: String,
    pub(crate) model_id: String,
    pub(crate) state: ModelProgressState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) completed_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<ModelsAiError>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn requests_are_strict_and_chat_rejects_tool_injection() {
        assert!(serde_json::from_value::<SettingsSaveRequest>(json!({
            "expectedRevision": 1,
            "providers": [],
            "models": []
        }))
        .is_err());
        assert!(serde_json::from_value::<ChatRequest>(json!({
            "providerId": OLLAMA_PROVIDER_ID,
            "modelId": MANAGED_MODEL_ID,
            "messages": [{"role":"user","content":"hello"}],
            "tools": []
        }))
        .is_err());
        assert!(serde_json::from_value::<CredentialSetRequest>(json!({
            "providerId": OPENAI_LOCAL_PROVIDER_ID,
            "credential": "secret",
            "echo": true
        }))
        .is_err());
    }

    #[test]
    fn managed_model_manifest_serializes_exact_identity_and_honest_tool_state() {
        let model = crate::models_ai::store::managed_model(false);
        assert_eq!(model.id, MANAGED_MODEL_ID);
        assert_eq!(model.runtime_name, MANAGED_MODEL_RUNTIME_NAME);
        assert_eq!(model.name, MANAGED_MODEL_NAME);
        assert_eq!(model.expected_download_bytes, Some(731_000_000));
        assert_eq!(model.context_window_tokens, None);
        assert_eq!(model.estimated_memory_bytes, None);
        assert_eq!(
            model.structured_tool_support,
            StructuredToolSupport::Unverified
        );
        assert_eq!(model.execution_mode, ExecutionMode::ChatOnly);
    }

    #[test]
    fn errors_are_static_structured_and_secret_free() {
        let secret = "sk-should-never-serialize";
        for error in [
            ModelsAiError::credential(),
            ModelsAiError::invalid_response(),
            ModelsAiError::storage(),
        ] {
            let serialized = serde_json::to_string(&error).unwrap();
            assert!(!serialized.contains(secret));
            assert!(!serialized.contains('/') && !serialized.contains('\\'));
        }
    }
}
