import type {
  CanvasElement,
  ElementId,
  InkElement,
  ShapeElement,
  TextElement,
} from "./elements";
import { isBoxCanvasElement } from "./elements";
import { resolveConnectorEndpoint } from "./connectorBinding";
import { containsPointInsideShapeBoundary } from "./shapeBoundary";
import type { CanvasPoint, CanvasRect } from "./geometry";

export type Bounds = CanvasRect;

export function normalizeBounds(bounds: Bounds): Bounds {
  return {
    x: Math.min(bounds.x, bounds.x + bounds.width),
    y: Math.min(bounds.y, bounds.y + bounds.height),
    width: Math.abs(bounds.width),
    height: Math.abs(bounds.height),
  };
}

export function getElementBounds(
  element: CanvasElement,
  elementsById: Readonly<Record<ElementId, CanvasElement>> = {},
): Bounds | null {
  if (element.type === "connector") {
    const start = resolveConnectorEndpoint(element.start, elementsById, element.pageId);
    const end = resolveConnectorEndpoint(element.end, elementsById, element.pageId);
    if (!start || !end) return null;
    const padding = Math.max(0, element.style.strokeWidth / 2);
    return {
      x: Math.min(start.x, end.x) - padding,
      y: Math.min(start.y, end.y) - padding,
      width: Math.abs(start.x - end.x) + padding * 2,
      height: Math.abs(start.y - end.y) + padding * 2,
    };
  }
  if (!isBoxCanvasElement(element)) return null;
  return normalizeBounds({ x: element.x, y: element.y, width: element.width, height: element.height });
}

