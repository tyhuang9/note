import type {
  CanvasElement,
  ConnectorElement,
  ConnectorEndpoint,
  ElementId,
  PerimeterAnchor,
  ShapeElement,
  TextElement,
} from "./elements";
import type { CanvasPoint } from "./geometry";
import {
  getShapeBoundaryPoint,
  getShapeSupportPoint,
  projectPointToShapeBoundary,
} from "./shapeBoundary";

/** The screen-space capture radius stays constant as the canvas zooms. */
export const CONNECTOR_BINDING_SNAP_RADIUS_PX = 18;
/** A nearby compatible target reveals its anchors before endpoint snapping begins. */
export const CONNECTOR_BINDING_REVEAL_RADIUS_PX = 28;
/** Mirrors the persistence boundary limit in the Rust repository. */
export const MAX_CANVAS_VALUE = 1_000_000;
export const MAX_CANVAS_ROTATION_DEGREES = 360;
const DEFAULT_KEYBOARD_ARROW_LENGTH = 160;
export const CONNECTOR_ARROWHEAD_LENGTH = 12;
export const CONNECTOR_ARROWHEAD_HALF_WIDTH = 5;

export type ShapeAnchorName = "top" | "right" | "bottom" | "left";

export type ShapeBindingAnchor = Readonly<{
  anchor: PerimeterAnchor;
  name: ShapeAnchorName | "perimeter";
  point: CanvasPoint;
}>;

/**
 * `t` is a clockwise angular fraction around a shape, beginning at its top.
 * This keeps the four persisted cardinal anchors meaningful for every shape
 * family and after a shape is rotated.
 */
const CARDINAL_ANCHORS: readonly Readonly<{ name: ShapeAnchorName; t: number }>[] = [
  { name: "top", t: 0 },
  { name: "right", t: 0.25 },
  { name: "bottom", t: 0.5 },
  { name: "left", t: 0.75 },
];

export type BindableElement = ShapeElement | TextElement;

export type ConnectorAuthoringCandidate = Readonly<{
  activeAnchor: ShapeBindingAnchor;
  anchors: readonly ShapeBindingAnchor[];
  endpoint: ConnectorEndpoint;
  target: BindableElement;
}>;

/** Converts a perimeter fraction to the spoken integer degree, with the seam at 0°. */
export function getConnectorBoundaryDegrees(anchorT: number): number {
  if (!Number.isFinite(anchorT)) return 0;
  const rounded = Math.round(anchorT * 360);
  return ((rounded % 360) + 360) % 360;
}

/** Stable key and wording shared by arrow authoring and endpoint retargeting. */
export function getConnectorCandidateAnnouncementKey(candidate: ConnectorAuthoringCandidate | null): string | null {
  return candidate
    ? `${candidate.target.id}:${candidate.endpoint.kind === "element" ? "snapped" : "near"}`
    : null;
}

export function getConnectorCandidateAnnouncement(
  candidate: ConnectorAuthoringCandidate | null,
  targetLabel: string | null = null,
): string {
  if (!candidate) return "No binding target. Endpoint will remain free.";
  const label = targetLabel ?? candidate.target.id;
  return candidate.endpoint.kind === "element"
    ? `Snapped to ${label}. The connector will follow its nearest visible boundary.`
    : `Near ${label}; move closer to bind the whole object.`;
}

export function isBindableShape(element: CanvasElement | undefined): element is ShapeElement {
  return element?.type === "shape" && (
    element.shape === "rectangle" || element.shape === "ellipse" || element.shape === "diamond"
  ) && hasSafeShapeGeometry(element);
}

/** Shapes and text blocks have an explicit model rectangle and may host arrows. */
export function isBindableElement(element: CanvasElement | undefined): element is BindableElement {
  return isBindableShape(element) || (element?.type === "text" && hasSafeBoxGeometry(element));
}

export function isSafeCanvasCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_CANVAS_VALUE;
}

export function isSafeCanvasDimension(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_CANVAS_VALUE;
}

export function isSafeCanvasRotation(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_CANVAS_ROTATION_DEGREES;
}

