import type { ShapeAnchorName } from "../model/connectorBinding";
import type { ShapeElement } from "../model/elements";

type ConnectorEndpointChooserProps = {
  endpoint: "start" | "end";
  onBind: (anchor: ShapeAnchorName) => void;
  onClose: () => void;
  onDetach: () => void;
  onSelectTarget: (targetElementId: string) => void;
  shapes: readonly Readonly<{ element: ShapeElement; label: string }>[];
  targetElementId: string | null;
};

const CARDINAL_ANCHORS: readonly Readonly<{ name: ShapeAnchorName; label: string }>[] = [
  { name: "top", label: "Top" },
  { name: "right", label: "Right" },
  { name: "bottom", label: "Bottom" },
  { name: "left", label: "Left" },
];

/** Keyboard-focused binding controls that intentionally complement visual-only anchors. */
export function ConnectorEndpointChooser({
  endpoint,
  onBind,
  onClose,
  onDetach,
  onSelectTarget,
  shapes,
  targetElementId,
}: ConnectorEndpointChooserProps) {
  const selectedTarget = shapes.find(({ element }) => element.id === targetElementId) ?? null;
  return (
    <section
      aria-label={`Choose ${endpoint} endpoint target and anchor`}
      className="connector-endpoint-chooser"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      role="dialog"
    >
      <p>Choose a target shape, then a cardinal anchor.</p>
      <div aria-label="Target shape" className="connector-endpoint-chooser-group" role="group">
        {shapes.map(({ element, label }, index) => (
          <button
            aria-pressed={element.id === targetElementId}
            autoFocus={element.id === targetElementId || (!targetElementId && index === 0)}
            key={element.id}
            onClick={() => onSelectTarget(element.id)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      <div aria-label="Cardinal anchor" className="connector-endpoint-chooser-group" role="group">
        {CARDINAL_ANCHORS.map(({ name, label }) => (
          <button
            disabled={!selectedTarget}
            key={name}
            onClick={() => onBind(name)}
            type="button"
          >
            {label} anchor
          </button>
        ))}
      </div>
      <div className="connector-endpoint-chooser-actions">
        <button onClick={onDetach} type="button">Detach {endpoint} endpoint</button>
        <button onClick={onClose} type="button">Close chooser</button>
      </div>
    </section>
  );
}
