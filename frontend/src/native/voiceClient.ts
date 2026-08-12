import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const MAX_VOICE_TEXT_LENGTH = 500;

export type VoiceMode = "assistant_command" | "note_dictation" | "quick_capture";
export type VoiceCaptureState =
  | "idle"
  | "recording"
  | "transcribing"
  | "cancelled"
  | "timed_out"
  | "unavailable";
export type VoiceEventSource = "quick_command";
export type VoiceProposalSource = "typed" | "voice";

export type VoiceSession = {
  generation: number;
  sessionId: string;
  state: "recording" | "transcribing" | "cancelled" | "timed_out" | "unavailable";
  mode: VoiceMode;
};

export type VoiceProposal = {
  proposalId: string;
  text: string;
  mode: VoiceMode;
  source: VoiceProposalSource;
};

export type VoiceStatus = {
  microphoneCapture: { available: boolean };
  transcription: { available: boolean };
};

export type VoiceStateEvent = {
  generation: number;
  sessionId: string;
  state: VoiceCaptureState;
  mode: VoiceMode;
  source: VoiceEventSource;
};

export type VoiceTranscriptEvent = {
  generation: number;
  sessionId: string;
  proposalId: string;
  transcript: string;
  mode: VoiceMode;
  source: "voice";
};

export type VoiceQuickCommandReady = {
  generation: number;
  shortcutPressed: boolean;
  state?: VoiceStateEvent;
  transcript?: VoiceTranscriptEvent;
};

export type VoiceShortcutEvent = {
  action: "hold_to_talk" | "assistant" | "quick_capture" | "agenda" | "widget";
  state: "pressed" | "released";
};

export type VoiceEvent =
  | { type: "state"; value: VoiceStateEvent }
  | { type: "transcript"; value: VoiceTranscriptEvent }
  | { type: "shortcut"; value: VoiceShortcutEvent };

export type VoiceNativeError = { code: string; message: string };

export class VoiceNativeClientError extends Error {
  readonly code: string;

  constructor(error: VoiceNativeError) {
    super(error.message);
    this.name = "VoiceNativeClientError";
    this.code = error.code;
  }
}

type VoiceCommand =
  | "voice_status_get"
  | "voice_quick_command_ready"
  | "voice_capture_start"
  | "voice_capture_stop"
  | "voice_capture_cancel"
  | "voice_typed_proposal"
  | "voice_proposal_submit";

type VoiceRequestByCommand = {
  voice_status_get: undefined;
  voice_quick_command_ready: undefined;
  voice_capture_start: { mode: VoiceMode };
  voice_capture_stop: { sessionId: string };
  voice_capture_cancel: { sessionId: string };
  voice_typed_proposal: { mode: VoiceMode; text: string };
  voice_proposal_submit: { proposalId: string; mode: VoiceMode };
};

const unavailable: VoiceNativeError = {
  code: "voice_unavailable",
  message: "Native voice is unavailable. Check microphone and voice configuration.",
};
const invalidResponse: VoiceNativeError = {
  code: "invalid_native_response",
  message: "Native voice returned an invalid response. Try again.",
};
const invalidInput: VoiceNativeError = {
  code: "invalid_voice_input",
  message: "Enter up to 500 characters before sending.",
};
const voiceStateEvent = "note://voice-state";
const voiceTranscriptEvent = "note://voice-transcript";
const voiceShortcutEvent = "note://voice-shortcut";
const modes = ["assistant_command", "note_dictation", "quick_capture"] as const;
const captureStates = ["idle", "recording", "transcribing", "cancelled", "timed_out", "unavailable"] as const;
const eventSources = ["quick_command"] as const;
const shortcutActions = ["hold_to_talk", "assistant", "quick_capture", "agenda", "widget"] as const;
const shortcutStates = ["pressed", "released"] as const;
const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function clientError(error: VoiceNativeError) {
  return new VoiceNativeClientError(error);
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw clientError(invalidResponse);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) throw clientError(invalidResponse);
  return object;
}

