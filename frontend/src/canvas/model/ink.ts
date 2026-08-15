import type { CanvasColor, InkElement, InkPoint } from "./elements";

export type RawInkPoint = Readonly<{ x: number; y: number; pressure: number }>;

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
  const valid = points.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
  );
  if (valid.length === 0) {
    throw new Error("An ink stroke requires at least one finite point.");
  }
  const unique: RawInkPoint[] = [];
  for (const point of valid) {
    const previous = unique[unique.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.1) {
      unique.push(point);
    }
  }
  const padded = Math.max(2, brushSize * 1.5);
  const minX = Math.min(...unique.map((point) => point.x)) - padded;
  const minY = Math.min(...unique.map((point) => point.y)) - padded;
  const maxX = Math.max(...unique.map((point) => point.x)) + padded;
  const maxY = Math.max(...unique.map((point) => point.y)) + padded;
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
