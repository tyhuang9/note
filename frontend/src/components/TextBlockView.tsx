import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
  ResizeDirection,
  SearchMatch,
} from "../appTypes";
import { blurActiveTextEntry } from "../editorUtils";
import type { TextBlock } from "../types";

type DragState = {
  pointerId: number;
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
  onInteractionModeChange: (mode: InteractionMode) => void;
  onBlockElementChange: (
    blockId: string,
    element: HTMLDivElement | null,
  ) => void;
  onSelect: (blockId: string) => void;
  onUpdate: (blockId: string, updates: BlockUpdates) => void;
  onVisualDragCancel: () => void;
  onVisualDragEnd: (clientX: number, clientY: number) => void;
  onVisualDragMove: (clientX: number, clientY: number) => void;
  onVisualDragStart: (
    originId: string,
    clientX: number,
    clientY: number,
  ) => boolean;
  zoomLevel: number;
};

export const TextBlockView = memo(function TextBlockView({
  block,
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
  onInteractionModeChange,
  onBlockElementChange,
  onSelect,
  onUpdate,
  onVisualDragCancel,
  onVisualDragEnd,
  onVisualDragMove,
  onVisualDragStart,
  zoomLevel,
}: TextBlockViewProps) {
  const blockRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const displayRef = useRef<HTMLDivElement | null>(null);
  const widthMeasureRef = useRef<HTMLDivElement | null>(null);
  const heightMeasureRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const isResizingRef = useRef(false);
  const activePointerId = useRef<number | null>(null);
  const ctrlAStage = useRef(0);
  const hasManualWidth = useRef(Boolean(block.isWidthManuallyResized));
  const pendingCaretOffset = useRef<number | null>(null);
  const draftContentRef = useRef(block.content);
  const committedContentRef = useRef(block.content);
  const commitTimerRef = useRef<number | null>(null);
  const autosizeRafId = useRef<number | null>(null);
  const latestAutosizeText = useRef(block.content);
  const [isContentSelected, setIsContentSelected] = useState(false);

  const setBlockElement = useCallback(
    (element: HTMLDivElement | null) => {
      blockRef.current = element;
      onBlockElementChange(block.id, element);

      if (!element) {
        return;
      }

      element.classList.toggle("is-resizing", isResizingRef.current);
    },
    [block.id, onBlockElementChange],
  );

  useEffect(() => {
    committedContentRef.current = block.content;

    if (!isEditing) {
      draftContentRef.current = block.content;
      latestAutosizeText.current = "";

      if (editorRef.current) {
        editorRef.current.value = block.content;
      }
    }
  }, [block.content, block.id, isEditing]);

  useEffect(() => {
    hasManualWidth.current = Boolean(block.isWidthManuallyResized);
  }, [block.id, block.isWidthManuallyResized]);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current !== null) {
        window.clearTimeout(commitTimerRef.current);
      }

      if (autosizeRafId.current !== null) {
        window.cancelAnimationFrame(autosizeRafId.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isEditing) {
      const editorElement = editorRef.current;

      if (editorElement && editorElement.value !== draftContentRef.current) {
        editorElement.value = draftContentRef.current;
      }

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

    if (!blockElement) {
      return;
    }

    const size = getAutoSize(undefined, false, draftContentRef.current);

    blockElement.style.width = `${size.width}px`;
    blockElement.style.height = `${size.height}px`;
  }, [
    block.content,
    block.height,
    block.id,
    block.isWidthManuallyResized,
    block.width,
  ]);

  function getSizeUpdates() {
    const size = getAutoSize(undefined, false, draftContentRef.current);
    const updates: BlockUpdates = {};

    if (size.width !== block.width) {
      updates.width = size.width;
    }

    if (size.height !== block.height) {
      updates.height = size.height;
    }

    return updates;
  }

  function setMeasureText(text: string) {
    const measureText = text.length > 0 ? text : " ";

    if (latestAutosizeText.current === text) {
      return;
    }

    latestAutosizeText.current = text;

    if (widthMeasureRef.current) {
      widthMeasureRef.current.textContent = measureText;
    }

    if (heightMeasureRef.current) {
      heightMeasureRef.current.textContent = measureText;
    }
  }

  function getAutoSize(
    widthOverride?: number,
    forceFixedWidth = false,
    content = draftContentRef.current,
  ) {
    if (block.imageData) {
      return {
        width: Math.max(MIN_BLOCK_WIDTH, block.width),
        height: Math.max(MIN_BLOCK_HEIGHT, block.height),
      };
    }

    const widthMeasureElement = widthMeasureRef.current;
    const heightMeasureElement = heightMeasureRef.current;
    const nextWidth = widthOverride ?? block.width;

    setMeasureText(content);

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

    const measuredHeight = heightMeasureElement.scrollHeight;

    return {
      width: measuredWidth,
      height: Math.max(
        MIN_BLOCK_HEIGHT,
        measuredHeight + TEXT_BLOCK_HEADER_HEIGHT + TEXT_BLOCK_HEIGHT_BUFFER,
      ),
    };
  }

  function getAutoHeight(widthOverride?: number, forceFixedWidth = false) {
    return getAutoSize(
      widthOverride,
      forceFixedWidth,
      editorRef.current?.value ?? draftContentRef.current,
    ).height;
  }

  function getMeasureText() {
    return draftContentRef.current.length > 0 ? draftContentRef.current : " ";
  }

  function scheduleAutosize() {
    if (autosizeRafId.current !== null) {
      return;
    }

    autosizeRafId.current = window.requestAnimationFrame(() => {
      const blockElement = blockRef.current;

      if (blockElement) {
        const size = getAutoSize(undefined, false, draftContentRef.current);

        blockElement.style.width = `${size.width}px`;
        blockElement.style.height = `${size.height}px`;
      }

      autosizeRafId.current = null;
    });
  }

  function scheduleContentCommit() {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
    }

    commitTimerRef.current = window.setTimeout(() => {
      const nextContent = draftContentRef.current;

      if (nextContent === committedContentRef.current) {
        commitTimerRef.current = null;
        return;
      }

      const size = getAutoSize(undefined, false, nextContent);

      committedContentRef.current = nextContent;
      onUpdate(block.id, { content: nextContent, ...size });
      commitTimerRef.current = null;
    }, TEXT_COMMIT_DELAY_MS);
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
      return block.content;
    }

    const escapedQuery = nextQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const queryRegex = new RegExp(`(${escapedQuery})`, "gi");

    let cursor = 0;

    return block.content.split(queryRegex).map((part, index) => {
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
      return draftContentRef.current.length;
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

    return draftContentRef.current.length;
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button === 2) {
      onCanvasPanStart(event);
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const didStartDrag = onVisualDragStart(
      block.id,
      event.clientX,
      event.clientY,
    );

    if (!didStartDrag) {
      onSelect(block.id);
      return;
    }

    dragState.current = {
      pointerId: event.pointerId,
    };
    blurActiveTextEntry();
    activePointerId.current = event.pointerId;
    blockRef.current?.setPointerCapture(event.pointerId);
  }

  function moveBlock(event: PointerLike) {
    if (!dragState.current) {
      return;
    }

    event.preventDefault();
    onVisualDragMove(event.clientX, event.clientY);
  }

  function endDrag(clientX: number, clientY: number, pointerId?: number) {
    if (!dragState.current) {
      return;
    }

    if (blockRef.current) {
      if (
        pointerId !== undefined &&
        blockRef.current.hasPointerCapture(pointerId)
      ) {
        blockRef.current.releasePointerCapture(pointerId);
      }
    }

    onVisualDragEnd(clientX, clientY);
    dragState.current = null;
    activePointerId.current = null;
  }

  function cancelDrag(pointerId?: number) {
    if (!dragState.current) {
      return;
    }

    if (
      pointerId !== undefined &&
      blockRef.current?.hasPointerCapture(pointerId)
    ) {
      blockRef.current.releasePointerCapture(pointerId);
    }

    onVisualDragCancel();
    dragState.current = null;
    activePointerId.current = null;
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
    isResizingRef.current = true;
    blockRef.current?.classList.add("is-resizing");
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

      const nextHeight = getAutoHeight(
        resizeState.current.currentWidth,
        true,
      );

      if (resizeState.current.direction.includes("w")) {
        blockRef.current.style.left = `${resizeState.current.currentX}px`;
        blockRef.current.style.top = `${resizeState.current.currentY}px`;
      }

      blockRef.current.style.width = `${resizeState.current.currentWidth}px`;
      resizeState.current.currentHeight = nextHeight;
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
      currentResize.rafId = null;
    }

    currentResize.currentHeight = getAutoHeight(currentResize.currentWidth, true);

    if (blockRef.current) {
      blockRef.current.style.height = `${currentResize.currentHeight}px`;
      blockRef.current.classList.remove("is-resizing");
    }

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
    isResizingRef.current = false;
    activePointerId.current = null;
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
      endDrag(event.clientX, event.clientY, event.pointerId);
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

  function handleRootPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragState.current) {
      event.preventDefault();
      event.stopPropagation();
      cancelDrag(event.pointerId);
      return;
    }

    handleRootPointerEnd(event);
  }

  return (
    <div
      className={`text-block ${isSelected ? "is-selected" : ""} ${
        isEditing ? "is-editing" : ""
      } ${
        isSelected && isMultiSelected ? "is-multi-selected" : ""
      } ${
        isSelected && !isEditing ? "is-canvas-mode" : ""
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
        if (event.button === 2) {
          onCanvasPanStart(event);
          return;
        }

        if (event.button !== 0) {
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
      ref={setBlockElement}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={handleRootPointerCancel}
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

          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
            commitTimerRef.current = null;
          }

          if (editorRef.current) {
            draftContentRef.current = editorRef.current.value;
          }

          const nextDraftContent = draftContentRef.current;
          const updates = getSizeUpdates();
          const nextContent = nextDraftContent.trim();

          if (!nextContent) {
            onDelete(block.id);
            onEditEnd();
            return;
          }

          if (nextDraftContent !== committedContentRef.current) {
            updates.content = nextDraftContent;
            committedContentRef.current = nextDraftContent;
          }

          if (Object.keys(updates).length > 0) {
            onUpdate(block.id, updates);
          }

          onEditEnd();
        }}
        onInput={(event) => {
          ctrlAStage.current = 0;

          if (isContentSelected) {
            setIsContentSelected(false);
          }

          draftContentRef.current = event.currentTarget.value;
          scheduleAutosize();
          scheduleContentCommit();
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
          if (event.button === 2) {
            onCanvasPanStart(event);
          }
        }}
        ref={editorRef}
        defaultValue={block.content}
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
            if (event.button === 2) {
              onCanvasPanStart(event);
              return;
            }

            if (event.button !== 0) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            pendingCaretOffset.current = getCaretOffsetFromPoint(
              event.clientX,
              event.clientY,
            );
          }}
          onPointerMove={(event) => {
            if (event.buttons !== 2) {
              event.stopPropagation();
            }
          }}
          onPointerUp={(event) => {
            if (event.button !== 2) {
              event.stopPropagation();
            }
          }}
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
            if (event.button === 2) {
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
}, areTextBlockViewPropsEqual);

function areSearchRangesEqual(
  previousRange: SearchMatch | null,
  nextRange: SearchMatch | null,
) {
  if (previousRange === nextRange) {
    return true;
  }

  if (!previousRange || !nextRange) {
    return false;
  }

  return (
    previousRange.blockId === nextRange.blockId &&
    previousRange.start === nextRange.start &&
    previousRange.end === nextRange.end
  );
}

function areTextBlockViewPropsEqual(
  previousProps: TextBlockViewProps,
  nextProps: TextBlockViewProps,
) {
  return (
    previousProps.block === nextProps.block &&
    previousProps.isEditing === nextProps.isEditing &&
    previousProps.isMultiSelected === nextProps.isMultiSelected &&
    previousProps.isSelected === nextProps.isSelected &&
    previousProps.searchQuery === nextProps.searchQuery &&
    previousProps.shouldFocusEnd === nextProps.shouldFocusEnd &&
    previousProps.zoomLevel === nextProps.zoomLevel &&
    areSearchRangesEqual(
      previousProps.activeSearchRange,
      nextProps.activeSearchRange,
    )
  );
}
