import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { CanvasSize, PanOffset } from "../../appTypes";
import { isArrowConnector, type CanvasElement, type ConnectorElement, type ElementId } from "../model/elements";
import { isBindableElement, resolveConnectorPoints } from "../model/connectorBinding";
import { getSelectionElementBounds, unionBounds } from "../model/selectionBounds";

const CONTROL_SIZE_PX = 44;
const CONTROL_GAP_PX = 8;
const CANVAS_EDGE_INSET_PX = 16;
const TOP_CONTROLS_INSET_PX = 112;
const BOTTOM_CONTROLS_INSET_PX = 120;
const SEARCH_BOTTOM_INSET_PX = 190;

export type SuppressedConnectorControlPlacement = Readonly<{
  left: number;
  side: "bottom" | "left" | "right" | "top";
  top: number;
}>;

export function isCanonicalConnectorRouteSuppressed(
  connector: ConnectorElement,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
): boolean {
  if (
    connector.start.kind !== "element"
    || connector.end.kind !== "element"
    || !isArrowConnector(connector)
    || connector.start.anchor
    || connector.end.anchor
    || connector.start.targetElementId === connector.end.targetElementId
  ) return false;
  const startTarget = elementsById[connector.start.targetElementId];
  const endTarget = elementsById[connector.end.targetElementId];
  return isBindableElement(startTarget)
    && isBindableElement(endTarget)
    && startTarget.pageId === connector.pageId
    && endTarget.pageId === connector.pageId
    && resolveConnectorPoints(connector, elementsById) === null;
}

type SuppressedConnectorControlProps = SuppressedConnectorControlPlacement & {
  connectorId: ElementId;
  isLocked: boolean;
  isSelected: boolean;
  label: string;
  onDelete: () => void;
  onManageEndpoint: (endpoint: "start" | "end", origin: HTMLButtonElement) => void;
  onSelect: () => void;
};

/**
 * Returns a constant-size screen-space affordance outside the union of the two
 * bound targets. It prefers the roomiest usable edge, then falls back to the
 * full canvas when toolbar/search safe insets leave no valid side.
 */
export function getSuppressedConnectorControlPlacement(
  connector: ConnectorElement,
  elementsById: Readonly<Record<ElementId, CanvasElement>>,
  canvasSize: CanvasSize,
  panOffset: PanOffset,
  zoomLevel: number,
  isSearchOpen = false,
): SuppressedConnectorControlPlacement | null {
  if (!isCanonicalConnectorRouteSuppressed(connector, elementsById)) return null;
  if (connector.start.kind !== "element" || connector.end.kind !== "element") return null;

  const startTarget = elementsById[connector.start.targetElementId];
  const endTarget = elementsById[connector.end.targetElementId];
  if (!isBindableElement(startTarget) || !isBindableElement(endTarget)) return null;

  const startBounds = getSelectionElementBounds(startTarget);
  const endBounds = getSelectionElementBounds(endTarget);
  if (!startBounds || !endBounds) return null;
  const targetBounds = unionBounds(startBounds, endBounds);
  const zoom = Number.isFinite(zoomLevel) && zoomLevel > 0 ? zoomLevel : 1;
  const screenBounds = {
    bottom: panOffset.y + (targetBounds.y + targetBounds.height) * zoom,
    left: panOffset.x + targetBounds.x * zoom,
    right: panOffset.x + (targetBounds.x + targetBounds.width) * zoom,
    top: panOffset.y + targetBounds.y * zoom,
  };
  const centerX = (screenBounds.left + screenBounds.right) / 2;
  const centerY = (screenBounds.top + screenBounds.bottom) / 2;
  const actualArea = {
    bottom: Math.max(CANVAS_EDGE_INSET_PX, canvasSize.height - CANVAS_EDGE_INSET_PX),
    left: CANVAS_EDGE_INSET_PX,
    right: Math.max(CANVAS_EDGE_INSET_PX, canvasSize.width - CANVAS_EDGE_INSET_PX),
    top: CANVAS_EDGE_INSET_PX,
  };
  const safeArea = {
    bottom: Math.max(
      actualArea.top,
      canvasSize.height - (isSearchOpen ? SEARCH_BOTTOM_INSET_PX : BOTTOM_CONTROLS_INSET_PX),
    ),
    left: actualArea.left,
    right: actualArea.right,
    top: Math.min(actualArea.bottom, TOP_CONTROLS_INSET_PX),
  };

  const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
  );
  const candidates = (area: typeof safeArea) => ([
    {
      available: area.right - screenBounds.right,
      fits: screenBounds.right + CONTROL_GAP_PX + CONTROL_SIZE_PX <= area.right,
      left: screenBounds.right + CONTROL_GAP_PX,
      side: "right" as const,
      top: clamp(centerY - CONTROL_SIZE_PX / 2, area.top, area.bottom - CONTROL_SIZE_PX),
    },
    {
      available: screenBounds.left - area.left,
      fits: screenBounds.left - CONTROL_GAP_PX - CONTROL_SIZE_PX >= area.left,
      left: screenBounds.left - CONTROL_GAP_PX - CONTROL_SIZE_PX,
      side: "left" as const,
      top: clamp(centerY - CONTROL_SIZE_PX / 2, area.top, area.bottom - CONTROL_SIZE_PX),
    },
    {
      available: area.bottom - screenBounds.bottom,
      fits: screenBounds.bottom + CONTROL_GAP_PX + CONTROL_SIZE_PX <= area.bottom,
      left: clamp(centerX - CONTROL_SIZE_PX / 2, area.left, area.right - CONTROL_SIZE_PX),
      side: "bottom" as const,
      top: screenBounds.bottom + CONTROL_GAP_PX,
    },
    {
      available: screenBounds.top - area.top,
      fits: screenBounds.top - CONTROL_GAP_PX - CONTROL_SIZE_PX >= area.top,
      left: clamp(centerX - CONTROL_SIZE_PX / 2, area.left, area.right - CONTROL_SIZE_PX),
      side: "top" as const,
      top: screenBounds.top - CONTROL_GAP_PX - CONTROL_SIZE_PX,
    },
  ]).filter((candidate) => candidate.fits)
    .sort((first, second) => second.available - first.available);

  const placement = candidates(safeArea)[0] ?? candidates(actualArea)[0];
  if (placement) {
    return { left: placement.left, side: placement.side, top: placement.top };
  }

  // A target can cover the full viewport at extreme zoom. Keep the control
  // visible and deterministic even when no fully outside placement exists.
  return {
    left: clamp(screenBounds.right + CONTROL_GAP_PX, actualArea.left, actualArea.right - CONTROL_SIZE_PX),
    side: "right",
    top: clamp(centerY - CONTROL_SIZE_PX / 2, actualArea.top, actualArea.bottom - CONTROL_SIZE_PX),
  };
}

