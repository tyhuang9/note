import { describe, expect, it } from "vitest";
import boundaryVectors from "../../../tests/fixtures/connector-boundary-golden-vectors.json";
import objectBindingVectors from "../../../tests/fixtures/connector-object-binding-golden-vectors.json";
import type { ConnectorElement, RoughStyle, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import {
  CONNECTOR_BINDING_SNAP_RADIUS_PX,
  CONNECTOR_BINDING_REVEAL_RADIUS_PX,
  detachConnectorEndpointsForDeletedTargets,
  getConnectorCandidateAnnouncement,
  getConnectorCandidateAnnouncementKey,
  getDefaultKeyboardArrowEndpoints,
  getConnectorAuthoringCandidate,
  getNearbyBindableTargets,
  getNearestBindableBoundaryAnchor,
  getShapeAnchorPoint,
  getTextAnchorPoint,
  MAX_CANVAS_VALUE,
  normalizeFreeConnectorEndpoint,
  resolveConnectorEndpoint,
  resolveConnectorPoints,
  snapConnectorEndpoint,
  snapConnectorPointToAngle,
} from "../../src/canvas/model/connectorBinding";
import { canvasElementContainsPoint, getElementBounds } from "../../src/canvas/model/hitTesting";
import { getSelectionElementBounds, scaleSelection, translateSelection } from "../../src/canvas/model/selectionBounds";
import { flattenShapeBoundary, getShapeSupportPoint } from "../../src/canvas/model/shapeBoundary";
import { arrowheadPoints } from "../../src/canvas/components/PrimitiveElementView";

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

function adaptiveBoundaryPoints(target: ShapeElement | TextElement, tolerance = 1e-5): { x: number; y: number }[] {
  const local = target.type === "shape"
    ? flattenShapeBoundary(target.shape, target.width, target.height, target.style.roundness, tolerance)
    : [
      { x: 0, y: 0 },
      { x: target.width, y: 0 },
      { x: target.width, y: target.height },
      { x: 0, y: target.height },
    ];
  const radians = target.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return local.map((point) => {
    const dx = point.x - target.width / 2;
    const dy = point.y - target.height / 2;
    return {
      x: target.x + target.width / 2 + dx * cos - dy * sin,
      y: target.y + target.height / 2 + dx * sin + dy * cos,
    };
  });
}

function pointToSegmentDistanceForOracle(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const edge = { x: end.x - start.x, y: end.y - start.y };
  const size = edge.x * edge.x + edge.y * edge.y;
  const ratio = size === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * edge.x + (point.y - start.y) * edge.y) / size,
  ));
  return Math.hypot(point.x - start.x - edge.x * ratio, point.y - start.y - edge.y * ratio);
}

function adaptiveFlattenOracleDistance(first: ShapeElement | TextElement, second: ShapeElement | TextElement): number {
  const firstPoints = adaptiveBoundaryPoints(first);
  const secondPoints = adaptiveBoundaryPoints(second);
  let best = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < firstPoints.length; firstIndex += 1) {
    const firstStart = firstPoints[firstIndex];
    const firstEnd = firstPoints[(firstIndex + 1) % firstPoints.length];
    for (let secondIndex = 0; secondIndex < secondPoints.length; secondIndex += 1) {
      const secondStart = secondPoints[secondIndex];
      const secondEnd = secondPoints[(secondIndex + 1) % secondPoints.length];
      best = Math.min(
        best,
        pointToSegmentDistanceForOracle(firstStart, secondStart, secondEnd),
        pointToSegmentDistanceForOracle(firstEnd, secondStart, secondEnd),
        pointToSegmentDistanceForOracle(secondStart, firstStart, firstEnd),
        pointToSegmentDistanceForOracle(secondEnd, firstStart, firstEnd),
      );
    }
  }
  return best;
}

function adaptiveFlattenPointBoundaryDistance(target: ShapeElement | TextElement, point: { x: number; y: number }): number {
  const points = adaptiveBoundaryPoints(target);
  return points.reduce((best, start, index) => Math.min(
    best,
    pointToSegmentDistanceForOracle(point, start, points[(index + 1) % points.length]),
  ), Number.POSITIVE_INFINITY);
}

