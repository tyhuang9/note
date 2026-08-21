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
  createShapeSupportDescriptor,
  getShapeBoundaryPoint,
  getShapeSupportPointFromDescriptor,
  projectPointToShapeBoundary,
  type ShapeSupportDescriptor,
} from "./shapeBoundary";

/** The screen-space capture radius stays constant as the canvas zooms. */
export const CONNECTOR_BINDING_SNAP_RADIUS_PX = 18;
/** A nearby compatible target reveals a whole-object highlight before endpoint snapping begins. */
export const CONNECTOR_BINDING_REVEAL_RADIUS_PX = 28;
/** Mirrors the persistence boundary limit in the Rust repository. */
export const MAX_CANVAS_VALUE = 1_000_000;
export const MAX_CANVAS_ROTATION_DEGREES = 360;
const DEFAULT_KEYBOARD_ARROW_LENGTH = 160;
export const CONNECTOR_ARROWHEAD_LENGTH = 12;
export const CONNECTOR_ARROWHEAD_HALF_WIDTH = 5;

export type BindableElement = ShapeElement | TextElement;

export type ConnectorAuthoringCandidate = Readonly<{
  endpoint: ConnectorEndpoint;
  target: BindableElement;
}>;

type ConnectorGeometryCacheEntry = Readonly<{
  endTarget: CanvasElement | null;
  points: Readonly<{ start: CanvasPoint; end: CanvasPoint }> | null;
  startTarget: CanvasElement | null;
}>;

const connectorGeometryCache = new WeakMap<ConnectorElement, ConnectorGeometryCacheEntry>();
let connectorGeometryCacheHits = 0;
let connectorGeometryCacheMisses = 0;
const gjkIterationHistogram = Array.from({ length: 65 }, () => 0);
let gjkCapHits = 0;
let gjkResolutions = 0;

export function getConnectorGeometryCacheDiagnostics(): Readonly<{ hits: number; misses: number }> {
  return { hits: connectorGeometryCacheHits, misses: connectorGeometryCacheMisses };
}

export function resetConnectorGeometryCacheDiagnostics(): void {
  connectorGeometryCacheHits = 0;
  connectorGeometryCacheMisses = 0;
}

export function getConnectorGjkDiagnostics(): Readonly<{
  capHits: number;
  histogram: readonly number[];
  resolutions: number;
}> {
  return { capHits: gjkCapHits, histogram: [...gjkIterationHistogram], resolutions: gjkResolutions };
}

export function resetConnectorGjkDiagnostics(): void {
  gjkCapHits = 0;
  gjkResolutions = 0;
  gjkIterationHistogram.fill(0);
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
    ? `Snapped to ${label}. The connector will follow its nearest facing visible boundary.`
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
  const startTarget = getBoundEndpointTargetReference(connector.start, elementsById);
  const endTarget = getBoundEndpointTargetReference(connector.end, elementsById);
  const cached = connectorGeometryCache.get(connector);
  if (cached && cached.startTarget === startTarget && cached.endTarget === endTarget) {
    connectorGeometryCacheHits += 1;
    return cached.points;
  }
  connectorGeometryCacheMisses += 1;
  const points = computeConnectorPoints(connector, elementsById);
  connectorGeometryCache.set(connector, { endTarget, points, startTarget });
  return points;
}

/**
 * Callers replace connectors and targets immutably. The WeakMap therefore
 * invalidates only routes whose endpoint object references actually changed.
 */
