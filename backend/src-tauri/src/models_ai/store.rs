use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::private_file::atomic_write_private;

use super::{
    client::validate_provider_endpoint,
    contracts::{
        CredentialMutationResponse, DataSharing, ExecutionMode, LegacyMigrationRequest,
        LegacyMigrationResponse, LegacyProviderKind, ManagedRemoval, MigrationStatus,
        ModelCapabilities, ModelDto, ModelLicense, ModelsAiError, ModelsAiStateResponse,
        ProviderCapabilities, ProviderDto, ProviderKind, ProviderSettingsInput,
        SettingsSaveRequest, StructuredToolSupport, LLAMA_HARNESS_PROVIDER_ID,
        MANAGED_MODEL_EXPECTED_BYTES, MANAGED_MODEL_ID, MANAGED_MODEL_NAME,
        MANAGED_MODEL_RUNTIME_NAME, MAX_CREDENTIAL_BYTES, MAX_ID_BYTES, MAX_MODELS, MAX_NAME_BYTES,
        MAX_PROVIDERS, NATIVE_WHISPER_PROVIDER_ID, OLLAMA_PROVIDER_ID, OPENAI_LOCAL_PROVIDER_ID,
        SCHEMA_VERSION,
    },
};

const SETTINGS_FILE: &str = "models-ai-settings.v1.json";
const CREDENTIALS_FILE: &str = "models-ai-credentials.v1.json";
const MAX_SETTINGS_FILE_BYTES: usize = 512 * 1024;
const MAX_CREDENTIALS_FILE_BYTES: usize = 256 * 1024;

pub(crate) trait CredentialStore: Send + Sync {
    fn get(&self, provider_id: &str, fingerprint: &str) -> Result<Option<String>, ModelsAiError>;
    fn set(
        &self,
        provider_id: &str,
        fingerprint: &str,
        credential: &str,
    ) -> Result<(), ModelsAiError>;
    fn delete(&self, provider_id: &str) -> Result<(), ModelsAiError>;
}

/// An app-private atomic file keeps credentials outside every renderer and
/// auxiliary window. It deliberately does not claim OS-keychain protection.
pub(crate) struct AtomicFileCredentialStore {
    path: PathBuf,
    gate: Mutex<()>,
}

impl AtomicFileCredentialStore {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            gate: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<CredentialFile, ModelsAiError> {
        let file = read_json_file(&self.path, MAX_CREDENTIALS_FILE_BYTES)?.map_or_else(
            || Ok(CredentialFile::default()),
            |bytes| serde_json::from_slice(&bytes).map_err(|_| ModelsAiError::credential()),
        )?;
        validate_credential_file(&file)?;
        Ok(file)
    }

    fn write(&self, credentials: &CredentialFile) -> Result<(), ModelsAiError> {
        let bytes = serde_json::to_vec(credentials).map_err(|_| ModelsAiError::credential())?;
        if bytes.len() > MAX_CREDENTIALS_FILE_BYTES {
            return Err(ModelsAiError::credential());
        }
        ensure_parent(&self.path).map_err(|_| ModelsAiError::credential())?;
        atomic_write_private(&self.path, &bytes).map_err(|_| ModelsAiError::credential())
    }
}

impl CredentialStore for AtomicFileCredentialStore {
    fn get(&self, provider_id: &str, fingerprint: &str) -> Result<Option<String>, ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::credential())?;
        match self.read()?.credentials.get(provider_id) {
            Some(binding) if binding.endpoint_fingerprint == fingerprint => {
                Ok(Some(binding.credential.clone()))
            }
            Some(_) => Err(ModelsAiError::credential()),
            None => Ok(None),
        }
    }

    fn set(
        &self,
        provider_id: &str,
        fingerprint: &str,
        credential: &str,
    ) -> Result<(), ModelsAiError> {
        validate_id(provider_id, "providerId")?;
        validate_fingerprint(fingerprint)?;
        let credential = credential.trim();
        if credential.is_empty() || credential.len() > MAX_CREDENTIAL_BYTES {
            return Err(ModelsAiError::invalid("credential"));
        }
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::credential())?;
        let mut file = self.read()?;
        file.credentials.insert(
            provider_id.to_owned(),
            CredentialBinding {
                endpoint_fingerprint: fingerprint.to_owned(),
                credential: credential.to_owned(),
            },
        );
        self.write(&file)?;
        let verified = self.read()?.credentials.get(provider_id).cloned();
        if verified.as_ref().is_some_and(|binding| {
            binding.endpoint_fingerprint == fingerprint && binding.credential == credential
        }) {
            Ok(())
        } else {
            Err(ModelsAiError::credential())
        }
    }

    fn delete(&self, provider_id: &str) -> Result<(), ModelsAiError> {
        validate_id(provider_id, "providerId")?;
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::credential())?;
        let mut file = self.read()?;
        file.credentials.remove(provider_id);
        self.write(&file)?;
        if self.read()?.credentials.contains_key(provider_id) {
            Err(ModelsAiError::credential())
        } else {
            Ok(())
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CredentialFile {
    schema_version: u8,
    credentials: BTreeMap<String, CredentialBinding>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CredentialBinding {
    endpoint_fingerprint: String,
    credential: String,
}

impl Default for CredentialFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            credentials: BTreeMap::new(),
        }
    }
}

pub(crate) struct ModelsAiStore {
    settings_path: PathBuf,
    credentials: Arc<dyn CredentialStore>,
    gate: Mutex<()>,
}

