import { memo, useEffect, useState } from "react";
import type {
  AssistantActionKind,
  AssistantMessage,
} from "../aiTypes";

type AssistantPanelProps = {
  assistantError: string | null;
  assistantStatus: string | null;
  defaultChatModelLabel: string;
  harnessAgents: Array<{
    default_model: string;
    id: string;
    name: string;
  }>;
  harnessAgentModel: string;
  harnessAgentName: string;
  harnessAgentSystemPrompt: string;
  inputValue: string;
  isHarnessLoading: boolean;
  isHarnessReady: boolean;
  isRecording: boolean;
  isSending: boolean;
  messages: AssistantMessage[];
  onClose: () => void;
  onInputChange: (value: string) => void;
  onRefreshHarness: () => void;
  onRunAction: (kind: AssistantActionKind) => void;
  onSaveHarnessAgent: (patch: {
    default_model?: string;
    name?: string;
    system_prompt?: string;
  }) => void;
  onSend: () => void;
  onSelectHarnessAgent: (agentId: string) => void;
  onToggleRecording: () => void;
  selectedHarnessAgentId: string;
};

type AssistantIconName =
  | "chevron-right"
  | "microphone"
  | "paper-airplane"
  | "sparkles"
  | "x-mark";

const assistantActions: Array<{ kind: AssistantActionKind; label: string }> = [
  { kind: "insert-text-block", label: "Insert" },
  { kind: "append-to-selected-block", label: "Append" },
  { kind: "replace-selected-block", label: "Replace" },
];

function AssistantIcon({ name }: { name: AssistantIconName }) {
  return (
    <svg
      aria-hidden="true"
      className="assistant-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {name === "chevron-right" ? <path d="m9 6 6 6-6 6" /> : null}
      {name === "microphone" ? (
        <>
          <path d="M12 14.25a3 3 0 0 0 3-3v-4.5a3 3 0 1 0-6 0v4.5a3 3 0 0 0 3 3Z" />
          <path d="M18.75 11.25a6.75 6.75 0 0 1-13.5 0M12 18v3M9 21h6" />
        </>
      ) : null}
      {name === "paper-airplane" ? (
        <>
          <path d="m3.75 11.25 15.9-7.05a.5.5 0 0 1 .68.59l-4.54 15.9a.5.5 0 0 1-.9.15l-3.43-5.15-5.15-3.43a.5.5 0 0 1 .15-.9Z" />
          <path d="m11.46 15.69 3.6-3.6" />
        </>
      ) : null}
      {name === "sparkles" ? (
        <>
          <path d="m12 3 1.38 4.12L17.5 8.5l-4.12 1.38L12 14l-1.38-4.12L6.5 8.5l4.12-1.38L12 3Z" />
          <path d="m18.5 13 .78 2.22L21.5 16l-2.22.78L18.5 19l-.78-2.22L15.5 16l2.22-.78L18.5 13ZM5.5 14l.58 1.42L7.5 16l-1.42.58L5.5 18l-.58-1.42L3.5 16l1.42-.58L5.5 14Z" />
        </>
      ) : null}
      {name === "x-mark" ? <path d="M6 6l12 12M18 6 6 18" /> : null}
    </svg>
  );
}

function getLatestAssistantOutput(messages: AssistantMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "assistant" && message.content.trim()) {
      return message.content;
    }
  }

  return "";
}

