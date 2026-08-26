import { memo, useMemo, useState } from "react";
import type { AIModel, AIProvider, ProviderType } from "../aiTypes";
import { getProviderTypeLabel } from "../services/aiProviderStorage";

export type ProviderConnectionState = {
  isRefreshing?: boolean;
  isTesting?: boolean;
  message?: string;
  status: "idle" | "ok" | "error";
};

type AIProvidersSettingsProps = {
  connectionStates: Record<string, ProviderConnectionState>;
  defaultChatModelId: string;
  defaultEmbeddingModelId: string;
  models: AIModel[];
  providers: AIProvider[];
  selectedProviderId: string;
  onAddProvider: (type: ProviderType) => void;
  onClose: () => void;
  onDeleteProvider: (providerId: string) => void;
  onRefreshModels: (providerId: string) => void;
  onSelectProvider: (providerId: string) => void;
  onSetDefaultChatModel: (modelId: string) => void;
  onSetDefaultEmbeddingModel: (modelId: string) => void;
  onTestConnection: (providerId: string) => void;
  onUpdateProvider: (providerId: string, updates: Partial<AIProvider>) => void;
};

const providerTypeOptions: Array<{ label: string; value: ProviderType }> = [
  { label: "Ollama", value: "ollama" },
  { label: "LM Studio", value: "lm-studio" },
  { label: "OpenAI-compatible", value: "openai-compatible" },
  { label: "OpenAI API", value: "openai" },
];

const emptyConnectionState: ProviderConnectionState = { status: "idle" };

