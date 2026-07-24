import { memo } from "react";
import type { Ref } from "react";
import type {
  AssistantActionKind,
  AssistantMessage,
} from "../../aiTypes";
import { buildAssistantActionRequest } from "../../services/assistantActions";

interface AssistantPanelProps {
  readonly assistantError: string | null;
  readonly assistantStatus: string | null;
  readonly defaultChatModelLabel: string;
  readonly harnessAgents: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>;
  readonly inputValue: string;
  readonly isHarnessLoading: boolean;
  readonly isHarnessReady: boolean;
  readonly isSending: boolean;
  readonly messages: readonly AssistantMessage[];
  readonly onClose: () => void;
  readonly onInputChange: (value: string) => void;
  readonly onRefreshHarness: () => void;
  readonly onRunAction: (kind: AssistantActionKind) => void;
  readonly onSend: () => void;
  readonly onSelectHarnessAgent: (agentId: string) => void;
  readonly panelRef: Ref<HTMLElement>;
  readonly selectedBlockCount: number;
  readonly selectedBlockPreview: string | null;
  readonly selectedHarnessAgentId: string;
  readonly selectedPageTitle: string | null;
}

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

function getLatestAssistantMessage(messages: readonly AssistantMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "assistant" && message.content.trim()) {
      return message;
    }
  }

  return null;
}

export const AssistantPanel = memo(function AssistantPanel({
  assistantError,
  assistantStatus,
  defaultChatModelLabel,
  harnessAgents,
  inputValue,
  isHarnessLoading,
  isHarnessReady,
  isSending,
  messages,
  onClose,
  onInputChange,
  onRefreshHarness,
  onRunAction,
  onSend,
  onSelectHarnessAgent,
  panelRef,
  selectedBlockCount,
  selectedBlockPreview,
  selectedHarnessAgentId,
  selectedPageTitle,
}: Readonly<AssistantPanelProps>) {
  const canSend = inputValue.trim().length > 0 && !isSending && isHarnessReady && Boolean(selectedHarnessAgentId);
  const latestAssistantMessage = getLatestAssistantMessage(messages);
  const assistantOutputEligibility = buildAssistantActionRequest(
    "insert-text-block",
    latestAssistantMessage?.content ?? "",
  );
  const hasSingleSelectedBlock =
    selectedBlockCount === 1 && selectedBlockPreview !== null;
  const actionEligibilityReasonId = "assistant-action-eligibility-reason";
  const selectedBlockLabel = selectedBlockPreview
    ? `Selected block: ${selectedBlockPreview}`
    : selectedBlockCount === 1
      ? "Selected block: Image block (text actions unavailable)"
    : selectedBlockCount > 1
      ? `${selectedBlockCount} blocks selected`
      : "Selected block: None";

  function getActionDisabledReason(kind: AssistantActionKind) {
    if (!assistantOutputEligibility.ok) {
      return assistantOutputEligibility.message;
    }

    if (kind === "insert-text-block") {
      return selectedPageTitle ? null : "Select a page before inserting output.";
    }

    return hasSingleSelectedBlock
      ? null
      : "Select exactly one text block to append or replace output.";
  }

  const visibleEligibilityReason = !assistantOutputEligibility.ok
    ? assistantOutputEligibility.message
    : !selectedPageTitle && !hasSingleSelectedBlock
      ? "Select a page to enable Insert, and select exactly one text block to enable Append and Replace."
      : !selectedPageTitle
        ? "Select a page to enable Insert."
        : !hasSingleSelectedBlock
          ? "Select exactly one text block to enable Append and Replace."
          : null;

  return (
    <aside
      className="assistant-panel"
      aria-label="AI assistant"
      id="workspace-assistant-panel"
      ref={panelRef}
      tabIndex={-1}
    >
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

      <section className="assistant-messages" aria-label="Assistant messages">
        {messages.length === 0 ? (
          <div className="assistant-empty-state">No messages</div>
        ) : (
          messages.map((message) => {
            const isLatestAssistantMessage =
              message.id === latestAssistantMessage?.id;

            return (
              <article
                className={`assistant-message assistant-message-${message.role}`}
                key={message.id}
              >
                <div className="assistant-message-role">{message.role}</div>
                <p>{message.content}</p>
                {isLatestAssistantMessage ? (
                  <>
                    <div className="assistant-target-context">
                      <strong>
                        Current page: {selectedPageTitle ?? "None selected"}
                      </strong>
                      <span>{selectedBlockLabel}</span>
                    </div>
                    <section
                      className="assistant-output-actions"
                      aria-label="Assistant output actions"
                    >
                      {assistantActions.map((action) => {
                        const disabledReason = getActionDisabledReason(action.kind);

                        return (
                          <button
                            aria-describedby={
                              disabledReason
                                ? actionEligibilityReasonId
                                : undefined
                            }
                            disabled={Boolean(disabledReason)}
                            key={action.kind}
                            onClick={() => onRunAction(action.kind)}
                            title={disabledReason ?? action.label}
                            type="button"
                          >
                            {action.label}
                          </button>
                        );
                      })}
                      {visibleEligibilityReason ? (
                        <p
                          className="assistant-action-reason"
                          id={actionEligibilityReasonId}
                        >
                          {visibleEligibilityReason}
                        </p>
                      ) : null}
                    </section>
                  </>
                ) : null}
              </article>
            );
          })
        )}
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
          <span className="assistant-voice-unavailable" id="native-voice-status">
            Native voice input is not yet available.
          </span>
          <button
            aria-describedby="native-voice-status"
            aria-label="Native voice input unavailable"
            className="assistant-dictation-button"
            disabled
            title="Native voice input is not yet available"
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
