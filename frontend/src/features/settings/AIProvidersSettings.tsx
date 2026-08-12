import { memo, useMemo, useState } from "react";
import type {
  ModelsAIModel,
  ModelsAIProvider,
} from "../../native/modelsAIClient";
import {
  inferDataSharing,
  type OllamaSetupState,
  type ProviderConnectionState,
} from "./useAIProviderSettings";

type ModelsAISettingsProps = {
  connectionStates: Record<string, ProviderConnectionState>;
  defaultChatModelId: string;
  defaultEmbeddingModelId: string;
  error: string;
  isSaving: boolean;
  loadStatus: "loading" | "ready" | "unavailable" | "error";
  message: string;
  models: ModelsAIModel[];
  ollamaSetup: OllamaSetupState;
  pendingAction: string;
  providers: ModelsAIProvider[];
  selectedProviderId: string;
  onAddProvider: () => void;
  onCancelManagedModelInstall: () => void;
  onCheckOllama: () => void;
  onDeleteCredential: (providerId: string) => void;
  onDeleteProvider: (providerId: string) => void;
  onInstallManagedModel: () => void;
  onRefreshModels: (providerId: string) => void;
  onRemoveManagedModel: () => void;
  onRetryLoad: () => void;
  onSave: () => void;
  onSelectProvider: (providerId: string) => void;
  onSetCredential: (providerId: string, credential: string) => Promise<boolean>;
  onSetDefaultChatModel: (modelId: string) => void;
  onSetDefaultEmbeddingModel: (modelId: string) => void;
  onTestConnection: (providerId: string) => void;
  onUpdateProvider: (providerId: string, updates: Partial<ModelsAIProvider>) => void;
};

const emptyConnectionState: ProviderConnectionState = { status: "idle" };

