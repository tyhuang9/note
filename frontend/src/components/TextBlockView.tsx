import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { AllSelection, TextSelection, type EditorState } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
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
  SearchMatch,
} from "../appTypes";
import { blurActiveTextEntry } from "../editorUtils";
import { createSlashCommandExtension } from "../editor/SlashCommandExtension";
import {
  getTextOffsetAtClientPoint,
  placeEditorCaret,
  type CaretPlacementRequest,
} from "../editor/caretPlacement";
import {
  getCanonicalRichTextDocument as getTipTapContent,
  hasTipTapRenderableContent,
  renderRichTextContent as renderRichBlockContent,
  richTextExtensions,
} from "../editor/richText";
import type { TextElement } from "../canvas/model/elements";

type DragState = {
  didStart: boolean;
  isStarting: boolean;
  pointerId: number;
  startClientX: number;
  startClientY: number;
};

type PointerLike = {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
};

const TEXT_BLOCK_HORIZONTAL_PADDING = 18;

type TextBlockViewProps = {
  block: TextElement;
  activeSearchRange: SearchMatch | null;
  searchRanges: readonly SearchMatch[];
  searchableText: string;
  isEditing: boolean;
  isDragSourceHidden: boolean;
  interactionCancellationKey: string;
  isMultiSelected: boolean;
  isSelected: boolean;
  isTransientDraft?: boolean;
  shouldFocusEnd: boolean;
  onEditEnd: (blockId: string) => void;
  onDelete: (blockId: string) => void;
  onEdit: (blockId: string) => void;
  onActiveEditorChange: (editor: Editor | null) => void;
  onCanvasPanEnd: (event: ReactPointerEvent<HTMLElement>) => void;
  onCanvasPanMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onCanvasPanStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onCancelDraft?: (blockId: string) => void;
  onFocusEndHandled: () => void;
  onBlockElementChange: (
    blockId: string,
    element: HTMLDivElement | null,
  ) => void;
  onKeyboardMove: (blockId: string, delta: Readonly<{ x: number; y: number }>) => void;
  onKeyboardResize: (blockId: string, direction: -1 | 1, zoomLevel: number) => void;
  onSelect: (blockId: string, additive?: boolean) => void;
  onSelectAllBlocks: () => void;
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
  searchRanges,
  searchableText,
  isEditing,
  isDragSourceHidden,
  interactionCancellationKey,
  isMultiSelected,
  isSelected,
  isTransientDraft = false,
  shouldFocusEnd,
  onEditEnd,
  onDelete,
  onEdit,
  onActiveEditorChange,
  onCanvasPanEnd,
  onCanvasPanMove,
  onCanvasPanStart,
  onCancelDraft,
  onFocusEndHandled,
  onBlockElementChange,
  onKeyboardMove,
  onKeyboardResize,
  onSelect,
  onSelectAllBlocks,
  onUpdate,
  onVisualDragCancel,
  onVisualDragEnd,
  onVisualDragMove,
  onVisualDragStart,
  zoomLevel,
}: TextBlockViewProps) {
  const blockRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const displayRef = useRef<HTMLDivElement | null>(null);
  const widthMeasureRef = useRef<HTMLDivElement | null>(null);
  const heightMeasureRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<DragState | null>(null);
  const activePointerId = useRef<number | null>(null);
  const hasManualWidth = useRef(Boolean(block.isWidthManuallyResized));
  const pendingCaretOffset = useRef<number | null>(null);
  const pendingCaretPoint = useRef<CaretPlacementRequest | null>(null);
  const suppressModifierClickRef = useRef(false);
  const draftContentRef = useRef(block.content);
  const draftRichContentRef = useRef<JSONContent>(
    getTipTapContent(block),
  );
  const committedContentRef = useRef(block.content);
  const committedRichContentRef = useRef<JSONContent>(
    getTipTapContent(block),
  );
  const commitTimerRef = useRef<number | null>(null);
  const autosizeRafId = useRef<number | null>(null);
  const lastAppliedSizeRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const latestAutosizeContent = useRef<{
    key: string;
    source: HTMLElement | null;
  } | null>(null);
  const isTransientDraftFinalizedRef = useRef(false);
  const [isContentSelected, setIsContentSelected] = useState(false);
  const transientDraftInstructionsId = isTransientDraft
    ? `direct-text-draft-instructions-${block.id}`
    : undefined;

  const setBlockElement = useCallback(
    (element: HTMLDivElement | null) => {
      blockRef.current = element;
      onBlockElementChange(block.id, element);

      if (!element) {
        lastAppliedSizeRef.current = null;
        return;
      }

    },
    [block.id, onBlockElementChange],
  );

  useEffect(() => {
    committedContentRef.current = block.content;
    committedRichContentRef.current = getTipTapContent(block);

    if (!isEditing) {
      draftContentRef.current = block.content;
      draftRichContentRef.current = getTipTapContent(block);
      latestAutosizeContent.current = null;
    }
  }, [block.content, block.id, block.richContent, isEditing]);

  useEffect(() => {
    isTransientDraftFinalizedRef.current = false;
  }, [block.id, isTransientDraft]);

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
    updateBlockElementSize();
  }, [
    block.content,
    block.height,
    block.id,
    block.isWidthManuallyResized,
    block.width,
  ]);

  function getSizeUpdates() {
    const size = getAutoSize(undefined, false, draftRichContentRef.current);
    const updates: BlockUpdates = {};

    if (size.width !== block.width) {
      updates.width = size.width;
    }

    if (size.height !== block.height) {
      updates.height = size.height;
    }

    return updates;
  }

  function setMeasureContent(content: JSONContent) {
    const widthMeasureElement = widthMeasureRef.current;
    const heightMeasureElement = heightMeasureRef.current;

    if (!widthMeasureElement || !heightMeasureElement) {
      return;
    }

    const sourceElement = editorRef.current?.view.dom ?? displayRef.current;
    const contentKey = JSON.stringify(content);

    if (
      latestAutosizeContent.current?.key === contentKey &&
      latestAutosizeContent.current.source === sourceElement
    ) {
      return;
    }

    if (sourceElement) {
      const cloneContent = () =>
        Array.from(sourceElement.childNodes, (node) => node.cloneNode(true));

      widthMeasureElement.replaceChildren(...cloneContent());
      heightMeasureElement.replaceChildren(...cloneContent());
    } else {
      const measureText = getTipTapMeasureText(content) || " ";

      widthMeasureElement.textContent = measureText;
      heightMeasureElement.textContent = measureText;
    }

    latestAutosizeContent.current = {
      key: contentKey,
      source: sourceElement,
    };
  }

  function getAutoSize(
    widthOverride?: number,
    forceFixedWidth = false,
    measureContent = draftRichContentRef.current,
  ) {
    const widthMeasureElement = widthMeasureRef.current;
    const heightMeasureElement = heightMeasureRef.current;
    const nextWidth = widthOverride ?? block.width;
    const imageMetrics = getTipTapImageMetrics(measureContent);

    setMeasureContent(measureContent);

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
          imageMetrics.maxWidth + TEXT_BLOCK_HORIZONTAL_PADDING,
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

  function updateBlockElementSize() {
    const blockElement = blockRef.current;

    if (!blockElement) {
      return;
    }

    const size = getAutoSize(undefined, false, draftRichContentRef.current);

    if (
      lastAppliedSizeRef.current?.width === size.width &&
      lastAppliedSizeRef.current.height === size.height
    ) {
      return;
    }

    blockElement.style.width = `${size.width}px`;
    blockElement.style.height = `${size.height}px`;
    lastAppliedSizeRef.current = size;
  }

  function applyAutosize() {
    if (autosizeRafId.current !== null) {
      window.cancelAnimationFrame(autosizeRafId.current);
      autosizeRafId.current = null;
    }

    updateBlockElementSize();
  }

  function scheduleAutosize() {
    if (autosizeRafId.current !== null) {
      return;
    }

    autosizeRafId.current = window.requestAnimationFrame(() => {
      autosizeRafId.current = null;
      updateBlockElementSize();
    });
  }

  function scheduleContentCommit() {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
    }

    commitTimerRef.current = window.setTimeout(() => {
      const nextContent = draftContentRef.current;
      const nextRichContent = draftRichContentRef.current;

      if (
        nextContent === committedContentRef.current &&
        areRichContentsEqual(nextRichContent, committedRichContentRef.current)
      ) {
        commitTimerRef.current = null;
        return;
      }

      const size = getAutoSize(undefined, false, draftRichContentRef.current);

      committedContentRef.current = nextContent;
      committedRichContentRef.current = nextRichContent;
      onUpdate(block.id, {
        content: nextContent,
        richContent: nextRichContent,
        ...size,
      });
      commitTimerRef.current = null;
    }, TEXT_COMMIT_DELAY_MS);
  }

  function getCaretOffsetFromPoint(clientX: number, clientY: number) {
    const displayElement = displayRef.current;

    if (!displayElement) {
      return draftContentRef.current.length;
    }

    return getTextOffsetAtClientPoint(displayElement, {
      clientX,
      clientY,
    }) ?? draftContentRef.current.length;
  }

  function cacheCaretFromPoint(clientX: number, clientY: number) {
    const textOffset = getCaretOffsetFromPoint(clientX, clientY);
    pendingCaretOffset.current = textOffset;
    pendingCaretPoint.current = { clientX, clientY, textOffset };
  }

  function selectTextBlock(additive = false) {
    leaveEditorForBlockSelection(additive);
  }

  function editTextBlockAtCachedCaret(clientX: number, clientY: number) {
    cacheCaretFromPoint(clientX, clientY);
    selectTextBlock();
    onEdit(block.id);
  }

  function handleEditorChange(editor: Editor) {
    if (isContentSelected) {
      setIsContentSelected(false);
    }

    draftContentRef.current = editor.getText({ blockSeparator: "\n" });
    draftRichContentRef.current = editor.getJSON();
    applyAutosize();
    if (!isTransientDraft) {
      scheduleContentCommit();
    }
  }

  function cancelTransientDraft() {
    if (!isTransientDraft || isTransientDraftFinalizedRef.current) {
      return;
    }

    isTransientDraftFinalizedRef.current = true;
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    onActiveEditorChange(null);
    onCancelDraft?.(block.id);
  }

  function commitTransientDraft(editor: Editor) {
    if (!isTransientDraft || isTransientDraftFinalizedRef.current) {
      return;
    }

    isTransientDraftFinalizedRef.current = true;
    onActiveEditorChange(null);
    commitEditorDraft(editor, {
      deleteEmpty: true,
      endEdit: true,
      includeSizeUpdates: true,
    });
    window.requestAnimationFrame(() => {
      blockRef.current
        ?.querySelector<HTMLElement>(".text-block-header")
        ?.focus({ preventScroll: true });
    });
  }

  function commitEditorDraft(
    editor: Editor,
    options: {
      deleteEmpty: boolean;
      endEdit: boolean;
      includeSizeUpdates: boolean;
    },
  ) {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }

    draftContentRef.current = editor.getText({ blockSeparator: "\n" });
    draftRichContentRef.current = editor.getJSON();

    const nextDraftContent = draftContentRef.current;
    const nextRichContent = draftRichContentRef.current;
    const updates: BlockUpdates = options.includeSizeUpdates
      ? getSizeUpdates()
      : {};
    const nextContent = nextDraftContent.trim();

    if (!nextContent && !hasTipTapRenderableContent(nextRichContent)) {
      if (options.deleteEmpty) {
        onDelete(block.id);
        onEditEnd(block.id);
      }

      return;
    }

    if (nextDraftContent !== committedContentRef.current) {
      updates.content = nextDraftContent;
      committedContentRef.current = nextDraftContent;
    }

    if (!areRichContentsEqual(nextRichContent, committedRichContentRef.current)) {
      updates.richContent = nextRichContent;
      committedRichContentRef.current = nextRichContent;
    }

    if (Object.keys(updates).length > 0) {
      onUpdate(block.id, updates);
    }

    if (options.endEdit) {
      onEditEnd(block.id);
    }
  }

  function isToolbarBlurTarget(target: EventTarget | null) {
    return (
      target instanceof HTMLElement &&
      target.closest(".global-text-toolbar") !== null
    );
  }

  function handleEditorBlur(editor: Editor, event: FocusEvent) {
    if (isTransientDraftFinalizedRef.current) {
      return;
    }

    if (
      document.body.dataset.noteToolbarInteraction === "true" ||
      isToolbarBlurTarget(event.relatedTarget) ||
      isToolbarBlurTarget(document.activeElement)
    ) {
      if (!isTransientDraft) {
        commitEditorDraft(editor, {
          deleteEmpty: false,
          endEdit: false,
          includeSizeUpdates: false,
        });
      }
      onActiveEditorChange(editor);
      return;
    }

    setIsContentSelected(false);
    onActiveEditorChange(null);
    window.getSelection()?.removeAllRanges();
    if (isTransientDraft) {
      isTransientDraftFinalizedRef.current = true;
    }
    commitEditorDraft(editor, {
      deleteEmpty: true,
      endEdit: true,
      includeSizeUpdates: true,
    });
  }

  function leaveEditorForBlockSelection(additive = false) {
    setIsContentSelected(false);
    blurActiveTextEntry();
    window.getSelection()?.removeAllRanges();
    onActiveEditorChange(null);
    onSelect(block.id, additive);
  }

  function handleSelectAllBlocksFromEditor(editor: Editor) {
    setIsContentSelected(false);
    onActiveEditorChange(null);
    window.getSelection()?.removeAllRanges();
    commitEditorDraft(editor, {
      deleteEmpty: true,
      endEdit: true,
      includeSizeUpdates: true,
    });
    onSelectAllBlocks();
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button === 2) {
      onCanvasPanStart(event);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      suppressModifierClickRef.current = true;
      cacheCaretFromPoint(event.clientX, event.clientY);
      leaveEditorForBlockSelection(true);
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    cacheCaretFromPoint(event.clientX, event.clientY);
    leaveEditorForBlockSelection();

    if (block.locked) {
      return;
    }

    dragState.current = {
      didStart: false,
      isStarting: false,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    activePointerId.current = event.pointerId;
    blockRef.current?.setPointerCapture(event.pointerId);
  }

  function moveBlock(event: PointerLike) {
    if (!dragState.current) {
      return;
    }

    const currentDrag = dragState.current;
    if (
      !currentDrag.didStart &&
      Math.hypot(
        event.clientX - currentDrag.startClientX,
        event.clientY - currentDrag.startClientY,
      ) < 3
    ) {
      return;
    }
    if (!currentDrag.didStart) {
      currentDrag.didStart = true;
      currentDrag.isStarting = true;
      const didStartDrag = onVisualDragStart(
        block.id,
        currentDrag.startClientX,
        currentDrag.startClientY,
      );
      currentDrag.isStarting = false;
      if (!didStartDrag) {
        dragState.current = null;
        activePointerId.current = null;
        if (blockRef.current?.hasPointerCapture(currentDrag.pointerId)) {
          blockRef.current.releasePointerCapture(currentDrag.pointerId);
        }
        return;
      }
      if (dragState.current !== currentDrag) return;
      if (!blockRef.current?.hasPointerCapture(currentDrag.pointerId)) {
        blockRef.current?.setPointerCapture(currentDrag.pointerId);
      }
    }

    event.preventDefault();
    onVisualDragMove(event.clientX, event.clientY);
  }

  function endDrag(clientX: number, clientY: number, pointerId?: number) {
    if (!dragState.current) {
      return;
    }

    const didStart = dragState.current.didStart;
    dragState.current = null;
    activePointerId.current = null;

    if (blockRef.current) {
      if (
        pointerId !== undefined &&
        blockRef.current.hasPointerCapture(pointerId)
      ) {
        blockRef.current.releasePointerCapture(pointerId);
      }
    }

    if (didStart) {
      onVisualDragEnd(clientX, clientY);
    }
  }

  function cancelDrag(pointerId?: number) {
    suppressModifierClickRef.current = false;
    const currentDrag = dragState.current;
    if (!currentDrag) {
      return;
    }

    const didStart = currentDrag.didStart;
    const capturedPointerId = pointerId ?? currentDrag.pointerId;
    dragState.current = null;
    activePointerId.current = null;

    if (blockRef.current?.hasPointerCapture(capturedPointerId)) {
      blockRef.current.releasePointerCapture(capturedPointerId);
    }

    if (didStart) {
      onVisualDragCancel();
    }
  }

  function handleHeaderKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "F2") {
      if (isSelected) {
        event.preventDefault();
        event.stopPropagation();
        onEdit(block.id);
      }
      return;
    }
    if (
      event.altKey &&
      event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (block.locked) return;
      onKeyboardResize(
        block.id,
        event.key === "ArrowLeft" ? -1 : 1,
        zoomLevel,
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      leaveEditorForBlockSelection(event.ctrlKey || event.metaKey);
      return;
    }
    const step = (event.shiftKey ? 10 : 1) / zoomLevel;
    const delta = event.key === "ArrowLeft"
      ? { x: -step, y: 0 }
      : event.key === "ArrowRight"
        ? { x: step, y: 0 }
        : event.key === "ArrowUp"
          ? { x: 0, y: -step }
          : event.key === "ArrowDown"
            ? { x: 0, y: step }
            : null;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    leaveEditorForBlockSelection();
    onKeyboardMove(block.id, delta);
  }

  useEffect(() => {
    function cancelPendingDrag() {
      cancelDrag();
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") cancelPendingDrag();
    }

  function handleCapturedDragCancellation(event: PointerEvent) {
      if (!dragState.current || dragState.current.isStarting) {
        suppressModifierClickRef.current = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancelDrag(event.pointerId);
    }

    window.addEventListener("lostpointercapture", handleCapturedDragCancellation, true);
    window.addEventListener("pointercancel", handleCapturedDragCancellation, true);
    window.addEventListener("blur", cancelPendingDrag);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("lostpointercapture", handleCapturedDragCancellation, true);
      window.removeEventListener("pointercancel", handleCapturedDragCancellation, true);
      window.removeEventListener("blur", cancelPendingDrag);
      window.removeEventListener("keydown", handleEscape);
      cancelPendingDrag();
    };
  }, [interactionCancellationKey]);

  function handleRootPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragState.current) {
      moveBlock(event);
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

    onCanvasPanEnd(event);
  }

  function handleRootPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragState.current) {
      event.preventDefault();
      event.stopPropagation();
      cancelDrag(event.pointerId);
      return;
    }

    suppressModifierClickRef.current = false;
    handleRootPointerEnd(event);
  }

  function handleLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragState.current || dragState.current.isStarting) {
      suppressModifierClickRef.current = false;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelDrag(event.pointerId);
  }

  return (
    <div
      className={`text-block ${isSelected ? "is-selected" : ""} ${
        isEditing ? "is-editing" : ""
      } ${
        isDragSourceHidden ? "is-drag-source-hidden" : ""
      } ${
        isSelected && isMultiSelected ? "is-multi-selected" : ""
      } ${
        isSelected && !isEditing ? "is-canvas-mode" : ""
      } ${block.backgroundMode === "transparent" ? "is-transparent-background" : ""} ${isContentSelected ? "is-content-selected" : ""
      }`}
      onClick={(event) => {
        event.stopPropagation();
        if (!isEditing) {
          selectTextBlock(event.ctrlKey || event.metaKey);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!isEditing) {
          editTextBlockAtCachedCaret(event.clientX, event.clientY);
        }
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
        cacheCaretFromPoint(event.clientX, event.clientY);
        leaveEditorForBlockSelection(event.ctrlKey || event.metaKey);
      }}
      ref={setBlockElement}
      onContextMenu={(event) => event.preventDefault()}
      onLostPointerCapture={handleLostPointerCapture}
      onPointerCancel={handleRootPointerCancel}
      onPointerMove={handleRootPointerMove}
      onPointerUp={handleRootPointerEnd}
      data-block-id={block.id}
      data-canvas-element-id={block.id}
      data-canvas-element-type={block.type}
      style={{
        left: block.x,
        top: block.y,
        transform: `rotate(${block.rotation}deg)`,
        transformOrigin: "center",
        width: block.width,
        height: block.height,
        zIndex: isSelected || isEditing || isDragSourceHidden
          ? Math.max(block.zIndex, 1000)
          : block.zIndex,
      }}
    >
      <div
        aria-keyshortcuts={isSelected
          ? block.locked
            ? "F2"
            : "F2 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
          : undefined}
        aria-label={block.locked
          ? isSelected
            ? "Select locked text block; press F2 to edit"
            : "Select locked text block"
          : isSelected
            ? "Select and move text block; press F2 to edit; resize width with Alt+Shift+Left or Right Arrow"
            : "Select and move text block"}
        aria-pressed={isSelected}
        className="text-block-header"
        onClick={(event) => {
          event.stopPropagation();

          if (event.ctrlKey || event.metaKey) {
            return;
          }

          leaveEditorForBlockSelection();
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!isEditing) {
            editTextBlockAtCachedCaret(event.clientX, event.clientY);
          }
        }}
        onPointerDown={startDrag}
        onKeyDown={handleHeaderKeyDown}
        role="button"
        tabIndex={0}
      />
      {isEditing ? (
        <>
          {transientDraftInstructionsId ? (
            <span
              className="editor-shortcut-instructions"
              id={transientDraftInstructionsId}
            >
              Escape cancels this new text block. Control+Enter or Command+Enter saves it.
            </span>
          ) : null}
          <TiptapBlockEditor
            block={block}
            draftInstructionsId={transientDraftInstructionsId}
            onBlur={handleEditorBlur}
            onCancelDraft={isTransientDraft ? cancelTransientDraft : undefined}
            onCanvasPanStart={onCanvasPanStart}
            onChange={handleEditorChange}
            onCommitDraft={isTransientDraft ? commitTransientDraft : undefined}
            initialCaretOffset={pendingCaretOffset.current}
            initialCaretPoint={pendingCaretPoint.current}
            onCaretOffsetHandled={() => {
              pendingCaretOffset.current = null;
            }}
            onCaretPointHandled={() => {
              pendingCaretPoint.current = null;
            }}
            onEditorReady={(editor) => {
              editorRef.current = editor;
              onActiveEditorChange(editor);

              if (editor) {
                scheduleAutosize();
              }
            }}
            onFocusEndHandled={onFocusEndHandled}
            onSelectContent={() => {
              setIsContentSelected(true);
            }}
            onSelectAllBlocks={handleSelectAllBlocksFromEditor}
            onSelectionReset={() => {
              setIsContentSelected(false);
            }}
            shouldFocusEnd={shouldFocusEnd}
          />
        </>
      ) : null}
      {!isEditing ? (
        <div
          className="text-block-display text-block-rich-content"
          onClick={(event) => {
            event.stopPropagation();
            const suppressModifierClick = suppressModifierClickRef.current;
            suppressModifierClickRef.current = false;
            if ((event.ctrlKey || event.metaKey) && suppressModifierClick) {
              return;
            }
            if (!isEditing) {
              selectTextBlock(event.ctrlKey || event.metaKey);
            }
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (!isEditing) {
              editTextBlockAtCachedCaret(event.clientX, event.clientY);
            }
          }}
          onPointerDown={startDrag}
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
          {renderRichBlockContent(
            block,
            `${block.id}-display`,
            searchRanges.length > 0 ? {
              searchableText,
              ranges: searchRanges.map((range) => ({
                start: range.start,
                end: range.end,
                isActive: activeSearchRange?.start === range.start
                  && activeSearchRange.end === range.end,
              })),
            } : undefined,
          )}
        </div>
      ) : null}
      <>
        <div
          aria-hidden="true"
          className="text-block-measurer text-block-rich-content text-block-width-measurer"
          ref={widthMeasureRef}
        />
        <div
          aria-hidden="true"
          className="text-block-measurer text-block-rich-content text-block-height-measurer"
          ref={heightMeasureRef}
        />
      </>
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
    previousRange.elementId === nextRange.elementId &&
    previousRange.source === nextRange.source &&
    previousRange.start === nextRange.start &&
    previousRange.end === nextRange.end
  );
}

