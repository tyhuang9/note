import type {
  AssistantMessage,
  LlmChatRequest,
  LlmChatResponse,
  LlmProviderConfig,
  LlmProviderKind,
} from "../aiTypes";

const OLLAMA_CHAT_ENDPOINT = "api/chat";
const OPENAI_CHAT_COMPLETIONS_ENDPOINT = "chat/completions";
const ERROR_BODY_MAX_LENGTH = 500;

type ProviderChatMessage = Pick<AssistantMessage, "content" | "role">;

export const DEFAULT_OLLAMA_LLM_CONFIG: LlmProviderConfig = {
  baseUrl: "http://localhost:11434",
  kind: "ollama",
  model: "llama3.2",
  name: "Ollama",
};

export const DEFAULT_OPENAI_COMPATIBLE_LLM_CONFIG: LlmProviderConfig = {
  baseUrl: "http://localhost:1234/v1",
  kind: "openai-compatible",
  model: "local-model",
  name: "OpenAI-compatible local LLM",
};

export const DEFAULT_LOCAL_LLM_CONFIG: LlmProviderConfig =
  DEFAULT_OLLAMA_LLM_CONFIG;

export class LocalModelProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalModelProviderError";
  }
}

export function normalizeProviderBaseUrl(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim();

  if (trimmedBaseUrl.length === 0) {
    throw new LocalModelProviderError("Provider base URL is required.");
  }

  const urlWithProtocol = hasUrlProtocol(trimmedBaseUrl)
    ? trimmedBaseUrl
    : `http://${trimmedBaseUrl}`;

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(urlWithProtocol);
  } catch {
    throw new LocalModelProviderError(
      `Invalid provider base URL "${baseUrl}". Use a local HTTP URL such as http://localhost:11434.`,
    );
  }

  if (parsedUrl.hostname.length === 0) {
    throw new LocalModelProviderError(
      `Invalid provider base URL "${baseUrl}". A host is required.`,
    );
  }

  parsedUrl.hash = "";
  parsedUrl.search = "";
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");

  return parsedUrl.toString().replace(/\/+$/, "");
}

export function getProviderEndpointUrl(
  baseUrl: string,
  endpointPath: string,
): string {
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
  const normalizedEndpointPath = endpointPath.replace(/^\/+/, "");

  return new URL(`${normalizedEndpointPath}`, `${normalizedBaseUrl}/`).toString();
}

export async function callOllamaChat(
  request: LlmChatRequest,
): Promise<LlmChatResponse> {
  assertLlmProviderKind(request.config, "ollama");

  const url = getProviderEndpointUrl(
    request.config.baseUrl,
    OLLAMA_CHAT_ENDPOINT,
  );
  const responseJson = await postJson(request.config, url, {
    messages: buildProviderChatMessages(request),
    model: request.config.model,
    stream: false,
  });
  const providerError = extractProviderErrorMessage(responseJson);

  if (providerError) {
    throw new LocalModelProviderError(
      `${getProviderDisplayName(request.config)} returned an error: ${providerError}`,
    );
  }

  const content = readNestedText(responseJson, ["message", "content"]);
  const fallbackContent = readText(responseJson, "response");
  const model = readText(responseJson, "model") ?? request.config.model;

  if (content === undefined && fallbackContent === undefined) {
    throw new LocalModelProviderError(
      `${getProviderDisplayName(request.config)} returned a response without assistant content.`,
    );
  }

  return {
    content: content ?? fallbackContent ?? "",
    model,
    provider: "ollama",
  };
}

export async function callOpenAICompatibleChat(
  request: LlmChatRequest,
): Promise<LlmChatResponse> {
  assertLlmProviderKind(request.config, "openai-compatible");

  const url = getProviderEndpointUrl(
    request.config.baseUrl,
    OPENAI_CHAT_COMPLETIONS_ENDPOINT,
  );
  const responseJson = await postJson(request.config, url, {
    messages: buildProviderChatMessages(request),
    model: request.config.model,
    stream: false,
  });
  const providerError = extractProviderErrorMessage(responseJson);

  if (providerError) {
    throw new LocalModelProviderError(
      `${getProviderDisplayName(request.config)} returned an error: ${providerError}`,
    );
  }

  const content = readOpenAIChoiceContent(responseJson);
  const model = readText(responseJson, "model") ?? request.config.model;

  if (content === undefined) {
    throw new LocalModelProviderError(
      `${getProviderDisplayName(request.config)} returned a chat completion without assistant content.`,
    );
  }

  return {
    content,
    model,
    provider: "openai-compatible",
  };
}

function hasUrlProtocol(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(value);
}

function buildProviderChatMessages(
  request: LlmChatRequest,
): ProviderChatMessage[] {
  const providerMessages = request.messages.map(({ content, role }) => ({
    content,
    role,
  }));
  const promptSummary = request.notesContext?.promptSummary.trim();

  if (!promptSummary) {
    return providerMessages;
  }

  return [
    {
      content: `Current notes context:\n${promptSummary}`,
      role: "system",
    },
    ...providerMessages,
  ];
}

async function postJson(
  config: LlmProviderConfig,
  url: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  } catch (error) {
    throw buildFetchError(config, url, error);
  }

  return readProviderJson(config, url, response);
}

async function readProviderJson(
  config: LlmProviderConfig,
  url: string,
  response: Response,
): Promise<unknown> {
  const bodyText = await response.text();

  if (!response.ok) {
    throw new LocalModelProviderError(
      `${getProviderDisplayName(config)} request failed with HTTP ${formatHttpStatus(response)} at ${url}: ${formatProviderFailureBody(bodyText)}`,
    );
  }

  if (bodyText.trim().length === 0) {
    throw new LocalModelProviderError(
      `${getProviderDisplayName(config)} returned an empty response from ${url}.`,
    );
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new LocalModelProviderError(
      `${getProviderDisplayName(config)} returned invalid JSON from ${url}: ${truncateBody(bodyText)}`,
    );
  }
}

function buildFetchError(
  config: LlmProviderConfig,
  url: string,
  error: unknown,
): LocalModelProviderError {
  return new LocalModelProviderError(
    `Unable to reach ${getProviderDisplayName(config)} at ${url}: ${getErrorMessage(error)}`,
  );
}

function assertLlmProviderKind(
  config: LlmProviderConfig,
  expectedKind: LlmProviderKind,
): void {
  if (config.kind !== expectedKind) {
    throw new LocalModelProviderError(
      `${getProviderDisplayName(config)} is configured as "${config.kind}", but this helper requires "${expectedKind}".`,
    );
  }
}

function getProviderDisplayName(config: LlmProviderConfig): string {
  return config.name.trim() || config.kind;
}

function formatHttpStatus(response: Response): string {
  return response.statusText
    ? `${response.status} ${response.statusText}`
    : `${response.status}`;
}

function formatProviderFailureBody(bodyText: string): string {
  if (bodyText.trim().length === 0) {
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
  return typeof value === "object" && value !== null;
}
