import type {
  AIModel,
  AIModelCapabilities,
  AIProvider,
  AIProviderAdapter,
  ChatMessage,
  ChatResponse,
  ConnectionTestResult,
  ProviderType,
} from "../aiTypes";

const ERROR_BODY_MAX_LENGTH = 500;

type ModelListResponse = {
  data?: Array<{ id?: string; name?: string; object?: string }>;
  models?: Array<{ model?: string; name?: string }>;
};

type ProviderAdapterOptions = {
  defaultBaseUrl: string;
  displayName: string;
};

export class AIProviderAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderAdapterError";
  }
}

export class OllamaProviderAdapter implements AIProviderAdapter {
  async testConnection(provider: AIProvider): Promise<ConnectionTestResult> {
    const startedAt = performance.now();

    await requestProviderJson(provider, "api/tags");

    return {
      latencyMs: Math.round(performance.now() - startedAt),
      message: "Ollama server is reachable.",
      ok: true,
    };
  }

  async listModels(provider: AIProvider): Promise<AIModel[]> {
    const response = await requestProviderJson<ModelListResponse>(
      provider,
      "api/tags",
    );
    const models = response.models ?? [];

    return models
      .map((model) => model.name ?? model.model ?? "")
      .filter(Boolean)
      .map((name) => createModel(provider, name, inferCapabilities(name)));
  }

  async sendChat(
    provider: AIProvider,
    model: AIModel,
    messages: ChatMessage[],
  ): Promise<ChatResponse> {
    const response = await requestProviderJson<unknown>(provider, "api/chat", {
      body: {
        messages: messages.map(({ content, role }) => ({ content, role })),
        model: model.name,
        stream: false,
      },
      method: "POST",
    });
    const content =
      readNestedText(response, ["message", "content"]) ??
      readText(response, "response");

    if (content === undefined) {
      throw new AIProviderAdapterError(
        `${provider.name} returned a response without assistant content.`,
      );
    }

    return {
      content,
      modelId: model.id,
      providerId: provider.id,
    };
  }
}

export class OpenAICompatibleProviderAdapter implements AIProviderAdapter {
  protected readonly options: ProviderAdapterOptions;

  constructor(options: ProviderAdapterOptions) {
    this.options = options;
  }

  async testConnection(provider: AIProvider): Promise<ConnectionTestResult> {
    const startedAt = performance.now();

    try {
      await this.listModels(provider);

      return {
        latencyMs: Math.round(performance.now() - startedAt),
        message: `${this.options.displayName} models endpoint is reachable.`,
        ok: true,
      };
    } catch (error) {
      const rootResult = await testProviderRoot(provider);

      if (rootResult.ok) {
        return {
          latencyMs: Math.round(performance.now() - startedAt),
          message:
            "Server is reachable, but the models endpoint did not return a model list.",
          ok: true,
        };
      }

      throw error;
    }
  }

  async listModels(provider: AIProvider): Promise<AIModel[]> {
    const response = await requestProviderJson<ModelListResponse>(
      provider,
      "models",
      { headers: getAuthHeaders(provider) },
    );
    const models = response.data ?? [];

    return models
      .map((model) => model.id ?? model.name ?? "")
      .filter(Boolean)
      .map((name) => createModel(provider, name, inferCapabilities(name)));
  }

  async sendChat(
    provider: AIProvider,
    model: AIModel,
    messages: ChatMessage[],
  ): Promise<ChatResponse> {
    const response = await requestProviderJson<unknown>(
      provider,
      "chat/completions",
      {
        body: {
          messages: messages.map(({ content, role }) => ({ content, role })),
          model: model.name,
          stream: false,
        },
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(provider),
        },
        method: "POST",
      },
    );
    const content = readOpenAIChoiceContent(response);

    if (content === undefined) {
      throw new AIProviderAdapterError(
        `${provider.name} returned a chat completion without assistant content.`,
      );
    }

    return {
      content,
      modelId: model.id,
      providerId: provider.id,
    };
  }
}

export class OpenAIProviderAdapter extends OpenAICompatibleProviderAdapter {
  constructor() {
    super({
      defaultBaseUrl: "https://api.openai.com/v1",
      displayName: "OpenAI",
    });
  }
}

const ollamaProviderAdapter = new OllamaProviderAdapter();
const lmStudioProviderAdapter = new OpenAICompatibleProviderAdapter({
  defaultBaseUrl: "http://localhost:1234/v1",
  displayName: "LM Studio",
});
const openAICompatibleProviderAdapter = new OpenAICompatibleProviderAdapter({
  defaultBaseUrl: "http://localhost:1234/v1",
  displayName: "OpenAI-compatible provider",
});
const openAIProviderAdapter = new OpenAIProviderAdapter();

export function getProviderAdapter(type: ProviderType): AIProviderAdapter {
  if (type === "ollama") {
    return ollamaProviderAdapter;
  }

  if (type === "lm-studio") {
    return lmStudioProviderAdapter;
  }

  if (type === "openai") {
    return openAIProviderAdapter;
  }

  return openAICompatibleProviderAdapter;
}

export async function testAIProvider(
  provider: AIProvider,
): Promise<ConnectionTestResult> {
  return getProviderAdapter(provider.type).testConnection(provider);
}

export async function listAIProviderModels(provider: AIProvider) {
  return getProviderAdapter(provider.type).listModels(provider);
}

export async function sendAIProviderChat(
  provider: AIProvider,
  model: AIModel,
  messages: ChatMessage[],
) {
  return getProviderAdapter(provider.type).sendChat(provider, model, messages);
}