type TiptapBlockEditorProps = {
  block: TextElement;
  draftInstructionsId?: string;
  initialCaretOffset: number | null;
  initialCaretPoint: CaretPlacementRequest | null;
  onBlur: (editor: Editor, event: FocusEvent) => void;
  onCancelDraft?: () => void;
  onCaretOffsetHandled: () => void;
  onCaretPointHandled: () => void;
  onCanvasPanStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onChange: (editor: Editor) => void;
  onCommitDraft?: (editor: Editor) => void;
  onEditorReady: (editor: Editor | null) => void;
  onFocusEndHandled: () => void;
  onSelectContent: () => void;
  onSelectAllBlocks: (editor: Editor) => void;
  onSelectionReset: () => void;
  shouldFocusEnd: boolean;
};

type CtrlASelectionStage = "none" | "line" | "manual-line-confirmed" | "all";

type ClipboardEditorImage =
  | {
      file: File;
      kind: "file";
      name: string;
    }
  | {
      kind: "source";
      name: string;
      source: string;
    };

function TiptapBlockEditor({
  block,
  draftInstructionsId,
  initialCaretOffset,
  initialCaretPoint,
  onBlur,
  onCancelDraft,
  onCaretOffsetHandled,
  onCaretPointHandled,
  onCanvasPanStart,
  onChange,
  onCommitDraft,
  onEditorReady,
  onFocusEndHandled,
  onSelectContent,
  onSelectAllBlocks,
  onSelectionReset,
  shouldFocusEnd,
}: TiptapBlockEditorProps) {
  const ctrlAStageRef = useRef<CtrlASelectionStage>("none");
  const onSelectContentRef = useRef(onSelectContent);
  const onSelectAllBlocksRef = useRef(onSelectAllBlocks);
  const onSelectionResetRef = useRef(onSelectionReset);
  const onCancelDraftRef = useRef(onCancelDraft);
  const onCommitDraftRef = useRef(onCommitDraft);
  const editorExtensions = useMemo(
    () => [...richTextExtensions, createSlashCommandExtension(block.id)],
    [block.id],
  );

  onSelectContentRef.current = onSelectContent;
  onSelectAllBlocksRef.current = onSelectAllBlocks;
  onSelectionResetRef.current = onSelectionReset;
  onCancelDraftRef.current = onCancelDraft;
  onCommitDraftRef.current = onCommitDraft;

  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: getTipTapContent(block),
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          ...(draftInstructionsId
            ? {
                "aria-describedby": draftInstructionsId,
                "aria-keyshortcuts": "Escape Control+Enter Meta+Enter",
              }
            : {}),
          "aria-multiline": "true",
          "aria-label": draftInstructionsId ? "New text block" : "Text block",
          class: "text-block-editor-content text-block-rich-content",
          role: "textbox",
        },
        handleKeyDown: (view, event) => {
          if (event.isComposing || event.keyCode === 229) {
            return false;
          }

          const isDraftEscape = event.key === "Escape" && Boolean(onCancelDraftRef.current);
          const isDraftCommit = event.key === "Enter"
            && (event.ctrlKey || event.metaKey)
            && Boolean(onCommitDraftRef.current);
          if (
            event.repeat && (isDraftEscape || isDraftCommit)
            || isDraftCommit && (event.altKey || event.shiftKey)
          ) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }

          if (isDraftEscape && onCancelDraftRef.current) {
            event.preventDefault();
            event.stopPropagation();
            onCancelDraftRef.current();
            return true;
          }

          if (
            isDraftCommit
            && onCommitDraftRef.current
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (editor) {
              onCommitDraftRef.current(editor);
            }
            return true;
          }

          const isCtrlA =
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "a";

          if (!isCtrlA) {
            ctrlAStageRef.current = "none";
            return false;
          }

          event.preventDefault();
          event.stopPropagation();

          if (isWholeEditorDocumentSelected(view.state)) {
            if (editor) {
              ctrlAStageRef.current = "none";
              onSelectAllBlocksRef.current(editor);
            }

            return true;
          }

          const selectAllContent = () => {
            view.dispatch(
              view.state.tr
                .setSelection(new AllSelection(view.state.doc))
                .scrollIntoView(),
            );
            ctrlAStageRef.current = "all";
            onSelectContentRef.current();
          };

          if (
            ctrlAStageRef.current === "line" ||
            ctrlAStageRef.current === "manual-line-confirmed" ||
            ctrlAStageRef.current === "all"
          ) {
            selectAllContent();
            return true;
          }

          const selectionScope = getSelectionLineScope(view.state);

          if (selectionScope === "multi-line") {
            selectAllContent();
            return true;
          }

          const currentLineRange = getCurrentLineSelectionRange(view.state);

          view.dispatch(
            view.state.tr
              .setSelection(
                TextSelection.create(
                  view.state.doc,
                  currentLineRange.from,
                  currentLineRange.to,
                ),
              )
              .scrollIntoView(),
          );
          ctrlAStageRef.current =
            selectionScope === "single-line" ? "manual-line-confirmed" : "line";
          onSelectionResetRef.current();
          return true;
        },
        handlePaste: (_view, event) => {
          const clipboardImage = getClipboardEditorImage(event.clipboardData);

          if (!clipboardImage) {
            return false;
          }

          event.preventDefault();
          event.stopPropagation();
          void insertClipboardImage(editor, clipboardImage);
          return true;
        },
      },
      onBlur: ({ editor, event }) => {
        ctrlAStageRef.current = "none";
        onBlur(editor, event);
      },
      onSelectionUpdate: ({ editor }) => {
        if (isWholeEditorDocumentSelected(editor.state)) {
          onSelectContentRef.current();
          return;
        }

        onSelectionResetRef.current();
      },
      onUpdate: ({ editor }) => {
        ctrlAStageRef.current = "none";
        onChange(editor);
      },
    },
    [block.id],
  );

  useEffect(() => {
    if (!editor) {
      return;
    }

    ctrlAStageRef.current = "none";
    onEditorReady(editor);
    let focusRafId: number | null = null;
    let placementRafId: number | null = null;

    focusRafId = window.requestAnimationFrame(() => {
      placementRafId = window.requestAnimationFrame(() => {
        if (initialCaretPoint || initialCaretOffset !== null) {
          placeEditorCaret(editor, initialCaretPoint, initialCaretOffset);
          onCaretPointHandled();
          onCaretOffsetHandled();
          return;
        }

        if (shouldFocusEnd) {
          editor.commands.focus("end");
          onFocusEndHandled();
          return;
        }

        editor.commands.focus();
      });
    });

    return () => {
      if (focusRafId !== null) {
        window.cancelAnimationFrame(focusRafId);
      }

      if (placementRafId !== null) {
        window.cancelAnimationFrame(placementRafId);
      }

      onEditorReady(null);
    };
  }, [
    editor,
    initialCaretOffset,
    initialCaretPoint,
    onCaretOffsetHandled,
    onCaretPointHandled,
    onEditorReady,
    onFocusEndHandled,
    shouldFocusEnd,
  ]);

  if (!editor) {
    return null;
  }

  function resetCtrlAStage() {
    ctrlAStageRef.current = "none";
  }

  return (
    <>
      <EditorContent
        className="text-block-editor"
        editor={editor}
        onKeyDown={(event) => {
          if (!((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a")) {
            resetCtrlAStage();
          }
        }}
        onMouseDown={() => {
          resetCtrlAStage();
          onSelectionReset();
        }}
        onPointerDown={(event) => {
          if (event.button === 2) {
            onCanvasPanStart(event);
          }
        }}
      />
    </>
  );
}

function getClipboardEditorImage(
  clipboardData: DataTransfer | null,
): ClipboardEditorImage | null {
  const clipboardItems = Array.from(clipboardData?.items ?? []);
  const imageItem = clipboardItems.find((item) =>
    item.type.startsWith("image/"),
  );
  const imageItemFile = imageItem?.getAsFile();

  if (imageItemFile) {
    return {
      file: imageItemFile,
      kind: "file",
      name: imageItemFile.name || "Pasted image",
    };
  }

  const imageFile = Array.from(clipboardData?.files ?? []).find((file) =>
    file.type.startsWith("image/"),
  );

  if (imageFile) {
    return {
      file: imageFile,
      kind: "file",
      name: imageFile.name || "Pasted image",
    };
  }

  const html = clipboardData?.getData("text/html") ?? "";
  const htmlImageSource = getClipboardHtmlImageSource(html);

  if (htmlImageSource) {
    return {
      kind: "source",
      name: getImageNameFromSource(htmlImageSource),
      source: htmlImageSource,
    };
  }

  return null;
}

function getClipboardHtmlImageSource(html: string) {
  if (!html.trim()) {
    return null;
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const imageElement = template.content.querySelector("img");
  const imageSource = imageElement?.getAttribute("src")?.trim();

  if (!imageSource || !isPasteableImageSource(imageSource)) {
    return null;
  }

  return imageSource;
}

function isPasteableImageSource(source: string) {
  return source.startsWith("data:image/") || /^https?:\/\//i.test(source);
}

function getImageNameFromSource(source: string) {
  if (source.startsWith("data:image/")) {
    return "Pasted image";
  }

  try {
    const pathName = new URL(source).pathname;
    const pathParts = pathName.split("/").filter(Boolean);
    const name = decodeURIComponent(pathParts[pathParts.length - 1] ?? "");

    return name || "Pasted image";
  } catch {
    return "Pasted image";
  }
}

async function insertClipboardImage(
  editor: Editor | null,
  clipboardImage: ClipboardEditorImage,
) {
  if (!editor || editor.isDestroyed) {
    return;
  }

  const source =
    clipboardImage.kind === "file"
      ? await readFileAsDataUrl(clipboardImage.file)
      : clipboardImage.source;
  const dimensions = await getImageDimensions(source);

  if (editor.isDestroyed) {
    return;
  }

  editor
    .chain()
    .focus()
    .insertContent({
      type: "image",
      attrs: {
        alt: clipboardImage.name,
        src: source,
        ...(dimensions ? dimensions : {}),
      },
    })
    .run();
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(reader.error ?? new Error("Could not read image."));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Image reader returned an unsupported result."));
    };
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(source: string) {
  return new Promise<{ width: number; height: number } | null>((resolve) => {
    const image = new Image();

    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({
          height: image.naturalHeight,
          width: image.naturalWidth,
        });
        return;
      }

      resolve(null);
    };
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

type SelectionLineScope = "caret" | "single-line" | "multi-line" | "all";

function getCurrentLineSelectionRange(state: EditorState) {
  return getTextblockRangeAtPosition(state, state.selection.$anchor.pos);
}

function getSelectionLineScope(state: EditorState): SelectionLineScope {
  const { selection } = state;

  if (isWholeEditorDocumentSelected(state)) {
    return "all";
  }

  if (selection.empty) {
    return "caret";
  }

  const fromRange = getTextblockRangeAtPosition(state, selection.from);
  const toRange = getTextblockRangeAtPosition(
    state,
    Math.max(selection.from, selection.to - 1),
  );

  return fromRange.from === toRange.from && fromRange.to === toRange.to
    ? "single-line"
    : "multi-line";
}

function getTextblockRangeAtPosition(state: EditorState, position: number) {
  const { doc } = state;
  const resolvedPosition = doc.resolve(
    Math.max(0, Math.min(position, doc.content.size)),
  );

  for (let depth = resolvedPosition.depth; depth > 0; depth -= 1) {
    const node = resolvedPosition.node(depth);

    if (node.isTextblock) {
      return {
        from: resolvedPosition.start(depth),
        to: resolvedPosition.end(depth),
      };
    }
  }

  return {
    from: 1,
    to: Math.max(1, doc.content.size - 1),
  };
}

function isWholeEditorDocumentSelected(state: EditorState) {
  const { doc, selection } = state;

  return (
    !selection.empty &&
    selection.from <= 0 &&
    selection.to >= doc.content.size
  );
}

function areRichContentsEqual(
  firstContent: JSONContent | undefined,
  secondContent: JSONContent | undefined,
) {
  return JSON.stringify(firstContent) === JSON.stringify(secondContent);
}

function getTipTapMeasureText(content: JSONContent) {
  const lines: string[] = [];

  collectTipTapMeasureLines(content, lines);

  return lines.join("\n");
}

function collectTipTapMeasureLines(content: JSONContent, lines: string[]) {
  switch (content.type) {
    case "doc":
    case "bulletList":
    case "orderedList":
      content.content?.forEach((child) =>
        collectTipTapMeasureLines(child, lines),
      );
      return;
    case "paragraph":
    case "heading":
    case "codeBlock":
      lines.push(getInlineMeasureText(content));
      return;
    case "blockquote":
    case "listItem": {
      const blockChildren =
        content.content?.filter((child) => isMeasureBlockNode(child)) ?? [];

      if (blockChildren.length > 0) {
        blockChildren.forEach((child) =>
          collectTipTapMeasureLines(child, lines),
        );
      } else {
        lines.push(getInlineMeasureText(content));
      }

      return;
    }
    default:
      if (!content.content || content.content.length === 0) {
        return;
      }

      lines.push(getInlineMeasureText(content));
  }
}

function isMeasureBlockNode(content: JSONContent) {
  return (
    content.type === "paragraph" ||
    content.type === "heading" ||
    content.type === "codeBlock" ||
    content.type === "blockquote" ||
    content.type === "bulletList" ||
    content.type === "orderedList" ||
    content.type === "listItem"
  );
}

function getInlineMeasureText(content: JSONContent) {
  const parts: string[] = [];

  collectInlineMeasureText(content, parts);

  return parts.join("") || " ";
}

function collectInlineMeasureText(content: JSONContent, parts: string[]) {
  if (content.type === "text") {
    parts.push(content.text ?? "");
    return;
  }

  if (content.type === "hardBreak") {
    parts.push("\n");
    return;
  }

  content.content?.forEach((child) => collectInlineMeasureText(child, parts));
}

type TipTapImageMetrics = {
  images: Array<{
    height: number;
    width: number;
  }>;
  maxWidth: number;
};

function getTipTapImageMetrics(content: JSONContent): TipTapImageMetrics {
  const images: TipTapImageMetrics["images"] = [];

  collectTipTapImageMetrics(content, images);

  return {
    images,
    maxWidth: images.reduce(
      (currentMaxWidth, image) => Math.max(currentMaxWidth, image.width),
      0,
    ),
  };
}

function collectTipTapImageMetrics(
  content: JSONContent,
  images: TipTapImageMetrics["images"],
) {
  if (content.type === "image") {
    const width = Number(content.attrs?.width);
    const height = Number(content.attrs?.height);

    images.push({
      height: Number.isFinite(height) && height > 0 ? height : 160,
      width: Number.isFinite(width) && width > 0 ? width : DEFAULT_BLOCK_WIDTH,
    });
    return;
  }

  content.content?.forEach((child) => collectTipTapImageMetrics(child, images));
}

function areTextBlockViewPropsEqual(
  previousProps: TextBlockViewProps,
  nextProps: TextBlockViewProps,
) {
  return (
    previousProps.block === nextProps.block &&
    previousProps.isDragSourceHidden === nextProps.isDragSourceHidden &&
    previousProps.isEditing === nextProps.isEditing &&
    previousProps.isTransientDraft === nextProps.isTransientDraft &&
    previousProps.interactionCancellationKey === nextProps.interactionCancellationKey &&
    previousProps.isMultiSelected === nextProps.isMultiSelected &&
    previousProps.isSelected === nextProps.isSelected &&
    previousProps.searchRanges === nextProps.searchRanges &&
    previousProps.searchableText === nextProps.searchableText &&
    previousProps.shouldFocusEnd === nextProps.shouldFocusEnd &&
    previousProps.zoomLevel === nextProps.zoomLevel &&
    areSearchRangesEqual(
      previousProps.activeSearchRange,
      nextProps.activeSearchRange,
    )
  );
}
