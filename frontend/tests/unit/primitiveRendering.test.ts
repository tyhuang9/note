import { describe, expect, it } from "vitest";
import {
  arrowheadPoints,
  roughOptions,
  roundedRectanglePath,
  shapeRenderPadding,
} from "../../src/canvas/components/PrimitiveElementView";
import { elementIdsBackToFront } from "../../src/canvas/interaction/useCanvasInteraction";
import type { CanvasElement, RoughStyle, TextElement } from "../../src/canvas/model/elements";
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
    });
  });

  it("creates sharp and rounded rectangle paths from the persisted roundness", () => {
    expect(roundedRectanglePath(100, 60, 0)).toBe("M 0 0 H 100 V 60 H 0 Z");
    expect(roundedRectanglePath(100, 60, 0.5)).toContain("Q 100 0 100 15");
    expect(roundedRectanglePath(100, 60, 2)).toContain("Q 100 0 100 30");
  });

  it("adds render-only padding for rough outlines without changing model geometry", () => {
    expect(shapeRenderPadding({ ...style, roughness: 0, strokeWidth: 1 })).toBe(8);
    expect(shapeRenderPadding({ ...style, roughness: 8, strokeWidth: 4 })).toBe(20);
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

describe("canvas hit-test ordering", () => {
  it("sorts by z-index and preserves source order for ties", () => {
    const elements: CanvasElement[] = [text("tie-first", 5), text("front", 9), text("back", 1), text("tie-second", 5)];
    expect(elementIdsBackToFront(elements)).toEqual(["back", "tie-first", "tie-second", "front"]);
  });
});
