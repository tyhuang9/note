import type { KeyboardEventHandler, MouseEventHandler, PointerEventHandler, ReactNode, Ref } from "react";
import type { SelectionCorner } from "../model/selectionBounds";

type CanvasInteractionOverlayProps = {
  children?: ReactNode;
  marqueeRef: Ref<HTMLDivElement>;
  selectionFrameRef?: Ref<HTMLDivElement>;
  selectionFrame?: {
    height: number;
    onDoubleClick?: MouseEventHandler<HTMLButtonElement>;
    onMoveKeyDown: KeyboardEventHandler<HTMLButtonElement>;
    onPointerCancel: PointerEventHandler<HTMLButtonElement>;
    onLostPointerCapture: PointerEventHandler<HTMLButtonElement>;
    onPointerDown: PointerEventHandler<HTMLButtonElement>;
    onPointerMove: PointerEventHandler<HTMLButtonElement>;
    onPointerUp: PointerEventHandler<HTMLButtonElement>;
    onResizeKeyDown: (corner: SelectionCorner) => KeyboardEventHandler<HTMLButtonElement>;
    onResizePointerDown: (corner: SelectionCorner) => PointerEventHandler<HTMLButtonElement>;
    preserveNativeSoutheastHandle?: boolean;
    resizeCorners: readonly SelectionCorner[];
    showMoveSurface: boolean;
    width: number;
    x: number;
    y: number;
  };
};

/** Screen-space interaction UI layered outside CanvasWorldLayer's transform. */
export function CanvasInteractionOverlay({
  children,
  marqueeRef,
  selectionFrame,
  selectionFrameRef,
}: CanvasInteractionOverlayProps) {
  return (
    <div className="canvas-interaction-overlay">
      <div className="selection-rectangle" ref={marqueeRef} />
      {selectionFrame ? (
        <div
          className="selection-frame"
          ref={selectionFrameRef}
          style={{ height: selectionFrame.height, left: selectionFrame.x, top: selectionFrame.y, width: selectionFrame.width }}
        >
          {selectionFrame.showMoveSurface ? (
            <button
              aria-label="Move selected elements"
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
          {selectionFrame.resizeCorners.map((corner) => (
            <button
              aria-label={`Resize selected elements from ${corner}`}
              className={`selection-frame-handle selection-frame-handle-${corner}`}
              key={corner}
              onKeyDown={selectionFrame.onResizeKeyDown(corner)}
              onPointerCancel={selectionFrame.onPointerCancel}
              onPointerDown={(event) => {
                event.stopPropagation();
                selectionFrame.onResizePointerDown(corner)(event);
              }}
              onLostPointerCapture={selectionFrame.onLostPointerCapture}
              onPointerMove={selectionFrame.onPointerMove}
              onPointerUp={selectionFrame.onPointerUp}
              type="button"
            />
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}
