import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { HIGHLIGHTER_BRUSH, normalizePressure, PEN_BRUSH, type RawInkPoint } from "../model/ink";
import type { InkElement } from "../model/elements";
import { inkContainsPoint } from "../model/hitTesting";
import { screenToleranceToWorld } from "../model/geometry";
import { inkPath } from "../rendering/strokePath";
import type { CanvasTool } from "./types";

export type DrawingTool = Extract<CanvasTool, "select" | "pen" | "highlighter" | "eraser">;
type InkTool = Extract<DrawingTool, "pen" | "highlighter">;

type ViewportMetrics = Readonly<{
  height: number;
  left: number;
  offsetHeight: number;
  offsetWidth: number;
  top: number;
  width: number;
}>;

type PointerSampleLike = Readonly<{
  clientX: number;
  clientY: number;
  pointerType: string;
  pressure: number;
}>;

type InkSession = {
  kind: "drawing";
  pointerId: number;
  points: RawInkPoint[];
  previewRaf: number | null;
  tool: InkTool;
};

type EraserSession = {
  elementIds: Set<string>;
  kind: "erasing";
  pointerId: number;
};

type InkInteractionSession = InkSession | EraserSession;

type UseInkInteractionOptions = {
  activeToolRef: RefObject<DrawingTool>;
  canvasContentRef: RefObject<HTMLDivElement | null>;
  liveDraftLayerRef: RefObject<SVGSVGElement | null>;
  onCompleteStroke: (tool: InkTool, points: readonly RawInkPoint[]) => void;
  onEraseStrokes: (elementIds: readonly string[]) => void;
  visibleInkElements: () => readonly InkElement[];
  zoomLevelRef: RefObject<number>;
};

function brushFor(tool: InkTool) {
  return tool === "pen" ? PEN_BRUSH : HIGHLIGHTER_BRUSH;
}

/** Maps a client-space pointer into the transformed world's local coordinates. */
export function screenSampleToWorld(
  sample: PointerSampleLike,
  viewport: ViewportMetrics,
  simulatePressure: boolean,
): RawInkPoint | null {
  if (!Number.isFinite(sample.clientX) || !Number.isFinite(sample.clientY)) {
    return null;
  }
  const scaleX = viewport.offsetWidth > 0 ? viewport.width / viewport.offsetWidth : 0;
  const scaleY = viewport.offsetHeight > 0 ? viewport.height / viewport.offsetHeight : 0;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return null;
  }
  const x = (sample.clientX - viewport.left) / scaleX;
  const y = (sample.clientY - viewport.top) / scaleY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    pressure: normalizePressure(
      sample.pointerType === "mouse" ? 0.5 : sample.pressure,
      simulatePressure,
    ),
    x,
    y,
  };
}

export function drawingToolForShortcut(
  event: Readonly<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">>,
): DrawingTool | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "Escape") return "select";
  switch (event.key.toLowerCase()) {
    case "v": return "select";
    case "p": return "pen";
    case "h": return "highlighter";
    case "e": return "eraser";
    default: return null;
  }
}

function pointerSamples(event: ReactPointerEvent<HTMLElement>) {
  const nativeEvent = event.nativeEvent;
  const coalesced = nativeEvent.getCoalescedEvents?.();
  return coalesced && coalesced.length > 0 ? coalesced : [nativeEvent];
}

function isDrawingTool(tool: DrawingTool): tool is InkTool {
  return tool === "pen" || tool === "highlighter";
}

function isPaletteTarget(target: EventTarget | null) {
  return target instanceof Element && target.closest(".canvas-tool-palette") !== null;
}

/**
 * Pointer-capture adapter for transient freehand previews. Persistent elements
 * are created only once, when the captured pointer ends.
 */
