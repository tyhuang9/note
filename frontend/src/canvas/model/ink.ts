import type { CanvasColor, InkElement, InkPoint } from "./elements";

export type RawInkPoint = Readonly<{ x: number; y: number; pressure: number }>;
export const MAX_INK_POINTS = 20_000;

export const PEN_BRUSH = {
  color: { kind: "theme", token: "foreground" } as CanvasColor,
  kind: "pen" as const,
  opacity: 1,
  simulatePressure: true,
  size: 4,
  smoothing: 0.5,
  streamline: 0.45,
  thinning: 0.45,
};

export const HIGHLIGHTER_BRUSH = {
  color: { kind: "fixed", value: "#f4c542" } as CanvasColor,
  kind: "highlighter" as const,
  opacity: 0.38,
  simulatePressure: false,
  size: 18,
  smoothing: 0.5,
  streamline: 0.45,
  thinning: 0.1,
};

export function normalizePressure(value: number, simulatePressure: boolean): number {
  if (!Number.isFinite(value) || value <= 0) {
    return simulatePressure ? 0.5 : 0;
  }
  return Math.max(0, Math.min(1, value));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

/** Converts captured world points to a compact, move-friendly local stroke. */
export function normalizeInkGeometry(
  points: readonly RawInkPoint[],
  brushSize: number,
  simulatePressure = true,
): Pick<InkElement, "x" | "y" | "width" | "height" | "points"> {
  const unique: RawInkPoint[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const previous = unique[unique.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.1) {
      unique.push(point);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      if (unique.length === MAX_INK_POINTS) break;
    }
  }
  if (unique.length === 0) {
    throw new Error("An ink stroke requires at least one finite point.");
  }
  const padded = Math.max(2, brushSize * 1.5);
  minX -= padded;
  minY -= padded;
  maxX += padded;
  maxY += padded;
  const local: InkPoint[] = unique.map((point) => [
    round(point.x - minX),
    round(point.y - minY),
    normalizePressure(point.pressure, simulatePressure),
  ]);
  return {
    height: round(Math.max(1, maxY - minY)),
    points: local,
    width: round(Math.max(1, maxX - minX)),
    x: round(minX),
    y: round(minY),
  };
}

export function scaleInkElement(element: InkElement, ratio: number): InkElement {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return {
    ...element,
    brush: { ...element.brush, size: round(element.brush.size * safeRatio) },
    height: round(element.height * safeRatio),
    points: element.points.map(([x, y, pressure]) => [round(x * safeRatio), round(y * safeRatio), pressure]),
    width: round(element.width * safeRatio),
  };
}
