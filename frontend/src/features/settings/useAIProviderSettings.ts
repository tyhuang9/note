import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isModelsAIClientError,
  modelsAIClient,
  type ModelProgressEvent,
  type ModelsAIDataSharing,
  type ModelsAIProvider,
  type ModelsAIState,
  type OllamaStatus,
} from "../../native/modelsAIClient";
import { migrateLegacyModelsAIState } from "../../services/modelsAIMigration";

export type ProviderConnectionState = {
  isRefreshing?: boolean;
  isTesting?: boolean;
  message?: string;
  status: "idle" | "ok" | "error";
};

export type OllamaSetupState = {
  status:
    | "unchecked"
    | "checking"
    | "unavailable"
    | "ready"
    | "installing"
    | "verifying"
    | "cancelled"
    | "error";
  message: string;
  progress?: ModelProgressEvent;
  ollama?: OllamaStatus;
};

let initialStatePromise: Promise<ModelsAIState> | null = null;
function loadInitialState() {
  if (!initialStatePromise) {
    const pending = modelsAIClient.stateGet().then(migrateLegacyModelsAIState);
    initialStatePromise = pending;
    void pending.catch(() => {
      if (initialStatePromise === pending) initialStatePromise = null;
    });
  }
  return initialStatePromise;
}

function providerInput(provider: ModelsAIProvider) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    enabled: provider.enabled,
    dataSharing: provider.dataSharing,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useAIProviderSettings(isOllamaProbeActive = false, isModelsAISettingsActive = false) {
  const [state, setState] = useState<ModelsAIState | null>(null);
  const [providers, setProviders] = useState<ModelsAIProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [defaultChatModelId, setDefaultChatModelId] = useState("");
  const [defaultEmbeddingModelId, setDefaultEmbeddingModelId] = useState("");
  const [selectedLlamaHarnessAgentId, setSelectedHarnessAgentId] = useState("");
  const [connectionStates, setConnectionStates] = useState<Record<string, ProviderConnectionState>>({});
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [ollamaSetup, setOllamaSetup] = useState<OllamaSetupState>({
    status: "unchecked",
    message: "Ollama has not been checked.",
  });

  const applyState = useCallback((next: ModelsAIState) => {
    setState(next);
    setProviders(next.providers);
    setDefaultChatModelId(next.defaultChatModelId ?? "");
    setDefaultEmbeddingModelId(next.defaultEmbeddingModelId ?? "");
    setSelectedHarnessAgentId(next.selectedLlamaHarnessAgentId ?? "");
    setSelectedProviderId((current) =>
      next.providers.some((provider) => provider.id === current)
        ? current
        : next.providers[0]?.id ?? "",
    );
    setLoadStatus("ready");
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadInitialState()
      .then((next) => {
        if (mounted) applyState(next);
      })
      .catch((reason) => {
        if (!mounted) return;
        setLoadStatus(
          reason instanceof Error && reason.message.includes("desktop app")
            ? "unavailable"
            : "error",
        );
        setError(errorMessage(reason));
      });
    return () => {
      mounted = false;
    };
  }, [applyState]);

  const retryInitialState = useCallback(async () => {
    setLoadStatus("loading");
    setError("");
    try {
      applyState(await loadInitialState());
    } catch (reason) {
      setLoadStatus(
        reason instanceof Error && reason.message.includes("desktop app")
          ? "unavailable"
          : "error",
      );
      setError(errorMessage(reason));
    }
  }, [applyState]);

  const refreshState = useCallback(async () => {
    const next = await modelsAIClient.stateGet();
    applyState(next);
    return next;
  }, [applyState]);

  const applyOllamaStatus = useCallback((status: OllamaStatus) => {
    const nextStatus = status.service === "ready" ? "ready" : status.service;
    setOllamaSetup({
      status: nextStatus,
      message:
        nextStatus === "ready"
          ? status.managedModelInstalled
            ? status.canRemove
              ? "The Note-managed model is installed and ready."
              : "This model tag already exists outside Note and will not be removed by Note."
            : "Ollama is ready. Install Note’s managed model to use local chat."
          : status.error?.message ?? "Ollama is unavailable.",
      ollama: status,
    });
  }, []);

  const checkOllama = useCallback(async () => {
    setOllamaSetup({ status: "checking", message: "Checking Ollama…" });
    try {
      applyOllamaStatus(await modelsAIClient.ollamaStatus());
    } catch (reason) {
      setOllamaSetup({ status: "error", message: errorMessage(reason) });
    }
  }, [applyOllamaStatus]);

  useEffect(() => {
    if (!isOllamaProbeActive || loadStatus !== "ready") return;
    void checkOllama();
  }, [checkOllama, isOllamaProbeActive, loadStatus]);

  useEffect(() => {
    if (!isModelsAISettingsActive || loadStatus !== "ready") return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    function disposeListener(listener: () => void) {
      void Promise.resolve().then(listener).catch(() => undefined);
    }

    void modelsAIClient.listenToModelProgress((progress) => {
      if (disposed) return;
      setOllamaSetup((current) => ({
        ...current,
        progress,
        status:
          progress.state === "verifying"
            ? "verifying"
            : progress.state === "cancelled"
              ? "cancelled"
              : progress.state === "failed"
                ? "error"
                : progress.state === "complete"
                  ? "ready"
                  : "installing",
        message:
          progress.state === "cancelled"
            ? "Model installation was cancelled."
            : progress.state === "failed"
              ? progress.error?.message ?? "Model installation failed."
              : progress.state === "verifying"
                ? "Download complete. Verifying the managed model…"
                : progress.state === "complete"
                  ? "The Note-managed model is installed and ready."
                  : "Installing the Note-managed model…",
      }));
      if (progress.state === "complete") {
        void modelsAIClient.stateGet()
          .then((next) => {
            if (!disposed) applyState(next);
          })
          .catch(() => {
            if (!disposed) setOllamaSetup({ status: "error", message: "Model progress updates are unavailable." });
          });
      }
    })
      .then((dispose) => {
        if (disposed) disposeListener(dispose);
        else unlisten = dispose;
      })
      .catch(() => {
        if (!disposed) setOllamaSetup({ status: "error", message: "Model progress updates are unavailable." });
      });
    return () => {
      disposed = true;
      if (unlisten) disposeListener(unlisten);
    };
  }, [applyState, isModelsAISettingsActive, loadStatus]);

  function updateProvider(providerId: string, updates: Partial<ModelsAIProvider>) {
    setProviders((current) =>
      current.map((provider) =>
        provider.id === providerId ? { ...provider, ...updates } : provider,
      ),
    );
    setConnectionStates((current) => ({
      ...current,
      [providerId]: { status: "idle" },
    }));
  }

  function addProvider() {
    const provider: ModelsAIProvider = {
      id: `ai-provider-${crypto.randomUUID()}`,
      name: "OpenAI-compatible",
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      enabled: true,
      dataSharing: "local",
      credentialConfigured: false,
      capabilities: { chat: true, embeddings: true, speechToText: false },
      managed: false,
    };
    setProviders((current) => [...current, provider]);
    setSelectedProviderId(provider.id);
  }

  async function saveSettings(overrides?: {
    selectedLlamaHarnessAgentId?: string | null;
    nextProviders?: ModelsAIProvider[];
  }) {
    if (!state || isSaving) return null;
    setIsSaving(true);
    setError("");
    try {
      const next = await modelsAIClient.settingsSave({
        expectedRevision: state.revision,
        defaultChatModelId: defaultChatModelId || null,
        defaultEmbeddingModelId: defaultEmbeddingModelId || null,
        selectedLlamaHarnessAgentId:
          overrides?.selectedLlamaHarnessAgentId === undefined
            ? state.selectedLlamaHarnessAgentId ?? null
            : overrides.selectedLlamaHarnessAgentId,
        providers: (overrides?.nextProviders ?? providers).map(providerInput),
      });
      applyState(next);
      setMessage("Models & AI settings saved.");
      return next;
    } catch (reason) {
      setError(errorMessage(reason));
      return null;
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteProvider(providerId: string) {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider || provider.managed || pendingAction) return;
    setPendingAction(`delete-provider:${providerId}`);
    setError("");
    try {
      if (provider.credentialConfigured) {
        await modelsAIClient.credentialDelete(providerId);
      }
      const nextProviders = providers.filter((candidate) => candidate.id !== providerId);
      const saved = await saveSettings({ nextProviders });
      if (!saved) {
        setError("The credential was removed, but the provider could not be deleted. Retry saving settings.");
      }
    } catch (reason) {
      setError(`Credential removal failed; the provider was kept. ${errorMessage(reason)}`);
    } finally {
      setPendingAction("");
    }
  }

  async function setCredential(providerId: string, credential: string) {
    setError("");
    const editableProvider = providers.find((provider) => provider.id === providerId);
    const persistedProvider = state?.providers.find((provider) => provider.id === providerId);
    if (
      !editableProvider ||
      !persistedProvider ||
      editableProvider.id !== persistedProvider.id ||
      editableProvider.kind !== persistedProvider.kind ||
      editableProvider.baseUrl !== persistedProvider.baseUrl ||
      editableProvider.dataSharing !== persistedProvider.dataSharing
    ) {
      setError("Save provider changes before storing a credential.");
      return false;
    }
    try {
      const response = await modelsAIClient.credentialSet(providerId, credential);
      setProviders((current) =>
        current.map((provider) =>
          provider.id === providerId
            ? { ...provider, credentialConfigured: response.credentialConfigured }
            : provider,
        ),
      );
      setMessage("Credential stored by Note’s native service.");
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    }
  }

  async function deleteCredential(providerId: string) {
    if (pendingAction) return;
    setPendingAction(`delete-credential:${providerId}`);
    setError("");
    try {
      const response = await modelsAIClient.credentialDelete(providerId);
      setProviders((current) =>
        current.map((provider) =>
          provider.id === providerId
            ? { ...provider, credentialConfigured: response.credentialConfigured }
            : provider,
        ),
      );
      setMessage("Credential removed.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPendingAction("");
    }
  }

  async function testConnection(providerId: string) {
    setConnectionStates((current) => ({
      ...current,
      [providerId]: { status: "idle", isTesting: true, message: "Testing connection…" },
    }));
    try {
      const result = await modelsAIClient.providerTest(providerId);
      setConnectionStates((current) => ({
        ...current,
        [providerId]: {
          status: "ok",
          message: `${result.message} (${result.latencyMs} ms)`,
        },
      }));
    } catch (reason) {
      setConnectionStates((current) => ({
        ...current,
        [providerId]: { status: "error", message: errorMessage(reason) },
      }));
    }
  }

  async function refreshModels(providerId: string) {
    setConnectionStates((current) => ({
      ...current,
      [providerId]: { status: "idle", isRefreshing: true, message: "Loading models…" },
    }));
    try {
      const result = await modelsAIClient.providerListModels(providerId);
      setState((current) => current
        ? {
            ...current,
            revision: result.stateRevision,
            models: [
              ...current.models.filter((model) => model.providerId !== providerId),
              ...result.models,
            ],
          }
        : current);
      setConnectionStates((current) => ({
        ...current,
        [providerId]: { status: "ok", message: `Found ${result.models.length} models.` },
      }));
    } catch (reason) {
      setConnectionStates((current) => ({
        ...current,
        [providerId]: { status: "error", message: errorMessage(reason) },
      }));
    }
  }

  async function installManagedModel() {
    const model = state?.models.find((candidate) => candidate.managedRemoval === "note_managed_only");
    if (!model) return;
    setOllamaSetup({ status: "installing", message: "Starting model installation…" });
    try {
      applyOllamaStatus(await modelsAIClient.ollamaPull(model.id));
      await refreshState();
    } catch (reason) {
      if (isModelsAIClientError(reason) && reason.code === "model_pull_cancelled") {
        setOllamaSetup((current) => ({
          ...current,
          status: "cancelled",
          message: "Model installation was cancelled.",
        }));
      } else {
        setOllamaSetup({ status: "error", message: errorMessage(reason) });
      }
    }
  }

  async function cancelManagedModelInstall() {
    try {
      setOllamaSetup((current) => ({ ...current, message: "Cancelling installation…" }));
      await modelsAIClient.ollamaCancelPull();
    } catch (reason) {
      setOllamaSetup({ status: "error", message: errorMessage(reason) });
    }
  }

  async function removeManagedModel() {
    const model = state?.models.find((candidate) => candidate.managedRemoval === "note_managed_only");
    if (!model || !ollamaSetup.ollama?.canRemove || pendingAction) return;
    setPendingAction("remove-managed-model");
    try {
      applyOllamaStatus(await modelsAIClient.ollamaRemove(model.id));
      await refreshState();
    } catch (reason) {
      setOllamaSetup({ status: "error", message: errorMessage(reason) });
    } finally {
      setPendingAction("");
    }
  }

  async function setSelectedLlamaHarnessAgentId(agentId: string) {
    setSelectedHarnessAgentId(agentId);
    await saveSettings({ selectedLlamaHarnessAgentId: agentId || null });
  }

  const models = state?.models ?? [];
  const configuredDefaultChatModel = useMemo(
    () => models.find((model) => model.id === defaultChatModelId) ?? null,
    [defaultChatModelId, models],
  );
  const configuredDefaultChatProvider = providers.find(
    (provider) => provider.id === configuredDefaultChatModel?.providerId,
  );
  const isDefaultChatModelChecking = Boolean(
    configuredDefaultChatModel &&
      configuredDefaultChatProvider?.enabled &&
      configuredDefaultChatProvider.kind === "ollama" &&
      (ollamaSetup.status === "unchecked" || ollamaSetup.status === "checking"),
  );
  const defaultChatModel = configuredDefaultChatModel &&
    configuredDefaultChatProvider?.enabled &&
    (configuredDefaultChatProvider.kind !== "ollama" ||
      (ollamaSetup.status === "ready" &&
        ollamaSetup.ollama?.service === "ready" &&
        ollamaSetup.ollama.availableModels.includes(configuredDefaultChatModel.runtimeName)))
    ? configuredDefaultChatModel
    : null;

  return {
    addProvider,
    cancelManagedModelInstall,
    checkOllama,
    connectionStates,
    defaultChatModel,
    defaultChatModelId,
    defaultEmbeddingModelId,
    deleteCredential,
    deleteProvider,
    error,
    installManagedModel,
    isDefaultChatModelChecking,
    isSaving,
    loadStatus,
    message,
    models,
    ollamaSetup,
    pendingAction,
    providers,
    refreshModels,
    removeManagedModel,
    retryInitialState,
    saveSettings,
    selectedLlamaHarnessAgentId,
    selectedProviderId,
    setCredential,
    setDefaultChatModelId,
    setDefaultEmbeddingModelId,
    setSelectedLlamaHarnessAgentId,
    setSelectedProviderId,
    state,
    testConnection,
    updateProvider,
  };
}

export function inferDataSharing(baseUrl: string): ModelsAIDataSharing {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "::1") return "local";
    const ipv4 = host.split(".");
    return ipv4.length === 4 &&
      ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
      Number(ipv4[0]) === 127
      ? "local"
      : "remote";
  } catch {
    return "remote";
  }
}
