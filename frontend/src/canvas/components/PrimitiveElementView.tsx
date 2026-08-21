import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type RefCallback } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { RoughSVG } from "roughjs/bin/svg";
import type { Options } from "roughjs/bin/core";
import type { CanvasColor, CanvasElement, ConnectorElement, ElementId, RichTextValue, RoughStyle, ShapeElement } from "../model/elements";
import type { SearchMatch } from "../../appTypes";
import { resolveConnectorPoints } from "../model/connectorBinding";
import { roundedDiamondPath, roundedRectanglePath } from "../model/shapeBoundary";
export { roundedDiamondPath, roundedRectanglePath } from "../model/shapeBoundary";
import { canvasColorToCss } from "../rendering/canvasColor";
import { createSlashCommandExtension } from "../../editor/SlashCommandExtension";
import {
  getCanonicalShapeRichTextDocument,
  getShapeTextAccessibleExcerpt,
  hasTipTapRenderableContent,
  renderShapeRichTextContent,
  shapeRichTextExtensions,
  validateRichTextDocument,
} from "../../editor/richText";

type PrimitiveElementViewProps<T extends ShapeElement | ConnectorElement> = {
  element: T;
  isDragSourceHidden?: boolean;
  isSelected: boolean;
  onElementChange?: (elementId: string, element: HTMLDivElement | null) => void;
  onKeyboardMove: (elementId: string, delta: Readonly<{ x: number; y: number }>) => void;
  onSelect: (elementId: string, additive?: boolean) => void;
};

type ShapeElementViewProps = PrimitiveElementViewProps<ShapeElement> & {
  activeSearchRange: SearchMatch | null;
  isEditing: boolean;
  onActiveEditorChange: (editor: Editor | null) => void;
  onEdit: (elementId: string) => void;
  onEditEnd: (elementId: string, outcome?: ShapeTextEditOutcome, restoreFocus?: boolean) => void;
  onEditSessionChange: (elementId: string, session: ShapeTextEditSession | null) => void;
  onTextCommit: (elementId: string, text: RichTextValue | undefined) => void;
  searchRanges: readonly SearchMatch[];
  searchableText: string;
};

export type ShapeTextEditOutcome = "canceled" | "committed" | "unchanged";
export type ShapeTextEditSession = Readonly<{ cancel: () => void; commit: () => void }>;

export function shouldRenderShapeTextSurface(element: ShapeElement, isEditing: boolean) {
  return element.style.fillColor != null && (isEditing || element.text !== undefined);
}

function createPrimitiveRootRef(elementId: string, onElementChange?: PrimitiveElementViewProps<ShapeElement>["onElementChange"]): RefCallback<HTMLDivElement> {
  return (element) => onElementChange?.(elementId, element);
}

export function roughOptions(style: ShapeElement["style"], visualScale = 1): Options {
  const dashScale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1;
  return {
    fill: style.fillColor ? canvasColorToCss(style.fillColor) : "none",
    curveFitting: 0.9,
    disableMultiStroke: true,
    disableMultiStrokeFill: true,
    roughness: style.roughness,
    seed: style.seed,
    stroke: canvasColorToCss(style.strokeColor),
    strokeLineDash: style.strokeStyle === "dashed"
      ? [8 * dashScale, 5 * dashScale]
      : style.strokeStyle === "dotted"
        ? [2 * dashScale, 4 * dashScale]
        : undefined,
    strokeWidth: style.strokeWidth,
  };
}

function finishRoughNode(node: SVGElement): SVGElement {
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  return node;
}

/** Extra SVG-only space for RoughJS's imperfect outline; model geometry stays untouched. */
export function shapeRenderPadding(style: ShapeElement["style"]): number {
  return Math.ceil(Math.max(8, style.strokeWidth * 2, style.roughness * 2 + style.strokeWidth));
}