function requiredString(value: unknown, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maxLength || value.includes("\0") || (!allowEmpty && !value.trim())) {
    throw clientError(invalidResponse);
  }
  return value;
}

function identifier(value: unknown): string {
  const id = requiredString(value, MAX_ID_LENGTH);
  if (!ID_PATTERN.test(id)) throw clientError(invalidResponse);
  return id;
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw clientError(invalidResponse);
  return value as number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw clientError(invalidResponse);
  return value as T;
}

function session(value: unknown): VoiceSession {
  const response = exactObject(value, ["generation", "sessionId", "state", "mode"]);
  return {
    generation: generation(response.generation),
    sessionId: identifier(response.sessionId),
    state: oneOf(response.state, ["recording", "transcribing", "cancelled", "timed_out", "unavailable"]),
    mode: oneOf(response.mode, modes),
  };
}

function proposal(value: unknown): VoiceProposal {
  const response = exactObject(value, ["proposalId", "text", "mode", "source"]);
  if (response.source !== "typed") throw clientError(invalidResponse);
  return {
    proposalId: identifier(response.proposalId),
    text: requiredString(response.text, MAX_VOICE_TEXT_LENGTH),
    mode: oneOf(response.mode, modes),
    source: "typed",
  };
}

function submitted(value: unknown): boolean {
  const response = exactObject(value, ["accepted"]);
  if (typeof response.accepted !== "boolean") throw clientError(invalidResponse);
  return response.accepted;
}

function voiceStatus(value: unknown): VoiceStatus {
  const response = exactObject(value, ["microphoneCapture", "transcription"]);
  const capability = (candidate: unknown) => {
    const value = exactObject(candidate, ["available", "limitation"]);
    if (typeof value.available !== "boolean") throw clientError(invalidResponse);
    requiredString(value.limitation, MAX_VOICE_TEXT_LENGTH);
    return { available: value.available };
  };
  return {
    microphoneCapture: capability(response.microphoneCapture),
    transcription: capability(response.transcription),
  };
}

function stateEvent(value: unknown): VoiceStateEvent {
  const event = exactObject(value, ["generation", "sessionId", "state", "mode", "source"]);
  return {
    generation: generation(event.generation),
    sessionId: identifier(event.sessionId),
    state: oneOf(event.state, captureStates),
    mode: oneOf(event.mode, modes),
    source: oneOf(event.source, eventSources),
  };
}

function transcriptEvent(value: unknown): VoiceTranscriptEvent {
  const event = exactObject(value, ["generation", "sessionId", "proposalId", "transcript", "mode", "source"]);
  if (event.source !== "voice") throw clientError(invalidResponse);
  return {
    generation: generation(event.generation),
    sessionId: identifier(event.sessionId),
    proposalId: identifier(event.proposalId),
    transcript: requiredString(event.transcript, MAX_VOICE_TEXT_LENGTH),
    mode: oneOf(event.mode, modes),
    source: "voice",
  };
}

function quickCommandReady(value: unknown): VoiceQuickCommandReady {
  const response = exactObject(value, ["generation", "shortcutPressed", "state", "transcript"]);
  if (typeof response.shortcutPressed !== "boolean") throw clientError(invalidResponse);
  const ready = {
    generation: generation(response.generation),
    shortcutPressed: response.shortcutPressed,
    ...(response.state === undefined ? {} : { state: stateEvent(response.state) }),
    ...(response.transcript === undefined ? {} : { transcript: transcriptEvent(response.transcript) }),
  };
  if (ready.state && ready.state.generation !== ready.generation) throw clientError(invalidResponse);
  if (ready.transcript && ready.transcript.generation !== ready.generation) throw clientError(invalidResponse);
  if (ready.transcript && ready.state && (
    ready.transcript.sessionId !== ready.state.sessionId ||
    ready.transcript.mode !== ready.state.mode
  )) throw clientError(invalidResponse);
  return ready;
}

