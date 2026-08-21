import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ShapeAnchorName } from "../model/connectorBinding";

type ConnectorEndpointChooserProps = {
  anchorT: number;
  endpoint: "start" | "end";
  isBound: boolean;
  isDarkMode: boolean;
  onBind: (anchorT: number) => void;
  onClose: () => void;
  onDetach: () => void;
  onSelectTarget: (targetElementId: string) => void;
  targets: readonly Readonly<{ id: string; label: string; rotation: number }>[];
  targetElementId: string | null;
};

const CARDINAL_ANCHORS: readonly Readonly<{ name: ShapeAnchorName; label: string }>[] = [
  { name: "top", label: "Top" },
  { name: "right", label: "Right" },
  { name: "bottom", label: "Bottom" },
  { name: "left", label: "Left" },
];

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function targetRotationDescription(rotation: number): string {
  const roundedRotation = Math.round(rotation);
  return roundedRotation === 0 ? "" : `, target rotated ${roundedRotation} degrees`;
}

/** Keyboard-focused binding controls that intentionally complement visual-only anchors. */
export function ConnectorEndpointChooser({
  endpoint,
  anchorT,
  isBound,
  isDarkMode,
  onBind,
  onClose,
  onDetach,
  onSelectTarget,
  targets,
  targetElementId,
}: ConnectorEndpointChooserProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const [toolbarPosition, setToolbarPosition] = useState({ left: 0, top: 0 });
  const [anchorDegrees, setAnchorDegrees] = useState(Math.round(anchorT * 360) % 360);
  const selectedTarget = targets.find(({ id }) => id === targetElementId) ?? null;

  useEffect(() => setAnchorDegrees(Math.round(anchorT * 360) % 360), [anchorT]);

  useLayoutEffect(() => {
    function updateToolbarPosition() {
      const toolbar = document.querySelector<HTMLElement>(".canvas-tool-palette");
      if (!toolbar) {
        setToolbarPosition({ left: window.innerWidth / 2, top: 84 });
        return;
      }
      const bounds = toolbar.getBoundingClientRect();
      setToolbarPosition({
        left: bounds.left + bounds.width / 2,
        top: bounds.bottom + 12,
      });
    }

    updateToolbarPosition();
    window.addEventListener("resize", updateToolbarPosition);
    const toolbar = document.querySelector<HTMLElement>(".canvas-tool-palette");
    const observer = new ResizeObserver(updateToolbarPosition);
    if (toolbar) observer.observe(toolbar);
    return () => {
      window.removeEventListener("resize", updateToolbarPosition);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const root = document.getElementById("root");
    const rootWasInert = root?.hasAttribute("inert") ?? false;
    root?.setAttribute("inert", "");
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const selectedTargetButton = dialog?.querySelector<HTMLButtonElement>(
        '[data-connector-target][aria-pressed="true"]',
      );
      const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (selectedTargetButton ?? firstFocusable)?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (!rootWasInert) root?.removeAttribute("inert");
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getClientRects().length > 0);
      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      if (!firstFocusable || !lastFocusable) return;
      const activeElement = document.activeElement;
      if (!dialog.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastFocusable : firstFocusable).focus();
        return;
      }
      if (event.shiftKey && activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="connector-endpoint-chooser-layer" data-theme={isDarkMode ? "dark" : "light"}>
      <div
        aria-hidden="true"
        className="connector-endpoint-chooser-backdrop"
        onPointerDown={(event) => event.stopPropagation()}
      />
      <section
        aria-describedby="connector-endpoint-chooser-instructions"
        aria-labelledby="connector-endpoint-chooser-title"
        aria-modal="true"
        className="connector-endpoint-chooser"
        onPointerDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        style={{ left: toolbarPosition.left, top: toolbarPosition.top }}
      >
        <header className="connector-endpoint-chooser-header">
          <div>
            <h2 id="connector-endpoint-chooser-title">Choose {endpoint} endpoint target</h2>
            <p id="connector-endpoint-chooser-instructions">
              Choose a shape or text block, then a target-relative boundary position. Cardinal presets and the one-degree range rotate with the target. Bind commits the choice.
            </p>
          </div>
        </header>
        <div aria-label="Target element" className="connector-endpoint-chooser-group" role="group">
          {targets.map(({ id, label }) => (
            <button
              aria-pressed={id === targetElementId}
              data-connector-target
              key={id}
              onClick={() => onSelectTarget(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div aria-label="Cardinal anchor" className="connector-endpoint-chooser-group" role="group">
          {CARDINAL_ANCHORS.map(({ name, label }) => (
            <button
              aria-label={selectedTarget
                ? `${label} anchor on ${selectedTarget.label}${targetRotationDescription(selectedTarget.rotation)}`
                : `${label} anchor`}
              disabled={!selectedTarget}
              key={name}
              aria-pressed={anchorDegrees === CARDINAL_ANCHORS.findIndex((anchor) => anchor.name === name) * 90}
              onClick={() => setAnchorDegrees(CARDINAL_ANCHORS.findIndex((anchor) => anchor.name === name) * 90)}
              type="button"
            >
              {label} anchor
            </button>
          ))}
        </div>
        <label className="connector-endpoint-chooser-range" htmlFor="connector-boundary-position">
          Boundary position: {anchorDegrees} degrees{selectedTarget ? `${targetRotationDescription(selectedTarget.rotation)}` : ""}
          <input
            aria-label={selectedTarget ? `Target-relative boundary position on ${selectedTarget.label}${targetRotationDescription(selectedTarget.rotation)}` : "Target-relative boundary position"}
            aria-valuetext={selectedTarget
              ? `${anchorDegrees} degrees target-relative boundary position on ${selectedTarget.label}${targetRotationDescription(selectedTarget.rotation)}`
              : `${anchorDegrees} degrees target-relative boundary position; select a target`}
            disabled={!selectedTarget}
            id="connector-boundary-position"
            max="359"
            min="0"
            onChange={(event) => setAnchorDegrees(Number(event.target.value))}
            step="1"
            type="range"
            value={anchorDegrees}
          />
        </label>
        <div className="connector-endpoint-chooser-actions">
          <button disabled={!selectedTarget} onClick={() => onBind(anchorDegrees / 360)} type="button">Bind {endpoint} endpoint</button>
          <button disabled={!isBound} onClick={onDetach} type="button">Detach {endpoint} endpoint</button>
          <button aria-label="Close endpoint chooser" onClick={onClose} type="button">Close</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
