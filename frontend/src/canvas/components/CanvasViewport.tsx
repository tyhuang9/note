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
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
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
      onPointerDown,
      onPointerMove,
      onPointerUp,
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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        ref={ref}
        role="tabpanel"
      >
        {children}
      </section>
    );
  },
);
