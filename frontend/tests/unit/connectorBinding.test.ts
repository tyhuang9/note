import { describe, expect, it } from "vitest";
import type { ConnectorElement, RoughStyle, ShapeElement } from "../../src/canvas/model/elements";
import {
  CONNECTOR_BINDING_SNAP_RADIUS_PX,
  detachConnectorEndpointsForDeletedTargets,
  getShapeAnchorPoint,
  getShapeBindingAnchors,
  MAX_CANVAS_VALUE,
  resolveConnectorEndpoint,
  snapConnectorEndpoint,
} from "../../src/canvas/model/connectorBinding";
import { canvasElementContainsPoint, getElementBounds } from "../../src/canvas/model/hitTesting";
import { getSelectionElementBounds, scaleSelection, translateSelection } from "../../src/canvas/model/selectionBounds";

const style: RoughStyle = {
  fillColor: null,
  roughness: 1,
  roundness: 0,
  seed: 1,
  strokeColor: { kind: "fixed", value: "#000000" },
  strokeStyle: "solid",
  strokeWidth: 2,
};

function shape(shapeName: ShapeElement["shape"], overrides: Partial<ShapeElement> = {}): ShapeElement {
  return {
    createdAt: 1,
    height: 60,
    id: shapeName,
    locked: false,
    opacity: 1,
    pageId: "page",
    rotation: 0,
    shape: shapeName,
    style,
    type: "shape",
    updatedAt: 1,
    width: 100,
    x: 10,
    y: 20,
    zIndex: 1,
    ...overrides,
  };
}

function arrow(start: ConnectorElement["start"], end: ConnectorElement["end"]): ConnectorElement {
  return {
    createdAt: 1,
    end,
    id: "arrow",
    locked: false,
    opacity: 1,
    pageId: "page",
    routing: "straight",
    start,
    style: { ...style, endArrowhead: "arrow", startArrowhead: "none" },
    type: "connector",
    updatedAt: 1,
    zIndex: 2,
  };
}

describe("connector shape binding", () => {
  it.each(["rectangle", "ellipse", "diamond"] as const)("exposes the cardinal anchors for a %s", (shapeName) => {
    const anchors = getShapeBindingAnchors(shape(shapeName));
    expect(anchors.map(({ name, point }) => ({ name, point }))).toEqual([
      { name: "top", point: { x: 60, y: 20 } },
      { name: "right", point: { x: 110, y: 50 } },
      { name: "bottom", point: { x: 60, y: 80 } },
      { name: "left", point: { x: 10, y: 50 } },
    ]);
  });

  it("uses the logical rotated perimeter and applies gap outside the shape", () => {
    const rotated = shape("ellipse", { rotation: 90 });
    expect(getShapeAnchorPoint(rotated, { t: 0 })).toEqual({ x: 90, y: 50 });
    expect(getShapeAnchorPoint(rotated, { t: 0 }, 4)).toEqual({ x: 94, y: 50 });
    expect(getShapeAnchorPoint(shape("diamond", { rotation: 90 }), { t: 0.25 })).toEqual({ x: 60, y: 100 });
  });

  it("snaps only within a fixed screen-pixel radius and only to compatible shapes", () => {
    const rectangle = shape("rectangle");
    const text = { ...rectangle, id: "text", type: "text" as const, content: "not a target" };
    const nearAt200 = snapConnectorEndpoint({ x: 118, y: 50 }, [rectangle, text], 2, true);
    expect(nearAt200).toEqual({ kind: "element", targetElementId: rectangle.id, anchor: { t: 0.25 }, gap: 0 });
    expect(snapConnectorEndpoint({ x: 120, y: 50 }, [rectangle], 2, true)).toEqual({ kind: "free", x: 120, y: 50 });
    expect(snapConnectorEndpoint({ x: 130, y: 50 }, [rectangle], 0.5, true)).toMatchObject({ kind: "element", targetElementId: rectangle.id });
    expect(snapConnectorEndpoint({ x: 110, y: 50 }, [rectangle], 1, false)).toEqual({ kind: "free", x: 110, y: 50 });
    expect(CONNECTOR_BINDING_SNAP_RADIUS_PX).toBeGreaterThan(0);
  });

  it("resolves mixed endpoints consistently for selection bounds and hit testing", () => {
    const rectangle = shape("rectangle");
    const connector = arrow(
      { kind: "element", targetElementId: rectangle.id, anchor: { t: 0.25 }, gap: 2 },
      { kind: "free", x: 190, y: 50 },
    );
    const elementsById = { [rectangle.id]: rectangle, [connector.id]: connector };
    expect(resolveConnectorEndpoint(connector.start, elementsById)).toEqual({ x: 112, y: 50 });
    expect(getSelectionElementBounds(connector, elementsById)).toEqual({ x: 111, y: 49, width: 80, height: 2 });
    expect(getElementBounds(connector, elementsById)).toEqual({ x: 111, y: 49, width: 80, height: 2 });
    expect(canvasElementContainsPoint(connector, { x: 150, y: 50 }, 0, elementsById)).toBe(true);
  });

  it("keeps a bound endpoint bound during connector transforms and detaches it before target deletion", () => {
    const rectangle = shape("rectangle");
    const connector = arrow(
      { kind: "element", targetElementId: rectangle.id, anchor: { t: 0.25 }, gap: 0 },
      { kind: "free", x: 190, y: 50 },
    );
    const translated = translateSelection([connector], new Set([connector.id]), { x: 12, y: 6 })[0] as ConnectorElement;
    expect(translated.start).toEqual(connector.start);
    expect(translated.end).toEqual({ kind: "free", x: 202, y: 56 });
    const scaled = scaleSelection([connector], new Set([connector.id]), { x: 110, y: 50, width: 80, height: 10 }, "se", 2)[0] as ConnectorElement;
    expect(scaled.start).toEqual(connector.start);
    const detached = detachConnectorEndpointsForDeletedTargets([rectangle, connector], new Set([rectangle.id]));
    expect(detached[1]).toMatchObject({ start: { kind: "free", x: 110, y: 50 } });
  });

  it("fails safely for dangling or non-shape targets", () => {
    const connector = arrow(
      { kind: "element", targetElementId: "missing", anchor: { t: 0 }, gap: 0 },
      { kind: "free", x: 1, y: 1 },
    );
    expect(resolveConnectorEndpoint(connector.start, {})).toBeNull();
    expect(getSelectionElementBounds(connector, { [connector.id]: connector })).toBeNull();
  });

  it("never resolves unsafe stored geometry or endpoint magnitudes", () => {
    const rectangle = shape("rectangle");
    const unsafeShape = shape("rectangle", { x: MAX_CANVAS_VALUE + 1 });
    expect(getShapeBindingAnchors(unsafeShape)).toEqual([]);
    expect(resolveConnectorEndpoint(
      { kind: "free", x: MAX_CANVAS_VALUE + 1, y: 0 },
      {},
    )).toBeNull();
    expect(resolveConnectorEndpoint(
      { kind: "element", targetElementId: rectangle.id, anchor: { t: 0.25 }, gap: MAX_CANVAS_VALUE + 1 },
      { [rectangle.id]: rectangle },
    )).toBeNull();
    expect(resolveConnectorEndpoint(
      { kind: "element", targetElementId: unsafeShape.id, anchor: { t: 0.25 }, gap: 0 },
      { [unsafeShape.id]: unsafeShape },
    )).toBeNull();
  });
});