/** Clamps finite free endpoints to the persistence boundary and rejects non-finite input. */
export function normalizeFreeConnectorEndpoint(
  point: CanvasPoint,
): Extract<ConnectorEndpoint, { kind: "free" }> | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return {
    kind: "free",
    x: clampCanvasCoordinate(point.x),
    y: clampCanvasCoordinate(point.y),
  };
}

/** Creates a visible horizontal keyboard-authored arrow centered in the current viewport. */
export function getDefaultKeyboardArrowEndpoints(
  viewport: Readonly<{ x: number; y: number; width: number; height: number }>,
): Readonly<{
  start: Extract<ConnectorEndpoint, { kind: "free" }>;
  end: Extract<ConnectorEndpoint, { kind: "free" }>;
}> | null {
  if (
    !Number.isFinite(viewport.width)
    || !Number.isFinite(viewport.height)
    || viewport.width <= 0
    || viewport.height <= 0
  ) return null;
  const center = {
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
  };
  if (!isSafeCanvasCoordinate(center.x) || !isSafeCanvasCoordinate(center.y)) return null;
  const length = Math.min(DEFAULT_KEYBOARD_ARROW_LENGTH, viewport.width / 2);
  const start = normalizeFreeConnectorEndpoint({ x: center.x - length / 2, y: center.y });
  const end = normalizeFreeConnectorEndpoint({ x: center.x + length / 2, y: center.y });
  return start && end && Math.hypot(end.x - start.x, end.y - start.y) >= 0.01
    ? { start, end }
    : null;
}

/** Resolves any compatible endpoint to its current world point. */
export function resolveConnectorEndpoint(
  endpoint: ConnectorEndpoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  sourcePageId?: string,
): CanvasPoint | null {
  if (endpoint.kind === "free") {
    return isSafeCanvasCoordinate(endpoint.x) && isSafeCanvasCoordinate(endpoint.y) ? endpoint : null;
  }
  if (endpoint.kind !== "element") return null;
  const target = elementsById[endpoint.targetElementId];
  if (!isBindableElement(target) || !endpoint.anchor || !isValidPerimeterAnchor(endpoint.anchor) || !isSafeGap(endpoint.gap)) {
    return null;
  }
  if (sourcePageId && target.pageId !== sourcePageId) return null;
  const point = getBindableAnchorPoint(target, endpoint.anchor, endpoint.gap);
  return point && isSafeResolvedPoint(point) ? point : null;
}

export function resolveConnectorPoints(
  connector: ConnectorElement,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): Readonly<{ start: CanvasPoint; end: CanvasPoint }> | null {
  const startReference = getEndpointReferencePoint(connector.start, elementsById, connector.pageId);
  const endReference = getEndpointReferencePoint(connector.end, elementsById, connector.pageId);
  if (!startReference || !endReference) return null;

  if (
    connector.start.kind === "element"
    && connector.end.kind === "element"
    && connector.start.targetElementId === connector.end.targetElementId
  ) {
    if (!connector.start.anchor || !connector.end.anchor) return null;
    const start = resolveConnectorEndpoint(connector.start, elementsById, connector.pageId);
    const end = resolveConnectorEndpoint(connector.end, elementsById, connector.pageId);
    return start && end ? { start, end } : null;
  }
  if (areCoincidentCanonicalBindings(connector.start, connector.end, elementsById)) return null;

  const fallbackDirection = deterministicCoincidentDirection(connector);
  const closest = getClosestEndpointBoundaryPair(
    connector.start,
    connector.end,
    elementsById,
    connector.pageId,
    normalizedDirection(startReference, endReference, fallbackDirection),
  );
  if (!closest || closest.kind === "overlap") return null;
  const cleanStart = closest.start;
  const cleanEnd = closest.end;
  const direction = normalizedDirection(cleanStart, cleanEnd, fallbackDirection);
  const start = applyEndpointClearance(connector.start, cleanStart, direction, connector.style.strokeWidth, elementsById);
  const end = applyEndpointClearance(connector.end, cleanEnd, { x: -direction.x, y: -direction.y }, connector.style.strokeWidth, elementsById);
  return start && end ? { start, end } : null;
}