/** Visible, keyboard-operable management for a connector whose route is suppressed. */
export function SuppressedConnectorControl({
  connectorId,
  isLocked,
  isSelected,
  label,
  left,
  onDelete,
  onManageEndpoint,
  onSelect,
  side,
  top,
}: SuppressedConnectorControlProps) {
  const managementId = useId();
  const markerContainerRef = useRef<HTMLDivElement>(null);
  const managementRef = useRef<HTMLDivElement>(null);
  const [managementPosition, setManagementPosition] = useState({ left, top });
  const stopPointerPropagation = (event: MouseEvent<HTMLElement>) => event.stopPropagation();

  useLayoutEffect(() => {
    if (!isSelected) return;
    const marker = markerContainerRef.current;
    const management = managementRef.current;
    const overlay = marker?.closest<HTMLElement>(".canvas-interaction-overlay");
    if (!marker || !management || !overlay) return;

    const updatePosition = () => {
      const overlayBounds = overlay.getBoundingClientRect();
      const markerBounds = marker.getBoundingClientRect();
      const managementBounds = management.getBoundingClientRect();
      const inset = CANVAS_EDGE_INSET_PX;
      const gap = CONTROL_GAP_PX;
      let nextLeft = markerBounds.left - overlayBounds.left;
      let nextTop = markerBounds.top - overlayBounds.top;
      if (side === "left") nextLeft += markerBounds.width + gap;
      if (side === "right") nextLeft -= managementBounds.width + gap;
      if (side === "top") nextTop += markerBounds.height + gap;
      if (side === "bottom") nextTop -= managementBounds.height + gap;
      if (side === "top" || side === "bottom") {
        nextLeft += (markerBounds.width - managementBounds.width) / 2;
      } else {
        nextTop += (markerBounds.height - managementBounds.height) / 2;
      }
      const maximumLeft = Math.max(inset, overlayBounds.width - inset - managementBounds.width);
      const maximumTop = Math.max(inset, overlayBounds.height - inset - managementBounds.height);
      setManagementPosition({
        left: Math.min(Math.max(nextLeft, inset), maximumLeft),
        top: Math.min(Math.max(nextTop, inset), maximumTop),
      });
    };

    updatePosition();
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(updatePosition) : null;
    resizeObserver?.observe(overlay);
    resizeObserver?.observe(management);
    window.addEventListener("resize", updatePosition);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [isSelected, left, side, top]);

  return (
    <>
      <div
        className="suppressed-connector-control"
        data-side={side}
        data-suppressed-connector-id={connectorId}
        onPointerDown={stopPointerPropagation}
        ref={markerContainerRef}
        style={{ left, top }}
      >
        <button
          aria-controls={isSelected ? managementId : undefined}
          aria-expanded={isSelected}
          aria-label={`${label} hidden because its bound objects overlap. Manage connector.`}
          aria-pressed={isSelected}
          className="suppressed-connector-marker"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M3 16 9 10M15 10l6-6M15 4h6v6" />
            <path className="suppressed-connector-icon-gap" d="m10.5 8.5 3 3" />
          </svg>
          <span aria-hidden="true">Hidden</span>
        </button>
      </div>
      {isSelected ? (
        <div
          aria-label={`${label} endpoint management`}
          className="suppressed-connector-management"
          id={managementId}
          onClick={stopPointerPropagation}
          onPointerDown={stopPointerPropagation}
          ref={managementRef}
          role="group"
          style={managementPosition}
        >
          <span className="suppressed-connector-management-status">{label} hidden</span>
          <button
            aria-label={`Manage ${label} start endpoint`}
            disabled={isLocked}
            onClick={(event) => onManageEndpoint("start", event.currentTarget)}
            type="button"
          >
            Start
          </button>
          <button
            aria-label={`Manage ${label} end endpoint`}
            disabled={isLocked}
            onClick={(event) => onManageEndpoint("end", event.currentTarget)}
            type="button"
          >
            End
          </button>
          <button
            aria-label={`Delete ${label}`}
            disabled={isLocked}
            onClick={onDelete}
            type="button"
          >
            Delete
          </button>
        </div>
      ) : null}
    </>
  );
}
