import { forwardRef } from "react";

/** Empty SVG host reserved for animation-frame drawing previews in Phase 4. */
export const LiveDraftVectorLayer = forwardRef<SVGSVGElement>(
  function LiveDraftVectorLayer(_props, ref) {
    return (
      <svg
        aria-hidden="true"
        className="canvas-live-draft-layer"
        data-testid="canvas-live-draft-layer"
        height="100%"
        ref={ref}
        width="100%"
      />
    );
  },
);
