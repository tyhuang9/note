import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import type { AppData, TextBlock } from "./types";

const DEFAULT_BLOCK_WIDTH = 220;
const DEFAULT_BLOCK_HEIGHT = 54;
const MIN_BLOCK_WIDTH = 140;
const MIN_BLOCK_HEIGHT = 54;
const AUTO_WIDTH_RIGHT_PADDING = 8;
const TEXT_BLOCK_HEADER_HEIGHT = 12;
const TEXT_COMMIT_DELAY_MS = 500;
const SAVE_DELAY_MS = 500;
const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

type InteractionMode =
  | "canvas"
  | "selected"
  | "editing"
  | "dragging"
  | "resizing"
  | "selecting"
  | "panning";

type PanOffset = {
  x: number;
  y: number;
};

type CanvasPoint = {
  x: number;
  y: number;
};

const emptyData: AppData = {
  folders: [],
  pages: [],
  blocks: [],
  isDarkMode: false,
};

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

function blurActiveTextEntry() {
  if (isTextEntryTarget(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
  }
}

type DragState = {
  canvasLeft: number;
  canvasTop: number;
  panX: number;
  panY: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  rafId: number | null;
  translateX: number;
  translateY: number;
};

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type ResizeState = {
  direction: ResizeDirection;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  currentX: number;
  currentY: number;
  currentWidth: number;
  currentHeight: number;
  rafId: number | null;
};

type PanState = {
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
};

type SelectionState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  didMove: boolean;
};

type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type InsertionPoint = {
  x: number;
  y: number;
};

type GroupDragOffset = {
  blockIds: string[];
  originId: string;
  x: number;
  y: number;
};

type CanvasSize = {
  width: number;
  height: number;
};

type OffscreenGroup = {
  direction: "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
  count: number;
};

type SearchMatch = {
  blockId: string;
  end: number;
  start: number;
};

type ViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BlockUpdates = Partial<
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

const modeLabels: Record<InteractionMode, string> = {
  canvas: "Canvas selected",
  selected: "Textbox selected",
  editing: "Textbox editing",
  dragging: "Textbox dragging",
  resizing: "Textbox resizing",
  selecting: "Canvas selecting",
  panning: "Canvas panning",
};

function getSelectionRect(selection: SelectionState): SelectionRect {
  const x = Math.min(selection.startX, selection.currentX);
  const y = Math.min(selection.startY, selection.currentY);
  const width = Math.abs(selection.currentX - selection.startX);
  const height = Math.abs(selection.currentY - selection.startY);

  return { x, y, width, height };
}

