import type { CanvasElement } from "../model/elements";
import { getBindableBindingAnchors, isBindableElement, type ShapeAnchorName } from "../model/connectorBinding";

type ShapeBindingAnchorsProps = {
  activeAnchorName?: ShapeAnchorName | null;
  activeTargetId?: string | null;
  isSnapped?: boolean;
  targets: readonly CanvasElement[];
  zoom?: number;
};

/** Visual-only cardinal targets. Pointer snapping remains model-driven. */
export function ShapeBindingAnchors({ activeAnchorName, activeTargetId, isSnapped = false, targets, zoom = 1 }: ShapeBindingAnchorsProps) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return (
    <div aria-hidden="true" className="connector-binding-anchors">
      {targets.filter(isBindableElement).flatMap((target) => getBindableBindingAnchors(target).map(({ name, point }) => (
        <span
          className={`connector-binding-anchor ${target.id === activeTargetId && name === activeAnchorName ? "is-active" : ""} ${target.id === activeTargetId && name === activeAnchorName && isSnapped ? "is-snapped" : ""}`}
          data-connector-anchor={name}
          data-connector-target-id={target.id}
          key={`${target.id}-${name}`}
          style={{ left: point.x, top: point.y, transform: `translate(-50%, -50%) scale(${1 / safeZoom})` }}
        />
      )))}
    </div>
  );
}
