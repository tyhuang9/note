import { invoke, isTauri, transformCallback } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type ModelsAIProviderKind =
  | "ollama"
  | "llama_harness"
  | "openai_compatible"
  | "speech_to_text";
export type ModelsAIDataSharing = "local" | "remote";
export type ModelsAIExecutionMode = "tools" | "chat_only";
export type ModelsAIChatRole = "system" | "user" | "assistant";

export type ModelsAIProvider = {
  id: string;
  name: string;
  kind: ModelsAIProviderKind;
  baseUrl?: string;
  enabled: boolean;
  dataSharing: ModelsAIDataSharing;
  credentialConfigured: boolean;
  capabilities: { chat: boolean; embeddings: boolean; speechToText: boolean };
  managed: boolean;
};

export type ModelsAIModel = {
  id: string;
  providerId: string;
  runtimeName: string;
  name: string;
  capabilities: {
    chat: boolean;
    embeddings: boolean;
    vision: boolean;
    speechToText: boolean;
    streaming: boolean;
  };
  contextWindowTokens?: number;
  estimatedMemoryBytes?: number;
  platforms: string[];
  license: { name: string; url?: string };
  expectedDownloadBytes?: number;
  managedRemoval: "note_managed_only" | "not_supported";
  ownedByNote: boolean;
  structuredToolSupport: "reliable" | "unverified" | "unsupported";
  executionMode: ModelsAIExecutionMode;
};

export type ModelsAIState = {
  schemaVersion: 1;
  revision: number;
  legacyMigrationCompleted: boolean;
  providers: ModelsAIProvider[];
  models: ModelsAIModel[];
  defaultChatModelId?: string;
  defaultEmbeddingModelId?: string;
  selectedLlamaHarnessAgentId?: string;
};

export type ModelsAIProviderSettingsInput = Pick<
  ModelsAIProvider,
  "id" | "name" | "kind" | "baseUrl" | "enabled" | "dataSharing"
>;

export type ModelsAISettingsSaveRequest = {
  expectedRevision: number;
  defaultChatModelId: string | null;
  defaultEmbeddingModelId: string | null;
  selectedLlamaHarnessAgentId: string | null;
  providers: ModelsAIProviderSettingsInput[];
};

export type LegacyMigrationRequest = {
  legacySettings: {
    defaultChatModelId?: string;
    defaultEmbeddingModelId?: string;
    providers: Array<{
      id: string;
      name: string;
      type: "ollama" | "lm-studio" | "openai-compatible" | "openai";
      baseUrl: string;
      enabled: boolean;
    }>;
    models: Array<{
      id: string;
      providerId: string;
      name: string;
      capabilities: {
        chat: boolean;
        embeddings: boolean;
        vision: boolean;
        tools: boolean;
        streaming: boolean;
      };
    }>;
  } | null;
  legacyCredentials: Array<{ providerId: string; credential: string }>;
  selectedLlamaHarnessAgentId: string | null;
};

export type ModelsAIMigrationResponse = {
  status: "completed" | "already_completed";
  migratedProviderIds: string[];
  migratedCredentialProviderIds: string[];
  state: ModelsAIState;
};

export type ModelsAICredentialResponse = {
  providerId: string;
  credentialConfigured: boolean;
};

export type ModelsAIProviderTestResponse = {
  providerId: string;
  status: "reachable";
  latencyMs: number;
  message: string;
};

export type ModelsAIProviderModelsResponse = {
  providerId: string;
  models: ModelsAIModel[];
  stateRevision: number;
};

export type ModelsAIChatResponse = {
  providerId: string;
  modelId: string;
  content: string;
  executionMode: "chat_only";
};

export type ModelsAIError = { code: string; message: string; field?: string };
export class ModelsAIClientError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly isStructured: boolean;

  constructor(error: ModelsAIError, isStructured: boolean) {
    super(error.message);
    this.name = "ModelsAIClientError";
    this.code = error.code;
    this.field = error.field;
    this.isStructured = isStructured;
  }
}

export type OllamaStatus = {
  service: "ready" | "unavailable" | "error";
  version?: string;
  availableModels: string[];
  managedModelInstalled: boolean;
  managedModelOwnedByNote: boolean;
  canRemove: boolean;
  pullInProgress: boolean;
  operationId?: string;
  error?: ModelsAIError;
};

