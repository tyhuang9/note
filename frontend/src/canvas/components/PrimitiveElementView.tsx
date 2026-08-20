import { useLayoutEffect, useRef, type KeyboardEvent, type RefCallback } from "react";
import { RoughSVG } from "roughjs/bin/svg";
import type { Options } from "roughjs/bin/core";
import type { CanvasElement, ConnectorElement, ElementId, RoughStyle, ShapeElement } from "../model/elements";
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

export function roughOptions(style: ShapeElement["style"], visualScale = 1): Options {
  const dashScale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1;
  return {
    fill: style.fillColor ? canvasColorToCss(style.fillColor) : "none",
    curveFitting: 0.9,
    disableMultiStroke: true,
    disableMultiStrokeFill: true,
    roughness: style.roughness,
    seed: style.seed,
    stroke: canvasColorToCss(style.strokeColor),
    strokeLineDash: style.strokeStyle === "dashed"
      ? [8 * dashScale, 5 * dashScale]
      : style.strokeStyle === "dotted"
        ? [2 * dashScale, 4 * dashScale]
        : undefined,
    strokeWidth: style.strokeWidth,
  };
}

function finishRoughNode(node: SVGElement): SVGElement {
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  return node;
}

/** Extra SVG-only space for RoughJS's imperfect outline; model geometry stays untouched. */
export function shapeRenderPadding(style: ShapeElement["style"]): number {
  return Math.ceil(Math.max(8, style.strokeWidth * 2, style.roughness * 2 + style.strokeWidth));
}

export function roundedRectanglePath(width: number, height: number, roundness: number): string {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  // `roundness` stays exactly as persisted. This is a rendering-only floor so legacy
  // rectangles remain compatible without looking mechanically sharp.
  const visualRoundness = Math.max(0.06, Math.min(1, roundness));
  const radius = Math.min(safeWidth, safeHeight) * visualRoundness / 2;
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

/** A visually softened diamond whose four model anchors and bounds remain exact. */
export function roundedDiamondPath(width: number, height: number): string {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const centerX = safeWidth / 2;
  const centerY = safeHeight / 2;
  const cornerInset = Math.min(safeWidth, safeHeight) * 0.08;
  const horizontalInset = cornerInset * safeWidth / Math.max(1, Math.hypot(safeWidth, safeHeight));
  const verticalInset = cornerInset * safeHeight / Math.max(1, Math.hypot(safeWidth, safeHeight));
  const control = 0.45;
  // Each cardinal point is a real path endpoint (not merely a quadratic control
  // point). Paired quadratics give it a continuous horizontal/vertical tangent,
  // keeping the tip soft while matching model and connector cardinal extrema.
  return [
    `M ${centerX} 0`,
    `Q ${centerX + horizontalInset * control} 0 ${centerX + horizontalInset} ${verticalInset}`,
    `L ${safeWidth - horizontalInset} ${centerY - verticalInset}`,
    `Q ${safeWidth} ${centerY - verticalInset * control} ${safeWidth} ${centerY}`,
    `Q ${safeWidth} ${centerY + verticalInset * control} ${safeWidth - horizontalInset} ${centerY + verticalInset}`,
    `L ${centerX + horizontalInset} ${safeHeight - verticalInset}`,
    `Q ${centerX + horizontalInset * control} ${safeHeight} ${centerX} ${safeHeight}`,
    `Q ${centerX - horizontalInset * control} ${safeHeight} ${centerX - horizontalInset} ${safeHeight - verticalInset}`,
    `L ${horizontalInset} ${centerY + verticalInset}`,
    `Q 0 ${centerY + verticalInset * control} 0 ${centerY}`,
    `Q 0 ${centerY - verticalInset * control} ${horizontalInset} ${centerY - verticalInset}`,
    `L ${centerX - horizontalInset} ${verticalInset}`,
    `Q ${centerX - horizontalInset * control} 0 ${centerX} 0`,
    "Z",
  ].join(" ");
}

/** Shared seeded shape painter used by committed elements and live previews. */
export function renderShapeRoughSvg(
  svg: SVGSVGElement,
  shape: ShapeElement["shape"],
  style: RoughStyle,
  width: number,
  height: number,
  padding = 0,
) {
  svg.replaceChildren();
  const draw = new RoughSVG(svg);
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const options = roughOptions(style);
  const node = shape === "rectangle"
    ? draw.path(roundedRectanglePath(safeWidth, safeHeight, style.roundness), options)
    : shape === "ellipse"
      ? draw.ellipse(safeWidth / 2, safeHeight / 2, safeWidth, safeHeight, options)
      : draw.path(roundedDiamondPath(safeWidth, safeHeight), options);
  finishRoughNode(node);
  if (padding !== 0) node.setAttribute("transform", `translate(${padding} ${padding})`);
  svg.append(node);
  return node;
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
    renderShapeRoughSvg(svg, element.shape, element.style, element.width, element.height, renderPadding);
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
        data-seed={element.style.seed}
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
    const start = { x: x1 + padding, y: y1 + padding };
    const end = { x: x2 + padding, y: y2 + padding };
    renderConnectorRoughSvg(svg, element.style, start, end);
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
      <svg aria-label="Connector" className="primitive-connector" data-seed={element.style.seed} height="100%" overflow="visible" ref={ref} width="100%" />
    </div>
  );
}

/** Shared seeded connector painter for React elements and transient transform previews. */
export function renderConnectorRoughSvg(
  svg: SVGSVGElement,
  style: ConnectorElement["style"],
  start: Readonly<{ x: number; y: number }>,
  end: Readonly<{ x: number; y: number }>,
  visualScale = 1,
) {
  svg.replaceChildren();
  const draw = new RoughSVG(svg);
  const safeVisualScale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1;
  const options = roughOptions(style, safeVisualScale);
  svg.append(finishRoughNode(draw.line(start.x, start.y, end.x, end.y, options)));
  if (style.endArrowhead === "arrow") {
    const points = arrowheadPoints(start, end, 12 * safeVisualScale, 5 * safeVisualScale);
    if (points) svg.append(finishRoughNode(draw.polygon(points, {
      ...options,
      fill: canvasColorToCss(style.strokeColor),
      fillStyle: "solid",
      seed: ((style.seed + 1) >>> 0) || 1,
      strokeLineDash: undefined,
    })));
  }
}
