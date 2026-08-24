import type { Drawable, Options } from "roughjs/bin/core";
import { RoughGenerator } from "roughjs/bin/generator";
import { getConnectorArrowheadPoints, type ConnectorArrowheadPosition } from "../model/connectorArrowheads";

export type ConnectorPreviewCommand = Readonly<{
  end: Readonly<{ x: number; y: number }>;
  endArrowhead: "arrow" | "none";
  /** Half of the screen-space transparent line gap occupied by a DOM label. */
  labelGapHalfLength?: number;
  opacity: number;
  roughness: number;
  sceneIndex: number;
  seed: number;
  start: Readonly<{ x: number; y: number }>;
  startArrowhead: "arrow" | "none";
  stroke: string;
  strokeStyle: "dashed" | "dotted" | "solid";
  strokeWidth: number;
  visualScale: number;
  zIndex: number;
}>;

export type ConnectorPreviewFrame = Readonly<{
  commands: readonly ConnectorPreviewCommand[];
  devicePixelRatio: number;
  height: number;
  width: number;
}>;

export const MAX_CONNECTOR_PREVIEW_DIMENSION_PX = 8_192;
export const MAX_CONNECTOR_PREVIEW_PIXELS = 16_777_216;
export const MAX_CONNECTOR_PREVIEW_BYTES = 64 * 1_024 * 1_024;
const CONNECTOR_PREVIEW_BYTES_PER_PIXEL = 4;
const MAX_CONNECTOR_PREVIEW_COORDINATE = 1_000_000_000_000;

export type ConnectorPreviewPixelSize = Readonly<{
  height: number;
  pixels: number;
  width: number;
}>;

export function compareConnectorPreviewStack(
  left: ConnectorPreviewCommand,
  right: ConnectorPreviewCommand,
) {
  return left.zIndex - right.zIndex || left.sceneIndex - right.sceneIndex;
}

type PreviewContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type ConnectorPreviewScratch = {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: PreviewContext;
};

const generator = new RoughGenerator();
const shaftData = new Float64Array(8);
const arrowOutlineData = new Float64Array(24);
const arrowFillData = new Float64Array(6);

function isFinitePreviewCommand(command: ConnectorPreviewCommand): boolean {
  return [
    command.end.x,
    command.end.y,
    command.labelGapHalfLength ?? 0,
    command.opacity,
    command.roughness,
    command.sceneIndex,
    command.seed,
    command.start.x,
    command.start.y,
    command.strokeWidth,
    command.visualScale,
    command.zIndex,
  ].every(Number.isFinite)
    && Math.abs(command.start.x) <= MAX_CONNECTOR_PREVIEW_COORDINATE
    && Math.abs(command.start.y) <= MAX_CONNECTOR_PREVIEW_COORDINATE
    && Math.abs(command.end.x) <= MAX_CONNECTOR_PREVIEW_COORDINATE
    && Math.abs(command.end.y) <= MAX_CONNECTOR_PREVIEW_COORDINATE
    && command.opacity >= 0
    && command.opacity <= 1
    && command.roughness >= 0
    && command.strokeWidth >= 0
    && (command.labelGapHalfLength === undefined || command.labelGapHalfLength >= 0)
    && command.visualScale > 0;
}

function checkedRasterSize(
  width: number,
  height: number,
  devicePixelRatio: number,
  round: (value: number) => number,
): ConnectorPreviewPixelSize | null {
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || !Number.isFinite(devicePixelRatio)
    || width <= 0
    || height <= 0
    || devicePixelRatio <= 0
  ) return null;
  const pixelWidth = round(width * devicePixelRatio);
  const pixelHeight = round(height * devicePixelRatio);
  if (
    !Number.isSafeInteger(pixelWidth)
    || !Number.isSafeInteger(pixelHeight)
    || pixelWidth < 1
    || pixelHeight < 1
    || pixelWidth > MAX_CONNECTOR_PREVIEW_DIMENSION_PX
    || pixelHeight > MAX_CONNECTOR_PREVIEW_DIMENSION_PX
    || pixelWidth > Math.floor(MAX_CONNECTOR_PREVIEW_PIXELS / pixelHeight)
  ) return null;
  const pixels = pixelWidth * pixelHeight;
  if (pixels > Math.floor(MAX_CONNECTOR_PREVIEW_BYTES / CONNECTOR_PREVIEW_BYTES_PER_PIXEL)) {
    return null;
  }
  return { height: pixelHeight, pixels, width: pixelWidth };
}

