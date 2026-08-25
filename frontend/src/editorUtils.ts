import type { BoxCanvasElement } from "./canvas/model/elements";
import type { AppData } from "./types";
import type { InteractionMode, OffscreenGroup, SelectionRect, SelectionState, ViewportRect } from "./appTypes";

export const emptyData: AppData = {
  folders: [],
  pages: [],
  elements: [],
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

function eventTargetElement(target: EventTarget | null): Element | null {
  if (typeof Element !== "undefined" && target instanceof Element) {
    return target;
  }

  return typeof Node !== "undefined" && target instanceof Node
    ? target.parentElement
    : null;
}

const TEXT_ENTRY_ROLE_SELECTOR = [
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="spinbutton"]',
].join(", ");

const TEXT_ENTRY_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  TEXT_ENTRY_ROLE_SELECTOR,
].join(", ");

const CANVAS_TOOL_SHORTCUT_EXCLUSION_SELECTOR = [
  ".connector-endpoint-chooser",
  ".slash-command-popup",
  '[role="dialog"]',
  '[aria-modal="true"]',
].join(", ");

const CANVAS_TOOL_SHORTCUT_CONTEXT_SELECTOR = [
  ".canvas-tool-palette",
  ".drawing-properties-panel",
  "[data-canvas-element-id]",
  "[data-block-id]",
  "[data-selection-frame]",
].join(", ");

export function isTextEntryTarget(target: EventTarget | null) {
  const element = eventTargetElement(target);

  if (!element) {
    return false;
  }

  return (
    (element instanceof HTMLElement && element.isContentEditable) ||
    element.matches(TEXT_ENTRY_SELECTOR) ||
    element.closest(TEXT_ENTRY_SELECTOR) !== null
  );
}

type CanvasToolShortcutContext = Readonly<{
  activeElement: Element | null;
  canvasElement: HTMLElement | null;
  hasCanvasKeyboardOwnership: boolean;
  isCanvasAuthoringAvailable: boolean;
  isModalOrOverlayOpen: boolean;
  isTextEditing: boolean;
  target: EventTarget | null;
}>;

type CanvasToolShortcutEvent = Readonly<Pick<KeyboardEvent,
  "altKey" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "repeat"
>>;

/**
 * Restricts bare drawing-tool shortcuts to the active canvas while leaving all
 * editable controls, modal surfaces, and browser-modified shortcuts alone.
 */
export function hasCanvasToolShortcutContext(
  event: CanvasToolShortcutEvent,
  context: CanvasToolShortcutContext,
) {
  if (
    !context.canvasElement ||
    !context.isCanvasAuthoringAvailable ||
    context.isModalOrOverlayOpen ||
    context.isTextEditing ||
    event.isComposing ||
    event.key === "Process" ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    isTextEntryTarget(context.target) ||
    isTextEntryTarget(context.activeElement)
  ) {
    return false;
  }

  const target = eventTargetElement(context.target);
  const activeElement = context.activeElement;
  const isCanvasDomContext = (element: Element | null) => Boolean(
    element && (
      element === context.canvasElement ||
      context.canvasElement?.contains(element) ||
      element.closest(CANVAS_TOOL_SHORTCUT_CONTEXT_SELECTOR)
    ),
  );
  const isExcluded = (element: Element | null) => Boolean(
    element?.closest(CANVAS_TOOL_SHORTCUT_EXCLUSION_SELECTOR),
  );

  if (isExcluded(target) || isExcluded(activeElement)) {
    return false;
  }

  return (
    context.hasCanvasKeyboardOwnership ||
    isCanvasDomContext(target) ||
    isCanvasDomContext(activeElement)
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
  block: Pick<BoxCanvasElement, "height" | "width" | "x" | "y">,
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