/** Shared seeded shape painter used by committed elements and live previews. */
export function renderShapeRoughSvg(
  svg: SVGSVGElement,
  shape: ShapeElement["shape"],
  style: RoughStyle,
  width: number,
  height: number,
  padding = 0,
) {
  svg.replaceChildren();
  const draw = new RoughSVG(svg);
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const options = roughOptions(style);
  const node = shape === "rectangle"
    ? draw.path(roundedRectanglePath(safeWidth, safeHeight, style.roundness), options)
    : shape === "ellipse"
      ? draw.ellipse(safeWidth / 2, safeHeight / 2, safeWidth, safeHeight, options)
      : draw.path(roundedDiamondPath(safeWidth, safeHeight), options);
  finishRoughNode(node);
  if (padding !== 0) node.setAttribute("transform", `translate(${padding} ${padding})`);
  svg.append(node);
  return node;
}

export function arrowheadPoints(
  start: Readonly<{ x: number; y: number }>,
  end: Readonly<{ x: number; y: number }>,
  length = 12,
  halfWidth = 5,
): [[number, number], [number, number], [number, number]] | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.01) return null;
  const unitX = dx / distance;
  const unitY = dy / distance;
  const baseX = end.x - unitX * Math.min(length, distance * 0.45);
  const baseY = end.y - unitY * Math.min(length, distance * 0.45);
  return [
    [end.x, end.y],
    [baseX + unitY * halfWidth, baseY - unitX * halfWidth],
    [baseX - unitY * halfWidth, baseY + unitX * halfWidth],
  ];
}

function keyboardDelta(event: KeyboardEvent<HTMLDivElement>) {
  const step = event.shiftKey ? 10 : 1;
  if (event.key === "ArrowLeft") return { x: -step, y: 0 };
  if (event.key === "ArrowRight") return { x: step, y: 0 };
  if (event.key === "ArrowUp") return { x: 0, y: -step };
  if (event.key === "ArrowDown") return { x: 0, y: step };
  return null;
}

function primitiveKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  element: ShapeElement | ConnectorElement,
  onKeyboardMove: PrimitiveElementViewProps<ShapeElement>["onKeyboardMove"],
  onSelect: PrimitiveElementViewProps<ShapeElement>["onSelect"],
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect(element.id, event.ctrlKey || event.metaKey);
    return;
  }
  const delta = keyboardDelta(event);
  if (!delta || element.locked) return;
  event.preventDefault();
  event.stopPropagation();
  onSelect(element.id);
  onKeyboardMove(element.id, delta);
}