impl ModelsAiStore {
    pub(crate) fn new(app_data_dir: &Path) -> Self {
        Self {
            settings_path: app_data_dir.join(SETTINGS_FILE),
            credentials: Arc::new(AtomicFileCredentialStore::new(
                app_data_dir.join(CREDENTIALS_FILE),
            )),
            gate: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_credentials(
        app_data_dir: &Path,
        credentials: Arc<dyn CredentialStore>,
    ) -> Self {
        Self {
            settings_path: app_data_dir.join(SETTINGS_FILE),
            credentials,
            gate: Mutex::new(()),
        }
    }

    pub(crate) fn state(&self) -> Result<ModelsAiStateResponse, ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        self.response(&self.read_settings()?)
    }

    pub(crate) fn save_settings(
        &self,
        request: SettingsSaveRequest,
    ) -> Result<ModelsAiStateResponse, ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        let mut current = self.read_settings()?;
        if request.expected_revision != current.revision {
            return Err(ModelsAiError::revision_conflict());
        }
        let providers = validate_provider_settings(request.providers)?;
        for existing in &current.providers {
            let fingerprint = provider_fingerprint(existing)?;
            if self.credentials.get(&existing.id, &fingerprint)?.is_some() {
                let replacement = providers
                    .iter()
                    .find(|provider| provider.id == existing.id)
                    .ok_or_else(|| ModelsAiError::invalid("providers"))?;
                if provider_fingerprint(replacement)? != fingerprint {
                    return Err(ModelsAiError::invalid("providers"));
                }
            }
        }
        validate_optional_id(
            request.default_chat_model_id.as_deref(),
            "defaultChatModelId",
        )?;
        validate_optional_id(
            request.default_embedding_model_id.as_deref(),
            "defaultEmbeddingModelId",
        )?;
        validate_optional_id(
            request.selected_llama_harness_agent_id.as_deref(),
            "selectedLlamaHarnessAgentId",
        )?;
        let models = current
            .models(current.managed_ollama_digest.is_some())
            .into_iter()
            .map(|model| (model.id.clone(), model))
            .collect::<BTreeMap<_, _>>();
        validate_default_models(
            request.default_chat_model_id.as_deref(),
            request.default_embedding_model_id.as_deref(),
            &models,
        )?;
        current.revision = next_revision(current.revision)?;
        current.providers = providers;
        current.default_chat_model_id = request.default_chat_model_id;
        current.default_embedding_model_id = request.default_embedding_model_id;
        current.selected_llama_harness_agent_id = request.selected_llama_harness_agent_id;
        self.write_settings(&current)?;
        self.response(&current)
    }

    pub(crate) fn migrate_legacy(
        &self,
        request: LegacyMigrationRequest,
    ) -> Result<LegacyMigrationResponse, ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        let mut current = self.read_settings()?;
        if current.legacy_migration_completed {
            return Ok(LegacyMigrationResponse {
                status: MigrationStatus::AlreadyCompleted,
                migrated_provider_ids: Vec::new(),
                migrated_credential_provider_ids: Vec::new(),
                state: self.response(&current)?,
            });
        }
        if request.legacy_credentials.len() > MAX_PROVIDERS {
            return Err(ModelsAiError::invalid("legacyCredentials"));
        }

        let mut migrated_provider_ids = Vec::new();
        let mut legacy_id_map = BTreeMap::new();
        let mut legacy_model_id_map = BTreeMap::new();
        if let Some(settings) = request.legacy_settings {
            if settings.providers.len() > MAX_PROVIDERS || settings.models.len() > MAX_MODELS {
                return Err(ModelsAiError::invalid("legacySettings"));
            }
            let mut providers = builtin_provider_settings();
            for legacy in settings.providers {
                validate_id(&legacy.id, "legacySettings")?;
                validate_name(&legacy.name, "legacySettings")?;
                let target_id = match legacy.kind {
                    LegacyProviderKind::Ollama => OLLAMA_PROVIDER_ID.to_owned(),
                    LegacyProviderKind::LmStudio
                    | LegacyProviderKind::OpenaiCompatible
                    | LegacyProviderKind::Openai => legacy.id.clone(),
                };
                legacy_id_map.insert(legacy.id.clone(), target_id.clone());
                if target_id == OLLAMA_PROVIDER_ID {
                    providers[0].enabled = legacy.enabled;
                } else {
                    let data_sharing = validate_provider_endpoint(&legacy.base_url)?;
                    providers.push(ProviderSettingsInput {
                        id: target_id.clone(),
                        name: legacy.name,
                        kind: ProviderKind::OpenaiCompatible,
                        base_url: Some(legacy.base_url),
                        enabled: legacy.enabled,
                        data_sharing,
                    });
                }
                migrated_provider_ids.push(target_id);
            }
            current.providers = validate_provider_settings(providers)?;
            let provider_ids = current
                .providers
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<BTreeSet<_>>();
            current.discovered_models.clear();
            for legacy in settings.models {
                let _ = legacy.capabilities.tools;
                validate_id(&legacy.id, "legacySettings")?;
                validate_name(&legacy.name, "legacySettings")?;
                let legacy_provider_id = legacy.provider_id.clone();
                let provider_id = legacy_id_map
                    .get(&legacy_provider_id)
                    .cloned()
                    .unwrap_or_else(|| legacy_provider_id.clone());
                if !provider_ids.contains(provider_id.as_str()) {
                    return Err(ModelsAiError::invalid("legacySettings"));
                }
                let runtime_name = legacy_runtime_name(&legacy.id, &legacy_provider_id)?;
                if provider_id == OLLAMA_PROVIDER_ID
                    && (runtime_name == MANAGED_MODEL_RUNTIME_NAME || legacy.id == MANAGED_MODEL_ID)
                {
                    legacy_model_id_map.insert(legacy.id, MANAGED_MODEL_ID.to_owned());
                    continue;
                }
                let model = discovered_model(
                    &provider_id,
                    &runtime_name,
                    &legacy.name,
                    ModelCapabilities {
                        chat: legacy.capabilities.chat,
                        embeddings: legacy.capabilities.embeddings,
                        vision: legacy.capabilities.vision,
                        speech_to_text: false,
                        streaming: legacy.capabilities.streaming,
                    },
                )?;
                legacy_model_id_map.insert(legacy.id, model.id.clone());
                current.discovered_models.push(model);
            }
            current.default_chat_model_id =
                map_legacy_model_id(settings.default_chat_model_id, &legacy_model_id_map);
            current.default_embedding_model_id =
                map_legacy_model_id(settings.default_embedding_model_id, &legacy_model_id_map);
        }
        current.selected_llama_harness_agent_id = request.selected_llama_harness_agent_id;
        validate_optional_id(
            current.selected_llama_harness_agent_id.as_deref(),
            "selectedLlamaHarnessAgentId",
        )?;

