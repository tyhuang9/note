import type { ElementId } from "../model/elements";
import type { CanvasPoint } from "../model/geometry";

export type CanvasTool = "select" | "hand" | "pen" | "highlighter" | "eraser" | "rectangle" | "ellipse" | "diamond" | "line" | "arrow";

export type NormalizedPointerSample = Readonly<{ screen: CanvasPoint; world: CanvasPoint; pressure: number; timeStamp: number }>;
export type NormalizedPointerContext = Readonly<{
  pointerId: number;
  pointerType: string;
  buttons: number;
  modifiers: Readonly<{ alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }>;
  sample: NormalizedPointerSample;
  coalescedSamples: readonly NormalizedPointerSample[];
}>;

export type InteractionSession =
  | { kind: "idle" }
  | { kind: "panning"; pointerId: number; startScreen: CanvasPoint; startPan: CanvasPoint }
  | { kind: "marquee"; pointerId: number; startWorld: CanvasPoint; currentWorld: CanvasPoint; additive: boolean }
  | { kind: "moving"; pointerId: number; elementIds: readonly ElementId[]; startWorld: CanvasPoint; deltaWorld: CanvasPoint }
  | { kind: "resizing"; pointerId: number; elementId: ElementId; handle: string; startWorld: CanvasPoint }
  | { kind: "drawing"; pointerId: number; tool: "pen" | "highlighter"; points: readonly NormalizedPointerSample[] }
  | { kind: "creating-shape"; pointerId: number; tool: "rectangle" | "ellipse" | "diamond"; startWorld: CanvasPoint; currentWorld: CanvasPoint }
  | { kind: "creating-connector"; pointerId: number; tool: "line"; startWorld: CanvasPoint; currentWorld: CanvasPoint }
  | { kind: "editing-text"; elementId: ElementId };

export type CanvasToolHandler = Readonly<{
  pointerDown?: (context: NormalizedPointerContext) => InteractionSession | undefined;
  pointerMove?: (session: InteractionSession, context: NormalizedPointerContext) => InteractionSession | undefined;
  pointerUp?: (session: InteractionSession, context: NormalizedPointerContext) => InteractionSession | undefined;
  cancel?: (session: InteractionSession) => InteractionSession | undefined;
}>;

export type CanvasToolHandlerRegistry = Readonly<Partial<Record<CanvasTool, CanvasToolHandler>>>;

export function routePointerDown(registry: CanvasToolHandlerRegistry, tool: CanvasTool, context: NormalizedPointerContext): InteractionSession | undefined {
  return registry[tool]?.pointerDown?.(context);
}

export function routePointerMove(registry: CanvasToolHandlerRegistry, tool: CanvasTool, session: InteractionSession, context: NormalizedPointerContext): InteractionSession | undefined {
  return registry[tool]?.pointerMove?.(session, context);
}

export function routePointerUp(registry: CanvasToolHandlerRegistry, tool: CanvasTool, session: InteractionSession, context: NormalizedPointerContext): InteractionSession | undefined {
  return registry[tool]?.pointerUp?.(session, context);
}

export function routeCancel(registry: CanvasToolHandlerRegistry, tool: CanvasTool, session: InteractionSession): InteractionSession | undefined {
  return registry[tool]?.cancel?.(session);
}
