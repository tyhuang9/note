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

/** The screen-space capture radius stays constant as the canvas zooms. */
export const CONNECTOR_BINDING_SNAP_RADIUS_PX = 18;
/** Mirrors the persistence boundary limit in the Rust repository. */
export const MAX_CANVAS_VALUE = 1_000_000;
export const MAX_CANVAS_ROTATION_DEGREES = 360;

export type ShapeAnchorName = "top" | "right" | "bottom" | "left";

export type ShapeBindingAnchor = Readonly<{
  anchor: PerimeterAnchor;
  name: ShapeAnchorName;
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
  if (!isBindableElement(target) || !isValidPerimeterAnchor(endpoint.anchor) || !isSafeGap(endpoint.gap)) {
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
  const start = resolveConnectorEndpoint(connector.start, elementsById, connector.pageId);
  const end = resolveConnectorEndpoint(connector.end, elementsById, connector.pageId);
  return start && end ? { start, end } : null;
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
 * Finds the rotated logical perimeter point for an anchor. Render padding is
 * deliberately excluded: it protects RoughJS output only, never model space.
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
  const direction = {
    x: zeroSmall(Math.sin(radians)),
    y: zeroSmall(-Math.cos(radians)),
  };
  const radiusX = width / 2;
  const radiusY = height / 2;
  const perimeterDistance = shape.shape === "ellipse"
    ? 1
    : shape.shape === "diamond"
      ? 1 / Math.max(Number.EPSILON, Math.abs(direction.x) / Math.max(radiusX, Number.EPSILON) + Math.abs(direction.y) / Math.max(radiusY, Number.EPSILON))
      : Math.min(
        direction.x === 0 ? Number.POSITIVE_INFINITY : radiusX / Math.abs(direction.x),
        direction.y === 0 ? Number.POSITIVE_INFINITY : radiusY / Math.abs(direction.y),
      );
  const local = shape.shape === "ellipse"
    ? { x: direction.x * radiusX, y: direction.y * radiusY }
    : { x: direction.x * perimeterDistance, y: direction.y * perimeterDistance };
  const rotatedDirection = rotateVector(direction, shape.rotation);
  const rotatedLocal = rotateVector(local, shape.rotation);
  const safeGap = gap;
  const point = {
    x: center.x + rotatedLocal.x + rotatedDirection.x * safeGap,
    y: center.y + rotatedLocal.y + rotatedDirection.y * safeGap,
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
    return { kind: "free", x: clampCanvasCoordinate(point.x), y: clampCanvasCoordinate(point.y) };
  }
  if (!allowBinding) {
    return { kind: "free", ...point };
  }
  const worldRadius = radiusPx / Math.max(zoom, Number.EPSILON);
  let closest: Readonly<{ elementId: ElementId; anchor: PerimeterAnchor; distance: number }> | null = null;
  for (const element of elements) {
    if (!isBindableElement(element)) continue;
    for (const candidate of getBindableBindingAnchors(element)) {
      const distance = Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y);
      if (distance <= worldRadius && (!closest || distance < closest.distance)) {
        closest = { anchor: candidate.anchor, distance, elementId: element.id };
      }
    }
  }
  return closest
    ? { kind: "element", targetElementId: closest.elementId, anchor: closest.anchor, gap: 0 }
    : { kind: "free", ...point };
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

function normalizeAnchorT(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const normalized = t % 1;
  return normalized < 0 ? normalized + 1 : normalized;
}

function hasSafeShapeGeometry(shape: ShapeElement): boolean {
  return hasSafeBoxGeometry(shape);
}

function hasSafeBoxGeometry(shape: BindableElement): boolean {
  return isSafeCanvasCoordinate(shape.x)
    && isSafeCanvasCoordinate(shape.y)
    && isSafeCanvasDimension(shape.width)
    && isSafeCanvasDimension(shape.height)
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
  if (!Number.isFinite(value)) return 0;
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
