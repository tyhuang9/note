import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_PREFERENCES,
  normalizeTextBackgroundMode,
  normalizeTextPreferences,
} from "../../src/canvas/model/textPreferences";

describe("text background preferences", () => {
  it("defaults missing, malformed, and invalid session values to the surface card", () => {
    expect(normalizeTextPreferences(undefined)).toEqual(DEFAULT_TEXT_PREFERENCES);
    expect(normalizeTextPreferences(null)).toEqual(DEFAULT_TEXT_PREFERENCES);
    expect(normalizeTextPreferences([])).toEqual(DEFAULT_TEXT_PREFERENCES);
    expect(normalizeTextPreferences({ backgroundMode: "gradient" })).toEqual(DEFAULT_TEXT_PREFERENCES);
    expect(normalizeTextBackgroundMode("surface")).toBe("surface");
    expect(normalizeTextBackgroundMode("transparent")).toBe("transparent");
  });

  it("retains the only supported remembered default", () => {
    expect(normalizeTextPreferences({ backgroundMode: "transparent" })).toEqual({ backgroundMode: "transparent" });
  });
});