function pointInPolygon(point: CanvasPoint, vertices: readonly CanvasPoint[]) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index, index += 1) {
    const first = vertices[index];
    const second = vertices[previous];
    if (
      (first.y > point.y) !== (second.y > point.y) &&
      point.x < ((second.x - first.x) * (point.y - first.y)) / (second.y - first.y) + first.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToPolygon(point: CanvasPoint, vertices: readonly CanvasPoint[]) {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    distance = Math.min(
      distance,
      pointToSegmentDistance(point, vertices[index], vertices[(index + 1) % vertices.length]),
    );
  }
  return distance;
}

function unrotatePoint(
  element: Readonly<{ x: number; y: number; width: number; height: number; rotation: number }>,
  point: CanvasPoint,
) {
  const center = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
  const angle = (-element.rotation * Math.PI) / 180;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

function shapeContainsPoint(element: ShapeElement, worldPoint: CanvasPoint, tolerance: number) {
  const point = unrotatePoint(element, worldPoint);
  const radius = Math.max(0, tolerance) + element.style.strokeWidth / 2;
  const rect = normalizeBounds(element);
  const hasFill = Boolean(element.style.fillColor);

  if (element.shape === "ellipse") {
    const rx = rect.width / 2;
    const ry = rect.height / 2;
    if (rx <= 0 || ry <= 0) return false;
    const normalizedDistance = Math.hypot(
      (point.x - (rect.x + rx)) / rx,
      (point.y - (rect.y + ry)) / ry,
    );
    return hasFill
      ? normalizedDistance <= 1 + radius / Math.min(rx, ry)
      : Math.abs(normalizedDistance - 1) * Math.min(rx, ry) <= radius;
  }

  const vertices = element.shape === "diamond"
    ? [
        { x: rect.x + rect.width / 2, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
        { x: rect.x + rect.width / 2, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height / 2 },
      ]
    : [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height },
      ];
  return (hasFill && pointInPolygon(point, vertices)) || distanceToPolygon(point, vertices) <= radius;
}

/** Geometry-aware hit test shared by selection and the eraser. */
export function canvasElementContainsPoint(
  element: CanvasElement,
  point: CanvasPoint,
  tolerance = 0,
  elementsById: Readonly<Record<ElementId, CanvasElement>> = {},
): boolean {
  if (element.type === "ink") return inkContainsPoint(element, point, tolerance);
  if (element.type === "connector") {
    const start = resolveConnectorEndpoint(element.start, elementsById, element.pageId);
    const end = resolveConnectorEndpoint(element.end, elementsById, element.pageId);
    return Boolean(start && end && pointToSegmentDistance(point, start, end) <= Math.max(0, tolerance) + element.style.strokeWidth / 2);
  }
  if (element.type === "shape") return shapeContainsPoint(element, point, tolerance);
  return boundsContainPoint(element, unrotatePoint(element, point), tolerance);
}

export function getEraserElementIds(
  elements: readonly CanvasElement[],
  points: readonly CanvasPoint[],
  tolerance: number,
): ElementId[] {
  const elementsById = Object.fromEntries(elements.map((element) => [element.id, element]));
  return elements
    .filter(
      (element) =>
        !element.locked &&
        points.some((point) =>
          canvasElementContainsPoint(element, point, tolerance, elementsById),
        ),
    )
    .map((element) => element.id);
}

export function boundsContainPoint(bounds: Bounds, point: CanvasPoint, tolerance = 0): boolean {
  const normalized = normalizeBounds(bounds);
  return point.x >= normalized.x - tolerance && point.x <= normalized.x + normalized.width + tolerance
    && point.y >= normalized.y - tolerance && point.y <= normalized.y + normalized.height + tolerance;
}

export function boundsIntersect(first: Bounds, second: Bounds): boolean {
  const a = normalizeBounds(first);
  const b = normalizeBounds(second);
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

export function boundsContainBounds(container: Bounds, candidate: Bounds): boolean {
  const a = normalizeBounds(container);
  const b = normalizeBounds(candidate);
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
}

/** Squared-distance-safe point-to-segment calculation used for painted ink hit targets. */
export function pointToSegmentDistance(
  point: CanvasPoint,
  start: CanvasPoint,
  end: CanvasPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

/** Tests a world point against the actual local stroke path, not its rectangular bounds. */
export function inkContainsPoint(
  element: InkElement,
  point: CanvasPoint,
  tolerance = 0,
): boolean {
  const radius = Math.max(0, tolerance) + element.brush.size / 2;
  if (
    point.x < element.x - radius ||
    point.y < element.y - radius ||
    point.x > element.x + element.width + radius ||
    point.y > element.y + element.height + radius
  ) {
    return false;
  }
  const points = element.points;
  if (points.length === 0) return false;
  let startX = element.x + points[0][0];
  let startY = element.y + points[0][1];
  if (points.length === 1) return Math.hypot(point.x - startX, point.y - startY) <= radius;
  for (let index = 1; index < points.length; index += 1) {
    const endX = element.x + points[index][0];
    const endY = element.y + points[index][1];
    if (pointToSegmentDistance(point, { x: startX, y: startY }, { x: endX, y: endY }) <= radius) {
      return true;
    }
    startX = endX;
    startY = endY;
  }
  return false;
}

export function getMarqueeElementIds(
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  orderedElementIds: readonly ElementId[],
  marquee: Bounds,
  mode: "contain" | "intersect" = "contain",
): ElementId[] {
  return orderedElementIds.filter((id) => {
    const element = elementsById[id];
    const bounds = element && getElementBounds(element, elementsById);
    return bounds ? (mode === "contain" ? boundsContainBounds(marquee, bounds) : boundsIntersect(marquee, bounds)) : false;
  });
}

export function getTopmostElementAtPoint(
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  orderedElementIds: readonly ElementId[],
  point: CanvasPoint,
  tolerance = 0,
): CanvasElement | undefined {
  for (let index = orderedElementIds.length - 1; index >= 0; index -= 1) {
    const element = elementsById[orderedElementIds[index]];
    if (element && canvasElementContainsPoint(element, point, tolerance, elementsById)) return element;
  }
  return undefined;
}

/**
 * Finds a compatible target from model geometry, independent of DOM pointer
 * targeting. This keeps arrow binding usable while the world layer is pointer
 * inert and ignores connectors that visually cross a target.
 */
export function getDirectBindableTargetAtPoint(
  elements: readonly CanvasElement[],
  point: CanvasPoint,
): ShapeElement | TextElement | undefined {
  let best: ShapeElement | TextElement | undefined;
  let bestZIndex = Number.NEGATIVE_INFINITY;
  let bestIndex = -1;

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!isDirectBindableElement(element)) continue;

    // A candidate can only win if it has a higher z-index, or the same
    // z-index and a later source position than the current winner. This
    // avoids exact geometry work for candidates that cannot replace `best`.
    if (element.zIndex < bestZIndex || (element.zIndex === bestZIndex && index <= bestIndex)) continue;
    if (!directBindableContainsPoint(element, point)) continue;

    best = element;
    bestZIndex = element.zIndex;
    bestIndex = index;
  }

  return best;
}

function isDirectBindableElement(element: CanvasElement): element is ShapeElement | TextElement {
  return element.type === "text" || (element.type === "shape" && (
    element.shape === "rectangle" || element.shape === "ellipse" || element.shape === "diamond"
  ));
}

function directBindableContainsPoint(element: ShapeElement | TextElement, worldPoint: CanvasPoint): boolean {
  if (!(element.width > 0 && element.height > 0)) return false;
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;
  const angle = (-element.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = worldPoint.x - centerX;
  const dy = worldPoint.y - centerY;
  const localX = centerX + dx * cos - dy * sin - element.x;
  const localY = centerY + dx * sin + dy * cos - element.y;

  // Reject outside the inverse-rotated local AABB before invoking the more
  // expensive rounded boundary containment calculation.
  if (localX < 0 || localY < 0 || localX > element.width || localY > element.height) return false;
  if (element.type === "text" || element.shape === "rectangle") {
    return element.type === "text"
      ? true
      : containsPointInsideShapeBoundary(element.shape, element.width, element.height, element.style.roundness, {
        x: localX,
        y: localY,
      });
  }
  return containsPointInsideShapeBoundary(element.shape, element.width, element.height, element.style.roundness, {
    x: localX,
    y: localY,
  });
}