function areCoincidentCanonicalBindings(
  start: ConnectorEndpoint,
  end: ConnectorEndpoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): boolean {
  if (start.kind !== "element" || end.kind !== "element" || start.anchor || end.anchor) return false;
  const first = elementsById[start.targetElementId];
  const second = elementsById[end.targetElementId];
  if (!isBindableElement(first) || !isBindableElement(second)) return false;
  return first.type === second.type
    && first.x === second.x
    && first.y === second.y
    && first.width === second.width
    && first.height === second.height
    && first.rotation === second.rotation
    && (first.type === "text" || second.type === "text" || (
      first.shape === second.shape
      && first.style.roundness === second.style.roundness
    ));
}

/** Returns the four visible/persisted binding positions for a compatible shape. */
export function getShapeBindingAnchors(shape: ShapeElement): readonly ShapeBindingAnchor[] {
  return getBindableBindingAnchors(shape);
}

/** Shared shape/text anchor list so snapping, overlays, and chooser agree. */
export function getBindableBindingAnchors(target: BindableElement): readonly ShapeBindingAnchor[] {
  if (!hasSafeBoxGeometry(target)) return [];
  return CARDINAL_ANCHORS.flatMap(({ name, t }) => {
    const point = getBindableAnchorPoint(target, { t });
    return point ? [{ anchor: { t }, name, point }] : [];
  });
}

export function getBindableAnchorPoint(
  target: BindableElement,
  anchor: PerimeterAnchor,
  gap = 0,
): CanvasPoint | null {
  return target.type === "shape"
    ? getShapeAnchorPoint(target, anchor, gap)
    : getTextAnchorPoint(target, anchor, gap);
}

/**
 * Projects a world point onto the nearest logical boundary and returns the
 * persisted angular anchor that the existing resolver maps back to that point.
 * The calculation deliberately ignores rendered RoughJS padding.
 */
export function getNearestBindableBoundaryAnchor(
  target: BindableElement,
  point: CanvasPoint,
): ShapeBindingAnchor | null {
  if (!hasSafeBoxGeometry(target) || !isSafeResolvedPoint(point)) return null;
  const local = unrotatePoint(point, target);
  const width = Math.max(0, target.width);
  const height = Math.max(0, target.height);
  const center = { x: target.x + width / 2, y: target.y + height / 2 };
  const localPoint = target.type === "shape"
    ? projectPointToShapeBoundary(target.shape, width, height, target.style.roundness, {
      x: local.x - target.x, y: local.y - target.y,
    })
    : closestRectanglePoint(local, center, width / 2, height / 2);
  if (!localPoint) return null;

  const t = canonicalAnchorT(target.type === "shape" && target.shape === "ellipse"
    ? Math.atan2(
      localPoint.x - width / 2,
      -(localPoint.y - height / 2) * (width / Math.max(height, Number.EPSILON)),
    ) / (Math.PI * 2)
    : target.type === "shape"
      ? Math.atan2(localPoint.x - width / 2, height / 2 - localPoint.y) / (Math.PI * 2)
      : Math.atan2(localPoint.x - center.x, center.y - localPoint.y) / (Math.PI * 2));
  const anchor = { t };
  // Always use the production resolver for the returned world point, avoiding
  // any small differences between the inverse and persisted forward geometry.
  const resolved = getBindableAnchorPoint(target, anchor);
  if (!resolved) return null;
  return { anchor, name: anchorNameForT(t), point: resolved };
}

/**
 * Finds the rotated clean logical perimeter point for an anchor. It matches
 * the rounded shape path before RoughJS jitter and render padding are applied.
 */
export function getShapeAnchorPoint(
  shape: ShapeElement,
  anchor: PerimeterAnchor,
  gap = 0,
): CanvasPoint | null {
  if (!hasSafeShapeGeometry(shape) || !isSafeGap(gap)) return null;
  const width = Math.max(0, shape.width);
  const height = Math.max(0, shape.height);
  const center = { x: shape.x + width / 2, y: shape.y + height / 2 };
  const t = normalizeAnchorT(anchor.t);
  const radians = t * Math.PI * 2;
  const direction = { x: zeroSmall(Math.sin(radians)), y: zeroSmall(-Math.cos(radians)) };
  const localBoundary = getShapeBoundaryPoint(shape.shape, width, height, shape.style.roundness, t);
  if (!localBoundary) return null;
  const local = { x: localBoundary.x - width / 2, y: localBoundary.y - height / 2 };
  const rotatedDirection = rotateVector(direction, shape.rotation);
  const rotatedLocal = rotateVector(local, shape.rotation);
  const safeGap = gap;
  const point = {
    x: cleanCoordinate(center.x + rotatedLocal.x + rotatedDirection.x * safeGap),
    y: cleanCoordinate(center.y + rotatedLocal.y + rotatedDirection.y * safeGap),
  };
  return isSafeResolvedPoint(point) ? point : null;
}

