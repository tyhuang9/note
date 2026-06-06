import { memo, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  AUTO_WIDTH_RIGHT_PADDING,
  DEFAULT_BLOCK_WIDTH,
  MIN_BLOCK_HEIGHT,
  MIN_BLOCK_WIDTH,
  TEXT_BLOCK_HEIGHT_BUFFER,
  TEXT_BLOCK_HEADER_HEIGHT,
  TEXT_COMMIT_DELAY_MS,
} from "../constants";
import type {
  BlockUpdates,
  InteractionMode,
  PanOffset,
  ResizeDirection,
  SearchMatch,
} from "../appTypes";
import { blurActiveTextEntry } from "../editorUtils";
import type { TextBlock } from "../types";

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

type PointerLike = {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
};

type TextBlockViewProps = {
  block: TextBlock;
  canvasRef: RefObject<HTMLElement | null>;
  activeSearchRange: SearchMatch | null;
  isEditing: boolean;
  isMultiSelected: boolean;
  isSelected: boolean;
  searchQuery: string;
  shouldFocusEnd: boolean;
  onEditEnd: () => void;
  onDelete: (blockId: string) => void;
  onEdit: (blockId: string) => void;
  onCanvasPanEnd: (event: ReactPointerEvent<HTMLElement>) => void;
  onCanvasPanMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onCanvasPanStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onFocusEndHandled: () => void;
  onGroupDragEnd: (originId: string, offset: PanOffset) => void;
  onGroupDragPreview: (originId: string, offset: PanOffset) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onSelect: (blockId: string) => void;
  onUpdate: (blockId: string, updates: BlockUpdates) => void;
  panOffset: PanOffset;
  zoomLevel: number;
};

export const TextBlockView = memo(function TextBlockView({
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
  const activePointerId = useRef<number | null>(null);
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
        measuredHeight + TEXT_BLOCK_HEADER_HEIGHT + TEXT_BLOCK_HEIGHT_BUFFER,
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

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
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
    event.stopPropagation();
    activePointerId.current = event.pointerId;
    blockRef.current?.setPointerCapture(event.pointerId);
  }

  function moveBlock(event: PointerLike) {
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

  function endDrag(pointerId?: number) {
    const currentDrag = dragState.current;

    if (!currentDrag) {
      return;
    }

    if (currentDrag.rafId !== null) {
      window.cancelAnimationFrame(currentDrag.rafId);
    }

    if (blockRef.current) {
      blockRef.current.style.transform = "";

      if (
        pointerId !== undefined &&
        blockRef.current.hasPointerCapture(pointerId)
      ) {
        blockRef.current.releasePointerCapture(pointerId);
      }
    }

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
    activePointerId.current = null;
    setIsDragging(false);
    onInteractionModeChange("selected");
  }

  function startResize(
    event: ReactPointerEvent<HTMLDivElement>,
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
    activePointerId.current = event.pointerId;
    blockRef.current?.setPointerCapture(event.pointerId);
  }

  function resizeBlock(event: PointerLike) {
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

    currentResize.currentX = nextX;
    currentResize.currentY = nextY;
    currentResize.currentWidth = nextWidth;

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
      resizeState.current.currentHeight = getAutoHeight(
        resizeState.current.currentWidth,
        true,
      );
      blockRef.current.style.height = `${resizeState.current.currentHeight}px`;
      resizeState.current.rafId = null;
    });
  }

  function endResize(pointerId?: number) {
    const currentResize = resizeState.current;

    if (!currentResize) {
      return;
    }

    if (currentResize.rafId !== null) {
      window.cancelAnimationFrame(currentResize.rafId);
    }

    currentResize.currentHeight = getAutoHeight(currentResize.currentWidth, true);

    if (
      pointerId !== undefined &&
      blockRef.current?.hasPointerCapture(pointerId)
    ) {
      blockRef.current.releasePointerCapture(pointerId);
    }

    onUpdate(block.id, {
      x: currentResize.currentX,
      y: currentResize.currentY,
      width: currentResize.currentWidth,
      height: currentResize.currentHeight,
      isWidthManuallyResized: true,
    });
    resizeState.current = null;
    activePointerId.current = null;
    setIsResizing(false);
    onInteractionModeChange("selected");
  }

  function handleRootPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragState.current) {
      moveBlock(event);
      return;
    }

    if (resizeState.current) {
      resizeBlock(event);
      return;
    }

    onCanvasPanMove(event);
  }

  function handleRootPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragState.current) {
      event.preventDefault();
      event.stopPropagation();
      endDrag(event.pointerId);
      return;
    }

    if (resizeState.current) {
      event.preventDefault();
      event.stopPropagation();
      endResize(event.pointerId);
      return;
    }

    onCanvasPanEnd(event);
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
      onPointerCancel={handleRootPointerEnd}
      onPointerMove={handleRootPointerMove}
      onPointerUp={handleRootPointerEnd}
      data-block-id={block.id}
      style={{
        left: block.x,
        top: block.y,
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
        onPointerDown={startDrag}
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
      {(["e"] as ResizeDirection[]).map((direction) => (
        <div
          aria-label={`Resize text block ${direction}`}
          className={`resize-handle resize-${direction}`}
          key={direction}
          onPointerDown={(event) => startResize(event, direction)}
          role="button"
          tabIndex={0}
        />
      ))}
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
