import { forwardRef, type ReactNode } from "react";
import type {
  PointerEventHandler,
  WheelEventHandler,
} from "react";

type CanvasViewportProps = {
  activeMode: "canvas" | "selected" | "editing" | "dragging" | "resizing" | "selecting" | "panning";
  labelledBy?: string;
  children: ReactNode;
  id: string;
  onPointerCancel: PointerEventHandler<HTMLElement>;
  onPointerCancelCapture?: PointerEventHandler<HTMLElement>;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerDownCapture?: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerMoveCapture?: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
  onPointerUpCapture?: PointerEventHandler<HTMLElement>;
  onWheel: WheelEventHandler<HTMLElement>;
};

/** Owns the canvas DOM event boundary while legacy interaction handlers are migrated. */
export const CanvasViewport = forwardRef<HTMLElement, CanvasViewportProps>(
  function CanvasViewport(
    {
      activeMode,
      labelledBy,
      children,
      id,
      onPointerCancel,
      onPointerCancelCapture,
      onPointerDown,
      onPointerDownCapture,
      onPointerMove,
      onPointerMoveCapture,
      onPointerUp,
      onPointerUpCapture,
      onWheel,
    },
    ref,
  ) {
    return (
      <section
        aria-label="Freeform note canvas"
        aria-labelledby={labelledBy}
        className={`canvas ${activeMode === "canvas" ? "is-canvas-selected" : ""} ${activeMode === "panning" ? "is-panning" : ""} ${activeMode === "selecting" ? "is-selecting" : ""}`}
        id={id}
        onContextMenu={(event) => event.preventDefault()}
        onPointerCancel={onPointerCancel}
        onPointerCancelCapture={onPointerCancelCapture}
        onPointerDown={onPointerDown}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMove={onPointerMove}
        onPointerMoveCapture={onPointerMoveCapture}
        onPointerUp={onPointerUp}
        onPointerUpCapture={onPointerUpCapture}
        onWheel={onWheel}
        ref={ref}
        role="tabpanel"
      >
        {children}
      </section>
    );
  },
);