export const AIProvidersSettings = memo(function AIProvidersSettings({
  connectionStates,
  defaultChatModelId,
  defaultEmbeddingModelId,
  error,
  isSaving,
  loadStatus,
  message,
  models,
  ollamaSetup,
  pendingAction,
  providers,
  selectedProviderId,
  onAddProvider,
  onCancelManagedModelInstall,
  onCheckOllama,
  onDeleteCredential,
  onDeleteProvider,
  onInstallManagedModel,
  onRefreshModels,
  onRemoveManagedModel,
  onRetryLoad,
  onSave,
  onSelectProvider,
  onSetCredential,
  onSetDefaultChatModel,
  onSetDefaultEmbeddingModel,
  onTestConnection,
  onUpdateProvider,
}: ModelsAISettingsProps) {
  const [credentialDraft, setCredentialDraft] = useState({ providerId: "", value: "" });
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialStatus, setCredentialStatus] = useState("");
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ?? providers[0];
  const selectedModels = useMemo(
    () => models.filter((model) => model.providerId === selectedProvider?.id),
    [models, selectedProvider?.id],
  );
  const chatModels = availableModels(models, providers, "chat");
  const embeddingModels = availableModels(models, providers, "embeddings");
  const connection = selectedProvider
    ? connectionStates[selectedProvider.id] ?? emptyConnectionState
    : emptyConnectionState;
  const isBusy = Boolean(connection.isRefreshing || connection.isTesting || credentialBusy || pendingAction);

  if (loadStatus !== "ready") {
    return (
      <section className="models-ai-shell models-ai-state" aria-labelledby="models-ai-title">
        <p className="workspace-system-eyebrow">Settings</p>
        <h1 id="models-ai-title">Models &amp; AI</h1>
        <div
          className={loadStatus === "error" || loadStatus === "unavailable" ? "models-ai-alert" : "models-ai-live"}
          role={loadStatus === "error" || loadStatus === "unavailable" ? "alert" : "status"}
        >
          {loadStatus === "loading" ? "Loading local model settings…" : error}
        </div>
        {loadStatus !== "loading" ? <button className="models-ai-primary" onClick={onRetryLoad} type="button">Retry loading</button> : null}
      </section>
    );
  }

  async function storeCredential() {
    if (!selectedProvider || !credentialDraft.value.trim() || credentialBusy) return;
    if (credentialDraft.providerId !== selectedProvider.id) {
      setCredentialStatus("Unstored credential cleared when changing providers.");
      setCredentialDraft({ providerId: "", value: "" });
      return;
    }
    setCredentialBusy(true);
    const stored = await onSetCredential(selectedProvider.id, credentialDraft.value);
    if (stored) setCredentialDraft({ providerId: "", value: "" });
    setCredentialBusy(false);
  }

  function clearCredentialDraft() {
    if (credentialDraft.value) {
      setCredentialStatus("Unstored credential cleared when changing providers.");
    }
    setCredentialDraft({ providerId: "", value: "" });
  }

  return (
    <section className="models-ai-shell" aria-labelledby="models-ai-title">
      <header className="models-ai-header">
        <div>
          <p className="workspace-system-eyebrow">Settings</p>
          <h1 id="models-ai-title">Models &amp; AI</h1>
          <p>Choose what powers chat, control data sharing, and manage Note’s local model.</p>
        </div>
        <button className="models-ai-primary" disabled={isSaving || isBusy} onClick={onSave} type="button">
          {isSaving ? "Saving…" : "Save changes"}
        </button>
      </header>

      {error ? <div className="models-ai-alert" role="alert">{error}</div> : null}
      <div className="models-ai-live" aria-live="polite" role="status">{credentialStatus || message}</div>

      <section className="models-ai-defaults" aria-labelledby="models-ai-defaults-title">
        <div className="models-ai-section-heading">
          <div><p className="models-ai-kicker">Routing</p><h2 id="models-ai-defaults-title">Default models</h2></div>
          <span>Shared by Note AI and Assistant</span>
        </div>
        <div className="models-ai-field-grid">
          <label className="models-ai-field">
            <span>Chat model</span>
            <select value={defaultChatModelId} onChange={(event) => onSetDefaultChatModel(event.currentTarget.value)}>
              <option value="">No native chat model</option>
              {chatModels.map(({ model, provider }) => <option key={model.id} value={model.id}>{provider.name} / {model.name}</option>)}
            </select>
          </label>
          <label className="models-ai-field">
            <span>Embedding model</span>
            <select value={defaultEmbeddingModelId} onChange={(event) => onSetDefaultEmbeddingModel(event.currentTarget.value)}>
              <option value="">No embedding model</option>
              {embeddingModels.map(({ model, provider }) => <option key={model.id} value={model.id}>{provider.name} / {model.name}</option>)}
            </select>
          </label>
        </div>
      </section>

      <div className="models-ai-layout">
        <nav className="models-ai-provider-nav" aria-label="Model providers">
          <div className="models-ai-section-heading compact"><h2>Providers</h2><button onClick={() => { clearCredentialDraft(); onAddProvider(); }} type="button">Add compatible</button></div>
          <div className="models-ai-provider-list">
            {providers.map((provider) => {
              const providerState = connectionStates[provider.id] ?? emptyConnectionState;
              return <button
                aria-pressed={provider.id === selectedProvider?.id}
                className={`models-ai-provider-card ${provider.id === selectedProvider?.id ? "is-selected" : ""}`}
                key={provider.id}
                onClick={() => { clearCredentialDraft(); onSelectProvider(provider.id); }}
                type="button"
              >
                <span><strong>{provider.name}</strong><small>{providerKindLabel(provider.kind)}</small></span>
                <span className={`models-ai-provider-state is-${providerState.status}`}>{provider.enabled ? "Enabled" : "Disabled"}</span>
              </button>;
            })}
          </div>
        </nav>

        <div className="models-ai-detail">
          {selectedProvider ? <>
            <section className="models-ai-card" aria-labelledby="models-ai-provider-title">
              <div className="models-ai-section-heading">
                <div><p className="models-ai-kicker">{providerKindLabel(selectedProvider.kind)}</p><h2 id="models-ai-provider-title">{selectedProvider.name}</h2></div>
                <span className={`models-ai-sharing is-${selectedProvider.dataSharing}`}>{selectedProvider.dataSharing === "local" ? "Local only" : "Remote data sharing"}</span>
              </div>
              <div className="models-ai-field-grid">
                <label className="models-ai-field"><span>Name</span><input value={selectedProvider.name} onChange={(event) => onUpdateProvider(selectedProvider.id, { name: event.currentTarget.value })} /></label>
                <label className="models-ai-field"><span>Type</span><input disabled value={providerKindLabel(selectedProvider.kind)} /></label>
                {selectedProvider.baseUrl !== undefined ? <label className="models-ai-field wide"><span>Base URL</span><input
                  disabled={selectedProvider.managed}
                  inputMode="url"
                  value={selectedProvider.baseUrl}
                  onChange={(event) => onUpdateProvider(selectedProvider.id, {
                    baseUrl: event.currentTarget.value,
                    dataSharing: inferDataSharing(event.currentTarget.value),
                  })}
                /></label> : null}
              </div>
              <label className="models-ai-toggle"><input checked={selectedProvider.enabled} onChange={(event) => onUpdateProvider(selectedProvider.id, { enabled: event.currentTarget.checked })} type="checkbox" /><span><strong>Provider enabled</strong><small>Disabled providers cannot be tested or used.</small></span></label>

              {selectedProvider.kind === "openai_compatible" ? <div className="models-ai-credential">
                <div><strong>Credential</strong><small>{selectedProvider.credentialConfigured ? "Configured — the value is never returned to this screen." : "Not configured. This field is write-only."}</small></div>
                <label className="models-ai-sr-only" htmlFor="models-ai-credential">New provider credential</label>
                <input autoComplete="new-password" id="models-ai-credential" placeholder="Enter a new credential" type="password" value={credentialDraft.providerId === selectedProvider.id ? credentialDraft.value : ""} onChange={(event) => { setCredentialStatus(""); setCredentialDraft({ providerId: selectedProvider.id, value: event.currentTarget.value }); }} />
                <button disabled={!credentialDraft.value.trim() || credentialBusy} onClick={() => void storeCredential()} type="button">{credentialBusy ? "Storing…" : "Store"}</button>
                <button disabled={!selectedProvider.credentialConfigured || credentialBusy || Boolean(pendingAction)} onClick={() => onDeleteCredential(selectedProvider.id)} type="button">{pendingAction === `delete-credential:${selectedProvider.id}` ? "Removing…" : "Remove"}</button>
              </div> : null}

              <div className="models-ai-actions">
                {selectedProvider.kind === "ollama" || selectedProvider.kind === "openai_compatible" ? <>
                  <button disabled={!selectedProvider.enabled || isBusy} onClick={() => onTestConnection(selectedProvider.id)} type="button">{connection.isTesting ? "Testing…" : "Test connection"}</button>
                  <button disabled={!selectedProvider.enabled || isBusy} onClick={() => onRefreshModels(selectedProvider.id)} type="button">{connection.isRefreshing ? "Loading…" : "List models"}</button>
                </> : null}
                {!selectedProvider.managed ? <button className="models-ai-danger" disabled={isBusy || isSaving} onClick={() => { clearCredentialDraft(); onDeleteProvider(selectedProvider.id); }} type="button">{pendingAction === `delete-provider:${selectedProvider.id}` ? "Deleting…" : "Delete provider"}</button> : null}
              </div>
              <div className={`models-ai-connection is-${connection.status}`} role={connection.status === "error" ? "alert" : "status"}>{connection.message ?? "Connection has not been tested."}</div>
            </section>

            {selectedProvider.kind === "ollama" ? <OllamaManager pendingAction={pendingAction} setup={ollamaSetup} onCancel={onCancelManagedModelInstall} onCheck={onCheckOllama} onInstall={onInstallManagedModel} onRemove={onRemoveManagedModel} /> : null}

            <section className="models-ai-card" aria-labelledby="models-ai-models-title">
              <div className="models-ai-section-heading"><h2 id="models-ai-models-title">Models</h2><span>{selectedModels.length}</span></div>
              {selectedModels.length ? <div className="models-ai-model-list">{selectedModels.map((model) => <ModelCard key={model.id} model={model} />)}</div> : <p className="models-ai-empty">No models reported. Use List models for supported chat providers.</p>}
            </section>
          </> : <p className="models-ai-empty">No provider is selected.</p>}
        </div>
      </div>

      <section className="models-ai-card models-ai-stt" aria-labelledby="models-ai-stt-title">
        <div className="models-ai-section-heading"><div><p className="models-ai-kicker">Speech to text</p><h2 id="models-ai-stt-title">Voice metadata</h2></div><span>Voice controls arrive in Phase 6</span></div>
        {providers.filter((provider) => provider.capabilities.speechToText).map((provider) => <p key={provider.id}><strong>{provider.name}</strong> · {provider.dataSharing} · {provider.enabled ? "enabled" : "disabled"}</p>)}
      </section>
    </section>
  );
});