export function useInkInteraction({
  activeToolRef,
  canvasContentRef,
  liveDraftLayerRef,
  onCompleteStroke,
  onEraseStrokes,
  visibleInkElements,
  zoomLevelRef,
}: UseInkInteractionOptions) {
  const optionsRef = useRef({ activeToolRef, canvasContentRef, liveDraftLayerRef, onCompleteStroke, onEraseStrokes, visibleInkElements, zoomLevelRef });
  const sessionRef = useRef<InkInteractionSession | null>(null);
  optionsRef.current = { activeToolRef, canvasContentRef, liveDraftLayerRef, onCompleteStroke, onEraseStrokes, visibleInkElements, zoomLevelRef };

  const clearPreview = useCallback(() => {
    const draftLayer = optionsRef.current.liveDraftLayerRef.current;
    if (draftLayer) draftLayer.replaceChildren();
  }, []);

  const paintPreview = useCallback((session: InkSession) => {
    const { liveDraftLayerRef } = optionsRef.current;
    const draftLayer = liveDraftLayerRef.current;
    if (!draftLayer) return;
    const brush = brushFor(session.tool);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", inkPath({ points: session.points.map((point) => [point.x, point.y, point.pressure]), brush }));
    path.setAttribute("fill", brush.color.kind === "fixed" ? brush.color.value : "var(--workbench-text)");
    path.setAttribute("fill-opacity", String(brush.opacity));
    draftLayer.replaceChildren(path);
  }, []);

  const schedulePreview = useCallback((session: InkSession) => {
    if (session.previewRaf !== null) return;
    session.previewRaf = window.requestAnimationFrame(() => {
      session.previewRaf = null;
      if (sessionRef.current === session) paintPreview(session);
    });
  }, [paintPreview]);

  const appendSamples = useCallback((event: ReactPointerEvent<HTMLElement>, session: InkSession) => {
    const content = optionsRef.current.canvasContentRef.current;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    const viewport: ViewportMetrics = {
      height: rect.height,
      left: rect.left,
      offsetHeight: content.offsetHeight,
      offsetWidth: content.offsetWidth,
      top: rect.top,
      width: rect.width,
    };
    const brush = brushFor(session.tool);
    for (const sample of pointerSamples(event)) {
      const point = screenSampleToWorld(sample, viewport, brush.simulatePressure);
      if (point) session.points.push(point);
    }
    schedulePreview(session);
  }, [schedulePreview]);

  const collectEraserTargets = useCallback((event: ReactPointerEvent<HTMLElement>, session: EraserSession) => {
    const current = optionsRef.current;
    const content = current.canvasContentRef.current;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    const viewport: ViewportMetrics = {
      height: rect.height,
      left: rect.left,
      offsetHeight: content.offsetHeight,
      offsetWidth: content.offsetWidth,
      top: rect.top,
      width: rect.width,
    };
    const tolerance = screenToleranceToWorld(12, { zoom: Math.max(0.01, current.zoomLevelRef.current) });
    const candidates = current.visibleInkElements();
    for (const sample of pointerSamples(event)) {
      const point = screenSampleToWorld(sample, viewport, false);
      if (!point) continue;
      for (const element of candidates) {
        if (!element.locked && inkContainsPoint(element, point, tolerance)) session.elementIds.add(element.id);
      }
    }
  }, []);

  const handlePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const tool = optionsRef.current.activeToolRef.current;
    if (
      (!isDrawingTool(tool) && tool !== "eraser") ||
      event.pointerType === "touch" ||
      event.button !== 0 ||
      sessionRef.current !== null ||
      isPaletteTarget(event.target)
    ) {
      return;
    }
    const session: InkInteractionSession = isDrawingTool(tool)
      ? { kind: "drawing", pointerId: event.pointerId, points: [], previewRaf: null, tool }
      : { elementIds: new Set(), kind: "erasing", pointerId: event.pointerId };
    sessionRef.current = session;
    if (session.kind === "drawing") appendSamples(event, session);
    else collectEraserTargets(event, session);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, [appendSamples, collectEraserTargets]);

  const handlePointerMoveCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.kind === "drawing") appendSamples(event, session);
    else collectEraserTargets(event, session);
    event.preventDefault();
    event.stopPropagation();
  }, [appendSamples, collectEraserTargets]);

  const finishSession = useCallback((event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (commit && session.kind === "drawing") appendSamples(event, session);
    if (commit && session.kind === "erasing") collectEraserTargets(event, session);
    if (session.kind === "drawing" && session.previewRaf !== null) window.cancelAnimationFrame(session.previewRaf);
    sessionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    clearPreview();
    if (commit && session.kind === "drawing" && session.points.length > 0) {
      optionsRef.current.onCompleteStroke(session.tool, session.points);
    }
    if (commit && session.kind === "erasing" && session.elementIds.size > 0) {
      optionsRef.current.onEraseStrokes([...session.elementIds]);
    }
    event.preventDefault();
    event.stopPropagation();
  }, [appendSamples, clearPreview, collectEraserTargets]);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (session?.kind === "drawing" && session.previewRaf !== null && session.previewRaf !== undefined) {
      window.cancelAnimationFrame(session.previewRaf);
    }
    sessionRef.current = null;
    clearPreview();
  }, [clearPreview]);

  return {
    handlePointerCancelCapture: useCallback((event: ReactPointerEvent<HTMLElement>) => finishSession(event, false), [finishSession]),
    handlePointerDownCapture,
    handlePointerMoveCapture,
    handlePointerUpCapture: useCallback((event: ReactPointerEvent<HTMLElement>) => finishSession(event, true), [finishSession]),
  };
}
