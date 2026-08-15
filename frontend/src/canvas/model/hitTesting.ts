import type { CanvasElement, ElementId, InkElement } from "./elements";
import { isBoxCanvasElement } from "./elements";
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

export function getElementBounds(element: CanvasElement): Bounds | null {
  if (!isBoxCanvasElement(element)) return null;
  return normalizeBounds({ x: element.x, y: element.y, width: element.width, height: element.height });
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
  const points = element.points.map(([x, y]) => ({ x: element.x + x, y: element.y + y }));
  if (points.length === 0) return false;
  if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y) <= radius;
  return points.slice(1).some((end, index) => pointToSegmentDistance(point, points[index], end) <= radius);
}

export function getMarqueeElementIds(
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  orderedElementIds: readonly ElementId[],
  marquee: Bounds,
  mode: "contain" | "intersect" = "contain",
): ElementId[] {
  return orderedElementIds.filter((id) => {
    const element = elementsById[id];
    const bounds = element && getElementBounds(element);
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
    const bounds = element && getElementBounds(element);
    if (bounds && boundsContainPoint(bounds, point, tolerance)) return element;
  }
  return undefined;
}
