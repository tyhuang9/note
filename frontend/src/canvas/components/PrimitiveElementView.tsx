import { useLayoutEffect, useRef, type RefCallback } from "react";
import { RoughSVG } from "roughjs/bin/svg";
import type { ConnectorElement, ShapeElement } from "../model/elements";

function color(value: ShapeElement["style"]["strokeColor"]) {
  return value.kind === "fixed" ? value.value : value.token === "muted" ? "var(--workbench-text-secondary)" : "var(--workbench-text)";
}

type PrimitiveElementViewProps<T extends ShapeElement | ConnectorElement> = {
  element: T;
  isDragSourceHidden?: boolean;
  onElementChange?: (elementId: string, element: HTMLDivElement | null) => void;
};

function createPrimitiveRootRef(elementId: string, onElementChange?: PrimitiveElementViewProps<ShapeElement>["onElementChange"]): RefCallback<HTMLDivElement> {
  return (element) => onElementChange?.(elementId, element);
}

export function ShapeElementView({ element, isDragSourceHidden = false, onElementChange }: PrimitiveElementViewProps<ShapeElement>) {
  const ref = useRef<SVGSVGElement | null>(null);
  const rootRef = createPrimitiveRootRef(element.id, onElementChange);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.replaceChildren();
    const draw = new RoughSVG(svg);
    const options = { seed: element.style.seed, roughness: element.style.roughness, stroke: color(element.style.strokeColor), strokeWidth: element.style.strokeWidth, fill: element.style.fillColor ? color(element.style.fillColor) : "none", strokeLineDash: element.style.strokeStyle === "dashed" ? [8, 5] : element.style.strokeStyle === "dotted" ? [2, 4] : undefined };
    const width = Math.max(1, element.width);
    const height = Math.max(1, element.height);
    const node = element.shape === "rectangle" ? draw.rectangle(0, 0, width, height, options) : element.shape === "ellipse" ? draw.ellipse(width / 2, height / 2, width, height, options) : draw.polygon([[width / 2, 0], [width, height / 2], [width / 2, height], [0, height / 2]], options);
    svg.append(node);
  }, [element]);
  return (
    <div
      className={`primitive-element ${isDragSourceHidden ? "is-drag-source-hidden" : ""}`}
      data-canvas-element-id={element.id}
      ref={rootRef}
      style={{ height: element.height, left: element.x, opacity: element.opacity, position: "absolute", top: element.y, transform: `rotate(${element.rotation}deg)`, width: element.width, zIndex: element.zIndex }}
    >
      <svg aria-label={`${element.shape} shape`} className="primitive-shape" height="100%" ref={ref} width="100%" />
    </div>
  );
}

export function ConnectorElementView({ element, isDragSourceHidden = false, onElementChange }: PrimitiveElementViewProps<ConnectorElement>) {
  if (element.start.kind !== "free" || element.end.kind !== "free") return null;
  const minX = Math.min(element.start.x, element.end.x);
  const minY = Math.min(element.start.y, element.end.y);
  const x1 = element.start.x - minX; const y1 = element.start.y - minY; const x2 = element.end.x - minX; const y2 = element.end.y - minY;
  const markerId = `connector-arrow-${element.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const stroke = color(element.style.strokeColor);
  const rootRef = createPrimitiveRootRef(element.id, onElementChange);
  const width = Math.max(1, Math.abs(x2 - x1) + 8);
  const height = Math.max(1, Math.abs(y2 - y1) + 8);
  return (
    <div
      className={`primitive-element ${isDragSourceHidden ? "is-drag-source-hidden" : ""}`}
      data-canvas-element-id={element.id}
      ref={rootRef}
      style={{ height, left: minX - 4, opacity: element.opacity, position: "absolute", top: minY - 4, width, zIndex: element.zIndex }}
    >
      <svg aria-label="Connector" className="primitive-connector" height="100%" overflow="visible" width="100%">
        {element.style.endArrowhead === "arrow" ? (
          <defs>
            <marker id={markerId} markerHeight="8" markerUnits="strokeWidth" markerWidth="8" orient="auto" refX="7" refY="4">
              <path d="M 0 0 L 8 4 L 0 8 z" fill={stroke} />
            </marker>
          </defs>
        ) : null}
        <line markerEnd={element.style.endArrowhead === "arrow" ? `url(#${markerId})` : undefined} stroke={stroke} strokeDasharray={element.style.strokeStyle === "dashed" ? "8 5" : element.style.strokeStyle === "dotted" ? "2 4" : undefined} strokeWidth={element.style.strokeWidth} x1={x1 + 4} x2={x2 + 4} y1={y1 + 4} y2={y2 + 4} />
      </svg>
    </div>
  );
}
