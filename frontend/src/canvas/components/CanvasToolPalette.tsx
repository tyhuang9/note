import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Circle, Diamond, Eraser, Hand, Highlighter, Image, LockKeyhole, MousePointer2, PenLine, RectangleHorizontal, Slash, SlidersHorizontal, Type } from "lucide-react";
import type { CanvasTool } from "../interaction/types";

type DrawingTool = CanvasTool | "text" | "image";

type CanvasToolPaletteProps = {
  activeTool: DrawingTool;
  isPropertiesPanelAvailable: boolean;
  isPropertiesPanelOpen: boolean;
  isToolLocked: boolean;
  onPropertiesPanelToggle: () => void;
  onToolLockChange: (locked: boolean) => void;
  onToolSelect: (tool: DrawingTool) => void;
};

const TOOLS = [
  { tool: "select", label: "Select", shortcut: "V / 1", Icon: MousePointer2 }, { tool: "hand", label: "Hand", shortcut: "Space", Icon: Hand }, { tool: "rectangle", label: "Rectangle", shortcut: "R / 2", Icon: RectangleHorizontal }, { tool: "diamond", label: "Diamond", shortcut: "D / 3", Icon: Diamond }, { tool: "ellipse", label: "Ellipse", shortcut: "O / 4", Icon: Circle }, { tool: "arrow", label: "Arrow", shortcut: "A / 5", Icon: ArrowRight }, { tool: "line", label: "Line", shortcut: "L / 6", Icon: Slash }, { tool: "pen", label: "Pen", shortcut: "P / 7", Icon: PenLine }, { tool: "text", label: "Text", shortcut: "T / 8", Icon: Type }, { tool: "image", label: "Image", shortcut: "I / 9", Icon: Image }, { tool: "eraser", label: "Eraser", shortcut: "E / 0", Icon: Eraser }, { tool: "highlighter", label: "Highlighter", shortcut: "H", Icon: Highlighter },
] as const satisfies ReadonlyArray<Readonly<{ tool: DrawingTool; label: string; shortcut: string; Icon: typeof MousePointer2 }>>;

type Tooltip = Readonly<{ label: string; owner: string; x: number; y: number }>;

