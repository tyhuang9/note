import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EventDraft } from "./calendarClient";

export type AssistantNativeError = { code: string; message: string; field?: string };
export class AssistantNativeClientError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly isStructured: boolean;

  constructor(error: AssistantNativeError, isStructured: boolean) {
    super(error.message);
    this.name = "AssistantNativeClientError";
    this.code = error.code;
    this.field = error.field;
    this.isStructured = isStructured;
  }
}
export type CalendarReview = {
  title: string;
  notes: string | null;
  location: string | null;
  time:
    | { temporalKind: "timed"; localStart: string; localEnd: string; timeZone: string; durationMinutes: number }
    | { temporalKind: "allDay"; startDate: string; endDateExclusive: string; dayCount: number };
  recurrenceRule: string | null;
  reminderOffsetsMinutes: number[];
  source: string;
  fieldSources: Record<string, "model" | "inferred">;
};

export type CalendarProposal = {
  /** Kept only by AssistantRuntime; never render, persist, or log this value. */
  token: string;
  expiresAtUtcMs: number;
  runId: string;
  toolCallId: string;
  toolId: "calendar.create_event";
  schemaVersion: 1;
  review: CalendarReview;
  providerResult: { status: "requires_confirmation"; review: CalendarReview };
};

export type AssistantCalendarEvent = {
  eventId: string;
  title: string;
  notes: string | null;
  location: string | null;
  time:
    | { temporalKind: "timed"; startUtcMs: number; endUtcMs: number; timeZone: string }
    | { temporalKind: "allDay"; startDate: string; endDateExclusive: string };
  recurrenceRule: string | null;
  reminderOffsetsMinutes: number[];
  revision: number;
  source: "local_calendar";
  truncatedFields?: Array<"title" | "notes" | "location">;
};
type CalendarTerminal =
  | { status: "created"; event: AssistantCalendarEvent; providerResult: { status: "created"; event: AssistantCalendarEvent }; replayed: boolean }
  | { status: "cancelled"; providerResult: { status: "cancelled" }; replayed: boolean };
export type CalendarReconciliationStatus = { state: "clear" | "reconciliation_required" };
export type CalendarReconciliationAcknowledgement = {
  state: "clear";
  acknowledged: boolean;
  mode: "exact_created_outcome_received" | "agenda_inspected";
};
const unavailable: AssistantNativeError = { code: "storage_unavailable", message: "Calendar storage is unavailable." };

function toError(error: unknown): AssistantNativeClientError {
  const candidate = error as Partial<AssistantNativeError> | null;
  const isStructured = Boolean(candidate && typeof candidate.code === "string" && typeof candidate.message === "string");
  const message = isStructured ? candidate!.message! : unavailable.message;
  return new AssistantNativeClientError({ code: isStructured ? candidate!.code! : unavailable.code, message, ...(typeof candidate?.field === "string" ? { field: candidate.field } : {}) }, isStructured);
}

export function isAssistantNativeClientError(error: unknown): error is AssistantNativeClientError { return error instanceof AssistantNativeClientError; }

async function call<T>(command: string, request: unknown): Promise<T> {
  if (!isTauri()) throw toError(unavailable);
  try {
    return await invoke<T>(command, { request });
  } catch (error) {
    throw toError(error);
  }
}

async function callWithoutRequest<T>(command: string): Promise<T> {
  if (!isTauri()) throw toError(unavailable);
  try {
    return await invoke<T>(command);
  } catch (error) {
    throw toError(error);
  }
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) throw new Error(`${label} contains an unsupported field.`);
  return object;
}

function reconciliationStatus(value: unknown): CalendarReconciliationStatus {
  const response = exactObject(value, ["state"], "Calendar reconciliation status");
  if (response.state !== "clear" && response.state !== "reconciliation_required") throw new Error("Calendar reconciliation status is invalid.");
  return { state: response.state };
}

function reconciliationAcknowledgement(value: unknown, expectedMode: CalendarReconciliationAcknowledgement["mode"]): CalendarReconciliationAcknowledgement {
  const response = exactObject(value, ["state", "acknowledged", "mode"], "Calendar reconciliation acknowledgement");
  if (response.state !== "clear" || typeof response.acknowledged !== "boolean" || response.mode !== expectedMode) {
    throw new Error("Calendar reconciliation acknowledgement is invalid.");
  }
  return { state: "clear", acknowledged: response.acknowledged, mode: expectedMode };
}

export function isAssistantNativeAvailable() { return isTauri(); }

export const assistantCalendarClient = {
  execute(toolId: string, schemaVersion: number, input: unknown) {
    return call<{ toolId: string; schemaVersion: number; result: unknown }>("assistant_calendar_tool_execute", { toolId, schemaVersion, input });
  },
  propose(runId: string, toolCallId: string, input: { event: EventDraft; inferredFields?: string[] }) {
    return call<CalendarProposal>("assistant_calendar_create_propose", { runId, toolCallId, toolId: "calendar.create_event", schemaVersion: 1, input });
  },
  revise(token: string, runId: string, toolCallId: string, input: { event: EventDraft; inferredFields?: string[] }) {
    return call<CalendarProposal>("assistant_calendar_create_revise", { token, runId, toolCallId, input });
  },
  confirm(token: string, runId: string, toolCallId: string) {
    return call<CalendarTerminal>("assistant_calendar_create_confirm", { token, runId, toolCallId });
  },
  cancel(token: string, runId: string, toolCallId: string) {
    return call<CalendarTerminal>("assistant_calendar_create_cancel", { token, runId, toolCallId });
  },
  async reconciliationStatus() {
    return reconciliationStatus(await callWithoutRequest<unknown>("assistant_calendar_create_reconciliation_status"));
  },
  async acknowledgeReconciliation(mode: CalendarReconciliationAcknowledgement["mode"]) {
    return reconciliationAcknowledgement(
      await call<unknown>("assistant_calendar_create_reconciliation_acknowledge", { mode }),
      mode,
    );
  },
};
