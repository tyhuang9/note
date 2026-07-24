import { useEffect, useState } from "react";
import type { AIModel, AIProvider, ProviderType } from "../../aiTypes";
import { listAIProviderModels, testAIProvider } from "../../services/aiProviderAdapters";
import {
  createAIProvider,
  deleteProviderCredential,
  loadAIProviderSettings,
  saveAIProviderSettings,
} from "../../services/aiProviderStorage";

export type ProviderConnectionState = {
  isRefreshing?: boolean;
  isTesting?: boolean;
  message?: string;
  status: "idle" | "ok" | "error";
};

export function useAIProviderSettings() {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [models, setModels] = useState<AIModel[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [defaultChatModelId, setDefaultChatModelId] = useState("");
  const [defaultEmbeddingModelId, setDefaultEmbeddingModelId] = useState("");
  const [connectionStates, setConnectionStates] = useState<
    Record<string, ProviderConnectionState>
  >({});

  useEffect(() => {
    let isMounted = true;

    void loadAIProviderSettings()
      .then((settings) => {
        if (!isMounted) {
          return;
        }

        setProviders(settings.providers);
        setModels(settings.models);
        setDefaultChatModelId(settings.defaultChatModelId ?? "");
        setDefaultEmbeddingModelId(settings.defaultEmbeddingModelId ?? "");
        setSelectedProviderId(settings.providers[0]?.id ?? "");
      })
      .finally(() => {
        if (isMounted) {
          setIsLoaded(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    void saveAIProviderSettings({
      defaultChatModelId: defaultChatModelId || undefined,
      defaultEmbeddingModelId: defaultEmbeddingModelId || undefined,
      models,
      providers,
    }).catch((error) => {
      console.warn("Could not save AI provider settings.", error);
    });
  }, [
    defaultChatModelId,
    defaultEmbeddingModelId,
    isLoaded,
    models,
    providers,
  ]);

  function setConnectionState(
    providerId: string,
    updates: ProviderConnectionState,
  ) {
    setConnectionStates((currentStates) => ({
      ...currentStates,
      [providerId]: updates,
    }));
  }

  function addProvider(type: ProviderType) {
    const provider = createAIProvider(type);

    setProviders((currentProviders) => [...currentProviders, provider]);
    setSelectedProviderId(provider.id);
    setConnectionState(provider.id, { status: "idle" });
    setIsOpen(true);
  }

  function updateProvider(providerId: string, updates: Partial<AIProvider>) {
    setProviders((currentProviders) =>
      currentProviders.map((provider) =>
        provider.id === providerId ? { ...provider, ...updates } : provider,
      ),
    );
    setConnectionState(providerId, { status: "idle" });
  }

  function deleteProvider(providerId: string) {
    setProviders((currentProviders) =>
      currentProviders.filter((provider) => provider.id !== providerId),
    );
    setModels((currentModels) =>
      currentModels.filter((model) => model.providerId !== providerId),
    );
    setConnectionStates((currentStates) => {
      const nextStates = { ...currentStates };

      delete nextStates[providerId];
      return nextStates;
    });
    setDefaultChatModelId((currentModelId) =>
      models.find((model) => model.id === currentModelId)?.providerId === providerId
        ? ""
        : currentModelId,
    );
    setDefaultEmbeddingModelId((currentModelId) =>
      models.find((model) => model.id === currentModelId)?.providerId === providerId
        ? ""
        : currentModelId,
    );
    setSelectedProviderId((currentProviderId) =>
      currentProviderId === providerId
        ? providers.find((provider) => provider.id !== providerId)?.id ?? ""
        : currentProviderId,
    );
    void deleteProviderCredential(providerId).catch((error) => {
      console.warn("Could not delete AI provider credential.", error);
    });
  }

  async function testConnection(providerId: string) {
    const provider = providers.find((item) => item.id === providerId);

    if (!provider) {
      return;
    }

    setConnectionState(providerId, {
      isTesting: true,
      message: "Testing connection...",
      status: "idle",
    });

    try {
      const result = await testAIProvider(provider);
      const latencyMessage = result.latencyMs ? ` (${result.latencyMs} ms)` : "";

      setConnectionState(providerId, {
        message: `${result.message}${latencyMessage}`,
        status: result.ok ? "ok" : "error",
      });
    } catch (error) {
      setConnectionState(providerId, {
        message: getErrorMessage(error),
        status: "error",
      });
    }
  }

  async function refreshModels(providerId: string) {
    const provider = providers.find((item) => item.id === providerId);

    if (!provider) {
      return;
    }

    setConnectionState(providerId, {
      isRefreshing: true,
      message: "Refreshing models...",
      status: "idle",
    });

    try {
      const providerModels = await listAIProviderModels(provider);

      setModels((currentModels) => [
        ...currentModels.filter((model) => model.providerId !== providerId),
        ...providerModels,
      ]);
      setDefaultChatModelId((currentModelId) =>
        currentModelId ||
        providerModels.find((model) => model.capabilities.chat)?.id ||
        "",
      );
      setDefaultEmbeddingModelId((currentModelId) =>
        currentModelId ||
        providerModels.find((model) => model.capabilities.embeddings)?.id ||
        "",
      );
      setConnectionState(providerId, {
        message: `Found ${providerModels.length} models.`,
        status: "ok",
      });
    } catch (error) {
      setConnectionState(providerId, {
        message: getErrorMessage(error),
        status: "error",
      });
    }
  }

  return {
    addProvider,
    close: () => setIsOpen(false),
    connectionStates,
    defaultChatModelId,
    defaultEmbeddingModelId,
    deleteProvider,
    isOpen,
    models,
    open: () => setIsOpen(true),
    providers,
    refreshModels,
    selectedProviderId,
    setDefaultChatModelId,
    setDefaultEmbeddingModelId,
    setSelectedProviderId,
    testConnection,
    updateProvider,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
