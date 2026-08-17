import type {
  CanvasElement,
  ConnectorElement,
  ConnectorEndpoint,
  ElementId,
  PerimeterAnchor,
  ShapeElement,
} from "./elements";
import type { CanvasPoint } from "./geometry";

/** The screen-space capture radius stays constant as the canvas zooms. */
export const CONNECTOR_BINDING_SNAP_RADIUS_PX = 18;

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

export function isBindableShape(element: CanvasElement | undefined): element is ShapeElement {
  return element?.type === "shape" && (
    element.shape === "rectangle" || element.shape === "ellipse" || element.shape === "diamond"
  );
}

/** Resolves any compatible endpoint to its current world point. */
export function resolveConnectorEndpoint(
  endpoint: ConnectorEndpoint,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): CanvasPoint | null {
  if (endpoint.kind === "free") {
    return Number.isFinite(endpoint.x) && Number.isFinite(endpoint.y) ? endpoint : null;
  }
  if (endpoint.kind !== "element") return null;
  const target = elementsById[endpoint.targetElementId];
  return isBindableShape(target) ? getShapeAnchorPoint(target, endpoint.anchor, endpoint.gap) : null;
}

export function resolveConnectorPoints(
  connector: ConnectorElement,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): Readonly<{ start: CanvasPoint; end: CanvasPoint }> | null {
  const start = resolveConnectorEndpoint(connector.start, elementsById);
  const end = resolveConnectorEndpoint(connector.end, elementsById);
  return start && end ? { start, end } : null;
}

/** Returns the four visible/persisted binding positions for a compatible shape. */
export function getShapeBindingAnchors(shape: ShapeElement): readonly ShapeBindingAnchor[] {
  return CARDINAL_ANCHORS.map(({ name, t }) => ({
    anchor: { t },
    name,
    point: getShapeAnchorPoint(shape, { t }),
  }));
}

/**
 * Finds the rotated logical perimeter point for an anchor. Render padding is
 * deliberately excluded: it protects RoughJS output only, never model space.
 */
export function getShapeAnchorPoint(
  shape: ShapeElement,
  anchor: PerimeterAnchor,
  gap = 0,
): CanvasPoint {
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
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  return {
    x: center.x + rotatedLocal.x + rotatedDirection.x * safeGap,
    y: center.y + rotatedLocal.y + rotatedDirection.y * safeGap,
  };
}

/** Snaps only arrow endpoints; callers pass `allowBinding` false for lines. */
export function snapConnectorEndpoint(
  point: CanvasPoint,
  elements: readonly CanvasElement[],
  zoom: number,
  allowBinding: boolean,
  radiusPx = CONNECTOR_BINDING_SNAP_RADIUS_PX,
): ConnectorEndpoint {
  if (!allowBinding || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { kind: "free", ...point };
  }
  const worldRadius = radiusPx / Math.max(zoom, Number.EPSILON);
  let closest: Readonly<{ elementId: ElementId; anchor: PerimeterAnchor; distance: number }> | null = null;
  for (const element of elements) {
    if (!isBindableShape(element)) continue;
    for (const candidate of getShapeBindingAnchors(element)) {
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
  const detach = (endpoint: ConnectorEndpoint): ConnectorEndpoint => {
    if (endpoint.kind !== "element" || !deletedIds.has(endpoint.targetElementId)) return endpoint;
    const resolved = resolveConnectorEndpoint(endpoint, elementsById);
    return resolved ? { kind: "free", ...resolved } : endpoint;
  };
  return elements.map((element) => {
    if (element.type !== "connector" || deletedIds.has(element.id)) return element;
    const start = detach(element.start);
    const end = detach(element.end);
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

function rotateVector(vector: CanvasPoint, rotation: number): CanvasPoint {
  const radians = (Number.isFinite(rotation) ? rotation : 0) * Math.PI / 180;
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