/** Validates every allocation-relevant field before an HTML or offscreen canvas is resized. */
export function getConnectorPreviewFramePixelSize(
  frame: ConnectorPreviewFrame,
): ConnectorPreviewPixelSize | null {
  if (!frame.commands.every(isFinitePreviewCommand)) return null;
  return checkedRasterSize(frame.width, frame.height, frame.devicePixelRatio, Math.round);
}

/** Clears the currently allocated surface without deriving dimensions from an invalid frame. */
export function clearConnectorPreviewContext(context: PreviewContext) {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.restore();
}

class RoughRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next() {
    if (!this.seed) return Math.random();
    this.seed = Math.imul(48_271, this.seed);
    return ((2 ** 31 - 1) & this.seed) / 2 ** 31;
  }
}

function previewOptions(command: ConnectorPreviewCommand): Options {
  return {
    fill: "none",
    curveFitting: 0.9,
    disableMultiStroke: true,
    disableMultiStrokeFill: true,
    roughness: command.roughness,
    seed: command.seed,
    stroke: command.stroke,
    strokeLineDash: command.strokeStyle === "dashed"
      ? [8 * command.visualScale, 5 * command.visualScale]
      : command.strokeStyle === "dotted"
        ? [2 * command.visualScale, 4 * command.visualScale]
        : undefined,
    strokeWidth: command.strokeWidth,
  };
}

function arrowheadPoints(command: ConnectorPreviewCommand, position: ConnectorArrowheadPosition) {
  return getConnectorArrowheadPoints(command.start, command.end, position, command.visualScale);
}

function arrowheadSeed(command: ConnectorPreviewCommand, position: ConnectorArrowheadPosition) {
  return ((command.seed + (position === "end" ? 1 : 2)) >>> 0) || 1;
}

function roughOffset(random: RoughRandom, magnitude: number, roughness: number, gain = 1) {
  return roughness * gain * (random.next() * magnitude * 2 - magnitude);
}

/** Writes RoughJS renderer `_line` scalars without allocating its transient op/data arrays. */
function writeRoughLine(
  output: Float64Array,
  offsetIndex: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  roughness: number,
  random: RoughRandom,
) {
  const lengthSquared = (x1 - x2) ** 2 + (y1 - y2) ** 2;
  const length = Math.sqrt(lengthSquared);
  const roughnessGain = length < 200 ? 1 : length > 500 ? 0.4 : -0.0016668 * length + 1.233334;
  let maxOffset = 2;
  if (maxOffset * maxOffset * 100 > lengthSquared) maxOffset = length / 10;
  const divergePoint = 0.2 + random.next() * 0.2;
  const midDispX = roughOffset(random, 2 * (y2 - y1) / 200, roughness, roughnessGain);
  const midDispY = roughOffset(random, 2 * (x1 - x2) / 200, roughness, roughnessGain);
  output[offsetIndex] = x1 + roughOffset(random, maxOffset, roughness, roughnessGain);
  output[offsetIndex + 1] = y1 + roughOffset(random, maxOffset, roughness, roughnessGain);
  output[offsetIndex + 2] = midDispX + x1 + (x2 - x1) * divergePoint + roughOffset(random, maxOffset, roughness, roughnessGain);
  output[offsetIndex + 3] = midDispY + y1 + (y2 - y1) * divergePoint + roughOffset(random, maxOffset, roughness, roughnessGain);
  output[offsetIndex + 4] = midDispX + x1 + 2 * (x2 - x1) * divergePoint + roughOffset(random, maxOffset, roughness, roughnessGain);
  output[offsetIndex + 5] = midDispY + y1 + 2 * (y2 - y1) * divergePoint + roughOffset(random, maxOffset, roughness, roughnessGain);
  output[offsetIndex + 6] = x2 + roughOffset(random, maxOffset, roughness, roughnessGain);
  output[offsetIndex + 7] = y2 + roughOffset(random, maxOffset, roughness, roughnessGain);
}

