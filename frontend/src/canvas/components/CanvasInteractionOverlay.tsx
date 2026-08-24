import type { KeyboardEventHandler, MouseEventHandler, PointerEventHandler, ReactNode, Ref } from "react";
import type { SelectionResizeHandle } from "../model/selectionBounds";

type CanvasInteractionOverlayProps = {
  children?: ReactNode;
  isInert?: boolean;
  marqueeRef: Ref<HTMLDivElement>;
  textResizeHandle?: {
    cursorClass: string;
    onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
    onLostPointerCapture: PointerEventHandler<HTMLButtonElement>;
    onPointerCancel: PointerEventHandler<HTMLButtonElement>;
    onPointerDown: PointerEventHandler<HTMLButtonElement>;
    onPointerMove: PointerEventHandler<HTMLButtonElement>;
    onPointerUp: PointerEventHandler<HTMLButtonElement>;
    ref: Ref<HTMLButtonElement>;
    rotation: number;
    x: number;
    y: number;
  };
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
    moveLabel: string;
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
  textResizeHandle,
}: CanvasInteractionOverlayProps) {
  return (
    <div className="canvas-interaction-overlay" inert={isInert ? true : undefined}>
      <div className="selection-rectangle" ref={marqueeRef} />
      {selectionFrame ? (
        <div
          className="selection-frame"
          ref={selectionFrameRef}
          style={{ height: selectionFrame.height, left: selectionFrame.x, top: selectionFrame.y, width: selectionFrame.width }}
        >
          {selectionFrame.showMoveSurface ? (
            <button
              aria-label={selectionFrame.moveLabel}
              className={`selection-frame-move-surface ${selectionFrame.preserveNativeSoutheastHandle ? "preserve-native-se-handle" : ""}`}
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
              className={`selection-frame-handle selection-frame-handle-${handle}`}
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
      {textResizeHandle ? (
        <button
          aria-label="Resize text width"
          aria-keyshortcuts="ArrowLeft ArrowRight"
          className={`selection-frame-text-resize-e ${textResizeHandle.cursorClass}`}
          onKeyDown={textResizeHandle.onKeyDown}
          onLostPointerCapture={textResizeHandle.onLostPointerCapture}
          onPointerCancel={textResizeHandle.onPointerCancel}
          onPointerDown={textResizeHandle.onPointerDown}
          onPointerMove={textResizeHandle.onPointerMove}
          onPointerUp={textResizeHandle.onPointerUp}
          ref={textResizeHandle.ref}
          style={{
            left: textResizeHandle.x - 22,
            top: textResizeHandle.y - 22,
            transform: `rotate(${textResizeHandle.rotation}deg)`,
          }}
          type="button"
        />
      ) : null}
      {children}
    </div>
  );
}
