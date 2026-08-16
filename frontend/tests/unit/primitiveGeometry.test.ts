import { describe, expect, it } from "vitest";
import {
  connectorFromDrag,
  deterministicSeed,
  primitiveGeometryFromSession,
  shapeRectFromDrag,
} from "../../src/canvas/interaction/primitiveGeometry";

describe("primitive drag geometry", () => {
  it("normalizes shape drags and applies Shift/Alt constraints", () => {
    expect(shapeRectFromDrag({ x: 10, y: 20 }, { x: 2, y: 26 }, { alt: false, shift: false })).toEqual({ x: 2, y: 20, width: 8, height: 6 });
    expect(shapeRectFromDrag({ x: 10, y: 20 }, { x: 2, y: 26 }, { alt: false, shift: true })).toEqual({ x: 2, y: 20, width: 8, height: 8 });
    expect(shapeRectFromDrag({ x: 10, y: 20 }, { x: 14, y: 23 }, { alt: true, shift: false })).toEqual({ x: 6, y: 17, width: 8, height: 6 });
  });

  it("snaps lines to 45 degrees and creates deterministic seeds", () => {
    const snapped = connectorFromDrag({ x: 0, y: 0 }, { x: 10, y: 7 }, { alt: false, shift: true }).end;
    expect(snapped.x).toBeCloseTo(snapped.y);
    expect(deterministicSeed("shape-1")).toBe(deterministicSeed("shape-1"));
    expect(deterministicSeed("shape-1")).not.toBe(deterministicSeed("shape-2"));
  });

  it("creates useful click defaults for every primitive family", () => {
    expect(primitiveGeometryFromSession(
      "rectangle",
      { x: 20, y: 30 },
      { x: 20, y: 30 },
      { alt: false, shift: false },
      false,
    )).toEqual({ kind: "shape", rect: { x: 20, y: 30, width: 160, height: 100 } });
    expect(primitiveGeometryFromSession(
      "arrow",
      { x: 20, y: 30 },
      { x: 20, y: 30 },
      { alt: false, shift: false },
      false,
    )).toEqual({ kind: "connector", start: { x: 20, y: 30 }, end: { x: 180, y: 30 } });
  });

  it("retains Shift and Alt modifiers through committed session geometry", () => {
    expect(primitiveGeometryFromSession(
      "diamond",
      { x: 10, y: 10 },
      { x: 14, y: 12 },
      { alt: true, shift: true },
      true,
    )).toEqual({ kind: "shape", rect: { x: 6, y: 6, width: 8, height: 8 } });
    expect(primitiveGeometryFromSession(
      "line",
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { alt: true, shift: false },
      true,
    )).toEqual({ kind: "connector", start: { x: 0, y: 10 }, end: { x: 20, y: 10 } });
  });
});