export function normalizeProviderBaseUrl(baseUrl: string) {
  const trimmedBaseUrl = baseUrl.trim();

  if (!trimmedBaseUrl) {
    throw new AIProviderAdapterError("Provider base URL is required.");
  }

  const urlWithProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmedBaseUrl)
    ? trimmedBaseUrl
    : `http://${trimmedBaseUrl}`;

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(urlWithProtocol);
  } catch {
    throw new AIProviderAdapterError(
      `Invalid provider base URL "${baseUrl}". Use a URL such as http://localhost:11434.`,
    );
  }

  parsedUrl.hash = "";
  parsedUrl.search = "";
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");

  return parsedUrl.toString().replace(/\/+$/, "");
}

export function getProviderEndpointUrl(
  provider: AIProvider,
  endpointPath: string,
) {
  const normalizedBaseUrl = normalizeProviderBaseUrl(provider.baseUrl);
  const normalizedEndpointPath = endpointPath.replace(/^\/+/, "");

  return new URL(`${normalizedEndpointPath}`, `${normalizedBaseUrl}/`).toString();
}

async function requestProviderJson<T>(
  provider: AIProvider,
  endpointPath: string,
  options: {
    body?: unknown;
    headers?: HeadersInit;
    method?: "GET" | "POST";
  } = {},
): Promise<T> {
  const url = getProviderEndpointUrl(provider, endpointPath);
  let response: Response;

  try {
    response = await fetch(url, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: options.headers,
      method: options.method ?? "GET",
    });
  } catch (error) {
    throw new AIProviderAdapterError(
      `Unable to reach ${provider.name} at ${url}: ${getErrorMessage(error)}`,
    );
  }

  const bodyText = await response.text();

  if (!response.ok) {
    throw new AIProviderAdapterError(
      `${provider.name} request failed with HTTP ${formatHttpStatus(response)} at ${url}: ${formatProviderFailureBody(bodyText)}`,
    );
  }

  if (!bodyText.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new AIProviderAdapterError(
      `${provider.name} returned invalid JSON from ${url}: ${truncateBody(bodyText)}`,
    );
  }
}

async function testProviderRoot(provider: AIProvider) {
  const url = normalizeProviderBaseUrl(provider.baseUrl);

  try {
    const response = await fetch(url, {
      headers: getAuthHeaders(provider),
      method: "GET",
    });

    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

function getAuthHeaders(provider: AIProvider): HeadersInit {
  const apiKey = provider.apiKey?.trim();

  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function createModel(
  provider: AIProvider,
  name: string,
  capabilities: AIModelCapabilities,
): AIModel {
  return {
    capabilities,
    id: `${provider.id}:${name}`,
    name,
    providerId: provider.id,
  };
}

function inferCapabilities(modelName: string): AIModelCapabilities {
  const normalizedName = modelName.toLowerCase();
  const embeddings =
    normalizedName.includes("embed") ||
    normalizedName.includes("embedding") ||
    normalizedName.includes("text-embedding");
  const vision =
    normalizedName.includes("vision") ||
    normalizedName.includes("llava") ||
    normalizedName.includes("gpt-4o");

  return {
    chat: !embeddings,
    embeddings,
    vision,
    tools: !embeddings,
    streaming: !embeddings,
  };
}

function formatHttpStatus(response: Response): string {
  return response.statusText
    ? `${response.status} ${response.statusText}`
    : `${response.status}`;
}

function formatProviderFailureBody(bodyText: string): string {
  if (!bodyText.trim()) {
    return "The provider returned an empty error response.";
  }

  try {
    const parsedBody = JSON.parse(bodyText) as unknown;
    const providerMessage = extractProviderErrorMessage(parsedBody);

    return providerMessage ?? truncateBody(bodyText);
  } catch {
    return truncateBody(bodyText);
  }
}

function extractProviderErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const error = value.error;
  const message = value.message;
  const detail = value.detail;

  if (typeof error === "string") {
    return error;
  }

  if (typeof message === "string") {
    return message;
  }

  if (typeof detail === "string") {
    return detail;
  }

  return (
    extractNestedErrorMessage(error) ??
    extractNestedErrorMessage(message) ??
    extractNestedErrorMessage(detail)
  );
}

function extractNestedErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const message = value.message;
  const detail = value.detail;

  if (typeof message === "string") {
    return message;
  }

  if (typeof detail === "string") {
    return detail;
  }

  return undefined;
}

function readOpenAIChoiceContent(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return undefined;
  }

  const firstChoice = value.choices[0];

  if (!isRecord(firstChoice)) {
    return undefined;
  }

  const message = firstChoice.message;

  if (isRecord(message)) {
    return readContentValue(message.content);
  }

  return readContentValue(firstChoice.text);
}

function readNestedText(
  value: unknown,
  path: [string, string],
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const parent = value[path[0]];

  if (!isRecord(parent)) {
    return undefined;
  }

  return readContentValue(parent[path[1]]);
}

function readText(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readContentValue(value[key]);
}

function readContentValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const content = value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!isRecord(part)) {
        return "";
      }

      const text = part.text;

      if (typeof text === "string") {
        return text;
      }

      if (isRecord(text) && typeof text.value === "string") {
        return text.value;
      }

      return "";
    })
    .join("");

  return content.length > 0 ? content : undefined;
}

function truncateBody(bodyText: string): string {
  if (bodyText.length <= ERROR_BODY_MAX_LENGTH) {
    return bodyText;
  }

  return `${bodyText.slice(0, ERROR_BODY_MAX_LENGTH)}...`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