export function ShapeElementView({ activeSearchRange, element, isDragSourceHidden = false, isEditing, isSelected, onActiveEditorChange, onEdit, onEditEnd, onEditSessionChange, onElementChange, onKeyboardMove, onSelect, onTextCommit, searchRanges, searchableText }: ShapeElementViewProps) {
  const ref = useRef<SVGSVGElement | null>(null);
  const rootRef = createPrimitiveRootRef(element.id, onElementChange);
  const renderPadding = shapeRenderPadding(element.style);
  const accessibleName = useMemo(
    () => shapeAccessibleName(element),
    [element.locked, element.shape, element.text],
  );
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.replaceChildren();
    renderShapeRoughSvg(svg, element.shape, element.style, element.width, element.height, renderPadding);
  }, [element, renderPadding]);
  return (
    <div
      aria-label={isEditing ? shapeEditingAccessibleName(element) : accessibleName}
      aria-keyshortcuts={isEditing ? "Escape Control+Enter" : "F2"}
      aria-pressed={isEditing ? undefined : isSelected}
      className={`primitive-element shape-element ${isEditing ? "is-editing" : ""} ${shouldRenderShapeTextSurface(element, isEditing) ? "has-contained-text-surface" : ""} ${isDragSourceHidden ? "is-drag-source-hidden" : ""}`}
      data-canvas-element-id={element.id}
      data-canvas-element-type="shape"
      onKeyDown={(event) => {
        if (event.key === "F2") {
          event.preventDefault();
          event.stopPropagation();
          onEdit(element.id);
          return;
        }
        primitiveKeyDown(event, element, onKeyboardMove, onSelect);
      }}
      ref={rootRef}
      role={isEditing ? "group" : "button"}
      style={{ height: element.height, left: element.x, opacity: element.opacity, position: "absolute", top: element.y, transform: `rotate(${element.rotation}deg)`, width: element.width, zIndex: element.zIndex }}
      tabIndex={isEditing ? -1 : 0}
    >
      <svg
        aria-label={`${element.shape} shape`}
        className="primitive-shape"
        data-seed={element.style.seed}
        height={`calc(100% + ${renderPadding * 2}px)`}
        overflow="visible"
        ref={ref}
        style={{ left: -renderPadding, position: "absolute", top: -renderPadding, width: `calc(100% + ${renderPadding * 2}px)` }}
      />
      {isEditing ? (
        <ShapeContainedTextEditor
          element={element}
          onActiveEditorChange={onActiveEditorChange}
          onCancel={(restoreFocus) => onEditEnd(element.id, "canceled", restoreFocus)}
          onCommit={(text, outcome, restoreFocus) => {
            onTextCommit(element.id, text);
            onEditEnd(element.id, outcome, restoreFocus);
          }}
          onEditSessionChange={onEditSessionChange}
        />
      ) : element.text ? (
        <div
          aria-hidden="true"
          className="shape-contained-text shape-contained-text-display text-block-rich-content"
          style={shapeTextInsetStyle(element)}
        >
          <div className="shape-contained-text-content">
            {renderShapeRichTextContent(
              element.text,
              `${element.id}-shape-text`,
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
        </div>
      ) : null}
    </div>
  );
}

function shapeAccessibleName(element: ShapeElement) {
  const action = element.locked ? "Select locked" : "Select and move";
  const excerpt = element.text ? getShapeTextAccessibleExcerpt(element.text) : "";
  return `${action} ${element.shape} shape${excerpt ? `, text: ${excerpt}` : ""}. Press F2 to edit contained text.`;
}

function shapeEditingAccessibleName(element: ShapeElement) {
  return `Editing text inside ${element.shape} shape. Escape cancels. Control+Enter saves.`;
}

type ShapeTextInsetCss = CSSProperties & {
  "--shape-text-surface-color": string;
  "--shape-text-surface-fill": string;
  "--shape-text-surface-radius": string;
};

export function shapeTextSurfaceColors(fillColor: CanvasColor | null | undefined) {
  if (fillColor?.kind !== "fixed") {
    return {
      color: "var(--canvas-tool-text)",
      fill: "var(--canvas-shape-text-surface)",
    };
  }
  const shorthand = /^#([\da-f])([\da-f])([\da-f])$/i.exec(fillColor.value);
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(fillColor.value);
  const channels = shorthand
    ? shorthand.slice(1).map((channel) => Number.parseInt(`${channel}${channel}`, 16))
    : full?.slice(1).map((channel) => Number.parseInt(channel, 16));
  if (!channels) {
    return {
      color: "var(--canvas-tool-text)",
      fill: "var(--canvas-shape-text-surface)",
    };
  }
  const luminance = channels
    .map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  return {
    color: luminance > 0.179 ? "#000000" : "#ffffff",
    fill: fillColor.value,
  };
}

export function shapeTextInsetStyle(element: ShapeElement): ShapeTextInsetCss {
  const horizontal = element.shape === "rectangle"
    ? 12
    : element.shape === "ellipse"
      ? Math.max(8, element.width * 0.14645)
      : Math.max(8, element.width * 0.25);
  const vertical = element.shape === "rectangle"
    ? 12
    : element.shape === "ellipse"
      ? Math.max(8, element.height * 0.14645)
      : Math.max(8, element.height * 0.25);
  const surfaceColors = shapeTextSurfaceColors(element.style.fillColor);
  return {
    inset: `${Math.min(vertical, Math.max(0, element.height / 2 - 2))}px ${Math.min(horizontal, Math.max(0, element.width / 2 - 2))}px`,
    "--shape-text-surface-color": surfaceColors.color,
    "--shape-text-surface-fill": surfaceColors.fill,
    "--shape-text-surface-radius": element.shape === "ellipse" ? "999px" : element.shape === "diamond" ? "8px" : "6px",
  };
}

type ShapeContainedTextEditorProps = {
  element: ShapeElement;
  onActiveEditorChange: (editor: Editor | null) => void;
  onCancel: (restoreFocus: boolean) => void;
  onCommit: (text: RichTextValue | undefined, outcome: Exclude<ShapeTextEditOutcome, "canceled">, restoreFocus: boolean) => void;
  onEditSessionChange: ShapeElementViewProps["onEditSessionChange"];
};

function ShapeContainedTextEditor({ element, onActiveEditorChange, onCancel, onCommit, onEditSessionChange }: ShapeContainedTextEditorProps) {
  const initialText = useMemo(() => element.text ?? { content: "" }, [element.id]);
  const baselineDocument = useRef(getCanonicalShapeRichTextDocument(initialText));
  const finalized = useRef(false);
  const extensions = useMemo(
    () => [...shapeRichTextExtensions, createSlashCommandExtension(element.id)],
    [element.id],
  );

  function finish(editor: Editor, cancel: boolean, restoreFocus: boolean) {
    if (finalized.current) return;
    finalized.current = true;
    onEditSessionChange(element.id, null);
    onActiveEditorChange(null);
    if (cancel) {
      onCancel(restoreFocus);
      return;
    }
    const richContent = editor.getJSON();
    const content = editor.getText({ blockSeparator: "\n" });
    const isEmpty = !content.trim() && !hasTipTapRenderableContent(richContent);
    const didChange = content !== initialText.content
      || JSON.stringify(richContent) !== JSON.stringify(baselineDocument.current);
    if (!didChange) {
      onCommit(element.text, "unchanged", restoreFocus);
      return;
    }
    if (isEmpty) {
      onCommit(undefined, "committed", restoreFocus);
      return;
    }
    if (validateRichTextDocument(richContent) !== null) {
      onCancel(restoreFocus);
      return;
    }
    onCommit({ content, richContent }, "committed", restoreFocus);
  }

  const editor = useEditor({
    extensions,
    content: baselineDocument.current,
    editorProps: {
      attributes: {
        "aria-label": `Edit text inside ${element.shape}`,
        "aria-multiline": "true",
        class: "shape-contained-text-editor-content text-block-rich-content",
        role: "textbox",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (editor) finish(editor, true, true);
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (editor) finish(editor, false, true);
          return true;
        }
        if (event.key === "Tab") {
          const toolbarControls = [...document.querySelectorAll<HTMLElement>(
            ".global-text-toolbar button:not(:disabled), .global-text-toolbar select:not(:disabled)",
          )];
          const nextControl = event.shiftKey ? toolbarControls[toolbarControls.length - 1] : toolbarControls[0];
          if (nextControl) {
            event.preventDefault();
            nextControl.focus();
            return true;
          }
        }
        return false;
      },
    },
    onBlur: ({ editor: blurredEditor, event }) => {
      const target = event.relatedTarget;
      if (
        document.body.dataset.noteToolbarInteraction === "true"
        || target instanceof HTMLElement && target.closest(".global-text-toolbar")
      ) {
        onActiveEditorChange(blurredEditor);
        return;
      }
      finish(blurredEditor, false, false);
    },
    onCreate: ({ editor: createdEditor }) => {
      queueMicrotask(() => createdEditor.commands.focus("end"));
    },
  });

  useEffect(() => {
    if (!editor) return;
    const finishCurrentDraft = () => finish(editor, false, false);
    const cancelAndRestoreFocus = () => finish(editor, true, true);
    const commitAndRestoreFocus = () => finish(editor, false, true);
    const finishWhenFocusLeavesSession = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.closest(".shape-contained-text-editor") || target.closest(".global-text-toolbar"))
      ) return;
      finishCurrentDraft();
    };
    onActiveEditorChange(editor);
    onEditSessionChange(element.id, { cancel: cancelAndRestoreFocus, commit: commitAndRestoreFocus });
    document.addEventListener("focusin", finishWhenFocusLeavesSession);
    return () => {
      document.removeEventListener("focusin", finishWhenFocusLeavesSession);
      onActiveEditorChange(null);
      onEditSessionChange(element.id, null);
    };
  }, [editor, element.id, onActiveEditorChange, onEditSessionChange]);

  return (
    <div className="shape-contained-text shape-contained-text-editor" style={shapeTextInsetStyle(element)}>
      <EditorContent className="shape-contained-text-editor-surface" editor={editor} />
      <div aria-hidden="true" className="shape-contained-text-editor-hint">
        Esc cancels · Ctrl/⌘+Enter saves
      </div>
    </div>
  );
}