/** Text binds to its rotated model rectangle, not its rendered surface padding. */
export function getTextAnchorPoint(
  text: TextElement,
  anchor: PerimeterAnchor,
  gap = 0,
): CanvasPoint | null {
  if (!hasSafeBoxGeometry(text) || !isSafeGap(gap)) return null;
  const center = { x: text.x + text.width / 2, y: text.y + text.height / 2 };
  const t = normalizeAnchorT(anchor.t);
  const direction = { x: zeroSmall(Math.sin(t * Math.PI * 2)), y: zeroSmall(-Math.cos(t * Math.PI * 2)) };
  const distance = Math.min(
    direction.x === 0 ? Number.POSITIVE_INFINITY : text.width / 2 / Math.abs(direction.x),
    direction.y === 0 ? Number.POSITIVE_INFINITY : text.height / 2 / Math.abs(direction.y),
  );
  const rotatedDirection = rotateVector(direction, text.rotation);
  const local = rotateVector({ x: direction.x * distance, y: direction.y * distance }, text.rotation);
  const point = { x: center.x + local.x + rotatedDirection.x * gap, y: center.y + local.y + rotatedDirection.y * gap };
  return isSafeResolvedPoint(point) ? point : null;
}

/** Snaps only arrow endpoints; callers pass `allowBinding` false for lines. */
export function snapConnectorEndpoint(
  point: CanvasPoint,
  elements: readonly CanvasElement[],
  zoom: number,
  allowBinding: boolean,
  radiusPx = CONNECTOR_BINDING_SNAP_RADIUS_PX,
): ConnectorEndpoint {
  if (!isSafeResolvedPoint(point)) {
    return normalizeFreeConnectorEndpoint(point) ?? { kind: "free", x: 0, y: 0 };
  }
  if (!allowBinding) {
    return { kind: "free", ...point };
  }
  const worldRadius = radiusPx / Math.max(zoom, Number.EPSILON);
  let closest: Readonly<{ elementId: ElementId; distance: number; index: number; zIndex: number }> | null = null;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!isBindableElement(element)) continue;
    if (!isPointNearBindableBounds(point, element, worldRadius)) continue;
    const candidate = getNearestBindableBoundaryAnchor(element, point);
    if (!candidate) continue;
    const distance = Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y);
    if (distance <= worldRadius && (!closest || distance < closest.distance || (
      distance === closest.distance && (element.zIndex > closest.zIndex || (
        element.zIndex === closest.zIndex && index < closest.index
      ))
    ))) {
      closest = { distance, elementId: element.id, index, zIndex: element.zIndex };
    }
  }
  return closest
    ? { kind: "element", targetElementId: closest.elementId, gap: 0 }
    : { kind: "free", ...point };
}

/**
 * Resolves the one target shown while an arrow endpoint is being authored.
 * A directly hovered compatible target wins. Proximity candidates are ordered
 * deterministically by nearest anchor, then visual stacking, then source order.
 */
