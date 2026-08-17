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
import type { BoxCanvasElement } from "../model/elements";

type CanvasInteractionOptions = {
  canvasContentRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLElement | null>;
  cleanupMarquee: () => void;
  leaveTextEditing: () => void;
  maxZoom: number;
  minZoom: number;
  panOffsetRef: RefObject<PanOffset>;
  scheduleCanvasContentTransform: (panOffset: PanOffset) => void;
  scheduleSelectionRectangle: (rect: SelectionRect) => void;
  setActiveMode: (mode: InteractionMode) => void;
  setInsertionPoint: (point: InsertionPoint | null) => void;
  setIsCanvasKeyboardActive: (active: boolean) => void;
  setLivePanOffset: (panOffset: PanOffset) => void;
  setPanOffset: (panOffset: PanOffset) => void;
  setSelectedElementIds: (elementIds: string[]) => void;
  setZoomLevel: (zoom: number) => void;
  visibleElements: readonly BoxCanvasElement[];
  zoomLevelRef: RefObject<number>;
  zoomStep: number;
};

function isCanvasBackgroundTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
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

/** Central DOM router for legacy canvas pan, marquee, insertion, and wheel behavior. */
export function useCanvasInteraction(options: CanvasInteractionOptions) {
  const optionsRef = useRef(options);
  const panState = useRef<PanState | null>(null);
  const selectionState = useRef<SelectionState | null>(null);

  optionsRef.current = options;

  const cancelMarquee = useCallback(() => {
    selectionState.current = null;
    optionsRef.current.cleanupMarquee();
  }, []);

  useEffect(() => cancelMarquee, [cancelMarquee]);

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

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = optionsRef.current;
      if (!isCanvasBackgroundTarget(event.target)) {
        return;
      }

      current.leaveTextEditing();
      current.setSelectedElementIds([]);
      current.cleanupMarquee();
      current.setIsCanvasKeyboardActive(true);
      current.setActiveMode("canvas");
      event.preventDefault();

      if (event.button === 2) {
        startPan(event);
      } else {
        const startPoint = getCanvasPoint(event.clientX, event.clientY);

        if (!startPoint) {
          return;
        }

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
    [getCanvasPoint],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      void event;
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
        const nextSelectedElementIds = current.visibleElements
          .filter((element) =>
            rectsIntersect(nextSelectionRect, {
              x: element.x,
              y: element.y,
              width: element.width,
              height: element.height,
            }),
          )
          .map((element) => element.id);
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
    [cancelMarquee],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const currentPan = panState.current;
      const currentSelection = selectionState.current;
      // Browsers dispatch lostpointercapture after a successful pointerup.
      // The completed session has already been cleared by then, so it must not
      // reset the selected mode or discard a completed marquee.
      if (!currentPan && !currentSelection) return;
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
      cancelMarquee();
      optionsRef.current.setActiveMode("canvas");
    },
    [cancelMarquee],
  );

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
    handlePointerCancel,
    handlePointerEnd,
    handlePointerMove,
    handleWheel,
    cancelMarquee,
    startPan,
  };
}
