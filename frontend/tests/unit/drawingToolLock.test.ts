import { describe, expect, it } from "vitest";
import { getDrawingToolLockPreference } from "../../src/canvas/state/drawingToolLock";

describe("drawing tool lock session preference", () => {
  it("uses an unlocked tool for missing and legacy session state", () => {
    expect(getDrawingToolLockPreference(undefined)).toBe(false);
    expect(getDrawingToolLockPreference(null)).toBe(false);
    expect(getDrawingToolLockPreference({})).toBe(false);
  });

  it("preserves explicit persisted lock values", () => {
    expect(getDrawingToolLockPreference({ isDrawingToolLocked: false })).toBe(false);
    expect(getDrawingToolLockPreference({ isDrawingToolLocked: true })).toBe(true);
  });
});
