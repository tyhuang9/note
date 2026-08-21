import { describe, expect, it } from "vitest";
import { RoughGenerator } from "roughjs/bin/generator";
import {
  arrowheadPoints,
  roughOptions,
  roundedDiamondPath,
  roundedRectanglePath,
  shapeTextInsetStyle,
  shapeTextSurfaceColors,
  shapeRenderPadding,
  shapeRoughOptions,
  shouldRenderShapeTextSurface,
} from "../../src/canvas/components/PrimitiveElementView";
import { elementIdsBackToFront } from "../../src/canvas/interaction/useCanvasInteraction";
import type { CanvasElement, RoughStyle, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import { canvasColorToCss } from "../../src/canvas/rendering/canvasColor";

const style: RoughStyle = {
  fillColor: null,
  roughness: 2.4,
  roundness: 0,
  seed: 314159,
  strokeColor: { kind: "theme", token: "foreground" },
  strokeStyle: "dashed",
  strokeWidth: 4,
};

function text(id: string, zIndex: number): TextElement {
  return {
    backgroundMode: "surface",
    content: id,
    createdAt: 1,
    height: 20,
    id,
    locked: false,
    opacity: 1,
    pageId: "page-1",
    rotation: 0,
    type: "text",
    updatedAt: 1,
    width: 80,
    x: 0,
    y: 0,
    zIndex,
  };
}

describe("primitive rendering", () => {
  it("passes deterministic rough style fields into RoughJS", () => {
    expect(roughOptions(style)).toMatchObject({
      roughness: 2.4,
      seed: 314159,
      stroke: "var(--canvas-tool-text)",
      strokeLineDash: [8, 5],
      strokeWidth: 4,
      disableMultiStroke: true,
      disableMultiStrokeFill: true,
    });
    expect(roughOptions(style)).not.toHaveProperty("preserveVertices");
    expect(shapeRoughOptions(style)).toMatchObject({ preserveVertices: true });
  });

  it.each([
    [0.5, [4, 2.5], [14, -2.5]],
    [2, [16, 10], [11, -10]],
  ])("scales connector dash and arrowhead visual geometry at %s zoom", (zoom, dash, arrowheadBase) => {
    expect(roughOptions(style, zoom).strokeLineDash).toEqual(dash);
    const points = arrowheadPoints({ x: 0, y: 0 }, { x: 20, y: 0 }, 12 * zoom, 5 * zoom);
    expect(points?.[1]).toEqual(arrowheadBase);
    expect(roughOptions(style, zoom)).toMatchObject({ roughness: style.roughness, strokeWidth: style.strokeWidth });
  });

  it("keeps persisted square preferences visually softened only at render time", () => {
    expect(roundedRectanglePath(100, 60, 0)).toMatch(/Q 100 0 100 1\.\d+/);
    expect(roundedRectanglePath(100, 60, 0.5)).toContain("Q 100 0 100 15");
    expect(roundedRectanglePath(100, 60, 2)).toContain("Q 100 0 100 30");
  });

  it.each([
    ["rectangle", roundedRectanglePath(100, 60, 0.5)],
    ["diamond", roundedDiamondPath(100, 60)],
  ])("keeps every generated %s outline segment joined without a redundant closing stroke", (_shape, path) => {
    const generator = new RoughGenerator();
    const drawable = generator.path(path, shapeRoughOptions(style));
    const outline = generator.toPaths(drawable).find((candidate) => candidate.stroke !== "none");

    expect(path).not.toMatch(/\sZ$/);
    expect(outline).toBeDefined();
    const continuity = generatedPathContinuity(outline!.d);
    expect(continuity.moves).toBeGreaterThan(1);
    expect(continuity.maxJoinGap).toBe(0);
    expect(continuity.closeGap).toBe(0);
  });

  it("rounds diamond corners while its rendered path reaches every model cardinal extent", () => {
    const path = roundedDiamondPath(100, 60);
    const extents = sampledPathExtents(path);
    expect(extents.minX).toBeCloseTo(0, 8);
    expect(extents.maxX).toBeCloseTo(100, 8);
    expect(extents.minY).toBeCloseTo(0, 8);
    expect(extents.maxY).toBeCloseTo(60, 8);
  });

  it("adds render-only padding for rough outlines without changing model geometry", () => {
    expect(shapeRenderPadding({ ...style, roughness: 0, strokeWidth: 1 })).toBe(8);
    expect(shapeRenderPadding({ ...style, roughness: 8, strokeWidth: 4 })).toBe(20);
  });

  it("layers a shape-aware quiet surface over labeled rough fills without changing unlabeled hachure options", () => {
    const filledStyle: RoughStyle = {
      ...style,
      fillColor: { kind: "fixed", value: "#e8e2ff" },
      strokeStyle: "solid",
    };
    const unlabeled: ShapeElement = {
      createdAt: 1,
      height: 180,
      id: "rough-shape",
      locked: false,
      opacity: 1,
      pageId: "page-1",
      rotation: 12,
      shape: "diamond",
      style: filledStyle,
      type: "shape",
      updatedAt: 1,
      width: 300,
      x: 0,
      y: 0,
      zIndex: 1,
    };
    const labeled: ShapeElement = { ...unlabeled, text: { content: "Readable label" } };

    expect(roughOptions(unlabeled.style)).toMatchObject({ fill: "#e8e2ff", seed: 314159 });
    expect(roughOptions(labeled.style)).toEqual(roughOptions(unlabeled.style));
    expect(shouldRenderShapeTextSurface(unlabeled, false)).toBe(false);
    expect(shouldRenderShapeTextSurface(labeled, false)).toBe(true);
    expect(shouldRenderShapeTextSurface(unlabeled, true)).toBe(true);
    expect(shouldRenderShapeTextSurface({ ...labeled, style: { ...filledStyle, fillColor: undefined } }, false)).toBe(false);
    expect(shapeTextInsetStyle(labeled)).toEqual({
      inset: "45px 75px",
      "--shape-text-surface-color": "#000000",
      "--shape-text-surface-fill": "#e8e2ff",
      "--shape-text-surface-radius": "8px",
    });
    expect(shapeTextInsetStyle({ ...labeled, shape: "ellipse" })["--shape-text-surface-radius"]).toBe("999px");
    expect(shapeTextInsetStyle({ ...labeled, shape: "rectangle" })["--shape-text-surface-radius"]).toBe("6px");
    expect(shapeTextSurfaceColors({ kind: "fixed", value: "#123" })).toEqual({ color: "#ffffff", fill: "#123" });
    expect(shapeTextSurfaceColors({ kind: "fixed", value: "#e8e2ff" }, "dark")).toEqual({ color: "#000000", fill: "#e8e2ff" });
    expect(shapeTextSurfaceColors({ kind: "fixed", value: "#ff000080" }, "light")).toEqual({ color: "#000000", fill: "#fa7b7d" });
    expect(shapeTextSurfaceColors({ kind: "fixed", value: "#ff000080" }, "dark")).toEqual({ color: "#ffffff", fill: "#8b0b0b" });
    expect(shapeTextSurfaceColors({ kind: "theme", token: "foreground" }, "light")).toEqual({
      color: "#ffffff",
      fill: "var(--canvas-tool-text)",
    });
    expect(shapeTextSurfaceColors({ kind: "theme", token: "foreground" }, "dark")).toEqual({
      color: "#000000",
      fill: "var(--canvas-tool-text)",
    });
    expect(shapeTextSurfaceColors({ kind: "theme", token: "muted" }, "dark")).toEqual({
      color: "#000000",
      fill: "var(--workbench-text-secondary)",
    });
    expect(shapeTextSurfaceColors({ kind: "fixed", value: "invalid" })).toEqual({
      color: "var(--canvas-tool-text)",
      fill: "var(--canvas-shape-text-surface)",
    });
  });

  it("builds a finite arrowhead and skips a zero-length connector", () => {
    expect(arrowheadPoints({ x: 0, y: 0 }, { x: 20, y: 0 })).toEqual([
      [20, 0],
      [11, -5],
      [11, 5],
    ]);
    expect(arrowheadPoints({ x: 2, y: 2 }, { x: 2, y: 2 })).toBeNull();
  });

  it("resolves fixed and theme colors consistently for drafts and primitives", () => {
    expect(canvasColorToCss({ kind: "fixed", value: "#123456" })).toBe("#123456");
    expect(canvasColorToCss({ kind: "theme", token: "foreground" })).toBe("var(--canvas-tool-text)");
    expect(canvasColorToCss({ kind: "theme", token: "muted" })).toBe("var(--workbench-text-secondary)");
  });
});

function sampledPathExtents(path: string) {
  const tokens = path.match(/[MLQZ]|-?\d+(?:\.\d+)?/g);
  if (!tokens) throw new Error("Expected a numeric SVG path.");
  const points: Array<{ x: number; y: number }> = [];
  let cursor = { x: 0, y: 0 };
  let start = cursor;
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "M" || command === "L") {
      cursor = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
      if (command === "M") start = cursor;
      points.push(cursor);
      continue;
    }
    if (command === "Q") {
      const control = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
      const end = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
      for (let sample = 1; sample <= 128; sample += 1) {
        const t = sample / 128;
        const inverseT = 1 - t;
        points.push({
          x: inverseT ** 2 * cursor.x + 2 * inverseT * t * control.x + t ** 2 * end.x,
          y: inverseT ** 2 * cursor.y + 2 * inverseT * t * control.y + t ** 2 * end.y,
        });
      }
      cursor = end;
      continue;
    }
    if (command === "Z") points.push(start);
  }
  return {
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
  };
}

