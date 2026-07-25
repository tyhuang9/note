import { memo, useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import type {
  AssistantActionKind,
  AssistantMessage,
} from "../../aiTypes";
import { buildAssistantActionRequest } from "../../services/assistantActions";
import type { AssistantProviderMetadata, AssistantReview } from "./AssistantRuntime";
import type { EventDraft } from "../../native/calendarClient";

interface AssistantPanelProps {
  readonly assistantError: string | null;
  readonly assistantStatus: string | null;
  readonly defaultChatModelLabel: string;
  readonly providerMetadata: AssistantProviderMetadata;
  readonly calendarReconciliation:
    | { state: "loading" }
    | { state: "clear" }
    | { state: "required"; agendaInspected: boolean; busy: boolean; error?: string }
    | { state: "unknown"; agendaInspected: boolean; busy: boolean; canRetryStatus: boolean; error: string };
  readonly calendarReconciliationFocus: { request: number; target: "acknowledge" | "openAgenda" | "retry" | null };
  readonly consent: { agentId: string; agentLabel: string; categories: readonly string[]; modelId: string; modelLabel: string; prompt: string; provider: AssistantProviderMetadata } | null;
  readonly focusRequest: number;
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
  readonly onCancelReview: () => void;
  readonly onCancelConsent: () => void;
  readonly onCancelRun: () => void;
  readonly onConfirmReview: () => void;
  readonly onConfirmConsent: () => void;
  readonly onDismissExpiredReview: () => void;
  readonly onEditCalendarReview: (input: { event: EventDraft; inferredFields?: string[] }) => Promise<void>;
  readonly onEditNoteReview: (patch: Record<string, string | number>) => Promise<void>;
  readonly onInputChange: (value: string) => void;
  readonly onAcknowledgeCalendarUnresolved: () => void;
  readonly onOpenAgenda: () => void;
  readonly onRefreshHarness: () => void;
  readonly onRetryCalendarReconciliation: () => void;
  readonly onRunAction: (kind: AssistantActionKind) => void;
  readonly onSend: () => void;
  readonly onSelectHarnessAgent: (agentId: string) => void;
  readonly panelRef: Ref<HTMLElement>;
  readonly review: AssistantReview | null;
  readonly isReviewBusy: boolean;
  readonly reviewOperationStatus: string | null;
  readonly selectedBlockCount: number;
  readonly selectedBlockPreview: string | null;
  readonly selectedHarnessAgentId: string;
  readonly selectedPageTitle: string | null;
}

function ConsentCard({ consent, isBusy, onCancel, onConfirm }: { consent: NonNullable<AssistantPanelProps["consent"]>; isBusy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const disabledExplanationId = "assistant-consent-disabled-explanation";
  useEffect(() => { confirmRef.current?.focus(); }, [consent.agentId, consent.modelId, consent.prompt, consent.provider.provider]);
  return <section aria-busy={isBusy} aria-label="Assistant data sharing review" className="assistant-review-card">
    <h3>Review data sharing</h3>
    <p>This request goes through <strong>local llama-harness</strong>. Its reported upstream routing label is <strong>{consent.provider.provider}</strong>, using reported model <strong>{consent.modelLabel}</strong> (<strong>{consent.modelId}</strong>). Note cannot independently verify the upstream provider identity or routing. Processing location is <strong>{consent.provider.dataSharing}</strong>, so Note cannot confirm this stays on this device.</p>
    <dl className="assistant-review-details">
      <div><dt>Agent</dt><dd>{consent.agentLabel} ({consent.agentId})</dd></div>
      <div><dt>Exact prompt</dt><dd>{consent.prompt}</dd></div>
    </dl>
    <p>Sending will share only:</p>
    <ul className="assistant-consent-list">{consent.categories.map((category) => <li key={category}>{category}</li>)}</ul>
    <p className="assistant-review-operation" id={disabledExplanationId} aria-live="polite">{isBusy ? "Building bounded context and sending…" : "Nothing has been sent yet."}</p>
    <div className="assistant-review-actions">
      <button aria-describedby={isBusy ? disabledExplanationId : undefined} disabled={isBusy} onClick={onConfirm} ref={confirmRef} type="button">Send with this context</button>
      <button aria-describedby={isBusy ? disabledExplanationId : undefined} disabled={isBusy} onClick={onCancel} type="button">Keep private</button>
    </div>
  </section>;
}

function CalendarReconciliationCard({ focusIntent, reconciliation, onAcknowledge, onOpenAgenda, onRetry }: {
  focusIntent: AssistantPanelProps["calendarReconciliationFocus"];
  reconciliation: Exclude<AssistantPanelProps["calendarReconciliation"], { state: "clear" }>;
  onAcknowledge: () => void;
  onOpenAgenda: () => void;
  onRetry: () => void;
}) {
  const acknowledgeRef = useRef<HTMLButtonElement | null>(null);
  const openAgendaRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const handledFocusRequestRef = useRef(focusIntent.request);
  const agendaInspected = reconciliation.state === "loading" ? false : reconciliation.agendaInspected;
  const canAcknowledge = reconciliation.state !== "loading" && agendaInspected && (reconciliation.state === "required" || reconciliation.canRetryStatus);
  useEffect(() => {
    if (reconciliation.state === "loading") return;
    const hasExplicitIntent = focusIntent.request !== handledFocusRequestRef.current;
    handledFocusRequestRef.current = focusIntent.request;
    const target = hasExplicitIntent ? focusIntent.target : canAcknowledge ? "acknowledge" : "openAgenda";
    if (target === "acknowledge" && canAcknowledge) acknowledgeRef.current?.focus();
    else if (target === "retry" && reconciliation.state === "unknown" && reconciliation.canRetryStatus) retryRef.current?.focus();
    else openAgendaRef.current?.focus();
  }, [agendaInspected, canAcknowledge, focusIntent.request, focusIntent.target, reconciliation.state]);
  if (reconciliation.state === "loading") {
    return <section aria-label="Calendar creation status" className="assistant-review-card" role="status">
      <h3>Checking calendar creation status</h3>
      <p className="assistant-review-operation">Calendar creation stays locked until the native status check completes.</p>
    </section>;
  }
  const explanationId = "assistant-calendar-unresolved-explanation";
  return <section aria-label="Unresolved calendar confirmation" className="assistant-review-card" role="alert">
    <h3>Calendar confirmation unresolved</h3>
    <p className="assistant-review-expired">The event may already exist. Do not attempt another calendar create until you inspect Agenda or your calendar.</p>
    <p className="assistant-review-operation" id={explanationId}>{reconciliation.error ?? (reconciliation.agendaInspected ? "Agenda was opened after this warning began. Acknowledge only after checking for the event." : "Acknowledgement stays disabled until you open Agenda in this session.")}</p>
    <div className="assistant-review-actions">
      <button disabled={reconciliation.busy} onClick={onOpenAgenda} ref={openAgendaRef} type="button">Open Agenda</button>
      <button aria-describedby={!canAcknowledge || reconciliation.busy ? explanationId : undefined} disabled={!canAcknowledge || reconciliation.busy} onClick={onAcknowledge} ref={acknowledgeRef} type="button">{reconciliation.busy ? "Clearing…" : "I checked; unlock creates"}</button>
      {reconciliation.state === "unknown" && reconciliation.canRetryStatus ? <button aria-describedby={explanationId} disabled={reconciliation.busy} onClick={onRetry} ref={retryRef} type="button">Retry status</button> : null}
    </div>
  </section>;
}

function CalendarReviewCard({ review, isBusy, operationStatus, onCancel, onConfirm, onDismissExpired, onEdit }: { review: Extract<AssistantReview, { kind: "calendar" }>; isBusy: boolean; operationStatus: string | null; onCancel: () => void; onConfirm: () => void; onDismissExpired: () => void; onEdit: (input: { event: EventDraft }) => Promise<void> }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [title, setTitle] = useState(review.review.title);
  const [location, setLocation] = useState(review.review.location ?? "");
  const [notes, setNotes] = useState(review.review.notes ?? "");
  const [start, setStart] = useState(review.review.time.temporalKind === "timed" ? review.review.time.localStart : review.review.time.startDate);
  const [end, setEnd] = useState(review.review.time.temporalKind === "timed" ? review.review.time.localEnd : review.review.time.endDateExclusive);
  const [timeZone, setTimeZone] = useState(review.review.time.temporalKind === "timed" ? review.review.time.timeZone : "");
  useEffect(() => { if (!editing) confirmRef.current?.focus(); }, [editing, review.expiresAtUtcMs]);
  useEffect(() => {
    setTitle(review.review.title);
    setLocation(review.review.location ?? "");
    setNotes(review.review.notes ?? "");
    setStart(review.review.time.temporalKind === "timed" ? review.review.time.localStart : review.review.time.startDate);
    setEnd(review.review.time.temporalKind === "timed" ? review.review.time.localEnd : review.review.time.endDateExclusive);
    setTimeZone(review.review.time.temporalKind === "timed" ? review.review.time.timeZone : "");
  }, [review.review]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remainingSeconds = Math.max(0, Math.ceil((review.expiresAtUtcMs - now) / 1000));
  const outcomePending = Boolean(review.confirmationOutcomePending);
  const expired = remainingSeconds === 0 && !outcomePending;
  const dismiss = () => { if (!isBusy && !outcomePending) (expired ? onDismissExpired() : onCancel()); };
  const submitEdit = async () => {
    const time = review.review.time.temporalKind === "timed"
      ? { temporalKind: "timed" as const, localStart: start, localEnd: end, timeZone }
      : { temporalKind: "allDay" as const, startDate: start, endDateExclusive: end };
    setIsSavingEdit(true);
    try {
      await onEdit({ event: { title, location: location || null, notes: notes || null, time, recurrenceRule: review.review.recurrenceRule, reminderOffsetsMinutes: review.review.reminderOffsetsMinutes } });
      setEditing(false);
    } finally {
      setIsSavingEdit(false);
    }
  };
  const fieldSources = Object.entries(review.review.fieldSources).map(([field, source]) => `${field}: ${source}`).join("; ");
  const disabledExplanationId = "calendar-review-disabled-explanation";
  return <section aria-busy={isBusy} aria-label="Calendar event review" className="assistant-review-card" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); } }}>
    <h3>{review.action}</h3><p><strong>{review.review.title}</strong></p>
    <p className="assistant-review-warning">Review this event before it changes your calendar.</p>
    {editing ? <div className="assistant-review-form">
      <label>Title <input disabled={isBusy || isSavingEdit || expired || outcomePending} value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <label>Start <input disabled={isBusy || isSavingEdit || expired || outcomePending} value={start} onChange={(event) => setStart(event.currentTarget.value)} /></label>
      <label>End <input disabled={isBusy || isSavingEdit || expired || outcomePending} value={end} onChange={(event) => setEnd(event.currentTarget.value)} /></label>
      {review.review.time.temporalKind === "timed" ? <label>Time zone <input disabled={isBusy || isSavingEdit || expired || outcomePending} value={timeZone} onChange={(event) => setTimeZone(event.currentTarget.value)} /></label> : null}
      <label>Location <input disabled={isBusy || isSavingEdit || expired || outcomePending} value={location} onChange={(event) => setLocation(event.currentTarget.value)} /></label>
      <label>Notes <textarea disabled={isBusy || isSavingEdit || expired || outcomePending} value={notes} onChange={(event) => setNotes(event.currentTarget.value)} /></label>
      <button aria-describedby={isBusy || isSavingEdit || expired || outcomePending ? disabledExplanationId : undefined} disabled={isBusy || isSavingEdit || expired || outcomePending} onClick={submitEdit} type="button">{isSavingEdit ? "Updating…" : "Save details for review"}</button>
    </div> : <dl className="assistant-review-details">
      <div><dt>When</dt><dd>{review.review.time.temporalKind === "timed" ? `${review.review.time.localStart} to ${review.review.time.localEnd} (${review.review.time.timeZone})` : `${review.review.time.startDate} to ${review.review.time.endDateExclusive} (all day)`}</dd></div>
      <div><dt>Duration</dt><dd>{review.review.time.temporalKind === "timed" ? `${review.review.time.durationMinutes} minutes` : `${review.review.time.dayCount} days, all day`}</dd></div>
      <div><dt>Recurrence</dt><dd>{review.review.recurrenceRule ?? "Does not repeat"}</dd></div>
      <div><dt>Reminders</dt><dd>{review.review.reminderOffsetsMinutes.length ? `${review.review.reminderOffsetsMinutes.join(", ")} minutes before` : "None"}</dd></div>
      <div><dt>Location</dt><dd>{review.review.location ?? "None"}</dd></div>
      <div><dt>Notes</dt><dd>{review.review.notes ?? "None"}</dd></div>
      <div><dt>Field sources</dt><dd>{fieldSources}</dd></div>
      <div><dt>Provider</dt><dd>{review.provider.provider} / {review.provider.model}; data sharing: {review.provider.dataSharing}</dd></div>
      <div><dt>Expires</dt><dd>{outcomePending ? "Confirmation outcome pending; retry Confirm to reconcile" : expired ? "Expired" : `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")} remaining (${new Date(review.expiresAtUtcMs).toLocaleString()})`}</dd></div>
    </dl>}
    <p className={expired ? "assistant-review-expired" : "assistant-review-operation"} id={disabledExplanationId} aria-live="polite">{operationStatus ?? (expired ? "This review expired. Dismiss it, then ask the assistant to propose the event again." : "No calendar change has been made.")}</p>
    <div className="assistant-review-actions">
      <button aria-describedby={isBusy || expired ? disabledExplanationId : undefined} disabled={isBusy || expired} onClick={onConfirm} ref={confirmRef} type="button">{isBusy ? "Working…" : outcomePending ? "Retry Confirm" : "Confirm"}</button>
      <button aria-describedby={isBusy || expired || outcomePending ? disabledExplanationId : undefined} disabled={isBusy || expired || outcomePending} onClick={() => setEditing(true)} type="button">Edit details</button>
      <button aria-describedby={isBusy || outcomePending ? disabledExplanationId : undefined} disabled={isBusy || outcomePending} onClick={dismiss} type="button">{expired ? "Dismiss expired review" : "Cancel"}</button>
    </div>
  </section>;
}

