import type {
  AssistantMessage,
  ChatMessage,
  NotesContextSnapshot,
} from "../aiTypes";
import { MAX_TOOL_CALLS_PER_ROUND, type AssistantToolManifest } from "../features/assistant/toolRegistry";

const LLAMA_HARNESS_BASE_URL = "http://127.0.0.1:8787";
const NOTE_APP_ID = "note";
const LLAMA_HARNESS_METADATA_TIMEOUT_MS = 15_000;
const LLAMA_HARNESS_RUN_TIMEOUT_MS = 120_000;
const LLAMA_HARNESS_MAX_RESPONSE_BYTES = 1024 * 1024;

class LlamaHarnessSafetyError extends Error {
  constructor(readonly code: "request_timeout" | "response_too_large" | "invalid_response", message: string) { super(message); this.name = "LlamaHarnessSafetyError"; }
}

type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

export type LlamaHarnessSetupStep =
  | "start_litellm"
  | "add_provider"
  | "select_model"
  | "create_agent"
  | "ready";

export type LlamaHarnessSetupStatus = {
  litellm_enabled: boolean;
  litellm_ready: boolean;
  usable_provider_count: number;
  usable_model_count: number;
  active_agent_count: number;
  ready: boolean;
  next_step: LlamaHarnessSetupStep;
  missing_steps: LlamaHarnessSetupStep[];
};

export type LlamaHarnessAgent = {
  id: string;
  name: string;
  description: string;
};

export type LlamaHarnessToolSummary = {
  id: string;
  name: string;
  description: string;
  riskLevel: "low" | "medium" | "high" | string;
  enabled: boolean;
};

export type LlamaHarnessAppCapabilities = {
  appId: string;
  appName: string;
  defaultAgent: LlamaHarnessAgent;
  allowedAgents: LlamaHarnessAgent[];
  tools: LlamaHarnessToolSummary[];
  model: {
    id: string;
    name: string;
    provider: string;
    modelName: string;
    status: string;
  };
  warnings?: string[];
};

export type LlamaHarnessRunToolRequest = {
  id: string;
  toolId: string;
  name: string;
  arguments: unknown;
  riskLevel: "low" | "medium" | "high" | string;
  displayName: string;
};

export type LlamaHarnessRunToolResult = {
  toolCallId: string;
  toolId?: string;
  result?: unknown;
  error?: string;
};

export type LlamaHarnessRunResponse = {
  runId: string;
  status: "completed" | "requires_action" | "failed";
  appId: string;
  agentId: string;
  modelId: string;
  output?: string;
  toolRequests: LlamaHarnessRunToolRequest[];
  durationMs: number;
  usage?: TokenUsage | null;
};

export async function getLlamaHarnessSetupStatus() {
  return request<LlamaHarnessSetupStatus>("/api/setup/status", undefined, LLAMA_HARNESS_METADATA_TIMEOUT_MS);
}

export async function getLlamaHarnessNoteCapabilities() {
  return request<LlamaHarnessAppCapabilities>(
    `/api/apps/${encodeURIComponent(NOTE_APP_ID)}/capabilities`,
    undefined,
    LLAMA_HARNESS_METADATA_TIMEOUT_MS,
  );
}

export async function createLlamaHarnessNoteRun({
  agentId,
  expectedModelId,
  messages,
  notesContext,
  signal,
  toolManifest,
}: {
  agentId: string;
  expectedModelId: string;
  messages: AssistantMessage[];
  notesContext: NotesContextSnapshot;
  signal?: AbortSignal;
  toolManifest: AssistantToolManifest;
}): Promise<LlamaHarnessRunResponse> {
  let response: unknown;
  try {
    response = await request<unknown>("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        agentId,
        appId: NOTE_APP_ID,
        context: notesContext,
        messages: messages.map(toChatMessage),
        toolManifest,
      }),
      signal,
    }, LLAMA_HARNESS_RUN_TIMEOUT_MS);
  } catch (error) {
    if (isAbortError(error) || error instanceof LlamaHarnessSafetyError) throw error;
    const message = error instanceof Error ? error.message : "Unknown harness error.";
    throw new Error(`llama-harness rejected the bounded Note tool manifest or run request. No assistant tools were executed. ${message}`);
  }

  return normalizeRunResponse(response, { agentId, modelId: expectedModelId });
}

