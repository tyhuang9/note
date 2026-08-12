import { invoke, isTauri, transformCallback } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type VoiceMicrophone = {
  id: string;
  label: string;
  selected: boolean;
};

export type VoiceMicrophonesStatus = {
  available: boolean;
  limitation: string;
  devices: VoiceMicrophone[];
  selectedId?: string;
  selectionNotice?: string;
};

export type VoiceModelState =
  | "idle"
  | "installing"
  | "installed"
  | "cancelled"
  | "failed"
  | "unavailable";

export type VoiceModelStatus = {
  state: VoiceModelState;
  errorCode?: string;
  displayName: "Whisper small.en";
  expectedDownloadBytes: number;
  transcriptionAvailable: boolean;
};

export type VoiceModelProgressEvent = {
  operationId: string;
  state: "installing" | "verifying" | "installed" | "cancelled" | "failed";
  completedBytes: number;
  totalBytes: number;
  errorCode?: string;
};

export type VoiceShortcutState =
  | "registered"
  | "unregistered"
  | "conflict"
  | "unavailable";

export type VoiceShortcutAction = {
  status: VoiceShortcutState;
  key?: string;
  message: string;
};

export type VoiceShortcutsStatus = {
  holdToTalk: VoiceShortcutAction & {
    key: "CmdOrCtrl+Shift+V";
  };
  assistant: VoiceShortcutAction;
  quickCapture: VoiceShortcutAction;
  agenda: VoiceShortcutAction;
  widget: VoiceShortcutAction;
};

export type VoiceSettingsNativeError = { code: string; message: string };

export class VoiceSettingsClientError extends Error {
  readonly code: string;

  constructor({ code, message }: VoiceSettingsNativeError) {
    super(message);
    this.name = "VoiceSettingsClientError";
    this.code = code;
  }
}

type Unlisten = () => void | Promise<void>;

const unavailable: VoiceSettingsNativeError = {
  code: "voice_settings_unavailable",
  message: "Voice settings are available in the Note desktop app.",
};
const invalidResponse: VoiceSettingsNativeError = {
  code: "invalid_native_response",
  message: "Voice settings received an invalid native response. Try again.",
};
const invalidInput: VoiceSettingsNativeError = {
  code: "invalid_voice_settings_input",
  message: "The voice settings request is invalid.",
};
const modelProgressEvent = "note://voice-model-progress";
const MAX_DEVICES = 64;
const MAX_TEXT_LENGTH = 500;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_OPERATION_ID_LENGTH = 128;
const MAX_DOWNLOAD_BYTES = 4_000_000_000;
const microphoneIdPattern = /^mic-[a-f0-9]{16}$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const errorCodePattern = /^[a-z][a-z0-9_]{0,63}$/;

function clientError(error: VoiceSettingsNativeError) {
  return new VoiceSettingsClientError(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactObject(value: unknown, allowedKeys: readonly string[]) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw clientError(invalidResponse);
  }
  return value;
}

function boundedText(value: unknown, maxLength = MAX_TEXT_LENGTH) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    /[\0-\x08\x0b\x0c\x0e-\x1f\\/]/.test(value)
  ) {
    throw clientError(invalidResponse);
  }
  return value;
}

function safeByteCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_DOWNLOAD_BYTES
  ) {
    throw clientError(invalidResponse);
  }
  return value;
}

function requiredBoolean(value: unknown) {
  if (typeof value !== "boolean") throw clientError(invalidResponse);
  return value;
}

function microphoneId(value: unknown) {
  if (typeof value !== "string" || !microphoneIdPattern.test(value)) {
    throw clientError(invalidResponse);
  }
  return value;
}

function operationId(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > MAX_OPERATION_ID_LENGTH ||
    !opaqueIdPattern.test(value)
  ) {
    throw clientError(invalidResponse);
  }
  return value;
}

function errorCode(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > MAX_ERROR_CODE_LENGTH ||
    !errorCodePattern.test(value)
  ) {
    throw clientError(invalidResponse);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw clientError(invalidResponse);
  }
  return value as T;
}