export function getConnectorAuthoringCandidate(
  point: CanvasPoint,
  elements: readonly CanvasElement[],
  zoom: number,
  directHoveredElementId?: ElementId | null,
): ConnectorAuthoringCandidate | null {
  if (!isSafeResolvedPoint(point)) return null;
  const safeZoom = Math.max(Number.EPSILON, Number.isFinite(zoom) ? zoom : 1);
  const directTarget = directHoveredElementId
    ? elements.find((element) => element.id === directHoveredElementId)
    : undefined;
  if (isBindableElement(directTarget)) {
    return buildAuthoringCandidate(point, directTarget, safeZoom);
  }

  let closest: Readonly<{
    candidate: ConnectorAuthoringCandidate;
    distancePx: number;
    index: number;
  }> | null = null;
  for (const { element, index } of getNearbyBindableTargets(
    point,
    elements,
    CONNECTOR_BINDING_REVEAL_RADIUS_PX / safeZoom,
  )) {
    const candidate = buildAuthoringCandidate(point, element, safeZoom);
    if (!candidate) continue;
    const distancePx = pointDistance(point, candidate.activeAnchor.point) * safeZoom;
    if (distancePx > CONNECTOR_BINDING_REVEAL_RADIUS_PX) continue;
    if (
      !closest
      || distancePx < closest.distancePx
      || (distancePx === closest.distancePx && element.zIndex > closest.candidate.target.zIndex)
      || (
        distancePx === closest.distancePx
        && element.zIndex === closest.candidate.target.zIndex
        && index < closest.index
      )
    ) {
      closest = { candidate, distancePx, index };
    }
  }
  return closest?.candidate ?? null;
}

/** Snaps a free endpoint to 45-degree increments around the armed start. */
export function snapConnectorPointToAngle(start: CanvasPoint, point: CanvasPoint): CanvasPoint {
  if (!isSafeResolvedPoint(start) || !isSafeResolvedPoint(point)) return point;
  const delta = { x: point.x - start.x, y: point.y - start.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length === 0) return point;
  const snappedAngle = Math.round(Math.atan2(delta.y, delta.x) / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: zeroSmall(start.x + Math.cos(snappedAngle) * length),
    y: zeroSmall(start.y + Math.sin(snappedAngle) * length),
  };
}

/**
 * Converts only endpoints whose live target is being removed. The caller uses
 * this before filtering targets so the final free coordinate is exact and the
 * entire delete remains one history/persistence transaction.
 */
export function detachConnectorEndpointsForDeletedTargets(
  elements: readonly CanvasElement[],
  deletedIds: ReadonlySet<ElementId>,
): CanvasElement[] {
  const elementsById = Object.fromEntries(elements.map((element) => [element.id, element]));
  const detach = (endpoint: ConnectorEndpoint, sourcePageId: string): ConnectorEndpoint => {
    if (endpoint.kind !== "element" || !deletedIds.has(endpoint.targetElementId)) return endpoint;
    const resolved = resolveConnectorEndpoint(endpoint, elementsById, sourcePageId);
    return resolved ? { kind: "free", ...resolved } : endpoint;
  };
  return elements.map((element) => {
    if (element.type !== "connector" || deletedIds.has(element.id)) return element;
    const start = detach(element.start, element.pageId);
    const end = detach(element.end, element.pageId);
    return start === element.start && end === element.end
      ? element
      : { ...element, start, end, updatedAt: Date.now() };
  });
}

type SupportVertex = Readonly<{
  difference: CanvasPoint;
  start: CanvasPoint;
  end: CanvasPoint;
}>;

type ClosestSimplex = Readonly<{
  closest: CanvasPoint;
  overlap: boolean;
  simplex: readonly SupportVertex[];
  weights: readonly number[];
}>;

/** Exact convex support/GJK distance; center rays are used only for zero-distance degeneracies. */
function getClosestEndpointBoundaryPair(
  start: ConnectorEndpoint,
  end: ConnectorEndpoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  sourcePageId: string,
  initialDirection: CanvasPoint,
): Readonly<{ kind: "overlap" } | { kind: "separated"; start: CanvasPoint; end: CanvasPoint }> | null {
  const support = (direction: CanvasPoint): SupportVertex | null => {
    const startPoint = getEndpointSupportPoint(start, direction, elementsById, sourcePageId);
    const endPoint = getEndpointSupportPoint(end, { x: -direction.x, y: -direction.y }, elementsById, sourcePageId);
    return startPoint && endPoint ? {
      difference: { x: startPoint.x - endPoint.x, y: startPoint.y - endPoint.y },
      start: startPoint,
      end: endPoint,
    } : null;
  };
  const first = support(initialDirection);
  if (!first) return null;
  let state = closestSimplexToOrigin([first]);
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const distanceSquared = dotPoint(state.closest, state.closest);
    if (state.overlap || distanceSquared <= 1e-20) return { kind: "overlap" };
    const direction = { x: -state.closest.x, y: -state.closest.y };
    const next = support(direction);
    if (!next) return null;
    const improvement = distanceSquared - dotPoint(state.closest, next.difference);
    if (improvement <= 1e-12 * Math.max(1, distanceSquared)) {
      const witnesses = witnessPoints(state);
      return witnesses ? { kind: "separated", ...witnesses } : null;
    }
    if (state.simplex.some((vertex) => pointDistance(vertex.difference, next.difference) <= 1e-12)) return null;
    state = closestSimplexToOrigin([...state.simplex, next]);
  }
  const witnesses = witnessPoints(state);
  return witnesses ? { kind: "separated", ...witnesses } : null;
}

