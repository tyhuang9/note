import type { ShapeElement } from "../model/elements";
import { getShapeBindingAnchors } from "../model/connectorBinding";

type ShapeBindingAnchorsProps = {
  shapes: readonly ShapeElement[];
};

/** Visual-only cardinal targets. Pointer snapping remains model-driven. */
export function ShapeBindingAnchors({ shapes }: ShapeBindingAnchorsProps) {
  return (
    <div aria-hidden="true" className="connector-binding-anchors">
      {shapes.flatMap((shape) => getShapeBindingAnchors(shape).map(({ name, point }) => (
        <span
          className="connector-binding-anchor"
          data-connector-anchor={name}
          data-connector-target-id={shape.id}
          key={`${shape.id}-${name}`}
          style={{ left: point.x, top: point.y }}
        />
      )))}
    </div>
  );
}
