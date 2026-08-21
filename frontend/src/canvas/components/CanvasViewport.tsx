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
  describedBy?: string;
  labelledBy?: string;
  children: ReactNode;
  id: string;
  isInteractionDisabled?: boolean;
  isKeyboardShapeCreationAvailable?: boolean;
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
      describedBy,
      labelledBy,
      children,
      id,
      isInteractionDisabled = false,
      isKeyboardShapeCreationAvailable = false,
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
    const isSearchPanelEvent = (event: { target: EventTarget | null }) => (
      event.target instanceof Element && event.target.closest(".search-panel") !== null
    );
    const blockCanvasInteraction = (event: {
      target: EventTarget | null;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => {
      if (!isInteractionDisabled) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    return (
      <section
        aria-label={labelledBy ? undefined : "Canvas workspace"}
        aria-describedby={describedBy}
        aria-keyshortcuts={isKeyboardShapeCreationAvailable ? "Enter" : undefined}
        aria-labelledby={labelledBy}
        className={`canvas ${activeMode === "canvas" ? "is-canvas-selected" : ""} ${activeMode === "panning" ? "is-panning" : ""} ${activeMode === "selecting" ? "is-selecting" : ""}`}
        data-active-tool={activeTool}
        data-search-navigation-active={isInteractionDisabled ? "true" : undefined}
        id={id}
        onClickCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          blockCanvasInteraction(event);
        }}
        onContextMenu={(event) => {
          if (!isSearchPanelEvent(event)) event.preventDefault();
        }}
        onDoubleClick={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onDoubleClick(event);
        }}
        onDoubleClickCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          blockCanvasInteraction(event);
        }}
        onKeyDownCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          blockCanvasInteraction(event);
        }}
        onPointerCancel={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onPointerCancel(event);
        }}
        onPointerCancelCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onPointerCancelCapture?.(event);
        }}
        onPointerDown={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (blockCanvasInteraction(event)) return;
          if (event.target === event.currentTarget) {
            event.currentTarget.focus({ preventScroll: true });
          }
          onPointerDown(event);
        }}
        onPointerDownCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onPointerDownCapture?.(event);
        }}
        onLostPointerCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onLostPointerCapture?.(event);
        }}
        onPointerMove={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onPointerMove(event);
        }}
        onPointerMoveCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onPointerMoveCapture?.(event);
        }}
        onPointerUp={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onPointerUp(event);
        }}
        onPointerUpCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (!blockCanvasInteraction(event)) onPointerUpCapture?.(event);
        }}
        onWheel={(event) => {
          if (isSearchPanelEvent(event)) return;
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
