import {
  modelsAIClient,
  type LegacyMigrationRequest,
  type ModelsAIState,
} from "../native/modelsAIClient";

export const LEGACY_MODELS_AI_KEYS = [
  "note.aiProviders.settings.v1",
  "note.aiProviders.credentials.v1",
  "note.llamaHarness.selectedAgentId.v1",
] as const;

const [SETTINGS_KEY, CREDENTIALS_KEY, AGENT_KEY] = LEGACY_MODELS_AI_KEYS;
const MAX_SETTINGS_BYTES = 512 * 1024;
const MAX_CREDENTIALS_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 160;

export async function migrateLegacyModelsAIState(
  state: ModelsAIState,
): Promise<ModelsAIState> {
  const snapshot = readLegacySnapshot();
  if (!snapshot) return state;
  const present = Object.values(snapshot).some((value) => value !== null);
  if (!present) return state;
  const request = readMigrationRequest(snapshot);
  if (state.legacyMigrationCompleted) {
    removeLegacyKeys();
    return state;
  }

  const response = await modelsAIClient.migrateLegacy(request);
  if (
    (response.status === "completed" || response.status === "already_completed") &&
    response.state.legacyMigrationCompleted
  ) {
    removeLegacyKeys();
  }
  return response.state;
}

export function readMigrationRequest(snapshot = requiredLegacySnapshot()): LegacyMigrationRequest {
  return {
    legacySettings: snapshot.settings === null
      ? null
      : requireValid(parseLegacySettings(snapshot.settings), "settings"),
    legacyCredentials: snapshot.credentials === null
      ? []
      : requireValid(parseLegacyCredentials(snapshot.credentials), "credentials"),
    selectedLlamaHarnessAgentId: snapshot.agent === null
      ? null
      : requireValid(parseLegacyAgent(snapshot.agent), "selected agent"),
  };
}

type Invalid = { invalid: true };
const invalid: Invalid = { invalid: true };
type LegacySnapshot = { settings: string | null; credentials: string | null; agent: string | null };

function parseLegacySettings(raw: string): LegacyMigrationRequest["legacySettings"] | Invalid {
  const parsed = parseJson(raw, MAX_SETTINGS_BYTES);
  if (!isRecord(parsed)) return invalid;
  if (!Array.isArray(parsed.providers) || !Array.isArray(parsed.models)) return invalid;
  if (parsed.providers.length > 32 || parsed.models.length > 256) return invalid;

  const providers = parsed.providers.map(normalizeProvider);
  const models = parsed.models.map(normalizeModel);
  if (providers.some((provider) => provider === null) || models.some((model) => model === null)) {
    return invalid;
  }
  const defaultChatModelId = optionalId(parsed.defaultChatModelId);
  const defaultEmbeddingModelId = optionalId(parsed.defaultEmbeddingModelId);
  if (defaultChatModelId === false || defaultEmbeddingModelId === false) return invalid;

  return {
    ...(defaultChatModelId ? { defaultChatModelId } : {}),
    ...(defaultEmbeddingModelId ? { defaultEmbeddingModelId } : {}),
    providers: providers as NonNullable<LegacyMigrationRequest["legacySettings"]>["providers"],
    models: models as NonNullable<LegacyMigrationRequest["legacySettings"]>["models"],
  };
}

function normalizeProvider(value: unknown) {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (
    type !== "ollama" &&
    type !== "lm-studio" &&
    type !== "openai-compatible" &&
    type !== "openai"
  ) return null;
  const id = boundedId(value.id);
  const name = boundedText(value.name, 256);
  const baseUrl = boundedText(value.baseUrl, 2_048);
  if (!id || !name || !baseUrl || typeof value.enabled !== "boolean") return null;
  return { id, name, type, baseUrl, enabled: value.enabled };
}

function normalizeModel(value: unknown) {
  if (!isRecord(value) || !isRecord(value.capabilities)) return null;
  const id = boundedId(value.id);
  const providerId = boundedId(value.providerId);
  const name = boundedText(value.name, 256);
  const capabilities = value.capabilities;
  const fields = ["chat", "embeddings", "vision", "tools", "streaming"] as const;
  if (!id || !providerId || !name || fields.some((field) => typeof capabilities[field] !== "boolean")) return null;
  return {
    id,
    providerId,
    name,
    capabilities: Object.fromEntries(
      fields.map((field) => [field, capabilities[field] as boolean]),
    ) as NonNullable<LegacyMigrationRequest["legacySettings"]>["models"][number]["capabilities"],
  };
}

function parseLegacyCredentials(raw: string): LegacyMigrationRequest["legacyCredentials"] | Invalid {
  const parsed = parseJson(raw, MAX_CREDENTIALS_BYTES);
  if (!isRecord(parsed) || Object.keys(parsed).length > 32) return invalid;
  const entries = Object.entries(parsed).map(([providerId, credential]) => ({
    providerId: boundedId(providerId),
    credential: boundedText(credential, 16 * 1024),
  }));
  if (entries.some(({ providerId, credential }) => !providerId || !credential)) return invalid;
  return entries as Array<{ providerId: string; credential: string }>;
}

function parseLegacyAgent(raw: string): string | Invalid {
  return boundedId(raw) ?? invalid;
}

function parseJson(raw: string, maximumBytes: number): unknown {
  if (!raw || new TextEncoder().encode(raw).byteLength > maximumBytes) return invalid;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return invalid;
  }
}

function optionalId(value: unknown): string | false | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedId(value) || false;
}

function boundedId(value: unknown) {
  return boundedText(value, MAX_ID_LENGTH);
}

function boundedText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && new TextEncoder().encode(trimmed).byteLength <= maximum
    ? trimmed
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireValid<T>(value: T | Invalid, label: string): T {
  if (isInvalid(value)) {
    throw new Error(`Legacy Models & AI ${label} could not be migrated safely.`);
  }
  return value;
}

function isInvalid(value: unknown): value is Invalid {
  return isRecord(value) && value.invalid === true;
}

function readLegacySnapshot(): LegacySnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    return {
      settings: storage.getItem(SETTINGS_KEY),
      credentials: storage.getItem(CREDENTIALS_KEY),
      agent: storage.getItem(AGENT_KEY),
    };
  } catch {
    throw new Error("Legacy Models & AI settings could not be read safely.");
  }
}

function requiredLegacySnapshot() {
  const snapshot = readLegacySnapshot();
  if (!snapshot) throw new Error("Legacy Models & AI settings are unavailable.");
  return snapshot;
}

function removeLegacyKeys() {
  try {
    for (const key of LEGACY_MODELS_AI_KEYS) window.localStorage.removeItem(key);
  } catch {
    throw new Error("Migrated Models & AI settings could not be cleared from legacy storage.");
  }
}
