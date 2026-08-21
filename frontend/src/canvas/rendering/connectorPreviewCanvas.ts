import {
  paintConnectorPreviewFrame,
  setConnectorPreviewScratchFactory,
  type ConnectorPreviewFrame,
} from "./connectorPreviewProtocol";

setConnectorPreviewScratchFactory(() => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  return context ? { canvas, context } : null;
});

type WorkerFrame = Readonly<{ frame: ConnectorPreviewFrame; frameId: number }>;

export type LatestWorkerFrameQueue<T> = Readonly<{
  cancel: () => void;
  complete: () => void;
  enqueue: (value: T) => void;
  pendingDepth: () => number;
}>;

type CloseableBitmap = Readonly<{ close: () => void }>;

/** Owns at most one incomplete worker result and releases every stale or replaced bitmap. */
export class MatchingWorkerBitmapPair<T extends CloseableBitmap> {
  private activeFrameId: number | null = null;
  private bitmaps: Array<T | null> = [null, null];

  begin(frameId: number) {
    this.close();
    this.activeFrameId = frameId;
  }

  accept(frameId: number, rangeIndex: number, bitmap: T): readonly [T, T] | null {
    if (frameId !== this.activeFrameId || (rangeIndex !== 0 && rangeIndex !== 1)) {
      bitmap.close();
      return null;
    }
    this.bitmaps[rangeIndex]?.close();
    this.bitmaps[rangeIndex] = bitmap;
    if (!this.bitmaps[0] || !this.bitmaps[1]) return null;
    const pair = [this.bitmaps[0], this.bitmaps[1]] as const;
    this.bitmaps = [null, null];
    this.activeFrameId = null;
    return pair;
  }

  retainedCount() {
    return Number(this.bitmaps[0] !== null) + Number(this.bitmaps[1] !== null);
  }

  close() {
    this.bitmaps[0]?.close();
    this.bitmaps[1]?.close();
    this.bitmaps = [null, null];
    this.activeFrameId = null;
  }
}

/** Allows one active worker frame and replaces, rather than accumulates, its single pending frame. */
export function createLatestWorkerFrameQueue<T>(send: (value: T) => void): LatestWorkerFrameQueue<T> {
  let active = false;
  let pending: T | undefined;
  return {
    cancel: () => {
      active = false;
      pending = undefined;
    },
    complete: () => {
      if (pending === undefined) {
        active = false;
        return;
      }
      const next = pending;
      pending = undefined;
      send(next);
    },
    enqueue: (value) => {
      if (active) {
        pending = value;
        return;
      }
      active = true;
      send(value);
    },
    pendingDepth: () => pending === undefined ? 0 : 1,
  };
}

export class ConnectorPreviewCanvas {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D | null = null;
  private disposed = false;
  private frameId = 0;
  private bitmapPair = new MatchingWorkerBitmapPair<ImageBitmap>();
  private activeFrameId = 0;
  private activeFrame: ConnectorPreviewFrame | null = null;
  private lastFrame: ConnectorPreviewFrame | null = null;
  private queue: LatestWorkerFrameQueue<WorkerFrame> | null = null;
  private workers: Worker[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.initialize();
  }

  get element() {
    return this.canvas;
  }

  get pendingFrameDepth() {
    return this.queue?.pendingDepth() ?? 0;
  }

  render(frame: ConnectorPreviewFrame) {
    if (this.disposed) return;
    this.lastFrame = frame;
    if (this.workers.length === 2 && this.queue) {
      this.queue.enqueue({ frame, frameId: ++this.frameId });
      this.canvas.dataset.pendingDepth = `${this.queue.pendingDepth()}`;
      return;
    }
    this.paintFallback(frame);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queue?.cancel();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.bitmapPair.close();
    this.canvas.dataset.retainedBitmaps = "0";
    this.canvas.remove();
  }

