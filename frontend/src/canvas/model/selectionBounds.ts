import type {
  CanvasElement,
  ConnectorElement,
  ConnectorEndpoint,
  ElementId,
  InkElement,
  TextElement,
} from "./elements";
import { isBoxCanvasElement } from "./elements";
import { resolveConnectorEndpoint } from "./connectorBinding";
import type { CanvasPoint } from "./geometry";
import type { Bounds } from "./hitTesting";
import { normalizeBounds } from "./hitTesting";
import { MIN_BLOCK_HEIGHT, MIN_BLOCK_WIDTH } from "../../constants";

export type SelectionCorner = "nw" | "ne" | "se" | "sw";

/** Exact text box dimensions measured by the caller after rich-content reflow. */
export type TextSelectionSize = Readonly<{
  height: number;
  width: number;
}>;

/**
 * The visual bounding box of an element in world coordinates. Unlike the DOM
 * box, this includes its rotation and connector endpoints.
 */
export function getSelectionElementBounds(
  element: CanvasElement,
  elementsById: Readonly<Record<ElementId, CanvasElement>> = {},
): Bounds | null {
  if (element.type === "connector") {
    return getConnectorBounds(element, elementsById);
  }

  if (!isBoxCanvasElement(element)) return null;
  return boundsFromPoints(rotatedBoxCorners(element));
}

/** Returns one union frame for all selected elements, skipping unknown ids. */
export function getSelectionBounds(
  elements: readonly CanvasElement[],
  elementsById: Readonly<Record<ElementId, CanvasElement>> = {},
): Bounds | null {
  let result: Bounds | null = null;

  for (const element of elements) {
    const bounds = getSelectionElementBounds(element, elementsById);
    if (!bounds) continue;
    result = result ? unionBounds(result, bounds) : bounds;
  }

  return result;
}

export function rotatedBoxCorners(box: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}): CanvasPoint[] {
  const normalized = normalizeBounds(box);
  const center = {
    x: normalized.x + normalized.width / 2,
    y: normalized.y + normalized.height / 2,
  };
  const angle = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return [
    { x: normalized.x, y: normalized.y },
    { x: normalized.x + normalized.width, y: normalized.y },
    { x: normalized.x + normalized.width, y: normalized.y + normalized.height },
    { x: normalized.x, y: normalized.y + normalized.height },
  ].map((point) => ({
    x: center.x + (point.x - center.x) * cos - (point.y - center.y) * sin,
    y: center.y + (point.x - center.x) * sin + (point.y - center.y) * cos,
  }));
}

export function unionBounds(first: Bounds, second: Bounds): Bounds {
  const a = normalizeBounds(first);
  const b = normalizeBounds(second);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: right - Math.min(a.x, b.x), height: bottom - Math.min(a.y, b.y) };
}

export function getOppositeCorner(bounds: Bounds, corner: SelectionCorner): CanvasPoint {
  const normalized = normalizeBounds(bounds);
  switch (corner) {
    case "nw": return { x: normalized.x + normalized.width, y: normalized.y + normalized.height };
    case "ne": return { x: normalized.x, y: normalized.y + normalized.height };
    case "se": return { x: normalized.x, y: normalized.y };
    case "sw": return { x: normalized.x + normalized.width, y: normalized.y };
  }
}

/**
 * Computes a uniform scale from one frame corner while retaining the original
 * aspect ratio. The dominant axis controls the scale so a diagonal drag never
 * shears selected objects.
 */
export function getProportionalScale(
  bounds: Bounds,
  corner: SelectionCorner,
  draggedCorner: CanvasPoint,
  minimum = 0.01,
): number {
  const normalized = normalizeBounds(bounds);
  const anchor = getOppositeCorner(normalized, corner);
  const target = {
    x: Math.abs(draggedCorner.x - anchor.x),
    y: Math.abs(draggedCorner.y - anchor.y),
  };
  const ratios = [
    normalized.width > 0 ? target.x / normalized.width : 0,
    normalized.height > 0 ? target.y / normalized.height : 0,
  ].filter((ratio) => Number.isFinite(ratio) && ratio > 0);
  return Math.max(minimum, ratios.length > 0 ? Math.max(...ratios) : minimum);
}

