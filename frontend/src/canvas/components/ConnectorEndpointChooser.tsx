import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type ConnectorEndpointChooserProps = {
  endpoint: "start" | "end";
  isBound: boolean;
  isDarkMode: boolean;
  onBind: () => void;
  onClose: () => void;
  onDetach: () => void;
  onSelectTarget: (targetElementId: string) => void;
  targets: readonly Readonly<{ id: string; label: string }>[];
  targetElementId: string | null;
};

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Target-only keyboard binding controls with modal focus containment and restoration. */
export function ConnectorEndpointChooser({
  endpoint,
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
  const focusMovedInsideDialogRef = useRef(false);
  const [toolbarPosition, setToolbarPosition] = useState({ left: 0, top: 0 });
  const selectedTarget = targets.find(({ id }) => id === targetElementId) ?? null;

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
    function noteFocusMovedInsideDialog(event: FocusEvent) {
      if (event.target instanceof Node && dialogRef.current?.contains(event.target)) {
        focusMovedInsideDialogRef.current = true;
      }
    }

    document.addEventListener("focusin", noteFocusMovedInsideDialog, true);
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (focusMovedInsideDialogRef.current || dialog?.contains(document.activeElement)) return;
      const selectedTargetButton = dialog?.querySelector<HTMLButtonElement>(
        '[data-connector-target][aria-pressed="true"]',
      );
      const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (selectedTargetButton ?? firstFocusable)?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("focusin", noteFocusMovedInsideDialog, true);
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
              Choose one shape or text block. The connector automatically follows the nearest facing visible boundaries as objects change. Bind commits the target.
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
        <div className="connector-endpoint-chooser-actions">
          <button disabled={!selectedTarget} onClick={onBind} type="button">Bind {endpoint} endpoint</button>
          <button disabled={!isBound} onClick={onDetach} type="button">Detach {endpoint} endpoint</button>
          <button aria-label="Close endpoint chooser" onClick={onClose} type="button">Close</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
