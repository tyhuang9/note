import type {
  AIModel,
  AIProvider,
  AssistantMessage,
  ChatMessage,
  ChatResponse,
  NotesContextSnapshot,
} from "../aiTypes";
import { sendAIProviderChat } from "./aiProviderAdapters";

export type AssistantChatRequest = {
  messages: AssistantMessage[];
  model: AIModel;
  notesContext?: NotesContextSnapshot;
  provider: AIProvider;
};

export async function sendAssistantChat({
  messages,
  model,
  notesContext,
  provider,
}: AssistantChatRequest): Promise<ChatResponse> {
  return sendAIProviderChat(provider, model, buildChatMessages(messages, notesContext));
}

function buildChatMessages(
  messages: AssistantMessage[],
  notesContext: NotesContextSnapshot | undefined,
): ChatMessage[] {
  const chatMessages = messages.map(({ content, role }) => ({ content, role }));
  const promptSummary = notesContext?.promptSummary.trim();

  if (!promptSummary) {
    return chatMessages;
  }

  return [
    {
      content: `Current notes context:\n${promptSummary}`,
      role: "system",
    },
    ...chatMessages,
  ];
}
