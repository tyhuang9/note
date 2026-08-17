import { useCallback, useEffect, useRef, type RefObject } from "react";
import type {
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
import type { CanvasElement } from "../model/elements";
import { screenToleranceToWorld } from "../model/geometry";
import { getElementBounds, getTopmostElementAtPoint } from "../model/hitTesting";
import {
  primitiveGeometryFromSession,
  type PrimitiveGeometry,
  type PrimitiveModifiers,
  type PrimitiveTool,
} from "./primitiveGeometry";
import type { DrawingTool } from "./useInkInteraction";

type PrimitiveSession = {
  current: CanvasPoint;
  didMove: boolean;
  modifiers: PrimitiveModifiers;
  pointerId: number;
  start: CanvasPoint;
  tool: PrimitiveTool;
};

type CanvasInteractionOptions = {
  activeToolRef: RefObject<DrawingTool>;
  canvasContentRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLElement | null>;
  cleanupMarquee: () => void;
  hasPendingImage: () => boolean;
  isTemporaryHandActiveRef: RefObject<boolean>;
  leaveTextEditing: () => void;
  liveDraftLayerRef: RefObject<SVGSVGElement | null>;
  maxZoom: number;
  minZoom: number;
  onCreatePrimitive: (tool: PrimitiveTool, geometry: PrimitiveGeometry) => void;
  onCreateText: (point: CanvasPoint) => void;
  onImagePreviewPointChange: (point: CanvasPoint | null) => void;
  onPlaceImage: (point: CanvasPoint) => void;
  onRequestImagePicker: () => void;
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

function isPrimitiveTool(tool: DrawingTool): tool is PrimitiveTool {
  return tool === "rectangle" || tool === "ellipse" || tool === "diamond" || tool === "line" || tool === "arrow";
}

function isCanvasChromeTarget(target: EventTarget | null) {
  return target instanceof Element &&
    target.closest(".canvas-tool-palette, .offscreen-indicators, .search-panel, .selection-frame") !== null;
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

/** Central DOM router for legacy canvas pan, marquee, insertion, and wheel behavior. */
export function useCanvasInteraction(options: CanvasInteractionOptions) {
  const optionsRef = useRef(options);
  const panState = useRef<PanState | null>(null);
  const selectionState = useRef<SelectionState | null>(null);
  const primitiveSession = useRef<PrimitiveSession | null>(null);
  const primitivePreviewRef = useRef<SVGGElement | null>(null);

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
    const group = primitivePreviewRef.current ?? document.createElementNS("http://www.w3.org/2000/svg", "g");
    primitivePreviewRef.current = group;
    group.replaceChildren();
    group.setAttribute("fill", "none");
    group.setAttribute("opacity", "0.7");
    group.setAttribute("pointer-events", "none");
    group.setAttribute("stroke", "currentColor");
    group.setAttribute("stroke-dasharray", "6 4");
    group.setAttribute("stroke-width", "2");

    if (geometry.kind === "connector") {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(geometry.start.x));
      line.setAttribute("y1", String(geometry.start.y));
      line.setAttribute("x2", String(geometry.end.x));
      line.setAttribute("y2", String(geometry.end.y));
      group.append(line);
    } else {
      const { rect } = geometry;
      const node = document.createElementNS(
        "http://www.w3.org/2000/svg",
        session.tool === "ellipse" ? "ellipse" : session.tool === "diamond" ? "polygon" : "rect",
      );
      if (session.tool === "ellipse") {
        node.setAttribute("cx", String(rect.x + rect.width / 2));
        node.setAttribute("cy", String(rect.y + rect.height / 2));
        node.setAttribute("rx", String(rect.width / 2));
        node.setAttribute("ry", String(rect.height / 2));
      } else if (session.tool === "diamond") {
        node.setAttribute("points", [
          `${rect.x + rect.width / 2},${rect.y}`,
          `${rect.x + rect.width},${rect.y + rect.height / 2}`,
          `${rect.x + rect.width / 2},${rect.y + rect.height}`,
          `${rect.x},${rect.y + rect.height / 2}`,
        ].join(" "));
      } else {
        node.setAttribute("x", String(rect.x));
        node.setAttribute("y", String(rect.y));
        node.setAttribute("width", String(rect.width));
        node.setAttribute("height", String(rect.height));
      }
      group.append(node);
    }
    if (group.parentNode !== draftLayer) draftLayer.append(group);
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
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = optionsRef.current;
      if (event.button !== 0 || isCanvasChromeTarget(event.target)) return;
      const tool = current.activeToolRef.current;

      if (current.isTemporaryHandActiveRef.current || tool === "hand") {
        startPan(event);
        return;
      }
      if (!isPrimitiveTool(tool)) {
        if (tool !== "text" && tool !== "image") return;
        const point = getCanvasPoint(event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        event.stopPropagation();
        current.leaveTextEditing();
        current.cleanupMarquee();
        current.setInsertionPoint(null);
        current.setIsCanvasKeyboardActive(true);
        if (tool === "text") {
          current.onCreateText(point);
        } else if (current.hasPendingImage()) {
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
      current.setSelectedElementIds([]);
      current.setIsCanvasKeyboardActive(true);
      current.setActiveMode("canvas");
      primitiveSession.current = {
        current: point,
        didMove: false,
        modifiers: { alt: event.altKey, shift: event.shiftKey },
        pointerId: event.pointerId,
        start: point,
        tool,
      };
      paintPrimitivePreview(primitiveSession.current);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
    },
    [getCanvasPoint, paintPrimitivePreview, startPan],
  );

  const handlePointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = optionsRef.current;
      if (current.activeToolRef.current !== "image" || !current.hasPendingImage()) return;
      const point = getCanvasPoint(event.clientX, event.clientY);
      if (point) current.onImagePreviewPointChange(point);
    },
    [getCanvasPoint],
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
        const hitElement = getTopmostElementAtPoint(
          elementsById,
          elementIdsBackToFront(current.visibleElements),
          startPoint,
          tolerance,
        );
        if (hitElement) {
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
          return;
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
        current.setInsertionPoint(startPoint);
        current.cleanupMarquee();
      }

      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [getCanvasPoint, startPan],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const currentPrimitive = primitiveSession.current;
      if (currentPrimitive?.pointerId === event.pointerId) {
        const point = getCanvasPoint(event.clientX, event.clientY);
        if (!point) return;
        currentPrimitive.current = point;
        currentPrimitive.modifiers = { alt: event.altKey, shift: event.shiftKey };
        currentPrimitive.didMove ||= Math.hypot(
          point.x - currentPrimitive.start.x,
          point.y - currentPrimitive.start.y,
        ) >= 2;
        paintPrimitivePreview(currentPrimitive);
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
        const point = getCanvasPoint(event.clientX, event.clientY);
        if (point) currentPrimitive.current = point;
        currentPrimitive.modifiers = { alt: event.altKey, shift: event.shiftKey };
        primitiveSession.current = null;
        clearPrimitivePreview();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        optionsRef.current.onCreatePrimitive(
          currentPrimitive.tool,
          primitiveGeometryFromSession(
            currentPrimitive.tool,
            currentPrimitive.start,
            currentPrimitive.current,
            currentPrimitive.modifiers,
            currentPrimitive.didMove,
          ),
        );
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
    },
    [cancelMarquee, clearPrimitivePreview, getCanvasPoint],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const currentPan = panState.current;
      const currentSelection = selectionState.current;
      // Browsers dispatch lostpointercapture after a successful pointerup.
      // The completed session has already been cleared by then, so it must not
      // reset the selected mode or discard a completed marquee.
      const currentPrimitive = primitiveSession.current;
      if (!currentPan && !currentSelection && !currentPrimitive) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (currentPan) {
        const startPan = { x: currentPan.startPanX, y: currentPan.startPanY };
        optionsRef.current.panOffsetRef.current = startPan;
        optionsRef.current.scheduleCanvasContentTransform(startPan);
        optionsRef.current.setPanOffset(startPan);
      }
      panState.current = null;
      primitiveSession.current = null;
      clearPrimitivePreview();
      cancelMarquee();
      optionsRef.current.setActiveMode("canvas");
    },
    [cancelMarquee, clearPrimitivePreview],
  );

  useEffect(() => () => {
    primitiveSession.current = null;
    clearPrimitivePreview();
  }, [clearPrimitivePreview]);

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
    handlePointerDown,
    handlePointerDownCapture,
    handlePointerCancel,
    handlePointerEnd,
    handlePointerMove,
    handlePointerMoveCapture,
    handleWheel,
    cancelMarquee,
    startPan,
  };
}
