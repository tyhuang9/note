import { forwardRef, type ReactNode, type Ref } from "react";
import type { PanOffset } from "../../appTypes";
import { LiveDraftVectorLayer } from "./LiveDraftVectorLayer";

type CanvasWorldLayerProps = {
  children: ReactNode;
  isGridVisible: boolean;
  liveDraftLayerRef: Ref<SVGSVGElement>;
  panOffset: PanOffset;
  zoomLevel: number;
};

/** Applies the viewport transform exactly once to all world-space content. */
export const CanvasWorldLayer = forwardRef<HTMLDivElement, CanvasWorldLayerProps>(
  function CanvasWorldLayer(
    { children, isGridVisible, liveDraftLayerRef, panOffset, zoomLevel },
    ref,
  ) {
    return (
      <div
        className="canvas-content"
        ref={ref}
        style={{
          transform: `translate3d(${panOffset.x}px, ${panOffset.y}px, 0) scale(${zoomLevel})`,
        }}
      >
        {isGridVisible ? <div className="canvas-grid" /> : null}
        {children}
        <LiveDraftVectorLayer ref={liveDraftLayerRef} />
      </div>
    );
  },
);
