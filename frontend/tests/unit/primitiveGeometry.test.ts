import { describe, expect, it } from "vitest";
import {
  connectorFromDrag,
  deterministicSeed,
  getDefaultKeyboardShapeGeometry,
  isMeaningfulShapeDrag,
  primitiveGeometryFromSession,
  SHAPE_DRAG_THRESHOLD_PX,
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

  it("requires a fixed screen-space drag for shapes while preserving the line click default", () => {
    expect(SHAPE_DRAG_THRESHOLD_PX).toBe(3);
    expect(isMeaningfulShapeDrag({ x: 20, y: 30 }, { x: 22, y: 30 })).toBe(false);
    expect(isMeaningfulShapeDrag({ x: 20, y: 30 }, { x: 23, y: 30 })).toBe(true);
    for (const shape of ["rectangle", "ellipse", "diamond"] as const) {
      expect(primitiveGeometryFromSession(
        shape,
        { x: 20, y: 30 },
        { x: 20, y: 30 },
        { alt: false, shift: false },
        false,
      )).toBeNull();
    }
    expect(primitiveGeometryFromSession(
      "line",
      { x: 20, y: 30 },
      { x: 20, y: 30 },
      { alt: false, shift: false },
      false,
    )).toEqual({ kind: "connector", start: { x: 20, y: 30 }, end: { x: 180, y: 30 } });
  });

  it("centers default keyboard shapes and keeps them inside the persistence envelope", () => {
    expect(getDefaultKeyboardShapeGeometry("rectangle", { x: 100, y: 200, width: 800, height: 400 })).toEqual({
      kind: "shape",
      rect: { x: 420, y: 350, width: 160, height: 100 },
    });
    expect(getDefaultKeyboardShapeGeometry("ellipse", { x: 0, y: 0, width: 80, height: 60 })).toEqual({
      kind: "shape",
      rect: { x: 0, y: 0, width: 80, height: 60 },
    });
    expect(getDefaultKeyboardShapeGeometry("diamond", {
      x: 1_000_000 - 200,
      y: 1_000_000 - 100,
      width: 400,
      height: 200,
    })).toEqual({
      kind: "shape",
      rect: { x: 1_000_000 - 140, y: 1_000_000 - 100, width: 140, height: 100 },
    });
    expect(getDefaultKeyboardShapeGeometry("rectangle", {
      x: 1_000_001,
      y: 0,
      width: 100,
      height: 100,
    })).toBeNull();
    expect(getDefaultKeyboardShapeGeometry("rectangle", { x: 0, y: 0, width: 0, height: 100 })).toBeNull();
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
