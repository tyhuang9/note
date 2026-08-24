import { describe, expect, it } from "vitest";
import type {
  CanvasElement,
  ConnectorElement,
  ImageElement,
  RoughStyle,
  ShapeElement,
  TextElement,
} from "../../src/canvas/model/elements";
import {
  canvasElementContainsPoint,
  getEraserElementIds,
  getElementBounds,
  shapeTextContainsPoint,
} from "../../src/canvas/model/hitTesting";
import { PEN_BRUSH } from "../../src/canvas/model/ink";

const style: RoughStyle = {
  fillColor: null,
  roughness: 1,
  roundness: 0,
  seed: 1,
  strokeColor: { kind: "fixed", value: "#000" },
  strokeStyle: "solid",
  strokeWidth: 2,
};
const base = {
  createdAt: 1,
  locked: false,
  opacity: 1,
  pageId: "page-1",
  updatedAt: 1,
  zIndex: 1,
};

const text: TextElement = {
  ...base,
  backgroundMode: "surface",
  content: "Text",
  height: 50,
  id: "text",
  rotation: 0,
  type: "text",
  width: 100,
  x: 10,
  y: 10,
};
const image: ImageElement = {
  ...base,
  assetId: "asset",
  fit: "contain",
  height: 80,
  id: "image",
  locked: true,
  naturalHeight: 80,
  naturalWidth: 120,
  rotation: 0,
  type: "image",
  width: 120,
  x: 150,
  y: 10,
};
const rectangle: ShapeElement = {
  ...base,
  height: 100,
  id: "rectangle",
  rotation: 0,
  shape: "rectangle",
  style,
  type: "shape",
  width: 120,
  x: 10,
  y: 100,
};
const ellipse: ShapeElement = {
  ...rectangle,
  id: "ellipse",
  shape: "ellipse",
  x: 160,
};
const diamond: ShapeElement = {
  ...rectangle,
  id: "diamond",
  shape: "diamond",
  x: 310,
};
const connector: ConnectorElement = {
  ...base,
  end: { kind: "free", x: 140, y: 270 },
  id: "connector",
  routing: "straight",
  start: { kind: "free", x: 20, y: 240 },
  style: { ...style, endArrowhead: "arrow", startArrowhead: "none" },
  type: "connector",
};
const ink: CanvasElement = {
  ...base,
  brush: PEN_BRUSH,
  height: 10,
  id: "ink",
  points: [[0, 0, 0.5], [80, 0, 0.5]],
  rotation: 0,
  type: "ink",
  width: 80,
  x: 180,
  y: 250,
};

describe("canvas element hit testing", () => {
  it("matches the rotated inset used by shape-owned text", () => {
    const labeled = { ...rectangle, rotation: 32, text: { content: "Editable" } };
    const center = { x: labeled.x + labeled.width / 2, y: labeled.y + labeled.height / 2 };
    const rotateLocalPoint = (x: number, y: number) => {
      const angle = (labeled.rotation * Math.PI) / 180;
      const dx = x - center.x;
      const dy = y - center.y;
      return {
        x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle),
        y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle),
      };
    };

    expect(shapeTextContainsPoint(labeled, center)).toBe(true);
    expect(shapeTextContainsPoint(labeled, rotateLocalPoint(labeled.x + 4, labeled.y + 4))).toBe(false);
    expect(shapeTextContainsPoint({ ...labeled, text: undefined }, center)).toBe(false);
  });

  it("uses box interiors for text/images and painted paths for ink", () => {
    expect(canvasElementContainsPoint(text, { x: 50, y: 30 }, 0)).toBe(true);
    expect(canvasElementContainsPoint(image, { x: 200, y: 40 }, 0)).toBe(true);
    expect(canvasElementContainsPoint(ink, { x: 220, y: 252 }, 2)).toBe(true);
    expect(canvasElementContainsPoint(ink, { x: 220, y: 270 }, 2)).toBe(false);
  });

  it("follows unfilled shape outlines and connector segments", () => {
    expect(canvasElementContainsPoint(rectangle, { x: 70, y: 101 }, 2)).toBe(true);
    expect(canvasElementContainsPoint(rectangle, { x: 70, y: 150 }, 2)).toBe(false);
    expect(canvasElementContainsPoint(ellipse, { x: 220, y: 101 }, 2)).toBe(true);
    expect(canvasElementContainsPoint(diamond, { x: 370, y: 101 }, 2)).toBe(true);
    expect(canvasElementContainsPoint(connector, { x: 80, y: 255 }, 2)).toBe(true);
    expect(canvasElementContainsPoint(connector, { x: 80, y: 280 }, 2)).toBe(false);
  });

  it("includes painted start and end arrowhead triangles in hits and bounds", () => {
    const horizontal = {
      ...connector,
      end: { kind: "free" as const, x: 120, y: 100 },
      start: { kind: "free" as const, x: 20, y: 100 },
      style: { ...connector.style, endArrowhead: "none" as const, startArrowhead: "none" as const },
    };
    const startArrow = { ...horizontal, style: { ...horizontal.style, endArrowhead: "none" as const, startArrowhead: "arrow" as const } };
    const endArrow = { ...horizontal, style: { ...horizontal.style, endArrowhead: "arrow" as const, startArrowhead: "none" as const } };
    expect(canvasElementContainsPoint(startArrow, { x: 29, y: 96 }, 0)).toBe(true);
    expect(canvasElementContainsPoint(endArrow, { x: 111, y: 96 }, 0)).toBe(true);
    expect(canvasElementContainsPoint(horizontal, { x: 29, y: 96 }, 0)).toBe(false);
    expect(getElementBounds(startArrow)).toMatchObject({ x: 15, y: 95, width: 110, height: 10 });
  });

  it("collects every unlocked geometry hit while preserving locked elements", () => {
    const elements = [text, image, rectangle, ellipse, diamond, connector, ink];
    expect(getEraserElementIds(elements, [
      { x: 50, y: 30 },
      { x: 200, y: 40 },
      { x: 70, y: 101 },
      { x: 220, y: 101 },
      { x: 370, y: 101 },
      { x: 80, y: 255 },
      { x: 220, y: 252 },
    ], 2)).toEqual(["text", "rectangle", "ellipse", "diamond", "connector", "ink"]);
  });
});
