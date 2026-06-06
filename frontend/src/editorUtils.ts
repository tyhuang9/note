import type { AppData, TextBlock } from "./types";
import type { InteractionMode, OffscreenGroup, SelectionRect, SelectionState, ViewportRect } from "./appTypes";

export const emptyData: AppData = {
  folders: [],
  pages: [],
  blocks: [],
  isDarkMode: false,
};

export const modeLabels: Record<InteractionMode, string> = {
  canvas: "Canvas selected",
  selected: "Textbox selected",
  editing: "Textbox editing",
  dragging: "Textbox dragging",
  resizing: "Textbox resizing",
  selecting: "Canvas selecting",
  panning: "Canvas panning",
};

export function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

export function blurActiveTextEntry() {
  if (isTextEntryTarget(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
  }
}

export function getSelectionRect(selection: SelectionState): SelectionRect {
  const x = Math.min(selection.startX, selection.currentX);
  const y = Math.min(selection.startY, selection.currentY);
  const width = Math.abs(selection.currentX - selection.startX);
  const height = Math.abs(selection.currentY - selection.startY);

  return { x, y, width, height };
}

export function rectsIntersect(first: SelectionRect, second: SelectionRect) {
  const intersectionWidth =
    Math.min(first.x + first.width, second.x + second.width) -
    Math.max(first.x, second.x);
  const intersectionHeight =
    Math.min(first.y + first.height, second.y + second.height) -
    Math.max(first.y, second.y);

  return (
    intersectionWidth > 0 &&
    intersectionHeight > 0 &&
    intersectionWidth * intersectionHeight >= 16
  );
}

export function getOffscreenDirection(
  block: Pick<TextBlock, "height" | "width" | "x" | "y">,
  viewport: ViewportRect,
): OffscreenGroup["direction"] | null {
  if (
    rectsIntersect(viewport, {
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
    })
  ) {
    return null;
  }

  const viewportCenter = {
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
  };
  const blockCenter = {
    x: block.x + block.width / 2,
    y: block.y + block.height / 2,
  };
  const deltaX = blockCenter.x - viewportCenter.x;
  const deltaY = blockCenter.y - viewportCenter.y;
  const horizontal =
    Math.abs(deltaX) > viewport.width * 0.22 ? (deltaX > 0 ? "e" : "w") : "";
  const vertical =
    Math.abs(deltaY) > viewport.height * 0.22 ? (deltaY > 0 ? "s" : "n") : "";
  const fallback =
    Math.abs(deltaX) > Math.abs(deltaY)
      ? deltaX > 0
        ? "e"
        : "w"
      : deltaY > 0
        ? "s"
        : "n";

  const direction = `${vertical}${horizontal}`;

  return direction
    ? (direction as OffscreenGroup["direction"])
    : (fallback as OffscreenGroup["direction"]);
}
