import type {
  AssistantMessage,
  ChatMessage,
  NotesContextSnapshot,
} from "../aiTypes";

const LLAMA_HARNESS_BASE_URL = "http://127.0.0.1:8787";
const NOTE_APP_ID = "note";

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

type RunWireResponse = Omit<LlamaHarnessRunResponse, "toolRequests"> & {
  toolRequests?: LlamaHarnessRunToolRequest[];
};

export async function getLlamaHarnessSetupStatus() {
  return request<LlamaHarnessSetupStatus>("/api/setup/status");
}

export async function getLlamaHarnessNoteCapabilities() {
  return request<LlamaHarnessAppCapabilities>(
    `/api/apps/${encodeURIComponent(NOTE_APP_ID)}/capabilities`,
  );
}

export async function createLlamaHarnessNoteRun({
  agentId,
  messages,
  notesContext,
}: {
  agentId: string;
  messages: AssistantMessage[];
  notesContext: NotesContextSnapshot;
}): Promise<LlamaHarnessRunResponse> {
  const response = await request<RunWireResponse>("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      agentId,
      appId: NOTE_APP_ID,
      context: notesContext,
      messages: messages.map(toChatMessage),
    }),
  });

  return normalizeRunResponse(response);
}

export async function submitLlamaHarnessNoteToolResults({
  runId,
  toolResults,
}: {
  runId: string;
  toolResults: LlamaHarnessRunToolResult[];
}): Promise<LlamaHarnessRunResponse> {
  const response = await request<RunWireResponse>(
    `/api/runs/${encodeURIComponent(runId)}/tool-results`,
    {
      method: "POST",
      body: JSON.stringify({
        appId: NOTE_APP_ID,
        toolResults,
      }),
    },
  );

  return normalizeRunResponse(response);
}

function toChatMessage({ content, role }: AssistantMessage): ChatMessage {
  return { content, role };
}

function normalizeRunResponse(response: RunWireResponse): LlamaHarnessRunResponse {
  return {
    ...response,
    toolRequests: response.toolRequests ?? [],
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LLAMA_HARNESS_BASE_URL}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      typeof body.error === "string"
        ? body.error
        : `${response.status} ${response.statusText}`;

    throw new Error(message);
  }

  return response.json() as Promise<T>;
}
