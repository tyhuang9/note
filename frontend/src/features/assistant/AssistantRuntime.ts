import type { EventDraft } from "../../native/calendarClient";
import { assistantCalendarClient, isAssistantNativeClientError, type CalendarProposal, type CalendarReview } from "../../native/assistantClient";
import { ASSISTANT_SCHEMA_VERSION, MAX_TOOL_CALLS_PER_ROUND, MAX_TOOL_CALLS_TOTAL, MAX_TOOL_ROUNDS, resolveAssistantTool, validateAssistantToolResult, type ToolDefinition } from "./toolRegistry";

export type AssistantProviderMetadata = { provider: string; model: string; capabilities: { tools: boolean }; dataSharing: "local" | "remote" | "unknown" };
export type AssistantToolCall = { id: string; toolId: string; arguments: unknown };
export type AssistantProviderResponse = { runId: string; status: "completed" | "requires_action" | "failed"; output?: string; toolRequests: AssistantToolCall[] };
export interface AssistantProviderAdapter { start(signal: AbortSignal): Promise<AssistantProviderResponse>; continue(runId: string, results: Array<{ toolCallId: string; toolId: string; result?: unknown; error?: string }>, signal: AbortSignal): Promise<AssistantProviderResponse>; }
export type NoteReviewField = { key?: string; label: string; before?: string; after?: string; inputType?: "text" | "number"; editable?: boolean };
export type AssistantReview =
  | { kind: "calendar"; action: "Create calendar event"; review: CalendarReview; expiresAtUtcMs: number; confirmationOutcomePending?: boolean; provider: AssistantProviderMetadata }
  | { kind: "note"; action: string; target: string; effect: string; fields: NoteReviewField[]; provider: AssistantProviderMetadata };
type Pending = { call: AssistantToolCall; tool: ToolDefinition; input: Record<string, unknown>; runId: string; targetFingerprint?: string; proposal?: CalendarProposal; confirmationOutcomeUnknown?: boolean };
export type RuntimeTransition = { kind: "completed"; response: AssistantProviderResponse } | { kind: "review"; review: AssistantReview };

export type AssistantRuntimeErrorCode = "calendar_confirm_outcome_pending" | "calendar_confirm_outcome_unresolved" | "calendar_confirm_failed" | "calendar_create_blocked_unresolved" | "calendar_proposal_lost" | "calendar_created_reconciliation_ack_failed" | "calendar_created_follow_up_failed" | "note_changed_follow_up_failed" | "note_target_changed" | "tool_timeout";
export class AssistantRuntimeError extends Error {
  constructor(readonly code: AssistantRuntimeErrorCode, message: string, readonly nativeCode?: string) { super(message); this.name = "AssistantRuntimeError"; }
}
export function isAssistantRuntimeError(error: unknown, code?: AssistantRuntimeErrorCode): error is AssistantRuntimeError { return error instanceof AssistantRuntimeError && (code === undefined || error.code === code); }
class ToolTimeoutError extends AssistantRuntimeError { constructor(readonly toolId: string, readonly timeoutMs: number, label: string) { super("tool_timeout", `${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`); this.name = "ToolTimeoutError"; } }
function abortError() { return new DOMException("The assistant request was cancelled.", "AbortError"); }
function isAbortError(error: unknown) { return error instanceof Error && error.name === "AbortError"; }
function withToolTimeout<T>(tool: ToolDefinition, operation: () => Promise<T> | T, label = `${tool.id} tool operation`, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => finish(() => reject(new ToolTimeoutError(tool.id, tool.timeoutMs, label))), tool.timeoutMs);
    Promise.resolve().then(() => {
      if (settled) throw abortError();
      return operation();
    }).then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

const DEFINITIVE_CREATE_FAILURE_CODES = new Set([
  "assistant_payload_too_large",
  "forbidden_window",
  "invalid_inferred_fields",
  "invalid_range",
  "invalid_recurrence_rule",
  "invalid_reminder_offsets",
  "invalid_time_zone",
  "invalid_title",
  "nonexistent_local_time",
  "ambiguous_local_time",
  "field_too_long",
]);
function isDefinitiveCreateFailure(error: unknown) {
  return isAssistantNativeClientError(error) && error.isStructured && DEFINITIVE_CREATE_FAILURE_CODES.has(error.code);
}
function validatedToolResult(tool: ToolDefinition, result: unknown) {
  validateAssistantToolResult(tool, result);
  const serialized = JSON.stringify(result);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > tool.maximumResultBytes) throw new Error(`${tool.id} returned more data than its declared provider limit.`);
  return result;
}