function getEndpointSupportPoint(
  endpoint: ConnectorEndpoint,
  direction: CanvasPoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  sourcePageId: string,
): CanvasPoint | null {
  if (endpoint.kind === "free") return isSafeResolvedPoint(endpoint) ? endpoint : null;
  if (endpoint.kind !== "element" || !isSafeGap(endpoint.gap)) return null;
  const target = elementsById[endpoint.targetElementId];
  if (!isBindableElement(target) || target.pageId !== sourcePageId) return null;
  const localDirection = rotateVector(direction, -target.rotation);
  const local = target.type === "shape"
    ? getShapeSupportPoint(target.shape, target.width, target.height, target.style.roundness, localDirection)
    : getRectangleSupportPoint(target.width, target.height, localDirection);
  if (!local) return null;
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const rotated = rotateVector({ x: local.x - target.width / 2, y: local.y - target.height / 2 }, target.rotation);
  const point = { x: center.x + rotated.x, y: center.y + rotated.y };
  return isSafeResolvedPoint(point) ? point : null;
}

function getRectangleSupportPoint(width: number, height: number, direction: CanvasPoint): CanvasPoint {
  return {
    x: direction.x >= 0 ? width : 0,
    y: direction.y >= 0 ? height : 0,
  };
}

function closestSimplexToOrigin(simplex: readonly SupportVertex[]): ClosestSimplex {
  if (simplex.length === 1) {
    return { closest: simplex[0].difference, overlap: false, simplex, weights: [1] };
  }
  if (simplex.length === 2) return closestSegmentSimplex(simplex[0], simplex[1]);
  const triangle = simplex.slice(-3);
  if (originInsideTriangle(triangle[0].difference, triangle[1].difference, triangle[2].difference)) {
    return { closest: { x: 0, y: 0 }, overlap: true, simplex: triangle, weights: [0, 0, 0] };
  }
  const edges = [
    closestSegmentSimplex(triangle[0], triangle[1]),
    closestSegmentSimplex(triangle[1], triangle[2]),
    closestSegmentSimplex(triangle[2], triangle[0]),
  ];
  return edges.reduce((best, candidate) =>
    dotPoint(candidate.closest, candidate.closest) < dotPoint(best.closest, best.closest) - 1e-16 ? candidate : best,
  );
}

function closestSegmentSimplex(first: SupportVertex, second: SupportVertex): ClosestSimplex {
  const edge = {
    x: second.difference.x - first.difference.x,
    y: second.difference.y - first.difference.y,
  };
  const size = dotPoint(edge, edge);
  const ratio = size <= 1e-24
    ? 0
    : Math.max(0, Math.min(1, -dotPoint(first.difference, edge) / size));
  if (ratio <= 1e-14) return { closest: first.difference, overlap: false, simplex: [first], weights: [1] };
  if (ratio >= 1 - 1e-14) return { closest: second.difference, overlap: false, simplex: [second], weights: [1] };
  return {
    closest: {
      x: first.difference.x + edge.x * ratio,
      y: first.difference.y + edge.y * ratio,
    },
    overlap: false,
    simplex: [first, second],
    weights: [1 - ratio, ratio],
  };
}

function originInsideTriangle(first: CanvasPoint, second: CanvasPoint, third: CanvasPoint): boolean {
  const firstCross = crossPoint(
    { x: second.x - first.x, y: second.y - first.y },
    { x: -first.x, y: -first.y },
  );
  const secondCross = crossPoint(
    { x: third.x - second.x, y: third.y - second.y },
    { x: -second.x, y: -second.y },
  );
  const thirdCross = crossPoint(
    { x: first.x - third.x, y: first.y - third.y },
    { x: -third.x, y: -third.y },
  );
  return (firstCross >= -1e-12 && secondCross >= -1e-12 && thirdCross >= -1e-12)
    || (firstCross <= 1e-12 && secondCross <= 1e-12 && thirdCross <= 1e-12);
}