/** Small, keyboard discoverable drawing-mode selector kept outside world transforms. */
export function CanvasToolPalette({ activeTool, isPropertiesPanelAvailable, isPropertiesPanelOpen, isToolLocked, onPropertiesPanelToggle, onToolLockChange, onToolSelect }: CanvasToolPaletteProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const propertiesToggleRef = useRef<HTMLButtonElement | null>(null);
  const previousPropertiesOpen = useRef(isPropertiesPanelOpen);
  const tooltipId = useId();
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [tabStop, setTabStop] = useState(() => Math.max(0, TOOLS.findIndex(({ tool }) => tool === activeTool)));
  const [isCompact, setIsCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches);
  const buttonCount = TOOLS.length + 1 + (isCompact && isPropertiesPanelAvailable ? 1 : 0);

  useEffect(() => {
    const activeIndex = TOOLS.findIndex(({ tool }) => tool === activeTool);
    if (activeIndex >= 0) setTabStop(activeIndex);
  }, [activeTool]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 899px)");
    const update = () => {
      setIsCompact(media.matches);
      if (!media.matches) setTabStop((current) => Math.min(current, TOOLS.length));
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isPropertiesPanelAvailable) setTabStop((current) => Math.min(current, TOOLS.length));
  }, [isPropertiesPanelAvailable]);

  useEffect(() => {
    const wasOpen = previousPropertiesOpen.current;
    previousPropertiesOpen.current = isPropertiesPanelOpen;
    if (!wasOpen || isPropertiesPanelOpen || !isCompact || !isPropertiesPanelAvailable) return;
    const frame = window.requestAnimationFrame(() => propertiesToggleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isCompact, isPropertiesPanelAvailable, isPropertiesPanelOpen]);

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % buttonCount;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + buttonCount) % buttonCount;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = buttonCount - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setTabStop(nextIndex);
    buttonRefs.current[nextIndex]?.focus();
  }

  function showTooltip(owner: string, label: string, button: HTMLButtonElement) {
    const bounds = button.getBoundingClientRect();
    setTooltip({
      label,
      owner,
      x: Math.max(96, Math.min(window.innerWidth - 96, bounds.left + bounds.width / 2)),
      y: bounds.bottom + 8,
    });
  }

  function hideTooltip(owner: string, button?: HTMLButtonElement) {
    if (button && document.activeElement === button) return;
    setTooltip((current) => current?.owner === owner ? null : current);
  }

  return (
    <>
      <div aria-label="Drawing tools" aria-orientation="horizontal" className="canvas-tool-palette" onScroll={() => setTooltip(null)} role="toolbar">
        {TOOLS.map(({ tool, label, shortcut, Icon }, index) => (
          <Fragment key={tool}>
            <button
              aria-describedby={tooltip?.owner === tool ? tooltipId : undefined}
              aria-label={`${label} (${shortcut})`}
              aria-pressed={activeTool === tool}
              data-tool={tool}
              onBlur={() => hideTooltip(tool)}
              onClick={() => { setTabStop(index); onToolSelect(tool); }}
              onFocus={(event) => { setTabStop(index); showTooltip(tool, `${label} · ${shortcut}`, event.currentTarget); }}
              onKeyDown={(event) => moveFocus(event, index)}
              onMouseEnter={(event) => showTooltip(tool, `${label} · ${shortcut}`, event.currentTarget)}
              onMouseLeave={(event) => hideTooltip(tool, event.currentTarget)}
              ref={(button) => { buttonRefs.current[index] = button; }}
              tabIndex={tabStop === index ? 0 : -1}
              title={`${label} (${shortcut})`}
              type="button"
            >
              <Icon aria-hidden="true" size={20} />
            </button>
            {index === 1 || index === TOOLS.length - 1 ? <span aria-hidden="true" className="canvas-tool-separator" /> : null}
          </Fragment>
        ))}
        <button
          aria-describedby={tooltip?.owner === "tool-lock" ? tooltipId : undefined}
          aria-label="Keep drawing tool active"
          aria-pressed={isToolLocked}
          data-tool-lock
          onBlur={() => hideTooltip("tool-lock")}
          onClick={() => { setTabStop(TOOLS.length); onToolLockChange(!isToolLocked); }}
          onFocus={(event) => { setTabStop(TOOLS.length); showTooltip("tool-lock", isToolLocked ? "Unlock drawing tool" : "Keep drawing tool active", event.currentTarget); }}
          onKeyDown={(event) => moveFocus(event, TOOLS.length)}
          onMouseEnter={(event) => showTooltip("tool-lock", isToolLocked ? "Unlock drawing tool" : "Keep drawing tool active", event.currentTarget)}
          onMouseLeave={(event) => hideTooltip("tool-lock", event.currentTarget)}
          ref={(button) => { buttonRefs.current[TOOLS.length] = button; }}
          tabIndex={tabStop === TOOLS.length ? 0 : -1}
          title={isToolLocked ? "Unlock drawing tool" : "Keep drawing tool active"}
          type="button"
        >
          <LockKeyhole aria-hidden="true" size={20} />
        </button>
        {isCompact && isPropertiesPanelAvailable ? <button
          aria-controls="drawing-properties-panel"
          aria-describedby={tooltip?.owner === "properties" ? tooltipId : undefined}
          aria-expanded={isPropertiesPanelOpen}
          aria-label="Drawing properties"
          aria-pressed={isPropertiesPanelOpen}
          className="canvas-properties-toggle"
          onBlur={() => hideTooltip("properties")}
          onClick={() => { setTabStop(TOOLS.length + 1); onPropertiesPanelToggle(); }}
          onFocus={(event) => { setTabStop(TOOLS.length + 1); showTooltip("properties", "Drawing properties", event.currentTarget); }}
          onKeyDown={(event) => moveFocus(event, TOOLS.length + 1)}
          onMouseEnter={(event) => showTooltip("properties", "Drawing properties", event.currentTarget)}
          onMouseLeave={(event) => hideTooltip("properties", event.currentTarget)}
          ref={(button) => { buttonRefs.current[TOOLS.length + 1] = button; propertiesToggleRef.current = button; }}
          tabIndex={tabStop === TOOLS.length + 1 ? 0 : -1}
          title="Drawing properties"
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" size={20} />
        </button> : null}
      </div>
      {tooltip && typeof document !== "undefined" ? createPortal(
        <div className="drawing-toolbar-tooltip" id={tooltipId} role="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.label}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
