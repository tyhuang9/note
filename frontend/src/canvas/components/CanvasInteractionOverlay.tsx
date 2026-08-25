import type { KeyboardEventHandler, MouseEventHandler, PointerEventHandler, ReactNode, Ref } from "react";
import type { SelectionResizeHandle } from "../model/selectionBounds";

type CanvasInteractionOverlayProps = {
  children?: ReactNode;
  isInert?: boolean;
  marqueeRef: Ref<HTMLDivElement>;
  selectionFrameRef?: Ref<HTMLDivElement>;
  selectionFrame?: {
    connectorEndpointHandles?: readonly {
      description: string;
      endpoint: "start" | "end";
      onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
      onPointerDown: PointerEventHandler<HTMLButtonElement>;
      x: number;
      y: number;
    }[];
    height: number;
    isShapeFrame: boolean;
    isNativeTextFrame: boolean;
    moveLabel: string;
    onClick?: MouseEventHandler<HTMLButtonElement>;
    onDoubleClick?: MouseEventHandler<HTMLButtonElement>;
    onMoveKeyDown: KeyboardEventHandler<HTMLButtonElement>;
    onPointerCancel: PointerEventHandler<HTMLButtonElement>;
    onLostPointerCapture: PointerEventHandler<HTMLButtonElement>;
    onPointerDown: PointerEventHandler<HTMLButtonElement>;
    onPointerMove: PointerEventHandler<HTMLButtonElement>;
    onPointerUp: PointerEventHandler<HTMLButtonElement>;
    onResizeKeyDown: (handle: SelectionResizeHandle) => KeyboardEventHandler<HTMLButtonElement>;
    onResizePointerDown: (handle: SelectionResizeHandle) => PointerEventHandler<HTMLButtonElement>;
    preserveNativeSoutheastHandle?: boolean;
    resizeLabel: (handle: SelectionResizeHandle) => string;
    resizeHandles: readonly SelectionResizeHandle[];
    rotation: number;
    showMoveSurface: boolean;
    width: number;
    x: number;
    y: number;
  };
};

/** Screen-space interaction UI layered outside CanvasWorldLayer's transform. */
export function CanvasInteractionOverlay({
  children,
  isInert = false,
  marqueeRef,
  selectionFrame,
  selectionFrameRef,
}: CanvasInteractionOverlayProps) {
  return (
    <div className="canvas-interaction-overlay" inert={isInert ? true : undefined}>
      <div className="selection-rectangle" ref={marqueeRef} />
      {selectionFrame ? (
        <div
          className={`selection-frame ${selectionFrame.isNativeTextFrame ? "is-native-text-frame" : ""} ${selectionFrame.isShapeFrame ? "is-shape-selection-frame" : ""}`}
          ref={selectionFrameRef}
          style={{
            height: selectionFrame.height,
            left: selectionFrame.x,
            top: selectionFrame.y,
            transform: `rotate(${selectionFrame.rotation}deg)`,
            width: selectionFrame.width,
          }}
        >
          {selectionFrame.showMoveSurface ? (
            <button
              aria-label={selectionFrame.moveLabel}
              className={`selection-frame-move-surface ${selectionFrame.preserveNativeSoutheastHandle ? "preserve-native-se-handle" : ""}`}
              onClick={selectionFrame.onClick}
              onDoubleClick={selectionFrame.onDoubleClick}
              onKeyDown={selectionFrame.onMoveKeyDown}
              onLostPointerCapture={selectionFrame.onLostPointerCapture}
              onPointerCancel={selectionFrame.onPointerCancel}
              onPointerDown={selectionFrame.onPointerDown}
              onPointerMove={selectionFrame.onPointerMove}
              onPointerUp={selectionFrame.onPointerUp}
              type="button"
            />
          ) : null}
          {selectionFrame.resizeHandles.map((handle) => (
            <button
              aria-label={selectionFrame.resizeLabel(handle)}
              className={`selection-frame-handle selection-frame-handle-${handle} ${handle.length === 1 ? "selection-frame-edge" : "selection-frame-corner"}`}
              data-selection-resize-handle={handle}
              key={handle}
              onKeyDown={selectionFrame.onResizeKeyDown(handle)}
              onPointerCancel={selectionFrame.onPointerCancel}
              onPointerDown={(event) => {
                event.stopPropagation();
                selectionFrame.onResizePointerDown(handle)(event);
              }}
              onLostPointerCapture={selectionFrame.onLostPointerCapture}
              onPointerMove={selectionFrame.onPointerMove}
              onPointerUp={selectionFrame.onPointerUp}
              style={{ cursor: rotatedResizeCursor(handle, selectionFrame.rotation) }}
              type="button"
            />
          ))}
          {selectionFrame.connectorEndpointHandles?.map((handle) => (
            <span key={handle.endpoint}>
              <span className="canvas-accessibility-status" id={`connector-${handle.endpoint}-endpoint-description`}>
                {handle.description}
              </span>
              <button
                aria-describedby={`connector-${handle.endpoint}-endpoint-description`}
                aria-label={`Move connector ${handle.endpoint} endpoint`}
                className="selection-frame-endpoint-handle"
                data-connector-endpoint-handle={handle.endpoint}
                onKeyDown={handle.onKeyDown}
                onLostPointerCapture={selectionFrame.onLostPointerCapture}
                onPointerCancel={selectionFrame.onPointerCancel}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  handle.onPointerDown(event);
                }}
                onPointerMove={selectionFrame.onPointerMove}
                onPointerUp={selectionFrame.onPointerUp}
                style={{ left: handle.x - 12, top: handle.y - 12 }}
                type="button"
              />
            </span>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function rotatedResizeCursor(handle: SelectionResizeHandle, rotation: number) {
  const localAxis = handle === "e" || handle === "w"
    ? 0
    : handle === "n" || handle === "s"
      ? 90
      : handle === "nw" || handle === "se"
        ? 45
        : 135;
  const normalized = ((localAxis + rotation) % 180 + 180) % 180;
  const cursorIndex = Math.round(normalized / 45) % 4;
  return (["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const)[cursorIndex];
}
