import type { CanvasElement, ElementId } from "./elements";
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