export type ModelProgressEvent = {
  operationId: string;
  modelId: string;
  state: "starting" | "downloading" | "verifying" | "complete" | "cancelled" | "failed";
  completedBytes?: number;
  totalBytes?: number;
  error?: ModelsAIError;
};

const unavailable: ModelsAIError = {
  code: "storage_unavailable",
  message: "Models & AI is available in the Note desktop app.",
};
const modelProgressEvent = "note://model-progress";

function unregisterModelProgressCallback(eventId: number) {
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(modelProgressEvent, eventId);
}

function toError(error: unknown) {
  const candidate = error as Partial<ModelsAIError> | null;
  const structured = Boolean(
    candidate &&
      typeof candidate.code === "string" &&
      typeof candidate.message === "string",
  );
  return new ModelsAIClientError(
    structured
      ? {
          code: candidate!.code!,
          message: candidate!.message!,
          ...(typeof candidate?.field === "string" ? { field: candidate.field } : {}),
        }
      : unavailable,
    structured,
  );
}

async function call<T>(command: string, request: unknown): Promise<T> {
  if (!isTauri()) throw toError(unavailable);
  try {
    return await invoke<T>(command, { request });
  } catch (error) {
    throw toError(error);
  }
}

async function callWithoutRequest<T>(command: string): Promise<T> {
  if (!isTauri()) throw toError(unavailable);
  try {
    return await invoke<T>(command);
  } catch (error) {
    throw toError(error);
  }
}

export function isModelsAIClientError(error: unknown): error is ModelsAIClientError {
  return error instanceof ModelsAIClientError;
}

export const modelsAIClient = {
  stateGet: () => callWithoutRequest<ModelsAIState>("models_ai_state_get"),
  settingsSave: (request: ModelsAISettingsSaveRequest) =>
    call<ModelsAIState>("models_ai_settings_save", request),
  migrateLegacy: (request: LegacyMigrationRequest) =>
    call<ModelsAIMigrationResponse>("models_ai_migrate_legacy", request),
  credentialSet: (providerId: string, credential: string) =>
    call<ModelsAICredentialResponse>("models_ai_credential_set", {
      providerId,
      credential,
    }),
  credentialDelete: (providerId: string) =>
    call<ModelsAICredentialResponse>("models_ai_credential_delete", { providerId }),
  providerTest: (providerId: string) =>
    call<ModelsAIProviderTestResponse>("models_ai_provider_test", { providerId }),
  providerListModels: (providerId: string) =>
    call<ModelsAIProviderModelsResponse>("models_ai_provider_list_models", {
      providerId,
    }),
  chat: (
    providerId: string,
    modelId: string,
    messages: Array<{ role: ModelsAIChatRole; content: string }>,
  ) =>
    call<ModelsAIChatResponse>("models_ai_chat", { providerId, modelId, messages }),
  ollamaStatus: () =>
    callWithoutRequest<OllamaStatus>("models_ai_ollama_status"),
  ollamaPull: (modelId: string) =>
    call<OllamaStatus>("models_ai_ollama_pull", { modelId }),
  ollamaCancelPull: () =>
    callWithoutRequest<OllamaStatus>("models_ai_ollama_cancel_pull"),
  ollamaRemove: (modelId: string) =>
    call<OllamaStatus>("models_ai_ollama_remove", { modelId }),
  async listenToModelProgress(handler: (event: ModelProgressEvent) => void): Promise<UnlistenFn> {
    if (!isTauri()) return Promise.resolve(() => undefined);
    const callbackId = transformCallback<{ payload: ModelProgressEvent }>(({ payload }) => handler(payload));
    let eventId: number;
    try {
      eventId = await invoke<number>("plugin:event|listen", {
        event: modelProgressEvent,
        target: { kind: "Any" },
        handler: callbackId,
      });
    } catch (error) {
      unregisterModelProgressCallback(callbackId);
      throw error;
    }
    return async () => {
      unregisterModelProgressCallback(eventId);
      await invoke("plugin:event|unlisten", { event: modelProgressEvent, eventId });
    };
  },
};