function OllamaManager({ pendingAction, setup, onCancel, onCheck, onInstall, onRemove }: { pendingAction: string; setup: OllamaSetupState; onCancel: () => void; onCheck: () => void; onInstall: () => void; onRemove: () => void }) {
  const busy = setup.status === "checking" || setup.status === "installing" || setup.status === "verifying";
  const percent = setup.progress?.completedBytes && setup.progress.totalBytes
    ? Math.min(100, Math.round(setup.progress.completedBytes / setup.progress.totalBytes * 100))
    : undefined;
  return <section className="models-ai-card models-ai-ollama" aria-labelledby="models-ai-ollama-title">
    <div className="models-ai-section-heading"><div><p className="models-ai-kicker">Local setup</p><h2 id="models-ai-ollama-title">Managed Ollama model</h2></div><span className={`models-ai-setup-state is-${setup.status}`}>{setup.status}</span></div>
    <p aria-live="polite" role="status">{setup.message}</p>
    {setup.status === "error" ? <div className="models-ai-alert" role="alert">{setup.message}</div> : null}
    {percent !== undefined ? <progress aria-label="Model download progress" max="100" value={percent}>{percent}%</progress> : null}
    <div className="models-ai-actions">
      <button disabled={busy} onClick={onCheck} type="button">Check status</button>
      {!setup.ollama?.managedModelInstalled ? <button disabled={busy || setup.ollama?.service !== "ready"} onClick={onInstall} type="button">Install managed model</button> : null}
      {setup.status === "installing" || setup.status === "verifying" ? <button onClick={onCancel} type="button">Cancel download</button> : null}
      {setup.ollama?.managedModelInstalled ? <button className="models-ai-danger" disabled={busy || !setup.ollama.canRemove || Boolean(pendingAction)} onClick={onRemove} type="button">{pendingAction === "remove-managed-model" ? "Removing…" : "Remove managed model"}</button> : null}
    </div>
  </section>;
}

