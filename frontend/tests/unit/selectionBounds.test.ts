import { describe, expect, it } from "vitest";
import type { CanvasElement, ConnectorElement, InkElement, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import { PEN_BRUSH } from "../../src/canvas/model/ink";
import {
  getProportionalScale,
  getSelectionResizeTransform,
  getSelectionBounds,
  getSelectionElementBounds,
  getSelectionResizePreviewConnectorIds,
  scaleSelection,
  resizeSelection,
  translateSelection,
} from "../../src/canvas/model/selectionBounds";
import { resolveConnectorPoints } from "../../src/canvas/model/connectorBinding";

const text: TextElement = {
  backgroundMode: "surface",
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
    const elementsById = { [rectangle.id]: rectangle, [attached.id]: attached };
    const points = resolveConnectorPoints(attached, elementsById)!;
    const bounds = getSelectionElementBounds(attached, elementsById)!;
    expect(bounds.x).toBeCloseTo(Math.min(points.start.x, points.end.x) - 2);
    expect(bounds.y).toBeCloseTo(Math.min(points.start.y, points.end.y) - 2);
    expect(bounds.width).toBeCloseTo(Math.abs(points.start.x - points.end.x) + 4);
    expect(bounds.height).toBeCloseTo(Math.abs(points.start.y - points.end.y) + 4);
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

  it("leaves locked items byte-identical while scaling text geometry", () => {
    const locked = { ...text, id: "locked", locked: true, x: 300 };
    const result = scaleSelection(
      [text, locked],
      new Set([text.id, locked.id]),
      { x: 10, y: 20, width: 390, height: 40 },
      "se",
      2,
    );
    expect(result[0]).toMatchObject({ x: 10, y: 20, width: 200, height: 80, isWidthManuallyResized: true });
    expect(result[1]).toBe(locked);
  });

  it("scales non-text geometry and text widths while preserving text content", () => {
    const result = scaleSelection([text, ink, connector], new Set([text.id, ink.id, connector.id]), { x: 10, y: 20, width: 200, height: 100 }, "se", 2);
    const scaledText = result[0] as TextElement;
    const scaledInk = result[1] as InkElement;
    expect(scaledText).toMatchObject({ x: 10, y: 20, width: 200, height: 80, content: "One", isWidthManuallyResized: true });
    expect(scaledInk).toMatchObject({ x: 290, y: 80, width: 80, height: 40 });
    expect(scaledInk.points).toEqual([[0, 0, 0.5], [80, 40, 0.7]]);
    expect(scaledInk.brush.size).toBe(8);
    expect(result[2]).toMatchObject({ start: { kind: "free", x: 190, y: 100 }, end: { kind: "free", x: 430, y: 200 } });
  });

  it("deduplicates selected free connectors and bound-follow connectors for mixed resize previews", () => {
    const bound: ConnectorElement = {
      ...connector,
      id: "bound",
      start: { kind: "element", targetElementId: text.id, anchor: { t: 0.25 }, gap: 0 },
    };
    const selectedAndBound: ConnectorElement = {
      ...bound,
      id: "selected-and-bound",
    };
    const lockedSelected: ConnectorElement = {
      ...connector,
      id: "locked-selected",
      locked: true,
    };
    expect(getSelectionResizePreviewConnectorIds(
      [text, connector, bound, selectedAndBound, lockedSelected],
      new Set([text.id, connector.id, selectedAndBound.id, lockedSelected.id]),
      new Set([text.id]),
    )).toEqual(new Set([connector.id, bound.id, selectedAndBound.id]));
  });

  it("uses supplied rich-content reflow sizes without changing rich text", () => {
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
      new Map([[richText.id, { height: 108, width: 360 }]]),
    );

    expect(result).toMatchObject({
      content: richText.content,
      height: 108,
      isWidthManuallyResized: true,
      richContent: richText.richContent,
      rotation: richText.rotation,
      width: 360,
      x: 130,
      y: 95,
    });
  });

  it("recomputes mixed preview bounds from resized text geometry", () => {
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

    expect(scaled[1]).toMatchObject({ x: 290, y: 80, width: 200, height: 80, isWidthManuallyResized: true });
    expect(getSelectionBounds(scaled, Object.fromEntries(scaled.map((element) => [element.id, element])))).toEqual({
      x: 10,
      y: 20,
      width: 480,
      height: 140,
    });
  });

  it.each([
    ["nw", { x: -90, y: 6 }, { x: 110, y: 60 }],
    ["ne", { x: 10, y: 6 }, { x: 10, y: 60 }],
    ["se", { x: 10, y: 20 }, { x: 10, y: 20 }],
    ["sw", { x: -90, y: 20 }, { x: 110, y: 20 }],
  ] as const)("keeps the opposite %s text corner fixed after reflow", (corner, expectedPosition, fixedCorner) => {
    const [scaled] = scaleSelection(
      [text],
      new Set([text.id]),
      { x: text.x, y: text.y, width: text.width, height: text.height },
      corner,
      2,
      new Map([[text.id, { height: 50, width: 200 }]]),
    );
    const result = scaled as TextElement;
    expect(result).toMatchObject({ ...expectedPosition, height: 54, width: 200, isWidthManuallyResized: true });
    const opposite = corner === "nw"
      ? { x: result.x + result.width, y: result.y + result.height }
      : corner === "ne"
        ? { x: result.x, y: result.y + result.height }
        : corner === "se"
          ? { x: result.x, y: result.y }
          : { x: result.x + result.width, y: result.y };
    expect(opposite).toEqual(fixedCorner);
  });

  it("clamps malformed measured text dimensions to shared finite block minimums", () => {
    const [scaled] = scaleSelection(
      [text],
      new Set([text.id]),
      { x: text.x, y: text.y, width: text.width, height: text.height },
      "se",
      Number.POSITIVE_INFINITY,
      new Map([[text.id, { height: Number.NaN, width: Number.NEGATIVE_INFINITY }]]),
    );
    expect(scaled).toMatchObject({ height: 54, width: 140 });
  });

  it.each([0, 30, 90])("preserves each transformed opposite local corner for %d degree text", (rotation) => {
    for (const corner of ["nw", "ne", "se", "sw"] as const) {
      const rotated = { ...text, rotation, x: 50, y: 70 };
      const bounds = getSelectionElementBounds(rotated)!;
      const [scaled] = scaleSelection(
        [rotated],
        new Set([rotated.id]),
        bounds,
        corner,
        1.5,
        new Map([[rotated.id, { height: 80, width: 180 }]]),
      );
      const result = scaled as TextElement;
      const originalOpposite = rotatedLocalWorldPoint(rotated, oppositeLocalPoint(rotated, corner));
      const anchor = corner === "nw"
        ? { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
        : corner === "ne"
          ? { x: bounds.x, y: bounds.y + bounds.height }
          : corner === "se"
            ? { x: bounds.x, y: bounds.y }
            : { x: bounds.x + bounds.width, y: bounds.y };
      const expectedOpposite = {
        x: anchor.x + (originalOpposite.x - anchor.x) * 1.5,
        y: anchor.y + (originalOpposite.y - anchor.y) * 1.5,
      };
      const resultOpposite = rotatedLocalWorldPoint(result, oppositeLocalPoint(result, corner));
      expect(resultOpposite.x).toBeCloseTo(expectedOpposite.x);
      expect(resultOpposite.y).toBeCloseTo(expectedOpposite.y);
    }
  });

  it("uses a single dominant-axis proportional scale from a corner drag", () => {
    expect(getProportionalScale({ x: 0, y: 0, width: 100, height: 50 }, "se", { x: 150, y: 60 })).toBe(1.5);
  });

  it("expands selection bounds for each painted arrowhead", () => {
    const startArrow: ConnectorElement = {
      ...connector,
      end: { kind: "free", x: 120, y: 100 },
      start: { kind: "free", x: 20, y: 100 },
      style: { ...connector.style, startArrowhead: "arrow" },
    };
    const bounds = getSelectionElementBounds(startArrow)!;
    expect(bounds).toEqual({ x: 15, y: 95, width: 110, height: 10 });
  });

  it("uses true cardinal width resizing while retaining the opposite text edge", () => {
    const frame = { x: text.x, y: text.y, width: text.width, height: text.height, rotation: 0 };
    const transform = getSelectionResizeTransform(frame, "e", { x: 210, y: 40 });
    expect(transform).toMatchObject({ scaleX: 2, scaleY: 1, anchor: { x: 10, y: 40 } });
    const [resized] = resizeSelection([text], new Set([text.id]), frame, transform,
      new Map([[text.id, { width: 200, height: 40 }]]));
    expect(resized).toMatchObject({ x: 10, y: 13, width: 200, height: 54, isWidthManuallyResized: true });
  });

  it("keeps every textbox at its own transformed opposite edge or corner", () => {
    const second = { ...text, height: 60, id: "second", width: 120, x: 210, y: 100 };
    const elements = [text, second];
    const selectedIds = new Set(elements.map((element) => element.id));
    const frame = { x: 10, y: 20, width: 320, height: 140, rotation: 0 };
    const draggedPoints = {
      e: { x: 650, y: 90 },
      n: { x: 170, y: -50 },
      ne: { x: 650, y: -50 },
      nw: { x: -310, y: -50 },
      s: { x: 170, y: 230 },
      se: { x: 650, y: 230 },
      sw: { x: -310, y: 230 },
      w: { x: -310, y: 90 },
    } as const;

    for (const handle of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const) {
      const transform = getSelectionResizeTransform(frame, handle, draggedPoints[handle]);
      const sizes = new Map(elements.map((element) => [element.id, {
        height: element.id === text.id ? 54 : 70,
        width: Math.max(140, element.width * transform.scaleX),
      }]));
      const resized = resizeSelection(elements, selectedIds, frame, transform, sizes) as TextElement[];
      for (let index = 0; index < elements.length; index += 1) {
        const original = elements[index];
        const result = resized[index];
        const originalOpposite = resizedHandleOppositeWorldPoint(original, handle);
        const expectedOpposite = {
          x: transform.anchor.x + (originalOpposite.x - transform.anchor.x) * transform.scaleX,
          y: transform.anchor.y + (originalOpposite.y - transform.anchor.y) * transform.scaleY,
        };
        const actualOpposite = resizedHandleOppositeWorldPoint(result, handle);
        expect(actualOpposite.x).toBeCloseTo(expectedOpposite.x);
        expect(actualOpposite.y).toBeCloseTo(expectedOpposite.y);
      }
      expect(resized[0].x).not.toBeCloseTo(resized[1].x);
      expect(resized[0].y).not.toBeCloseTo(resized[1].y);
    }
  });

  it("uses independent width and height factors for corner handles", () => {
    const frame = { x: 10, y: 20, width: 100, height: 40, rotation: 0 };
    const transform = getSelectionResizeTransform(frame, "se", { x: 210, y: 80 });
    expect(transform).toMatchObject({ anchor: { x: 10, y: 20 }, scaleX: 2, scaleY: 1.5 });
    const [resized] = resizeSelection([text], new Set([text.id]), frame, transform,
      new Map([[text.id, { height: 54, width: 200 }]]));
    expect(resized).toMatchObject({ height: 60, manualHeight: 60, width: 200, x: 10, y: 20 });
  });

  it("keeps the south edge fixed and records a non-clipping manual text height", () => {
    const frame = { x: text.x, y: text.y, width: text.width, height: text.height, rotation: 0 };
    const transform = getSelectionResizeTransform(frame, "n", { x: 60, y: 0 });
    const [resized] = resizeSelection([text], new Set([text.id]), frame, transform,
      new Map([[text.id, { width: 100, height: 54 }]]));
    expect(resized).toMatchObject({ x: -10, y: 0, width: 140, height: 60, manualHeight: 60 });
    expect((resized as TextElement).y + (resized as TextElement).height).toBe(60);
  });

  it("stretches ink coordinates on one axis without changing brush thickness", () => {
    const frame = { x: ink.x, y: ink.y, width: ink.width, height: ink.height, rotation: 0 };
    const transform = getSelectionResizeTransform(frame, "e", { x: 230, y: 60 });
    const [resized] = resizeSelection([ink], new Set([ink.id]), frame, transform) as InkElement[];
    expect(resized).toMatchObject({ width: 80, height: 20 });
    expect(resized.points).toEqual([[0, 0, 0.5], [80, 20, 0.7]]);
    expect(resized.brush.size).toBe(ink.brush.size);
  });

  it("calculates cardinal transforms in rotated local axes", () => {
    const frame = { x: 10, y: 20, width: 100, height: 40, rotation: 90 };
    const transform = getSelectionResizeTransform(frame, "e", { x: 60, y: 190 });
    expect(transform.scaleX).toBeCloseTo(2);
    expect(transform.scaleY).toBe(1);
    expect(transform.anchor.x).toBeCloseTo(60);
    expect(transform.anchor.y).toBeCloseTo(-10);
  });
});

