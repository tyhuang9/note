import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import type {
  CanvasPoint,
  InsertionPoint,
  InteractionMode,
  PanOffset,
  PanState,
  SelectionRect,
  SelectionState,
} from "../../appTypes";
import { getSelectionRect, rectsIntersect } from "../../editorUtils";
import { isArrowConnector, type CanvasElement, type ConnectorElement, type ConnectorEndpoint, type RoughStyle, type ShapeElement } from "../model/elements";
import {
  getConnectorAuthoringCandidate,
  getConnectorCandidateAnnouncement,
  getConnectorCandidateAnnouncementKey,
  getNearestBindableBoundaryAnchor,
  normalizeFreeConnectorEndpoint,
  resolveConnectorPoints,
  snapConnectorPointToAngle,
  type BindableElement,
} from "../model/connectorBinding";
import { screenToleranceToWorld } from "../model/geometry";
import {
  canvasElementContainsPoint,
  getDirectBindableTargetAtPoint,
  getElementBounds,
  getTopmostSelectableElementAtPoint,
  shapeTextEditingContainsPoint,
  shapeTextContainsPoint,
} from "../model/hitTesting";
import {
  getTextOffsetAtClientPoint,
  type CaretPlacementRequest,
} from "../../editor/caretPlacement";
import { renderConnectorRoughSvg, renderShapeRoughSvg, shapeRenderPadding } from "../components/PrimitiveElementView";
import {
  isMeaningfulShapeDrag,
  primitiveGeometryFromSession,
  type PrimitiveGeometry,
  type PrimitiveModifiers,
  type PrimitiveTool,
} from "./primitiveGeometry";
import type { DrawingTool } from "./useInkInteraction";

type PrimitiveSession = {
  cancellationKey: string;
  current: CanvasPoint;
  didMove: boolean;
  elementId: string;
  modifiers: PrimitiveModifiers;
  opacity: number;
  pointerId: number;
  previousSelection: readonly string[];
  start: CanvasPoint;
  startClient: CanvasPoint;
  style: RoughStyle;
  tool: PrimitiveTool;
};

type CapturedPointer = Readonly<{
  pointerId: number;
  target: HTMLElement;
}>;

type PendingElementDrag = {
  cancellationKey: string;
  didStart: boolean;
  elementId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
};

type ArrowAuthoringSession = {
  cancellationKey: string;
  currentEndpoint: ConnectorEndpoint;
  currentPoint: CanvasPoint;
  elementId: string;
  previousSelection: readonly string[];
  startEndpoint: ConnectorEndpoint;
  startPoint: CanvasPoint;
};

export type ArrowAuthoringVisual = Readonly<{
  anchor: CanvasPoint | null;
  isSnapped: boolean;
  target: BindableElement;
}>;

type CanvasInteractionOptions = {
  activeToolRef: RefObject<DrawingTool>;
  canvasContentRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLElement | null>;
  cleanupMarquee: () => void;
  createArrowId: () => string;
  createPrimitiveId: (tool: PrimitiveTool) => string;
  hasPendingImage: () => boolean;
  isDirectTextDraftActive: () => boolean;
  isTemporaryHandActiveRef: RefObject<boolean>;
  interactionCancellationKey: string;
  isTextEditing: () => boolean;
  leaveTextEditing: () => void;
  liveDraftLayerRef: RefObject<SVGSVGElement | null>;
  maxZoom: number;
  minZoom: number;
  getArrowPreviewStyle: (elementId: string) => ConnectorElement["style"];
  getPrimitivePreviewAppearance: (tool: PrimitiveTool, elementId: string) => Readonly<{ opacity: number; style: RoughStyle }>;
  getArrowCreatedStatus: () => string;
  getArrowTargetLabel: (target: BindableElement) => string;
  onCreateArrow: (elementId: string, start: ConnectorEndpoint, end: ConnectorEndpoint) => boolean;
  onCreateDirectText: (point: CanvasPoint, previousSelection: readonly string[]) => boolean;
  onCreatePrimitive: (elementId: string, tool: PrimitiveTool, geometry: PrimitiveGeometry, appearance: Readonly<{ opacity: number; style: RoughStyle }>) => boolean;
  onPrimitiveStatusChange: (tool: ShapeElement["shape"]) => void;
  onArrowStatusChange: (message: string) => void;
  onEditBindableText: (elementId: string, caretPlacement?: CaretPlacementRequest) => void;
  onEditConnectorLabel: (elementId: string) => void;
  onImagePreviewPointChange: (point: CanvasPoint | null) => void;
  onPlaceImage: (point: CanvasPoint) => void;
  onRequestImagePicker: () => void;
  onVisualDragCancel: (updateState?: boolean) => void;
  onVisualDragEnd: (clientX: number, clientY: number) => void;
  onVisualDragMove: (clientX: number, clientY: number) => void;
  onVisualDragStart: (elementId: string, clientX: number, clientY: number) => boolean;
  panOffsetRef: RefObject<PanOffset>;
  scheduleCanvasContentTransform: (panOffset: PanOffset) => void;
  scheduleSelectionRectangle: (rect: SelectionRect) => void;
  setActiveMode: (mode: InteractionMode) => void;
  setInsertionPoint: (point: InsertionPoint | null) => void;
  setIsCanvasKeyboardActive: (active: boolean) => void;
  setLivePanOffset: (panOffset: PanOffset) => void;
  setPanOffset: (panOffset: PanOffset) => void;
  selectedElementIdsRef: RefObject<string[]>;
  setSelectedElementIds: (elementIds: string[]) => void;
  setZoomLevel: (zoom: number) => void;
  visibleElements: readonly CanvasElement[];
  zoomLevelRef: RefObject<number>;
  zoomStep: number;
};

function isDragPrimitiveTool(tool: DrawingTool): tool is PrimitiveTool {
  return tool === "rectangle" || tool === "ellipse" || tool === "diamond" || tool === "line";
}

function isShapePrimitiveTool(tool: PrimitiveTool) {
  return tool !== "line";
}

function directHoveredElementId(
  point: CanvasPoint,
  elements: readonly CanvasElement[],
): string | null {
  return getDirectBindableTargetAtPoint(elements, point)?.id ?? null;
}

function isCanvasChromeTarget(target: EventTarget | null) {
  return target instanceof Element &&
    target.closest(".canvas-tool-palette, .drawing-properties-panel, .offscreen-indicators, .search-panel, .selection-frame") !== null;
}