function replayRoughLine(context: PreviewContext, data: Float64Array, offsetIndex: number) {
  context.moveTo(data[offsetIndex], data[offsetIndex + 1]);
  context.bezierCurveTo(
    data[offsetIndex + 2],
    data[offsetIndex + 3],
    data[offsetIndex + 4],
    data[offsetIndex + 5],
    data[offsetIndex + 6],
    data[offsetIndex + 7],
  );
}

/** Allocation-free production replay, scalar-for-scalar equivalent to the generated drawables above. */
export function paintExactConnectorPreview(context: PreviewContext, command: ConnectorPreviewCommand) {
  const shaftSegments = connectorShaftSegments(command);
  context.save();
  context.strokeStyle = command.stroke;
  context.lineWidth = command.strokeWidth;
  if (command.strokeStyle === "dashed") context.setLineDash([8 * command.visualScale, 5 * command.visualScale]);
  else if (command.strokeStyle === "dotted") context.setLineDash([2 * command.visualScale, 4 * command.visualScale]);
  context.beginPath();
  for (let index = 0; index < shaftSegments.length; index += 1) {
    const [x1, y1, x2, y2] = shaftSegments[index];
    writeRoughLine(shaftData, 0, x1, y1, x2, y2, command.roughness, new RoughRandom(((command.seed + index * 37) >>> 0) || 1));
    replayRoughLine(context, shaftData, 0);
  }
  context.stroke();
  context.restore();

  for (const position of ["start", "end"] as const) {
    if (command[`${position}Arrowhead`] !== "arrow") continue;
    const points = arrowheadPoints(command, position);
    if (!points) continue;
    paintExactArrowhead(context, command, points, arrowheadSeed(command, position));
  }
}

function paintExactArrowhead(
  context: PreviewContext,
  command: ConnectorPreviewCommand,
  points: NonNullable<ReturnType<typeof arrowheadPoints>>,
  seed: number,
) {
  const random = new RoughRandom(seed);
  const segments = [
    [points[0], points[1]],
    [points[1], points[2]],
    [points[2], points[0]],
  ] as const;
  let outlineIndex = 0;
  for (const [start, end] of segments) {
    writeRoughLine(arrowOutlineData, outlineIndex, start[0], start[1], end[0], end[1], command.roughness, random);
    outlineIndex += 8;
  }
  for (let index = 0; index < points.length; index += 1) {
    arrowFillData[index * 2] = points[index][0] + roughOffset(random, 2, command.roughness);
    arrowFillData[index * 2 + 1] = points[index][1] + roughOffset(random, 2, command.roughness);
  }
  context.save();
  context.fillStyle = command.stroke;
  context.beginPath();
  context.moveTo(arrowFillData[0], arrowFillData[1]);
  context.lineTo(arrowFillData[2], arrowFillData[3]);
  context.lineTo(arrowFillData[4], arrowFillData[5]);
  context.fill("evenodd");
  context.restore();
  context.save();
  context.strokeStyle = command.stroke;
  context.lineWidth = command.strokeWidth;
  context.beginPath();
  for (let index = 0; index < arrowOutlineData.length; index += 8) replayRoughLine(context, arrowOutlineData, index);
  context.stroke();
  context.restore();
}

/** Generates the same seeded RoughJS drawables used by the committed SVG painter. */
export function generateConnectorPreviewDrawables(command: ConnectorPreviewCommand): readonly Drawable[] {
  const options = previewOptions(command);
  const drawables = connectorShaftSegments(command).map(([x1, y1, x2, y2], index) =>
    generator.line(x1, y1, x2, y2, { ...options, seed: index === 0 ? options.seed : ((command.seed + index * 37) >>> 0) || 1 }),
  );
  for (const position of ["start", "end"] as const) {
    if (command[`${position}Arrowhead`] !== "arrow") continue;
    const points = arrowheadPoints(command, position);
    if (!points) continue;
    drawables.push(generator.polygon(points, {
      ...options,
      fill: command.stroke,
      fillStyle: "solid",
      seed: arrowheadSeed(command, position),
      strokeLineDash: undefined,
    }));
  }
  return drawables;
}