/** Applies one committed translation, leaving locked selected elements intact. */
export function translateSelection(
  elements: readonly CanvasElement[],
  selectedIds: ReadonlySet<ElementId>,
  delta: CanvasPoint,
): CanvasElement[] {
  return elements.map((element) => {
    if (!selectedIds.has(element.id) || element.locked) return element;
    if (element.type === "connector") return translateConnector(element, delta);
    return isBoxCanvasElement(element)
      ? { ...element, x: element.x + delta.x, y: element.y + delta.y, updatedAt: Date.now() }
      : element;
  });
}

/**
 * Uniformly scales a selection about its opposite frame corner. Callers may
 * supply exact text measurements after reflow at the scaled width. Text keeps
 * its content intact while its opposite local edge is transformed around the
 * selection anchor for every corner direction. The local-edge calculation
 * accounts for rotation, so changing reflow height cannot make rotated text
 * jump between preview and commit.
 */
export function scaleSelection(
  elements: readonly CanvasElement[],
  selectedIds: ReadonlySet<ElementId>,
  bounds: Bounds,
  corner: SelectionCorner,
  scale: number,
  textSizes: ReadonlyMap<ElementId, TextSelectionSize> = new Map(),
): CanvasElement[] {
  const factor = finiteAtLeast(scale, 0.01);
  const anchor = getOppositeCorner(bounds, corner);
  return elements.map((element) => {
    if (!selectedIds.has(element.id) || element.locked) return element;
    if (element.type === "connector") return scaleConnector(element, anchor, factor);
    if (!isBoxCanvasElement(element)) return element;

    if (element.type === "text") {
      const size = getScaledTextSize(element, factor, textSizes.get(element.id));
      return {
        ...element,
        ...getTextPosition(element, anchor, factor, corner, size),
        height: size.height,
        isWidthManuallyResized: true,
        width: size.width,
        updatedAt: Date.now(),
      };
    }
    const position = scalePoint({ x: element.x, y: element.y }, anchor, factor);
    const box = {
      ...element,
      x: position.x,
      y: position.y,
      width: Math.max(0.01, element.width * factor),
      height: Math.max(0.01, element.height * factor),
      updatedAt: Date.now(),
    };

    if (box.type !== "ink") return box;
    return scaleInkGeometry(box, factor);
  });
}

/**
 * Connector previews for a mixed resize are the union of selected unlocked
 * connectors and connectors that visually follow a resized bound target.
 */
export function getSelectionResizePreviewConnectorIds(
  elements: readonly CanvasElement[],
  selectedIds: ReadonlySet<ElementId>,
  resizedTargetIds: ReadonlySet<ElementId>,
): Set<ElementId> {
  const connectorIds = new Set<ElementId>();
  for (const element of elements) {
    if (element.type !== "connector") continue;
    const followsResizedTarget = [element.start, element.end].some((endpoint) =>
      endpoint.kind === "element" && resizedTargetIds.has(endpoint.targetElementId),
    );
    if (followsResizedTarget || selectedIds.has(element.id) && !element.locked) {
      connectorIds.add(element.id);
    }
  }
  return connectorIds;
}

function getScaledTextSize(
  element: TextElement,
  factor: number,
  measured: TextSelectionSize | undefined,
): TextSelectionSize {
  return {
    height: finiteAtLeast(measured?.height ?? element.height * factor, MIN_BLOCK_HEIGHT),
    width: finiteAtLeast(measured?.width ?? element.width * factor, MIN_BLOCK_WIDTH),
  };
}