/** Provider-neutral state machine. Pending native tokens stay in this instance, never React state. */
export class AssistantRuntime {
  private controller: AbortController | null = null;
  private pending: Pending | null = null;
  private calls = 0;
  private rounds = 0;
  private runGeneration = 0;
  private activeOperation: number | null = null;
  private nextOperation = 0;
  private terminalAction = false;
  constructor(private readonly provider: AssistantProviderAdapter, private readonly metadata: AssistantProviderMetadata, private readonly tools: { read(tool: ToolDefinition, input: Record<string, unknown>): Promise<unknown>; write(tool: ToolDefinition, input: Record<string, unknown>): Promise<unknown>; describeWrite(tool: ToolDefinition, input: Record<string, unknown>): Extract<AssistantReview, { kind: "note" }>; fingerprintWrite(tool: ToolDefinition, input: Record<string, unknown>): string; canProposeCalendarCreate?(): boolean; onCalendarReconciliationCleared?(): void }) {}
  async start(): Promise<RuntimeTransition> {
    if (this.activeOperation !== null || this.pending) {
      throw new Error("Finish or cancel the current assistant action before starting another.");
    }
    this.runGeneration += 1;
    this.controller?.abort();
    this.controller = null;
    const operation = this.beginOperation();
    this.controller = new AbortController();
    this.pending = null;
    this.terminalAction = false;
    this.calls = 0;
    this.rounds = 0;
    const generation = this.runGeneration;
    try {
      const response = await this.provider.start(this.controller.signal);
      this.assertCurrent(generation);
      return await this.advance(response, generation);
    } finally {
      this.finishOperation(operation);
    }
  }
  cancel() { this.runGeneration += 1; this.controller?.abort(); this.controller = null; this.pending = null; this.terminalAction = true; }
  async confirm(): Promise<RuntimeTransition> {
    const operation = this.beginOperation();
    try {
      const pending = this.requirePending();
      const generation = this.runGeneration;
      if (
        pending.tool.operation !== "calendar.create_event" &&
        pending.targetFingerprint !== this.tools.fingerprintWrite(pending.tool, pending.input)
      ) {
        this.pending = null;
        this.terminalAction = true;
        throw new AssistantRuntimeError("note_target_changed", "The reviewed Note target changed. Ask the assistant for a new proposal.");
      }
      let result: unknown;
      if (pending.tool.operation === "calendar.create_event") {
        try {
          result = await withToolTimeout(pending.tool, () => assistantCalendarClient.confirm(pending.proposal!.token, pending.runId, pending.call.id), "Calendar confirmation", this.controller?.signal);
          this.assertCurrent(generation);
        } catch (error) {
          if (isAbortError(error)) {
            this.pending = null;
            this.terminalAction = true;
            throw new AssistantRuntimeError("calendar_confirm_outcome_unresolved", "Calendar confirmation was interrupted after dispatch. The event may already exist. Open Agenda and inspect your calendar before attempting another create.");
          }
          if (isAssistantNativeClientError(error) && ["assistant_calendar_create_reconciliation_required", "assistant_calendar_create_reconciliation_unknown"].includes(error.code)) {
            this.pending = null;
            this.terminalAction = true;
            throw new AssistantRuntimeError("calendar_confirm_outcome_unresolved", "The native calendar could not prove whether the event was created. The event may already exist. Open Agenda and inspect your calendar before attempting another create.", error.code);
          }
          if (!pending.confirmationOutcomeUnknown && (error instanceof ToolTimeoutError || !isDefinitiveCreateFailure(error))) {
            pending.confirmationOutcomeUnknown = true;
            this.assertCurrent(generation);
            throw new AssistantRuntimeError("calendar_confirm_outcome_pending", error instanceof ToolTimeoutError
              ? "Calendar confirmation timed out. The outcome is pending or unknown. Keep Note open and retry Confirm to reconcile this same proposal safely."
              : "Calendar confirmation could not be verified. The outcome is pending or unknown. Keep Note open and retry Confirm to reconcile this same proposal safely.");
          }
          this.pending = null;
          this.terminalAction = true;
          if (pending.confirmationOutcomeUnknown) {
            throw new AssistantRuntimeError("calendar_confirm_outcome_unresolved", "The calendar confirmation outcome can no longer be verified. The event may already exist. Open Agenda and inspect your calendar before attempting another create.", isAssistantNativeClientError(error) ? error.code : undefined);
          }
          const detail = isAssistantNativeClientError(error) ? error.message : "Calendar confirmation failed.";
          throw new AssistantRuntimeError("calendar_confirm_failed", `Calendar event was not created. Request a new proposal. ${detail}`, isAssistantNativeClientError(error) ? error.code : undefined);
        }
      } else {
        result = await withToolTimeout(pending.tool, () => this.tools.write(pending.tool, pending.input), `${pending.tool.id} write`);
        this.assertCurrent(generation);
      }
      this.terminalAction = true;
      this.pending = null;
      try {
        validatedToolResult(pending.tool, result);
        if (pending.tool.operation === "calendar.create_event" && (result as { status?: unknown }).status === "created") {
          try {
            await assistantCalendarClient.acknowledgeReconciliation("exact_created_outcome_received");
            this.assertCurrent(generation);
            this.tools.onCalendarReconciliationCleared?.();
          } catch (error) {
            throw new AssistantRuntimeError(
              "calendar_created_reconciliation_ack_failed",
              "Calendar event created; reconciliation acknowledgement failed. Calendar creation remains locked until you inspect Agenda and acknowledge the warning.",
              isAssistantNativeClientError(error) ? error.code : undefined,
            );
          }
        }
        return await this.continuePending(pending, result);
      } catch (error) {
        if (isAssistantRuntimeError(error, "calendar_created_reconciliation_ack_failed")) throw error;
        const detail = error instanceof Error ? ` ${error.message}` : "";
        if (pending.tool.operation === "calendar.create_event") {
          throw new AssistantRuntimeError("calendar_created_follow_up_failed", `The calendar event was created, but the assistant follow-up failed.${detail}`);
        }
        throw new AssistantRuntimeError("note_changed_follow_up_failed", `Note changed; assistant follow-up failed.${detail}`);
      }
    } finally {
      this.finishOperation(operation);
    }
  }
  async cancelReview(): Promise<{ followUp: Promise<boolean> }> {
    const operation = this.beginOperation();
    try {
      const pending = this.requirePending();
      const generation = this.runGeneration;
      const result = pending.tool.operation === "calendar.create_event"
        ? await withToolTimeout(pending.tool, () => assistantCalendarClient.cancel(pending.proposal!.token, pending.runId, pending.call.id), "Calendar cancellation")
        : { status: "cancelled" };
      this.assertCurrent(generation);
      this.pending = null;
      this.terminalAction = true;
      try {
        validatedToolResult(pending.tool, result);
      } catch {
        this.finishOperation(operation);
        return { followUp: Promise.resolve(false) };
      }
      const controller = this.controller;
      this.finishOperation(operation);
      return {
        followUp: controller
          ? this.continueCancellation(pending, result, controller, generation)
          : Promise.resolve(false),
      };
    } catch (error) {
      this.finishOperation(operation);
      throw error;
    }
  }
  async revise(input: { event: EventDraft; inferredFields?: string[] }): Promise<AssistantReview> {
    const operation = this.beginOperation();
    try {
      const pending = this.requirePending();
      if (pending.tool.operation !== "calendar.create_event" || !pending.proposal) throw new Error("This proposal cannot be edited.");
      const generation = this.runGeneration;
      let proposal: CalendarProposal;
      try {
        proposal = await withToolTimeout(pending.tool, () => assistantCalendarClient.revise(pending.proposal!.token, pending.runId, pending.call.id, input), "Calendar proposal revision", this.controller?.signal);
      } catch (error) {
        if (error instanceof ToolTimeoutError) {
          this.pending = null;
          this.terminalAction = true;
          throw new AssistantRuntimeError("calendar_proposal_lost", "The revised calendar proposal was not returned in time. No calendar creation was requested, and no uncertain review authority can be used. Ask the assistant for a new proposal.");
        }
        throw error;
      }
      this.assertCurrent(generation);
      pending.proposal = proposal;
      pending.input = { ...pending.input, ...input };
      return this.calendarReview(proposal);
    } finally {
      this.finishOperation(operation);
    }
  }
  reviseNote(patch: Record<string, string | number>): AssistantReview {
    if (this.activeOperation !== null) throw new Error("An assistant review operation is already in progress.");
    const pending = this.requirePending();
    if (pending.tool.operation === "calendar.create_event") throw new Error("Use the calendar editor for this proposal.");
    const editableKeys = new Set(this.tools.describeWrite(pending.tool, pending.input).fields.filter((field) => field.editable && field.key).map((field) => field.key!));
    if (Object.keys(patch).some((key) => !editableKeys.has(key))) throw new Error("This review field cannot be edited.");
    pending.input = pending.tool.validate({ ...pending.input, ...patch });
    return this.tools.describeWrite(pending.tool, pending.input);
  }
  private async continuePending(pending: Pending, result: unknown) { this.pending = null; const controller = this.controller; if (!controller) throw new Error("The assistant run was cancelled."); const generation = this.runGeneration; const response = await this.provider.continue(pending.runId, [{ toolCallId: pending.call.id, toolId: pending.tool.id, result }], controller.signal); this.assertCurrent(generation); return this.advance(response, generation); }
  private async continueCancellation(pending: Pending, result: unknown, controller: AbortController, generation: number) {
    const operation = this.beginOperation();
    try {
      await this.provider.continue(pending.runId, [{ toolCallId: pending.call.id, toolId: pending.tool.id, result }], controller.signal);
      this.assertCurrent(generation);
      this.cancel();
      return true;
    } catch {
      this.cancel();
      return false;
    } finally {
      this.finishOperation(operation);
    }
  }
  private async advance(response: AssistantProviderResponse, generation: number): Promise<RuntimeTransition> {
    while (response.status === "requires_action") {
      if (generation !== this.runGeneration) throw new Error("A newer assistant run replaced this response.");
      if (++this.rounds > MAX_TOOL_ROUNDS) throw new Error("The assistant exceeded the tool round limit.");
      const calls = response.toolRequests;
      if (!calls.length || calls.length > MAX_TOOL_CALLS_PER_ROUND || this.calls + calls.length > MAX_TOOL_CALLS_TOTAL) throw new Error("The assistant exceeded the tool call limit.");
      const prepared = calls.map((call) => ({ call, tool: resolveAssistantTool(call.toolId, ASSISTANT_SCHEMA_VERSION), input: null as Record<string, unknown> | null }));
      for (const entry of prepared) entry.input = entry.tool.validate(entry.call.arguments);
      this.calls += prepared.length;
      const writes = prepared.filter((entry) => entry.tool.risk === "write");
      if (writes.length > 1 || (writes.length && prepared.length !== 1)) throw new Error("Mixed or multiple assistant writes require separate requests.");
      if (writes.length) {
        const entry = writes[0]; const pending: Pending = { call: entry.call, tool: entry.tool, input: entry.input!, runId: response.runId, ...(entry.tool.operation === "calendar.create_event" ? {} : { targetFingerprint: this.tools.fingerprintWrite(entry.tool, entry.input!) }) };
        if (entry.tool.operation === "calendar.create_event") {
          if (this.tools.canProposeCalendarCreate?.() === false) throw new AssistantRuntimeError("calendar_create_blocked_unresolved", "Calendar creation is locked until you inspect Agenda and acknowledge the unresolved earlier confirmation.");
          try {
            pending.proposal = await withToolTimeout(entry.tool, () => assistantCalendarClient.propose(response.runId, entry.call.id, entry.input as { event: EventDraft; inferredFields?: string[] }), "Calendar proposal", this.controller?.signal);
          } catch (error) {
            if (error instanceof ToolTimeoutError) throw new AssistantRuntimeError("calendar_proposal_lost", "The calendar proposal was not returned in time. No calendar creation was requested, and no unreturned review authority can be used. Ask the assistant for a new proposal.");
            throw error;
          }
          this.assertCurrent(generation); this.pending = pending; this.terminalAction = false; return { kind: "review", review: this.calendarReview(pending.proposal) };
        }
        this.pending = pending;
        this.terminalAction = false;
        return { kind: "review", review: this.tools.describeWrite(entry.tool, entry.input!) };
      }
      const results = await Promise.all(prepared.map(async (entry) => {
        const result = await withToolTimeout(entry.tool, async () => entry.tool.operation.startsWith("calendar.")
          ? (await assistantCalendarClient.execute(entry.tool.id, entry.tool.schemaVersion, entry.input!)).result
          : this.tools.read(entry.tool, entry.input!), `${entry.tool.id} read`, this.controller?.signal);
        this.assertCurrent(generation);
        validatedToolResult(entry.tool, result);
        return { toolCallId: entry.call.id, toolId: entry.tool.id, result };
      }));
      this.assertCurrent(generation);
      const controller = this.controller; if (!controller) throw new Error("The assistant run was cancelled."); response = await this.provider.continue(response.runId, results, controller.signal);
      this.assertCurrent(generation);
    }
    this.assertCurrent(generation);
    if (response.status === "failed") {
      throw new Error(response.output?.trim() || "The assistant provider reported a failed run.");
    }
    return { kind: "completed", response };
  }
  private requirePending() { if (this.terminalAction || !this.pending) throw new Error("There is no assistant action awaiting review."); return this.pending; }
  private beginOperation() { if (this.activeOperation !== null) throw new Error("An assistant operation is already in progress."); const operation = ++this.nextOperation; this.activeOperation = operation; return operation; }
  private finishOperation(operation: number) { if (this.activeOperation === operation) this.activeOperation = null; }
  private assertCurrent(generation: number) { if (generation !== this.runGeneration || !this.controller || this.controller.signal.aborted) throw abortError(); }
  private calendarReview(proposal: CalendarProposal): AssistantReview { return { kind: "calendar", action: "Create calendar event", review: proposal.review, expiresAtUtcMs: proposal.expiresAtUtcMs, provider: this.metadata }; }
}
