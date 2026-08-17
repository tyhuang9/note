import { describe, expect, it } from "vitest";
import type { CanvasElement, ConnectorElement, InkElement, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import { PEN_BRUSH } from "../../src/canvas/model/ink";
import {
  getProportionalScale,
  getSelectionBounds,
  getSelectionElementBounds,
  scaleSelection,
  translateSelection,
} from "../../src/canvas/model/selectionBounds";

const text: TextElement = {
  content: "One",
  createdAt: 1,
  height: 40,
  id: "text",
  locked: false,
  opacity: 1,
  pageId: "page",
  rotation: 0,
  type: "text",
  updatedAt: 1,
  width: 100,
  x: 10,
  y: 20,
  zIndex: 1,
};

const ink: InkElement = {
  brush: PEN_BRUSH,
  createdAt: 1,
  height: 20,
  id: "ink",
  locked: false,
  opacity: 1,
  pageId: "page",
  points: [[0, 0, 0.5], [40, 20, 0.7]],
  rotation: 0,
  type: "ink",
  updatedAt: 1,
  width: 40,
  x: 150,
  y: 50,
  zIndex: 2,
};

const connector: ConnectorElement = {
  createdAt: 1,
  end: { kind: "free", x: 220, y: 110 },
  id: "connector",
  locked: false,
  opacity: 1,
  pageId: "page",
  routing: "straight",
  start: { kind: "free", x: 100, y: 60 },
  style: { endArrowhead: "none", fillColor: null, roughness: 1, roundness: 0, seed: 1, startArrowhead: "none", strokeColor: { kind: "fixed", value: "#000" }, strokeStyle: "solid", strokeWidth: 4 },
  type: "connector",
  updatedAt: 1,
  zIndex: 3,
};

describe("selection bounds", () => {
  it("uses the rotated box corners rather than its unrotated DOM rectangle", () => {
    const bounds = getSelectionElementBounds({ ...text, rotation: 90 });
    expect(bounds).toMatchObject({ x: 40, width: 40, height: 100 });
    expect(bounds?.y).toBeCloseTo(-10);
  });

  it("unions box, ink, and connector endpoint bounds", () => {
    const elements: CanvasElement[] = [text, ink, connector];
    expect(getSelectionBounds(elements, Object.fromEntries(elements.map((element) => [element.id, element])))).toEqual({
      x: 10,
      y: 20,
      width: 212,
      height: 92,
    });
  });

  it("resolves element connector endpoints from compatible shape anchors", () => {
    const rectangle: ShapeElement = {
      ...text,
      id: "rectangle",
      shape: "rectangle",
      style: { fillColor: null, roughness: 1, roundness: 0, seed: 1, strokeColor: { kind: "fixed", value: "#000" }, strokeStyle: "solid", strokeWidth: 2 },
      type: "shape",
    };
    const attached: ConnectorElement = {
      ...connector,
      start: { kind: "element", targetElementId: rectangle.id, anchor: { t: 0.25 }, gap: 3 },
      end: { kind: "free", x: 220, y: 50 },
    };
    expect(getSelectionElementBounds(attached, { [rectangle.id]: rectangle, [attached.id]: attached })).toEqual({
      x: 111,
      y: 38,
      width: 111,
      height: 14,
    });
  });
});

describe("composite transforms", () => {
  it("keeps locked items fixed while translating boxes and free connector endpoints", () => {
    const locked = { ...text, id: "locked", locked: true, x: 300 };
    const result = translateSelection([text, locked, connector], new Set([text.id, locked.id, connector.id]), { x: 8, y: -5 });
    expect(result[0]).toMatchObject({ x: 18, y: 15 });
    expect(result[1]).toBe(locked);
    expect(result[2]).toMatchObject({ start: { kind: "free", x: 108, y: 55 }, end: { kind: "free", x: 228, y: 105 } });
  });

  it("leaves locked items unchanged and preserves text geometry during selection resize", () => {
    const locked = { ...text, id: "locked", locked: true, x: 300 };
    const result = scaleSelection(
      [text, locked],
      new Set([text.id, locked.id]),
      { x: 10, y: 20, width: 390, height: 40 },
      "se",
      2,
    );
    expect(result[0]).toMatchObject({ x: 10, y: 20, width: 100, height: 40 });
    expect(result[1]).toBe(locked);
  });

  it("scales non-text geometry while moving text without changing its size or content", () => {
    const result = scaleSelection([text, ink, connector], new Set([text.id, ink.id, connector.id]), { x: 10, y: 20, width: 200, height: 100 }, "se", 2);
    const scaledText = result[0] as TextElement;
    const scaledInk = result[1] as InkElement;
    expect(scaledText).toMatchObject({ x: 10, y: 20, width: 100, height: 40, content: "One" });
    expect(scaledInk).toMatchObject({ x: 290, y: 80, width: 80, height: 40 });
    expect(scaledInk.points).toEqual([[0, 0, 0.5], [80, 40, 0.7]]);
    expect(scaledInk.brush.size).toBe(8);
    expect(result[2]).toMatchObject({ start: { kind: "free", x: 190, y: 100 }, end: { kind: "free", x: 430, y: 200 } });
  });

  it("preserves every textbox sizing semantic while scaling its position", () => {
    const richText: TextElement = {
      ...text,
      content: "Manual width",
      height: 72,
      isWidthManuallyResized: true,
      richContent: { type: "doc", content: [{ type: "paragraph" }] },
      rotation: 15,
      width: 240,
      x: 90,
      y: 70,
    };
    const [result] = scaleSelection(
      [richText],
      new Set([richText.id]),
      { x: 10, y: 20, width: 300, height: 180 },
      "se",
      1.5,
    );

    expect(result).toMatchObject({
      content: richText.content,
      height: richText.height,
      isWidthManuallyResized: true,
      richContent: richText.richContent,
      rotation: richText.rotation,
      width: richText.width,
      x: 130,
      y: 95,
    });
  });

  it("recomputes the mixed preview union around position-scaled, fixed-size text", () => {
    const shape: ShapeElement = {
      ...text,
      height: 20,
      id: "shape",
      shape: "rectangle",
      style: { fillColor: null, roughness: 1, roundness: 0, seed: 2, strokeColor: { kind: "fixed", value: "#000" }, strokeStyle: "solid", strokeWidth: 2 },
      type: "shape",
      width: 40,
      x: 10,
      y: 20,
    };
    const offsetText = { ...text, x: 150, y: 50 };
    const selectedIds = new Set([shape.id, offsetText.id]);
    const scaled = scaleSelection(
      [shape, offsetText],
      selectedIds,
      { x: 10, y: 20, width: 240, height: 70 },
      "se",
      2,
    );

    expect(scaled[1]).toMatchObject({ x: 290, y: 80, width: 100, height: 40 });
    expect(getSelectionBounds(scaled, Object.fromEntries(scaled.map((element) => [element.id, element])))).toEqual({
      x: 10,
      y: 20,
      width: 380,
      height: 100,
    });
  });

  it("uses a single dominant-axis proportional scale from a corner drag", () => {
    expect(getProportionalScale({ x: 0, y: 0, width: 100, height: 50 }, "se", { x: 150, y: 60 })).toBe(1.5);
  });
});
