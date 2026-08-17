import { describe, expect, it } from "vitest";
import type { CanvasElement, InkElement, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import {
  applyDrawingPropertyUpdate,
  createDefaultDrawingPreferences,
  normalizeDrawingPreferences,
  readDrawingProperties,
  reboxInkForBrush,
  updateDrawingPreference,
} from "../../src/canvas/model/drawingPreferences";
import { PEN_BRUSH } from "../../src/canvas/model/ink";

const base = {
  createdAt: 1,
  locked: false,
  opacity: 1,
  pageId: "page",
  updatedAt: 1,
};

const rectangle: ShapeElement = {
  ...base,
  height: 60,
  id: "rectangle",
  rotation: 0,
  shape: "rectangle",
  style: {
    fillColor: null,
    roughness: 1,
    roundness: 0,
    seed: 1,
    strokeColor: { kind: "fixed", value: "#000000" },
    strokeStyle: "solid",
    strokeWidth: 2,
  },
  type: "shape",
  width: 100,
  x: 0,
  y: 0,
  zIndex: 0,
};

const ellipse: ShapeElement = {
  ...rectangle,
  id: "ellipse",
  shape: "ellipse",
  style: { ...rectangle.style, strokeColor: { kind: "fixed", value: "#ff0000" } },
  zIndex: 1,
};

const text: TextElement = {
  ...base,
  content: "Text",
  height: 40,
  id: "text",
  rotation: 0,
  type: "text",
  width: 100,
  x: 0,
  y: 0,
  zIndex: 2,
};

const ink: InkElement = {
  ...base,
  brush: { ...PEN_BRUSH },
  height: 40,
  id: "ink",
  points: [[10, 10, 0.5], [30, 20, 0.7]],
  rotation: 0,
  type: "ink",
  width: 40,
  x: 100,
  y: 50,
  zIndex: 3,
};

describe("drawing preferences", () => {
  it("normalizes untrusted session values per tool without discarding valid fields", () => {
    const normalized = normalizeDrawingPreferences({
      pen: { opacity: 2, strokeColor: { kind: "fixed", value: "#123456" }, strokeWidth: 8 },
      rectangle: { roundness: 0.5, strokeStyle: "invalid" },
    });
    expect(normalized.pen).toMatchObject({ opacity: 1, strokeColor: { kind: "fixed", value: "#123456" }, strokeWidth: 8 });
    expect(normalized.rectangle.roundness).toBe(0.5);
    expect(normalized.rectangle.strokeStyle).toBe("solid");
  });

  it("keeps unsupported defaults unchanged", () => {
    const preferences = createDefaultDrawingPreferences();
    expect(preferences.rectangle.roundness).toBe(0);
    expect(updateDrawingPreference(preferences, "pen", { property: "roughness", value: 2 })).toBe(preferences);
  });

  it("reports mixed and unavailable values explicitly across compatible selections", () => {
    const values = readDrawingProperties([rectangle, ellipse, text]);
    expect(values.strokeColor.kind).toBe("mixed");
    expect(values.opacity).toEqual({ kind: "value", value: 1 });
    expect(values.roundness).toEqual({ kind: "value", value: 0 });
    expect(readDrawingProperties([text]).strokeWidth.kind).toBe("unavailable");
  });

  it("updates only selected, unlocked, compatible elements", () => {
    const lockedRectangle = { ...rectangle, id: "locked", locked: true };
    const updated = applyDrawingPropertyUpdate(
      [rectangle, ellipse, text, lockedRectangle],
      new Set([rectangle.id, ellipse.id, text.id, lockedRectangle.id]),
      { property: "roundness", value: 0.25 },
      10,
    );
    expect((updated[0] as ShapeElement).style.roundness).toBe(0.25);
    expect(updated[1]).toBe(ellipse);
    expect(updated[2]).toBe(text);
    expect(updated[3]).toBe(lockedRectangle);
  });
});

describe("ink restyling bounds", () => {
  it("preserves world-space centerline points while reboxing for a wider brush", () => {
    const originalWorldPoints = ink.points.map(([x, y]) => [ink.x + x, ink.y + y]);
    const reboxed = reboxInkForBrush({ ...ink, brush: { ...ink.brush, size: 20 } });
    expect(reboxed.points.map(([x, y]) => [reboxed.x + x, reboxed.y + y])).toEqual(originalWorldPoints);
    expect(reboxed).toMatchObject({ x: 80, y: 30, width: 80, height: 70 });
  });

  it("restyles ink through the compatibility update and leaves other types alone", () => {
    const elements: CanvasElement[] = [ink, text];
    const updated = applyDrawingPropertyUpdate(elements, new Set([ink.id, text.id]), { property: "strokeWidth", value: 12 }, 20);
    expect((updated[0] as InkElement).brush.size).toBe(12);
    expect(updated[0].updatedAt).toBe(20);
    expect(updated[1]).toBe(text);
  });
});
