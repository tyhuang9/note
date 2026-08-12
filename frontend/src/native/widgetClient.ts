import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WidgetSizePreset = "small" | "medium" | "large";

export type WidgetStatus = {
  requestedMode: "floating" | "desktop";
  effectiveMode: "floating";
  visibilityRequested: boolean;
  visible: boolean;
  locked: boolean;
  sizePreset: WidgetSizePreset;
  attached: false;
  fallbackReason?: "desktop_attachment_unavailable";
  errorReason?: string;
};

export type WidgetAgendaItem = {
  eventId: string;
  occurrenceKey: string;
  title: string;
  time:
    | {
        temporalKind: "timed";
        startUtcMs: number;
        endUtcMs: number;
        timeZone: string;
      }
    | {
        temporalKind: "allDay";
        startDate: string;
        endDateExclusive: string;
      };
};

export type WidgetClientErrorShape = {
  code: string;
  message: string;
};

const WIDGET_UNAVAILABLE: WidgetClientErrorShape = {
  code: "widget_unavailable",
  message: "The agenda widget is available in the Note desktop app.",
};

export class WidgetClientError extends Error implements WidgetClientErrorShape {
  readonly code: string;

  constructor(error: WidgetClientErrorShape) {
    super(error.message);
    this.name = "WidgetClientError";
    this.code = error.code;
  }
}

function isWidgetClientErrorShape(error: unknown): error is WidgetClientErrorShape {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as Record<string, unknown>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasRequiredKeys(value: Record<string, unknown>, requiredKeys: readonly string[]) {
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const WIDGET_STATUS_REQUIRED_KEYS = [
  "requestedMode",
  "effectiveMode",
  "visibilityRequested",
  "visible",
  "locked",
  "sizePreset",
  "attached",
] as const;
const WIDGET_STATUS_OPTIONAL_KEYS = ["fallbackReason", "errorReason"] as const;
const WIDGET_AGENDA_ITEM_KEYS = ["eventId", "occurrenceKey", "title", "time"] as const;
const WIDGET_TIMED_KEYS = ["temporalKind", "startUtcMs", "endUtcMs", "timeZone"] as const;
const WIDGET_ALL_DAY_KEYS = ["temporalKind", "startDate", "endDateExclusive"] as const;

function unavailableResponse(): never {
  throw new WidgetClientError(WIDGET_UNAVAILABLE);
}

function isWidgetStatus(value: unknown): value is WidgetStatus {
  if (!isRecord(value)) return false;
  if (
    !hasRequiredKeys(value, WIDGET_STATUS_REQUIRED_KEYS) ||
    !hasOnlyKeys(value, [...WIDGET_STATUS_REQUIRED_KEYS, ...WIDGET_STATUS_OPTIONAL_KEYS])
  ) return false;

  return (value.requestedMode === "floating" || value.requestedMode === "desktop") &&
    value.effectiveMode === "floating" &&
    typeof value.visibilityRequested === "boolean" &&
    typeof value.visible === "boolean" &&
    typeof value.locked === "boolean" &&
    (value.sizePreset === "small" || value.sizePreset === "medium" || value.sizePreset === "large") &&
    value.attached === false &&
    (!Object.prototype.hasOwnProperty.call(value, "fallbackReason") || value.fallbackReason === "desktop_attachment_unavailable") &&
    (!Object.prototype.hasOwnProperty.call(value, "errorReason") || typeof value.errorReason === "string");
}

function widgetStatus(value: unknown): WidgetStatus {
  if (!isWidgetStatus(value)) return unavailableResponse();
  return value;
}

function isWidgetAgendaItem(value: unknown): value is WidgetAgendaItem {
  if (!isRecord(value) || !hasRequiredKeys(value, WIDGET_AGENDA_ITEM_KEYS) || !hasOnlyKeys(value, WIDGET_AGENDA_ITEM_KEYS)) return false;
  if (typeof value.eventId !== "string" || typeof value.occurrenceKey !== "string" || typeof value.title !== "string" || !isRecord(value.time)) return false;

  const time = value.time;
  const validTimed = hasRequiredKeys(time, WIDGET_TIMED_KEYS) && hasOnlyKeys(time, WIDGET_TIMED_KEYS) && time.temporalKind === "timed" && typeof time.startUtcMs === "number" && Number.isFinite(time.startUtcMs) && typeof time.endUtcMs === "number" && Number.isFinite(time.endUtcMs) && typeof time.timeZone === "string";
  const validAllDay = hasRequiredKeys(time, WIDGET_ALL_DAY_KEYS) && hasOnlyKeys(time, WIDGET_ALL_DAY_KEYS) && time.temporalKind === "allDay" && typeof time.startDate === "string" && typeof time.endDateExclusive === "string";
  return validTimed || validAllDay;
}

function widgetAgenda(value: unknown): WidgetAgendaItem[] {
  if (!Array.isArray(value) || !value.every(isWidgetAgendaItem)) return unavailableResponse();
  return value;
}

async function invokeWidget<Response>(
  command: WidgetCommand,
  arguments_: Record<string, unknown> | undefined = undefined,
): Promise<Response> {
  if (!isTauri()) throw new WidgetClientError(WIDGET_UNAVAILABLE);

  try {
    return arguments_ === undefined
      ? await invoke<Response>(command)
      : await invoke<Response>(command, arguments_);
  } catch (error) {
    throw new WidgetClientError(
      isWidgetClientErrorShape(error) ? error : WIDGET_UNAVAILABLE,
    );
  }
}

type WidgetCommand =
  | "calendar_widget_agenda"
  | "widget_status_get"
  | "widget_show"
  | "widget_hide"
  | "widget_toggle"
  | "widget_set_locked"
  | "widget_set_size_preset"
  | "widget_open_calendar";

export const widgetClient = {
  async agenda(displayTimeZone: string): Promise<WidgetAgendaItem[]> {
    return widgetAgenda(await invokeWidget("calendar_widget_agenda", {
      request: { displayTimeZone },
    }));
  },

  async getStatus(): Promise<WidgetStatus> {
    return widgetStatus(await invokeWidget("widget_status_get"));
  },

  async show(): Promise<WidgetStatus> {
    return widgetStatus(await invokeWidget("widget_show"));
  },

  async hide(): Promise<WidgetStatus> {
    return widgetStatus(await invokeWidget("widget_hide"));
  },

  async toggle(): Promise<WidgetStatus> {
    return widgetStatus(await invokeWidget("widget_toggle"));
  },

  async setLocked(locked: boolean): Promise<WidgetStatus> {
    return widgetStatus(await invokeWidget("widget_set_locked", { locked }));
  },

  async setSizePreset(sizePreset: WidgetSizePreset): Promise<WidgetStatus> {
    return widgetStatus(await invokeWidget("widget_set_size_preset", { sizePreset }));
  },

  openCalendar(): Promise<void> {
    return invokeWidget("widget_open_calendar");
  },
};

type WidgetEvent = "note://calendar-changed" | "note://widget-status-changed";

async function listenForWidgetEvent(
  event: WidgetEvent,
  listener: (payload: unknown) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;

  return listen(event, (nativeEvent) => listener(nativeEvent.payload));
}

export function listenForWidgetCalendarChanges(
  listener: () => void,
): Promise<UnlistenFn> {
  return listenForWidgetEvent("note://calendar-changed", () => listener());
}

export function listenForWidgetStatusChanges(
  listener: (status: WidgetStatus) => void,
): Promise<UnlistenFn> {
  return listenForWidgetEvent("note://widget-status-changed", (payload) => {
    if (isWidgetStatus(payload)) listener(payload);
  });
}
