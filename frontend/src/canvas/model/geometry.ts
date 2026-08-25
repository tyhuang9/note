/** Pure coordinate helpers. Screen coordinates include the viewport's page position. */
export type CanvasPoint = Readonly<{ x: number; y: number }>;
export type CanvasRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type CanvasViewport = Readonly<{
  origin: CanvasPoint;
  pan: CanvasPoint;
  zoom: number;
}>;

export function screenToWorld(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: (point.x - viewport.origin.x - viewport.pan.x) / viewport.zoom,
    y: (point.y - viewport.origin.y - viewport.pan.y) / viewport.zoom,
  };
}

export function worldToScreen(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: viewport.origin.x + viewport.pan.x + point.x * viewport.zoom,
    y: viewport.origin.y + viewport.pan.y + point.y * viewport.zoom,
  };
}

export function screenDeltaToWorld(delta: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return { x: delta.x / viewport.zoom, y: delta.y / viewport.zoom };
}

export function worldDeltaToScreen(delta: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return { x: delta.x * viewport.zoom, y: delta.y * viewport.zoom };
}

export function screenRectToWorld(rect: CanvasRect, viewport: CanvasViewport): CanvasRect {
  const origin = screenToWorld(rect, viewport);
  return { x: origin.x, y: origin.y, width: rect.width / viewport.zoom, height: rect.height / viewport.zoom };
}

export function worldRectToScreen(rect: CanvasRect, viewport: CanvasViewport): CanvasRect {
  const origin = worldToScreen(rect, viewport);
  return { x: origin.x, y: origin.y, width: rect.width * viewport.zoom, height: rect.height * viewport.zoom };
}

/** Returns a viewport with the world point below `screenPoint` fixed while zooming. */
export function zoomViewportAroundScreenPoint(
  viewport: CanvasViewport,
  screenPoint: CanvasPoint,
  zoom: number,
): CanvasViewport {
  const worldPoint = screenToWorld(screenPoint, viewport);
  return {
    ...viewport,
    zoom,
    pan: {
      x: screenPoint.x - viewport.origin.x - worldPoint.x * zoom,
      y: screenPoint.y - viewport.origin.y - worldPoint.y * zoom,
    },
  };
}

/** Converts a fixed-size screen hit target to its current world-space radius. */
export function screenToleranceToWorld(screenPixels: number, viewport: Pick<CanvasViewport, "zoom">): number {
  return screenPixels / viewport.zoom;
}
