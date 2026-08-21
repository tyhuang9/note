import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectorBindingTargetHighlight } from "../../src/canvas/components/ConnectorBindingTargetHighlight";
import type { ShapeElement, TextElement } from "../../src/canvas/model/elements";

const rectangle: ShapeElement = {
  createdAt: 1,
  height: 80,
  id: "rectangle",
  locked: false,
  opacity: 1,
  pageId: "page",
  rotation: 27,
  shape: "rectangle",
  style: {
    fillColor: null,
    roughness: 1,
    roundness: 0.2,
    seed: 1,
    strokeColor: { kind: "fixed", value: "#111827" },
    strokeStyle: "solid",
    strokeWidth: 2,
  },
  type: "shape",
  updatedAt: 1,
  width: 140,
  x: 25,
  y: 40,
  zIndex: 1,
};

describe("ConnectorBindingTargetHighlight", () => {
  it("highlights the complete rotated shape without rendering an anchor marker", () => {
    const markup = renderToStaticMarkup(createElement(ConnectorBindingTargetHighlight, {
      isSnapped: true,
      target: rectangle,
    }));
    expect(markup).toContain('data-connector-target-id="rectangle"');
    expect(markup).toContain('data-connector-binding-state="snapped"');
    expect(markup).toContain('viewBox="0 0 140 80"');
    expect(markup).toContain('transform:rotate(27deg)');
    expect(markup).toContain("<path");
    expect(markup).not.toContain("connector-binding-anchor");
  });

  it("uses the whole text rectangle for the near-target state", () => {
    const target: TextElement = {
      backgroundMode: "surface",
      content: "Target",
      createdAt: 1,
      height: 60,
      id: "text",
      locked: false,
      opacity: 1,
      pageId: "page",
      rotation: -12,
      type: "text",
      updatedAt: 1,
      width: 200,
      x: 100,
      y: 120,
      zIndex: 2,
    };
    const markup = renderToStaticMarkup(createElement(ConnectorBindingTargetHighlight, { target }));
    expect(markup).toContain('data-connector-binding-state="near"');
    expect(markup).toContain('<rect height="60" width="200" x="0" y="0"></rect>');
  });
});
