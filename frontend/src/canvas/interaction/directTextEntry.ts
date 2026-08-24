import type { CanvasPoint, ViewportRect } from "../../appTypes";
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_BLOCK_WIDTH,
  TEXT_BLOCK_HEADER_HEIGHT,
} from "../../constants";
import { MAX_CANVAS_VALUE, isSafeCanvasCoordinate } from "../model/connectorBinding";
import { isPersistableShapeRect } from "./primitiveGeometry";

const TEXT_BLOCK_BORDER_WIDTH = 1;
const TEXT_BLOCK_CONTENT_PADDING_LEFT = 10;
const TEXT_BLOCK_CONTENT_PADDING_TOP = 5;

export type DirectTextDraftRect = Readonly<{
  height: number;
  width: number;
  x: number;
  y: number;
}>;

export type DirectTextEntryAvailability = Readonly<{
  activeTool: string;
  hasConnectorChooser: boolean;
  hasDirectDraft: boolean;
  hasPendingImage: boolean;
  isCanvasAuthoringAvailable: boolean;
  isEditingText: boolean;
  isModalOrOverlayOpen: boolean;
  source: "keyboard" | "pointer";
}>;

/** Single state contract for advertised and authoritative direct text entry. */
export function canStartDirectTextEntry({
  activeTool,
  hasConnectorChooser,
  hasDirectDraft,
  hasPendingImage,
  isCanvasAuthoringAvailable,
  isEditingText,
  isModalOrOverlayOpen,
  source,
}: DirectTextEntryAvailability) {
  return isCanvasAuthoringAvailable
    && !hasConnectorChooser
    && !hasDirectDraft
    && !hasPendingImage
    && !isEditingText
    && !isModalOrOverlayOpen
    && (source === "pointer" ? activeTool === "select" : activeTool === "text");
}

/** Places the first editable caret exactly at a world-space canvas point. */
export function getDirectTextDraftRect(
  caretPoint: CanvasPoint,
): DirectTextDraftRect | null {
  const rect = {
    height: DEFAULT_BLOCK_HEIGHT,
    width: DEFAULT_BLOCK_WIDTH,
    x: caretPoint.x - TEXT_BLOCK_BORDER_WIDTH - TEXT_BLOCK_CONTENT_PADDING_LEFT,
    y:
      caretPoint.y -
      TEXT_BLOCK_BORDER_WIDTH -
      TEXT_BLOCK_HEADER_HEIGHT -
      TEXT_BLOCK_CONTENT_PADDING_TOP,
  };

  return isPersistableShapeRect(rect) ? rect : null;
}

/** Returns a safe keyboard insertion point centered in the visible viewport. */
export function getDefaultKeyboardTextCaretPoint(
  viewport: ViewportRect,
): CanvasPoint | null {
  if (
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  const center = {
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
  };
  if (!isSafeCanvasCoordinate(center.x) || !isSafeCanvasCoordinate(center.y)) {
    return null;
  }

  const desired = getDirectTextDraftRect(center);
  if (desired) return center;

  const x = Math.max(
    -MAX_CANVAS_VALUE,
    Math.min(
      MAX_CANVAS_VALUE - DEFAULT_BLOCK_WIDTH,
      center.x - TEXT_BLOCK_BORDER_WIDTH - TEXT_BLOCK_CONTENT_PADDING_LEFT,
    ),
  );
  const y = Math.max(
    -MAX_CANVAS_VALUE,
    Math.min(
      MAX_CANVAS_VALUE - DEFAULT_BLOCK_HEIGHT,
      center.y -
        TEXT_BLOCK_BORDER_WIDTH -
        TEXT_BLOCK_HEADER_HEIGHT -
        TEXT_BLOCK_CONTENT_PADDING_TOP,
    ),
  );
  const caretPoint = {
    x: x + TEXT_BLOCK_BORDER_WIDTH + TEXT_BLOCK_CONTENT_PADDING_LEFT,
    y:
      y +
      TEXT_BLOCK_BORDER_WIDTH +
      TEXT_BLOCK_HEADER_HEIGHT +
      TEXT_BLOCK_CONTENT_PADDING_TOP,
  };

  return getDirectTextDraftRect(caretPoint) ? caretPoint : null;
}
