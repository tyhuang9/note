/// <reference lib="webworker" />

import {
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
  const pixelWidth = Math.max(1, Math.round(message.frame.width * message.frame.devicePixelRatio));
  const pixelHeight = Math.max(1, Math.round(message.frame.height * message.frame.devicePixelRatio));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context = canvas.getContext("2d");
  if (!context) throw new Error("Connector preview worker lost its Canvas2D context.");
  paintConnectorPreviewFrame(context, message.frame);
  const bitmap = canvas.transferToImageBitmap();
  self.postMessage({ bitmap, frameId: message.frameId, rangeIndex: message.rangeIndex, type: "rendered" }, [bitmap]);
};

export {};
