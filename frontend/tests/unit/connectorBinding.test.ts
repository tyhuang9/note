import { describe, expect, it } from "vitest";
import type { ConnectorElement, RoughStyle, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import {
  CONNECTOR_BINDING_SNAP_RADIUS_PX,
  CONNECTOR_BINDING_REVEAL_RADIUS_PX,
  detachConnectorEndpointsForDeletedTargets,
  getDefaultKeyboardArrowEndpoints,
  getConnectorAuthoringCandidate,
  getNearestBindableBoundaryAnchor,
  getShapeAnchorPoint,
  getShapeBindingAnchors,
  getTextAnchorPoint,
  MAX_CANVAS_VALUE,
  normalizeFreeConnectorEndpoint,
  resolveConnectorEndpoint,
  snapConnectorEndpoint,
  snapConnectorPointToAngle,
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

function text(overrides: Partial<TextElement> = {}): TextElement {
  return { ...shape("rectangle"), backgroundMode: "surface", content: "bound text", id: "text", rotation: 90, type: "text", ...overrides };
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
  it("inverts rotated rectangle, text, and diamond boundaries to continuous canonical anchors", () => {
    const rectangle = shape("rectangle", { rotation: 31, width: 180, height: 60 });
    const diamond = shape("diamond", { rotation: -27, width: 160, height: 80 });
    const targetText = text({ rotation: 18, width: 150, height: 44 });
    for (const [target, point] of [
      [rectangle, { x: 163, y: 52 }],
      [diamond, { x: 139, y: 62 }],
      [targetText, { x: 145, y: 61 }],
    ] as const) {
      const inverse = getNearestBindableBoundaryAnchor(target, point);
      expect(inverse).not.toBeNull();
      expect(inverse!.anchor.t).toBeGreaterThanOrEqual(0);
      expect(inverse!.anchor.t).toBeLessThan(1);
      expect(resolveConnectorEndpoint(
        { kind: "element", targetElementId: target.id, anchor: inverse!.anchor, gap: 0 },
        { [target.id]: target },
      )).toEqual(inverse!.point);
    }
  });

  it("uses a Euclidean ellipse boundary projection instead of radial projection", () => {
    const ellipse = shape("ellipse", { width: 240, height: 60, rotation: 23 });
    const inverse = getNearestBindableBoundaryAnchor(ellipse, { x: 189, y: 81 });
    expect(inverse).not.toBeNull();
    expect(inverse!.anchor.t).not.toBeCloseTo(0.25, 2);
    expect(resolveConnectorEndpoint(
      { kind: "element", targetElementId: ellipse.id, anchor: inverse!.anchor, gap: 0 },
      { [ellipse.id]: ellipse },
    )).toEqual(inverse!.point);
  });

  it("reveals and snaps one authoring target using screen-space radii", () => {
    const rectangle = shape("rectangle");
    expect(getConnectorAuthoringCandidate({ x: 130, y: 50 }, [rectangle], 1)).toMatchObject({
      activeAnchor: { name: "right" },
      endpoint: { kind: "free", x: 130, y: 50 },
      target: { id: rectangle.id },
    });
    expect(getConnectorAuthoringCandidate({ x: 128, y: 50 }, [rectangle], 1)).toMatchObject({
      endpoint: { kind: "element", targetElementId: rectangle.id, anchor: { t: 0.25 } },
    });
    expect(getConnectorAuthoringCandidate({ x: 139, y: 50 }, [rectangle], 1)).toBeNull();
    expect(getConnectorAuthoringCandidate({ x: 124, y: 50 }, [rectangle], 2)).toMatchObject({
      endpoint: { kind: "free", x: 124, y: 50 },
    });
    expect(CONNECTOR_BINDING_REVEAL_RADIUS_PX).toBe(28);
    expect(CONNECTOR_BINDING_SNAP_RADIUS_PX).toBe(18);
  });

  it("prioritizes direct hover, then distance, z-index, and stable source order", () => {
    const low = shape("rectangle", { id: "low", zIndex: 1 });
    const high = shape("rectangle", { id: "high", zIndex: 5 });
    const nearer = shape("rectangle", { id: "nearer", x: 14, zIndex: 0 });
    expect(getConnectorAuthoringCandidate({ x: 115, y: 50 }, [low, nearer, high], 1)?.target.id).toBe("nearer");
    expect(getConnectorAuthoringCandidate({ x: 110, y: 50 }, [low, high], 1)?.target.id).toBe("high");
    expect(getConnectorAuthoringCandidate({ x: 110, y: 50 }, [low, { ...low, id: "later" }], 1)?.target.id).toBe("low");
    expect(getConnectorAuthoringCandidate({ x: 110, y: 50 }, [low, high], 1, "low")?.target.id).toBe("low");
    expect(getConnectorAuthoringCandidate({ x: 300, y: 300 }, [low], 1, "low")?.endpoint).toEqual({ kind: "free", x: 300, y: 300 });
  });

  it("supports text and locked targets and snaps free endpoints to 45 degrees", () => {
    const lockedText = text({ locked: true });
    expect(getConnectorAuthoringCandidate({ x: 90, y: 50 }, [lockedText], 1, lockedText.id)).toMatchObject({
      endpoint: { kind: "element", targetElementId: lockedText.id },
      target: { locked: true, type: "text" },
    });
    const snapped = snapConnectorPointToAngle({ x: 0, y: 0 }, { x: 10, y: 7 });
    expect(snapped.x).toBeCloseTo(Math.hypot(10, 7) / Math.sqrt(2));
    expect(snapped.y).toBeCloseTo(Math.hypot(10, 7) / Math.sqrt(2));
    expect(snapConnectorPointToAngle({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });

  it("normalizes authored free endpoints to the persisted coordinate boundary", () => {
    expect(normalizeFreeConnectorEndpoint({ x: MAX_CANVAS_VALUE, y: -MAX_CANVAS_VALUE })).toEqual({
      kind: "free",
      x: MAX_CANVAS_VALUE,
      y: -MAX_CANVAS_VALUE,
    });
    expect(normalizeFreeConnectorEndpoint({ x: Number.MAX_VALUE, y: -Number.MAX_VALUE })).toEqual({
      kind: "free",
      x: MAX_CANVAS_VALUE,
      y: -MAX_CANVAS_VALUE,
    });
    expect(normalizeFreeConnectorEndpoint({ x: Number.NaN, y: 0 })).toBeNull();
    expect(normalizeFreeConnectorEndpoint({ x: 0, y: Number.POSITIVE_INFINITY })).toBeNull();
    expect(normalizeFreeConnectorEndpoint({ x: Number.NEGATIVE_INFINITY, y: 0 })).toBeNull();
  });

  it("centers a nonzero keyboard arrow in safe viewports and rejects an unsafe center", () => {
    expect(getDefaultKeyboardArrowEndpoints({ x: 100, y: 200, width: 800, height: 400 })).toEqual({
      start: { kind: "free", x: 420, y: 400 },
      end: { kind: "free", x: 580, y: 400 },
    });
    expect(getDefaultKeyboardArrowEndpoints({ x: 0, y: 0, width: 100, height: 80 })).toEqual({
      start: { kind: "free", x: 25, y: 40 },
      end: { kind: "free", x: 75, y: 40 },
    });
    expect(getDefaultKeyboardArrowEndpoints({
      x: MAX_CANVAS_VALUE - 200,
      y: 0,
      width: 400,
      height: 100,
    })).toEqual({
      start: { kind: "free", x: MAX_CANVAS_VALUE - 80, y: 50 },
      end: { kind: "free", x: MAX_CANVAS_VALUE, y: 50 },
    });
    expect(getDefaultKeyboardArrowEndpoints({ x: MAX_CANVAS_VALUE + 1, y: 0, width: 400, height: 100 })).toBeNull();
    expect(getDefaultKeyboardArrowEndpoints({ x: Number.NaN, y: 0, width: 400, height: 100 })).toBeNull();
    expect(getDefaultKeyboardArrowEndpoints({ x: 0, y: 0, width: 0, height: 100 })).toBeNull();
  });

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

  it("snaps only within a fixed screen-pixel radius and to compatible shapes or text", () => {
    const rectangle = shape("rectangle");
    const nearAt200 = snapConnectorEndpoint({ x: 118, y: 50 }, [rectangle], 2, true);
    expect(nearAt200).toEqual({ kind: "element", targetElementId: rectangle.id, anchor: { t: 0.25 }, gap: 0 });
    expect(snapConnectorEndpoint({ x: 120, y: 50 }, [rectangle], 2, true)).toEqual({ kind: "free", x: 120, y: 50 });
    expect(snapConnectorEndpoint({ x: 130, y: 50 }, [rectangle], 0.5, true)).toMatchObject({ kind: "element", targetElementId: rectangle.id });
    expect(snapConnectorEndpoint({ x: 110, y: 50 }, [rectangle], 1, false)).toEqual({ kind: "free", x: 110, y: 50 });
    expect(snapConnectorEndpoint({ x: 92, y: 50 }, [text()], 1, true)).toMatchObject({ kind: "element", targetElementId: "text" });
    expect(CONNECTOR_BINDING_SNAP_RADIUS_PX).toBeGreaterThan(0);
  });

  it("resolves text cardinal anchors against its rotated model rectangle and detaches on delete", () => {
    const target = text();
    const connector = arrow({ kind: "element", targetElementId: target.id, anchor: { t: 0 }, gap: 4 }, { kind: "free", x: 190, y: 50 });
    expect(getTextAnchorPoint(target, { t: 0 })).toEqual({ x: 90, y: 50 });
    expect(resolveConnectorEndpoint(connector.start, { [target.id]: target })).toEqual({ x: 94, y: 50 });
    const [, detached] = detachConnectorEndpointsForDeletedTargets([target, connector], new Set([target.id]));
    expect(detached).toMatchObject({ start: { kind: "free", x: 94, y: 50 } });
  });

  it("keeps a locked bound-bound arrow live when a text target is transformed", () => {
    const source = text({ id: "source" });
    const destination = shape("rectangle", { id: "destination", x: 260 });
    const connector = { ...arrow(
      { kind: "element", targetElementId: source.id, anchor: { t: 0 }, gap: 0 },
      { kind: "element", targetElementId: destination.id, anchor: { t: 0.5 }, gap: 0 },
    ), locked: true };
    const original = resolveConnectorEndpoint(connector.start, { [source.id]: source, [destination.id]: destination });
    const preview = translateSelection([source, destination, connector], new Set([source.id]), { x: 40, y: 20 });
    const previewById = Object.fromEntries(preview.map((element) => [element.id, element]));
    expect(resolveConnectorEndpoint(connector.start, previewById)).toEqual({ x: original!.x + 40, y: original!.y + 20 });
    expect(resolveConnectorEndpoint(connector.end, previewById)).toEqual(resolveConnectorEndpoint(connector.end, { [source.id]: source, [destination.id]: destination }));
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
    const foreignShape = shape("rectangle", { id: "foreign", pageId: "other-page" });
    const overLimitResolution = shape("rectangle", { id: "edge", width: 1, x: MAX_CANVAS_VALUE - 1 });
    const unsafeRotation = shape("rectangle", { rotation: 361 });
    expect(getShapeBindingAnchors(unsafeShape)).toEqual([]);
    expect(getShapeBindingAnchors(unsafeRotation)).toEqual([]);
    expect(getShapeAnchorPoint(unsafeRotation, { t: 0 })).toBeNull();
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
    expect(resolveConnectorEndpoint(
      { kind: "element", targetElementId: foreignShape.id, anchor: { t: 0.25 }, gap: 0 },
      { [foreignShape.id]: foreignShape },
      "page",
    )).toBeNull();
    expect(resolveConnectorEndpoint(
      { kind: "element", targetElementId: overLimitResolution.id, anchor: { t: 0.25 }, gap: MAX_CANVAS_VALUE },
      { [overLimitResolution.id]: overLimitResolution },
      "page",
    )).toBeNull();
  });

  it("detaches an endpoint at the persisted coordinate boundary without changing its point", () => {
    const edge = shape("rectangle", { width: 1, x: MAX_CANVAS_VALUE - 1 });
    const connector = arrow(
      { kind: "element", targetElementId: edge.id, anchor: { t: 0.25 }, gap: 0 },
      { kind: "free", x: 1, y: 1 },
    );
    const [, detached] = detachConnectorEndpointsForDeletedTargets([edge, connector], new Set([edge.id]));
    expect(detached).toMatchObject({ start: { kind: "free", x: MAX_CANVAS_VALUE, y: 50 } });
  });
});
