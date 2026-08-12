import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type WidgetRequestedMode = "floating" | "desktop";

export type WidgetPlacementStatus = {
  requestedMode: WidgetRequestedMode;
  effectiveMode: "floating";
  visibilityRequested: boolean;
  visible: boolean;
  locked: boolean;
  sizePreset: "small" | "medium" | "large";
  attached: false;
  fallbackReason?: "desktop_attachment_unavailable";
  errorReason?: string;
};

const WIDGET_SETTINGS_UNAVAILABLE = "Widget placement controls are unavailable.";

export class WidgetSettingsClientError extends Error {
  constructor() {
    super(WIDGET_SETTINGS_UNAVAILABLE);
    this.name = "WidgetSettingsClientError";
  }
}

function isWidgetPlacementStatus(value: unknown): value is WidgetPlacementStatus {
  if (typeof value !== "object" || value === null) return false;

  const status = value as Record<string, unknown>;
  const keys = Object.keys(status);
  return (
    keys.every((key) => [
      "requestedMode",
      "effectiveMode",
      "visibilityRequested",
      "visible",
      "locked",
      "sizePreset",
      "attached",
      "fallbackReason",
      "errorReason",
    ].includes(key)) &&
    (status.requestedMode === "floating" || status.requestedMode === "desktop") &&
    status.effectiveMode === "floating" &&
    typeof status.visibilityRequested === "boolean" &&
    typeof status.visible === "boolean" &&
    typeof status.locked === "boolean" &&
    (status.sizePreset === "small" || status.sizePreset === "medium" || status.sizePreset === "large") &&
    status.attached === false &&
    (status.fallbackReason === undefined || status.fallbackReason === "desktop_attachment_unavailable") &&
    (status.errorReason === undefined || typeof status.errorReason === "string")
  );
}

function isMainWindow() {
  if (!isTauri()) return false;

  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
}

async function invokeWidgetSettings(
  command: "widget_status_get" | "widget_set_requested_mode",
  arguments_?: Record<string, unknown>,
): Promise<WidgetPlacementStatus> {
  if (!isMainWindow()) throw new WidgetSettingsClientError();

  try {
    const response = arguments_ === undefined
      ? await invoke<unknown>(command)
      : await invoke<unknown>(command, arguments_);
    if (!isWidgetPlacementStatus(response)) throw new WidgetSettingsClientError();
    return response;
  } catch {
    throw new WidgetSettingsClientError();
  }
}

export const widgetSettingsClient = {
  getStatus(): Promise<WidgetPlacementStatus> {
    return invokeWidgetSettings("widget_status_get");
  },

  setRequestedMode(mode: WidgetRequestedMode): Promise<WidgetPlacementStatus> {
    return invokeWidgetSettings("widget_set_requested_mode", { request: { mode } });
  },
};
