import { useLayoutEffect, useRef, type KeyboardEvent, type RefCallback } from "react";
import { RoughSVG } from "roughjs/bin/svg";
import type { Options } from "roughjs/bin/core";
import type { CanvasElement, ConnectorElement, ElementId, ShapeElement } from "../model/elements";
import { resolveConnectorPoints } from "../model/connectorBinding";
import { canvasColorToCss } from "../rendering/canvasColor";

type PrimitiveElementViewProps<T extends ShapeElement | ConnectorElement> = {
  element: T;
  isDragSourceHidden?: boolean;
  isSelected: boolean;
  onElementChange?: (elementId: string, element: HTMLDivElement | null) => void;
  onKeyboardMove: (elementId: string, delta: Readonly<{ x: number; y: number }>) => void;
  onSelect: (elementId: string, additive?: boolean) => void;
};

function createPrimitiveRootRef(elementId: string, onElementChange?: PrimitiveElementViewProps<ShapeElement>["onElementChange"]): RefCallback<HTMLDivElement> {
  return (element) => onElementChange?.(elementId, element);
}

export function roughOptions(style: ShapeElement["style"]): Options {
  return {
    fill: style.fillColor ? canvasColorToCss(style.fillColor) : "none",
    roughness: style.roughness,
    seed: style.seed,
    stroke: canvasColorToCss(style.strokeColor),
    strokeLineDash: style.strokeStyle === "dashed"
      ? [8, 5]
      : style.strokeStyle === "dotted"
        ? [2, 4]
        : undefined,
    strokeWidth: style.strokeWidth,
  };
}

/** Extra SVG-only space for RoughJS's imperfect outline; model geometry stays untouched. */
export function shapeRenderPadding(style: ShapeElement["style"]): number {
  return Math.ceil(Math.max(8, style.strokeWidth * 2, style.roughness * 2 + style.strokeWidth));
}

export function roundedRectanglePath(width: number, height: number, roundness: number): string {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const radius = Math.min(safeWidth, safeHeight) * Math.max(0, Math.min(1, roundness)) / 2;
  if (radius === 0) return `M 0 0 H ${safeWidth} V ${safeHeight} H 0 Z`;
  return [
    `M ${radius} 0`,
    `H ${safeWidth - radius}`,
    `Q ${safeWidth} 0 ${safeWidth} ${radius}`,
    `V ${safeHeight - radius}`,
    `Q ${safeWidth} ${safeHeight} ${safeWidth - radius} ${safeHeight}`,
    `H ${radius}`,
    `Q 0 ${safeHeight} 0 ${safeHeight - radius}`,
    `V ${radius}`,
    `Q 0 0 ${radius} 0`,
    "Z",
  ].join(" ");
}

export function arrowheadPoints(
  start: Readonly<{ x: number; y: number }>,
  end: Readonly<{ x: number; y: number }>,
  length = 12,
  halfWidth = 5,
): [[number, number], [number, number], [number, number]] | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.01) return null;
  const unitX = dx / distance;
  const unitY = dy / distance;
  const baseX = end.x - unitX * Math.min(length, distance * 0.45);
  const baseY = end.y - unitY * Math.min(length, distance * 0.45);
  return [
    [end.x, end.y],
    [baseX + unitY * halfWidth, baseY - unitX * halfWidth],
    [baseX - unitY * halfWidth, baseY + unitX * halfWidth],
  ];
}

function keyboardDelta(event: KeyboardEvent<HTMLDivElement>) {
  const step = event.shiftKey ? 10 : 1;
  if (event.key === "ArrowLeft") return { x: -step, y: 0 };
  if (event.key === "ArrowRight") return { x: step, y: 0 };
  if (event.key === "ArrowUp") return { x: 0, y: -step };
  if (event.key === "ArrowDown") return { x: 0, y: step };
  return null;
}

function primitiveKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  element: ShapeElement | ConnectorElement,
  onKeyboardMove: PrimitiveElementViewProps<ShapeElement>["onKeyboardMove"],
  onSelect: PrimitiveElementViewProps<ShapeElement>["onSelect"],
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect(element.id, event.ctrlKey || event.metaKey);
    return;
  }
  const delta = keyboardDelta(event);
  if (!delta || element.locked) return;
  event.preventDefault();
  event.stopPropagation();
  onSelect(element.id);
  onKeyboardMove(element.id, delta);
}