function isCanvasDoubleClickExcludedTarget(target: EventTarget | null) {
  return target instanceof Element && target.closest(
    ".canvas-tool-palette, .drawing-properties-panel, .offscreen-indicators, .search-panel, .selection-frame-handle, .selection-frame-endpoint-handle, .selection-frame-text-resize-e, .shape-contained-text-editor, .global-text-toolbar, [role='dialog'], [aria-modal='true']",
  ) !== null;
}

function isCanvasBackgroundTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  if (
    target.closest(
      ".text-block, .offscreen-indicators, .search-panel, .canvas-starter",
    )
  ) {
    return false;
  }

  return target.closest(".canvas, .canvas-content, .canvas-grid") !== null;
}

/** Orders the scene by visual stacking while preserving scene order for z-index ties. */
export function elementIdsBackToFront(elements: readonly CanvasElement[]): string[] {
  return elements
    .map((element, index) => ({ element, index }))
    .sort((first, second) => first.element.zIndex - second.element.zIndex || first.index - second.index)
    .map(({ element }) => element.id);
}

type EditableTextCanvasElement = Extract<CanvasElement, { type: "shape" | "text" }>;

export type DirectTextEntryHit =
  | Readonly<{ element: EditableTextCanvasElement; kind: "editable" }>
  | Readonly<{ element: ConnectorElement; kind: "connector-label" }>
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "blank" }>;

type DirectTextEntryHitResolver = (
  elements: readonly CanvasElement[],
  point: CanvasPoint,
) => DirectTextEntryHit;

type CachedDirectTextEntryHit = Readonly<{
  elements: readonly CanvasElement[];
  hit: DirectTextEntryHit;
  point: CanvasPoint;
}>;

const directTextEntryHitByNativeEvent = new WeakMap<object, CachedDirectTextEntryHit>();

/** Resolves text-entry intent in exact visual z-order without DOM ownership. */
export function resolveDirectTextEntryHit(
  elements: readonly CanvasElement[],
  point: CanvasPoint,
  connectorTolerance = 0,
): DirectTextEntryHit {
  const elementsById = Object.fromEntries(
    elements.map((element) => [element.id, element]),
  );
  const orderedIds = elementIdsBackToFront(elements);
  for (let index = orderedIds.length - 1; index >= 0; index -= 1) {
    const element = elementsById[orderedIds[index]];
    if (!element) continue;
    if (element.type === "shape" && (
      shapeTextContainsPoint(element, point) || shapeTextEditingContainsPoint(element, point)
    )) {
      return { element, kind: "editable" };
    }
    if (
      element.type === "connector"
      && isArrowConnector(element)
      && canvasElementContainsPoint(element, point, connectorTolerance, elementsById)
    ) {
      return { element, kind: "connector-label" };
    }
    if (canvasElementContainsPoint(element, point, 0, elementsById)) {
      return element.type === "text" || element.type === "shape"
        ? { element, kind: "editable" }
        : { kind: "blocked" };
    }
  }
  return { kind: "blank" };
}

/** Shares a scene hit between React's capture and bubble handlers for one native event. */
export function resolveDirectTextEntryHitForNativeEvent(
  nativeEvent: object,
  elements: readonly CanvasElement[],
  point: CanvasPoint,
  resolveHit: DirectTextEntryHitResolver = resolveDirectTextEntryHit,
): DirectTextEntryHit {
  const cached = directTextEntryHitByNativeEvent.get(nativeEvent);
  if (
    cached &&
    cached.elements === elements &&
    cached.point.x === point.x &&
    cached.point.y === point.y
  ) {
    return cached.hit;
  }

  const hit = resolveHit(elements, point);
  directTextEntryHitByNativeEvent.set(nativeEvent, { elements, hit, point });
  return hit;
}