function getTextPosition(
  element: TextElement,
  anchor: CanvasPoint,
  factor: number,
  corner: SelectionCorner,
  size: TextSelectionSize,
): CanvasPoint {
  const oppositeLocalPoint = {
    x: corner.includes("w") ? element.width : 0,
    y: corner.includes("n") ? element.height : 0,
  };
  const targetWorldPoint = scalePoint(
    getRotatedLocalPoint(element, oppositeLocalPoint),
    anchor,
    factor,
  );
  const nextOppositeLocalPoint = {
    x: corner.includes("w") ? size.width : 0,
    y: corner.includes("n") ? size.height : 0,
  };
  return getBoxPositionForRotatedLocalPoint(
    size,
    element.rotation,
    nextOppositeLocalPoint,
    targetWorldPoint,
  );
}

function getRotatedLocalPoint(
  box: Pick<TextElement, "height" | "rotation" | "width" | "x" | "y">,
  point: CanvasPoint,
): CanvasPoint {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const angle = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const delta = { x: point.x - box.width / 2, y: point.y - box.height / 2 };
  return {
    x: center.x + delta.x * cos - delta.y * sin,
    y: center.y + delta.x * sin + delta.y * cos,
  };
}

function getBoxPositionForRotatedLocalPoint(
  size: TextSelectionSize,
  rotation: number,
  localPoint: CanvasPoint,
  worldPoint: CanvasPoint,
): CanvasPoint {
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const delta = { x: localPoint.x - size.width / 2, y: localPoint.y - size.height / 2 };
  const center = {
    x: worldPoint.x - (delta.x * cos - delta.y * sin),
    y: worldPoint.y - (delta.x * sin + delta.y * cos),
  };
  return { x: center.x - size.width / 2, y: center.y - size.height / 2 };
}

function finiteAtLeast(value: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, value) : minimum;
}

function getConnectorBounds(
  connector: ConnectorElement,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): Bounds | null {
  const start = resolveConnectorEndpoint(connector.start, elementsById, connector.pageId);
  const end = resolveConnectorEndpoint(connector.end, elementsById, connector.pageId);
  if (!start || !end) return null;
  const padding = Math.max(0, connector.style.strokeWidth / 2);
  return {
    x: Math.min(start.x, end.x) - padding,
    y: Math.min(start.y, end.y) - padding,
    width: Math.abs(start.x - end.x) + padding * 2,
    height: Math.abs(start.y - end.y) + padding * 2,
  };
}

function boundsFromPoints(points: readonly CanvasPoint[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = minX;
  let maxY = minY;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function scalePoint(point: CanvasPoint, anchor: CanvasPoint, factor: number): CanvasPoint {
  return { x: anchor.x + (point.x - anchor.x) * factor, y: anchor.y + (point.y - anchor.y) * factor };
}

function translateConnector(connector: ConnectorElement, delta: CanvasPoint): ConnectorElement {
  return {
    ...connector,
    start: translateEndpoint(connector.start, delta),
    end: translateEndpoint(connector.end, delta),
    updatedAt: Date.now(),
  };
}

function scaleConnector(connector: ConnectorElement, anchor: CanvasPoint, factor: number): ConnectorElement {
  return {
    ...connector,
    start: scaleEndpoint(connector.start, anchor, factor),
    end: scaleEndpoint(connector.end, anchor, factor),
    updatedAt: Date.now(),
  };
}

function translateEndpoint(endpoint: ConnectorEndpoint, delta: CanvasPoint): ConnectorEndpoint {
  return endpoint.kind === "free" ? { ...endpoint, x: endpoint.x + delta.x, y: endpoint.y + delta.y } : endpoint;
}

function scaleEndpoint(endpoint: ConnectorEndpoint, anchor: CanvasPoint, factor: number): ConnectorEndpoint {
  return endpoint.kind === "free" ? { ...endpoint, ...scalePoint(endpoint, anchor, factor) } : endpoint;
}

function scaleInkGeometry(element: InkElement, factor: number): InkElement {
  return {
    ...element,
    points: element.points.map(([x, y, pressure]) => [x * factor, y * factor, pressure]),
    brush: { ...element.brush, size: element.brush.size * factor },
  };
}
