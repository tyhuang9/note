import { describe, expect, it } from "vitest";
import {
  getDefaultKeyboardTextCaretPoint,
  getDirectTextDraftRect,
} from "../../src/canvas/interaction/directTextEntry";

describe("direct canvas text entry geometry", () => {
  it("places the first caret exactly at the requested world point", () => {
    const point = { x: 125.5, y: -44.25 };
    const rect = getDirectTextDraftRect(point);

    expect(rect).toEqual({
      height: 54,
      width: 220,
      x: 114.5,
      y: -64.25,
    });
  });

  it("rejects unsafe pointer positions instead of clamping the click", () => {
    expect(getDirectTextDraftRect({ x: 1_000_000, y: 0 })).toBeNull();
    expect(getDirectTextDraftRect({ x: Number.NaN, y: 0 })).toBeNull();
  });

  it("centers keyboard entry and keeps near-edge defaults persistence-safe", () => {
    expect(getDefaultKeyboardTextCaretPoint({ x: -500, y: -300, width: 1_000, height: 600 }))
      .toEqual({ x: 0, y: 0 });

    const edgePoint = getDefaultKeyboardTextCaretPoint({
      x: 999_800,
      y: 999_800,
      width: 200,
      height: 200,
    });
    expect(edgePoint).not.toBeNull();
    expect(getDirectTextDraftRect(edgePoint!)).not.toBeNull();
  });

  it("rejects invalid or wholly unsafe keyboard viewports", () => {
    expect(getDefaultKeyboardTextCaretPoint({ x: 0, y: 0, width: 0, height: 100 })).toBeNull();
    expect(getDefaultKeyboardTextCaretPoint({ x: 1_000_001, y: 0, width: 100, height: 100 })).toBeNull();
  });
});
