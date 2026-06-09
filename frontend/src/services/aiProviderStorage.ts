import type {
  AIModel,
  AIProvider,
  AIProviderSettingsData,
  ProviderType,
} from "../aiTypes";

const PROVIDER_SETTINGS_STORAGE_KEY = "note.aiProviders.settings.v1";
const PROVIDER_CREDENTIALS_STORAGE_KEY = "note.aiProviders.credentials.v1";
const ROOT_PROVIDER_ID_PREFIX = "ai-provider";

export type CredentialStore = {
  deleteApiKey(providerId: string): Promise<void>;
  getApiKey(providerId: string): Promise<string | undefined>;
  setApiKey(providerId: string, apiKey: string): Promise<void>;
};

type PersistedAIProvider = Omit<AIProvider, "apiKey">;

type PersistedProviderSettings = {
  defaultChatModelId?: string;
  defaultEmbeddingModelId?: string;
  models: AIModel[];
  providers: PersistedAIProvider[];
};

class LocalStorageCredentialStore implements CredentialStore {
  async deleteApiKey(providerId: string) {
    const credentials = readCredentials();

    delete credentials[providerId];
    writeCredentials(credentials);
  }

  async getApiKey(providerId: string) {
    return readCredentials()[providerId];
  }

  async setApiKey(providerId: string, apiKey: string) {
    const credentials = readCredentials();
    const trimmedApiKey = apiKey.trim();

    if (trimmedApiKey) {
      credentials[providerId] = trimmedApiKey;
    } else {
      delete credentials[providerId];
    }

    writeCredentials(credentials);
  }
}

export const localCredentialStore: CredentialStore =
  new LocalStorageCredentialStore();

export function createAIProvider(type: ProviderType): AIProvider {
  return {
    baseUrl: getDefaultBaseUrl(type),
    enabled: true,
    id: `${ROOT_PROVIDER_ID_PREFIX}-${crypto.randomUUID()}`,
    name: getDefaultProviderName(type),
    type,
  };
}

export async function loadAIProviderSettings(
  credentialStore: CredentialStore = localCredentialStore,
): Promise<AIProviderSettingsData> {
  const persistedSettings = readPersistedProviderSettings();
  const providers = await Promise.all(
    persistedSettings.providers.map(async (provider) => ({
      ...provider,
      apiKey: await credentialStore.getApiKey(provider.id),
    })),
  );

  return {
    defaultChatModelId: persistedSettings.defaultChatModelId,
    defaultEmbeddingModelId: persistedSettings.defaultEmbeddingModelId,
    models: persistedSettings.models,
    providers,
  };
}

export async function saveAIProviderSettings(
  settings: AIProviderSettingsData,
  credentialStore: CredentialStore = localCredentialStore,
) {
  const persistedProviders = settings.providers.map(stripProviderCredential);

  writeProviderSettings({
    defaultChatModelId: settings.defaultChatModelId,
    defaultEmbeddingModelId: settings.defaultEmbeddingModelId,
    models: settings.models,
    providers: persistedProviders,
  });

  await Promise.all(
    settings.providers.map((provider) =>
      credentialStore.setApiKey(provider.id, provider.apiKey ?? ""),
    ),
  );
}

export async function deleteProviderCredential(
  providerId: string,
  credentialStore: CredentialStore = localCredentialStore,
) {
  await credentialStore.deleteApiKey(providerId);
}

export function getProviderTypeLabel(type: ProviderType) {
  if (type === "ollama") {
    return "Ollama";
  }

  if (type === "lm-studio") {
    return "LM Studio";
  }

  if (type === "openai") {
    return "OpenAI API";
  }

  return "OpenAI-compatible";
}

export function getDefaultBaseUrl(type: ProviderType) {
  if (type === "ollama") {
    return "http://localhost:11434";
  }

  if (type === "lm-studio") {
    return "http://localhost:1234/v1";
  }

  if (type === "openai") {
    return "https://api.openai.com/v1";
  }

  return "http://localhost:1234/v1";
}

function getDefaultProviderName(type: ProviderType) {
  if (type === "ollama") {
    return "Ollama local";
  }

  if (type === "lm-studio") {
    return "LM Studio local";
  }

  if (type === "openai") {
    return "OpenAI";
  }

  return "OpenAI-compatible";
}

function stripProviderCredential(provider: AIProvider): PersistedAIProvider {
  const { apiKey: _apiKey, ...persistedProvider } = provider;

  return persistedProvider;
}

function readPersistedProviderSettings(): PersistedProviderSettings {
  if (!canUseLocalStorage()) {
    return getEmptyProviderSettings();
  }

  const rawSettings = window.localStorage.getItem(PROVIDER_SETTINGS_STORAGE_KEY);

  if (!rawSettings) {
    return getEmptyProviderSettings();
  }

  try {
    const parsedSettings = JSON.parse(rawSettings) as Partial<PersistedProviderSettings>;

    return {
      defaultChatModelId: parsedSettings.defaultChatModelId,
      defaultEmbeddingModelId: parsedSettings.defaultEmbeddingModelId,
      models: Array.isArray(parsedSettings.models) ? parsedSettings.models : [],
      providers: Array.isArray(parsedSettings.providers)
        ? parsedSettings.providers
        : [],
    };
  } catch {
    return getEmptyProviderSettings();
  }
}

function writeProviderSettings(settings: PersistedProviderSettings) {
  if (!canUseLocalStorage()) {
    return;
  }

  window.localStorage.setItem(
    PROVIDER_SETTINGS_STORAGE_KEY,
    JSON.stringify(settings),
  );
}

function readCredentials(): Record<string, string> {
  if (!canUseLocalStorage()) {
    return {};
  }

  const rawCredentials = window.localStorage.getItem(
    PROVIDER_CREDENTIALS_STORAGE_KEY,
  );

  if (!rawCredentials) {
    return {};
  }

  try {
    const parsedCredentials = JSON.parse(rawCredentials) as unknown;

    return isRecord(parsedCredentials)
      ? Object.fromEntries(
          Object.entries(parsedCredentials).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}

function writeCredentials(credentials: Record<string, string>) {
  if (!canUseLocalStorage()) {
    return;
  }

  window.localStorage.setItem(
    PROVIDER_CREDENTIALS_STORAGE_KEY,
    JSON.stringify(credentials),
  );
}

function getEmptyProviderSettings(): PersistedProviderSettings {
  return {
    models: [],
    providers: [],
  };
}

function canUseLocalStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
