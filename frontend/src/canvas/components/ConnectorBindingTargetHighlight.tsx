import type { BindableElement } from "../model/connectorBinding";
import { roundedDiamondPath, roundedRectanglePath } from "../model/shapeBoundary";

type ConnectorBindingTargetHighlightProps = {
  isSnapped?: boolean;
  target: BindableElement;
};

/** Non-interactive whole-object feedback shared by pointer authoring and retargeting. */
export function ConnectorBindingTargetHighlight({
  isSnapped = false,
  target,
}: ConnectorBindingTargetHighlightProps) {
  const path = target.type === "shape" && target.shape === "rectangle"
    ? roundedRectanglePath(target.width, target.height, target.style.roundness)
    : target.type === "shape" && target.shape === "diamond"
      ? roundedDiamondPath(target.width, target.height)
      : null;
  const renderBoundary = (className: string) => (
    target.type === "shape" && target.shape === "ellipse" ? (
      <ellipse className={className} cx={target.width / 2} cy={target.height / 2} rx={target.width / 2} ry={target.height / 2} />
    ) : path ? (
      <path className={className} d={path} />
    ) : (
      <rect className={className} height={target.height} width={target.width} x="0" y="0" />
    )
  );

  return (
    <svg
      aria-hidden="true"
      className={`connector-binding-target-highlight ${isSnapped ? "is-snapped" : "is-near"}`}
      data-connector-binding-state={isSnapped ? "snapped" : "near"}
      data-connector-target-id={target.id}
      height={target.height}
      style={{
        left: target.x,
        top: target.y,
        transform: `rotate(${target.rotation}deg)`,
      }}
      viewBox={`0 0 ${target.width} ${target.height}`}
      width={target.width}
    >
      {renderBoundary("connector-binding-target-halo-outer")}
      {renderBoundary("connector-binding-target-halo-inner")}
    </svg>
  );
}
