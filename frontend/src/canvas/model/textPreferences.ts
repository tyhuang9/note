import type { TextBackgroundMode } from "./elements";

export type TextPreferences = Readonly<{
  backgroundMode: TextBackgroundMode;
}>;

export const DEFAULT_TEXT_PREFERENCES: TextPreferences = {
  backgroundMode: "surface",
};

export function normalizeTextBackgroundMode(value: unknown): TextBackgroundMode {
  return value === "transparent" ? "transparent" : "surface";
}

/** Safely loads text defaults from an optional, untrusted session payload. */
export function normalizeTextPreferences(value: unknown): TextPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TEXT_PREFERENCES;
  }
  return {
    backgroundMode: normalizeTextBackgroundMode(
      (value as { backgroundMode?: unknown }).backgroundMode,
    ),
  };
}
