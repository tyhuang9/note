import type {
  AssistantMessage,
  ChatMessage,
  NotesContextSnapshot,
} from "../aiTypes";

const LLAMA_HARNESS_BASE_URL = "http://127.0.0.1:8787";

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
  role: string;
  description: string;
  system_prompt: string;
  default_provider_id: string;
  default_model: string;
  default_environment: string;
  autonomy: string;
  permissions: {
    browser: boolean;
    file_read: boolean;
    file_write: boolean;
    terminal: boolean;
  };
  status: "active" | "paused" | "draft";
  tasks_run: number;
  updated_at: string;
};

export type LlamaHarnessAgentPatch = Partial<
  Pick<
    LlamaHarnessAgent,
    "name" | "description" | "system_prompt" | "default_provider_id" | "default_model" | "status"
  >
>;

export type LlamaHarnessToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
};

export type LlamaHarnessAgentChatResponse = {
  content: string;
  modelId: string;
  providerId: string;
  toolCalls: LlamaHarnessToolCall[];
  usage?: TokenUsage | null;
};

type AgentChatWireResponse = {
  provider: string;
  model: string;
  message: ChatMessage;
  tool_calls?: LlamaHarnessToolCall[] | null;
  usage?: TokenUsage | null;
};

export async function getLlamaHarnessSetupStatus() {
  return request<LlamaHarnessSetupStatus>("/api/setup/status");
}

export async function listLlamaHarnessAgents() {
  return request<LlamaHarnessAgent[]>("/api/agents");
}

export async function patchLlamaHarnessAgent(
  agentId: string,
  patch: LlamaHarnessAgentPatch,
) {
  return request<LlamaHarnessAgent>(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function sendLlamaHarnessAgentChat({
  agentId,
  messages,
  notesContext,
}: {
  agentId: string;
  messages: AssistantMessage[];
  notesContext: NotesContextSnapshot;
}): Promise<LlamaHarnessAgentChatResponse> {
  const response = await request<AgentChatWireResponse>(
    `/api/agents/${encodeURIComponent(agentId)}/chat`,
    {
      method: "POST",
      body: JSON.stringify({
        app_context: notesContext,
        messages: messages.map(({ content, role }) => ({ content, role })),
        source_app: "note",
      }),
    },
  );

  return {
    content: response.message.content.toString(),
    modelId: response.model,
    providerId: response.provider,
    toolCalls: response.tool_calls ?? [],
    usage: response.usage,
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
