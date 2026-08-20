import type { ShapeBindingAnchor } from "../model/connectorBinding";

type ShapeBindingAnchorsProps = {
  anchor: ShapeBindingAnchor;
  isSnapped?: boolean;
  targetId: string;
  zoom?: number;
};

/** The active authoring or retargeting target has exactly one visual marker. */
export function ShapeBindingAnchors({ anchor, isSnapped = false, targetId, zoom = 1 }: ShapeBindingAnchorsProps) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return (
    <div aria-hidden="true" className="connector-binding-anchors">
      <span
        className={`connector-binding-anchor is-active ${isSnapped ? "is-snapped" : ""}`}
        data-connector-anchor={anchor.name}
        data-connector-target-id={targetId}
        style={{ left: anchor.point.x, top: anchor.point.y, transform: `translate(-50%, -50%) scale(${1 / safeZoom})` }}
      />
    </div>
  );
}