function rectsIntersect(first: SelectionRect, second: SelectionRect) {
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

function getOffscreenDirection(
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

type InlineRenameProps = {
  ariaLabel: string;
  initialValue: string;
  onCancel: () => void;
  onCommit: (value: string) => void;
};

function InlineRename({
  ariaLabel,
  initialValue,
  onCancel,
  onCommit,
}: InlineRenameProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const didCancel = useRef(false);
  const didCommit = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function commit(value: string) {
    if (didCancel.current || didCommit.current) {
      return;
    }

    didCommit.current = true;
    onCommit(value);
  }

  return (
    <input
      aria-label={ariaLabel}
      autoFocus
      className="inline-input"
      defaultValue={initialValue}
      onBlur={(event) => commit(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        }

        if (event.key === "Escape") {
          didCancel.current = true;
          onCancel();
        }
      }}
      ref={inputRef}
    />
  );
}

type TextBlockViewProps = {
  block: TextBlock;
  canvasRef: React.RefObject<HTMLElement | null>;
  activeSearchRange: SearchMatch | null;
  isEditing: boolean;
  isMultiSelected: boolean;
  isSelected: boolean;
  searchQuery: string;
  shouldFocusEnd: boolean;
  onEditEnd: () => void;
  onDelete: (blockId: string) => void;
  onEdit: (blockId: string) => void;
  onCanvasPanEnd: (event: React.PointerEvent<HTMLElement>) => void;
  onCanvasPanMove: (event: React.PointerEvent<HTMLElement>) => void;
  onCanvasPanStart: (event: React.PointerEvent<HTMLElement>) => void;
  onFocusEndHandled: () => void;
  onGroupDragEnd: (originId: string, offset: PanOffset) => void;
  onGroupDragPreview: (originId: string, offset: PanOffset) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onSelect: (blockId: string) => void;
  onUpdate: (blockId: string, updates: BlockUpdates) => void;
  groupDragOffset: GroupDragOffset | null;
  panOffset: PanOffset;
  zoomLevel: number;
};

const TextBlockView = memo(function TextBlockView({
  block,
  canvasRef,
  activeSearchRange,
  isEditing,
  isMultiSelected,
  isSelected,
  searchQuery,
  shouldFocusEnd,
  onEditEnd,
  onDelete,
  onEdit,
  onCanvasPanEnd,
  onCanvasPanMove,
  onCanvasPanStart,
  onFocusEndHandled,
  onGroupDragEnd,
  onGroupDragPreview,
  onInteractionModeChange,
  onSelect,
  onUpdate,
  groupDragOffset,
  panOffset,
  zoomLevel,
}: TextBlockViewProps) {
  const blockRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const displayRef = useRef<HTMLDivElement | null>(null);
  const widthMeasureRef = useRef<HTMLDivElement | null>(null);
  const heightMeasureRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const ctrlAStage = useRef(0);
  const hasManualWidth = useRef(Boolean(block.isWidthManuallyResized));
  const pendingCaretOffset = useRef<number | null>(null);
  const [draftContent, setDraftContent] = useState(block.content);
  const [isContentSelected, setIsContentSelected] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    setDraftContent(block.content);
  }, [block.content, block.id]);

  useEffect(() => {
    hasManualWidth.current = Boolean(block.isWidthManuallyResized);
  }, [block.id, block.isWidthManuallyResized]);

  useEffect(() => {
    if (isEditing) {
      const editorElement = editorRef.current;

      editorElement?.focus();

      if (editorElement && pendingCaretOffset.current !== null) {
        const caretPosition = Math.min(
          editorElement.value.length,
          pendingCaretOffset.current,
        );

        window.requestAnimationFrame(() => {
          editorElement.setSelectionRange(caretPosition, caretPosition);
          pendingCaretOffset.current = null;
        });
        return;
      }

      if (shouldFocusEnd && editorElement) {
        const caretPosition = editorElement.value.length;

        window.requestAnimationFrame(() => {
          editorElement.setSelectionRange(caretPosition, caretPosition);
          onFocusEndHandled();
        });
      }
    }
  }, [isEditing, onFocusEndHandled, shouldFocusEnd]);

  useEffect(() => {
    const blockElement = blockRef.current;
    const editorElement = editorRef.current;

    if (!blockElement || !editorElement) {
      return;
    }

    const size = getAutoSize();

    blockElement.style.width = `${size.width}px`;
    blockElement.style.height = `${size.height}px`;
  }, [block.isWidthManuallyResized, block.width, draftContent]);

  useEffect(() => {
    if (draftContent === block.content) {
      return;
    }

    const commitTimer = window.setTimeout(() => {
      onUpdate(block.id, { content: draftContent, ...getAutoSize() });
    }, TEXT_COMMIT_DELAY_MS);

    return () => window.clearTimeout(commitTimer);
  }, [
    block.content,
    block.id,
    block.isWidthManuallyResized,
    block.width,
    draftContent,
    onUpdate,
  ]);

  function getSizeUpdates() {
    const size = getAutoSize();
    const updates: BlockUpdates = {};

    if (size.width !== block.width) {
      updates.width = size.width;
    }

    if (size.height !== block.height) {
      updates.height = size.height;
    }

    return updates;
  }

  function getAutoSize(widthOverride?: number, forceFixedWidth = false) {
    if (block.imageData) {
      return {
        width: Math.max(MIN_BLOCK_WIDTH, block.width),
        height: Math.max(MIN_BLOCK_HEIGHT, block.height),
      };
    }

    const widthMeasureElement = widthMeasureRef.current;
    const heightMeasureElement = heightMeasureRef.current;
    const nextWidth = widthOverride ?? block.width;

    if (!widthMeasureElement || !heightMeasureElement) {
      return {
        width: Math.max(MIN_BLOCK_WIDTH, block.width),
        height: Math.max(MIN_BLOCK_HEIGHT, block.height),
      };
    }

    const measuredWidth = hasManualWidth.current || forceFixedWidth
      ? Math.max(MIN_BLOCK_WIDTH, nextWidth)
      : Math.max(
          DEFAULT_BLOCK_WIDTH,
          MIN_BLOCK_WIDTH,
          Math.ceil(widthMeasureElement.scrollWidth) + AUTO_WIDTH_RIGHT_PADDING,
          nextWidth,
        );

    heightMeasureElement.style.width = `${measuredWidth}px`;

    const measuredHeight = Math.max(
      heightMeasureElement.scrollHeight,
      Math.ceil(heightMeasureElement.getBoundingClientRect().height),
    );

    return {
      width: measuredWidth,
      height: Math.max(
        MIN_BLOCK_HEIGHT,
        measuredHeight + TEXT_BLOCK_HEADER_HEIGHT,
      ),
    };
  }

  function getAutoHeight(widthOverride?: number, forceFixedWidth = false) {
    return getAutoSize(widthOverride, forceFixedWidth).height;
  }

  function getMeasureText() {
    return draftContent.length > 0 ? draftContent : " ";
  }

  function selectCurrentLine(editorElement: HTMLTextAreaElement) {
    const cursorPosition = editorElement.selectionStart;
    const lineStart = editorElement.value.lastIndexOf("\n", cursorPosition - 1) + 1;
    const nextLineBreak = editorElement.value.indexOf("\n", cursorPosition);
    const lineEnd =
      nextLineBreak === -1 ? editorElement.value.length : nextLineBreak;

    editorElement.setSelectionRange(lineStart, lineEnd);
  }

  function renderHighlightedContent() {
    const nextQuery = searchQuery.trim();

    if (!nextQuery) {
      return draftContent;
    }

    const escapedQuery = nextQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const queryRegex = new RegExp(`(${escapedQuery})`, "gi");

    let cursor = 0;

    return draftContent.split(queryRegex).map((part, index) => {
      const start = cursor;

      cursor += part.length;

      if (part.toLowerCase() !== nextQuery.toLowerCase()) {
        return <span key={`${part}-${index}`}>{part}</span>;
      }

      return (
        <mark
          className={
            activeSearchRange?.start === start &&
            activeSearchRange.end === start + part.length
              ? "is-active-search-match"
              : undefined
          }
          key={`${part}-${index}`}
        >
          {part}
        </mark>
      );
    });
  }

  function getTextOffsetFromNode(
    container: HTMLElement,
    caretNode: Node,
    caretOffset: number,
  ) {
    const textWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let textOffset = 0;
    let currentNode = textWalker.nextNode();

    while (currentNode) {
      if (currentNode === caretNode) {
        return textOffset + caretOffset;
      }

      if (
        caretNode.nodeType === Node.ELEMENT_NODE &&
        caretNode.childNodes[caretOffset] &&
        currentNode.compareDocumentPosition(caretNode.childNodes[caretOffset]) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        return textOffset;
      }

      textOffset += currentNode.textContent?.length ?? 0;
      currentNode = textWalker.nextNode();
    }

    return textOffset;
  }

  function getCaretOffsetFromPoint(clientX: number, clientY: number) {
    const displayElement = displayRef.current;

    if (!displayElement) {
      return draftContent.length;
    }

    const caretPositionFromPoint = (
      document as Document & {
        caretPositionFromPoint?: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
      }
    ).caretPositionFromPoint;

    if (caretPositionFromPoint) {
      const caretPosition = caretPositionFromPoint.call(document, clientX, clientY);

      if (
        caretPosition &&
        displayElement.contains(caretPosition.offsetNode)
      ) {
        return getTextOffsetFromNode(
          displayElement,
          caretPosition.offsetNode,
          caretPosition.offset,
        );
      }
    }

    const caretRangeFromPoint = (
      document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      }
    ).caretRangeFromPoint;
    const caretRange = caretRangeFromPoint?.call(document, clientX, clientY);

    if (caretRange && displayElement.contains(caretRange.startContainer)) {
      return getTextOffsetFromNode(
        displayElement,
        caretRange.startContainer,
        caretRange.startOffset,
      );
    }

    return draftContent.length;
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.shiftKey) {
      onCanvasPanStart(event);
      return;
    }

    const canvasElement = canvasRef.current;

    if (!canvasElement) {
      return;
    }

    const canvasRect = canvasElement.getBoundingClientRect();

    dragState.current = {
      canvasLeft: canvasRect.left,
      canvasTop: canvasRect.top,
      panX: panOffset.x,
      panY: panOffset.y,
      offsetX:
        (event.clientX - canvasRect.left - panOffset.x) / zoomLevel - block.x,
      offsetY:
        (event.clientY - canvasRect.top - panOffset.y) / zoomLevel - block.y,
      startX: block.x,
      startY: block.y,
      currentX: block.x,
      currentY: block.y,
      rafId: null,
      translateX: 0,
      translateY: 0,
    };
    blurActiveTextEntry();
    setIsDragging(true);
    onSelect(block.id);
    onInteractionModeChange("dragging");
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveBlock(event: React.PointerEvent<HTMLDivElement>) {
    const currentDrag = dragState.current;
    const blockElement = blockRef.current;

    if (!currentDrag || !blockElement) {
      return;
    }

    event.preventDefault();

    const x =
      (event.clientX - currentDrag.canvasLeft - currentDrag.panX) / zoomLevel -
      currentDrag.offsetX;
    const y =
      (event.clientY - currentDrag.canvasTop - currentDrag.panY) / zoomLevel -
      currentDrag.offsetY;

    currentDrag.currentX = x;
    currentDrag.currentY = y;
    currentDrag.translateX = x - currentDrag.startX;
    currentDrag.translateY = y - currentDrag.startY;

    if (isSelected && isMultiSelected) {
      onGroupDragPreview(block.id, {
        x: currentDrag.translateX,
        y: currentDrag.translateY,
      });
    }

    if (currentDrag.rafId !== null) {
      return;
    }

    currentDrag.rafId = window.requestAnimationFrame(() => {
      if (!dragState.current || !blockRef.current) {
        return;
      }

      blockRef.current.style.transform = `translate3d(${dragState.current.translateX}px, ${dragState.current.translateY}px, 0)`;
      dragState.current.rafId = null;
    });
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const currentDrag = dragState.current;

    if (!currentDrag) {
      return;
    }

    if (currentDrag.rafId !== null) {
      window.cancelAnimationFrame(currentDrag.rafId);
    }

    if (blockRef.current) {
      blockRef.current.style.transform = "";
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    if (isSelected && isMultiSelected) {
      onGroupDragEnd(block.id, {
        x: currentDrag.translateX,
        y: currentDrag.translateY,
      });
    } else {
      onUpdate(block.id, {
        x: currentDrag.currentX,
        y: currentDrag.currentY,
      });
    }
    dragState.current = null;
    setIsDragging(false);
    onInteractionModeChange("selected");
  }

  function startResize(
    event: React.PointerEvent<HTMLDivElement>,
    direction: ResizeDirection,
  ) {
    event.stopPropagation();
    event.preventDefault();

    resizeState.current = {
      direction,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: block.x,
      startY: block.y,
      startWidth: block.width,
      startHeight: block.height,
      currentX: block.x,
      currentY: block.y,
      currentWidth: block.width,
      currentHeight: block.height,
      rafId: null,
    };
    hasManualWidth.current = true;
    setIsResizing(true);
    onSelect(block.id);
    onInteractionModeChange("resizing");
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeBlock(event: React.PointerEvent<HTMLDivElement>) {
    const currentResize = resizeState.current;
    const blockElement = blockRef.current;

    if (!currentResize || !blockElement) {
      return;
    }

    const deltaX = (event.clientX - currentResize.startClientX) / zoomLevel;
    let nextX = currentResize.startX;
    let nextY = currentResize.startY;
    let nextWidth = currentResize.startWidth;

    if (currentResize.direction.includes("w")) {
      const anchorRight = currentResize.startX + currentResize.startWidth;
      nextX = Math.min(anchorRight - MIN_BLOCK_WIDTH, currentResize.startX + deltaX);
      nextWidth = anchorRight - nextX;
    } else if (currentResize.direction.includes("e")) {
      nextWidth = Math.max(MIN_BLOCK_WIDTH, currentResize.startWidth + deltaX);
    }

    const nextHeight = getAutoHeight(nextWidth, true);

    currentResize.currentX = nextX;
    currentResize.currentY = nextY;
    currentResize.currentWidth = nextWidth;
    currentResize.currentHeight = nextHeight;

    if (currentResize.rafId !== null) {
      return;
    }

    currentResize.rafId = window.requestAnimationFrame(() => {
      if (!resizeState.current || !blockRef.current) {
        return;
      }

      blockRef.current.style.left = `${resizeState.current.currentX}px`;
      blockRef.current.style.top = `${resizeState.current.currentY}px`;
      blockRef.current.style.width = `${resizeState.current.currentWidth}px`;
      blockRef.current.style.height = `${resizeState.current.currentHeight}px`;
      resizeState.current.rafId = null;
    });
  }

  function endResize(event: React.PointerEvent<HTMLDivElement>) {
    const currentResize = resizeState.current;

    if (!currentResize) {
      return;
    }

    if (currentResize.rafId !== null) {
      window.cancelAnimationFrame(currentResize.rafId);
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    onUpdate(block.id, {
      x: currentResize.currentX,
      y: currentResize.currentY,
      width: currentResize.currentWidth,
      height: currentResize.currentHeight,
      isWidthManuallyResized: true,
    });
    resizeState.current = null;
    setIsResizing(false);
    onInteractionModeChange("selected");
  }

  return (
    <div
      className={`text-block ${isSelected ? "is-selected" : ""} ${
        isEditing ? "is-editing" : ""
      } ${
        isSelected && isMultiSelected ? "is-multi-selected" : ""
      } ${
        isSelected && !isEditing ? "is-canvas-mode" : ""
      } ${isDragging ? "is-dragging" : ""} ${
        isResizing ? "is-resizing" : ""
      } ${isContentSelected ? "is-content-selected" : ""
      }`}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEdit(block.id);
      }}
      onPointerDown={(event) => {
        if (event.shiftKey) {
          onCanvasPanStart(event);
          return;
        }

        if (event.target !== event.currentTarget) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        blurActiveTextEntry();
        setIsContentSelected(false);
        ctrlAStage.current = 0;
        onSelect(block.id);
      }}
      ref={blockRef}
      onPointerCancel={onCanvasPanEnd}
      onPointerMove={onCanvasPanMove}
      onPointerUp={onCanvasPanEnd}
      style={{
        left: block.x,
        top: block.y,
        transform:
          groupDragOffset &&
          groupDragOffset.originId !== block.id &&
          groupDragOffset.blockIds.includes(block.id)
            ? `translate3d(${groupDragOffset.x}px, ${groupDragOffset.y}px, 0)`
            : undefined,
        width: block.width,
        height: block.height,
      }}
    >
      <div
        aria-label="Select and move text block"
        className="text-block-header"
        onClick={(event) => {
          event.stopPropagation();
          blurActiveTextEntry();
          onSelect(block.id);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
        }}
        onPointerCancel={endDrag}
        onPointerDown={startDrag}
        onPointerMove={moveBlock}
        onPointerUp={endDrag}
        role="button"
        tabIndex={0}
      />
      <textarea
        aria-label="Text block"
        className="text-block-editor"
        hidden={!isEditing || Boolean(block.imageData)}
        onBlur={() => {
          ctrlAStage.current = 0;
          setIsContentSelected(false);

          const updates = getSizeUpdates();
          const nextContent = draftContent.trim();

          if (!nextContent) {
            onDelete(block.id);
            onEditEnd();
            return;
          }

          if (draftContent !== block.content) {
            updates.content = draftContent;
          }

          if (Object.keys(updates).length > 0) {
            onUpdate(block.id, updates);
          }

          onEditEnd();
        }}
        onChange={(event) => {
          ctrlAStage.current = 0;
          setIsContentSelected(false);
          setDraftContent(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();

            if (ctrlAStage.current === 0) {
              selectCurrentLine(event.currentTarget);
              setIsContentSelected(true);
              ctrlAStage.current = 1;
              return;
            }

            if (ctrlAStage.current === 1) {
              setIsContentSelected(false);
              ctrlAStage.current = 0;
              onSelect(block.id);
              onInteractionModeChange("selected");
              event.currentTarget.blur();
              return;
            }
          }
        }}
        onMouseDown={() => {
          ctrlAStage.current = 0;
          setIsContentSelected(false);
        }}
        onPointerDown={(event) => {
          if (event.shiftKey) {
            onCanvasPanStart(event);
          }
        }}
        ref={editorRef}
        value={draftContent}
      />
      {!isEditing && !block.imageData ? (
        <div
          className="text-block-display"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onEdit(block.id);
          }}
          onPointerDown={(event) => {
            if (event.shiftKey) {
              onCanvasPanStart(event);
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            pendingCaretOffset.current = getCaretOffsetFromPoint(
              event.clientX,
              event.clientY,
            );
          }}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          ref={displayRef}
        >
          {renderHighlightedContent()}
        </div>
      ) : null}
      {block.imageData ? (
        <img
          alt={block.imageName || "Pasted image"}
          className="text-block-image"
          onPointerDown={(event) => {
            if (event.shiftKey) {
              onCanvasPanStart(event);
            }
          }}
          src={block.imageData}
        />
      ) : null}
      {isSelected
        ? (["e"] as ResizeDirection[]).map(
            (direction) => (
              <div
                aria-label={`Resize text block ${direction}`}
                className={`resize-handle resize-${direction}`}
                key={direction}
                onPointerCancel={endResize}
                onPointerDown={(event) => startResize(event, direction)}
                onPointerMove={resizeBlock}
                onPointerUp={endResize}
                role="button"
                tabIndex={0}
              />
            ),
          )
        : null}
      {!block.imageData ? (
        <>
          <div
            aria-hidden="true"
            className="text-block-measurer text-block-width-measurer"
            ref={widthMeasureRef}
          >
            {getMeasureText()}
          </div>
          <div
            aria-hidden="true"
            className="text-block-measurer text-block-height-measurer"
            ref={heightMeasureRef}
          >
            {getMeasureText()}
          </div>
        </>
      ) : null}
    </div>
  );
});

