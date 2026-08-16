import type { PointerEventHandler, ReactNode, Ref } from "react";
import type { SelectionCorner } from "../model/selectionBounds";

type CanvasInteractionOverlayProps = {
  children?: ReactNode;
  marqueeRef: Ref<HTMLDivElement>;
  selectionFrame?: {
    height: number;
    onDoubleClick?: PointerEventHandler<HTMLDivElement>;
    onPointerCancel: PointerEventHandler<HTMLDivElement>;
    onLostPointerCapture: PointerEventHandler<HTMLDivElement>;
    onPointerDown: PointerEventHandler<HTMLDivElement>;
    onPointerMove: PointerEventHandler<HTMLDivElement>;
    onPointerUp: PointerEventHandler<HTMLDivElement>;
    onResizePointerDown: (corner: SelectionCorner) => PointerEventHandler<HTMLDivElement>;
    showResizeHandles: boolean;
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
}: CanvasInteractionOverlayProps) {
  return (
    <div className="canvas-interaction-overlay">
      <div className="selection-rectangle" ref={marqueeRef} />
      {selectionFrame ? (
        <div
          aria-label="Move selected elements"
          className="selection-frame"
          style={{ height: selectionFrame.height, left: selectionFrame.x, top: selectionFrame.y, width: selectionFrame.width }}
        >
          <div
            className={`selection-frame-move-surface ${selectionFrame.showResizeHandles ? "" : "is-single-selection"}`}
            onDoubleClick={selectionFrame.onDoubleClick}
            onLostPointerCapture={selectionFrame.onLostPointerCapture}
            onPointerCancel={selectionFrame.onPointerCancel}
            onPointerDown={selectionFrame.onPointerDown}
            onPointerMove={selectionFrame.onPointerMove}
            onPointerUp={selectionFrame.onPointerUp}
          />
          {selectionFrame.showResizeHandles ? (["nw", "ne", "se", "sw"] as const).map((corner) => (
            <div
              className={`selection-frame-handle selection-frame-handle-${corner}`}
              key={corner}
              onPointerDown={(event) => {
                event.stopPropagation();
                selectionFrame.onResizePointerDown(corner)(event);
              }}
              onLostPointerCapture={selectionFrame.onLostPointerCapture}
            />
          )) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