function shortcutEvent(value: unknown): VoiceShortcutEvent {
  const event = exactObject(value, ["action", "state"]);
  return {
    action: oneOf(event.action, shortcutActions),
    state: oneOf(event.state, shortcutStates),
  };
}

function toError(error: unknown): VoiceNativeClientError {
  const candidate = error as Partial<{ code: unknown }> | null;
  if (candidate && typeof candidate.code === "string" && /^[a-z_]{1,64}$/.test(candidate.code)) {
    return clientError({ ...unavailable, code: candidate.code });
  }
  return clientError(unavailable);
}

async function call<C extends VoiceCommand>(
  command: C,
  request: VoiceRequestByCommand[C],
): Promise<unknown> {
  if (!isTauri()) throw clientError(unavailable);
  try {
    return await invoke<unknown>(command, { request });
  } catch (error) {
    throw toError(error);
  }
}

async function callWithoutRequest(
  command: "voice_status_get" | "voice_quick_command_ready",
): Promise<unknown> {
  if (!isTauri()) {
    return command === "voice_status_get"
      ? {
          microphoneCapture: { available: false, limitation: unavailable.message },
          transcription: { available: false, limitation: unavailable.message },
        }
      : { generation: 0, shortcutPressed: false };
  }
  try {
    return await invoke<unknown>(command);
  } catch (error) {
    throw toError(error);
  }
}

function validInput(mode: VoiceMode, text: string) {
  if (!modes.includes(mode) || !text.trim() || text.length > MAX_VOICE_TEXT_LENGTH || text.includes("\0")) {
    throw clientError(invalidInput);
  }
}

export function isVoiceNativeAvailable() {
  return isTauri();
}

export function isVoiceNativeClientError(error: unknown): error is VoiceNativeClientError {
  return error instanceof VoiceNativeClientError;
}

export const voiceClient = {
  async status() {
    return voiceStatus(await callWithoutRequest("voice_status_get"));
  },
  async quickCommandReady() {
    return quickCommandReady(await callWithoutRequest("voice_quick_command_ready"));
  },
  async start(mode: VoiceMode) {
    const response = session(await call("voice_capture_start", { mode }));
    if (response.mode !== mode || !["recording", "unavailable"].includes(response.state)) throw clientError(invalidResponse);
    return response;
  },
  async stop(sessionId: string) {
    return session(await call("voice_capture_stop", { sessionId: identifier(sessionId) }));
  },
  async cancel(sessionId: string) {
    const response = session(await call("voice_capture_cancel", { sessionId: identifier(sessionId) }));
    if (response.state !== "cancelled") throw clientError(invalidResponse);
    return response;
  },
  async typedProposal(mode: VoiceMode, text: string) {
    validInput(mode, text);
    const response = proposal(await call("voice_typed_proposal", { mode, text }));
    if (response.mode !== mode) throw clientError(invalidResponse);
    return response;
  },
  async submitProposal(proposalId: string, mode: VoiceMode) {
    return submitted(await call("voice_proposal_submit", { proposalId: identifier(proposalId), mode }));
  },
  async listen(handler: (event: VoiceEvent) => void): Promise<UnlistenFn> {
    if (!isTauri()) return () => undefined;
    const emit = (event: VoiceEvent) => {
      try {
        handler(event);
      } catch {
        // Reject malformed native events without changing UI state.
      }
    };
    const unlisten = await Promise.all([
      listen<unknown>(voiceStateEvent, (event) => {
        try { emit({ type: "state", value: stateEvent(event.payload) }); } catch { /* rejected */ }
      }),
      listen<unknown>(voiceTranscriptEvent, (event) => {
        try { emit({ type: "transcript", value: transcriptEvent(event.payload) }); } catch { /* rejected */ }
      }),
      listen<unknown>(voiceShortcutEvent, (event) => {
        try { emit({ type: "shortcut", value: shortcutEvent(event.payload) }); } catch { /* rejected */ }
      }),
    ]);
    return () => unlisten.forEach((remove) => remove());
  },
};