function microphonesStatus(value: unknown): VoiceMicrophonesStatus {
  const response = exactObject(value, [
    "available",
    "limitation",
    "devices",
    "selectedId",
    "selectionNotice",
  ]);
  if (!Array.isArray(response.devices) || response.devices.length > MAX_DEVICES) {
    throw clientError(invalidResponse);
  }
  const devices = response.devices.map((device) => {
    const item = exactObject(device, ["id", "label", "selected"]);
    return {
      id: microphoneId(item.id),
      label: boundedText(item.label, 128),
      selected: requiredBoolean(item.selected),
    };
  });
  const selectedId = response.selectedId === undefined
    ? undefined
    : microphoneId(response.selectedId);
  const selected = devices.filter((device) => device.selected);

  if (selected.length > 1 || (selectedId && selected[0]?.id !== selectedId) || (!selectedId && selected.length > 0)) {
    throw clientError(invalidResponse);
  }

  return {
    available: requiredBoolean(response.available),
    limitation: boundedText(response.limitation),
    devices,
    ...(selectedId ? { selectedId } : {}),
    ...(response.selectionNotice === undefined
      ? {}
      : { selectionNotice: boundedText(response.selectionNotice, 160) }),
  };
}

function modelStatus(value: unknown): VoiceModelStatus {
  const response = exactObject(value, [
    "state",
    "errorCode",
    "displayName",
    "expectedDownloadBytes",
    "transcriptionAvailable",
  ]);
  if (response.displayName !== "Whisper small.en") throw clientError(invalidResponse);
  const state = oneOf(response.state, [
    "idle",
    "installing",
    "installed",
    "cancelled",
    "failed",
    "unavailable",
  ] as const);
  const parsedErrorCode = response.errorCode === undefined
    ? undefined
    : errorCode(response.errorCode);

  return {
    state,
    displayName: "Whisper small.en",
    expectedDownloadBytes: safeByteCount(response.expectedDownloadBytes),
    transcriptionAvailable: requiredBoolean(response.transcriptionAvailable),
    ...(parsedErrorCode ? { errorCode: parsedErrorCode } : {}),
  };
}

function shortcutAction(
  value: unknown,
  keyRequired: boolean,
  phaseSevenOnly = false,
): VoiceShortcutAction {
  const action = exactObject(value, ["status", "key", "message"]);
  const status = oneOf(action.status, [
    "registered",
    "unregistered",
    "conflict",
    "unavailable",
  ] as const);
  const key = action.key === undefined ? undefined : boundedText(action.key, 64);
  if ((keyRequired && key !== "CmdOrCtrl+Shift+V") || (phaseSevenOnly && (status !== "unavailable" || key !== undefined))) {
    throw clientError(invalidResponse);
  }
  const message = boundedText(action.message);
  if (phaseSevenOnly && message !== "Phase 7 action is not started.") {
    throw clientError(invalidResponse);
  }
  return { status, ...(key ? { key } : {}), message };
}

function shortcutsStatus(value: unknown): VoiceShortcutsStatus {
  const response = exactObject(value, [
    "holdToTalk",
    "assistant",
    "quickCapture",
    "agenda",
    "widget",
  ]);
  const holdToTalk = shortcutAction(response.holdToTalk, true);
  if (holdToTalk.key !== "CmdOrCtrl+Shift+V") throw clientError(invalidResponse);
  return {
    holdToTalk: holdToTalk as VoiceShortcutsStatus["holdToTalk"],
    assistant: shortcutAction(response.assistant, false, true),
    quickCapture: shortcutAction(response.quickCapture, false, true),
    agenda: shortcutAction(response.agenda, false, true),
    widget: shortcutAction(response.widget, false, true),
  };
}

