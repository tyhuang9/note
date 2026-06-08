import type { TextBlock } from "./types";

export type InteractionMode =
  | "canvas"
  | "selected"
  | "editing"
  | "dragging"
  | "resizing"
  | "selecting"
  | "panning";

export type PanOffset = {
  x: number;
  y: number;
};

export type PageViewport = {
  panOffset: PanOffset;
  zoomLevel: number;
};

export type CanvasPoint = {
  x: number;
  y: number;
};

export type PanState = {
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
  currentPanX: number;
  currentPanY: number;
};

export type SelectionState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  didMove: boolean;
};

export type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InsertionPoint = {
  x: number;
  y: number;
};

export type CanvasSize = {
  width: number;
  height: number;
};

export type OffscreenGroup = {
  direction: "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
  count: number;
};

export type SearchMatch = {
  blockId: string;
  end: number;
  start: number;
};

export type ViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BlockUpdates = Partial<
  Pick<
    TextBlock,
    | "content"
    | "height"
    | "imageData"
    | "imageName"
    | "isWidthManuallyResized"
    | "width"
    | "x"
    | "y"
  >
>;

export type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
