import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Mark, Node as TiptapNode, mergeAttributes, type Editor, type JSONContent } from "@tiptap/core";
import { AllSelection, TextSelection, type EditorState } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
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

const TextStyle = Mark.create({
  name: "textStyle",

  addAttributes() {
    return {
      fontFamily: {
        default: null,
        parseHTML: (element: HTMLElement) => element.style.fontFamily || null,
      },
      fontSize: {
        default: null,
        parseHTML: (element: HTMLElement) => element.style.fontSize || null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span",
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }

          return node.style.fontFamily || node.style.fontSize ? null : false;
        },
      },
    ];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const attrs = mark.attrs as {
      fontFamily?: string | null;
      fontSize?: string | null;
    };
    const styleParts = [
      attrs.fontFamily ? `font-family: ${attrs.fontFamily}` : "",
      attrs.fontSize ? `font-size: ${attrs.fontSize}` : "",
    ].filter(Boolean);

    return [
      "span",
      mergeAttributes(
        HTMLAttributes,
        styleParts.length ? { style: styleParts.join("; ") } : {},
      ),
      0,
    ];
  },
});

const RichImage = TiptapNode.create({
  name: "image",

  group: "block",

  atom: true,

  draggable: false,

  selectable: true,

  addAttributes() {
    return {
      alt: {
        default: null,
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const height = Number(element.getAttribute("height"));

          return Number.isFinite(height) && height > 0 ? height : null;
        },
      },
      src: {
        default: null,
      },
      title: {
        default: null,
      },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const width = Number(element.getAttribute("width"));

          return Number.isFinite(width) && width > 0 ? width : null;
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },
});

const tiptapExtensions = [StarterKit, TextStyle, RichImage];
const TEXT_BLOCK_HORIZONTAL_PADDING = 18;
const INLINE_IMAGE_VERTICAL_GAP = 4;