function NoteReviewCard({ review, isBusy, operationStatus, onCancel, onConfirm, onEdit }: { review: Extract<AssistantReview, { kind: "note" }>; isBusy: boolean; operationStatus: string | null; onCancel: () => void; onConfirm: () => void; onEdit: (patch: Record<string, string | number>) => Promise<void> }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const editableFields = review.fields.filter((field) => field.editable && field.key);
  useEffect(() => { if (!editing) confirmRef.current?.focus(); }, [editing, review]);
  useEffect(() => { setDraft(Object.fromEntries(editableFields.map((field) => [field.key!, field.after ?? ""]))); }, [review]);
  const submit = async () => {
    const patch: Record<string, string | number> = {};
    for (const field of editableFields) {
      const value = draft[field.key!] ?? "";
      if (field.inputType === "number") {
        const number = Number(value);
        if (!Number.isFinite(number)) { setEditError(`${field.label} must be a number.`); return; }
        patch[field.key!] = number;
      } else {
        patch[field.key!] = value;
      }
    }
    setEditError(null);
    await onEdit(patch);
    setEditing(false);
  };
  const disabledExplanationId = "note-review-disabled-explanation";
  return <section aria-busy={isBusy} aria-label="Note change review" className="assistant-review-card" onKeyDown={(event) => { if (event.key === "Escape" && !isBusy) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <h3>{review.action}</h3><p><strong>Target:</strong> {review.target}</p><p className="assistant-review-warning">{review.effect}</p>
    {editing ? <div className="assistant-review-form">{editableFields.map((field) => <label key={field.key}>{field.label}{field.key === "content" ? <textarea disabled={isBusy} value={draft[field.key] ?? ""} onChange={(event) => { const key = field.key!; const value = event.currentTarget.value; setDraft((current) => ({ ...current, [key]: value })); }} /> : <input disabled={isBusy} type={field.inputType === "number" ? "number" : "text"} value={draft[field.key!] ?? ""} onChange={(event) => { const key = field.key!; const value = event.currentTarget.value; setDraft((current) => ({ ...current, [key]: value })); }} />}</label>)}{editError ? <p role="alert">{editError}</p> : null}<button aria-describedby={isBusy ? disabledExplanationId : undefined} disabled={isBusy} onClick={submit} type="button">Save changes for review</button></div> : <dl className="assistant-review-details">{review.fields.map((field) => <div key={`${field.label}-${field.key ?? "fixed"}`}><dt>{field.label}</dt><dd>{field.before !== undefined ? <><span>Before: {field.before || "Empty"}</span><br /></> : null}{field.after !== undefined ? <span>After: {field.after || "Empty"}</span> : null}</dd></div>)}</dl>}
    <p>Provider: {review.provider.provider} / {review.provider.model}; data sharing: {review.provider.dataSharing}</p>
    {!editableFields.length ? <p>To revise this request, cancel it, update your prompt in the composer, and send again.</p> : null}
    <p className="assistant-review-operation" id={disabledExplanationId} aria-live="polite">{operationStatus ?? "No Note data has been changed."}</p>
    <div className="assistant-review-actions"><button aria-describedby={isBusy ? disabledExplanationId : undefined} disabled={isBusy} onClick={onConfirm} ref={confirmRef} type="button">{isBusy ? "Working…" : "Confirm"}</button>{editableFields.length ? <button aria-describedby={isBusy ? disabledExplanationId : undefined} disabled={isBusy} onClick={() => setEditing(true)} type="button">Edit proposed fields</button> : null}<button aria-describedby={isBusy ? disabledExplanationId : undefined} disabled={isBusy} onClick={onCancel} type="button">Cancel</button></div>
  </section>;
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
  calendarReconciliation,
  calendarReconciliationFocus,
  consent,
  defaultChatModelLabel,
  providerMetadata,
  focusRequest,
  harnessAgents,
  inputValue,
  isHarnessLoading,
  isHarnessReady,
  isSending,
  messages,
  onClose,
  onCancelConsent,
  onCancelReview,
  onCancelRun,
  onConfirmReview,
  onConfirmConsent,
  onDismissExpiredReview,
  onEditCalendarReview,
  onEditNoteReview,
  onInputChange,
  onAcknowledgeCalendarUnresolved,
  onOpenAgenda,
  onRefreshHarness,
  onRetryCalendarReconciliation,
  onRunAction,
  onSend,
  onSelectHarnessAgent,
  panelRef,
  review,
  isReviewBusy,
  reviewOperationStatus,
  selectedBlockCount,
  selectedBlockPreview,
  selectedHarnessAgentId,
  selectedPageTitle,
}: Readonly<AssistantPanelProps>) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelRunRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (focusRequest <= 0) return;
    if (isSending && !review) cancelRunRef.current?.focus();
    else composerRef.current?.focus();
  }, [focusRequest, isSending, review]);
  const consentLocked = Boolean(consent);
  const canSend = inputValue.trim().length > 0 && !isSending && !consent && !review && isHarnessReady && Boolean(selectedHarnessAgentId);
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
    if (consentLocked) {
      return "Resolve the data sharing review before changing Note content.";
    }
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

  const visibleEligibilityReason = consentLocked
    ? "Resolve the data sharing review before changing Note content."
    : !assistantOutputEligibility.ok
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
          <small>{providerMetadata.provider}; model {providerMetadata.model}; processing location {providerMetadata.dataSharing}</small>
        </div>
        {isHarnessReady && harnessAgents.length > 0 ? (
          <select
            aria-label="Assistant agent"
            aria-describedby={consentLocked ? "assistant-consent-controls-locked" : undefined}
            disabled={consentLocked}
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
        <button aria-describedby={consentLocked ? "assistant-consent-controls-locked" : undefined} disabled={consentLocked || isHarnessLoading} onClick={onRefreshHarness} type="button">
          {isHarnessLoading ? "Checking..." : "Refresh"}
        </button>
        {consentLocked ? <small id="assistant-consent-controls-locked">Prompt, agent, and provider context are frozen until you send or keep this request private.</small> : null}
      </section>

      <section className="assistant-messages" aria-label="Assistant messages">
        {calendarReconciliation.state !== "clear" ? <CalendarReconciliationCard focusIntent={calendarReconciliationFocus} reconciliation={calendarReconciliation} onAcknowledge={onAcknowledgeCalendarUnresolved} onOpenAgenda={onOpenAgenda} onRetry={onRetryCalendarReconciliation} /> : null}
        {consent ? <ConsentCard consent={consent} isBusy={isSending} onCancel={onCancelConsent} onConfirm={onConfirmConsent} /> : null}
        {review?.kind === "calendar" ? <CalendarReviewCard isBusy={isReviewBusy} operationStatus={reviewOperationStatus} onCancel={onCancelReview} onConfirm={onConfirmReview} onDismissExpired={onDismissExpiredReview} onEdit={onEditCalendarReview} review={review} /> : null}
        {review?.kind === "note" ? <NoteReviewCard isBusy={isReviewBusy} operationStatus={reviewOperationStatus} onCancel={onCancelReview} onConfirm={onConfirmReview} onEdit={onEditNoteReview} review={review} /> : null}
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
          {assistantStatus}{isSending && !review ? <button className="assistant-cancel-run" onClick={onCancelRun} ref={cancelRunRef} type="button">Cancel</button> : null}
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
          aria-describedby={consentLocked ? "assistant-consent-controls-locked" : undefined}
          disabled={isSending || consentLocked}
          maxLength={4000}
          ref={composerRef}
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
