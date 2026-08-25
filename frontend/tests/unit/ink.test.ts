import { describe, expect, it } from "vitest";
import { HIGHLIGHTER_BRUSH, normalizeInkGeometry, normalizePressure, PEN_BRUSH, scaleInkElement } from "../../src/canvas/model/ink";
import { inkPath, outlineToSvgPath } from "../../src/canvas/rendering/strokePath";
import type { InkElement } from "../../src/canvas/model/elements";

function ink(points: InkElement["points"]): InkElement {
  return { id: "ink", pageId: "page", type: "ink", zIndex: 0, opacity: 1, locked: false, createdAt: 1, updatedAt: 1, x: 0, y: 0, width: 100, height: 100, rotation: 0, points, brush: PEN_BRUSH };
}

describe("ink normalization", () => {
  it("normalizes finite pressure, local points, bounds, and duplicates", () => {
    expect(normalizePressure(Number.NaN, true)).toBe(0.5);
    expect(normalizePressure(4, false)).toBe(1);
    const normalized = normalizeInkGeometry([
      { x: 10, y: 20, pressure: 1.5 },
      { x: 10.04, y: 20.04, pressure: 0 },
      { x: 30, y: 40, pressure: 0.25 },
    ], 4);
    expect(normalized.x).toBe(4);
    expect(normalized.y).toBe(14);
    expect(normalized.points).toEqual([[6, 6, 1], [26, 26, 0.25]]);
  });

  it("scales local ink coordinates uniformly after a resize", () => {
    const scaled = scaleInkElement(ink([[10, 20, 0.5]]), 2);
    expect(scaled.points).toEqual([[20, 40, 0.5]]);
    expect(scaled.width).toBe(200);
    expect(scaled.height).toBe(200);
    expect(scaled.brush.size).toBe(8);
  });
});

describe("perfect-freehand stroke paths", () => {
  it("returns deterministic closed outlines for pen and highlighter brushes", () => {
    const pen = ink([[0, 0, 0.5], [40, 20, 0.7]]);
    const highlighter = { ...pen, brush: HIGHLIGHTER_BRUSH };
    expect(inkPath(pen)).toEqual(inkPath(pen));
    expect(inkPath(pen)).toMatch(/^M /);
    expect(inkPath(pen)).toMatch(/ Z$/);
    expect(inkPath(highlighter)).not.toEqual(inkPath(pen));
    expect(outlineToSvgPath([])).toBe("");
    expect(outlineToSvgPath([[1.2345, 6.789]])).toBe("M 1.23 6.79 Z");
  });
});