  private initialize() {
    this.canvas.dataset.retainedBitmaps = "0";
    if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function") {
      this.context = this.canvas.getContext("2d");
      this.canvas.dataset.previewRenderer = "main-thread";
      return;
    }
    try {
      this.context = this.canvas.getContext("2d");
      if (!this.context) return;
      for (let rangeIndex = 0; rangeIndex < 2; rangeIndex += 1) {
        const worker = new Worker(new URL("./connectorPreview.worker.ts", import.meta.url), {
          name: `connector-preview-${rangeIndex}`,
          type: "module",
        });
        worker.onmessage = (event: MessageEvent<{
          bitmap: ImageBitmap;
          frameId: number;
          rangeIndex: number;
          type: string;
        }>) => this.receiveWorkerBitmap(event.data);
        worker.onerror = () => this.activateFallback();
        worker.onmessageerror = () => this.activateFallback();
        this.workers.push(worker);
      }
      this.queue = createLatestWorkerFrameQueue((message) => this.sendWorkerFrame(message));
      this.canvas.dataset.previewRenderer = "two-worker";
    } catch {
      this.activateFallback();
    }
  }

  private activateFallback() {
    if (this.disposed || this.canvas.dataset.previewRenderer === "main-thread") return;
    this.queue?.cancel();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.queue = null;
    this.bitmapPair.close();
    this.context = this.canvas.getContext("2d");
    this.canvas.dataset.previewRenderer = "main-thread";
    if (this.lastFrame) this.paintFallback(this.lastFrame);
  }

  private sendWorkerFrame(message: WorkerFrame) {
    if (this.disposed || this.workers.length !== 2) return;
    this.bitmapPair.begin(message.frameId);
    this.activeFrameId = message.frameId;
    this.activeFrame = message.frame;
    const midpoint = Math.ceil(message.frame.commands.length / 2);
    const ranges = [
      message.frame.commands.slice(0, midpoint),
      message.frame.commands.slice(midpoint),
    ];
    for (let rangeIndex = 0; rangeIndex < 2; rangeIndex += 1) {
      this.workers[rangeIndex].postMessage({
        frame: { ...message.frame, commands: ranges[rangeIndex] },
        frameId: message.frameId,
        rangeIndex,
        type: "render",
      });
    }
  }

  private receiveWorkerBitmap(message: {
    bitmap: ImageBitmap;
    frameId: number;
    rangeIndex: number;
    type: string;
  }) {
    if (
      this.disposed ||
      message.type !== "rendered" ||
      message.frameId !== this.activeFrameId ||
      (message.rangeIndex !== 0 && message.rangeIndex !== 1)
    ) {
      message.bitmap.close();
      return;
    }
    const pair = this.bitmapPair.accept(message.frameId, message.rangeIndex, message.bitmap);
    this.canvas.dataset.retainedBitmaps = `${this.bitmapPair.retainedCount()}`;
    if (!pair) return;
    const context = this.context;
    if (!context) {
      pair[0].close();
      pair[1].close();
      return;
    }
    const frame = this.activeFrame;
    if (!frame) {
      pair[0].close();
      pair[1].close();
      this.queue?.complete();
      return;
    }
    const pixelWidth = Math.max(1, Math.round(frame.width * frame.devicePixelRatio));
    const pixelHeight = Math.max(1, Math.round(frame.height * frame.devicePixelRatio));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.drawImage(pair[0], 0, 0);
    context.drawImage(pair[1], 0, 0);
    pair[0].close();
    pair[1].close();
    this.canvas.dataset.retainedBitmaps = "0";
    this.activeFrame = null;
    this.canvas.dataset.presentedFrame = `${message.frameId}`;
    this.canvas.dispatchEvent(new CustomEvent("connector-preview-presented", {
      detail: { frameId: message.frameId },
    }));
    this.queue?.complete();
    this.canvas.dataset.pendingDepth = `${this.queue?.pendingDepth() ?? 0}`;
  }

  private paintFallback(frame: ConnectorPreviewFrame) {
    const context = this.context;
    if (!context) return;
    const pixelWidth = Math.max(1, Math.round(frame.width * frame.devicePixelRatio));
    const pixelHeight = Math.max(1, Math.round(frame.height * frame.devicePixelRatio));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    paintConnectorPreviewFrame(context, frame);
    const frameId = ++this.frameId;
    this.canvas.dataset.presentedFrame = `${frameId}`;
    this.canvas.dispatchEvent(new CustomEvent("connector-preview-presented", { detail: { frameId } }));
  }
}