function App() {
  const [data, setData] = useState<AppData>(emptyData);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [selectedPageId, setSelectedPageId] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [isEditingHeaderTitle, setIsEditingHeaderTitle] = useState(false);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<InteractionMode>("canvas");
  const [panOffset, setPanOffset] = useState<PanOffset>({ x: 0, y: 0 });
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [insertionPoint, setInsertionPoint] = useState<InsertionPoint | null>(null);
  const [groupDragOffset, setGroupDragOffset] = useState<GroupDragOffset | null>(null);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [focusEndBlockId, setFocusEndBlockId] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [persistenceAvailable, setPersistenceAvailable] = useState(false);
  const canvasRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const panState = useRef<PanState | null>(null);
  const selectionState = useRef<SelectionState | null>(null);
  const searchCache = useRef<Map<string, SearchMatch[]>>(new Map());

  const selectedPage = useMemo(
    () => data.pages.find((page) => page.id === selectedPageId),
    [data.pages, selectedPageId],
  );
  const visiblePages = useMemo(
    () => data.pages.filter((page) => page.folderId === selectedFolderId),
    [data.pages, selectedFolderId],
  );
  const visibleBlocks = useMemo(
    () => data.blocks.filter((block) => block.pageId === selectedPageId),
    [data.blocks, selectedPageId],
  );
  const pageCountsByFolder = useMemo(() => {
    const pageCounts = new Map<string, number>();

    for (const page of data.pages) {
      pageCounts.set(page.folderId, (pageCounts.get(page.folderId) ?? 0) + 1);
    }

    return pageCounts;
  }, [data.pages]);
  const searchMatches = useMemo<SearchMatch[]>(() => {
    const nextQuery = searchQuery.trim().toLowerCase();

    if (!nextQuery) {
      return [];
    }

    const cacheKey = `${selectedPageId}:${nextQuery}:${visibleBlocks
      .map((block) => `${block.id}:${block.x}:${block.y}:${block.content}`)
      .join("|")}`;
    const cachedMatches = searchCache.current.get(cacheKey);

    if (cachedMatches) {
      return cachedMatches;
    }

    const nextMatches = visibleBlocks
      .flatMap((block) => {
        const matches: SearchMatch[] = [];
        const content = block.content.toLowerCase();
        let start = content.indexOf(nextQuery);

        while (start !== -1) {
          matches.push({
            blockId: block.id,
            start,
            end: start + nextQuery.length,
          });
          start = content.indexOf(nextQuery, start + nextQuery.length);
        }

        return matches;
      })
      .sort((firstMatch, secondMatch) => {
        const firstBlock = visibleBlocks.find((block) => block.id === firstMatch.blockId);
        const secondBlock = visibleBlocks.find((block) => block.id === secondMatch.blockId);

        if (!firstBlock || !secondBlock) {
          return 0;
        }

        return (
          firstBlock.y - secondBlock.y ||
          firstBlock.x - secondBlock.x ||
          firstMatch.start - secondMatch.start
        );
      });

    searchCache.current.set(cacheKey, nextMatches);

    if (searchCache.current.size > 20) {
      const oldestKey = searchCache.current.keys().next().value;

      if (oldestKey) {
        searchCache.current.delete(oldestKey);
      }
    }

    return nextMatches;
  }, [searchQuery, selectedPageId, visibleBlocks]);
  const activeSearchMatch = searchMatches[activeSearchIndex] ?? null;
  const canvasViewport = useMemo<ViewportRect | null>(() => {
    if (canvasSize.width === 0 || canvasSize.height === 0) {
      return null;
    }

    return {
      x: -panOffset.x / zoomLevel,
      y: -panOffset.y / zoomLevel,
      width: canvasSize.width / zoomLevel,
      height: canvasSize.height / zoomLevel,
    };
  }, [canvasSize.height, canvasSize.width, panOffset.x, panOffset.y, zoomLevel]);
  const offscreenGroups = useMemo<OffscreenGroup[]>(() => {
    if (!canvasViewport || visibleBlocks.length === 0) {
      return [];
    }

    const counts = new Map<OffscreenGroup["direction"], number>();

    for (const block of visibleBlocks) {
      const direction = getOffscreenDirection(block, canvasViewport);

      if (!direction) {
        continue;
      }

      counts.set(direction, (counts.get(direction) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([direction, count]) => ({
      direction,
      count,
    }));
  }, [canvasViewport, visibleBlocks]);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      try {
        const savedData = await invoke<AppData>("load_app_data");

        if (!isMounted) {
          return;
        }

        const firstFolderId = savedData.folders[0]?.id ?? "";
        const firstPageId =
          savedData.pages.find((page) => page.folderId === firstFolderId)?.id ??
          "";

        setData(savedData);
        setIsDarkMode(Boolean(savedData.isDarkMode));
        setSelectedFolderId(firstFolderId);
        setSelectedPageId(firstPageId);
        setSelectedBlockIds([]);
        setEditingBlockId(null);
        setActiveMode("canvas");
        setInsertionPoint(null);
        setIsEditingHeaderTitle(false);
        setPersistenceAvailable(true);
      } catch (error) {
        console.warn("Could not load local note data.", error);
      } finally {
        if (isMounted) {
          setIsLoaded(true);
        }
      }
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [isSearchOpen]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [searchQuery, selectedPageId]);

  useEffect(() => {
    if (activeSearchIndex >= searchMatches.length) {
      setActiveSearchIndex(0);
    }
  }, [activeSearchIndex, searchMatches.length]);

  useEffect(() => {
    const canvasElement = canvasRef.current;

    if (!canvasElement) {
      return;
    }

    function updateCanvasSize() {
      setCanvasSize({
        width: canvasElement?.clientWidth ?? 0,
        height: canvasElement?.clientHeight ?? 0,
      });
    }

    updateCanvasSize();
    const resizeObserver = new ResizeObserver(updateCanvasSize);
    resizeObserver.observe(canvasElement);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!isLoaded || !persistenceAvailable) {
      return;
    }

    const saveTimer = window.setTimeout(() => {
      invoke("save_app_data", { data: { ...data, isDarkMode } }).catch((error) => {
        console.warn("Could not save local note data.", error);
      });
    }, SAVE_DELAY_MS);

    return () => window.clearTimeout(saveTimer);
  }, [data, isDarkMode, isLoaded, persistenceAvailable]);

  useEffect(() => {
    const shouldDisableSelection =
      activeMode === "dragging" ||
      activeMode === "resizing" ||
      activeMode === "selecting" ||
      activeMode === "panning";

    if (!shouldDisableSelection) {
      return;
    }

    document.body.classList.add("is-interacting");

    return () => document.body.classList.remove("is-interacting");
  }, [activeMode]);

  const deleteBlocks = useCallback((blockIds: string[]) => {
    const blockIdsToDelete = new Set(blockIds);

    setData((currentData) => ({
      ...currentData,
      blocks: currentData.blocks.filter(
        (block) => !blockIdsToDelete.has(block.id),
      ),
    }));
    setSelectedBlockIds((currentBlockIds) =>
      currentBlockIds.filter((blockId) => !blockIdsToDelete.has(blockId)),
    );
    setEditingBlockId((currentBlockId) =>
      currentBlockId && blockIdsToDelete.has(currentBlockId)
        ? null
        : currentBlockId,
    );
  }, []);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      if (editingBlockId || isTextEntryTarget(event.target)) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        updateZoom(ZOOM_STEP);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "-") {
        event.preventDefault();
        updateZoom(-ZOOM_STEP);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        setZoomLevel(DEFAULT_ZOOM);
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedBlockIds.length > 0
      ) {
        event.preventDefault();
        deleteBlocks(selectedBlockIds);
        setActiveMode("canvas");
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        if (visibleBlocks.length === 0) {
          return;
        }

        event.preventDefault();
        setSelectedBlockIds(visibleBlocks.map((block) => block.id));
        setEditingBlockId(null);
        setActiveMode("selected");
      }

      if (
        insertionPoint &&
        selectedPageId &&
        event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        createTextBlock(insertionPoint.x, insertionPoint.y, event.key);
        setInsertionPoint(null);
      }
    }

    document.addEventListener("keydown", handleKeyboard);

    return () => document.removeEventListener("keydown", handleKeyboard);
  }, [
    deleteBlocks,
    editingBlockId,
    insertionPoint,
    selectedBlockIds,
    selectedPageId,
    visibleBlocks,
  ]);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (!insertionPoint || !selectedPageId || isTextEntryTarget(event.target)) {
        return;
      }

      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const imageItem = clipboardItems.find((item) =>
        item.type.startsWith("image/"),
      );

      if (imageItem) {
        const imageFile = imageItem.getAsFile();

        if (!imageFile) {
          return;
        }

        event.preventDefault();
        const reader = new FileReader();

        reader.onload = () => {
          if (typeof reader.result !== "string") {
            return;
          }

          createImageBlock(
            insertionPoint.x,
            insertionPoint.y,
            reader.result,
            imageFile.name || "Pasted image",
          );
        };
        reader.readAsDataURL(imageFile);
        return;
      }

      const pastedText = event.clipboardData?.getData("text/plain");

      if (pastedText) {
        event.preventDefault();
        createTextBlock(insertionPoint.x, insertionPoint.y, pastedText);
      }
    }

    document.addEventListener("paste", handlePaste);

    return () => document.removeEventListener("paste", handlePaste);
  }, [insertionPoint, selectedPageId]);

  function getCanvasPoint(clientX: number, clientY: number): CanvasPoint | null {
    const canvasElement = canvasRef.current;

    if (!canvasElement) {
      return null;
    }

    const canvasRect = canvasElement.getBoundingClientRect();

    return {
      x: (clientX - canvasRect.left - panOffset.x) / zoomLevel,
      y: (clientY - canvasRect.top - panOffset.y) / zoomLevel,
    };
  }

  function updateZoom(delta: number) {
    setZoomLevel((currentZoom) =>
      Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom + delta)),
    );
  }

  function createFolder() {
    const folderId = createId("folder");

    setData((currentData) => ({
      ...currentData,
      folders: [...currentData.folders, { id: folderId, name: "New folder" }],
    }));
    setSelectedFolderId(folderId);
    setSelectedPageId("");
    setEditingFolderId(folderId);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function renameFolder(folderId: string, name: string) {
    const nextName = name.trim();

    if (!nextName) {
      return;
    }

    setData((currentData) => ({
      ...currentData,
      folders: currentData.folders.map((folder) =>
        folder.id === folderId ? { ...folder, name: nextName } : folder,
      ),
    }));
  }

  function deleteFolder(folderId: string) {
    setData((currentData) => {
      const nextFolders = currentData.folders.filter(
        (folder) => folder.id !== folderId,
      );
      const deletedPageIds = new Set(
        currentData.pages
          .filter((page) => page.folderId === folderId)
          .map((page) => page.id),
      );
      const nextPages = currentData.pages.filter(
        (page) => page.folderId !== folderId,
      );
      const nextFolderId = nextFolders[0]?.id ?? "";
      const nextSelectedPageId =
        nextPages.find((page) => page.folderId === nextFolderId)?.id ?? "";

      setSelectedFolderId(nextFolderId);
      setSelectedPageId(nextSelectedPageId);
      setEditingFolderId(null);
      setEditingPageId(null);
      setIsEditingHeaderTitle(false);
      setSelectedBlockIds([]);
      setEditingBlockId(null);
      setInsertionPoint(null);
      setActiveMode("canvas");

      return {
        folders: nextFolders,
        pages: nextPages,
        blocks: currentData.blocks.filter(
          (block) => !deletedPageIds.has(block.pageId),
        ),
      };
    });
  }

  function selectFolder(folderId: string) {
    const firstPage = data.pages.find((page) => page.folderId === folderId);

    setSelectedFolderId(folderId);
    setSelectedPageId(firstPage?.id ?? "");
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function createPage() {
    const folderId = selectedFolderId || data.folders[0]?.id;

    if (!folderId) {
      return;
    }

    const pageId = createId("page");

    setData((currentData) => ({
      ...currentData,
      pages: [
        ...currentData.pages,
        { id: pageId, folderId, title: "New page" },
      ],
    }));
    setSelectedFolderId(folderId);
    setSelectedPageId(pageId);
    setEditingFolderId(null);
    setEditingPageId(pageId);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function renamePage(pageId: string, title: string) {
    const nextTitle = title.trim();

    if (!nextTitle) {
      return;
    }

    setData((currentData) => ({
      ...currentData,
      pages: currentData.pages.map((page) =>
        page.id === pageId ? { ...page, title: nextTitle } : page,
      ),
    }));
  }

  function deletePage(pageId: string) {
    setData((currentData) => {
      const pageToDelete = currentData.pages.find((page) => page.id === pageId);
      const nextPages = currentData.pages.filter((page) => page.id !== pageId);
      const folderId = pageToDelete?.folderId ?? selectedFolderId;
      const nextSelectedPageId =
        pageId === selectedPageId
          ? nextPages.find((page) => page.folderId === folderId)?.id ?? ""
          : selectedPageId;

      setSelectedPageId(nextSelectedPageId);
      setEditingPageId(null);
      setIsEditingHeaderTitle(false);
      setSelectedBlockIds([]);
      setEditingBlockId(null);
      setInsertionPoint(null);
      setActiveMode("canvas");

      return {
        ...currentData,
        pages: nextPages,
        blocks: currentData.blocks.filter((block) => block.pageId !== pageId),
      };
    });
  }

  const deleteBlock = useCallback(
    (blockId: string) => deleteBlocks([blockId]),
    [deleteBlocks],
  );

  function selectPage(pageId: string) {
    setSelectedPageId(pageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function createTextBlock(x: number, y: number, content: string) {
    if (!selectedPageId) {
      return;
    }

    const blockId = createId("block");

    setData((currentData) => ({
      ...currentData,
      blocks: [
        ...currentData.blocks,
        {
          id: blockId,
          pageId: selectedPageId,
          x,
          y,
          width: DEFAULT_BLOCK_WIDTH,
          height: DEFAULT_BLOCK_HEIGHT,
          content,
          isWidthManuallyResized: false,
        },
      ],
    }));
    setSelectedBlockIds([blockId]);
    setEditingBlockId(blockId);
    setFocusEndBlockId(blockId);
    setActiveMode("editing");
    setInsertionPoint(null);
  }

  function createImageBlock(
    x: number,
    y: number,
    imageData: string,
    imageName: string,
  ) {
    if (!selectedPageId) {
      return;
    }

    const blockId = createId("block");

    setData((currentData) => ({
      ...currentData,
      blocks: [
        ...currentData.blocks,
        {
          id: blockId,
          pageId: selectedPageId,
          x,
          y,
          width: 320,
          height: 220,
          content: imageName,
          isWidthManuallyResized: true,
          imageData,
          imageName,
        },
      ],
    }));
    setSelectedBlockIds([blockId]);
    setEditingBlockId(null);
    setActiveMode("selected");
    setInsertionPoint(null);
  }

  const updateBlock = useCallback((blockId: string, updates: BlockUpdates) => {
    setData((currentData) => ({
      ...currentData,
      blocks: currentData.blocks.map((block) =>
        block.id === blockId ? { ...block, ...updates } : block,
      ),
    }));
  }, []);

  const bringBlockToFront = useCallback((blockId: string) => {
    setData((currentData) => {
      const blockToMove = currentData.blocks.find((block) => block.id === blockId);

      if (!blockToMove) {
        return currentData;
      }

      return {
        ...currentData,
        blocks: [
          ...currentData.blocks.filter((block) => block.id !== blockId),
          blockToMove,
        ],
      };
    });
  }, []);

  const selectBlock = useCallback((blockId: string) => {
    bringBlockToFront(blockId);
    setSelectedBlockIds((currentBlockIds) =>
      currentBlockIds.includes(blockId) && currentBlockIds.length > 1
        ? currentBlockIds
        : [blockId],
    );
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("selected");
  }, [bringBlockToFront]);

  const previewGroupDrag = useCallback(
    (originId: string, offset: PanOffset) => {
      setGroupDragOffset({
        blockIds: selectedBlockIds,
        originId,
        x: offset.x,
        y: offset.y,
      });
    },
    [selectedBlockIds],
  );

  const commitGroupDrag = useCallback(
    (originId: string, offset: PanOffset) => {
      const blockIdsToMove = new Set(
        selectedBlockIds.includes(originId) ? selectedBlockIds : [originId],
      );

      setData((currentData) => ({
        ...currentData,
        blocks: currentData.blocks.map((block) =>
          blockIdsToMove.has(block.id)
            ? { ...block, x: block.x + offset.x, y: block.y + offset.y }
            : block,
        ),
      }));
      setGroupDragOffset(null);
    },
    [selectedBlockIds],
  );

  const editBlock = useCallback((blockId: string) => {
    bringBlockToFront(blockId);
    setSelectedBlockIds([blockId]);
    setEditingBlockId(blockId);
    setInsertionPoint(null);
    setActiveMode("editing");
  }, [bringBlockToFront]);

  const endBlockEdit = useCallback(() => {
    setEditingBlockId(null);
    setActiveMode((currentMode) =>
      currentMode === "editing" ? "selected" : currentMode,
    );
  }, []);

  function selectCanvas() {
    blurActiveTextEntry();
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setSelectionRect(null);
    setGroupDragOffset(null);
    setActiveMode("canvas");
  }

  function startCanvasPan(event: React.PointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    blurActiveTextEntry();
    panState.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: panOffset.x,
      startPanY: panOffset.y,
    };
    setInsertionPoint(null);
    setActiveMode("panning");
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startCanvasInteraction(event: React.PointerEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) {
      return;
    }

    selectCanvas();
    event.preventDefault();

    if (event.shiftKey) {
      startCanvasPan(event);
    } else {
      const startPoint = getCanvasPoint(event.clientX, event.clientY);

      if (!startPoint) {
        return;
      }

      selectionState.current = {
        startX: startPoint.x,
        startY: startPoint.y,
        currentX: startPoint.x,
        currentY: startPoint.y,
        didMove: false,
      };
      setInsertionPoint(startPoint);
      setSelectionRect(null);
    }

    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateCanvasInteraction(event: React.PointerEvent<HTMLElement>) {
    const currentPan = panState.current;
    const currentSelection = selectionState.current;

    if (!currentPan && !currentSelection) {
      return;
    }

    if (currentPan) {
      const deltaX = event.clientX - currentPan.startClientX;
      const deltaY = event.clientY - currentPan.startClientY;

      setActiveMode("panning");
      setPanOffset({
        x: currentPan.startPanX + deltaX,
        y: currentPan.startPanY + deltaY,
      });
      return;
    }

    const canvasElement = canvasRef.current;

    if (!currentSelection || !canvasElement) {
      return;
    }

    const currentPoint = getCanvasPoint(event.clientX, event.clientY);

    if (!currentPoint) {
      return;
    }

    currentSelection.currentX = currentPoint.x;
    currentSelection.currentY = currentPoint.y;

    if (
      Math.abs(currentSelection.currentX - currentSelection.startX) > 2 ||
      Math.abs(currentSelection.currentY - currentSelection.startY) > 2
    ) {
      currentSelection.didMove = true;
      setActiveMode("selecting");
      setInsertionPoint(null);
      setSelectionRect(getSelectionRect(currentSelection));
    }
  }

  function endCanvasInteraction(event: React.PointerEvent<HTMLElement>) {
    const currentPan = panState.current;
    const currentSelection = selectionState.current;

    if (!currentPan && !currentSelection) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);

    if (currentSelection?.didMove) {
      const nextSelectionRect = getSelectionRect(currentSelection);
      const nextSelectedBlockIds = visibleBlocks
        .filter((block) =>
          rectsIntersect(nextSelectionRect, {
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
          }),
        )
        .map((block) => block.id);

      setSelectedBlockIds(nextSelectedBlockIds);
      setActiveMode(nextSelectedBlockIds.length > 0 ? "selected" : "canvas");
    } else {
      setActiveMode("canvas");
    }

    panState.current = null;
    selectionState.current = null;
    setSelectionRect(null);
  }

  function handleCanvasWheel(event: React.WheelEvent<HTMLElement>) {
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    updateZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  function focusSearchMatch(matchIndex: number) {
    if (searchMatches.length === 0) {
      return;
    }

    const normalizedIndex =
      ((matchIndex % searchMatches.length) + searchMatches.length) %
      searchMatches.length;
    const match = searchMatches[normalizedIndex];
    const block = visibleBlocks.find((currentBlock) => currentBlock.id === match.blockId);

    if (!block) {
      return;
    }

    blurActiveTextEntry();
    setActiveSearchIndex(normalizedIndex);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
    setPanOffset({
      x: canvasSize.width / 2 - (block.x + block.width / 2) * zoomLevel,
      y: canvasSize.height / 2 - (block.y + block.height / 2) * zoomLevel,
    });
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  function panToOffscreenGroup(direction: OffscreenGroup["direction"]) {
    if (!canvasViewport) {
      return;
    }

    const targetBlocks = visibleBlocks.filter(
      (block) => getOffscreenDirection(block, canvasViewport) === direction,
    );

    if (targetBlocks.length === 0) {
      return;
    }

    const bounds = targetBlocks.reduce(
      (currentBounds, block) => ({
        minX: Math.min(currentBounds.minX, block.x),
        minY: Math.min(currentBounds.minY, block.y),
        maxX: Math.max(currentBounds.maxX, block.x + block.width),
        maxY: Math.max(currentBounds.maxY, block.y + block.height),
      }),
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      },
    );
    const targetCenter = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };

    blurActiveTextEntry();
    setSelectedBlockIds(targetBlocks.map((block) => block.id));
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("selected");
    setPanOffset({
      x: canvasSize.width / 2 - targetCenter.x * zoomLevel,
      y: canvasSize.height / 2 - targetCenter.y * zoomLevel,
    });
  }

  return (
    <main className={`app-shell ${isDarkMode ? "is-dark" : ""}`}>
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="sidebar-header">
          <h1>Note</h1>
        </div>

        <section className="sidebar-section" aria-labelledby="folders-title">
          <div className="section-header">
            <h2 id="folders-title">Folders</h2>
            <button type="button" aria-label="Create folder" onClick={createFolder}>
              +
            </button>
          </div>
          <div className="nav-list">
            {data.folders.map((folder) => {
              const pageCount = pageCountsByFolder.get(folder.id) ?? 0;

              return (
                <div
                  className={`nav-item ${
                    folder.id === selectedFolderId ? "is-active" : ""
                  }`}
                  key={folder.id}
                  onDoubleClick={() => setEditingFolderId(folder.id)}
                  onClick={() => selectFolder(folder.id)}
                >
                  {editingFolderId === folder.id ? (
                    <InlineRename
                      ariaLabel="Folder name"
                      initialValue={folder.name}
                      onCancel={() => setEditingFolderId(null)}
                      onCommit={(value) => {
                        renameFolder(folder.id, value);
                        setEditingFolderId(null);
                      }}
                    />
                  ) : (
                    <span className="nav-label">{folder.name}</span>
                  )}
                  <span className="item-count">{pageCount}</span>
                  <span className="nav-actions">
                    <button
                      type="button"
                      aria-label={`Delete ${folder.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteFolder(folder.id);
                      }}
                    >
                      X
                    </button>
                  </span>
                </div>
              );
            })}
            {data.folders.length === 0 ? (
              <p className="empty-state">No folders yet</p>
            ) : null}
          </div>
        </section>

        <section className="sidebar-section" aria-labelledby="pages-title">
          <div className="section-header">
            <h2 id="pages-title">Pages</h2>
            <button
              type="button"
              aria-label="Create page"
              disabled={data.folders.length === 0}
              onClick={createPage}
            >
              +
            </button>
          </div>
          <div className="nav-list">
            {visiblePages.map((page) => (
              <div
                className={`nav-item ${
                  page.id === selectedPageId ? "is-selected" : ""
                }`}
                key={page.id}
                onDoubleClick={() => setEditingPageId(page.id)}
                onClick={() => selectPage(page.id)}
              >
                {editingPageId === page.id ? (
                  <InlineRename
                    ariaLabel="Page title"
                    initialValue={page.title}
                    onCancel={() => setEditingPageId(null)}
                    onCommit={(value) => {
                      renamePage(page.id, value);
                      setEditingPageId(null);
                    }}
                  />
                ) : (
                  <span className="nav-label">{page.title}</span>
                )}
                <span className="nav-actions">
                  <button
                    type="button"
                    aria-label={`Delete ${page.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      deletePage(page.id);
                    }}
                  >
                    X
                  </button>
                </span>
              </div>
            ))}
            {selectedFolderId && visiblePages.length === 0 ? (
              <p className="empty-state">No pages in this folder</p>
            ) : null}
            {!selectedFolderId ? (
              <p className="empty-state">Select or create a folder</p>
            ) : null}
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="page-header">
          <div className="page-title-group">
            <span className="app-title">Note</span>
            {selectedPage && isEditingHeaderTitle ? (
              <InlineRename
                ariaLabel="Page title"
                initialValue={selectedPage.title}
                onCancel={() => setIsEditingHeaderTitle(false)}
                onCommit={(value) => {
                  renamePage(selectedPage.id, value);
                  setIsEditingHeaderTitle(false);
                }}
              />
            ) : (
              <h2
                className="page-title"
                onDoubleClick={() => {
                  if (selectedPage) {
                    setIsEditingHeaderTitle(true);
                  }
                }}
              >
                {selectedPage?.title ?? "No page selected"}
              </h2>
            )}
          </div>
          <div className="page-header-actions">
            <span className="zoom-indicator">{Math.round(zoomLevel * 100)}%</span>
            <span className="mode-indicator">{modeLabels[activeMode]}</span>
            <button
              aria-pressed={isDarkMode}
              className="theme-toggle"
              onClick={() => setIsDarkMode((currentMode) => !currentMode)}
              type="button"
            >
              {isDarkMode ? "Light" : "Dark"}
            </button>
          </div>
        </header>

        <section
          className={`canvas ${activeMode === "canvas" ? "is-canvas-selected" : ""} ${
            activeMode === "panning" ? "is-panning" : ""
          } ${activeMode === "selecting" ? "is-selecting" : ""
          }`}
          aria-label="Freeform note canvas"
          onPointerCancel={endCanvasInteraction}
          onPointerDown={startCanvasInteraction}
          onPointerMove={updateCanvasInteraction}
          onPointerUp={endCanvasInteraction}
          onWheel={handleCanvasWheel}
          ref={canvasRef}
        >
          {offscreenGroups.length > 0 ? (
            <div className="offscreen-indicators" aria-label="Offscreen textboxes">
              {offscreenGroups.map((group) => (
                <button
                  aria-label={`${group.count} textboxes offscreen ${group.direction}`}
                  className={`offscreen-arrow offscreen-${group.direction}`}
                  key={group.direction}
                  onClick={(event) => {
                    event.stopPropagation();
                    panToOffscreenGroup(group.direction);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  type="button"
                >
                  <span>{group.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {isSearchOpen ? (
            <div className="search-panel" onPointerDown={(event) => event.stopPropagation()}>
              <input
                aria-label="Search textboxes"
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    focusSearchMatch(
                      activeSearchIndex + (event.shiftKey ? -1 : 1),
                    );
                  }

                  if (event.key === "Escape") {
                    setIsSearchOpen(false);
                    setSearchQuery("");
                  }
                }}
                placeholder="Search"
                ref={searchInputRef}
                value={searchQuery}
              />
              <span>{searchMatches.length}</span>
              <button
                aria-label="Close search"
                onClick={() => {
                  setIsSearchOpen(false);
                  setSearchQuery("");
                }}
                type="button"
              >
                X
              </button>
            </div>
          ) : null}
          <div
            className="canvas-content"
            style={{
              transform: `translate3d(${panOffset.x}px, ${panOffset.y}px, 0) scale(${zoomLevel})`,
            }}
          >
            {visibleBlocks.map((block) => (
              <TextBlockView
                block={block}
                canvasRef={canvasRef}
                activeSearchRange={
                  activeSearchMatch?.blockId === block.id ? activeSearchMatch : null
                }
                groupDragOffset={groupDragOffset}
                isEditing={block.id === editingBlockId}
                isMultiSelected={selectedBlockIds.length > 1}
                isSelected={selectedBlockIds.includes(block.id)}
                key={block.id}
                onDelete={deleteBlock}
                onEdit={editBlock}
                onEditEnd={endBlockEdit}
                onCanvasPanEnd={endCanvasInteraction}
                onCanvasPanMove={updateCanvasInteraction}
                onCanvasPanStart={startCanvasPan}
                onFocusEndHandled={() => setFocusEndBlockId(null)}
                onGroupDragEnd={commitGroupDrag}
                onGroupDragPreview={previewGroupDrag}
                onInteractionModeChange={setActiveMode}
                onSelect={selectBlock}
                onUpdate={updateBlock}
                panOffset={panOffset}
                searchQuery={searchQuery}
                shouldFocusEnd={focusEndBlockId === block.id}
                zoomLevel={zoomLevel}
              />
            ))}
            {selectionRect ? (
              <div
                className="selection-rectangle"
                style={{
                  left: selectionRect.x,
                  top: selectionRect.y,
                  width: selectionRect.width,
                  height: selectionRect.height,
                }}
              />
            ) : null}
            {insertionPoint ? (
              <div
                className="canvas-caret"
                style={{
                  left: insertionPoint.x,
                  top: insertionPoint.y,
                }}
              />
            ) : null}
          </div>
          {!selectedPageId ? (
            <div className="canvas-empty">
              <p>Select or create a page</p>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

export default App;
