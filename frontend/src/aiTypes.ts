import type { TextElement } from "./canvas/model/elements";
import type { AppData } from "./types";

export type ProviderType =
  | "ollama"
  | "lm-studio"
  | "openai-compatible"
  | "openai";

export type LlmProviderKind = "ollama" | "openai-compatible";

export type SttProviderKind = "openai-compatible-whisper";

export type LlmProviderConfig = {
  baseUrl: string;
  kind: LlmProviderKind;
  model: string;
  name: string;
};

export type SttProviderConfig = {
  baseUrl: string;
  kind: SttProviderKind;
  model: string;
  name: string;
};

export type AssistantRole = "system" | "user" | "assistant";

export type ChatMessage = {
  content: string;
  role: AssistantRole;
};

export type ChatResponse = {
  content: string;
  modelId: string;
  providerId: string;
};

export type ChatChunk = {
  content: string;
  done: boolean;
};

export type ConnectionTestResult = {
  latencyMs?: number;
  message: string;
  ok: boolean;
};

export type AssistantMessage = {
  content: string;
  createdAt: string;
  id: string;
  role: AssistantRole;
};

export type LlmChatRequest = {
  config: LlmProviderConfig;
  messages: AssistantMessage[];
  notesContext?: NotesContextSnapshot;
};

export type LlmChatResponse = {
  content: string;
  model?: string;
  provider: LlmProviderKind;
};

export type SttTranscriptionRequest = {
  audio: Blob;
  config: SttProviderConfig;
  fileName: string;
};

export type SttTranscriptionResponse = {
  provider: SttProviderKind;
  text: string;
};

export type NotesContextBlock = Pick<
  TextElement,
  "content" | "height" | "id" | "pageId" | "width" | "x" | "y"
>;

export type NotesContextPage = {
  folderName: string;
  id: string;
  isActive: boolean;
  title: string;
};

export type NotesContextSnapshot = {
  activePage?: NotesContextPage;
  activePageBlocks: NotesContextBlock[];
  appData: Pick<AppData, "folders" | "pages">;
  promptSummary: string;
  selectedBlocks: NotesContextBlock[];
};

export type NotesContextInput = {
  data: AppData;
  selectedBlockIds: string[];
  selectedPageId: string;
};

export type AssistantActionKind =
  | "insert-text-block"
  | "append-to-selected-block"
  | "replace-selected-block";

export type AssistantActionRequest = {
  content: string;
  kind: AssistantActionKind;
};

export type AssistantActionResult = {
  message: string;
  ok: boolean;
};

export type AIProvider = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
};

export type AIModelCapabilities = {
  chat: boolean;
  embeddings: boolean;
  vision: boolean;
  tools: boolean;
  streaming: boolean;
};

export type AIModel = {
  id: string;
  providerId: string;
  name: string;
  capabilities: AIModelCapabilities;
};

export type AIProviderAdapter = {
  testConnection(provider: AIProvider): Promise<ConnectionTestResult>;
  listModels(provider: AIProvider): Promise<AIModel[]>;
  sendChat(
    provider: AIProvider,
    model: AIModel,
    messages: ChatMessage[],
  ): Promise<ChatResponse>;
  streamChat?(
    provider: AIProvider,
    model: AIModel,
    messages: ChatMessage[],
  ): AsyncIterable<ChatChunk>;
};

export type AIProviderSettingsData = {
  defaultChatModelId?: string;
  defaultEmbeddingModelId?: string;
  models: AIModel[];
  providers: AIProvider[];
};