function progressEvent(value: unknown): VoiceModelProgressEvent {
  const event = exactObject(value, [
    "operationId",
    "state",
    "completedBytes",
    "totalBytes",
    "errorCode",
  ]);
  const completedBytes = safeByteCount(event.completedBytes);
  const totalBytes = safeByteCount(event.totalBytes);
  if (totalBytes > 0 && completedBytes > totalBytes) throw clientError(invalidResponse);
  return {
    operationId: operationId(event.operationId),
    state: oneOf(event.state, [
      "installing",
      "verifying",
      "installed",
      "cancelled",
      "failed",
    ] as const),
    completedBytes,
    totalBytes,
    ...(event.errorCode === undefined ? {} : { errorCode: errorCode(event.errorCode) }),
  };
}

function normalizedError(error: unknown): VoiceSettingsNativeError {
  if (isRecord(error) && typeof error.code === "string" && errorCodePattern.test(error.code)) {
    return {
      code: error.code,
      message: error.code === "forbidden_window"
        ? "Voice settings are only available in Note’s main window."
        : "Voice settings could not complete that request. Try again.",
    };
  }
  return unavailable;
}

function removeModelProgressCallback(eventId: number) {
  try {
    window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener(modelProgressEvent, eventId);
  } catch {
    // Native listener cleanup must never change the UI state.
  }
}

function requireMainWindow() {
  if (!isTauri()) throw clientError(unavailable);
  try {
    if (getCurrentWindow().label !== "main") throw clientError(unavailable);
  } catch (error) {
    if (error instanceof VoiceSettingsClientError) throw error;
    throw clientError(unavailable);
  }
}

async function callWithoutRequest<T>(command: string, parse: (value: unknown) => T) {
  requireMainWindow();
  try {
    return parse(await invoke<unknown>(command));
  } catch (error) {
    if (error instanceof VoiceSettingsClientError) throw error;
    throw clientError(normalizedError(error));
  }
}

async function callSelect(microphoneIdValue: string) {
  requireMainWindow();
  if (!microphoneIdPattern.test(microphoneIdValue)) throw clientError(invalidInput);
  try {
    return microphonesStatus(await invoke<unknown>("voice_microphone_select", {
      request: { microphoneId: microphoneIdValue },
    }));
  } catch (error) {
    if (error instanceof VoiceSettingsClientError) throw error;
    throw clientError(normalizedError(error));
  }
}

export function isVoiceSettingsClientError(
  error: unknown,
): error is VoiceSettingsClientError {
  return error instanceof VoiceSettingsClientError;
}

export const voiceSettingsClient = {
  microphonesGet: () => callWithoutRequest("voice_microphones_get", microphonesStatus),
  microphoneSelect: (microphoneIdValue: string) => callSelect(microphoneIdValue),
  modelStatus: () => callWithoutRequest("voice_model_status", modelStatus),
  modelInstall: () => callWithoutRequest("voice_model_install", modelStatus),
  modelCancelInstall: () => callWithoutRequest("voice_model_cancel_install", modelStatus),
  modelRemove: () => callWithoutRequest("voice_model_remove", modelStatus),
  shortcutsStatusGet: () => callWithoutRequest("voice_shortcuts_status_get", shortcutsStatus),
  shortcutsRegister: () => callWithoutRequest("voice_shortcuts_register", shortcutsStatus),
  async listenToModelProgress(
    handler: (event: VoiceModelProgressEvent) => void,
  ): Promise<Unlisten> {
    requireMainWindow();
    const callbackId = transformCallback<{ payload: unknown }>(({ payload }) => {
      try {
        handler(progressEvent(payload));
      } catch {
        // Ignore malformed event payloads without mutating settings state.
      }
    });
    let eventId: number;
    try {
      eventId = await invoke<number>("plugin:event|listen", {
        event: modelProgressEvent,
        target: { kind: "Any" },
        handler: callbackId,
      });
    } catch (error) {
      removeModelProgressCallback(callbackId);
      throw clientError(normalizedError(error));
    }
    if (!Number.isSafeInteger(eventId) || eventId < 0) {
      removeModelProgressCallback(callbackId);
      throw clientError(invalidResponse);
    }
    return async () => {
      removeModelProgressCallback(eventId);
      try {
        await invoke("plugin:event|unlisten", { event: modelProgressEvent, eventId });
      } catch {
        // The event callback has already been removed locally.
      }
    };
  },
};