function computeConnectorPoints(
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

function getBoundEndpointTargetReference(
  endpoint: ConnectorEndpoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): CanvasElement | null {
  return endpoint.kind === "element" ? elementsById[endpoint.targetElementId] ?? null : null;
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
): Readonly<{ anchor: PerimeterAnchor; point: CanvasPoint }> | null {
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
  return { anchor, point: resolved };
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
    const boundaryPoint = getNearestBindableBoundaryPoint(element, point);
    if (!boundaryPoint) continue;
    const distance = Math.hypot(boundaryPoint.x - point.x, boundaryPoint.y - point.y);
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
 * Resolves the one whole-object target shown while an arrow endpoint is being authored.
 * A directly hovered compatible target wins. Proximity candidates are ordered
 * deterministically by nearest boundary distance, then visual stacking, then source order.
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
    return buildAuthoringCandidate(point, directTarget, safeZoom, true)?.candidate ?? null;
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
    const built = buildAuthoringCandidate(point, element, safeZoom);
    if (!built) continue;
    const { candidate, distancePx } = built;
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
 * Resolves a bound endpoint for detachment. Suppressed canonical pairs have no
 * visible witness point, so place the free endpoint beyond a shared support
 * plane instead of at a target center that may remain inside the other object.
 */
export function getConnectorEndpointDetachPoint(
  connector: ConnectorElement,
  endpointName: "start" | "end",
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): CanvasPoint | null {
  const resolved = resolveConnectorPoints(connector, elementsById)?.[endpointName];
  if (resolved) return resolved;
  const endpoint = connector[endpointName];
  if (endpoint.kind === "free") return normalizeFreeConnectorEndpoint(endpoint);
  if (endpoint.kind !== "element") return null;
  const target = elementsById[endpoint.targetElementId];
  if (!isBindableElement(target) || target.pageId !== connector.pageId) return null;
  if (endpoint.anchor) return resolveConnectorEndpoint(endpoint, elementsById, connector.pageId);

  const oppositeName = endpointName === "start" ? "end" : "start";
  const opposite = connector[oppositeName];
  const oppositeTarget = opposite.kind === "element"
    ? elementsById[opposite.targetElementId]
    : undefined;
  const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const oppositeCenter = isBindableElement(oppositeTarget)
    ? { x: oppositeTarget.x + oppositeTarget.width / 2, y: oppositeTarget.y + oppositeTarget.height / 2 }
    : opposite.kind === "free"
      ? opposite
      : null;
  let direction = oppositeCenter
    ? { x: targetCenter.x - oppositeCenter.x, y: targetCenter.y - oppositeCenter.y }
    : endpointName === "start" ? { x: -1, y: 0 } : { x: 1, y: 0 };
  if (Math.hypot(direction.x, direction.y) <= 1e-10) {
    const fallback = deterministicCoincidentDirection(connector);
    direction = endpointName === "start"
      ? { x: -fallback.x, y: -fallback.y }
      : fallback;
  }
  const length = Math.hypot(direction.x, direction.y);
  if (!Number.isFinite(length) || length <= 0) return null;
  const unit = { x: direction.x / length, y: direction.y / length };
  const endpointSource = getEndpointSupportSource(endpoint, elementsById, connector.pageId);
  const oppositeSource = getEndpointSupportSource(opposite, elementsById, connector.pageId);
  const endpointSupport = endpointSource ? getEndpointSupportPoint(endpointSource, unit.x, unit.y) : null;
  const oppositeSupport = oppositeSource ? getEndpointSupportPoint(oppositeSource, unit.x, unit.y) : null;
  const support = endpointSupport && oppositeSupport
    ? endpointSupport.x * unit.x + endpointSupport.y * unit.y
        >= oppositeSupport.x * unit.x + oppositeSupport.y * unit.y
      ? endpointSupport
      : oppositeSupport
    : endpointSupport ?? oppositeSupport ?? targetCenter;
  const targetOutline = target.type === "shape" ? target.style.strokeWidth / 2 : 0;
  const clearance = Math.max(8, endpoint.gap + targetOutline + connector.style.strokeWidth / 2 + 4);
  return normalizeFreeConnectorEndpoint({
    x: support.x + unit.x * clearance,
    y: support.y + unit.y * clearance,
  });
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
  const detach = (endpoint: ConnectorEndpoint, resolved: CanvasPoint | null): ConnectorEndpoint => {
    if (endpoint.kind !== "element" || !deletedIds.has(endpoint.targetElementId)) return endpoint;
    if (resolved) return { kind: "free", ...resolved };
    const target = elementsById[endpoint.targetElementId];
    if (!isBindableElement(target)) return endpoint;
    return normalizeFreeConnectorEndpoint({
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    }) ?? endpoint;
  };
  return elements.map((element) => {
    if (element.type !== "connector" || deletedIds.has(element.id)) return element;
    const points = resolveConnectorPoints(element, elementsById);
    const start = detach(
      element.start,
      points?.start
        ?? (element.start.kind === "element" && deletedIds.has(element.start.targetElementId)
          ? getConnectorEndpointDetachPoint(element, "start", elementsById)
          : null),
    );
    const end = detach(
      element.end,
      points?.end
        ?? (element.end.kind === "element" && deletedIds.has(element.end.targetElementId)
          ? getConnectorEndpointDetachPoint(element, "end", elementsById)
          : null),
    );
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

type ClosestSimplex = {
  closestX: number;
  closestY: number;
  first: SupportVertex;
  firstWeight: number;
  overlap: boolean;
  second: SupportVertex | null;
  secondWeight: number;
};

type BindableSupportDescriptor = Readonly<{
  centerX: number;
  centerY: number;
  cos: number;
  height: number;
  shape: ShapeSupportDescriptor | null;
  sin: number;
  width: number;
}>;

type EndpointSupportSource = Readonly<
  | { kind: "free"; x: number; y: number }
  | { descriptor: BindableSupportDescriptor; kind: "bound" }
>;

const bindableSupportDescriptorCache = new WeakMap<BindableElement, BindableSupportDescriptor>();

/** Exact convex support/GJK distance; center rays are used only for zero-distance degeneracies. */
function getClosestEndpointBoundaryPair(
  start: ConnectorEndpoint,
  end: ConnectorEndpoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  sourcePageId: string,
  initialDirection: CanvasPoint,
): Readonly<{ kind: "overlap" } | { kind: "separated"; start: CanvasPoint; end: CanvasPoint }> | null {
  let iterationCount = 0;
  const finish = <T>(result: T, capHit = false): T => {
    gjkResolutions += 1;
    gjkIterationHistogram[Math.min(64, iterationCount)] += 1;
    if (capHit) gjkCapHits += 1;
    return result;
  };
  const startSupport = getEndpointSupportSource(start, elementsById, sourcePageId);
  const endSupport = getEndpointSupportSource(end, elementsById, sourcePageId);
  if (!startSupport || !endSupport) return finish(null);
  const support = (directionX: number, directionY: number): SupportVertex | null => {
    const startPoint = getEndpointSupportPoint(startSupport, directionX, directionY);
    const endPoint = getEndpointSupportPoint(endSupport, -directionX, -directionY);
    return startPoint && endPoint ? {
      difference: { x: startPoint.x - endPoint.x, y: startPoint.y - endPoint.y },
      start: startPoint,
      end: endPoint,
    } : null;
  };
  const first = support(initialDirection.x, initialDirection.y);
  if (!first) return finish(null);
  const state: ClosestSimplex = {
    closestX: first.difference.x,
    closestY: first.difference.y,
    first,
    firstWeight: 1,
    overlap: false,
    second: null,
    secondWeight: 0,
  };
  for (let iteration = 0; iteration < 64; iteration += 1) {
    iterationCount = iteration + 1;
    const distanceSquared = state.closestX * state.closestX + state.closestY * state.closestY;
    if (state.overlap || distanceSquared <= 1e-20) return finish({ kind: "overlap" as const });
    const next = support(-state.closestX, -state.closestY);
    if (!next) return finish(null);
    const improvement = distanceSquared - state.closestX * next.difference.x - state.closestY * next.difference.y;
    if (improvement <= 1e-12 * Math.max(1, distanceSquared)) {
      const witnesses = witnessPoints(state);
      return finish(witnesses ? { kind: "separated" as const, ...witnesses } : null);
    }
    const firstDeltaX = state.first.difference.x - next.difference.x;
    const firstDeltaY = state.first.difference.y - next.difference.y;
    let duplicate = firstDeltaX * firstDeltaX + firstDeltaY * firstDeltaY <= 1e-24;
    if (!duplicate && state.second) {
      const secondDeltaX = state.second.difference.x - next.difference.x;
      const secondDeltaY = state.second.difference.y - next.difference.y;
      duplicate = secondDeltaX * secondDeltaX + secondDeltaY * secondDeltaY <= 1e-24;
    }
    if (duplicate) return finish(null);
    extendClosestSimplex(state, next);
  }
  const witnesses = witnessPoints(state);
  return finish(witnesses ? { kind: "separated" as const, ...witnesses } : null, true);
}

function getEndpointSupportPoint(
  source: EndpointSupportSource,
  directionX: number,
  directionY: number,
): CanvasPoint | null {
  if (source.kind === "free") return source;
  const { descriptor } = source;
  const localDirectionX = directionX * descriptor.cos + directionY * descriptor.sin;
  const localDirectionY = -directionX * descriptor.sin + directionY * descriptor.cos;
  const local = descriptor.shape
    ? getShapeSupportPointFromDescriptor(descriptor.shape, localDirectionX, localDirectionY)
    : getRectangleSupportPoint(descriptor.width, descriptor.height, localDirectionX, localDirectionY);
  if (!local) return null;
  const localX = local.x - descriptor.width / 2;
  const localY = local.y - descriptor.height / 2;
  const point = {
    x: descriptor.centerX + localX * descriptor.cos - localY * descriptor.sin,
    y: descriptor.centerY + localX * descriptor.sin + localY * descriptor.cos,
  };
  return isSafeResolvedPoint(point) ? point : null;
}

function getEndpointSupportSource(
  endpoint: ConnectorEndpoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  sourcePageId: string,
): EndpointSupportSource | null {
  if (endpoint.kind === "free") return isSafeResolvedPoint(endpoint) ? endpoint : null;
  if (endpoint.kind !== "element" || !isSafeGap(endpoint.gap)) return null;
  const target = elementsById[endpoint.targetElementId];
  if (!isBindableElement(target) || target.pageId !== sourcePageId) return null;
  const descriptor = getBindableSupportDescriptor(target);
  return descriptor ? { descriptor, kind: "bound" } : null;
}

function getBindableSupportDescriptor(target: BindableElement): BindableSupportDescriptor | null {
  const cached = bindableSupportDescriptorCache.get(target);
  if (cached) return cached;
  const radians = target.rotation * Math.PI / 180;
  const descriptor: BindableSupportDescriptor = {
    centerX: target.x + target.width / 2,
    centerY: target.y + target.height / 2,
    cos: Math.cos(radians),
    height: target.height,
    shape: target.type === "shape"
      ? createShapeSupportDescriptor(target.shape, target.width, target.height, target.style.roundness)
      : null,
    sin: Math.sin(radians),
    width: target.width,
  };
  if (target.type === "shape" && !descriptor.shape) return null;
  bindableSupportDescriptorCache.set(target, descriptor);
  return descriptor;
}

function getRectangleSupportPoint(
  width: number,
  height: number,
  directionX: number,
  directionY: number,
): CanvasPoint {
  return {
    x: directionX >= 0 ? width : 0,
    y: directionY >= 0 ? height : 0,
  };
}

function extendClosestSimplex(state: ClosestSimplex, next: SupportVertex): void {
  if (!state.second) {
    setClosestSegmentSimplex(state, state.first, next);
    return;
  }
  const { first, second } = state;
  if (originInsideTriangle(first.difference, second.difference, next.difference)) {
    state.closestX = 0;
    state.closestY = 0;
    state.overlap = true;
    return;
  }
  const firstSecondRatio = getClosestSegmentRatio(first, second);
  let bestDistance = getSegmentDistanceSquared(first, second, firstSecondRatio);
  let bestFirst = first;
  let bestSecond = second;
  let bestRatio = firstSecondRatio;
  const secondNextRatio = getClosestSegmentRatio(second, next);
  let candidateDistance = getSegmentDistanceSquared(second, next, secondNextRatio);
  if (candidateDistance < bestDistance - 1e-16) {
    bestDistance = candidateDistance;
    bestFirst = second;
    bestSecond = next;
    bestRatio = secondNextRatio;
  }
  const nextFirstRatio = getClosestSegmentRatio(next, first);
  candidateDistance = getSegmentDistanceSquared(next, first, nextFirstRatio);
  if (candidateDistance < bestDistance - 1e-16) {
    bestFirst = next;
    bestSecond = first;
    bestRatio = nextFirstRatio;
  }
  setClosestSegmentSimplex(state, bestFirst, bestSecond, bestRatio);
}

function getClosestSegmentRatio(first: SupportVertex, second: SupportVertex): number {
  const edgeX = second.difference.x - first.difference.x;
  const edgeY = second.difference.y - first.difference.y;
  const size = edgeX * edgeX + edgeY * edgeY;
  return size <= 1e-24
    ? 0
    : Math.max(0, Math.min(1, -(first.difference.x * edgeX + first.difference.y * edgeY) / size));
}

function getSegmentDistanceSquared(first: SupportVertex, second: SupportVertex, ratio: number): number {
  const closestX = first.difference.x + (second.difference.x - first.difference.x) * ratio;
  const closestY = first.difference.y + (second.difference.y - first.difference.y) * ratio;
  return closestX * closestX + closestY * closestY;
}

function setClosestSegmentSimplex(
  state: ClosestSimplex,
  first: SupportVertex,
  second: SupportVertex,
  ratio = getClosestSegmentRatio(first, second),
): void {
  state.overlap = false;
  if (ratio <= 1e-14) {
    state.closestX = first.difference.x;
    state.closestY = first.difference.y;
    state.first = first;
    state.firstWeight = 1;
    state.second = null;
    state.secondWeight = 0;
    return;
  }
  if (ratio >= 1 - 1e-14) {
    state.closestX = second.difference.x;
    state.closestY = second.difference.y;
    state.first = second;
    state.firstWeight = 1;
    state.second = null;
    state.secondWeight = 0;
    return;
  }
  state.closestX = first.difference.x + (second.difference.x - first.difference.x) * ratio;
  state.closestY = first.difference.y + (second.difference.y - first.difference.y) * ratio;
  state.first = first;
  state.firstWeight = 1 - ratio;
  state.second = second;
  state.secondWeight = ratio;
}

function originInsideTriangle(first: CanvasPoint, second: CanvasPoint, third: CanvasPoint): boolean {
  const firstCross = (second.x - first.x) * -first.y - (second.y - first.y) * -first.x;
  const secondCross = (third.x - second.x) * -second.y - (third.y - second.y) * -second.x;
  const thirdCross = (first.x - third.x) * -third.y - (first.y - third.y) * -third.x;
  return (firstCross >= -1e-12 && secondCross >= -1e-12 && thirdCross >= -1e-12)
    || (firstCross <= 1e-12 && secondCross <= 1e-12 && thirdCross <= 1e-12);
}

function witnessPoints(state: ClosestSimplex): Readonly<{ start: CanvasPoint; end: CanvasPoint }> | null {
  if (state.overlap) return null;
  let startX = state.first.start.x * state.firstWeight;
  let startY = state.first.start.y * state.firstWeight;
  let endX = state.first.end.x * state.firstWeight;
  let endY = state.first.end.y * state.firstWeight;
  if (state.second) {
    startX += state.second.start.x * state.secondWeight;
    startY += state.second.start.y * state.secondWeight;
    endX += state.second.end.x * state.secondWeight;
    endY += state.second.end.y * state.secondWeight;
  }
  const result = { start: { x: startX, y: startY }, end: { x: endX, y: endY } };
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
  forceSnap = false,
): Readonly<{ candidate: ConnectorAuthoringCandidate; distancePx: number }> | null {
  const nearestBoundary = getNearestBindableBoundaryPoint(target, point);
  if (!nearestBoundary) return null;
  const distancePx = pointDistance(point, nearestBoundary) * zoom;
  return {
    candidate: {
      endpoint: forceSnap || distancePx <= CONNECTOR_BINDING_SNAP_RADIUS_PX
        ? { kind: "element", targetElementId: target.id, gap: 0 }
        : { kind: "free", ...point },
      target,
    },
    distancePx,
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

/** Point-only clean-boundary projection for normal whole-object authoring and retargeting. */
function getNearestBindableBoundaryPoint(
  target: BindableElement,
  point: CanvasPoint,
): CanvasPoint | null {
  if (!hasSafeBoxGeometry(target) || !isSafeResolvedPoint(point)) return null;
  const local = unrotatePoint(point, target);
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const projected = target.type === "shape"
    ? projectPointToShapeBoundary(target.shape, target.width, target.height, target.style.roundness, {
      x: local.x - target.x,
      y: local.y - target.y,
    })
    : closestRectanglePoint(local, center, target.width / 2, target.height / 2);
  if (!projected) return null;
  const unrotatedWorldPoint = target.type === "shape"
    ? { x: target.x + projected.x, y: target.y + projected.y }
    : projected;
  const rotated = rotateVector({
    x: unrotatedWorldPoint.x - center.x,
    y: unrotatedWorldPoint.y - center.y,
  }, target.rotation);
  const resolved = {
    x: cleanCoordinate(center.x + rotated.x),
    y: cleanCoordinate(center.y + rotated.y),
  };
  return isSafeResolvedPoint(resolved) ? resolved : null;
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
