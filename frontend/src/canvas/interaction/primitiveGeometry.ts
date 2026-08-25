import type { CanvasPoint, CanvasRect } from "../model/geometry";
import {
  MAX_CANVAS_VALUE,
  isSafeCanvasCoordinate,
  isSafeCanvasDimension,
} from "../model/connectorBinding";

export type PrimitiveModifiers = Readonly<{ alt: boolean; shift: boolean }>;
export type ShapeTool = "rectangle" | "ellipse" | "diamond";
export type ConnectorTool = "line";
export type PrimitiveTool = ShapeTool | ConnectorTool;
export type PrimitiveGeometry =
  | Readonly<{ kind: "shape"; rect: CanvasRect }>
  | Readonly<{ kind: "connector"; start: CanvasPoint; end: CanvasPoint }>;

const DEFAULT_CONNECTOR_LENGTH = 160;
const DEFAULT_SHAPE_SIZE: Readonly<Record<ShapeTool, Readonly<{ width: number; height: number }>>> = {
  rectangle: { width: 160, height: 100 },
  ellipse: { width: 140, height: 100 },
  diamond: { width: 140, height: 100 },
};
export const SHAPE_DRAG_THRESHOLD_PX = 3;

/** Keeps shape authoring intent stable across canvas zoom levels. */
export function isMeaningfulShapeDrag(
  startClient: CanvasPoint,
  currentClient: CanvasPoint,
): boolean {
  return Math.hypot(
    currentClient.x - startClient.x,
    currentClient.y - startClient.y,
  ) >= SHAPE_DRAG_THRESHOLD_PX;
}

/** Matches the finite, positive shape envelope accepted by persistence and binding. */
export function isPersistableShapeRect(rect: CanvasRect): boolean {
  return isSafeCanvasCoordinate(rect.x)
    && isSafeCanvasCoordinate(rect.y)
    && isSafeCanvasDimension(rect.width)
    && rect.width > 0
    && isSafeCanvasDimension(rect.height)
    && rect.height > 0
    && isSafeCanvasCoordinate(rect.x + rect.width)
    && isSafeCanvasCoordinate(rect.y + rect.height);
}

/** Returns a persistence-safe default shape centered in the visible viewport when possible. */
export function getDefaultKeyboardShapeGeometry(
  tool: ShapeTool,
  viewport: Readonly<{ x: number; y: number; width: number; height: number }>,
): Extract<PrimitiveGeometry, { kind: "shape" }> | null {
  if (
    !Number.isFinite(viewport.x)
    || !Number.isFinite(viewport.y)
    || !Number.isFinite(viewport.width)
    || !Number.isFinite(viewport.height)
    || viewport.width <= 0
    || viewport.height <= 0
  ) return null;
  const center = {
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
  };
  if (!isSafeCanvasCoordinate(center.x) || !isSafeCanvasCoordinate(center.y)) return null;
  const defaults = DEFAULT_SHAPE_SIZE[tool];
  const width = Math.min(defaults.width, viewport.width);
  const height = Math.min(defaults.height, viewport.height);
  if (width <= 0 || height <= 0) return null;
  const geometry: Extract<PrimitiveGeometry, { kind: "shape" }> = {
    kind: "shape",
    rect: {
      x: Math.max(-MAX_CANVAS_VALUE, Math.min(MAX_CANVAS_VALUE - width, center.x - width / 2)),
      y: Math.max(-MAX_CANVAS_VALUE, Math.min(MAX_CANVAS_VALUE - height, center.y - height / 2)),
      width,
      height,
    },
  };
  return isPersistableShapeRect(geometry.rect) ? geometry : null;
}

/** Normalizes a drag into a positive box; Shift locks aspect ratio, Alt expands from center. */
export function shapeRectFromDrag(start: CanvasPoint, current: CanvasPoint, modifiers: PrimitiveModifiers): CanvasRect {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (modifiers.shift) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * size;
    dy = Math.sign(dy || 1) * size;
  }
  if (modifiers.alt) {
    return { x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  }
  return { x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

/** Shift snaps connectors to 45-degree increments; Alt expands them symmetrically. */
export function connectorFromDrag(start: CanvasPoint, current: CanvasPoint, modifiers: PrimitiveModifiers): Readonly<{ start: CanvasPoint; end: CanvasPoint }> {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (modifiers.shift) {
    const angle = Math.atan2(dy, dx);
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    const length = Math.hypot(dx, dy);
    dx = Math.cos(snapped) * length;
    dy = Math.sin(snapped) * length;
  }
  return modifiers.alt
    ? { start: { x: start.x - dx, y: start.y - dy }, end: { x: start.x + dx, y: start.y + dy } }
    : { start, end: { x: start.x + dx, y: start.y + dy } };
}

/** Resolves a pointer session to geometry; shape no-ops return null while Line retains its click default. */
export function primitiveGeometryFromSession(
  tool: PrimitiveTool,
  start: CanvasPoint,
  current: CanvasPoint,
  modifiers: PrimitiveModifiers,
  didMove: boolean,
): PrimitiveGeometry | null {
  if (tool === "line") {
    if (!didMove) {
      return {
        kind: "connector",
        start,
        end: { x: start.x + DEFAULT_CONNECTOR_LENGTH, y: start.y },
      };
    }
    return { kind: "connector", ...connectorFromDrag(start, current, modifiers) };
  }

  if (!didMove) {
    return null;
  }
  const rect = shapeRectFromDrag(start, current, modifiers);
  return isPersistableShapeRect(rect) ? { kind: "shape", rect } : null;
}

export function deterministicSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
