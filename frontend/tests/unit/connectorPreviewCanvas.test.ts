import { RoughGenerator } from "roughjs/bin/generator";
import { describe, expect, it } from "vitest";
import { arrowheadPoints, roughOptions } from "../../src/canvas/components/PrimitiveElementView";
import {
  createLatestWorkerFrameQueue,
  MatchingWorkerBitmapPair,
} from "../../src/canvas/rendering/connectorPreviewCanvas";
import {
  compareConnectorPreviewStack,
  generateConnectorPreviewDrawables,
  paintExactConnectorPreview,
  paintConnectorPreviewFrame,
  setConnectorPreviewScratchFactory,
  type ConnectorPreviewCommand,
} from "../../src/canvas/rendering/connectorPreviewProtocol";

const command: ConnectorPreviewCommand = {
  end: { x: 151.5, y: 87.25 },
  endArrowhead: "arrow",
  opacity: 1,
  roughness: 1.4,
  sceneIndex: 3,
  seed: 314159,
  start: { x: 18.25, y: 7.5 },
  stroke: "rgba(32, 41, 54, 1)",
  strokeStyle: "dashed",
  strokeWidth: 3,
  visualScale: 1.5,
  zIndex: 4,
};

describe("connector transform preview canvas", () => {
  it("generates the exact legacy seeded shaft and arrowhead ops", () => {
    const generator = new RoughGenerator();
    const style = {
      endArrowhead: "arrow" as const,
      fillColor: null,
      roughness: command.roughness,
      roundness: 0,
      seed: command.seed,
      startArrowhead: "none" as const,
      strokeColor: { kind: "fixed" as const, value: command.stroke },
      strokeStyle: command.strokeStyle,
      strokeWidth: command.strokeWidth,
    };
    const options = roughOptions(style, command.visualScale);
    const expected = [generator.line(command.start.x, command.start.y, command.end.x, command.end.y, options)];
    const arrow = arrowheadPoints(
      command.start,
      command.end,
      12 * command.visualScale,
      5 * command.visualScale,
    );
    if (!arrow) throw new Error("Expected a finite arrowhead.");
    expected.push(generator.polygon(arrow, {
      ...options,
      fill: command.stroke,
      fillStyle: "solid",
      seed: ((command.seed + 1) >>> 0) || 1,
      strokeLineDash: undefined,
    }));

    expect(generateConnectorPreviewDrawables(command)).toEqual(expected);
  });

  it.each([
    command,
    { ...command, endArrowhead: "none" as const, end: { x: -31.25, y: 600.5 }, roughness: 0.2, seed: 1 },
    { ...command, end: { x: 9.5, y: -22.75 }, roughness: 2.4, seed: 0xffff_ffff, strokeStyle: "dotted" as const },
    { ...command, end: { x: 800, y: 7.51 }, seed: 0x8000_0000, strokeStyle: "solid" as const, visualScale: 0.5 },
  ])("streams the exact legacy op sequence without production allocations (seed $seed)", (candidate) => {
    const context = new RecordingContext();
    paintExactConnectorPreview(context as unknown as CanvasRenderingContext2D, candidate);
    const expected = generateConnectorPreviewDrawables(candidate).flatMap((drawable) =>
      drawable.sets.flatMap((set) => set.ops.map((operation) => ({ data: operation.data, op: operation.op }))),
    );
    expect(context.operations).toEqual(expected);
  });

  it.each(["solid", "dashed", "dotted"] as const)("preserves %s final paint options", (strokeStyle) => {
    const [shaft, arrow] = generateConnectorPreviewDrawables({ ...command, strokeStyle });
    expect(shaft.options).toMatchObject({
      disableMultiStroke: true,
      roughness: command.roughness,
      seed: command.seed,
      stroke: command.stroke,
      strokeWidth: command.strokeWidth,
    });
    expect(shaft.options.strokeLineDash).toEqual(
      strokeStyle === "dashed" ? [12, 7.5] : strokeStyle === "dotted" ? [3, 6] : undefined,
    );
    expect(arrow.options).toMatchObject({ fill: command.stroke, fillStyle: "solid", seed: command.seed + 1 });
    expect(arrow.options.strokeLineDash).toBeUndefined();
  });

  it("orders opaque connectors by z-index then scene index", () => {
    const context = new RecordingContext();
    const ordered = [
      { ...command, endArrowhead: "none" as const, sceneIndex: 4, seed: 44, zIndex: 2 },
      { ...command, endArrowhead: "none" as const, sceneIndex: 8, seed: 88, zIndex: 1 },
      { ...command, endArrowhead: "none" as const, sceneIndex: 2, seed: 22, zIndex: 2 },
    ];
    paintConnectorPreviewFrame(context as unknown as CanvasRenderingContext2D, {
      commands: ordered.sort(compareConnectorPreviewStack),
      devicePixelRatio: 1,
      height: 200,
      width: 300,
    });
    const expectedMoves = ordered.map((candidate) =>
      generateConnectorPreviewDrawables(candidate)[0].sets[0].ops[0].data,
    );
    expect(context.moves).toEqual(expectedMoves);
  });

  it("isolates translucent connector strokes and composites their group once", () => {
    const target = new RecordingContext();
    const scratch = new RecordingContext();
    const scratchCanvas = { height: 1, width: 1 };
    setConnectorPreviewScratchFactory(() => ({
      canvas: scratchCanvas as unknown as OffscreenCanvas,
      context: scratch as unknown as OffscreenCanvasRenderingContext2D,
    }));
    paintConnectorPreviewFrame(target as unknown as CanvasRenderingContext2D, {
      commands: [{ ...command, opacity: 0.42 }],
      devicePixelRatio: 2,
      height: 200,
      width: 300,
    });
    expect(target.strokes).toBe(0);
    expect(target.fills).toBe(0);
    expect(target.drawImages).toEqual([{ alpha: 0.42, arguments: 9 }]);
    expect(scratch.strokes).toBeGreaterThan(0);
    expect(scratch.fills).toBeGreaterThan(0);
  });

  it("keeps at most one pending worker frame and sends only the latest", () => {
    const sent: number[] = [];
    const queue = createLatestWorkerFrameQueue<number>((value) => sent.push(value));
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(queue.pendingDepth()).toBe(1);
    expect(sent).toEqual([1]);
    queue.complete();
    expect(queue.pendingDepth()).toBe(0);
    expect(sent).toEqual([1, 3]);
    queue.complete();
    queue.enqueue(4);
    expect(sent).toEqual([1, 3, 4]);
  });

  it("presents only a complete same-frame bitmap pair in range order", () => {
    const pairs = new MatchingWorkerBitmapPair<FakeBitmap>();
    const first = new FakeBitmap("range-0");
    const second = new FakeBitmap("range-1");
    pairs.begin(7);
    expect(pairs.accept(7, 1, second)).toBeNull();
    expect(second.closed).toBe(false);
    expect(pairs.accept(7, 0, first)).toEqual([first, second]);
    expect(first.closed).toBe(false);
    expect(second.closed).toBe(false);
  });

  it("closes stale and replaced worker bitmaps", () => {
    const pairs = new MatchingWorkerBitmapPair<FakeBitmap>();
    const partial = new FakeBitmap("partial");
    const stale = new FakeBitmap("stale");
    pairs.begin(3);
    expect(pairs.accept(3, 0, partial)).toBeNull();
    pairs.begin(4);
    expect(partial.closed).toBe(true);
    expect(pairs.accept(3, 1, stale)).toBeNull();
    expect(stale.closed).toBe(true);
  });

  it("closes an incomplete bitmap pair during cleanup", () => {
    const pairs = new MatchingWorkerBitmapPair<FakeBitmap>();
    const partial = new FakeBitmap("partial");
    pairs.begin(11);
    pairs.accept(11, 1, partial);
    pairs.close();
    expect(partial.closed).toBe(true);
  });
});

class FakeBitmap {
  closed = false;

  constructor(readonly label: string) {}

  close() {
    this.closed = true;
  }
}

class RecordingContext {
  canvas = { height: 400, width: 600 };
  drawImages: Array<{ alpha: number; arguments: number }> = [];
  fills = 0;
  globalAlpha = 1;
  lineCap = "butt";
  lineDashOffset = 0;
  lineJoin = "miter";
  lineWidth = 1;
  moves: number[][] = [];
  operations: Array<{ data: number[]; op: string }> = [];
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000";
  fillStyle: string | CanvasGradient | CanvasPattern = "#000";
  strokes = 0;

  beginPath() {}
  bezierCurveTo(...data: number[]) { this.operations.push({ data, op: "bcurveTo" }); }
  clearRect() {}
  drawImage(...args: unknown[]) { this.drawImages.push({ alpha: this.globalAlpha, arguments: args.length }); }
  fill() { this.fills += 1; }
  lineTo(...data: number[]) { this.operations.push({ data, op: "lineTo" }); }
  moveTo(...data: number[]) {
    this.moves.push(data);
    this.operations.push({ data, op: "move" });
  }
  restore() {}
  save() {}
  setLineDash() {}
  setTransform() {}
  stroke() { this.strokes += 1; }
}