/** Central DOM router for legacy canvas pan, marquee, insertion, and wheel behavior. */
export function useCanvasInteraction(options: CanvasInteractionOptions) {
  const optionsRef = useRef(options);
  const panState = useRef<PanState | null>(null);
  const selectionState = useRef<SelectionState | null>(null);
  const primitiveSession = useRef<PrimitiveSession | null>(null);
  const pendingElementDrag = useRef<PendingElementDrag | null>(null);
  const capturedPointerRef = useRef<CapturedPointer | null>(null);
  const primitivePreviewRef = useRef<SVGSVGElement | null>(null);
  const arrowSession = useRef<ArrowAuthoringSession | null>(null);
  const arrowPreviewRef = useRef<SVGSVGElement | null>(null);
  const ignoredLostCapturePointerIdRef = useRef<number | null>(null);
  const blankClickSelectionRef = useRef<Readonly<{
    capturedAt: number;
    elementIds: readonly string[];
  }> | null>(null);
  const recentConnectorClickRef = useRef<Readonly<{
    clientX: number;
    clientY: number;
    elementId: string;
    time: number;
  }> | null>(null);
  const suppressDraftOriginDoubleClickRef = useRef(Number.NEGATIVE_INFINITY);
  const lastArrowCandidateAnnouncementRef = useRef<string | null>(null);
  const selectHoverCursorRef = useRef<"grab" | "pointer" | null>(null);
  const [arrowAuthoringVisual, setArrowAuthoringVisual] = useState<ArrowAuthoringVisual | null>(null);

  optionsRef.current = options;

  const cancelMarquee = useCallback(() => {
    selectionState.current = null;
    optionsRef.current.cleanupMarquee();
  }, []);

  useEffect(() => cancelMarquee, [cancelMarquee]);

  const clearPrimitivePreview = useCallback(() => {
    primitivePreviewRef.current?.remove();
    primitivePreviewRef.current = null;
  }, []);

  const clearArrowPreview = useCallback(() => {
    arrowPreviewRef.current?.remove();
    arrowPreviewRef.current = null;
  }, []);

  const paintArrowPreview = useCallback((session: ArrowAuthoringSession) => {
    const draftLayer = optionsRef.current.liveDraftLayerRef.current;
    if (!draftLayer) return;
    const style = optionsRef.current.getArrowPreviewStyle(session.elementId);
    const elementsById = Object.fromEntries(
      optionsRef.current.visibleElements.map((element) => [element.id, element]),
    );
    const points = resolveConnectorPoints({
      createdAt: 0,
      end: session.currentEndpoint,
      id: session.elementId,
      locked: false,
      opacity: 1,
      pageId: optionsRef.current.visibleElements.find((element) => (
        session.startEndpoint.kind === "element"
          ? element.id === session.startEndpoint.targetElementId
          : session.currentEndpoint.kind === "element" && element.id === session.currentEndpoint.targetElementId
      ))?.pageId ?? "",
      routing: "straight",
      start: session.startEndpoint,
      style,
      type: "connector",
      updatedAt: 0,
      zIndex: 0,
    }, elementsById);
    if (!points && session.startEndpoint !== session.currentEndpoint) {
      arrowPreviewRef.current?.remove();
      arrowPreviewRef.current = null;
      return;
    }
    if (points) {
      session.startPoint = points.start;
      session.currentPoint = points.end;
    }
    const svg = arrowPreviewRef.current ?? document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrowPreviewRef.current = svg;
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "arrow-authoring-preview");
    svg.setAttribute("data-start-x", String(session.startPoint.x));
    svg.setAttribute("data-start-y", String(session.startPoint.y));
    svg.setAttribute("data-end-x", String(session.currentPoint.x));
    svg.setAttribute("data-end-y", String(session.currentPoint.y));
    svg.setAttribute("overflow", "visible");
    svg.setAttribute("pointer-events", "none");
    svg.setAttribute("opacity", "1");
    svg.setAttribute("data-seed", String(style.seed));
    renderConnectorRoughSvg(
      svg,
      style,
      session.startPoint,
      session.currentPoint,
    );
    if (svg.parentNode !== draftLayer) draftLayer.append(svg);
  }, []);

  const cancelArrowAuthoring = useCallback((message = "Arrow canceled.", updateUi = true) => {
    const session = arrowSession.current;
    if (!session) {
      lastArrowCandidateAnnouncementRef.current = null;
      clearArrowPreview();
      setArrowAuthoringVisual(null);
      return false;
    }
    arrowSession.current = null;
    lastArrowCandidateAnnouncementRef.current = null;
    clearArrowPreview();
    optionsRef.current.cleanupMarquee();
    if (updateUi) {
      const previousSelection = [...session.previousSelection];
      optionsRef.current.selectedElementIdsRef.current = previousSelection;
      optionsRef.current.setSelectedElementIds(previousSelection);
      optionsRef.current.setInsertionPoint(null);
      optionsRef.current.setActiveMode(previousSelection.length > 0 ? "selected" : "canvas");
      optionsRef.current.onArrowStatusChange(message);
      setArrowAuthoringVisual(null);
    }
    return true;
  }, [clearArrowPreview]);

  const resolveArrowEndpoint = useCallback((
    point: CanvasPoint,
    shiftKey: boolean,
    startPoint?: CanvasPoint,
  ) => {
    const candidate = getConnectorAuthoringCandidate(
      point,
      optionsRef.current.visibleElements,
      optionsRef.current.zoomLevelRef.current,
      directHoveredElementId(point, optionsRef.current.visibleElements),
    );
    const endpoint = candidate?.endpoint ?? { kind: "free" as const, ...point };
    if (endpoint.kind === "element") {
      return { adjustedEndpoint: endpoint, adjustedPoint: point, candidate };
    }
    const proposedPoint = shiftKey && startPoint
      ? snapConnectorPointToAngle(startPoint, point)
      : point;
    const adjustedEndpoint = normalizeFreeConnectorEndpoint(proposedPoint);
    return adjustedEndpoint
      ? { adjustedEndpoint, adjustedPoint: { x: adjustedEndpoint.x, y: adjustedEndpoint.y }, candidate }
      : null;
  }, []);

  const updateArrowVisual = useCallback((
    candidate: ReturnType<typeof getConnectorAuthoringCandidate>,
    pointer: CanvasPoint,
    announce = true,
  ) => {
    const next = candidate
      ? {
          anchor: getNearestBindableBoundaryAnchor(candidate.target, pointer)?.point ?? null,
          isSnapped: candidate.endpoint.kind === "element",
          target: candidate.target,
        }
      : null;
    if (announce) {
      const announcementKey = getConnectorCandidateAnnouncementKey(candidate);
      const previousAnnouncementKey = lastArrowCandidateAnnouncementRef.current;
      if (announcementKey !== previousAnnouncementKey) {
        lastArrowCandidateAnnouncementRef.current = announcementKey;
        if (candidate) {
          const targetLabel = optionsRef.current.getArrowTargetLabel(candidate.target);
          optionsRef.current.onArrowStatusChange(getConnectorCandidateAnnouncement(candidate, targetLabel));
        } else if (previousAnnouncementKey !== null) {
          optionsRef.current.onArrowStatusChange(getConnectorCandidateAnnouncement(null));
        }
      }
    }
    setArrowAuthoringVisual((current) =>
      current?.target === next?.target
      && current?.isSnapped === next?.isSnapped
      && current?.anchor?.x === next?.anchor?.x
      && current?.anchor?.y === next?.anchor?.y
        ? current
        : next,
    );
  }, []);

  const paintPrimitivePreview = useCallback((session: PrimitiveSession) => {
    const draftLayer = optionsRef.current.liveDraftLayerRef.current;
    if (!draftLayer) return;
    const geometry = primitiveGeometryFromSession(
      session.tool,
      session.start,
      session.current,
      session.modifiers,
      session.didMove,
    );
    if (!geometry) {
      primitivePreviewRef.current?.remove();
      primitivePreviewRef.current = null;
      return;
    }
    const svg = primitivePreviewRef.current ?? document.createElementNS("http://www.w3.org/2000/svg", "svg");
    primitivePreviewRef.current = svg;
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "primitive-authoring-preview");
    svg.setAttribute("data-element-id", session.elementId);
    svg.setAttribute("data-seed", String(session.style.seed));
    svg.setAttribute("opacity", String(session.opacity));
    svg.setAttribute("overflow", "visible");
    svg.setAttribute("pointer-events", "none");

    if (geometry.kind === "connector") {
      const padding = Math.max(8, session.style.strokeWidth * 2);
      const minX = Math.min(geometry.start.x, geometry.end.x);
      const minY = Math.min(geometry.start.y, geometry.end.y);
      const x1 = geometry.start.x - minX + padding;
      const y1 = geometry.start.y - minY + padding;
      const x2 = geometry.end.x - minX + padding;
      const y2 = geometry.end.y - minY + padding;
      svg.setAttribute("x", String(minX - padding));
      svg.setAttribute("y", String(minY - padding));
      svg.setAttribute("width", String(Math.max(1, Math.abs(x2 - x1) + padding * 2)));
      svg.setAttribute("height", String(Math.max(1, Math.abs(y2 - y1) + padding * 2)));
      renderConnectorRoughSvg(svg, { ...session.style, endArrowhead: "none", startArrowhead: "none" }, { x: x1, y: y1 }, { x: x2, y: y2 });
    } else {
      const { rect } = geometry;
      const padding = shapeRenderPadding(session.style);
      svg.setAttribute("x", String(rect.x - padding));
      svg.setAttribute("y", String(rect.y - padding));
      svg.setAttribute("width", String(Math.max(1, rect.width) + padding * 2));
      svg.setAttribute("height", String(Math.max(1, rect.height) + padding * 2));
      renderShapeRoughSvg(svg, session.tool as ShapeElement["shape"], session.style, rect.width, rect.height, padding);
    }
    if (svg.parentNode !== draftLayer) draftLayer.append(svg);
  }, []);

  const getCanvasPoint = useCallback(
    (clientX: number, clientY: number): CanvasPoint | null => {
      const canvasContentElement = optionsRef.current.canvasContentRef.current;

      if (!canvasContentElement) {
        return null;
      }

      const canvasContentRect = canvasContentElement.getBoundingClientRect();
      const scaleX =
        canvasContentElement.offsetWidth > 0
          ? canvasContentRect.width / canvasContentElement.offsetWidth
          : 0;
      const scaleY =
        canvasContentElement.offsetHeight > 0
          ? canvasContentRect.height / canvasContentElement.offsetHeight
          : 0;

      if (
        !Number.isFinite(scaleX) ||
        !Number.isFinite(scaleY) ||
        scaleX <= 0 ||
        scaleY <= 0
      ) {
        return null;
      }

      return {
        x: (clientX - canvasContentRect.left) / scaleX,
        y: (clientY - canvasContentRect.top) / scaleY,
      };
    },
    [],
  );

  const setSelectHoverCursor = useCallback((cursor: "grab" | "pointer" | null) => {
    if (selectHoverCursorRef.current === cursor) return;
    selectHoverCursorRef.current = cursor;
    const canvas = optionsRef.current.canvasRef.current;
    if (!canvas) return;
    if (cursor) {
      canvas.style.cursor = cursor;
      canvas.dataset.selectHoverCursor = cursor;
    } else {
      canvas.style.removeProperty("cursor");
      delete canvas.dataset.selectHoverCursor;
    }
  }, []);

  const updateSelectHoverCursor = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = optionsRef.current;
    if (current.activeToolRef.current !== "select" || panState.current || arrowSession.current) {
      setSelectHoverCursor(null);
      return;
    }
    if (event.target instanceof Element) {
      const editableSurface = event.target.closest(
        ".shape-contained-text-display, .text-block-display, .connector-label, input, textarea, [contenteditable='true']",
      );
      const owner = editableSurface?.closest<HTMLElement>("[data-canvas-element-id]");
      // Locked text/labels are not editable, so their affordance remains
      // selection rather than an insertion caret.
      if (editableSurface && owner?.dataset.canvasLocked !== "true") {
        setSelectHoverCursor(null);
        return;
      }
    }
    const point = getCanvasPoint(event.clientX, event.clientY);
    if (!point) {
      setSelectHoverCursor(null);
      return;
    }
    const elementsById = Object.fromEntries(current.visibleElements.map((element) => [element.id, element]));
    const hit = getTopmostSelectableElementAtPoint(
      elementsById,
      elementIdsBackToFront(current.visibleElements),
      point,
      screenToleranceToWorld(6, { zoom: Math.max(0.01, current.zoomLevelRef.current) }),
    );
    setSelectHoverCursor(hit ? (hit.locked ? "pointer" : "grab") : null);
  }, [getCanvasPoint, setSelectHoverCursor]);

  const capturePointer = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    ignoredLostCapturePointerIdRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    capturedPointerRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
    };
  }, []);

  const releaseCapturedPointer = useCallback((pointerId?: number) => {
    const captured = capturedPointerRef.current;
    if (!captured || (pointerId !== undefined && captured.pointerId !== pointerId)) return;
    capturedPointerRef.current = null;
    if (captured.target.hasPointerCapture(captured.pointerId)) {
      ignoredLostCapturePointerIdRef.current = captured.pointerId;
      captured.target.releasePointerCapture(captured.pointerId);
    }
  }, []);

  const startPan = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = optionsRef.current;
    event.preventDefault();
    event.stopPropagation();
    current.leaveTextEditing();
    panState.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: current.panOffsetRef.current.x,
      startPanY: current.panOffsetRef.current.y,
      currentPanX: current.panOffsetRef.current.x,
      currentPanY: current.panOffsetRef.current.y,
    };
    current.setInsertionPoint(null);
    current.setIsCanvasKeyboardActive(true);
    current.setActiveMode("panning");
    capturePointer(event);
  }, [capturePointer]);

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = optionsRef.current;
      if (event.button !== 0 || isCanvasChromeTarget(event.target)) return;
      const tool = current.activeToolRef.current;

      if (current.isTemporaryHandActiveRef.current || tool === "hand") {
        startPan(event);
        return;
      }
      if (tool === "arrow") {
        const point = getCanvasPoint(event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        event.stopPropagation();
        current.leaveTextEditing();
        current.cleanupMarquee();
        current.setInsertionPoint(null);
        current.setIsCanvasKeyboardActive(true);
        current.setActiveMode("canvas");
        const pending = arrowSession.current;
        if (!pending) {
          const resolved = resolveArrowEndpoint(point, false);
          if (!resolved) {
            current.onArrowStatusChange("Arrow endpoint is unavailable.");
            return;
          }
          const previousSelection = [...current.selectedElementIdsRef.current];
          current.selectedElementIdsRef.current = [];
          current.setSelectedElementIds([]);
          arrowSession.current = {
            cancellationKey: current.interactionCancellationKey,
            currentEndpoint: resolved.adjustedEndpoint,
            currentPoint: resolved.adjustedPoint,
            elementId: current.createArrowId(),
            previousSelection,
            startEndpoint: resolved.adjustedEndpoint,
            startPoint: resolved.adjustedPoint,
          };
          updateArrowVisual(resolved.candidate, point);
          paintArrowPreview(arrowSession.current);
          current.onArrowStatusChange(
            resolved.adjustedEndpoint.kind === "element"
              ? "Arrow start bound. Choose an end point."
              : "Arrow start set. Choose an end point.",
          );
        } else {
          const resolved = resolveArrowEndpoint(point, event.shiftKey, pending.startPoint);
          if (!resolved) {
            current.onArrowStatusChange("Arrow endpoint is unavailable.");
            return;
          }
          pending.currentEndpoint = resolved.adjustedEndpoint;
          pending.currentPoint = resolved.adjustedPoint;
          updateArrowVisual(resolved.candidate, point);
          paintArrowPreview(pending);
          if (Math.hypot(
            pending.currentPoint.x - pending.startPoint.x,
            pending.currentPoint.y - pending.startPoint.y,
          ) < 0.01) {
            current.onArrowStatusChange("Arrow needs two different endpoints.");
            return;
          }
          if (!current.onCreateArrow(pending.elementId, pending.startEndpoint, pending.currentEndpoint)) {
            current.onArrowStatusChange(
              "Arrow could not be created because its resolved endpoints exceed the safe canvas boundary.",
            );
            return;
          }
          arrowSession.current = null;
          lastArrowCandidateAnnouncementRef.current = null;
          clearArrowPreview();
          setArrowAuthoringVisual(null);
          current.onArrowStatusChange(current.getArrowCreatedStatus());
        }
        event.currentTarget.focus({ preventScroll: true });
        return;
      }
      if (!isDragPrimitiveTool(tool)) {
        if (tool !== "text" && tool !== "image") return;
        if (tool === "text") {
          current.setInsertionPoint(null);
          current.setIsCanvasKeyboardActive(true);
          event.currentTarget.focus({ preventScroll: true });
          return;
        }
        const point = getCanvasPoint(event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        event.stopPropagation();
        current.leaveTextEditing();
        current.cleanupMarquee();
        current.setInsertionPoint(null);
        current.setIsCanvasKeyboardActive(true);
        if (current.hasPendingImage()) {
          current.onPlaceImage(point);
        } else {
          current.onRequestImagePicker();
        }
        return;
      }
      if (primitiveSession.current) return;

      const point = getCanvasPoint(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      current.leaveTextEditing();
      current.cleanupMarquee();
      current.setInsertionPoint(null);
      const previousSelection = [...current.selectedElementIdsRef.current];
      if (tool === "line") {
        current.selectedElementIdsRef.current = [];
        current.setSelectedElementIds([]);
      }
      current.setIsCanvasKeyboardActive(true);
      if (tool === "line" || previousSelection.length === 0) {
        current.setActiveMode("canvas");
      }
      const elementId = current.createPrimitiveId(tool);
      const appearance = current.getPrimitivePreviewAppearance(tool, elementId);
      primitiveSession.current = {
        cancellationKey: current.interactionCancellationKey,
        current: point,
        didMove: false,
        elementId,
        modifiers: { alt: event.altKey, shift: event.shiftKey },
        opacity: appearance.opacity,
        pointerId: event.pointerId,
        previousSelection,
        start: point,
        startClient: { x: event.clientX, y: event.clientY },
        style: appearance.style,
        tool,
      };
      if (tool === "line") paintPrimitivePreview(primitiveSession.current);
      capturePointer(event);
      event.currentTarget.focus({ preventScroll: true });
    },
    [capturePointer, clearArrowPreview, getCanvasPoint, paintArrowPreview, paintPrimitivePreview, resolveArrowEndpoint, startPan, updateArrowVisual],
  );

  const handlePointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = optionsRef.current;
      const currentArrow = arrowSession.current;
      if (currentArrow && !panState.current) {
        setSelectHoverCursor(null);
        const point = getCanvasPoint(event.clientX, event.clientY);
        if (!point) return;
        const resolved = resolveArrowEndpoint(point, event.shiftKey, currentArrow.startPoint);
        if (!resolved) return;
        currentArrow.currentEndpoint = resolved.adjustedEndpoint;
        currentArrow.currentPoint = resolved.adjustedPoint;
        updateArrowVisual(resolved.candidate, point);
        paintArrowPreview(currentArrow);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Before the first click the Arrow tool still exposes the exact same
      // compatible target and boundary marker. This makes binding discoverable
      // without starting an authoring session or touching scene state.
      if (current.activeToolRef.current === "arrow" && !panState.current) {
        setSelectHoverCursor(null);
        const point = getCanvasPoint(event.clientX, event.clientY);
        if (point) {
          const candidate = getConnectorAuthoringCandidate(
            point,
            current.visibleElements,
            current.zoomLevelRef.current,
            directHoveredElementId(point, current.visibleElements),
          );
          updateArrowVisual(candidate, point, false);
        }
        return;
      }
      updateSelectHoverCursor(event);
      setArrowAuthoringVisual((visual) => visual === null ? visual : null);
      if (current.activeToolRef.current !== "image" || !current.hasPendingImage()) return;
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (point) current.onImagePreviewPointChange(point);
    },
    [getCanvasPoint, paintArrowPreview, resolveArrowEndpoint, setSelectHoverCursor, updateArrowVisual, updateSelectHoverCursor],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = optionsRef.current;
      if (!isCanvasBackgroundTarget(event.target)) {
        return;
      }
      if (event.button === 2) {
        startPan(event);
        return;
      }
      if (current.activeToolRef.current !== "select") return;

      if (current.isDirectTextDraftActive()) {
        suppressDraftOriginDoubleClickRef.current = performance.now();
      }
      current.leaveTextEditing();
      current.cleanupMarquee();
      current.setIsCanvasKeyboardActive(true);
      event.preventDefault();

      {
        const startPoint = getCanvasPoint(event.clientX, event.clientY);

        if (!startPoint) {
          return;
        }

        const tolerance = screenToleranceToWorld(6, {
          zoom: Math.max(0.01, current.zoomLevelRef.current),
        });
        const elementsById = Object.fromEntries(
          current.visibleElements.map((element) => [element.id, element]),
        );
        const hitElement = getTopmostSelectableElementAtPoint(
          elementsById,
          elementIdsBackToFront(current.visibleElements),
          startPoint,
          tolerance,
        );
        if (hitElement) {
          recentConnectorClickRef.current = hitElement.type === "connector"
            ? {
                clientX: event.clientX,
                clientY: event.clientY,
                elementId: hitElement.id,
                time: performance.now(),
              }
            : null;
          blankClickSelectionRef.current = null;
          const currentIds = current.selectedElementIdsRef.current;
          const nextIds = event.shiftKey
            ? currentIds.includes(hitElement.id)
              ? currentIds.filter((id) => id !== hitElement.id)
              : [...currentIds, hitElement.id]
            : [hitElement.id];
          current.selectedElementIdsRef.current = nextIds;
          current.setSelectedElementIds(nextIds);
          current.setInsertionPoint(null);
          current.setActiveMode(nextIds.length > 0 ? "selected" : "canvas");
          if (!event.shiftKey && !hitElement.locked && nextIds.includes(hitElement.id)) {
            pendingElementDrag.current = {
              cancellationKey: current.interactionCancellationKey,
              didStart: false,
              elementId: hitElement.id,
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startClientY: event.clientY,
            };
            capturePointer(event);
          }
          return;
        }

        const now = performance.now();
        const cachedSelection = blankClickSelectionRef.current;
        if (
          current.selectedElementIdsRef.current.length > 0
          || !cachedSelection
          || now - cachedSelection.capturedAt > 750
        ) {
          blankClickSelectionRef.current = {
            capturedAt: now,
            elementIds: [...current.selectedElementIdsRef.current],
          };
        }
        current.selectedElementIdsRef.current = [];
        current.setSelectedElementIds([]);
        current.setActiveMode("canvas");

        selectionState.current = {
          startX: startPoint.x,
          startY: startPoint.y,
          currentX: startPoint.x,
          currentY: startPoint.y,
          didMove: false,
        };
        current.setInsertionPoint(null);
        current.cleanupMarquee();
      }

      capturePointer(event);
    },
    [capturePointer, getCanvasPoint, startPan],
  );

  const editDirectTextElement = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      element: EditableTextCanvasElement,
    ) => {
      const current = optionsRef.current;
      event.preventDefault();
      event.stopPropagation();
      current.cleanupMarquee();
      current.setInsertionPoint(null);
      current.setIsCanvasKeyboardActive(true);
      blankClickSelectionRef.current = null;
      const textSurface = event.target instanceof Element
        ? event.target.closest<HTMLElement>(
            ".shape-contained-text-content, .text-block-display",
          )
        : null;
      current.onEditBindableText(element.id, {
        clientX: event.clientX,
        clientY: event.clientY,
        textOffset: textSurface
          ? getTextOffsetAtClientPoint(
              textSurface,
              event.clientX,
              event.clientY,
              textSurface.textContent?.length ?? 0,
            )
          : null,
      });
    },
    [],
  );

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const current = optionsRef.current;
      if (
        event.button !== 0
        || performance.now() - suppressDraftOriginDoubleClickRef.current < 750
        || current.activeToolRef.current !== "select" && current.activeToolRef.current !== "text"
        || current.isTextEditing()
        || isCanvasDoubleClickExcludedTarget(event.target)
      ) return;
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (!point) return;
      const hit = resolveDirectTextEntryHitForNativeEvent(
        event.nativeEvent,
        current.visibleElements,
        point,
        (elements, hitPoint) => resolveDirectTextEntryHit(
          elements,
          hitPoint,
          screenToleranceToWorld(8, { zoom: Math.max(0.01, current.zoomLevelRef.current) }),
        ),
      );
      if (hit.kind === "blocked") return;
      if (hit.kind === "connector-label") {
        event.preventDefault();
        event.stopPropagation();
        current.cleanupMarquee();
        current.setInsertionPoint(null);
        current.setIsCanvasKeyboardActive(true);
        current.onEditConnectorLabel(hit.element.id);
        return;
      }
      if (hit.kind === "blank" && !isCanvasBackgroundTarget(event.target)) return;
      if (hit.kind === "blank") {
        event.preventDefault();
        event.stopPropagation();
        current.cleanupMarquee();
        current.setInsertionPoint(null);
        current.setIsCanvasKeyboardActive(true);
        const previousSelection = blankClickSelectionRef.current?.elementIds
          ?? current.selectedElementIdsRef.current;
        blankClickSelectionRef.current = null;
        current.onCreateDirectText(point, previousSelection);
        return;
      }
      editDirectTextElement(event, hit.element);
    },
    [editDirectTextElement, getCanvasPoint],
  );

  const consumeRecentConnectorClick = useCallback((
    elementId: string,
    clientX: number,
    clientY: number,
  ) => {
    const recent = recentConnectorClickRef.current;
    recentConnectorClickRef.current = null;
    return Boolean(
      recent
      && recent.elementId === elementId
      && performance.now() - recent.time <= 750
      && Math.hypot(clientX - recent.clientX, clientY - recent.clientY) <= 8
    );
  }, []);

  const handleDoubleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const current = optionsRef.current;
      if (
        event.button !== 0
        || performance.now() - suppressDraftOriginDoubleClickRef.current < 750
        || current.activeToolRef.current !== "select" && current.activeToolRef.current !== "text"
        || current.isTextEditing()
        || isCanvasDoubleClickExcludedTarget(event.target)
      ) return;
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (!point) return;
      const hit = resolveDirectTextEntryHitForNativeEvent(
        event.nativeEvent,
        current.visibleElements,
        point,
        (elements, hitPoint) => resolveDirectTextEntryHit(
          elements,
          hitPoint,
          screenToleranceToWorld(8, { zoom: Math.max(0.01, current.zoomLevelRef.current) }),
        ),
      );
      if (hit.kind === "connector-label") {
        event.preventDefault();
        event.stopPropagation();
        current.cleanupMarquee();
        current.setInsertionPoint(null);
        current.setIsCanvasKeyboardActive(true);
        current.onEditConnectorLabel(hit.element.id);
        return;
      }
      if (hit.kind !== "editable") return;
      editDirectTextElement(event, hit.element);
    },
    [editDirectTextElement, getCanvasPoint],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const currentPrimitive = primitiveSession.current;
      if (currentPrimitive?.pointerId === event.pointerId) {
        const point = getCanvasPoint(event.clientX, event.clientY);
        if (!point) return;
        currentPrimitive.current = point;
        currentPrimitive.modifiers = { alt: event.altKey, shift: event.shiftKey };
        if (isShapePrimitiveTool(currentPrimitive.tool)) {
          const wasMeaningful = currentPrimitive.didMove;
          currentPrimitive.didMove = isMeaningfulShapeDrag(
            currentPrimitive.startClient,
            { x: event.clientX, y: event.clientY },
          );
          if (!wasMeaningful && currentPrimitive.didMove) {
            optionsRef.current.selectedElementIdsRef.current = [];
            optionsRef.current.setSelectedElementIds([]);
            optionsRef.current.setActiveMode("canvas");
          }
        } else {
          currentPrimitive.didMove ||= Math.hypot(
            point.x - currentPrimitive.start.x,
            point.y - currentPrimitive.start.y,
          ) >= 2;
        }
        paintPrimitivePreview(currentPrimitive);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const currentPan = panState.current;
      const currentSelection = selectionState.current;
      const current = optionsRef.current;
      const pendingDrag = pendingElementDrag.current;
      if (pendingDrag?.pointerId === event.pointerId) {
        if (!pendingDrag.didStart && Math.hypot(
          event.clientX - pendingDrag.startClientX,
          event.clientY - pendingDrag.startClientY,
        ) >= 3) {
          pendingDrag.didStart = current.onVisualDragStart(
            pendingDrag.elementId,
            pendingDrag.startClientX,
            pendingDrag.startClientY,
          );
          if (pendingDrag.didStart) current.setActiveMode("dragging");
        }
        if (pendingDrag.didStart) current.onVisualDragMove(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (currentPan) {
        const nextPanOffset = {
          x: currentPan.startPanX + event.clientX - currentPan.startClientX,
          y: currentPan.startPanY + event.clientY - currentPan.startClientY,
        };
        currentPan.currentPanX = nextPanOffset.x;
        currentPan.currentPanY = nextPanOffset.y;
        current.scheduleCanvasContentTransform(nextPanOffset);
        return;
      }

      if (!currentSelection || !current.canvasRef.current) {
        return;
      }

      const currentPoint = getCanvasPoint(event.clientX, event.clientY);
      if (!currentPoint) {
        return;
      }

      currentSelection.currentX = currentPoint.x;
      currentSelection.currentY = currentPoint.y;

      if (
        Math.abs(currentSelection.currentX - currentSelection.startX) > 2 ||
        Math.abs(currentSelection.currentY - currentSelection.startY) > 2
      ) {
        if (!currentSelection.didMove) {
          currentSelection.didMove = true;
          current.setActiveMode("selecting");
          current.setInsertionPoint(null);
        }

        current.scheduleSelectionRectangle(getSelectionRect(currentSelection));
      }
    },
    [getCanvasPoint, paintPrimitivePreview],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const currentPrimitive = primitiveSession.current;
      if (currentPrimitive?.pointerId === event.pointerId) {
        if (isShapePrimitiveTool(currentPrimitive.tool)) {
          const finalPoint = getCanvasPoint(event.clientX, event.clientY);
          if (finalPoint) {
            currentPrimitive.current = finalPoint;
            currentPrimitive.modifiers = { alt: event.altKey, shift: event.shiftKey };
            currentPrimitive.didMove = isMeaningfulShapeDrag(
              currentPrimitive.startClient,
              { x: event.clientX, y: event.clientY },
            );
          }
        }
        primitiveSession.current = null;
        clearPrimitivePreview();
        releaseCapturedPointer(event.pointerId);
        const geometry = primitiveGeometryFromSession(
          currentPrimitive.tool,
          currentPrimitive.start,
          currentPrimitive.current,
          currentPrimitive.modifiers,
          currentPrimitive.didMove,
        );
        const didCreate = geometry
          ? optionsRef.current.onCreatePrimitive(
            currentPrimitive.elementId,
            currentPrimitive.tool,
            geometry,
            { opacity: currentPrimitive.opacity, style: currentPrimitive.style },
          )
          : false;
        if (!didCreate) {
          if (
            currentPrimitive.didMove
            && isShapePrimitiveTool(currentPrimitive.tool)
          ) optionsRef.current.onPrimitiveStatusChange(currentPrimitive.tool);
          const restorableSelection = currentPrimitive.previousSelection.filter((id) =>
            optionsRef.current.visibleElements.some((element) => element.id === id)
          );
          optionsRef.current.selectedElementIdsRef.current = restorableSelection;
          optionsRef.current.setSelectedElementIds(restorableSelection);
          optionsRef.current.setActiveMode(restorableSelection.length > 0 ? "selected" : "canvas");
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const pendingDrag = pendingElementDrag.current;
      if (pendingDrag?.pointerId === event.pointerId) {
        pendingElementDrag.current = null;
        releaseCapturedPointer(event.pointerId);
        if (!pendingDrag.didStart && Math.hypot(
          event.clientX - pendingDrag.startClientX,
          event.clientY - pendingDrag.startClientY,
        ) >= 3) {
          pendingDrag.didStart = optionsRef.current.onVisualDragStart(
            pendingDrag.elementId,
            pendingDrag.startClientX,
            pendingDrag.startClientY,
          );
          if (pendingDrag.didStart) {
            optionsRef.current.setActiveMode("dragging");
            optionsRef.current.onVisualDragMove(event.clientX, event.clientY);
          }
        }
        if (pendingDrag.didStart) {
          optionsRef.current.onVisualDragEnd(event.clientX, event.clientY);
        } else {
          const selectedIds = optionsRef.current.selectedElementIdsRef.current;
          optionsRef.current.setActiveMode(selectedIds.length > 0 ? "selected" : "canvas");
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const currentPan = panState.current;
      const currentSelection = selectionState.current;

      if (!currentPan && !currentSelection) {
        return;
      }

      const current = optionsRef.current;
      if (currentPan) {
        const nextPanOffset = {
          x: currentPan.currentPanX,
          y: currentPan.currentPanY,
        };
        current.panOffsetRef.current = nextPanOffset;
        current.setPanOffset(nextPanOffset);
        current.setActiveMode("canvas");
      }

      if (currentSelection?.didMove) {
        const nextSelectionRect = getSelectionRect(currentSelection);
        const elementsById = Object.fromEntries(
          current.visibleElements.map((element) => [element.id, element]),
        );
        const nextSelectedElementIds = current.visibleElements
          .filter((element) => {
            const bounds = getElementBounds(element, elementsById);
            return Boolean(bounds && rectsIntersect(nextSelectionRect, bounds));
          })
          .map((element) => element.id);
        current.selectedElementIdsRef.current = nextSelectedElementIds;
        current.setSelectedElementIds(nextSelectedElementIds);
        current.setActiveMode(
          nextSelectedElementIds.length > 0 ? "selected" : "canvas",
        );
      } else {
        current.setActiveMode("canvas");
      }

      panState.current = null;
      cancelMarquee();
      releaseCapturedPointer(event.pointerId);
    },
    [cancelMarquee, clearPrimitivePreview, getCanvasPoint, releaseCapturedPointer],
  );

  const cancelCapturedPointerInteraction = useCallback(
    (updateUi = true) => {
      const currentPan = panState.current;
      const currentSelection = selectionState.current;
      const currentPrimitive = primitiveSession.current;
      const currentPendingElementDrag = pendingElementDrag.current;
      const hadCapturedSession = Boolean(
        currentPan || currentSelection || currentPrimitive || currentPendingElementDrag,
      );
      if (!hadCapturedSession && !capturedPointerRef.current) return false;
      if (currentPan && updateUi) {
        const startPan = { x: currentPan.startPanX, y: currentPan.startPanY };
        optionsRef.current.panOffsetRef.current = startPan;
        optionsRef.current.scheduleCanvasContentTransform(startPan);
      }
      panState.current = null;
      primitiveSession.current = null;
      pendingElementDrag.current = null;
      clearPrimitivePreview();
      cancelMarquee();
      releaseCapturedPointer();
      if (currentPendingElementDrag?.didStart) optionsRef.current.onVisualDragCancel(updateUi);
      if (updateUi && hadCapturedSession) {
        const restorableSelection = currentPrimitive && isShapePrimitiveTool(currentPrimitive.tool)
          ? currentPrimitive.previousSelection.filter((id) =>
              optionsRef.current.visibleElements.some((element) => element.id === id)
            )
          : currentPendingElementDrag
            ? optionsRef.current.selectedElementIdsRef.current.filter((id) =>
                optionsRef.current.visibleElements.some((element) => element.id === id)
              )
            : [];
        optionsRef.current.selectedElementIdsRef.current = restorableSelection;
        optionsRef.current.setSelectedElementIds(restorableSelection);
        optionsRef.current.setActiveMode(restorableSelection.length > 0 ? "selected" : "canvas");
      }
      return true;
    },
    [cancelMarquee, clearPrimitivePreview, releaseCapturedPointer],
  );

  const cancelTransientPointerInteraction = useCallback(
    (updateUi = true) => {
      const captured = cancelCapturedPointerInteraction(updateUi);
      const arrow = cancelArrowAuthoring("Arrow canceled.", updateUi);
      return captured || arrow;
    },
    [cancelArrowAuthoring, cancelCapturedPointerInteraction],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Browsers dispatch lostpointercapture after a successful pointerup.
      // The completed session has already been cleared by then, so it must not
      // reset the selected mode or discard a completed marquee.
      if (
        event.type === "lostpointercapture"
        && ignoredLostCapturePointerIdRef.current === event.pointerId
      ) {
        ignoredLostCapturePointerIdRef.current = null;
        if (capturedPointerRef.current?.pointerId !== event.pointerId) return;
      }
      cancelTransientPointerInteraction();
    },
    [cancelTransientPointerInteraction],
  );

  useEffect(() => {
    const handleWindowBlur = () => cancelTransientPointerInteraction();
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape"
        && !(event.target instanceof Element && event.target.closest(".search-panel"))
      ) {
        cancelTransientPointerInteraction();
      }
    };
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("keydown", handleEscape, true);
    };
  }, [cancelTransientPointerInteraction]);

  useEffect(() => {
    if (
      primitiveSession.current
      && primitiveSession.current.cancellationKey !== options.interactionCancellationKey
    ) {
      cancelCapturedPointerInteraction();
    }
    if (
      pendingElementDrag.current
      && pendingElementDrag.current.cancellationKey !== options.interactionCancellationKey
    ) {
      cancelCapturedPointerInteraction();
    }
    if (arrowSession.current?.cancellationKey !== options.interactionCancellationKey) {
      cancelArrowAuthoring();
    }
    if (!arrowSession.current && options.activeToolRef.current !== "arrow") {
      lastArrowCandidateAnnouncementRef.current = null;
      setArrowAuthoringVisual(null);
    }
  }, [cancelArrowAuthoring, cancelCapturedPointerInteraction, options.interactionCancellationKey]);

  useEffect(() => () => {
    cancelCapturedPointerInteraction(false);
    cancelArrowAuthoring("", false);
  }, [cancelArrowAuthoring, cancelCapturedPointerInteraction]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLElement>) => {
    const current = optionsRef.current;
    event.preventDefault();

    if (event.metaKey || event.ctrlKey) {
      const currentZoom = current.zoomLevelRef.current;
      const nextZoom = Math.min(
        current.maxZoom,
        Math.max(
          current.minZoom,
          currentZoom + (event.deltaY < 0 ? current.zoomStep : -current.zoomStep),
        ),
      );

      if (nextZoom === currentZoom) {
        return;
      }

      const canvasRect = event.currentTarget.getBoundingClientRect();
      const pointerX = event.clientX - canvasRect.left;
      const pointerY = event.clientY - canvasRect.top;
      const canvasPointX =
        (pointerX - current.panOffsetRef.current.x) / currentZoom;
      const canvasPointY =
        (pointerY - current.panOffsetRef.current.y) / currentZoom;
      const nextPanOffset = {
        x: pointerX - canvasPointX * nextZoom,
        y: pointerY - canvasPointY * nextZoom,
      };

      current.zoomLevelRef.current = nextZoom;
      current.panOffsetRef.current = nextPanOffset;
      current.setZoomLevel(nextZoom);
      current.setPanOffset(nextPanOffset);
      current.setLivePanOffset(nextPanOffset);
      return;
    }

    const shiftScrollDelta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    const nextPanOffset = {
      x:
        current.panOffsetRef.current.x -
        (event.shiftKey ? shiftScrollDelta : event.deltaX),
      y:
        current.panOffsetRef.current.y -
        (event.shiftKey ? 0 : event.deltaY),
    };

    current.panOffsetRef.current = nextPanOffset;
    current.setLivePanOffset(nextPanOffset);
    current.setPanOffset(nextPanOffset);
  }, []);

  return {
    handleDoubleClick,
    handleDoubleClickCapture,
    handlePointerDown,
    handlePointerDownCapture,
    handlePointerCancel,
    handlePointerEnd,
    handlePointerMove,
    handlePointerMoveCapture,
    handleWheel,
    arrowAuthoringVisual,
    cancelArrowAuthoring,
    cancelCapturedPointerInteraction,
    cancelMarquee,
    consumeRecentConnectorClick,
    startPan,
  };
}
