import { memo, useEffect, useId, useMemo, useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { InteractionMode } from "../../appTypes";
import type { InkElement } from "../model/elements";
import { inkPath } from "../rendering/strokePath";

export type InkElementUpdates = Partial<Pick<InkElement, "x" | "y">>;

type InkElementViewProps = {
  element: InkElement;
  isDragSourceHidden: boolean;
  isMultiSelected: boolean;
  isSelected: boolean;
  onCanvasPanStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onElementChange: (elementId: string, element: HTMLDivElement | null) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onResize: (elementId: string, ratio: number) => void;
  onSelect: (elementId: string, additive?: boolean) => void;
  onUpdate: (elementId: string, updates: InkElementUpdates) => void;
  onVisualDragCancel: () => void;
  onVisualDragEnd: (clientX: number, clientY: number) => void;
  onVisualDragMove: (clientX: number, clientY: number) => void;
  onVisualDragStart: (originId: string, clientX: number, clientY: number) => boolean;
  zoomLevel: number;
};

type ResizeState = {
  handle: HTMLDivElement;
  pointerId: number;
  startClientX: number;
  startHeight: number;
  startWidth: number;
};

const MIN_INK_SIZE = 8;
const MAX_INK_SIZE = 4_000;

function brushColor(element: InkElement) {
  if (element.brush.color.kind === "fixed") return element.brush.color.value;
  return element.brush.color.token === "muted"
    ? "var(--workbench-text-secondary)"
    : "var(--workbench-text)";
}

function resizeRatio(state: ResizeState, clientX: number, zoomLevel: number) {
  const proposed = (state.startWidth + (clientX - state.startClientX) / zoomLevel) / Math.max(1, state.startWidth);
  const minRatio = MIN_INK_SIZE / Math.max(1, Math.min(state.startWidth, state.startHeight));
  const maxRatio = MAX_INK_SIZE / Math.max(state.startWidth, state.startHeight);
  return Math.max(minRatio, Math.min(maxRatio, proposed));
}

/** Accessible stroke interaction whose rectangular wrapper never becomes a pointer target. */
export const InkElementView = memo(function InkElementView({
  element,
  isDragSourceHidden,
  isMultiSelected,
  isSelected,
  onCanvasPanStart,
  onElementChange,
  onInteractionModeChange,
  onResize,
  onSelect,
  onUpdate,
  onVisualDragCancel,
  onVisualDragEnd,
  onVisualDragMove,
  onVisualDragStart,
  zoomLevel,
}: InkElementViewProps) {
  const pointerIdRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hitSurfaceRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const rawPathId = useId();
  const pathId = `ink-path-${rawPathId.replace(/:/g, "")}`;
  const path = useMemo(
    () => inkPath(element),
    [element.brush, element.points],
  );

  const setRoot = (node: HTMLDivElement | null) => {
    rootRef.current = node;
    onElementChange(element.id, node);
  };

  useEffect(() => () => onElementChange(element.id, null), [element.id, onElementChange]);

  function handleRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(element.id);
      return;
    }
    const axis = event.key === "ArrowLeft" || event.key === "ArrowRight"
      ? "x"
      : event.key === "ArrowUp" || event.key === "ArrowDown"
        ? "y"
        : null;
    if (!axis || element.locked) return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const delta = (event.shiftKey ? 10 : 1) * direction;
    onUpdate(element.id, { [axis]: element[axis] + delta });
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      handle: event.currentTarget,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startHeight: element.height,
      startWidth: element.width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(element.id);
    onInteractionModeChange("resizing");
  }

  function previewResize(event: ReactPointerEvent<HTMLDivElement>) {
    const state = resizeRef.current;
    if (!state || state.pointerId !== event.pointerId || !rootRef.current) return;
    const ratio = resizeRatio(state, event.clientX, zoomLevel);
    rootRef.current.style.width = `${state.startWidth * ratio}px`;
    rootRef.current.style.height = `${state.startHeight * ratio}px`;
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    const state = resizeRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const ratio = resizeRatio(state, event.clientX, zoomLevel);
    if (state.handle.hasPointerCapture(event.pointerId)) state.handle.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
    onResize(element.id, ratio);
    onInteractionModeChange("selected");
    hitSurfaceRef.current?.focus();
  }

  function cancelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const state = resizeRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.handle.hasPointerCapture(event.pointerId)) state.handle.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
    if (rootRef.current) {
      rootRef.current.style.width = `${element.width}px`;
      rootRef.current.style.height = `${element.height}px`;
    }
    onInteractionModeChange("selected");
    hitSurfaceRef.current?.focus();
  }

  function resizeFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const ratio = event.key === "ArrowLeft" || event.key === "ArrowDown"
      ? 1 / (event.shiftKey ? 1.1 : 1.05)
      : event.shiftKey ? 1.1 : 1.05;
    onResize(element.id, ratio);
    event.currentTarget.focus();
  }

  return (
    <div
      className={`ink-element ${element.brush.kind === "highlighter" ? "is-highlighter" : ""} ${isSelected ? "is-selected" : ""} ${isSelected && isMultiSelected ? "is-multi-selected" : ""} ${isDragSourceHidden ? "is-drag-source-hidden" : ""}`}
      data-block-id={element.id}
      data-canvas-element-id={element.id}
      data-canvas-element-type="ink"
      ref={setRoot}
      style={{
        color: brushColor(element),
        height: element.height,
        left: element.x,
        top: element.y,
        transform: `rotate(${element.rotation}deg)`,
        width: element.width,
        zIndex: isSelected ? Math.max(element.zIndex, 1000) : element.zIndex,
      }}
    >
      <div
        aria-label={`${element.locked ? "Select locked" : "Select and move"} ${element.brush.kind} stroke`}
        aria-pressed={isSelected}
        className="ink-element-hit-surface"
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={handleRootKeyDown}
        onPointerCancel={(event) => {
          if (pointerIdRef.current !== event.pointerId) return;
          pointerIdRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          onVisualDragCancel();
          onInteractionModeChange("selected");
        }}
        onPointerDown={(event) => {
          if (event.button === 2) {
            onCanvasPanStart(event);
            return;
          }
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          onSelect(element.id, event.ctrlKey || event.metaKey);
          event.currentTarget.focus();
          if (element.locked) return;
          pointerIdRef.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          if (onVisualDragStart(element.id, event.clientX, event.clientY)) {
            onInteractionModeChange("dragging");
          }
        }}
        onPointerMove={(event) => {
          if (pointerIdRef.current === event.pointerId) onVisualDragMove(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          if (pointerIdRef.current !== event.pointerId) return;
          pointerIdRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          onVisualDragEnd(event.clientX, event.clientY);
          onInteractionModeChange("selected");
        }}
        ref={hitSurfaceRef}
        role="button"
        tabIndex={0}
      >
        <svg className="ink-element-path" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${element.width} ${element.height}`} width="100%">
          <defs><path d={path} id={pathId} /></defs>
          <use className="ink-element-content-path" fill="currentColor" href={`#${pathId}`} style={{ opacity: element.opacity }} />
          {element.brush.kind === "highlighter" ? <use className="ink-element-highlighter-edge" href={`#${pathId}`} /> : null}
          <use className="ink-element-hit-target" fill="transparent" href={`#${pathId}`} stroke="transparent" strokeWidth={12 / Math.max(zoomLevel, 0.01)} />
        </svg>
      </div>
      {isSelected && !element.locked ? (
        <div
          aria-label="Resize ink stroke"
          aria-valuemax={MAX_INK_SIZE}
          aria-valuemin={MIN_INK_SIZE}
          aria-valuenow={Math.round(Math.max(element.width, element.height))}
          aria-valuetext={`${Math.round(element.width)} by ${Math.round(element.height)} pixels`}
          className="resize-handle ink-resize-handle resize-se"
          onKeyDown={resizeFromKeyboard}
          onPointerCancel={cancelResize}
          onPointerDown={startResize}
          onPointerMove={previewResize}
          onPointerUp={finishResize}
          role="slider"
          tabIndex={0}
        />
      ) : null}
    </div>
  );
});