export function ShapeElementView({ element, isDragSourceHidden = false, isSelected, onElementChange, onKeyboardMove, onSelect }: PrimitiveElementViewProps<ShapeElement>) {
  const ref = useRef<SVGSVGElement | null>(null);
  const rootRef = createPrimitiveRootRef(element.id, onElementChange);
  const renderPadding = shapeRenderPadding(element.style);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.replaceChildren();
    const draw = new RoughSVG(svg);
    const options = roughOptions(element.style);
    const width = Math.max(1, element.width);
    const height = Math.max(1, element.height);
    const node = element.shape === "rectangle"
      ? element.style.roundness > 0
        ? draw.path(roundedRectanglePath(width, height, element.style.roundness), options)
        : draw.rectangle(0, 0, width, height, options)
      : element.shape === "ellipse"
        ? draw.ellipse(width / 2, height / 2, width, height, options)
        : draw.polygon([[width / 2, 0], [width, height / 2], [width / 2, height], [0, height / 2]], options);
    node.setAttribute("transform", `translate(${renderPadding} ${renderPadding})`);
    svg.append(node);
  }, [element, renderPadding]);
  return (
    <div
      aria-label={`${element.locked ? "Select locked" : "Select and move"} ${element.shape} element`}
      aria-pressed={isSelected}
      className={`primitive-element ${isDragSourceHidden ? "is-drag-source-hidden" : ""}`}
      data-canvas-element-id={element.id}
      data-canvas-element-type="shape"
      onKeyDown={(event) => primitiveKeyDown(event, element, onKeyboardMove, onSelect)}
      ref={rootRef}
      role="button"
      style={{ height: element.height, left: element.x, opacity: element.opacity, position: "absolute", top: element.y, transform: `rotate(${element.rotation}deg)`, width: element.width, zIndex: element.zIndex }}
      tabIndex={0}
    >
      <svg
        aria-label={`${element.shape} shape`}
        className="primitive-shape"
        height={`calc(100% + ${renderPadding * 2}px)`}
        overflow="visible"
        ref={ref}
        style={{ left: -renderPadding, position: "absolute", top: -renderPadding, width: `calc(100% + ${renderPadding * 2}px)` }}
      />
    </div>
  );
}

type ConnectorElementViewProps = PrimitiveElementViewProps<ConnectorElement> & {
  elementsById: Readonly<Record<ElementId, CanvasElement>>;
};

export function ConnectorElementView({ element, elementsById, isDragSourceHidden = false, isSelected, onElementChange, onKeyboardMove, onSelect }: ConnectorElementViewProps) {
  const points = resolveConnectorPoints(element, elementsById);
  if (!points) return null;
  return (
    <FreeConnectorElementView
      element={{ ...element, start: { kind: "free", ...points.start }, end: { kind: "free", ...points.end } }}
      isDragSourceHidden={isDragSourceHidden}
      isSelected={isSelected}
      onElementChange={onElementChange}
      onKeyboardMove={onKeyboardMove}
      onSelect={onSelect}
    />
  );
}

type FreeConnectorElement = Omit<ConnectorElement, "start" | "end"> & {
  start: Extract<ConnectorElement["start"], { kind: "free" }>;
  end: Extract<ConnectorElement["end"], { kind: "free" }>;
};

function FreeConnectorElementView({ element, isDragSourceHidden = false, isSelected, onElementChange, onKeyboardMove, onSelect }: PrimitiveElementViewProps<FreeConnectorElement>) {
  const ref = useRef<SVGSVGElement | null>(null);
  const minX = Math.min(element.start.x, element.end.x);
  const minY = Math.min(element.start.y, element.end.y);
  const x1 = element.start.x - minX; const y1 = element.start.y - minY; const x2 = element.end.x - minX; const y2 = element.end.y - minY;
  const rootRef = createPrimitiveRootRef(element.id, onElementChange);
  const padding = Math.max(8, element.style.strokeWidth * 2);
  const width = Math.max(1, Math.abs(x2 - x1) + padding * 2);
  const height = Math.max(1, Math.abs(y2 - y1) + padding * 2);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.replaceChildren();
    const draw = new RoughSVG(svg);
    const options = roughOptions(element.style);
    const start = { x: x1 + padding, y: y1 + padding };
    const end = { x: x2 + padding, y: y2 + padding };
    svg.append(draw.line(start.x, start.y, end.x, end.y, options));
    if (element.style.endArrowhead === "arrow") {
      const points = arrowheadPoints(start, end);
      if (points) {
        svg.append(draw.polygon(points, {
          ...options,
          fill: canvasColorToCss(element.style.strokeColor),
          fillStyle: "solid",
          seed: ((element.style.seed + 1) >>> 0) || 1,
          strokeLineDash: undefined,
        }));
      }
    }
  }, [element, height, padding, width, x1, x2, y1, y2]);
  return (
    <div
      aria-label={`${element.locked ? "Select locked" : "Select and move"} ${element.style.endArrowhead === "arrow" ? "arrow" : "line"} connector`}
      aria-pressed={isSelected}
      className={`primitive-element ${isDragSourceHidden ? "is-drag-source-hidden" : ""}`}
      data-canvas-element-id={element.id}
      data-canvas-element-type="connector"
      onKeyDown={(event) => primitiveKeyDown(event, element, onKeyboardMove, onSelect)}
      ref={rootRef}
      role="button"
      style={{ height, left: minX - padding, opacity: element.opacity, position: "absolute", top: minY - padding, width, zIndex: element.zIndex }}
      tabIndex={0}
    >
      <svg aria-label="Connector" className="primitive-connector" height="100%" overflow="visible" ref={ref} width="100%" />
    </div>
  );
}
