import type { Drawable, Options } from "roughjs/bin/core";
import { RoughGenerator } from "roughjs/bin/generator";

export type ConnectorPreviewCommand = Readonly<{
  end: Readonly<{ x: number; y: number }>;
  endArrowhead: "arrow" | "none";
  opacity: number;
  roughness: number;
  sceneIndex: number;
  seed: number;
  start: Readonly<{ x: number; y: number }>;
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

function arrowheadPoints(command: ConnectorPreviewCommand): [[number, number], [number, number], [number, number]] | null {
  const dx = command.end.x - command.start.x;
  const dy = command.end.y - command.start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.01) return null;
  const unitX = dx / distance;
  const unitY = dy / distance;
  const length = 12 * command.visualScale;
  const halfWidth = 5 * command.visualScale;
  const baseX = command.end.x - unitX * Math.min(length, distance * 0.45);
  const baseY = command.end.y - unitY * Math.min(length, distance * 0.45);
  return [
    [command.end.x, command.end.y],
    [baseX + unitY * halfWidth, baseY - unitX * halfWidth],
    [baseX - unitY * halfWidth, baseY + unitX * halfWidth],
  ];
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
  writeRoughLine(
    shaftData,
    0,
    command.start.x,
    command.start.y,
    command.end.x,
    command.end.y,
    command.roughness,
    new RoughRandom(command.seed),
  );
  context.save();
  context.strokeStyle = command.stroke;
  context.lineWidth = command.strokeWidth;
  if (command.strokeStyle === "dashed") context.setLineDash([8 * command.visualScale, 5 * command.visualScale]);
  else if (command.strokeStyle === "dotted") context.setLineDash([2 * command.visualScale, 4 * command.visualScale]);
  context.beginPath();
  replayRoughLine(context, shaftData, 0);
  context.stroke();
  context.restore();

  if (command.endArrowhead !== "arrow") return;
  const points = arrowheadPoints(command);
  if (!points) return;
  const random = new RoughRandom(((command.seed + 1) >>> 0) || 1);
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
  const drawables = [generator.line(command.start.x, command.start.y, command.end.x, command.end.y, options)];
  if (command.endArrowhead !== "arrow") return drawables;
  const points = arrowheadPoints(command);
  if (!points) return drawables;
  drawables.push(generator.polygon(points, {
    ...options,
    fill: command.stroke,
    fillStyle: "solid",
    seed: ((command.seed + 1) >>> 0) || 1,
    strokeLineDash: undefined,
  }));
  return drawables;
}

/** Clears and paints a complete transform preview in stable scene stacking order. */
export function paintConnectorPreviewFrame(context: PreviewContext, frame: ConnectorPreviewFrame) {
  const pixelWidth = Math.max(1, Math.round(frame.width * frame.devicePixelRatio));
  const pixelHeight = Math.max(1, Math.round(frame.height * frame.devicePixelRatio));
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.restore();
  context.save();
  context.setTransform(frame.devicePixelRatio, 0, 0, frame.devicePixelRatio, 0, 0);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const command of frame.commands) {
    if (command.opacity >= 1) {
      paintExactConnectorPreview(context, command);
      continue;
    }
    paintIsolatedConnector(context, frame, command);
  }
  context.restore();
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
) {
  scratch ??= scratchFactory?.() ?? null;
  if (!scratch) return;
  const padding = Math.ceil(
    16 * command.visualScale + command.strokeWidth * 4 + command.roughness * 4,
  );
  const left = Math.floor(Math.min(command.start.x, command.end.x) - padding);
  const top = Math.floor(Math.min(command.start.y, command.end.y) - padding);
  const width = Math.max(1, Math.ceil(Math.abs(command.end.x - command.start.x) + padding * 2));
  const height = Math.max(1, Math.ceil(Math.abs(command.end.y - command.start.y) + padding * 2));
  const pixelWidth = Math.max(1, Math.ceil(width * frame.devicePixelRatio));
  const pixelHeight = Math.max(1, Math.ceil(height * frame.devicePixelRatio));
  if (scratch.canvas.width < pixelWidth) scratch.canvas.width = pixelWidth;
  if (scratch.canvas.height < pixelHeight) scratch.canvas.height = pixelHeight;
  const context = scratch.context;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
  context.restore();
  context.save();
  context.setTransform(
    frame.devicePixelRatio,
    0,
    0,
    frame.devicePixelRatio,
    -left * frame.devicePixelRatio,
    -top * frame.devicePixelRatio,
  );
  context.lineCap = "round";
  context.lineJoin = "round";
  paintExactConnectorPreview(context, command);
  context.restore();
  target.save();
  target.globalAlpha = command.opacity;
  target.drawImage(scratch.canvas, 0, 0, pixelWidth, pixelHeight, left, top, width, height);
  target.restore();
}