function witnessPoints(state: ClosestSimplex): Readonly<{ start: CanvasPoint; end: CanvasPoint }> | null {
  if (state.overlap || state.simplex.length !== state.weights.length) return null;
  const result = state.simplex.reduce((points, vertex, index) => ({
    start: {
      x: points.start.x + vertex.start.x * state.weights[index],
      y: points.start.y + vertex.start.y * state.weights[index],
    },
    end: {
      x: points.end.x + vertex.end.x * state.weights[index],
      y: points.end.y + vertex.end.y * state.weights[index],
    },
  }), { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } });
  return isSafeResolvedPoint(result.start) && isSafeResolvedPoint(result.end) ? result : null;
}

function applyEndpointClearance(
  endpoint: ConnectorEndpoint,
  point: CanvasPoint,
  outwardDirection: CanvasPoint,
  connectorStrokeWidth: number,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): CanvasPoint | null {
  if (endpoint.kind === "free") return point;
  if (endpoint.kind !== "element") return null;
  const target = elementsById[endpoint.targetElementId];
  if (!isBindableElement(target) || !isSafeGap(endpoint.gap)) return null;
  const targetStrokeWidth = target.type === "shape" ? target.style.strokeWidth : 0;
  const clearance = endpoint.gap + targetStrokeWidth / 2 + Math.max(0, connectorStrokeWidth) / 2;
  const cleared = {
    x: cleanCoordinate(point.x + outwardDirection.x * clearance),
    y: cleanCoordinate(point.y + outwardDirection.y * clearance),
  };
  return isSafeResolvedPoint(cleared) ? cleared : null;
}

function dotPoint(first: CanvasPoint, second: CanvasPoint): number {
  return first.x * second.x + first.y * second.y;
}

function crossPoint(first: CanvasPoint, second: CanvasPoint): number {
  return first.x * second.y - first.y * second.x;
}

