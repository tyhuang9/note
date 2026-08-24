import type { JSONContent } from "@tiptap/core";

export type ElementId = string;
export type PageId = string;
export type GroupId = string;
export type CanvasElementType = "text" | "image" | "ink" | "shape" | "connector";
export type CanvasColor =
  | { kind: "theme"; token: "foreground" | "muted" }
  | { kind: "fixed"; value: string };
export type TextBackgroundMode = "surface" | "transparent";
/** Shared persisted text tokens. Connector labels deliberately use the same bounded set. */
export type TextFontFamily = "system-ui" | "Arial" | "Georgia" | "Times New Roman" | "Courier New";
export type TextFontSize = "12px" | "14px" | "16px" | "18px" | "24px" | "32px";
export type ConnectorLabelOrientation = "upright" | "follow";
export type ConnectorLabelStyle = {
  orientation: ConnectorLabelOrientation;
  fontFamily: TextFontFamily;
  fontSize: TextFontSize;
  color: CanvasColor;
};

export type ElementBase<TType extends CanvasElementType> = {
  id: ElementId; pageId: PageId; type: TType; zIndex: number; opacity: number;
  locked: boolean; groupId?: GroupId; createdAt: number; updatedAt: number;
};
export type BoxGeometry = { x: number; y: number; width: number; height: number; rotation: number };
export type BoxCanvasElement = ElementBase<CanvasElementType> & BoxGeometry;
export type TextElement = ElementBase<"text"> & BoxGeometry & {
  backgroundMode: TextBackgroundMode;
  content: string;
  richContent?: JSONContent;
  /** Optional user-authored frame height. Omitted text boxes continue to auto-size. */
  manualHeight?: number;
  isWidthManuallyResized?: boolean;
};
export type RichTextValue = {
  content: string;
  richContent?: JSONContent;
};
export type ImageElement = ElementBase<"image"> & BoxGeometry & { assetId: string; fileName?: string; altText?: string; naturalWidth: number; naturalHeight: number; fit: "contain" };
export type InkPoint = [x: number, y: number, pressure: number];
export type InkElement = ElementBase<"ink"> & BoxGeometry & { points: InkPoint[]; brush: { kind: "pen" | "highlighter"; color: CanvasColor; size: number; opacity: number; thinning: number; smoothing: number; streamline: number; simulatePressure: boolean } };
export type RoughStyle = {
  fillColor?: CanvasColor | null;
  roughness: number;
  roundness: number;
  seed: number;
  strokeColor: CanvasColor;
  strokeStyle: "solid" | "dashed" | "dotted";
  strokeWidth: number;
};
export type ShapeElement = ElementBase<"shape"> & BoxGeometry & {
  shape: "rectangle" | "ellipse" | "diamond";
  style: RoughStyle;
  text?: RichTextValue;
};
export type PerimeterAnchor = { t: number };
export type ConnectorEndpoint =
  | { kind: "free"; x: number; y: number }
  | { kind: "element"; targetElementId: ElementId; gap: number; anchor?: PerimeterAnchor }
  | { kind: "group"; targetGroupId: GroupId; anchor: PerimeterAnchor; gap: number }
  | { kind: "connector"; targetConnectorId: ElementId; pathT: number; gap: number };
export type ConnectorElement = ElementBase<"connector"> & {
  start: ConnectorEndpoint; end: ConnectorEndpoint; routing: "straight";
  style: RoughStyle & { startArrowhead: "none" | "arrow"; endArrowhead: "none" | "arrow" };
  /** `semantic.label` is the canonical persisted one-line arrow label. */
  semantic?: { relationshipType?: string; label?: string };
  /** Optional for backward compatibility; omitted styles render with defaults. */
  labelStyle?: ConnectorLabelStyle;
};
export type CanvasElement = TextElement | ImageElement | InkElement | ShapeElement | ConnectorElement;

export function isBoxCanvasElement(element: CanvasElement): element is CanvasElement & BoxCanvasElement {
  return "x" in element && "y" in element && "width" in element && "height" in element;
}
export function isTextElement(element: CanvasElement): element is TextElement { return element.type === "text"; }
export function isImageElement(element: CanvasElement): element is ImageElement { return element.type === "image"; }
