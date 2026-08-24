import type { BindableElement } from "../model/connectorBinding";
import type { CanvasPoint } from "../model/geometry";
import { roundedDiamondPath, roundedRectanglePath } from "../model/shapeBoundary";

type ConnectorBindingTargetHighlightProps = {
  /** Nearest visible boundary point under the author's pointer. */
  anchor?: CanvasPoint | null;
  isSnapped?: boolean;
  target: BindableElement;
  zoom?: number;
};

/** Non-interactive whole-object feedback shared by pointer authoring and retargeting. */
export function ConnectorBindingTargetHighlight({
  anchor = null,
  isSnapped = false,
  target,
  zoom = 1,
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
  // The target SVG is rotated around its center. Convert the resolved world
  // boundary point back into that local SVG space so the marker stays welded
  // to the actual perimeter at every rotation.
  const localAnchor = anchor ? worldPointToTargetLocal(anchor, target) : null;
  // Radius excludes the non-scaling outline: the resulting visible marker is
  // 10px while nearby and 14px when it becomes the active snap candidate.
  const markerRadius = (isSnapped ? 5.75 : 4) / Math.max(zoom, 0.01);

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
      {localAnchor ? (
        <circle
          className={`connector-binding-target-anchor ${isSnapped ? "is-active" : ""}`}
          cx={localAnchor.x}
          cy={localAnchor.y}
          r={markerRadius}
        />
      ) : null}
    </svg>
  );
}

function worldPointToTargetLocal(point: CanvasPoint, target: BindableElement): CanvasPoint {
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;
  const radians = -target.rotation * Math.PI / 180;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  return {
    x: target.width / 2 + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: target.height / 2 + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}
