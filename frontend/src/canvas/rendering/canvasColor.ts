import type { CanvasColor } from "../model/elements";

/** Resolves persisted canvas colors to the same theme-aware CSS tokens used by element views. */
export function canvasColorToCss(color: CanvasColor): string {
  if (color.kind === "fixed") return color.value;
  return color.token === "muted"
    ? "var(--workbench-text-secondary)"
    : "var(--canvas-tool-text)";
}