type TextBlockViewProps = {
  block: TextBlock;
  activeSearchRange: SearchMatch | null;
  isEditing: boolean;
  isDragSourceHidden: boolean;
  isMultiSelected: boolean;
  isSelected: boolean;
  searchQuery: string;
  shouldFocusEnd: boolean;
  onEditEnd: (blockId: string) => void;
  onDelete: (blockId: string) => void;
  onEdit: (blockId: string) => void;
  onActiveEditorChange: (editor: Editor | null) => void;
  onCanvasPanEnd: (event: ReactPointerEvent<HTMLElement>) => void;
  onCanvasPanMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onCanvasPanStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onFocusEndHandled: () => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onBlockElementChange: (
    blockId: string,
    element: HTMLDivElement | null,
  ) => void;
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

type CaretPoint = {
  clientX: number;
  clientY: number;
};

export const TextBlockView = memo(function TextBlockView({
  block,
  activeSearchRange,
  isEditing,
  isDragSourceHidden,
  isMultiSelected,
  isSelected,
  searchQuery,
  shouldFocusEnd,
  onEditEnd,
  onDelete,
  onEdit,
  onActiveEditorChange,
  onCanvasPanEnd,
  onCanvasPanMove,
  onCanvasPanStart,
  onFocusEndHandled,
  onInteractionModeChange,
  onBlockElementChange,
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
  const resizeState = useRef<ResizeState | null>(null);
  const isResizingRef = useRef(false);
  const activePointerId = useRef<number | null>(null);
  const hasManualWidth = useRef(Boolean(block.isWidthManuallyResized));
  const pendingCaretOffset = useRef<number | null>(null);
  const pendingCaretPoint = useRef<CaretPoint | null>(null);
  const draftContentRef = useRef(block.content);
  const draftRichContentRef = useRef<JSONContent>(
    getTipTapContent(block),
  );
  const draftMeasureTextRef = useRef(
    getTipTapMeasureText(getTipTapContent(block)),
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
  const latestAutosizeText = useRef(block.content);
  const [isContentSelected, setIsContentSelected] = useState(false);

  const setBlockElement = useCallback(
    (element: HTMLDivElement | null) => {
      blockRef.current = element;
      onBlockElementChange(block.id, element);

      if (!element) {
        lastAppliedSizeRef.current = null;
        return;
      }

      element.classList.toggle("is-resizing", isResizingRef.current);
    },
    [block.id, onBlockElementChange],
  );

  useEffect(() => {
    committedContentRef.current = block.content;
    committedRichContentRef.current = getTipTapContent(block);

    if (!isEditing) {
      draftContentRef.current = block.content;
      draftRichContentRef.current = getTipTapContent(block);
      draftMeasureTextRef.current = getTipTapMeasureText(
        draftRichContentRef.current,
      );
      latestAutosizeText.current = "";
    }
  }, [block.content, block.id, block.richContent, isEditing]);

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
    measureContent = draftRichContentRef.current,
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
    const measureText = getTipTapMeasureText(measureContent);
    const imageMetrics = getTipTapImageMetrics(measureContent);

    setMeasureText(measureText);

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

    const measuredImageHeight = getScaledImageHeight(
      imageMetrics,
      Math.max(MIN_BLOCK_WIDTH, measuredWidth - TEXT_BLOCK_HORIZONTAL_PADDING),
    );
    const measuredHeight =
      heightMeasureElement.scrollHeight + measuredImageHeight;

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
      draftRichContentRef.current,
    ).height;
  }

  function getMeasureText() {
    return draftMeasureTextRef.current.length > 0
      ? draftMeasureTextRef.current
      : " ";
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

  function handleEditorChange(editor: Editor) {
    if (isContentSelected) {
      setIsContentSelected(false);
    }

    draftContentRef.current = editor.getText({ blockSeparator: "\n" });
    draftRichContentRef.current = editor.getJSON();
    draftMeasureTextRef.current = getTipTapMeasureText(
      draftRichContentRef.current,
    );
    applyAutosize();
    scheduleContentCommit();
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
    draftMeasureTextRef.current = getTipTapMeasureText(
      draftRichContentRef.current,
    );

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
    if (
      document.body.dataset.noteToolbarInteraction === "true" ||
      isToolbarBlurTarget(event.relatedTarget) ||
      isToolbarBlurTarget(document.activeElement)
    ) {
      commitEditorDraft(editor, {
        deleteEmpty: false,
        endEdit: false,
        includeSizeUpdates: false,
      });
      onActiveEditorChange(editor);
      return;
    }

    setIsContentSelected(false);
    onActiveEditorChange(null);
    window.getSelection()?.removeAllRanges();
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
      leaveEditorForBlockSelection(true);
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    leaveEditorForBlockSelection();

    const didStartDrag = onVisualDragStart(
      block.id,
      event.clientX,
      event.clientY,
    );

    if (!didStartDrag) {
      return;
    }

    dragState.current = {
      pointerId: event.pointerId,
    };
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
        isDragSourceHidden ? "is-drag-source-hidden" : ""
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
        leaveEditorForBlockSelection(event.ctrlKey || event.metaKey);
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

          if (event.ctrlKey || event.metaKey) {
            return;
          }

          leaveEditorForBlockSelection();
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
        }}
        onPointerDown={startDrag}
        role="button"
        tabIndex={0}
      />
      {isEditing && !block.imageData ? (
        <TiptapBlockEditor
          block={block}
          onBlur={handleEditorBlur}
          onCanvasPanStart={onCanvasPanStart}
          onChange={handleEditorChange}
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
      ) : null}
      {!isEditing && !block.imageData ? (
        <div
          className="text-block-display"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();

            if (event.ctrlKey || event.metaKey) {
              return;
            }

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

            if (event.ctrlKey || event.metaKey) {
              pendingCaretOffset.current = null;
              pendingCaretPoint.current = null;
              onSelect(block.id, true);
              return;
            }

            pendingCaretOffset.current = getCaretOffsetFromPoint(
              event.clientX,
              event.clientY,
            );
            pendingCaretPoint.current = {
              clientX: event.clientX,
              clientY: event.clientY,
            };
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
          {...(searchQuery.trim()
            ? { children: renderHighlightedContent() }
            : { children: renderRichBlockContent(block) })}
        />
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

type TiptapBlockEditorProps = {
  block: TextBlock;
  initialCaretOffset: number | null;
  initialCaretPoint: CaretPoint | null;
  onBlur: (editor: Editor, event: FocusEvent) => void;
  onCaretOffsetHandled: () => void;
  onCaretPointHandled: () => void;
  onCanvasPanStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onChange: (editor: Editor) => void;
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
  initialCaretOffset,
  initialCaretPoint,
  onBlur,
  onCaretOffsetHandled,
  onCaretPointHandled,
  onCanvasPanStart,
  onChange,
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

  onSelectContentRef.current = onSelectContent;
  onSelectAllBlocksRef.current = onSelectAllBlocks;
  onSelectionResetRef.current = onSelectionReset;

  const editor = useEditor(
    {
      extensions: tiptapExtensions,
      content: getTipTapContent(block),
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          "aria-label": "Text block",
          class: "text-block-editor-content",
        },
        handleKeyDown: (view, event) => {
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
        const initialCaretPosition = getInitialCaretPosition(
          editor,
          initialCaretPoint,
          initialCaretOffset,
        );

        if (initialCaretPosition !== null) {
          editor.commands.focus();
          editor.commands.setTextSelection(initialCaretPosition);
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

function getTipTapContent(block: TextBlock): JSONContent {
  if (
    block.richContent &&
    (!block.content.trim() || hasTipTapRenderableContent(block.richContent))
  ) {
    return block.richContent;
  }

  return plainTextToTipTapDoc(block.content);
}

function plainTextToTipTapDoc(text: string): JSONContent {
  const lines = text.split("\n");

  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : undefined,
    })),
  };
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

function getScaledImageHeight(
  metrics: TipTapImageMetrics,
  availableContentWidth: number,
) {
  return metrics.images.reduce((height, image) => {
    const scale = Math.min(1, availableContentWidth / image.width);

    return height + image.height * scale + INLINE_IMAGE_VERTICAL_GAP;
  }, 0);
}

function hasTipTapRenderableContent(content: JSONContent): boolean {
  if (content.type === "text") {
    return Boolean(content.text?.trim());
  }

  if (content.type === "image" && typeof content.attrs?.src === "string") {
    return true;
  }

  return content.content?.some(hasTipTapRenderableContent) ?? false;
}

function renderRichBlockContent(block: TextBlock) {
  try {
    return renderTipTapContent(getTipTapContent(block));
  } catch {
    return block.content.split("\n").map((line, index) => (
      <p key={`${block.id}-fallback-${index}`}>
        {line ? line : <br />}
      </p>
    ));
  }
}

function renderTipTapContent(content: JSONContent, key = "root"): ReactNode {
  if (content.type === "text") {
    return renderTextMarks(content.text ?? "", content.marks ?? [], key);
  }

  const children = content.content?.map((child, index) =>
    renderTipTapContent(child, `${key}-${index}`),
  );

  switch (content.type) {
    case "doc":
      return children;
    case "paragraph":
      return <p key={key}>{children?.length ? children : <br />}</p>;
    case "bulletList":
      return <ul key={key}>{children}</ul>;
    case "orderedList":
      return <ol key={key}>{children}</ol>;
    case "listItem":
      return <li key={key}>{children}</li>;
    case "blockquote":
      return <blockquote key={key}>{children}</blockquote>;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{children}</code>
        </pre>
      );
    case "heading": {
      const HeadingTag = `h${content.attrs?.level ?? 1}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6";

      return <HeadingTag key={key}>{children}</HeadingTag>;
    }
    case "image": {
      const src = typeof content.attrs?.src === "string" ? content.attrs.src : "";
      const alt =
        typeof content.attrs?.alt === "string" ? content.attrs.alt : "Pasted image";

      return src ? (
        <img
          alt={alt}
          className="text-block-rich-image"
          key={key}
          src={src}
        />
      ) : null;
    }
    case "hardBreak":
      return <br key={key} />;
    case "horizontalRule":
      return <hr key={key} />;
    default:
      return children;
  }
}

function renderTextMarks(
  text: string,
  marks: NonNullable<JSONContent["marks"]>,
  key: string,
) {
  return marks.reduce<ReactNode>((currentNode, mark, index) => {
    const markKey = `${key}-mark-${index}`;

    switch (mark.type) {
      case "bold":
        return <strong key={markKey}>{currentNode}</strong>;
      case "italic":
        return <em key={markKey}>{currentNode}</em>;
      case "strike":
        return <s key={markKey}>{currentNode}</s>;
      case "underline":
        return <u key={markKey}>{currentNode}</u>;
      case "code":
        return <code key={markKey}>{currentNode}</code>;
      case "textStyle": {
        const style: CSSProperties = {};

        if (typeof mark.attrs?.fontFamily === "string") {
          style.fontFamily = mark.attrs.fontFamily;
        }

        if (typeof mark.attrs?.fontSize === "string") {
          style.fontSize = mark.attrs.fontSize;
        }

        return (
          <span key={markKey} style={style}>
            {currentNode}
          </span>
        );
      }
      default:
        return currentNode;
    }
  }, text);
}

function getInitialCaretPosition(
  editor: Editor,
  caretPoint: CaretPoint | null,
  textOffset: number | null,
) {
  const offsetPosition =
    textOffset !== null
      ? getDocumentPositionFromTextOffset(editor, textOffset)
      : null;
  const pointPosition = caretPoint
    ? editor.view.posAtCoords({
        left: caretPoint.clientX,
        top: caretPoint.clientY,
      })?.pos ?? null
    : null;

  if (pointPosition !== null) {
    if (
      pointPosition <= 1 &&
      offsetPosition !== null &&
      offsetPosition > 1
    ) {
      return offsetPosition;
    }

    return pointPosition;
  }

  return offsetPosition;
}

function getDocumentPositionFromTextOffset(editor: Editor, textOffset: number) {
  let remainingOffset = Math.max(0, textOffset);
  let documentPosition = 1;

  editor.state.doc.descendants((node, position) => {
    if (!node.isText) {
      return true;
    }

    const textLength = node.text?.length ?? 0;

    if (remainingOffset <= textLength) {
      documentPosition = position + remainingOffset;
      return false;
    }

    remainingOffset -= textLength;
    return true;
  });

  if (remainingOffset > 0) {
    return editor.state.doc.content.size;
  }

  return documentPosition;
}

function areTextBlockViewPropsEqual(
  previousProps: TextBlockViewProps,
  nextProps: TextBlockViewProps,
) {
  return (
    previousProps.block === nextProps.block &&
    previousProps.isDragSourceHidden === nextProps.isDragSourceHidden &&
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