function rotatedLocalWorldPoint(
  block: Pick<TextElement, "height" | "rotation" | "width" | "x" | "y">,
  point: { x: number; y: number },
) {
  const angle = (block.rotation * Math.PI) / 180;
  const center = { x: block.x + block.width / 2, y: block.y + block.height / 2 };
  const delta = { x: point.x - block.width / 2, y: point.y - block.height / 2 };
  return {
    x: center.x + delta.x * Math.cos(angle) - delta.y * Math.sin(angle),
    y: center.y + delta.x * Math.sin(angle) + delta.y * Math.cos(angle),
  };
}

function oppositeLocalPoint(block: Pick<TextElement, "height" | "width">, corner: "nw" | "ne" | "se" | "sw") {
  return {
    x: corner.includes("w") ? block.width : 0,
    y: corner.includes("n") ? block.height : 0,
  };
}

function resizedHandleOppositeWorldPoint(
  block: Pick<TextElement, "height" | "rotation" | "width" | "x" | "y">,
  handle: "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw",
) {
  return rotatedLocalWorldPoint(block, {
    x: handle.includes("w") ? block.width : handle.includes("e") ? 0 : block.width / 2,
    y: handle.includes("n") ? block.height : handle.includes("s") ? 0 : block.height / 2,
  });
}
