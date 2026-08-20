import type { CanvasElement } from "../model/elements";
import { getBindableBindingAnchors, isBindableElement } from "../model/connectorBinding";

type ShapeBindingAnchorsProps = {
  targets: readonly CanvasElement[];
};

/** Visual-only cardinal targets. Pointer snapping remains model-driven. */
export function ShapeBindingAnchors({ targets }: ShapeBindingAnchorsProps) {
  return (
    <div aria-hidden="true" className="connector-binding-anchors">
      {targets.filter(isBindableElement).flatMap((target) => getBindableBindingAnchors(target).map(({ name, point }) => (
        <span
          className="connector-binding-anchor"
          data-connector-anchor={name}
          data-connector-target-id={target.id}
          key={`${target.id}-${name}`}
          style={{ left: point.x, top: point.y }}
        />
      )))}
    </div>
  );
}