function connectorShaftSegments(command: ConnectorPreviewCommand): readonly (readonly [number, number, number, number])[] {
  const dx = command.end.x - command.start.x;
  const dy = command.end.y - command.start.y;
  const distance = Math.hypot(dx, dy);
  const gap = Math.min(Math.max(0, command.labelGapHalfLength ?? 0), Math.max(0, distance / 2 - 1));
  if (gap <= 0 || distance <= 0.01) return [[command.start.x, command.start.y, command.end.x, command.end.y]];
  const ux = dx / distance; const uy = dy / distance;
  const middleX = (command.start.x + command.end.x) / 2; const middleY = (command.start.y + command.end.y) / 2;
  return [
    [command.start.x, command.start.y, middleX - ux * gap, middleY - uy * gap],
    [middleX + ux * gap, middleY + uy * gap, command.end.x, command.end.y],
  ];
}

type ClippedConnectorBounds = Readonly<{
  bottom: number;
  left: number;
  right: number;
  top: number;
}>;

function getClippedConnectorBounds(
  frame: ConnectorPreviewFrame,
  command: ConnectorPreviewCommand,
): ClippedConnectorBounds | null {
  const padding = Math.ceil(
    16 * command.visualScale + command.strokeWidth * 4 + command.roughness * 4,
  );
  const unclippedLeft = Math.floor(Math.min(command.start.x, command.end.x) - padding);
  const unclippedTop = Math.floor(Math.min(command.start.y, command.end.y) - padding);
  const unclippedRight = Math.ceil(Math.max(command.start.x, command.end.x) + padding);
  const unclippedBottom = Math.ceil(Math.max(command.start.y, command.end.y) + padding);
  if (![unclippedLeft, unclippedTop, unclippedRight, unclippedBottom].every(Number.isFinite)) return null;
  const left = Math.max(0, unclippedLeft);
  const top = Math.max(0, unclippedTop);
  const right = Math.min(frame.width, unclippedRight);
  const bottom = Math.min(frame.height, unclippedBottom);
  return right > left && bottom > top ? { bottom, left, right, top } : null;
}

/** Clears and paints a complete transform preview in stable scene stacking order. */
export function paintConnectorPreviewFrame(context: PreviewContext, frame: ConnectorPreviewFrame): boolean {
  const size = getConnectorPreviewFramePixelSize(frame);
  if (!size) {
    clearConnectorPreviewContext(context);
    return false;
  }
  clearConnectorPreviewContext(context);
  context.save();
  context.setTransform(frame.devicePixelRatio, 0, 0, frame.devicePixelRatio, 0, 0);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const command of frame.commands) {
    if (command.opacity <= 0) continue;
    const clippedBounds = getClippedConnectorBounds(frame, command);
    if (!clippedBounds) continue;
    if (command.opacity >= 1) {
      paintExactConnectorPreview(context, command);
      continue;
    }
    paintIsolatedConnector(context, frame, command, clippedBounds);
  }
  context.restore();
  return true;
}

let scratchFactory: (() => ConnectorPreviewScratch | null) | null = null;
let scratch: ConnectorPreviewScratch | null = null;

/** Installs the environment-specific reusable scratch surface used for group opacity. */
export function setConnectorPreviewScratchFactory(factory: () => ConnectorPreviewScratch | null) {
  scratchFactory = factory;
  scratch = null;
}

function paintIsolatedConnector(
  target: PreviewContext,
  frame: ConnectorPreviewFrame,
  command: ConnectorPreviewCommand,
  bounds: ClippedConnectorBounds,
) {
  scratch ??= scratchFactory?.() ?? null;
  if (!scratch) return;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const size = checkedRasterSize(width, height, frame.devicePixelRatio, Math.ceil);
  if (!size) return;
  try {
    if (scratch.canvas.width !== size.width) scratch.canvas.width = size.width;
    if (scratch.canvas.height !== size.height) scratch.canvas.height = size.height;
  } catch {
    return;
  }
  const context = scratch.context;
  clearConnectorPreviewContext(context);
  context.save();
  context.setTransform(
    frame.devicePixelRatio,
    0,
    0,
    frame.devicePixelRatio,
    -bounds.left * frame.devicePixelRatio,
    -bounds.top * frame.devicePixelRatio,
  );
  context.lineCap = "round";
  context.lineJoin = "round";
  paintExactConnectorPreview(context, command);
  context.restore();
  target.save();
  target.globalAlpha = command.opacity;
  target.drawImage(
    scratch.canvas,
    0,
    0,
    size.width,
    size.height,
    bounds.left,
    bounds.top,
    width,
    height,
  );
  target.restore();
}