type ConnectorElementViewProps = PrimitiveElementViewProps<ConnectorElement> & {
  elementsById: Readonly<Record<ElementId, CanvasElement>>;
};

export function ConnectorElementView({ element, elementsById, isDragSourceHidden = false, isSelected, onElementChange, onKeyboardMove, onSelect }: ConnectorElementViewProps) {
  const points = resolveConnectorPoints(element, elementsById);
  if (!points) return null;
  return (
    <FreeConnectorElementView
      element={{ ...element, start: { kind: "free", ...points.start }, end: { kind: "free", ...points.end } }}
      isDragSourceHidden={isDragSourceHidden}
      isSelected={isSelected}
      onElementChange={onElementChange}
      onKeyboardMove={onKeyboardMove}
      onSelect={onSelect}
    />
  );
}

type FreeConnectorElement = Omit<ConnectorElement, "start" | "end"> & {
  start: Extract<ConnectorElement["start"], { kind: "free" }>;
  end: Extract<ConnectorElement["end"], { kind: "free" }>;
};

function FreeConnectorElementView({ element, isDragSourceHidden = false, isSelected, onElementChange, onKeyboardMove, onSelect }: PrimitiveElementViewProps<FreeConnectorElement>) {
  const ref = useRef<SVGSVGElement | null>(null);
  const minX = Math.min(element.start.x, element.end.x);
  const minY = Math.min(element.start.y, element.end.y);
  const x1 = element.start.x - minX; const y1 = element.start.y - minY; const x2 = element.end.x - minX; const y2 = element.end.y - minY;
  const rootRef = createPrimitiveRootRef(element.id, onElementChange);
  const padding = Math.max(8, element.style.strokeWidth * 2);
  const width = Math.max(1, Math.abs(x2 - x1) + padding * 2);
  const height = Math.max(1, Math.abs(y2 - y1) + padding * 2);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const start = { x: x1 + padding, y: y1 + padding };
    const end = { x: x2 + padding, y: y2 + padding };
    renderConnectorRoughSvg(svg, element.style, start, end);
  }, [element, height, padding, width, x1, x2, y1, y2]);
  return (
    <div
      aria-label={`${element.locked ? "Select locked" : "Select and move"} ${element.style.endArrowhead === "arrow" ? "arrow" : "line"} connector`}
      aria-pressed={isSelected}
      className={`primitive-element ${isDragSourceHidden ? "is-drag-source-hidden" : ""}`}
      data-canvas-element-id={element.id}
      data-canvas-element-type="connector"
      onKeyDown={(event) => primitiveKeyDown(event, element, onKeyboardMove, onSelect)}
      ref={rootRef}
      role="button"
      style={{ height, left: minX - padding, opacity: element.opacity, position: "absolute", top: minY - padding, width, zIndex: element.zIndex }}
      tabIndex={0}
    >
      <svg aria-label="Connector" className="primitive-connector" data-seed={element.style.seed} height="100%" overflow="visible" ref={ref} width="100%" />
    </div>
  );
}

/** Shared seeded connector painter for React elements and transient transform previews. */
export function renderConnectorRoughSvg(
  svg: SVGSVGElement,
  style: ConnectorElement["style"],
  start: Readonly<{ x: number; y: number }>,
  end: Readonly<{ x: number; y: number }>,
  visualScale = 1,
) {
  svg.replaceChildren();
  const draw = new RoughSVG(svg);
  const safeVisualScale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1;
  const options = roughOptions(style, safeVisualScale);
  svg.append(finishRoughNode(draw.line(start.x, start.y, end.x, end.y, options)));
  if (style.endArrowhead === "arrow") {
    const points = arrowheadPoints(start, end, 12 * safeVisualScale, 5 * safeVisualScale);
    if (points) svg.append(finishRoughNode(draw.polygon(points, {
      ...options,
      fill: canvasColorToCss(style.strokeColor),
      fillStyle: "solid",
      seed: ((style.seed + 1) >>> 0) || 1,
      strokeLineDash: undefined,
    })));
  }
}
