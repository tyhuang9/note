import { useLayoutEffect, useRef } from "react";
import { RoughSVG } from "roughjs/bin/svg";
import type { ConnectorElement, ShapeElement } from "../model/elements";

function color(value: ShapeElement["style"]["strokeColor"]) {
  return value.kind === "fixed" ? value.value : value.token === "muted" ? "var(--workbench-text-secondary)" : "var(--workbench-text)";
}

export function ShapeElementView({ element }: { element: ShapeElement }) {
  const ref = useRef<SVGSVGElement | null>(null);
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
  return <svg aria-label={`${element.shape} shape`} className="primitive-shape" data-canvas-element-id={element.id} height={element.height} ref={ref} style={{ left: element.x, opacity: element.opacity, position: "absolute", top: element.y, transform: `rotate(${element.rotation}deg)`, zIndex: element.zIndex }} width={element.width} />;
}

export function ConnectorElementView({ element }: { element: ConnectorElement }) {
  if (element.start.kind !== "free" || element.end.kind !== "free") return null;
  const minX = Math.min(element.start.x, element.end.x);
  const minY = Math.min(element.start.y, element.end.y);
  const x1 = element.start.x - minX; const y1 = element.start.y - minY; const x2 = element.end.x - minX; const y2 = element.end.y - minY;
  return <svg aria-label="Connector" className="primitive-connector" data-canvas-element-id={element.id} height={Math.max(1, Math.abs(y2 - y1) + 8)} style={{ left: minX - 4, overflow: "visible", position: "absolute", top: minY - 4, zIndex: element.zIndex }} width={Math.max(1, Math.abs(x2 - x1) + 8)}><line stroke={color(element.style.strokeColor)} strokeDasharray={element.style.strokeStyle === "dashed" ? "8 5" : element.style.strokeStyle === "dotted" ? "2 4" : undefined} strokeWidth={element.style.strokeWidth} x1={x1 + 4} x2={x2 + 4} y1={y1 + 4} y2={y2 + 4} /></svg>;
}