function generatedPathContinuity(path: string) {
  const tokens = path.match(/[MCL]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? [];
  let index = 0;
  let first: { x: number; y: number } | null = null;
  let previous: { x: number; y: number } | null = null;
  let maxJoinGap = 0;
  let moves = 0;
  const number = () => Number(tokens[index++]);
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "M") {
      const next = { x: number(), y: number() };
      if (!first) first = next;
      if (previous) maxJoinGap = Math.max(maxJoinGap, Math.hypot(next.x - previous.x, next.y - previous.y));
      previous = next;
      moves += 1;
      continue;
    }
    if (command === "L") {
      previous = { x: number(), y: number() };
      continue;
    }
    if (command === "C") {
      number();
      number();
      number();
      number();
      previous = { x: number(), y: number() };
      continue;
    }
    throw new Error(`Unexpected generated path command ${command}`);
  }
  return {
    closeGap: first && previous ? Math.hypot(first.x - previous.x, first.y - previous.y) : Number.POSITIVE_INFINITY,
    maxJoinGap,
    moves,
  };
}

describe("canvas hit-test ordering", () => {
  it("sorts by z-index and preserves source order for ties", () => {
    const elements: CanvasElement[] = [text("tie-first", 5), text("front", 9), text("back", 1), text("tie-second", 5)];
    expect(elementIdsBackToFront(elements)).toEqual(["back", "tie-first", "tie-second", "front"]);
  });
});
