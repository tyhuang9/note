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
  isKeyboardShapeCreationAvailable?: boolean;
  isKeyboardTextCreationAvailable?: boolean;
  onDoubleClick: MouseEventHandler<HTMLElement>;
  onDoubleClickCapture?: MouseEventHandler<HTMLElement>;
  onPointerCancel: PointerEventHandler<HTMLElement>;
  onPointerCancelCapture?: PointerEventHandler<HTMLElement>;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerDownCapture?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
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
      isKeyboardShapeCreationAvailable = false,
      isKeyboardTextCreationAvailable = false,
      onDoubleClick,
      onDoubleClickCapture,
      onPointerCancel,
      onPointerCancelCapture,
      onPointerDown,
      onPointerDownCapture,
      onPointerLeave,
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
    return (
      <section
        aria-label={labelledBy ? undefined : "Canvas workspace"}
        aria-describedby={describedBy}
        aria-keyshortcuts={
          isKeyboardShapeCreationAvailable || isKeyboardTextCreationAvailable
            ? "Enter"
            : undefined
        }
        aria-labelledby={labelledBy}
        className={`canvas ${activeMode === "canvas" ? "is-canvas-selected" : ""} ${activeMode === "panning" ? "is-panning" : ""} ${activeMode === "selecting" ? "is-selecting" : ""}`}
        data-active-tool={activeTool}
        id={id}
        onClickCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
        }}
        onContextMenu={(event) => {
          if (!isSearchPanelEvent(event)) event.preventDefault();
        }}
        onDoubleClick={(event) => {
          if (isSearchPanelEvent(event)) return;
          onDoubleClick(event);
        }}
        onDoubleClickCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          onDoubleClickCapture?.(event);
        }}
        onKeyDownCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
        }}
        onPointerCancel={(event) => {
          if (isSearchPanelEvent(event)) return;
          onPointerCancel(event);
        }}
        onPointerCancelCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          onPointerCancelCapture?.(event);
        }}
        onPointerDown={(event) => {
          if (isSearchPanelEvent(event)) return;
          if (event.target === event.currentTarget) {
            event.currentTarget.focus({ preventScroll: true });
          }
          onPointerDown(event);
        }}
        onPointerDownCapture={(event) => {
          onPointerDownCapture?.(event);
          if (isSearchPanelEvent(event)) return;
        }}
        onLostPointerCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          onLostPointerCapture?.(event);
        }}
        onPointerLeave={onPointerLeave}
        onPointerMove={(event) => {
          if (isSearchPanelEvent(event)) return;
          onPointerMove(event);
        }}
        onPointerMoveCapture={(event) => {
          onPointerMoveCapture?.(event);
          if (isSearchPanelEvent(event)) return;
        }}
        onPointerUp={(event) => {
          if (isSearchPanelEvent(event)) return;
          onPointerUp(event);
        }}
        onPointerUpCapture={(event) => {
          if (isSearchPanelEvent(event)) return;
          onPointerUpCapture?.(event);
        }}
        onWheel={(event) => {
          if (isSearchPanelEvent(event)) return;
          onWheel(event);
        }}
        ref={ref}
        role="tabpanel"
        tabIndex={0}
      >
        {children}
      </section>
    );
  },
);
