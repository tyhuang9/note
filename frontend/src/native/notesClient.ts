import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AppData } from "../types";

export type NativeNotesCommand = "load_app_data" | "save_app_data";

export type NativeNotesErrorDetails = {
  readonly code: string;
  readonly command: NativeNotesCommand;
  readonly field?: string;
  readonly message: string;
};

export class NativeNotesError extends Error {
  readonly details: NativeNotesErrorDetails;

  constructor(details: NativeNotesErrorDetails) {
    super(details.message);
    this.name = "NativeNotesError";
    this.details = details;
  }
}

export function normalizeNativeNotesError(
  error: unknown,
  command: NativeNotesCommand,
): NativeNotesError {
  if (error instanceof NativeNotesError) {
    return error;
  }

  const structuredError =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; field?: unknown; message?: unknown })
      : null;
  const message =
    typeof structuredError?.message === "string"
      ? structuredError.message
      : typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "The native notes service did not return an error message.";
  const code =
    typeof structuredError?.code === "string"
      ? structuredError.code
      : "native_notes_invoke_failed";

  return new NativeNotesError({
    code,
    command,
    ...(typeof structuredError?.field === "string"
      ? { field: structuredError.field }
      : {}),
    message,
  });
}

export async function loadAppData(): Promise<AppData> {
  assertNativeNotesAvailable("load_app_data");

  try {
    return await invoke<AppData>("load_app_data");
  } catch (error) {
    throw normalizeNativeNotesError(error, "load_app_data");
  }
}

export async function saveAppData(data: AppData): Promise<void> {
  assertNativeNotesAvailable("save_app_data");

  try {
    const noteData = new TextEncoder().encode(JSON.stringify(data));

    await invoke("save_app_data", noteData);
  } catch (error) {
    throw normalizeNativeNotesError(error, "save_app_data");
  }
}

export function isNativeNotesError(error: unknown): error is NativeNotesError {
  return error instanceof NativeNotesError;
}

function assertNativeNotesAvailable(command: NativeNotesCommand) {
  if (!isTauri()) {
    throw new NativeNotesError({
      code: "native_notes_unavailable",
      command,
      message: "Native notes persistence is unavailable in this browser.",
    });
  }
}