        let provider_ids = current
            .providers
            .iter()
            .map(|provider| provider.id.as_str())
            .collect::<BTreeSet<_>>();
        let openai_ids = current
            .providers
            .iter()
            .filter(|provider| provider.kind == ProviderKind::OpenaiCompatible)
            .map(|provider| provider.id.as_str())
            .collect::<BTreeSet<_>>();
        let mut seen_credentials = BTreeSet::new();
        let mut validated_credentials = Vec::with_capacity(request.legacy_credentials.len());
        for legacy in request.legacy_credentials {
            let provider_id = legacy_id_map
                .get(&legacy.provider_id)
                .cloned()
                .unwrap_or(legacy.provider_id);
            if !provider_ids.contains(provider_id.as_str())
                || !openai_ids.contains(provider_id.as_str())
                || !seen_credentials.insert(provider_id.clone())
            {
                return Err(ModelsAiError::invalid("legacyCredentials"));
            }
            let credential = legacy.credential.trim();
            if credential.is_empty() || credential.len() > MAX_CREDENTIAL_BYTES {
                return Err(ModelsAiError::invalid("legacyCredentials"));
            }
            validated_credentials.push((provider_id, credential.to_owned()));
        }
        let mut migrated_credential_provider_ids = Vec::with_capacity(validated_credentials.len());
        for (provider_id, credential) in validated_credentials {
            let provider = current
                .providers
                .iter()
                .find(|provider| provider.id == provider_id)
                .ok_or_else(ModelsAiError::provider_not_found)?;
            self.credentials
                .set(&provider_id, &provider_fingerprint(provider)?, &credential)?;
            migrated_credential_provider_ids.push(provider_id);
        }
        current.revision = next_revision(current.revision)?;
        current.legacy_migration_completed = true;
        self.write_settings(&current)?;
        migrated_provider_ids.sort();
        migrated_provider_ids.dedup();
        migrated_credential_provider_ids.sort();
        Ok(LegacyMigrationResponse {
            status: MigrationStatus::Completed,
            migrated_provider_ids,
            migrated_credential_provider_ids,
            state: self.response(&current)?,
        })
    }

    pub(crate) fn set_credential(
        &self,
        provider_id: &str,
        credential: &str,
    ) -> Result<CredentialMutationResponse, ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        let settings = self.read_settings()?;
        ensure_credential_provider(&settings, provider_id)?;
        let provider = settings
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(ModelsAiError::provider_not_found)?;
        self.credentials
            .set(provider_id, &provider_fingerprint(provider)?, credential)?;
        Ok(CredentialMutationResponse {
            provider_id: provider_id.to_owned(),
            credential_configured: true,
        })
    }

    pub(crate) fn delete_credential(
        &self,
        provider_id: &str,
    ) -> Result<CredentialMutationResponse, ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        let settings = self.read_settings()?;
        ensure_credential_provider(&settings, provider_id)?;
        self.credentials.delete(provider_id)?;
        Ok(CredentialMutationResponse {
            provider_id: provider_id.to_owned(),
            credential_configured: false,
        })
    }

    pub(crate) fn provider(&self, provider_id: &str) -> Result<ProviderDto, ModelsAiError> {
        self.state()?
            .providers
            .into_iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(ModelsAiError::provider_not_found)
    }

    pub(crate) fn enabled_provider_snapshot(
        &self,
        provider_id: &str,
    ) -> Result<(ProviderDto, Option<String>), ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        let settings = self.read_settings()?;
        let provider = settings
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(ModelsAiError::provider_not_found)?;
        if !provider.enabled {
            return Err(ModelsAiError::provider_disabled());
        }
        let fingerprint = provider_fingerprint(provider)?;
        let credential = self.credentials.get(provider_id, &fingerprint)?;
        Ok((provider_dto(provider, credential.is_some()), credential))
    }

    pub(crate) fn model(&self, model_id: &str) -> Result<ModelDto, ModelsAiError> {
        self.state()?
            .models
            .into_iter()
            .find(|model| model.id == model_id)
            .ok_or_else(ModelsAiError::model_not_found)
    }

    pub(crate) fn replace_discovered_models(
        &self,
        provider_id: &str,
        runtime_names: Vec<String>,
    ) -> Result<(Vec<ModelDto>, u64), ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        let mut settings = self.read_settings()?;
        if !settings
            .providers
            .iter()
            .any(|provider| provider.id == provider_id)
        {
            return Err(ModelsAiError::provider_not_found());
        }
        let mut unique = BTreeSet::new();
        let mut replacement = Vec::new();
        for runtime_name in runtime_names {
            if unique.insert(runtime_name.clone()) {
                if provider_id == OLLAMA_PROVIDER_ID && runtime_name == MANAGED_MODEL_RUNTIME_NAME {
                    continue;
                }
                replacement.push(discovered_model(
                    provider_id,
                    &runtime_name,
                    &runtime_name,
                    ModelCapabilities {
                        chat: true,
                        embeddings: false,
                        vision: false,
                        speech_to_text: false,
                        streaming: false,
                    },
                )?);
            }
        }
        if replacement.len() > MAX_MODELS {
            return Err(ModelsAiError::invalid("models"));
        }
        settings
            .discovered_models
            .retain(|model| model.provider_id != provider_id);
        settings.discovered_models.extend(replacement);
        settings.revision = next_revision(settings.revision)?;
        self.write_settings(&settings)?;
        let models = settings
            .models(settings.managed_ollama_digest.is_some())
            .into_iter()
            .filter(|model| model.provider_id == provider_id)
            .collect();
        Ok((models, settings.revision))
    }

    pub(crate) fn managed_digest(&self) -> Result<Option<String>, ModelsAiError> {
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        Ok(self.read_settings()?.managed_ollama_digest)
    }

    pub(crate) fn set_managed_digest(&self, digest: Option<&str>) -> Result<(), ModelsAiError> {
        if digest.is_some_and(invalid_digest) {
            return Err(ModelsAiError::storage());
        }
        let _guard = self.gate.lock().map_err(|_| ModelsAiError::storage())?;
        let mut settings = self.read_settings()?;
        if settings.managed_ollama_digest.as_deref() != digest {
            settings.managed_ollama_digest = digest.map(str::to_owned);
            settings.managed_ollama_owned = false;
            settings.revision = next_revision(settings.revision)?;
            self.write_settings(&settings)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn set_managed_owned(&self, owned: bool) -> Result<(), ModelsAiError> {
        self.set_managed_digest(
            owned.then_some(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        )
    }

    fn read_settings(&self) -> Result<SettingsFile, ModelsAiError> {
        let settings = read_json_file(&self.settings_path, MAX_SETTINGS_FILE_BYTES)?.map_or_else(
            || Ok(SettingsFile::default()),
            |bytes| serde_json::from_slice(&bytes).map_err(|_| ModelsAiError::storage()),
        )?;
        validate_settings_file(&settings)?;
        Ok(settings)
    }

    fn write_settings(&self, settings: &SettingsFile) -> Result<(), ModelsAiError> {
        validate_settings_file(settings)?;
        let bytes = serde_json::to_vec(settings).map_err(|_| ModelsAiError::storage())?;
        if bytes.len() > MAX_SETTINGS_FILE_BYTES {
            return Err(ModelsAiError::storage());
        }
        ensure_parent(&self.settings_path).map_err(|_| ModelsAiError::storage())?;
        atomic_write_private(&self.settings_path, &bytes).map_err(|_| ModelsAiError::storage())
    }

    fn response(&self, settings: &SettingsFile) -> Result<ModelsAiStateResponse, ModelsAiError> {
        let mut providers = Vec::with_capacity(settings.providers.len());
        for provider in &settings.providers {
            let configured = self
                .credentials
                .get(&provider.id, &provider_fingerprint(provider)?)?
                .is_some();
            providers.push(provider_dto(provider, configured));
        }
        Ok(ModelsAiStateResponse {
            schema_version: SCHEMA_VERSION,
            revision: settings.revision,
            legacy_migration_completed: settings.legacy_migration_completed,
            providers,
            models: settings.models(settings.managed_ollama_digest.is_some()),
            default_chat_model_id: settings.default_chat_model_id.clone(),
            default_embedding_model_id: settings.default_embedding_model_id.clone(),
            selected_llama_harness_agent_id: settings.selected_llama_harness_agent_id.clone(),
        })
    }
}

fn provider_dto(provider: &ProviderSettingsInput, credential_configured: bool) -> ProviderDto {
    ProviderDto {
        id: provider.id.clone(),
        name: provider.name.clone(),
        kind: provider.kind,
        base_url: provider.base_url.clone(),
        enabled: provider.enabled,
        data_sharing: provider.data_sharing,
        credential_configured,
        capabilities: provider_capabilities(provider.kind),
        managed: is_builtin_provider(&provider.id),
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SettingsFile {
    schema_version: u8,
    revision: u64,
    legacy_migration_completed: bool,
    providers: Vec<ProviderSettingsInput>,
    discovered_models: Vec<ModelDto>,
    default_chat_model_id: Option<String>,
    default_embedding_model_id: Option<String>,
    selected_llama_harness_agent_id: Option<String>,
    #[serde(default)]
    managed_ollama_owned: bool,
    #[serde(default)]
    managed_ollama_digest: Option<String>,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            revision: 1,
            legacy_migration_completed: false,
            providers: builtin_provider_settings(),
            discovered_models: Vec::new(),
            default_chat_model_id: Some(MANAGED_MODEL_ID.to_owned()),
            default_embedding_model_id: None,
            selected_llama_harness_agent_id: None,
            managed_ollama_owned: false,
            managed_ollama_digest: None,
        }
    }
}

impl SettingsFile {
    fn models(&self, owned: bool) -> Vec<ModelDto> {
        let mut models = Vec::with_capacity(self.discovered_models.len() + 1);
        models.push(managed_model(owned));
        models.extend(self.discovered_models.clone());
        models
    }
}

pub(crate) fn managed_model(owned: bool) -> ModelDto {
    ModelDto {
        id: MANAGED_MODEL_ID.to_owned(),
        provider_id: OLLAMA_PROVIDER_ID.to_owned(),
        runtime_name: MANAGED_MODEL_RUNTIME_NAME.to_owned(),
        name: MANAGED_MODEL_NAME.to_owned(),
        capabilities: ModelCapabilities {
            chat: true,
            embeddings: false,
            vision: false,
            speech_to_text: false,
            streaming: false,
        },
        // Ollama/model metadata does not provide stable install-independent
        // values for these fields, so the manifest intentionally omits them.
        context_window_tokens: None,
        estimated_memory_bytes: None,
        platforms: vec!["windows".into(), "macos".into(), "linux".into()],
        license: ModelLicense {
            name: "LFM Open License v1.0".into(),
            url: Some(
                "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking/blob/main/LICENSE".into(),
            ),
        },
        expected_download_bytes: Some(MANAGED_MODEL_EXPECTED_BYTES),
        managed_removal: ManagedRemoval::NoteManagedOnly,
        owned_by_note: owned,
        // Cal's live structured continuation was not reliable enough to
        // advertise this model as a tools executor.
        structured_tool_support: StructuredToolSupport::Unverified,
        execution_mode: ExecutionMode::ChatOnly,
    }
}

fn discovered_model(
    provider_id: &str,
    runtime_name: &str,
    name: &str,
    capabilities: ModelCapabilities,
) -> Result<ModelDto, ModelsAiError> {
    validate_id(provider_id, "providerId")?;
    validate_id(runtime_name, "models")?;
    validate_name(name, "models")?;
    let id = format!("{provider_id}:{runtime_name}");
    if id.len() > MAX_ID_BYTES * 2 + 1 {
        return Err(ModelsAiError::invalid("models"));
    }
    Ok(ModelDto {
        id,
        provider_id: provider_id.to_owned(),
        runtime_name: runtime_name.to_owned(),
        name: name.to_owned(),
        capabilities,
        context_window_tokens: None,
        estimated_memory_bytes: None,
        platforms: Vec::new(),
        license: ModelLicense {
            name: "Unknown".into(),
            url: None,
        },
        expected_download_bytes: None,
        managed_removal: ManagedRemoval::NotSupported,
        owned_by_note: false,
        structured_tool_support: StructuredToolSupport::Unverified,
        execution_mode: ExecutionMode::ChatOnly,
    })
}

fn builtin_provider_settings() -> Vec<ProviderSettingsInput> {
    vec![
        ProviderSettingsInput {
            id: OLLAMA_PROVIDER_ID.into(),
            name: "Ollama".into(),
            kind: ProviderKind::Ollama,
            base_url: Some("http://127.0.0.1:11434".into()),
            enabled: true,
            data_sharing: DataSharing::Local,
        },
        ProviderSettingsInput {
            id: LLAMA_HARNESS_PROVIDER_ID.into(),
            name: "llama-harness".into(),
            kind: ProviderKind::LlamaHarness,
            base_url: Some("http://127.0.0.1:8787".into()),
            enabled: true,
            data_sharing: DataSharing::Local,
        },
        ProviderSettingsInput {
            id: OPENAI_LOCAL_PROVIDER_ID.into(),
            name: "OpenAI-compatible local".into(),
            kind: ProviderKind::OpenaiCompatible,
            base_url: Some("http://127.0.0.1:1234/v1".into()),
            enabled: true,
            data_sharing: DataSharing::Local,
        },
        ProviderSettingsInput {
            id: NATIVE_WHISPER_PROVIDER_ID.into(),
            name: "Native Whisper".into(),
            kind: ProviderKind::SpeechToText,
            base_url: None,
            enabled: false,
            data_sharing: DataSharing::Local,
        },
    ]
}

fn validate_provider_settings(
    providers: Vec<ProviderSettingsInput>,
) -> Result<Vec<ProviderSettingsInput>, ModelsAiError> {
    if providers.len() < 4 || providers.len() > MAX_PROVIDERS {
        return Err(ModelsAiError::invalid("providers"));
    }
    let defaults = builtin_provider_settings();
    let mut seen = BTreeSet::new();
    for provider in &providers {
        validate_id(&provider.id, "providers")?;
        validate_name(&provider.name, "providers")?;
        if !seen.insert(provider.id.as_str()) {
            return Err(ModelsAiError::invalid("providers"));
        }
        if let Some(expected) = defaults.iter().find(|item| item.id == provider.id) {
            if provider.kind != expected.kind
                || provider.base_url != expected.base_url
                || provider.data_sharing != expected.data_sharing
            {
                return Err(ModelsAiError::invalid("providers"));
            }
        } else {
            if provider.kind != ProviderKind::OpenaiCompatible {
                return Err(ModelsAiError::invalid("providers"));
            }
            let base_url = provider
                .base_url
                .as_deref()
                .ok_or_else(|| ModelsAiError::invalid("providers"))?;
            if validate_provider_endpoint(base_url)? != provider.data_sharing {
                return Err(ModelsAiError::invalid("providers"));
            }
        }
    }
    if defaults
        .iter()
        .any(|required| !seen.contains(required.id.as_str()))
    {
        return Err(ModelsAiError::invalid("providers"));
    }
    Ok(providers)
}

fn validate_settings_file(settings: &SettingsFile) -> Result<(), ModelsAiError> {
    if settings.schema_version != SCHEMA_VERSION
        || settings.revision == 0
        || settings.discovered_models.len() > MAX_MODELS
        || settings
            .managed_ollama_digest
            .as_deref()
            .is_some_and(invalid_digest)
    {
        return Err(ModelsAiError::storage());
    }
    validate_provider_settings(settings.providers.clone()).map_err(|_| ModelsAiError::storage())?;
    validate_optional_id(
        settings.default_chat_model_id.as_deref(),
        "defaultChatModelId",
    )?;
    validate_optional_id(
        settings.default_embedding_model_id.as_deref(),
        "defaultEmbeddingModelId",
    )?;
    validate_optional_id(
        settings.selected_llama_harness_agent_id.as_deref(),
        "selectedLlamaHarnessAgentId",
    )?;
    let providers = settings
        .providers
        .iter()
        .map(|provider| provider.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut model_ids = BTreeSet::new();
    for model in &settings.discovered_models {
        if !providers.contains(model.provider_id.as_str())
            || !model_ids.insert(model.id.as_str())
            || model.id != format!("{}:{}", model.provider_id, model.runtime_name)
            || model.id.len() > MAX_ID_BYTES * 2 + 1
            || validate_id(&model.provider_id, "models").is_err()
            || validate_id(&model.runtime_name, "models").is_err()
            || validate_name(&model.name, "models").is_err()
            || model.platforms.len() > 16
            || model
                .platforms
                .iter()
                .any(|platform| validate_name(platform, "models").is_err())
            || validate_name(&model.license.name, "models").is_err()
            || model
                .license
                .url
                .as_ref()
                .is_some_and(|url| !valid_license_url(url))
            || model.owned_by_note
            || model.managed_removal != ManagedRemoval::NotSupported
            || model.structured_tool_support != StructuredToolSupport::Unverified
            || model.execution_mode != ExecutionMode::ChatOnly
        {
            return Err(ModelsAiError::storage());
        }
    }
    let models = settings
        .models(settings.managed_ollama_digest.is_some())
        .into_iter()
        .map(|model| (model.id.clone(), model))
        .collect::<BTreeMap<_, _>>();
    validate_default_models(
        settings.default_chat_model_id.as_deref(),
        settings.default_embedding_model_id.as_deref(),
        &models,
    )
    .map_err(|_| ModelsAiError::storage())?;
    Ok(())
}

fn validate_credential_file(file: &CredentialFile) -> Result<(), ModelsAiError> {
    if file.schema_version != SCHEMA_VERSION || file.credentials.len() > MAX_PROVIDERS {
        return Err(ModelsAiError::credential());
    }
    for (provider_id, binding) in &file.credentials {
        if validate_id(provider_id, "providerId").is_err()
            || validate_fingerprint(&binding.endpoint_fingerprint).is_err()
            || binding.credential.trim().is_empty()
            || binding.credential.len() > MAX_CREDENTIAL_BYTES
        {
            return Err(ModelsAiError::credential());
        }
    }
    Ok(())
}

fn validate_fingerprint(value: &str) -> Result<(), ModelsAiError> {
    if value.is_empty()
        || value.len() > super::contracts::MAX_URL_BYTES + 64
        || value.chars().any(char::is_control)
    {
        Err(ModelsAiError::credential())
    } else {
        Ok(())
    }
}

fn invalid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_none_or(|digest| {
        digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn provider_fingerprint(provider: &ProviderSettingsInput) -> Result<String, ModelsAiError> {
    let kind = match provider.kind {
        ProviderKind::Ollama => "ollama",
        ProviderKind::LlamaHarness => "llama_harness",
        ProviderKind::OpenaiCompatible => "openai_compatible",
        ProviderKind::SpeechToText => "speech_to_text",
    };
    let endpoint = match provider.base_url.as_deref() {
        Some(base) => Url::parse(base)
            .map_err(|_| ModelsAiError::invalid("baseUrl"))?
            .to_string(),
        None => "native".to_owned(),
    };
    Ok(format!("v1|{kind}|{:?}|{endpoint}", provider.data_sharing))
}

fn valid_license_url(value: &str) -> bool {
    if value == "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking/blob/main/LICENSE" {
        return true;
    }
    value.len() <= super::contracts::MAX_URL_BYTES
        && !value.chars().any(char::is_control)
        && Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
        })
}

fn validate_default_models(
    default_chat_model_id: Option<&str>,
    default_embedding_model_id: Option<&str>,
    models: &BTreeMap<String, ModelDto>,
) -> Result<(), ModelsAiError> {
    if let Some(model_id) = default_chat_model_id {
        let model = models
            .get(model_id)
            .ok_or_else(ModelsAiError::model_not_found)?;
        if !model.capabilities.chat {
            return Err(ModelsAiError::invalid("defaultChatModelId"));
        }
    }
    if let Some(model_id) = default_embedding_model_id {
        let model = models
            .get(model_id)
            .ok_or_else(ModelsAiError::model_not_found)?;
        if !model.capabilities.embeddings {
            return Err(ModelsAiError::invalid("defaultEmbeddingModelId"));
        }
    }
    Ok(())
}

fn provider_capabilities(kind: ProviderKind) -> ProviderCapabilities {
    match kind {
        ProviderKind::Ollama | ProviderKind::OpenaiCompatible => ProviderCapabilities {
            chat: true,
            embeddings: true,
            speech_to_text: false,
        },
        ProviderKind::LlamaHarness => ProviderCapabilities {
            chat: true,
            embeddings: false,
            speech_to_text: false,
        },
        ProviderKind::SpeechToText => ProviderCapabilities {
            chat: false,
            embeddings: false,
            speech_to_text: true,
        },
    }
}

fn ensure_credential_provider(
    settings: &SettingsFile,
    provider_id: &str,
) -> Result<(), ModelsAiError> {
    validate_id(provider_id, "providerId")?;
    match settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
    {
        Some(provider) if provider.kind == ProviderKind::OpenaiCompatible => Ok(()),
        Some(_) => Err(ModelsAiError::unsupported()),
        None => Err(ModelsAiError::provider_not_found()),
    }
}

fn map_legacy_model_id(
    model_id: Option<String>,
    model_map: &BTreeMap<String, String>,
) -> Option<String> {
    let model_id = model_id?;
    if model_id == MANAGED_MODEL_ID || model_id == MANAGED_MODEL_RUNTIME_NAME {
        return Some(MANAGED_MODEL_ID.into());
    }
    model_map.get(&model_id).cloned()
}

fn legacy_runtime_name(
    legacy_model_id: &str,
    legacy_provider_id: &str,
) -> Result<String, ModelsAiError> {
    let prefix = format!("{legacy_provider_id}:");
    let runtime_name = legacy_model_id
        .strip_prefix(&prefix)
        .unwrap_or(legacy_model_id);
    validate_id(runtime_name, "legacySettings")?;
    Ok(runtime_name.to_owned())
}

fn is_builtin_provider(id: &str) -> bool {
    matches!(
        id,
        OLLAMA_PROVIDER_ID
            | LLAMA_HARNESS_PROVIDER_ID
            | OPENAI_LOCAL_PROVIDER_ID
            | NATIVE_WHISPER_PROVIDER_ID
    )
}

fn validate_id(value: &str, field: &'static str) -> Result<(), ModelsAiError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
    {
        Err(ModelsAiError::invalid(field))
    } else {
        Ok(())
    }
}

fn validate_name(value: &str, field: &'static str) -> Result<(), ModelsAiError> {
    if value.trim().is_empty()
        || value.len() > MAX_NAME_BYTES
        || value.chars().any(char::is_control)
    {
        Err(ModelsAiError::invalid(field))
    } else {
        Ok(())
    }
}

fn validate_optional_id(value: Option<&str>, field: &'static str) -> Result<(), ModelsAiError> {
    value.map_or(Ok(()), |value| validate_id(value, field))
}

fn next_revision(revision: u64) -> Result<u64, ModelsAiError> {
    revision.checked_add(1).ok_or_else(ModelsAiError::storage)
}

fn read_json_file(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, ModelsAiError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ModelsAiError::storage()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(ModelsAiError::storage());
    }
    let bytes = fs::read(path).map_err(|_| ModelsAiError::storage())?;
    if bytes.len() > limit {
        Err(ModelsAiError::storage())
    } else {
        Ok(Some(bytes))
    }
}

fn ensure_parent(path: &Path) -> Result<(), std::io::Error> {
    path.parent()
        .ok_or_else(|| std::io::Error::other("missing parent"))
        .and_then(fs::create_dir_all)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct FailingCredentials {
        fail: AtomicBool,
        values: Mutex<BTreeMap<String, String>>,
    }

    impl CredentialStore for FailingCredentials {
        fn get(
            &self,
            provider_id: &str,
            _fingerprint: &str,
        ) -> Result<Option<String>, ModelsAiError> {
            if self.fail.load(Ordering::SeqCst) {
                Err(ModelsAiError::credential())
            } else {
                Ok(self.values.lock().unwrap().get(provider_id).cloned())
            }
        }

        fn set(
            &self,
            provider_id: &str,
            _fingerprint: &str,
            credential: &str,
        ) -> Result<(), ModelsAiError> {
            if self.fail.load(Ordering::SeqCst) {
                Err(ModelsAiError::credential())
            } else {
                self.values
                    .lock()
                    .unwrap()
                    .insert(provider_id.into(), credential.into());
                Ok(())
            }
        }

        fn delete(&self, provider_id: &str) -> Result<(), ModelsAiError> {
            self.values.lock().unwrap().remove(provider_id);
            Ok(())
        }
    }

    #[test]
    fn default_state_is_versioned_nonnetwork_and_exact() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        let state = store.state().unwrap();
        assert_eq!(state.schema_version, 1);
        assert_eq!(state.revision, 1);
        assert_eq!(state.providers.len(), 4);
        assert_eq!(state.models, vec![managed_model(false)]);
        assert!(!directory.path().join(SETTINGS_FILE).exists());
        assert!(!directory.path().join(CREDENTIALS_FILE).exists());
    }

    #[test]
    fn revisioned_save_is_atomic_and_preserves_native_model_state() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        store.set_managed_owned(true).unwrap();
        store
            .replace_discovered_models(OLLAMA_PROVIDER_ID, vec!["other:1".into()])
            .unwrap();
        let state = store.state().unwrap();
        let request = SettingsSaveRequest {
            expected_revision: state.revision,
            default_chat_model_id: Some(MANAGED_MODEL_ID.into()),
            default_embedding_model_id: None,
            selected_llama_harness_agent_id: Some("agent-1".into()),
            providers: builtin_provider_settings(),
        };
        let saved = store.save_settings(request).unwrap();
        assert!(saved
            .models
            .iter()
            .any(|model| model.id.ends_with("other:1")));
        assert!(saved.models[0].owned_by_note);
        let conflict = store
            .save_settings(SettingsSaveRequest {
                expected_revision: state.revision,
                default_chat_model_id: None,
                default_embedding_model_id: None,
                selected_llama_harness_agent_id: None,
                providers: builtin_provider_settings(),
            })
            .unwrap_err();
        assert_eq!(
            conflict.code,
            super::super::contracts::ModelsAiErrorCode::RevisionConflict
        );
    }

    #[test]
    fn credential_write_is_verified_and_never_serialized_in_state() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        store
            .set_credential(OPENAI_LOCAL_PROVIDER_ID, "sk-native-only")
            .unwrap();
        let serialized = serde_json::to_string(&store.state().unwrap()).unwrap();
        assert!(!serialized.contains("sk-native-only"));
        assert!(serialized.contains("credentialConfigured"));
        store.delete_credential(OPENAI_LOCAL_PROVIDER_ID).unwrap();
        assert!(store
            .enabled_provider_snapshot(OPENAI_LOCAL_PROVIDER_ID)
            .unwrap()
            .1
            .is_none());
    }

    #[test]
    fn credentials_block_provider_rebinding_and_removal_until_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        let mut providers = builtin_provider_settings();
        providers.push(ProviderSettingsInput {
            id: "bound-remote".into(),
            name: "Bound remote".into(),
            kind: ProviderKind::OpenaiCompatible,
            base_url: Some("https://api.example.test/v1".into()),
            enabled: true,
            data_sharing: DataSharing::Remote,
        });
        let state = store
            .save_settings(SettingsSaveRequest {
                expected_revision: 1,
                default_chat_model_id: Some(MANAGED_MODEL_ID.into()),
                default_embedding_model_id: None,
                selected_llama_harness_agent_id: None,
                providers: providers.clone(),
            })
            .unwrap();
        store.set_credential("bound-remote", "secret").unwrap();
        let mut rebound = providers.clone();
        rebound.last_mut().unwrap().base_url = Some("https://other.example.test/v1".into());
        assert!(store
            .save_settings(SettingsSaveRequest {
                expected_revision: state.revision,
                default_chat_model_id: Some(MANAGED_MODEL_ID.into()),
                default_embedding_model_id: None,
                selected_llama_harness_agent_id: None,
                providers: rebound
            })
            .is_err());
        providers.pop();
        assert!(store
            .save_settings(SettingsSaveRequest {
                expected_revision: state.revision,
                default_chat_model_id: Some(MANAGED_MODEL_ID.into()),
                default_embedding_model_id: None,
                selected_llama_harness_agent_id: None,
                providers: providers.clone()
            })
            .is_err());
        store.delete_credential("bound-remote").unwrap();
        assert!(store
            .save_settings(SettingsSaveRequest {
                expected_revision: state.revision,
                default_chat_model_id: Some(MANAGED_MODEL_ID.into()),
                default_embedding_model_id: None,
                selected_llama_harness_agent_id: None,
                providers
            })
            .is_ok());
    }

    #[test]
    fn provider_snapshot_keeps_endpoint_and_credential_from_one_binding() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        let mut providers = builtin_provider_settings();
        providers.push(ProviderSettingsInput {
            id: "snapshot-provider".into(),
            name: "Snapshot".into(),
            kind: ProviderKind::OpenaiCompatible,
            base_url: Some("https://first.example.test/v1".into()),
            enabled: true,
            data_sharing: DataSharing::Remote,
        });
        let saved = store
            .save_settings(SettingsSaveRequest {
                expected_revision: 1,
                default_chat_model_id: Some(MANAGED_MODEL_ID.into()),
                default_embedding_model_id: None,
                selected_llama_harness_agent_id: None,
                providers: providers.clone(),
            })
            .unwrap();
        store
            .set_credential("snapshot-provider", "first-secret")
            .unwrap();
        let first = store
            .enabled_provider_snapshot("snapshot-provider")
            .unwrap();
        store.delete_credential("snapshot-provider").unwrap();
        providers.last_mut().unwrap().base_url = Some("https://second.example.test/v1".into());
        store
            .save_settings(SettingsSaveRequest {
                expected_revision: saved.revision,
                default_chat_model_id: Some(MANAGED_MODEL_ID.into()),
                default_embedding_model_id: None,
                selected_llama_harness_agent_id: None,
                providers,
            })
            .unwrap();
        store
            .set_credential("snapshot-provider", "second-secret")
            .unwrap();
        let second = store
            .enabled_provider_snapshot("snapshot-provider")
            .unwrap();
        assert_eq!(
            (first.0.base_url.as_deref(), first.1.as_deref()),
            (Some("https://first.example.test/v1"), Some("first-secret"))
        );
        assert_eq!(
            (second.0.base_url.as_deref(), second.1.as_deref()),
            (
                Some("https://second.example.test/v1"),
                Some("second-secret")
            )
        );
    }

    #[test]
    fn legacy_unbound_credential_file_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(CREDENTIALS_FILE),
            serde_json::to_vec(&json!({
                "schemaVersion": SCHEMA_VERSION,
                "credentials": { OPENAI_LOCAL_PROVIDER_ID: "unbound-secret" }
            }))
            .unwrap(),
        )
        .unwrap();
        let store = ModelsAiStore::new(directory.path());
        assert_eq!(
            store
                .enabled_provider_snapshot(OPENAI_LOCAL_PROVIDER_ID)
                .unwrap_err()
                .code,
            super::super::contracts::ModelsAiErrorCode::CredentialUnavailable
        );
        assert!(serde_json::to_string(&store.state().unwrap_err())
            .unwrap()
            .contains("credential_unavailable"));
    }

    #[test]
    fn failed_credential_migration_does_not_publish_completion_marker() {
        let directory = tempfile::tempdir().unwrap();
        let credentials = Arc::new(FailingCredentials::default());
        credentials.fail.store(true, Ordering::SeqCst);
        let store = ModelsAiStore::with_credentials(directory.path(), credentials.clone());
        let request: LegacyMigrationRequest = serde_json::from_value(json!({
            "legacyCredentials": [{
                "providerId": OPENAI_LOCAL_PROVIDER_ID,
                "credential": "secret"
            }]
        }))
        .unwrap();
        assert!(store.migrate_legacy(request).is_err());
        credentials.fail.store(false, Ordering::SeqCst);
        assert!(!store.state().unwrap().legacy_migration_completed);
    }

    #[test]
    fn migration_is_idempotent_and_responses_are_secret_free() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        let request = || {
            serde_json::from_value(json!({
                "legacyCredentials": [{
                    "providerId": OPENAI_LOCAL_PROVIDER_ID,
                    "credential": "secret-migration-value"
                }]
            }))
            .unwrap()
        };
        let first = store.migrate_legacy(request()).unwrap();
        assert_eq!(first.status, MigrationStatus::Completed);
        let second = store.migrate_legacy(request()).unwrap();
        assert_eq!(second.status, MigrationStatus::AlreadyCompleted);
        for response in [first, second] {
            assert!(!serde_json::to_string(&response)
                .unwrap()
                .contains("secret-migration-value"));
        }
    }

    #[test]
    fn malformed_credential_file_is_rejected_before_use() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(CREDENTIALS_FILE),
            serde_json::to_vec(&json!({
                "schemaVersion": 99,
                "credentials": { OPENAI_LOCAL_PROVIDER_ID: "secret" }
            }))
            .unwrap(),
        )
        .unwrap();
        let error = ModelsAiStore::new(directory.path()).state().unwrap_err();
        assert_eq!(
            error.code,
            super::super::contracts::ModelsAiErrorCode::CredentialUnavailable
        );
    }

    #[test]
    fn legacy_credentials_are_all_validated_before_the_first_write() {
        let directory = tempfile::tempdir().unwrap();
        let credentials = Arc::new(FailingCredentials::default());
        let store = ModelsAiStore::with_credentials(directory.path(), credentials.clone());
        let request: LegacyMigrationRequest = serde_json::from_value(json!({
            "legacyCredentials": [
                { "providerId": OPENAI_LOCAL_PROVIDER_ID, "credential": "first" },
                { "providerId": OPENAI_LOCAL_PROVIDER_ID, "credential": "duplicate" }
            ]
        }))
        .unwrap();
        assert!(store.migrate_legacy(request).is_err());
        assert!(credentials.values.lock().unwrap().is_empty());
    }

    #[test]
    fn legacy_prefixed_model_id_is_not_duplicated() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        let response = store
            .migrate_legacy(
                serde_json::from_value(json!({
                    "legacySettings": {
                        "defaultChatModelId": "old-provider:tiny-model",
                        "defaultEmbeddingModelId": null,
                        "providers": [{
                            "id": "old-provider",
                            "name": "Old local provider",
                            "type": "lm-studio",
                            "baseUrl": "http://127.0.0.1:12345/v1",
                            "enabled": true
                        }],
                        "models": [{
                            "id": "old-provider:tiny-model",
                            "providerId": "old-provider",
                            "name": "Tiny model",
                            "capabilities": {
                                "chat": true,
                                "embeddings": false,
                                "vision": false,
                                "tools": false,
                                "streaming": false
                            }
                        }]
                    },
                    "legacyCredentials": []
                }))
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            response.state.default_chat_model_id.as_deref(),
            Some("old-provider:tiny-model")
        );
        assert!(response.state.models.iter().any(
            |model| model.id == "old-provider:tiny-model" && model.runtime_name == "tiny-model"
        ));
    }

    #[test]
    fn defaults_require_the_matching_model_capability() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        store
            .replace_discovered_models(OPENAI_LOCAL_PROVIDER_ID, vec!["chat-only".into()])
            .unwrap();
        let state = store.state().unwrap();
        let error = store
            .save_settings(SettingsSaveRequest {
                expected_revision: state.revision,
                default_chat_model_id: Some(MANAGED_MODEL_ID.into()),
                default_embedding_model_id: Some(format!("{OPENAI_LOCAL_PROVIDER_ID}:chat-only")),
                selected_llama_harness_agent_id: None,
                providers: builtin_provider_settings(),
            })
            .unwrap_err();
        assert_eq!(
            error.code,
            super::super::contracts::ModelsAiErrorCode::InvalidRequest
        );
    }

    #[test]
    fn corrupted_discovered_model_fields_are_rejected() {
        let mut settings = SettingsFile::default();
        let mut model = discovered_model(
            OPENAI_LOCAL_PROVIDER_ID,
            "valid-runtime",
            "Valid model",
            ModelCapabilities {
                chat: true,
                embeddings: false,
                vision: false,
                speech_to_text: false,
                streaming: false,
            },
        )
        .unwrap();
        model.id = "does-not-match-provider-and-runtime".into();
        settings.discovered_models.push(model);
        assert!(validate_settings_file(&settings).is_err());
    }

    #[test]
    fn persisted_license_urls_are_https_only() {
        for invalid in [
            "javascript:alert(1)",
            "file:///secret",
            "http://example.test/license",
        ] {
            assert!(!valid_license_url(invalid), "{invalid}");
        }
        assert!(valid_license_url("https://example.test/license"));
        assert!(valid_license_url(
            "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking/blob/main/LICENSE"
        ));
    }

    #[test]
    fn digest_ownership_is_validated_and_legacy_boolean_fails_closed() {
        let mut legacy = SettingsFile {
            managed_ollama_owned: true,
            ..SettingsFile::default()
        };
        assert!(validate_settings_file(&legacy).is_ok());
        assert!(!legacy.models(legacy.managed_ollama_digest.is_some())[0].owned_by_note);
        legacy.managed_ollama_digest = Some("not a digest!".into());
        assert!(validate_settings_file(&legacy).is_err());

        let directory = tempfile::tempdir().unwrap();
        let store = ModelsAiStore::new(directory.path());
        let digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        store.set_managed_digest(Some(digest)).unwrap();
        assert_eq!(store.managed_digest().unwrap().as_deref(), Some(digest));
        store.set_managed_digest(None).unwrap();
        assert_eq!(store.managed_digest().unwrap(), None);
    }

    #[test]
    fn remote_http_and_non_numeric_loopback_are_rejected() {
        assert_eq!(
            validate_provider_endpoint("https://api.example.com/v1").unwrap(),
            DataSharing::Remote
        );
        assert!(validate_provider_endpoint("http://api.example.com/v1").is_err());
        assert!(validate_provider_endpoint("http://localhost:1234/v1").is_err());
        assert_eq!(
            validate_provider_endpoint("http://127.0.0.1:1234/v1").unwrap(),
            DataSharing::Local
        );
    }
}
