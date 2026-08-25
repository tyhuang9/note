/// <reference lib="webworker" />

import {
  clearConnectorPreviewContext,
  getConnectorPreviewFramePixelSize,
  paintConnectorPreviewFrame,
  setConnectorPreviewScratchFactory,
  type ConnectorPreviewFrame,
} from "./connectorPreviewProtocol";

type RenderMessage = Readonly<{
  frame: ConnectorPreviewFrame;
  frameId: number;
  rangeIndex: number;
  type: "render";
}>;

let canvas = new OffscreenCanvas(1, 1);
let context = canvas.getContext("2d");

setConnectorPreviewScratchFactory(() => {
  const scratch = new OffscreenCanvas(1, 1);
  const scratchContext = scratch.getContext("2d");
  return scratchContext ? { canvas: scratch, context: scratchContext } : null;
});

self.onmessage = (event: MessageEvent<RenderMessage>) => {
  const message = event.data;
  if (!context) throw new Error("Connector preview worker could not create a Canvas2D context.");
  const size = getConnectorPreviewFramePixelSize(message.frame);
  if (!size) {
    clearConnectorPreviewContext(context);
    self.postMessage({ frameId: message.frameId, rangeIndex: message.rangeIndex, type: "dropped" });
    return;
  }
  try {
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
  } catch {
    canvas = new OffscreenCanvas(1, 1);
    context = canvas.getContext("2d");
    self.postMessage({ frameId: message.frameId, rangeIndex: message.rangeIndex, type: "dropped" });
    return;
  }
  context = canvas.getContext("2d");
  if (!context) throw new Error("Connector preview worker lost its Canvas2D context.");
  if (!paintConnectorPreviewFrame(context, message.frame)) {
    self.postMessage({ frameId: message.frameId, rangeIndex: message.rangeIndex, type: "dropped" });
    return;
  }
  const bitmap = canvas.transferToImageBitmap();
  self.postMessage({ bitmap, frameId: message.frameId, rangeIndex: message.rangeIndex, type: "rendered" }, [bitmap]);
};

export {};
