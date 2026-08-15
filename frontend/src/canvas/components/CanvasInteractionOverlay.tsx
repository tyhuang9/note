import type { ReactNode, Ref } from "react";

type CanvasInteractionOverlayProps = {
  children?: ReactNode;
  marqueeRef: Ref<HTMLDivElement>;
};

/** Screen-space interaction UI layered outside CanvasWorldLayer's transform. */
export function CanvasInteractionOverlay({
  children,
  marqueeRef,
}: CanvasInteractionOverlayProps) {
  return (
    <div className="canvas-interaction-overlay">
      <div className="selection-rectangle" ref={marqueeRef} />
      {children}
    </div>
  );
}