export async function submitLlamaHarnessNoteToolResults({
  agentId,
  expectedModelId,
  runId,
  toolResults,
  signal,
}: {
  agentId: string;
  expectedModelId: string;
  runId: string;
  toolResults: LlamaHarnessRunToolResult[];
  signal?: AbortSignal;
}): Promise<LlamaHarnessRunResponse> {
  const response = await request<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/tool-results`,
    {
      method: "POST",
      body: JSON.stringify({
        appId: NOTE_APP_ID,
        toolResults,
      }),
      signal,
    },
    LLAMA_HARNESS_RUN_TIMEOUT_MS,
  );

  return normalizeRunResponse(response, { agentId, modelId: expectedModelId, runId });
}

function toChatMessage({ content, role }: AssistantMessage): ChatMessage {
  return { content, role };
}

function normalizeRunResponse(response: unknown, expected: { agentId?: string; modelId?: string; runId?: string }): LlamaHarnessRunResponse {
  const value = exactObject(response, ["runId", "status", "appId", "agentId", "modelId", "output", "toolRequests", "durationMs", "usage"], "run response");
  const status = value.status;
  if (status !== "completed" && status !== "requires_action" && status !== "failed") invalidRunResponse("run response status is missing or unsupported.");
  const runId = boundedString(value.runId, "runId", 200);
  const agentId = boundedString(value.agentId, "agentId", 200);
  const modelId = boundedString(value.modelId, "modelId", 200);
  if (value.appId !== NOTE_APP_ID) invalidRunResponse("run response appId does not match Note.");
  if (expected.runId !== undefined && runId !== expected.runId) invalidRunResponse("run response changed its runId during continuation.");
  if (expected.agentId !== undefined && agentId !== expected.agentId) invalidRunResponse("run response agentId does not match the consented agent.");
  if (expected.modelId !== undefined && modelId !== expected.modelId) invalidRunResponse("run response modelId does not match the reviewed model.");
  const requests = value.toolRequests;
  if (!Array.isArray(requests) || requests.length > MAX_TOOL_CALLS_PER_ROUND) invalidRunResponse("run response toolRequests is missing or exceeds the per-round limit.");
  const toolRequests = requests.map(validateToolRequest);
  if (new Set(toolRequests.map((request) => request.id)).size !== toolRequests.length) invalidRunResponse("run response tool request IDs must be unique.");
  if ((status === "requires_action") !== (toolRequests.length > 0)) invalidRunResponse("run response status and toolRequests do not agree.");
  const output = value.output === undefined ? undefined : boundedOutput(value.output);
  const durationMs = boundedInteger(value.durationMs, "durationMs");
  const usage = value.usage === undefined || value.usage === null ? value.usage : validateUsage(value.usage);
  return {
    runId,
    status,
    appId: NOTE_APP_ID,
    agentId,
    modelId,
    ...(output === undefined ? {} : { output }),
    toolRequests,
    durationMs,
    ...(usage === undefined ? {} : { usage }),
  };
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const object = objectRecord(value, label);
  if (Object.keys(object).some((key) => !keys.includes(key))) invalidRunResponse(`${label} contains an unsupported field.`);
  return object;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRunResponse(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalidRunResponse(`${field} must be bounded text.`);
  return value;
}

function boundedInteger(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidRunResponse(`${field} must be a non-negative safe integer.`);
  return value;
}

function boundedOutput(value: unknown) {
  if (typeof value !== "string" || value.length > LLAMA_HARNESS_MAX_RESPONSE_BYTES) invalidRunResponse("output must be bounded text.");
  return value;
}

function validateToolRequest(value: unknown): LlamaHarnessRunToolRequest {
  const request = exactObject(value, ["id", "toolId", "name", "arguments", "riskLevel", "displayName"], "tool request");
  const riskLevel = request.riskLevel;
  if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high") invalidRunResponse("tool request riskLevel is unsupported.");
  const args = objectRecord(request.arguments, "tool request arguments");
  const serializedArguments = JSON.stringify(args);
  if (new TextEncoder().encode(serializedArguments).byteLength > 128 * 1024) invalidRunResponse("tool request arguments exceed the 128 KiB limit.");
  return {
    id: boundedString(request.id, "tool request id", 200),
    toolId: boundedString(request.toolId, "tool request toolId", 200),
    name: boundedString(request.name, "tool request name", 200),
    arguments: args,
    riskLevel,
    displayName: boundedString(request.displayName, "tool request displayName", 500),
  };
}

function validateUsage(value: unknown): TokenUsage {
  const usage = exactObject(value, ["input_tokens", "output_tokens", "total_tokens"], "run response usage");
  return Object.fromEntries(Object.entries(usage).map(([key, count]) => [key, boundedInteger(count, `usage.${key}`)]));
}

function invalidRunResponse(message: string): never {
  throw new LlamaHarnessSafetyError("invalid_response", `llama-harness returned an invalid run envelope: ${message}`);
}

async function request<T>(path: string, init: RequestInit | undefined, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  let timedOut = false;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`${LLAMA_HARNESS_BASE_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const body = await readBoundedJson(response);
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return body as T;
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? new DOMException("The request was aborted.", "AbortError");
    if (timedOut) throw new LlamaHarnessSafetyError("request_timeout", `llama-harness request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    window.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > LLAMA_HARNESS_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new LlamaHarnessSafetyError("response_too_large", "llama-harness response exceeded the 1 MiB safety limit.");
  }
  if (!response.body) throw new LlamaHarnessSafetyError("invalid_response", "llama-harness returned an empty response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > LLAMA_HARNESS_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LlamaHarnessSafetyError("response_too_large", "llama-harness response exceeded the 1 MiB safety limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new LlamaHarnessSafetyError("invalid_response", "llama-harness returned invalid JSON.");
  }
}

function isAbortError(error: unknown) { return error instanceof Error && error.name === "AbortError"; }
