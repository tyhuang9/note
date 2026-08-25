import { describe, expect, it } from "vitest";
import type { CanvasElement, ConnectorElement, InkElement, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import {
  applyDrawingPropertyUpdate,
  createDefaultDrawingPreferences,
  isPropertySupportedByTool,
  normalizeDrawingPreferences,
  readDrawingProperties,
  reboxInkForBrush,
  updateDrawingPreference,
} from "../../src/canvas/model/drawingPreferences";
import { isConnectorBindingPersistable, resolveConnectorPoints } from "../../src/canvas/model/connectorBinding";
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
  backgroundMode: "surface",
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

const connector: ConnectorElement = {
  ...base,
  end: { kind: "free", x: 120, y: 0 },
  id: "connector",
  routing: "straight",
  start: { kind: "free", x: 0, y: 0 },
  style: {
    endArrowhead: "none",
    fillColor: null,
    roughness: 1,
    roundness: 0,
    seed: 1,
    startArrowhead: "none",
    strokeColor: { kind: "fixed", value: "#000000" },
    strokeStyle: "solid",
    strokeWidth: 2,
  },
  type: "connector",
  zIndex: 4,
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

  it("uses a rounded rectangle default and keeps unsupported defaults unchanged", () => {
    const preferences = createDefaultDrawingPreferences();
    expect(preferences.rectangle.roundness).toBe(0.18);
    expect(preferences.arrow).toMatchObject({ startArrowhead: "none", endArrowhead: "arrow" });
    expect(preferences.line).toMatchObject({ startArrowhead: "none", endArrowhead: "none" });
    expect(isPropertySupportedByTool("arrow", "startArrowhead")).toBe(true);
    expect(isPropertySupportedByTool("line", "startArrowhead")).toBe(false);
    expect(updateDrawingPreference(preferences, "pen", { property: "roughness", value: 2 })).toBe(preferences);
  });

  it("normalizes legacy endpoint defaults separately for arrows and lines", () => {
    const preferences = normalizeDrawingPreferences({
      arrow: { endArrowhead: "invalid" },
      line: { endArrowhead: "arrow", startArrowhead: "invalid" },
    });
    expect(preferences.arrow).toMatchObject({ startArrowhead: "none", endArrowhead: "arrow" });
    expect(preferences.line).toMatchObject({ startArrowhead: "none", endArrowhead: "arrow" });
  });

  it("keeps Arrow defaults headed when either endpoint is cleared", () => {
    const defaults = createDefaultDrawingPreferences();
    const startCleared = updateDrawingPreference(defaults, "arrow", { property: "endArrowhead", value: "none" });
    expect(startCleared.arrow).toMatchObject({ startArrowhead: "arrow", endArrowhead: "none" });
    const endCleared = updateDrawingPreference(startCleared, "arrow", { property: "startArrowhead", value: "none" });
    expect(endCleared.arrow).toMatchObject({ startArrowhead: "none", endArrowhead: "arrow" });
    expect(normalizeDrawingPreferences({
      arrow: { startArrowhead: "none", endArrowhead: "none" },
    }).arrow).toMatchObject({ startArrowhead: "none", endArrowhead: "arrow" });
  });

  it("keeps explicit sharp rectangle preferences while filling missing values with the rounded default", () => {
    expect(normalizeDrawingPreferences({ rectangle: { roundness: 0 } }).rectangle.roundness).toBe(0);
    expect(normalizeDrawingPreferences({ rectangle: {} }).rectangle.roundness).toBe(0.18);
    expect(normalizeDrawingPreferences({}).rectangle.roundness).toBe(0.18);
  });

  it("reports mixed and unavailable values explicitly across compatible selections", () => {
    const values = readDrawingProperties([rectangle, ellipse, text]);
    expect(values.strokeColor.kind).toBe("mixed");
    expect(values.opacity).toEqual({ kind: "value", value: 1 });
    expect(values.roundness).toEqual({ kind: "value", value: 0 });
    expect(readDrawingProperties([text]).strokeWidth.kind).toBe("unavailable");
    expect(readDrawingProperties([text]).backgroundMode).toEqual({ kind: "value", value: "surface" });
    expect(readDrawingProperties([text, { ...text, id: "transparent", backgroundMode: "transparent" }]).backgroundMode).toEqual({ kind: "mixed" });
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

  it("reports mixed endpoint heads and updates selected unlocked connectors independently", () => {
    const startArrow = { ...connector, id: "start-arrow", style: { ...connector.style, startArrowhead: "arrow" as const } };
    const locked = { ...connector, id: "locked-connector", locked: true };
    const values = readDrawingProperties([connector, startArrow, locked]);
    expect(values.startArrowhead).toEqual({ kind: "mixed" });
    expect(values.endArrowhead).toEqual({ kind: "value", value: "none" });
    const updated = applyDrawingPropertyUpdate(
      [connector, startArrow, locked],
      new Set([connector.id, startArrow.id, locked.id]),
      { property: "endArrowhead", value: "arrow" },
      10,
    ) as ConnectorElement[];
    expect(updated[0].style).toMatchObject({ startArrowhead: "none", endArrowhead: "arrow" });
    expect(updated[1].style).toMatchObject({ startArrowhead: "arrow", endArrowhead: "arrow" });
    expect(updated[2]).toBe(locked);
  });

  it("detaches bound arrows and removes labels when the last head is cleared", () => {
    const target = { ...rectangle, id: "binding-target", x: 300 };
    const boundArrow: ConnectorElement = {
      ...connector,
      end: { kind: "element", targetElementId: target.id, anchor: { t: 0.75 }, gap: 6 },
      id: "bound-arrow",
      labelStyle: {
        color: { kind: "fixed", value: "#ff0000" },
        fontFamily: "Arial",
        fontSize: "16px",
        orientation: "follow",
      },
      semantic: { label: "Removed label", relationshipType: "supports" },
      start: { kind: "element", targetElementId: rectangle.id, anchor: { t: 0.25 }, gap: 6 },
      style: { ...connector.style, endArrowhead: "arrow" },
    };
    const elements = [rectangle, target, boundArrow];
    const elementsById = Object.fromEntries(elements.map((element) => [element.id, element]));
    const points = resolveConnectorPoints(boundArrow, elementsById);
    if (!points) throw new Error("Expected bound arrow points.");

    const [,, updated] = applyDrawingPropertyUpdate(
      elements,
      new Set([boundArrow.id]),
      { property: "endArrowhead", value: "none" },
      10,
    ) as [ShapeElement, ShapeElement, ConnectorElement];

    expect(updated).toMatchObject({
      end: { kind: "free", ...points.end },
      labelStyle: undefined,
      semantic: { relationshipType: "supports" },
      start: { kind: "free", ...points.start },
      style: { startArrowhead: "none", endArrowhead: "none" },
      updatedAt: 10,
    });
    expect(updated.semantic).not.toHaveProperty("label");
    expect(isConnectorBindingPersistable(updated, elementsById)).toBe(true);
  });

  it("updates text background mode without regressing text opacity or locked text", () => {
    const lockedText = { ...text, id: "locked-text", locked: true };
    const transparent = applyDrawingPropertyUpdate(
      [text, lockedText],
      new Set([text.id, lockedText.id]),
      { property: "backgroundMode", value: "transparent" },
      10,
    );
    expect(transparent[0]).toMatchObject({ backgroundMode: "transparent", updatedAt: 10 });
    expect(transparent[1]).toBe(lockedText);

    const faded = applyDrawingPropertyUpdate(
      transparent,
      new Set([text.id]),
      { property: "opacity", value: 0.4 },
      11,
    );
    expect(faded[0]).toMatchObject({ backgroundMode: "transparent", opacity: 0.4, updatedAt: 11 });
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
