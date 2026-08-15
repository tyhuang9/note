import { getStroke } from "perfect-freehand";
import type { InkElement } from "../model/elements";

export type StrokeOutlinePoint = readonly [number, number];

export function getInkOutline(element: Pick<InkElement, "points" | "brush">): StrokeOutlinePoint[] {
  return getStroke(
    element.points.map(([x, y, pressure]) => [x, y, pressure]),
    {
      last: true,
      simulatePressure: element.brush.simulatePressure,
      size: element.brush.size,
      smoothing: element.brush.smoothing,
      streamline: element.brush.streamline,
      thinning: element.brush.thinning,
    },
  );
}

/** Deterministic SVG path encoding for a perfect-freehand outline. */
export function outlineToSvgPath(outline: readonly StrokeOutlinePoint[]): string {
  if (outline.length === 0) return "";
  if (outline.length === 1) return `M ${outline[0][0]} ${outline[0][1]} Z`;
  return `${outline.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ")} Z`;
}

export function inkPath(element: Pick<InkElement, "points" | "brush">): string {
  return outlineToSvgPath(getInkOutline(element));
}
