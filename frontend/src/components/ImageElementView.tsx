import { memo, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { ImageElement } from "../canvas/model/elements";
import type { ImageElementUpdates } from "../appTypes";
import type { InteractionMode } from "../appTypes";

type ImageElementViewProps = {
  element: ImageElement;
  imageSource: string | undefined;
  isDragSourceHidden: boolean;
  isMultiSelected: boolean;
  isSelected: boolean;
  onBlockElementChange: (elementId: string, element: HTMLDivElement | null) => void;
  onCanvasPanStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onSelect: (elementId: string, additive?: boolean) => void;
  onUpdate: (elementId: string, updates: ImageElementUpdates) => void;
  onVisualDragCancel: () => void;
  onVisualDragEnd: (clientX: number, clientY: number) => void;
  onVisualDragMove: (clientX: number, clientY: number) => void;
  onVisualDragStart: (originId: string, clientX: number, clientY: number) => boolean;
  zoomLevel: number;
};

const MIN_IMAGE_WIDTH = 80;
const MIN_IMAGE_HEIGHT = 60;
const MAX_IMAGE_WIDTH = 4_000;

type ImageResizeState = {
  handle: HTMLDivElement;
  pointerId: number;
  startClientX: number;
  startWidth: number;
  startHeight: number;
};

/** Standalone scene image. Rich TipTap images remain owned by TextBlockView. */
export const ImageElementView = memo(function ImageElementView({
  element,
  imageSource,
  isDragSourceHidden,
  isMultiSelected,
  isSelected,
  onBlockElementChange,
  onCanvasPanStart,
  onInteractionModeChange,
  onSelect,
  onUpdate,
  onVisualDragCancel,
  onVisualDragEnd,
  onVisualDragMove,
  onVisualDragStart,
  zoomLevel,
}: ImageElementViewProps) {
  const pointerIdRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<ImageResizeState | null>(null);
  const [isImageUnavailable, setIsImageUnavailable] = useState(!imageSource);

  useEffect(() => setIsImageUnavailable(!imageSource), [imageSource]);

  const setRootElement = (node: HTMLDivElement | null) => {
    rootRef.current = node;
    onBlockElementChange(element.id, node);
  };

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      handle: event.currentTarget,
      startClientX: event.clientX,
      startWidth: element.width,
      startHeight: element.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(element.id);
    onInteractionModeChange("resizing");
  }

  function resizeImage(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const width = getResizedWidth(resize, event.clientX, zoomLevel);
    const height = getProportionalHeight(resize.startHeight, resize.startWidth, width);
    if (rootRef.current) {
      rootRef.current.style.width = `${width}px`;
      rootRef.current.style.height = `${height}px`;
    }
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const width = getResizedWidth(resize, event.clientX, zoomLevel);
    const height = getProportionalHeight(resize.startHeight, resize.startWidth, width);
    if (resize.handle.hasPointerCapture(event.pointerId)) resize.handle.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
    onUpdate(element.id, { width, height });
    onInteractionModeChange("selected");
  }

  function cancelResize(pointerId?: number) {
    const resize = resizeRef.current;
    if (!resize || (pointerId !== undefined && resize.pointerId !== pointerId)) return;

    if (resize.handle.hasPointerCapture(resize.pointerId)) {
      resize.handle.releasePointerCapture(resize.pointerId);
    }
    if (rootRef.current) {
      rootRef.current.style.width = `${element.width}px`;
      rootRef.current.style.height = `${element.height}px`;
    }
    resizeRef.current = null;
    onInteractionModeChange("selected");
    rootRef.current?.focus();
  }

  function resizeFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;

    event.preventDefault();
    event.stopPropagation();
    const step = Math.max(1, Math.round(element.width * (event.shiftKey ? 0.1 : 0.05)));
    const width = Math.max(
      MIN_IMAGE_WIDTH,
      Math.min(
        MAX_IMAGE_WIDTH,
        element.width + (["ArrowRight", "ArrowUp"].includes(event.key) ? step : -step),
      ),
    );
    onUpdate(element.id, {
      width,
      height: getProportionalHeight(element.height, element.width, width),
    });
    event.currentTarget.focus();
  }

  function handleRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;

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
    if (!axis) return;

    event.preventDefault();
    const delta = event.shiftKey ? 10 : 1;
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    onUpdate(element.id, { [axis]: element[axis] + direction * delta });
  }

  useEffect(() => () => onBlockElementChange(element.id, null), [element.id, onBlockElementChange]);

  return (
    <div
      className={`text-block ${isSelected ? "is-selected is-canvas-mode" : ""} ${isSelected && isMultiSelected ? "is-multi-selected" : ""} ${isDragSourceHidden ? "is-drag-source-hidden" : ""}`}
      aria-label={`Select and move image${element.fileName ? ` ${element.fileName}` : ""}`}
      aria-pressed={isSelected}
      data-block-id={element.id}
      onKeyDown={handleRootKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={(event) => {
        if (resizeRef.current) {
          event.preventDefault();
          event.stopPropagation();
          cancelResize(event.pointerId);
          return;
        }
        pointerIdRef.current = null;
        onVisualDragCancel();
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
        onVisualDragEnd(event.clientX, event.clientY);
        onInteractionModeChange("selected");
      }}
      ref={setRootElement}
      role="button"
      style={{ height: element.height, left: element.x, top: element.y, transform: `rotate(${element.rotation}deg)`, width: element.width, zIndex: isSelected ? Math.max(element.zIndex, 1000) : element.zIndex }}
      tabIndex={0}
    >
      {isImageUnavailable ? (
        <div className="image-unavailable" style={{ opacity: element.opacity }}>
          <span>{element.fileName || "Image"}</span>
          <span>Image unavailable</span>
        </div>
      ) : (
        <img
          alt={element.fileName || "Pasted image"}
          className="text-block-image"
          draggable={false}
          onError={() => setIsImageUnavailable(true)}
          src={imageSource}
          style={{ opacity: element.opacity }}
        />
      )}
      {isSelected ? (
        <div
          aria-label="Resize image"
          aria-valuemax={MAX_IMAGE_WIDTH}
          aria-valuemin={MIN_IMAGE_WIDTH}
          aria-valuenow={Math.round(element.width)}
          aria-valuetext={`${Math.round(element.width)} pixels wide`}
          className="resize-handle image-resize-handle resize-se"
          onKeyDown={resizeFromKeyboard}
          onPointerDown={startResize}
          onPointerMove={resizeImage}
          onPointerUp={endResize}
          role="slider"
          tabIndex={0}
        />
      ) : null}
    </div>
  );
});

function getResizedWidth(
  resize: Pick<ImageResizeState, "startClientX" | "startWidth">,
  clientX: number,
  zoomLevel: number,
) {
  return Math.max(
    MIN_IMAGE_WIDTH,
    Math.min(MAX_IMAGE_WIDTH, resize.startWidth + (clientX - resize.startClientX) / zoomLevel),
  );
}

function getProportionalHeight(startHeight: number, startWidth: number, width: number) {
  return Math.max(MIN_IMAGE_HEIGHT, startHeight * (width / startWidth));
}
