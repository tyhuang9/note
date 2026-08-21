import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getSuppressedConnectorControlPlacement,
  SuppressedConnectorControl,
} from "../../src/canvas/components/SuppressedConnectorControl";
import type { ConnectorElement, RoughStyle, ShapeElement } from "../../src/canvas/model/elements";
import { getSelectionElementBounds, unionBounds } from "../../src/canvas/model/selectionBounds";

const style: RoughStyle = {
  fillColor: { kind: "fixed", value: "#ffffff" },
  roughness: 1,
  roundness: 0.18,
  seed: 7,
  strokeColor: { kind: "fixed", value: "#111827" },
  strokeStyle: "solid",
  strokeWidth: 2,
};

function shape(id: string, x: number, y: number, rotation: number): ShapeElement {
  return {
    createdAt: 1,
    height: 120,
    id,
    locked: false,
    opacity: 1,
    pageId: "page",
    rotation,
    shape: id === "first" ? "rectangle" : "ellipse",
    style,
    type: "shape",
    updatedAt: 1,
    width: 180,
    x,
    y,
    zIndex: 1,
  };
}

function connector(firstId = "first", secondId = "second"): ConnectorElement {
  return {
    createdAt: 1,
    end: { gap: 0, kind: "element", targetElementId: secondId },
    id: "connector",
    locked: false,
    opacity: 1,
    pageId: "page",
    routing: "straight",
    start: { gap: 0, kind: "element", targetElementId: firstId },
    style: { ...style, endArrowhead: "arrow", startArrowhead: "none" },
    type: "connector",
    updatedAt: 1,
    zIndex: 3,
  };
}

describe("suppressed connector management", () => {
  it("places a 44px screen-space control outside rotated overlapping target bounds", () => {
    const first = shape("first", 100, 220, 28);
    const second = shape("second", 165, 245, -17);
    const elementsById = { first, second };
    const placement = getSuppressedConnectorControlPlacement(
      connector(),
      elementsById,
      { height: 720, width: 1100 },
      { x: 24, y: -18 },
      1.5,
    );
    expect(placement).not.toBeNull();
    const union = unionBounds(getSelectionElementBounds(first)!, getSelectionElementBounds(second)!);
    const targetRight = 24 + (union.x + union.width) * 1.5;
    expect(placement?.side).toBe("right");
    expect(placement!.left).toBeGreaterThan(targetRight);
    expect(placement!.left + 44).toBeLessThanOrEqual(1100 - 16);
    expect(placement!.top).toBeGreaterThanOrEqual(112);
  });

  it("chooses another outside edge when the target union touches the right viewport edge", () => {
    const first = shape("first", 690, 260, 22);
    const second = shape("second", 750, 280, -11);
    const elementsById = { first, second };
    const placement = getSuppressedConnectorControlPlacement(
      connector(),
      elementsById,
      { height: 700, width: 900 },
      { x: 0, y: 0 },
      1,
      true,
    );
    const union = unionBounds(getSelectionElementBounds(first)!, getSelectionElementBounds(second)!);
    expect(placement?.side).toBe("left");
    expect(placement!.left + 44).toBeLessThan(union.x);
    expect(placement!.top + 44).toBeLessThanOrEqual(700 - 190);
  });

  it("does not expose a marker for a visible or incomplete route", () => {
    const first = shape("first", 100, 220, 0);
    const overlapping = shape("second", 160, 240, 0);
    const separated = shape("second", 520, 240, 0);
    const viewport = { height: 700, width: 1000 };
    expect(getSuppressedConnectorControlPlacement(
      connector(), { first, second: separated }, viewport, { x: 0, y: 0 }, 1,
    )).toBeNull();
    expect(getSuppressedConnectorControlPlacement(
      connector(), { first, second: overlapping }, viewport, { x: 0, y: 0 }, 1,
    )).not.toBeNull();
    expect(getSuppressedConnectorControlPlacement(
      connector("first", "missing"), { first }, viewport, { x: 0, y: 0 }, 1,
    )).toBeNull();
  });

  it("renders named visible marker and endpoint/delete controls as real buttons", () => {
    const markup = renderToStaticMarkup(createElement(SuppressedConnectorControl, {
      connectorId: "connector",
      isLocked: false,
      isSelected: true,
      label: "Arrow connector 1",
      left: 240,
      onDelete: () => undefined,
      onManageEndpoint: () => undefined,
      onSelect: () => undefined,
      side: "right",
      top: 180,
    }));
    expect(markup).toContain('aria-label="Arrow connector 1 hidden because its bound objects overlap. Manage connector."');
    expect(markup).toContain(">Hidden</span>");
    expect(markup).toContain("Arrow connector 1 hidden");
    expect(markup).toContain('aria-label="Manage Arrow connector 1 start endpoint"');
    expect(markup).toContain('aria-label="Manage Arrow connector 1 end endpoint"');
    expect(markup).toContain('aria-label="Delete Arrow connector 1"');
  });
});
