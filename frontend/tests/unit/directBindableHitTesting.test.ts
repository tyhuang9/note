import { describe, expect, it } from "vitest";
import type { CanvasElement, ConnectorElement, RoughStyle, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import { getDirectBindableTargetAtPoint } from "../../src/canvas/model/hitTesting";

const style: RoughStyle = {
  fillColor: { kind: "fixed", value: "#fff" },
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
  pageId: "page",
  updatedAt: 1,
  zIndex: 1,
};

function shape(
  id: string,
  overrides: Partial<ShapeElement> = {},
): ShapeElement {
  return {
    ...base,
    height: 100,
    id,
    rotation: 0,
    shape: "rectangle",
    style,
    type: "shape",
    width: 100,
    x: 0,
    y: 0,
    ...overrides,
  };
}

function text(id: string, overrides: Partial<TextElement> = {}): TextElement {
  return {
    ...base,
    backgroundMode: "surface",
    content: id,
    height: 40,
    id,
    rotation: 0,
    type: "text",
    width: 100,
    x: 0,
    y: 0,
    ...overrides,
  };
}

function rotatePoint(
  point: { x: number; y: number },
  element: Readonly<{ x: number; y: number; width: number; height: number; rotation: number }>,
) {
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;
  const angle = (element.rotation * Math.PI) / 180;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  return {
    x: centerX + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: centerY + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

describe("direct bindable hit testing", () => {
  it("rejects a rounded rectangle's clipped corner while accepting its interior", () => {
    const rectangle = shape("rounded", { style: { ...style, roundness: 1 } });

    expect(getDirectBindableTargetAtPoint([rectangle], { x: 2, y: 2 })).toBeUndefined();
    expect(getDirectBindableTargetAtPoint([rectangle], { x: 20, y: 20 })).toBe(rectangle);
  });

  it("uses the softened diamond boundary instead of its rectangular bounds", () => {
    const diamond = shape("diamond", { shape: "diamond" });

    expect(getDirectBindableTargetAtPoint([diamond], { x: 5, y: 5 })).toBeUndefined();
    expect(getDirectBindableTargetAtPoint([diamond], { x: 50, y: 5 })).toBe(diamond);
  });

  it("hits ellipse interiors and rejects points outside the ellipse AABB boundary", () => {
    const ellipse = shape("ellipse", { shape: "ellipse" });

    expect(getDirectBindableTargetAtPoint([ellipse], { x: 50, y: 50 })).toBe(ellipse);
    expect(getDirectBindableTargetAtPoint([ellipse], { x: 0, y: 0 })).toBeUndefined();
  });

  it("inverse-rotates text before testing its local bounds", () => {
    const rotatedText = text("rotated", { height: 40, rotation: 37, width: 120, x: 200, y: 100 });
    const localPoint = { x: rotatedText.x + 80, y: rotatedText.y + 20 };

    expect(getDirectBindableTargetAtPoint([rotatedText], rotatePoint(localPoint, rotatedText))).toBe(rotatedText);
    expect(getDirectBindableTargetAtPoint([rotatedText], { x: 150, y: 100 })).toBeUndefined();
  });

  it("ignores connector overlays and preserves z-index then source-order priority", () => {
    const target = shape("target", { zIndex: 1 });
    const connector: ConnectorElement = {
      ...base,
      end: { kind: "free", x: 100, y: 50 },
      id: "connector",
      routing: "straight",
      start: { kind: "free", x: 0, y: 50 },
      style: { ...style, endArrowhead: "arrow", startArrowhead: "none" },
      type: "connector",
      zIndex: 99,
    };
    const higher = shape("higher", { zIndex: 2 });
    const sameZEarlier = text("same-z-earlier", { zIndex: 3 });
    const sameZLater = shape("same-z-later", { zIndex: 3 });

    expect(getDirectBindableTargetAtPoint([target, connector], { x: 50, y: 50 })).toBe(target);
    expect(getDirectBindableTargetAtPoint([target, higher], { x: 50, y: 50 })).toBe(higher);
    expect(getDirectBindableTargetAtPoint([sameZEarlier, sameZLater], { x: 50, y: 50 })).toBe(sameZLater);
  });

  it("returns the deterministic topmost winner across 5,000 overlapping rounded candidates", () => {
    const elements: CanvasElement[] = Array.from({ length: 5000 }, (_, index) => shape(`shape-${index}`, {
      height: 100,
      rotation: index % 2 === 0 ? 19 : -27,
      shape: index % 2 === 0 ? "rectangle" : "diamond",
      style: { ...style, roundness: index % 2 === 0 ? 0.8 : 0 },
      width: 100,
      x: 0,
      y: 0,
      zIndex: index,
    }));

    const point = { x: 50, y: 50 };
    expect(getDirectBindableTargetAtPoint(elements, point)).toBe(elements[4999]);
    expect(getDirectBindableTargetAtPoint(elements, point)).toBe(elements[4999]);
  });
});