function getEndpointReferencePoint(
  endpoint: ConnectorEndpoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  sourcePageId: string,
): CanvasPoint | null {
  if (endpoint.kind === "free") {
    return isSafeResolvedPoint(endpoint) ? endpoint : null;
  }
  if (endpoint.kind !== "element" || !isSafeGap(endpoint.gap)) return null;
  const target = elementsById[endpoint.targetElementId];
  if (!isBindableElement(target) || target.pageId !== sourcePageId) return null;
  return {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
}

function normalizedDirection(from: CanvasPoint, to: CanvasPoint, fallback: CanvasPoint): CanvasPoint {
  const delta = { x: to.x - from.x, y: to.y - from.y };
  const length = Math.hypot(delta.x, delta.y);
  return length > 1e-12 && Number.isFinite(length)
    ? { x: delta.x / length, y: delta.y / length }
    : fallback;
}

function deterministicCoincidentDirection(connector: ConnectorElement): CanvasPoint {
  let hash = 2_166_136_261;
  for (let index = 0; index < connector.id.length; index += 1) {
    hash ^= connector.id.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const angle = (hash >>> 0) / 0x1_0000_0000 * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function normalizeAnchorT(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const normalized = t % 1;
  return normalized < 0 ? normalized + 1 : normalized;
}

function buildAuthoringCandidate(
  point: CanvasPoint,
  target: BindableElement,
  zoom: number,
): ConnectorAuthoringCandidate | null {
  const activeAnchor = getNearestBindableBoundaryAnchor(target, point);
  if (!activeAnchor) return null;
  const activeDistance = pointDistance(point, activeAnchor.point);
  return {
    activeAnchor,
    anchors: [activeAnchor],
    endpoint: activeDistance * zoom <= CONNECTOR_BINDING_SNAP_RADIUS_PX
      ? { kind: "element", targetElementId: target.id, gap: 0 }
      : { kind: "free", ...point },
    target,
  };
}

/** Filters proximity candidates before their expensive boundary projection. */
export function getNearbyBindableTargets(
  point: CanvasPoint,
  elements: readonly CanvasElement[],
  radius: number,
): readonly Readonly<{ element: BindableElement; index: number }>[] {
  return elements.flatMap((element, index) => isBindableElement(element)
    && isPointNearBindableBounds(point, element, radius)
    ? [{ element, index }]
    : []);
}

function canonicalAnchorT(value: number): number {
  const normalized = normalizeAnchorT(value);
  return normalized === 0 || normalized === 1 ? 0 : normalized;
}

function anchorNameForT(t: number): ShapeBindingAnchor["name"] {
  const cardinal = CARDINAL_ANCHORS.find((candidate) => Math.abs(t - candidate.t) < 1e-8);
  return cardinal?.name ?? "perimeter";
}

function unrotatePoint(
  point: CanvasPoint,
  target: Readonly<{ x: number; y: number; width: number; height: number; rotation: number }>,
): CanvasPoint {
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const radians = -target.rotation * Math.PI / 180;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: center.y + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

/** Fast inverse-rotated broad phase before the quadratic/ellipse projection. */
function isPointNearBindableBounds(point: CanvasPoint, target: BindableElement, radius: number): boolean {
  const local = unrotatePoint(point, target);
  return local.x >= target.x - radius && local.x <= target.x + target.width + radius
    && local.y >= target.y - radius && local.y <= target.y + target.height + radius;
}

function closestRectanglePoint(point: CanvasPoint, center: CanvasPoint, radiusX: number, radiusY: number): CanvasPoint | null {
  if (radiusX === 0 && radiusY === 0) return center;
  const candidates = [
    { x: Math.max(center.x - radiusX, Math.min(center.x + radiusX, point.x)), y: center.y - radiusY },
    { x: center.x + radiusX, y: Math.max(center.y - radiusY, Math.min(center.y + radiusY, point.y)) },
    { x: Math.max(center.x - radiusX, Math.min(center.x + radiusX, point.x)), y: center.y + radiusY },
    { x: center.x - radiusX, y: Math.max(center.y - radiusY, Math.min(center.y + radiusY, point.y)) },
  ];
  return nearestPoint(point, candidates);
}

function nearestPoint(point: CanvasPoint, candidates: readonly CanvasPoint[]): CanvasPoint | null {
  return candidates.reduce<CanvasPoint | null>((nearest, candidate) => !nearest || pointDistance(point, candidate) < pointDistance(point, nearest) ? candidate : nearest, null);
}

function pointDistance(first: CanvasPoint, second: CanvasPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function hasSafeShapeGeometry(shape: ShapeElement): boolean {
  return hasSafeBoxGeometry(shape);
}

function hasSafeBoxGeometry(shape: BindableElement): boolean {
  return isSafeCanvasCoordinate(shape.x)
    && isSafeCanvasCoordinate(shape.y)
    && isSafeCanvasDimension(shape.width) && shape.width > 0
    && isSafeCanvasDimension(shape.height) && shape.height > 0
    && isSafeCanvasRotation(shape.rotation);
}

function isValidPerimeterAnchor(anchor: PerimeterAnchor): boolean {
  return Number.isFinite(anchor.t) && anchor.t >= 0 && anchor.t <= 1;
}

function isSafeGap(gap: number): boolean {
  return Number.isFinite(gap) && gap >= 0 && gap <= MAX_CANVAS_VALUE;
}

function isSafeResolvedPoint(point: CanvasPoint): boolean {
  return isSafeCanvasCoordinate(point.x) && isSafeCanvasCoordinate(point.y);
}

function clampCanvasCoordinate(value: number): number {
  return Math.max(-MAX_CANVAS_VALUE, Math.min(MAX_CANVAS_VALUE, value));
}

function rotateVector(vector: CanvasPoint, rotation: number): CanvasPoint {
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: zeroSmall(vector.x * cos - vector.y * sin),
    y: zeroSmall(vector.x * sin + vector.y * cos),
  };
}

function zeroSmall(value: number): number {
  return Math.abs(value) < 1e-12 ? 0 : value;
}

function cleanCoordinate(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-12 ? rounded : zeroSmall(value);
}
