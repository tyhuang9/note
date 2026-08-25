import type { CanvasPoint } from "./geometry";

export type ConnectorArrowheadPosition = "start" | "end";

export const CONNECTOR_ARROWHEAD_LENGTH = 12;
export const CONNECTOR_ARROWHEAD_HALF_WIDTH = 5;

/**
 * Returns the filled triangular geometry used by SVG and canvas connector
 * renderers. `start` to `end` is the connector's authored direction.
 */
export function getConnectorArrowheadPoints(
  start: Readonly<CanvasPoint>,
  end: Readonly<CanvasPoint>,
  position: ConnectorArrowheadPosition,
  visualScale = 1,
  length = CONNECTOR_ARROWHEAD_LENGTH,
  halfWidth = CONNECTOR_ARROWHEAD_HALF_WIDTH,
): [[number, number], [number, number], [number, number]] | null {
  const tip = position === "start" ? start : end;
  const opposite = position === "start" ? end : start;
  const dx = tip.x - opposite.x;
  const dy = tip.y - opposite.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 0.01) return null;
  const scale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1;
  const unitX = dx / distance;
  const unitY = dy / distance;
  const baseDistance = Math.min(length * scale, distance * 0.45);
  const scaledHalfWidth = halfWidth * scale;
  const baseX = tip.x - unitX * baseDistance;
  const baseY = tip.y - unitY * baseDistance;
  return [
    [tip.x, tip.y],
    [baseX + unitY * scaledHalfWidth, baseY - unitX * scaledHalfWidth],
    [baseX - unitY * scaledHalfWidth, baseY + unitX * scaledHalfWidth],
  ];
}

/** Extra paint extent beyond the stroke used for conservative hit and bounds checks. */
export function getConnectorArrowheadPaintPadding(strokeWidth: number, roughness: number) {
  return Math.max(
    0,
    strokeWidth / 2,
    CONNECTOR_ARROWHEAD_HALF_WIDTH,
    Number.isFinite(roughness) ? roughness * 2 : 0,
  );
}