describe("connector shape binding", () => {
  it("matches the shared object-level closest-boundary vectors", () => {
    for (const vector of objectBindingVectors.vectors) {
      const targets = vector.targets.map((target) => target.kind === "text"
        ? text({
          id: target.id,
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
          rotation: target.rotation,
        })
        : shape(target.shape as ShapeElement["shape"], {
          id: target.id,
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
          rotation: target.rotation,
          style: { ...style, roundness: target.roundness, strokeWidth: target.strokeWidth },
        }));
      const connector = {
        ...arrow(vector.start as ConnectorElement["start"], vector.end as ConnectorElement["end"]),
        id: vector.name,
        style: { ...style, strokeWidth: vector.connectorStrokeWidth, endArrowhead: "arrow" as const, startArrowhead: "none" as const },
      };
      const resolved = resolveConnectorPoints(connector, Object.fromEntries(targets.map((target) => [target.id, target])));
      if (!vector.expected) {
        expect(resolved, vector.name).toBeNull();
      } else {
        expect(resolved, vector.name).not.toBeNull();
        expect(resolved!.start.x, vector.name).toBeCloseTo(vector.expected.start.x, 8);
        expect(resolved!.start.y, vector.name).toBeCloseTo(vector.expected.start.y, 8);
        expect(resolved!.end.x, vector.name).toBeCloseTo(vector.expected.end.x, 8);
        expect(resolved!.end.y, vector.name).toBeCloseTo(vector.expected.end.y, 8);
      }
    }
  });

  it("matches an independent adaptive-flatten global boundary oracle", () => {
    const cases: readonly [ShapeElement | TextElement, ShapeElement | TextElement][] = [
      [
        shape("rectangle", { id: "rect", height: 20, width: 200, x: 0, y: 0, style: { ...style, roundness: 0.4, strokeWidth: 0 } }),
        text({ id: "angled-text", height: 20, rotation: 45, width: 60, x: 210, y: 30 }),
      ],
      [
        shape("ellipse", { id: "ellipse", height: 120, rotation: 23, width: 240, x: 10, y: 20, style: { ...style, strokeWidth: 0 } }),
        shape("diamond", { id: "diamond", height: 70, rotation: -31, width: 90, x: 260, y: 135, style: { ...style, strokeWidth: 0 } }),
      ],
      [
        shape("diamond", { id: "diamond-2", height: 60, rotation: 45, width: 80, x: 20, y: 20, style: { ...style, strokeWidth: 0 } }),
        text({ id: "text-2", height: 40, rotation: 45, width: 100, x: 210, y: 230 }),
      ],
    ];
    for (const [first, second] of cases) {
      const connector = {
        ...arrow(
          { kind: "element", targetElementId: first.id, gap: 0 },
          { kind: "element", targetElementId: second.id, gap: 0 },
        ),
        id: `${first.id}-${second.id}`,
        style: { ...style, strokeWidth: 0, endArrowhead: "arrow" as const, startArrowhead: "none" as const },
      };
      const resolved = resolveConnectorPoints(connector, { [first.id]: first, [second.id]: second });
      expect(resolved).not.toBeNull();
      const resolvedDistance = Math.hypot(
        resolved!.end.x - resolved!.start.x,
        resolved!.end.y - resolved!.start.y,
      );
      const oracleDistance = adaptiveFlattenOracleDistance(first, second);
      expect(adaptiveFlattenPointBoundaryDistance(first, resolved!.start), `${first.id} witness ${JSON.stringify(resolved!.start)}`).toBeLessThanOrEqual(2e-5);
      expect(adaptiveFlattenPointBoundaryDistance(second, resolved!.end), `${second.id} witness ${JSON.stringify(resolved!.end)}`).toBeLessThanOrEqual(2e-5);
      expect(
        Math.abs(resolvedDistance - oracleDistance),
        `${first.id} to ${second.id}: GJK ${resolvedDistance}, oracle ${oracleDistance}`,
      ).toBeLessThanOrEqual(2e-5);
    }
  }, 15_000);

  it("beats the prior center-ray route on the non-concentric rotated-box counterexample", () => {
    const first = text({ id: "first", x: -3, y: -1, width: 6, height: 2, rotation: 0 });
    const second = text({ id: "second", x: 5, y: 2, width: 6, height: 2, rotation: 45 });
    const connector = {
      ...arrow(
        { kind: "element", targetElementId: first.id, gap: 0 },
        { kind: "element", targetElementId: second.id, gap: 0 },
      ),
      style: { ...style, strokeWidth: 0, endArrowhead: "arrow" as const, startArrowhead: "none" as const },
    };
    const points = resolveConnectorPoints(connector, { [first.id]: first, [second.id]: second })!;
    expect(Math.hypot(points.end.x - points.start.x, points.end.y - points.start.y)).toBeCloseTo(2.24919419, 7);
    expect(Math.hypot(points.end.x - points.start.x, points.end.y - points.start.y)).toBeLessThan(3.2793933);
  });

  it("keeps the rendered destination arrow polygon outside rotated visible target strokes", () => {
    const targets = [
      shape("ellipse", { id: "ellipse", x: 240, y: 40, width: 180, height: 90, rotation: 31, style: { ...style, strokeWidth: 8 } }),
      shape("diamond", { id: "diamond", x: 240, y: 180, width: 170, height: 110, rotation: -27, style: { ...style, strokeWidth: 5 } }),
      text({ id: "text", x: 250, y: 340, width: 190, height: 70, rotation: 23 }),
    ];
    for (const [index, target] of targets.entries()) {
      const connectorStrokeWidth = 6;
      const gap = index + 2;
      const connector = {
        ...arrow(
          { kind: "free", x: -80, y: target.y + target.height / 2 - 35 },
          { kind: "element", targetElementId: target.id, gap },
        ),
        id: `arrowhead-clearance-${target.id}`,
        style: { ...style, strokeWidth: connectorStrokeWidth, endArrowhead: "arrow" as const, startArrowhead: "none" as const },
      };
      const points = resolveConnectorPoints(connector, { [target.id]: target })!;
      const length = Math.hypot(points.end.x - points.start.x, points.end.y - points.start.y);
      const direction = {
        x: (points.end.x - points.start.x) / length,
        y: (points.end.y - points.start.y) / length,
      };
      const outward = { x: -direction.x, y: -direction.y };
      const targetStrokeWidth = target.type === "shape" ? target.style.strokeWidth : 0;
      const clearance = gap + targetStrokeWidth / 2 + connectorStrokeWidth / 2;
      const cleanDestination = {
        x: points.end.x - outward.x * clearance,
        y: points.end.y - outward.y * clearance,
      };
      const polygon = arrowheadPoints(points.start, points.end)!;
      for (const [x, y] of polygon) {
        const outwardProjection = (x - cleanDestination.x) * outward.x + (y - cleanDestination.y) * outward.y;
        expect(outwardProjection - connectorStrokeWidth / 2, target.id).toBeGreaterThanOrEqual(
          gap + targetStrokeWidth / 2 - 1e-8,
        );
      }
    }
  });

  it("reroutes immutable bindings after move, resize, rotation, and text reflow", () => {
    const source = shape("rectangle", { id: "source", x: 20, y: 40, width: 130, height: 80 });
    const destination = text({ id: "destination", x: 310, y: 90, width: 150, height: 48 });
    const connector = arrow(
      { kind: "element", targetElementId: source.id, gap: 2 },
      { kind: "element", targetElementId: destination.id, gap: 3 },
    );
    const states = [
      [source, destination],
      [{ ...source, x: source.x + 35 }, destination],
      [{ ...source, width: source.width + 70, height: source.height + 25 }, destination],
      [source, { ...destination, rotation: 37 }],
      [source, { ...destination, width: 105, height: 92 }],
    ] as const;
    const routes = states.map(([nextSource, nextDestination]) => resolveConnectorPoints(connector, {
      [nextSource.id]: nextSource,
      [nextDestination.id]: nextDestination,
    }));
    expect(routes.every(Boolean)).toBe(true);
    for (let index = 1; index < routes.length; index += 1) expect(routes[index]).not.toEqual(routes[0]);
    expect(connector.start).toEqual({ kind: "element", targetElementId: source.id, gap: 2 });
    expect(connector.end).toEqual({ kind: "element", targetElementId: destination.id, gap: 3 });
  });

  it("keeps rounded rectangle and diamond supports consistent with their authored convex paths", () => {
    for (const target of [
      shape("rectangle", { width: 173, height: 91, style: { ...style, roundness: 0.73 } }),
      shape("diamond", { width: 147, height: 83 }),
    ]) {
      const flattened = flattenShapeBoundary(target.shape, target.width, target.height, target.style.roundness, 1e-5);
      const crosses = flattened.map((point, index) => {
        const next = flattened[(index + 1) % flattened.length];
        const after = flattened[(index + 2) % flattened.length];
        return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
      });
      expect(crosses.every((value) => value >= -2e-5) || crosses.every((value) => value <= 2e-5)).toBe(true);
      for (let index = 0; index < 72; index += 1) {
        const angle = index * Math.PI * 2 / 72;
        const direction = { x: Math.cos(angle), y: Math.sin(angle) };
        const support = getShapeSupportPoint(target.shape, target.width, target.height, target.style.roundness, direction)!;
        const supportProjection = support.x * direction.x + support.y * direction.y;
        const flattenedProjection = Math.max(...flattened.map((point) => point.x * direction.x + point.y * direction.y));
        expect(supportProjection).toBeGreaterThanOrEqual(flattenedProjection - 2e-5);
        expect(supportProjection - flattenedProjection).toBeLessThanOrEqual(2e-5);
      }
    }
  });

  it("dedupes candidate announcements by target and binding state", () => {
    const target = shape("rectangle");
    const first = getConnectorAuthoringCandidate({ x: 110, y: 20 }, [target], 1);
    const second = getConnectorAuthoringCandidate({ x: 110, y: 23 }, [target], 1);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(getConnectorCandidateAnnouncementKey(first)).toBe(getConnectorCandidateAnnouncementKey(second));
    expect(getConnectorCandidateAnnouncement(first)).toContain("nearest facing visible boundary");
  });

  it("matches the shared persisted boundary vectors", () => {
    for (const vector of boundaryVectors.vectors) {
      const target = vector.kind === "text"
        ? text({
          id: vector.name,
          x: vector.x,
          y: vector.y,
          width: vector.width,
          height: vector.height,
          rotation: vector.rotation,
        })
        : shape(vector.shape as ShapeElement["shape"], {
          id: vector.name,
          x: vector.x,
          y: vector.y,
          width: vector.width,
          height: vector.height,
          rotation: vector.rotation,
          style: { ...style, roundness: vector.roundness },
        });
      const endpoint = { kind: "element" as const, targetElementId: target.id, anchor: { t: vector.t }, gap: vector.gap };
      const resolved = resolveConnectorEndpoint(endpoint, { [target.id]: target });
      if (!vector.accepted) {
        expect(Math.abs(vector.expected.x)).toBeGreaterThan(MAX_CANVAS_VALUE);
        expect(resolved, vector.name).toBeNull();
        continue;
      }
      expect(resolved, vector.name).not.toBeNull();
      expect(resolved!.x, vector.name).toBeCloseTo(vector.expected.x, 9);
      expect(resolved!.y, vector.name).toBeCloseTo(vector.expected.y, 9);
    }
  });

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

  it("canonicalizes authored seam anchors while continuing to resolve legacy t=1", () => {
    const rectangle = shape("rectangle", { style: { ...style, roundness: 0.5 } });
    const authored = getNearestBindableBoundaryAnchor(rectangle, { x: 60, y: 20 });
    expect(authored?.anchor.t).toBe(0);
    expect(Object.is(authored?.anchor.t, -0)).toBe(false);
    expect(resolveConnectorEndpoint(
      { kind: "element", targetElementId: rectangle.id, anchor: { t: 1 }, gap: 0 },
      { [rectangle.id]: rectangle },
    )).toEqual(resolveConnectorEndpoint(
      { kind: "element", targetElementId: rectangle.id, anchor: { t: 0 }, gap: 0 },
      { [rectangle.id]: rectangle },
    ));
  });

  it("binds a whole rounded, rotated object without exposing a perimeter control", () => {
    const target = shape("rectangle", {
      height: 140,
      rotation: 31,
      style: { ...style, roundness: 0.18 },
      width: 240,
      x: 420,
      y: 240,
    });
    const exactPoint = getShapeAnchorPoint(target, { t: 0.18 });
    expect(exactPoint).not.toBeNull();
    const candidate = getConnectorAuthoringCandidate(exactPoint!, [target], 1);
    expect(candidate).toMatchObject({
      endpoint: { kind: "element", targetElementId: target.id },
      target: { id: target.id },
    });
    expect(candidate).not.toHaveProperty("activeAnchor");
    expect(candidate).not.toHaveProperty("anchors");
  });

  it("reveals and snaps one authoring target using screen-space radii", () => {
    const rectangle = shape("rectangle");
    expect(getConnectorAuthoringCandidate({ x: 130, y: 50 }, [rectangle], 1)).toMatchObject({
      endpoint: { kind: "free", x: 130, y: 50 },
      target: { id: rectangle.id },
    });
    expect(getConnectorAuthoringCandidate({ x: 128, y: 50 }, [rectangle], 1)).toMatchObject({
      endpoint: { kind: "element", targetElementId: rectangle.id, gap: 0 },
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
    expect(getConnectorAuthoringCandidate({ x: 300, y: 300 }, [low], 1, "low")?.endpoint).toEqual({
      kind: "element",
      targetElementId: "low",
      gap: 0,
    });
  });

  it("broad-phases large proximity candidate sets while preserving deep direct hover", () => {
    const distant = Array.from({ length: 500 }, (_, index) => shape("ellipse", {
      id: `distant-${index}`,
      x: 10_000 + index * 300,
      y: 10_000,
    }));
    expect(getNearbyBindableTargets({ x: 0, y: 0 }, distant, CONNECTOR_BINDING_REVEAL_RADIUS_PX)).toEqual([]);
    expect(getConnectorAuthoringCandidate({ x: 0, y: 0 }, distant, 1)).toBeNull();
    expect(snapConnectorEndpoint({ x: 0, y: 0 }, distant, 1, true)).toEqual({ kind: "free", x: 0, y: 0 });
    const direct = shape("rectangle", { id: "deep-direct", width: 400, height: 300, x: 5_000, y: 5_000 });
    expect(getNearbyBindableTargets({ x: 0, y: 0 }, [direct], CONNECTOR_BINDING_REVEAL_RADIUS_PX)).toEqual([]);
    expect(getConnectorAuthoringCandidate({ x: 0, y: 0 }, [direct], 1, direct.id)?.target.id).toBe(direct.id);
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

  it("uses the logical rotated perimeter and applies gap outside the shape", () => {
    const rotated = shape("ellipse", { rotation: 90 });
    expect(getShapeAnchorPoint(rotated, { t: 0 })).toEqual({ x: 90, y: 50 });
    expect(getShapeAnchorPoint(rotated, { t: 0 }, 4)).toEqual({ x: 94, y: 50 });
    expect(getShapeAnchorPoint(shape("diamond", { rotation: 90 }), { t: 0.25 })).toEqual({ x: 60, y: 97.9420169782899 });
  });

  it("snaps only within a fixed screen-pixel radius and to compatible shapes or text", () => {
    const rectangle = shape("rectangle");
    const nearAt200 = snapConnectorEndpoint({ x: 118, y: 50 }, [rectangle], 2, true);
    expect(nearAt200).toEqual({ kind: "element", targetElementId: rectangle.id, gap: 0 });
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
    const beforeDelete = resolveConnectorPoints(connector, { [target.id]: target })!;
    const [, detached] = detachConnectorEndpointsForDeletedTargets([target, connector], new Set([target.id]));
    expect(detached).toMatchObject({ start: { kind: "free", ...beforeDelete.start } });
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
    const points = resolveConnectorPoints(connector, elementsById)!;
    expect(points).toEqual({ start: { x: 114, y: 50 }, end: { x: 190, y: 50 } });
    expect(getSelectionElementBounds(connector, elementsById)).toEqual({ x: 113, y: 49, width: 78, height: 2 });
    expect(getElementBounds(connector, elementsById)).toEqual({ x: 113, y: 49, width: 78, height: 2 });
    expect(canvasElementContainsPoint(connector, { x: 150, y: 50 }, 0, elementsById)).toBe(true);
  });

  it("suppresses an overlapping route and restores it after either target moves apart", () => {
    const first = shape("rectangle", { id: "first", x: 10, y: 20 });
    const overlapping = shape("ellipse", { id: "second", x: 40, y: 30 });
    const connector = arrow(
      { kind: "element", targetElementId: first.id, gap: 0 },
      { kind: "element", targetElementId: overlapping.id, gap: 0 },
    );
    expect(resolveConnectorPoints(connector, { [first.id]: first, [overlapping.id]: overlapping })).toBeNull();
    expect(getSelectionElementBounds(connector, { [first.id]: first, [overlapping.id]: overlapping })).toBeNull();

    const moved = { ...overlapping, x: 260 };
    const elementsById = { [first.id]: first, [moved.id]: moved };
    const restored = resolveConnectorPoints(connector, elementsById);
    expect(restored).not.toBeNull();
    expect(getSelectionElementBounds(connector, elementsById)).not.toBeNull();
    expect(canvasElementContainsPoint(connector, {
      x: (restored!.start.x + restored!.end.x) / 2,
      y: (restored!.start.y + restored!.end.y) / 2,
    }, 0, elementsById)).toBe(true);
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
    const beforeDelete = resolveConnectorPoints(connector, { [rectangle.id]: rectangle })!;
    const detached = detachConnectorEndpointsForDeletedTargets([rectangle, connector], new Set([rectangle.id]));
    expect(detached[1]).toMatchObject({ start: { kind: "free", ...beforeDelete.start } });
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
    const beforeDelete = resolveConnectorPoints(connector, { [edge.id]: edge })!;
    const [, detached] = detachConnectorEndpointsForDeletedTargets([edge, connector], new Set([edge.id]));
    expect(detached).toMatchObject({ start: { kind: "free", ...beforeDelete.start } });
  });
});