export const AssistantPanel = memo(function AssistantPanel({
  assistantError,
  assistantStatus,
  defaultChatModelLabel,
  harnessAgents,
  harnessAgentModel,
  harnessAgentName,
  harnessAgentSystemPrompt,
  inputValue,
  isHarnessLoading,
  isHarnessReady,
  isRecording,
  isSending,
  messages,
  onClose,
  onInputChange,
  onRefreshHarness,
  onRunAction,
  onSaveHarnessAgent,
  onSend,
  onSelectHarnessAgent,
  onToggleRecording,
  selectedHarnessAgentId,
}: AssistantPanelProps) {
  const [draftAgentModel, setDraftAgentModel] = useState(harnessAgentModel);
  const [draftAgentName, setDraftAgentName] = useState(harnessAgentName);
  const [draftSystemPrompt, setDraftSystemPrompt] = useState(harnessAgentSystemPrompt);
  const canSend = inputValue.trim().length > 0 && !isSending && isHarnessReady && Boolean(selectedHarnessAgentId);
  const latestAssistantOutput = getLatestAssistantOutput(messages);
  const canRunOutputAction = Boolean(latestAssistantOutput);

  useEffect(() => {
    setDraftAgentModel(harnessAgentModel);
    setDraftAgentName(harnessAgentName);
    setDraftSystemPrompt(harnessAgentSystemPrompt);
  }, [harnessAgentModel, harnessAgentName, harnessAgentSystemPrompt]);

  function saveAgentField(field: "default_model" | "name" | "system_prompt", value: string) {
    const trimmedValue = value.trim();
    if (field === "default_model" && trimmedValue !== harnessAgentModel) {
      onSaveHarnessAgent({ default_model: trimmedValue });
    }
    if (field === "name" && trimmedValue !== harnessAgentName) {
      onSaveHarnessAgent({ name: trimmedValue });
    }
    if (field === "system_prompt" && trimmedValue !== harnessAgentSystemPrompt) {
      onSaveHarnessAgent({ system_prompt: trimmedValue });
    }
  }

  return (
    <aside className="assistant-panel" aria-label="AI assistant">
      <header className="assistant-panel-header">
        <div className="assistant-panel-title">
          <AssistantIcon name="sparkles" />
          <h2>Assistant</h2>
        </div>
        <button
          aria-label="Close assistant"
          className="assistant-close-button"
          onClick={onClose}
          title="Close assistant"
          type="button"
        >
          <AssistantIcon name="x-mark" />
        </button>
      </header>

      <section className="assistant-provider-summary" aria-label="Default AI model">
        <div>
          <span>llama-harness agent</span>
          <strong>{defaultChatModelLabel}</strong>
        </div>
        {isHarnessReady && harnessAgents.length > 0 ? (
          <select
            aria-label="Assistant agent"
            onChange={(event) => onSelectHarnessAgent(event.currentTarget.value)}
            value={selectedHarnessAgentId}
          >
            {harnessAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name || agent.id}
              </option>
            ))}
          </select>
        ) : null}
        <button onClick={onRefreshHarness} type="button">
          {isHarnessLoading ? "Checking..." : "Refresh"}
        </button>
      </section>

      {isHarnessReady && selectedHarnessAgentId ? (
        <section className="assistant-agent-editor" aria-label="Selected agent details">
          <input
            aria-label="Agent name"
            onBlur={() => saveAgentField("name", draftAgentName)}
            onChange={(event) => setDraftAgentName(event.currentTarget.value)}
            placeholder="Agent name"
            value={draftAgentName}
          />
          <input
            aria-label="Agent default model"
            onBlur={() => saveAgentField("default_model", draftAgentModel)}
            onChange={(event) => setDraftAgentModel(event.currentTarget.value)}
            placeholder="Default model"
            value={draftAgentModel}
          />
          <textarea
            aria-label="Agent system prompt"
            onBlur={() => saveAgentField("system_prompt", draftSystemPrompt)}
            onChange={(event) => setDraftSystemPrompt(event.currentTarget.value)}
            placeholder="System prompt"
            rows={3}
            value={draftSystemPrompt}
          />
        </section>
      ) : null}

      <section className="assistant-messages" aria-label="Assistant messages">
        {messages.length === 0 ? (
          <div className="assistant-empty-state">No messages</div>
        ) : (
          messages.map((message) => (
            <article
              className={`assistant-message assistant-message-${message.role}`}
              key={message.id}
            >
              <div className="assistant-message-role">{message.role}</div>
              <p>{message.content}</p>
            </article>
          ))
        )}
      </section>

      <section className="assistant-output-actions" aria-label="Assistant output actions">
        {assistantActions.map((action) => (
          <button
            disabled={!canRunOutputAction}
            key={action.kind}
            onClick={() => onRunAction(action.kind)}
            type="button"
          >
            {action.label}
          </button>
        ))}
      </section>

      {assistantStatus ? (
        <div className="assistant-status" role="status">
          {assistantStatus}
        </div>
      ) : null}
      {assistantError ? (
        <div className="assistant-error" role="alert">
          {assistantError}
        </div>
      ) : null}

      <form
        className="assistant-composer"
        onSubmit={(event) => {
          event.preventDefault();

          if (canSend) {
            onSend();
          }
        }}
      >
        <textarea
          aria-label="Assistant prompt"
          onChange={(event) => onInputChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();

              if (canSend) {
                onSend();
              }
            }
          }}
          placeholder="Ask about this note"
          rows={4}
          value={inputValue}
        />
        <div className="assistant-composer-actions">
          <button
            aria-label={isRecording ? "Stop dictation" : "Start dictation"}
            aria-pressed={isRecording}
            className="assistant-dictation-button"
            onClick={onToggleRecording}
            title={isRecording ? "Stop dictation" : "Start dictation"}
            type="button"
          >
            <AssistantIcon name="microphone" />
          </button>
          <button
            aria-label="Send prompt"
            className="assistant-send-button"
            disabled={!canSend}
            title="Send prompt"
            type="submit"
          >
            <AssistantIcon name="paper-airplane" />
            <AssistantIcon name="chevron-right" />
          </button>
        </div>
      </form>
    </aside>
  );
});
