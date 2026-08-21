import { forwardRef, type ReactNode } from "react";
import type {
  MouseEventHandler,
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
  isInteractionDisabled?: boolean;
  onDoubleClick: MouseEventHandler<HTMLElement>;
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
      isInteractionDisabled = false,
      onDoubleClick,
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
    const blockCanvasInteraction = (event: {
      target: EventTarget | null;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => {
      if (
        !isInteractionDisabled
        || event.target instanceof Element && event.target.closest(".search-panel")
      ) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    return (
      <section
        aria-label={labelledBy ? undefined : "Canvas workspace"}
        aria-labelledby={labelledBy}
        className={`canvas ${activeMode === "canvas" ? "is-canvas-selected" : ""} ${activeMode === "panning" ? "is-panning" : ""} ${activeMode === "selecting" ? "is-selecting" : ""}`}
        data-active-tool={activeTool}
        data-search-navigation-active={isInteractionDisabled ? "true" : undefined}
        id={id}
        onClickCapture={(event) => blockCanvasInteraction(event)}
        onContextMenu={(event) => event.preventDefault()}
        onDoubleClick={(event) => {
          if (!blockCanvasInteraction(event)) onDoubleClick(event);
        }}
        onKeyDownCapture={(event) => blockCanvasInteraction(event)}
        onPointerCancel={(event) => {
          if (!blockCanvasInteraction(event)) onPointerCancel(event);
        }}
        onPointerCancelCapture={(event) => {
          if (!blockCanvasInteraction(event)) onPointerCancelCapture?.(event);
        }}
        onPointerDown={(event) => {
          if (blockCanvasInteraction(event)) return;
          if (event.target === event.currentTarget) {
            event.currentTarget.focus({ preventScroll: true });
          }
          onPointerDown(event);
        }}
        onPointerDownCapture={(event) => {
          if (!blockCanvasInteraction(event)) onPointerDownCapture?.(event);
        }}
        onLostPointerCapture={(event) => {
          if (!blockCanvasInteraction(event)) onLostPointerCapture?.(event);
        }}
        onPointerMove={(event) => {
          if (!blockCanvasInteraction(event)) onPointerMove(event);
        }}
        onPointerMoveCapture={(event) => {
          if (!blockCanvasInteraction(event)) onPointerMoveCapture?.(event);
        }}
        onPointerUp={(event) => {
          if (!blockCanvasInteraction(event)) onPointerUp(event);
        }}
        onPointerUpCapture={(event) => {
          if (!blockCanvasInteraction(event)) onPointerUpCapture?.(event);
        }}
        onWheel={(event) => {
          if (!blockCanvasInteraction(event)) onWheel(event);
        }}
        ref={ref}
        role="tabpanel"
        tabIndex={isInteractionDisabled ? -1 : 0}
      >
        <span aria-hidden="true" className="canvas-focus-indicator" data-canvas-focus-indicator>
          Canvas focused
        </span>
        {children}
      </section>
    );
  },
);