function ModelCard({ model }: { model: ModelsAIModel }) {
  const capabilities = [
    model.capabilities.chat && "Chat",
    model.capabilities.embeddings && "Embeddings",
    model.capabilities.vision && "Vision",
    model.capabilities.speechToText && "Speech to text",
    model.capabilities.streaming && "Streaming",
  ].filter(Boolean);
  return <article className="models-ai-model-card">
    <div><strong>{model.name}</strong><small>{model.runtimeName}</small></div>
    <dl>
      <div><dt>Capabilities</dt><dd>{capabilities.join(", ") || "Not reported"}</dd></div>
      <div><dt>Context</dt><dd>{model.contextWindowTokens?.toLocaleString() ?? "Not reported"}</dd></div>
      <div><dt>Memory</dt><dd>{formatBytes(model.estimatedMemoryBytes)}</dd></div>
      <div><dt>Platforms</dt><dd>{model.platforms.join(", ") || "Not reported"}</dd></div>
      <div><dt>License</dt><dd>{model.license.url ? <a href={model.license.url} rel="noreferrer" target="_blank">{model.license.name}</a> : model.license.name}</dd></div>
      <div><dt>Structured tools</dt><dd>{model.structuredToolSupport} · {model.executionMode.replace("_", " ")}</dd></div>
    </dl>
  </article>;
}

function availableModels(models: ModelsAIModel[], providers: ModelsAIProvider[], capability: "chat" | "embeddings") {
  return models.flatMap((model) => {
    const provider = providers.find((candidate) => candidate.id === model.providerId);
    return provider?.enabled && model.capabilities[capability] ? [{ model, provider }] : [];
  });
}

function providerKindLabel(kind: ModelsAIProvider["kind"]) {
  if (kind === "ollama") return "Ollama";
  if (kind === "llama_harness") return "llama-harness";
  if (kind === "speech_to_text") return "Speech to text";
  return "OpenAI-compatible";
}

function formatBytes(value?: number) {
  if (!value) return "Not reported";
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
