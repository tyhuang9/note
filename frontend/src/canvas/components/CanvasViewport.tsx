import { forwardRef, type ReactNode } from "react";
import type {
  PointerEventHandler,
  WheelEventHandler,
} from "react";
import type { DrawingTool } from "../interaction/useInkInteraction";

type CanvasViewportProps = {
  activeMode: "canvas" | "selected" | "editing" | "dragging" | "resizing" | "selecting" | "panning";
  activeTool: DrawingTool;
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
  onLostPointerCapture?: PointerEventHandler<HTMLElement>;
  onWheel: WheelEventHandler<HTMLElement>;
};

/** Owns the canvas DOM event boundary while legacy interaction handlers are migrated. */
export const CanvasViewport = forwardRef<HTMLElement, CanvasViewportProps>(
  function CanvasViewport(
    {
      activeMode,
      activeTool,
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
      onLostPointerCapture,
      onWheel,
    },
    ref,
  ) {
    return (
      <section
        aria-label={labelledBy ? undefined : "Canvas workspace"}
        aria-labelledby={labelledBy}
        className={`canvas ${activeMode === "canvas" ? "is-canvas-selected" : ""} ${activeMode === "panning" ? "is-panning" : ""} ${activeMode === "selecting" ? "is-selecting" : ""}`}
        data-active-tool={activeTool}
        id={id}
        onContextMenu={(event) => event.preventDefault()}
        onPointerCancel={onPointerCancel}
        onPointerCancelCapture={onPointerCancelCapture}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            event.currentTarget.focus({ preventScroll: true });
          }
          onPointerDown(event);
        }}
        onPointerDownCapture={onPointerDownCapture}
        onLostPointerCapture={onLostPointerCapture}
        onPointerMove={onPointerMove}
        onPointerMoveCapture={onPointerMoveCapture}
        onPointerUp={onPointerUp}
        onPointerUpCapture={onPointerUpCapture}
        onWheel={onWheel}
        ref={ref}
        role="tabpanel"
        tabIndex={0}
      >
        {children}
      </section>
    );
  },
);