export const AIProvidersSettings = memo(function AIProvidersSettings({
  connectionStates,
  defaultChatModelId,
  defaultEmbeddingModelId,
  models,
  providers,
  selectedProviderId,
  onAddProvider,
  onClose,
  onDeleteProvider,
  onRefreshModels,
  onSelectProvider,
  onSetDefaultChatModel,
  onSetDefaultEmbeddingModel,
  onTestConnection,
  onUpdateProvider,
}: AIProvidersSettingsProps) {
  const [newProviderType, setNewProviderType] = useState<ProviderType>("ollama");
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers[0];
  const selectedProviderModels = useMemo(
    () =>
      selectedProvider
        ? models.filter((model) => model.providerId === selectedProvider.id)
        : [],
    [models, selectedProvider],
  );
  const enabledChatModels = models.filter((model) => {
    const provider = providers.find(
      (currentProvider) => currentProvider.id === model.providerId,
    );

    return Boolean(provider?.enabled && model.capabilities.chat);
  });
  const enabledEmbeddingModels = models.filter((model) => {
    const provider = providers.find(
      (currentProvider) => currentProvider.id === model.providerId,
    );

    return Boolean(provider?.enabled && model.capabilities.embeddings);
  });
  const selectedProviderState =
    (selectedProvider && connectionStates[selectedProvider.id]) ??
    emptyConnectionState;

  return (
    <section className="ai-providers-screen" aria-labelledby="ai-providers-title">
      <header className="ai-providers-header">
        <div>
          <h2 id="ai-providers-title">AI Providers</h2>
          <p>Connect local runtimes, cloud APIs, and OpenAI-compatible servers.</p>
        </div>
        <button
          aria-label="Close AI Providers"
          className="ai-providers-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>

      <div className="ai-providers-layout">
        <aside className="ai-providers-list" aria-label="AI provider list">
          <div className="ai-providers-add">
            <select
              aria-label="Provider type"
              value={newProviderType}
              onChange={(event) =>
                setNewProviderType(event.currentTarget.value as ProviderType)
              }
            >
              {providerTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button onClick={() => onAddProvider(newProviderType)} type="button">
              Add Provider
            </button>
          </div>

          <div className="ai-provider-items">
            {providers.length === 0 ? (
              <p className="ai-provider-empty">No providers</p>
            ) : (
              providers.map((provider) => {
                const connectionState =
                  connectionStates[provider.id] ?? emptyConnectionState;

                return (
                  <button
                    aria-pressed={provider.id === selectedProvider?.id}
                    className={`ai-provider-item ${
                      provider.id === selectedProvider?.id ? "is-selected" : ""
                    }`}
                    key={provider.id}
                    onClick={() => onSelectProvider(provider.id)}
                    type="button"
                  >
                    <span className="ai-provider-item-title">{provider.name}</span>
                    <span className="ai-provider-item-meta">
                      {getProviderTypeLabel(provider.type)}
                    </span>
                    <span
                      className={`ai-provider-status-dot is-${connectionState.status}`}
                      title={connectionState.message ?? "Not tested"}
                    />
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <main className="ai-provider-detail">
          <section className="ai-provider-defaults">
            <label className="ai-provider-field">
              <span>Default chat model</span>
              <select
                value={defaultChatModelId}
                onChange={(event) =>
                  onSetDefaultChatModel(event.currentTarget.value)
                }
              >
                <option value="">No default chat model</option>
                {enabledChatModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {formatModelOption(model, providers)}
                  </option>
                ))}
              </select>
            </label>
            <label className="ai-provider-field">
              <span>Default embedding model</span>
              <select
                value={defaultEmbeddingModelId}
                onChange={(event) =>
                  onSetDefaultEmbeddingModel(event.currentTarget.value)
                }
              >
                <option value="">No default embedding model</option>
                {enabledEmbeddingModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {formatModelOption(model, providers)}
                  </option>
                ))}
              </select>
            </label>
          </section>

          {selectedProvider ? (
            <>
              <section className="ai-provider-form">
                <label className="ai-provider-field">
                  <span>Name</span>
                  <input
                    value={selectedProvider.name}
                    onChange={(event) =>
                      onUpdateProvider(selectedProvider.id, {
                        name: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label className="ai-provider-field">
                  <span>Provider type</span>
                  <select
                    value={selectedProvider.type}
                    onChange={(event) =>
                      onUpdateProvider(selectedProvider.id, {
                        type: event.currentTarget.value as ProviderType,
                      })
                    }
                  >
                    {providerTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ai-provider-field">
                  <span>Base URL</span>
                  <input
                    value={selectedProvider.baseUrl}
                    onChange={(event) =>
                      onUpdateProvider(selectedProvider.id, {
                        baseUrl: event.currentTarget.value,
                      })
                    }
                    placeholder="http://localhost:11434"
                  />
                </label>
                <label className="ai-provider-field">
                  <span>API key</span>
                  <input
                    autoComplete="off"
                    type="password"
                    value={selectedProvider.apiKey ?? ""}
                    onChange={(event) =>
                      onUpdateProvider(selectedProvider.id, {
                        apiKey: event.currentTarget.value,
                      })
                    }
                    placeholder={
                      selectedProvider.type === "openai"
                        ? "Required"
                        : "Optional"
                    }
                  />
                </label>
                <label className="ai-provider-toggle">
                  <input
                    checked={selectedProvider.enabled}
                    type="checkbox"
                    onChange={(event) =>
                      onUpdateProvider(selectedProvider.id, {
                        enabled: event.currentTarget.checked,
                      })
                    }
                  />
                  <span>Enabled</span>
                </label>
              </section>

              <section className="ai-provider-actions">
                <button
                  disabled={selectedProviderState.isTesting}
                  onClick={() => onTestConnection(selectedProvider.id)}
                  type="button"
                >
                  {selectedProviderState.isTesting ? "Testing..." : "Test Connection"}
                </button>
                <button
                  disabled={selectedProviderState.isRefreshing}
                  onClick={() => onRefreshModels(selectedProvider.id)}
                  type="button"
                >
                  {selectedProviderState.isRefreshing
                    ? "Refreshing..."
                    : "Refresh Models"}
                </button>
                <button
                  className="ai-provider-delete"
                  onClick={() => onDeleteProvider(selectedProvider.id)}
                  type="button"
                >
                  Delete Provider
                </button>
              </section>

              <div
                className={`ai-provider-status-message is-${selectedProviderState.status}`}
                role={selectedProviderState.status === "error" ? "alert" : "status"}
              >
                {selectedProviderState.message ?? "Connection not tested."}
              </div>

              <section className="ai-provider-models">
                <div className="ai-provider-models-header">
                  <h3>Models</h3>
                  <span>{selectedProviderModels.length}</span>
                </div>
                {selectedProviderModels.length === 0 ? (
                  <p className="ai-provider-empty">Refresh models to populate this list.</p>
                ) : (
                  <div className="ai-provider-model-list">
                    {selectedProviderModels.map((model) => (
                      <div className="ai-provider-model-row" key={model.id}>
                        <span>{model.name}</span>
                        <small>{formatCapabilities(model)}</small>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : (
            <div className="ai-provider-no-selection">
              Add a provider to configure AI chat.
            </div>
          )}
        </main>
      </div>
    </section>
  );
});

function formatModelOption(model: AIModel, providers: AIProvider[]) {
  const provider = providers.find(
    (currentProvider) => currentProvider.id === model.providerId,
  );

  return provider ? `${provider.name} / ${model.name}` : model.name;
}

function formatCapabilities(model: AIModel) {
  const capabilities = [
    model.capabilities.chat ? "chat" : "",
    model.capabilities.embeddings ? "embeddings" : "",
    model.capabilities.vision ? "vision" : "",
    model.capabilities.tools ? "tools" : "",
    model.capabilities.streaming ? "streaming" : "",
  ].filter(Boolean);

  return capabilities.length > 0 ? capabilities.join(", ") : "unknown";
}
