import type { CanvasTool } from "../interaction/types";

type DrawingTool = Extract<CanvasTool, "select" | "pen" | "highlighter" | "eraser">;

type CanvasToolPaletteProps = {
  activeTool: DrawingTool;
  onToolSelect: (tool: DrawingTool) => void;
};

const TOOLS: ReadonlyArray<Readonly<{ tool: DrawingTool; label: string; shortcut: string }>> = [
  { tool: "select", label: "Select", shortcut: "V" },
  { tool: "pen", label: "Pen", shortcut: "P" },
  { tool: "highlighter", label: "Highlighter", shortcut: "H" },
  { tool: "eraser", label: "Eraser", shortcut: "E" },
];

/** Small, keyboard discoverable drawing-mode selector kept outside world transforms. */
export function CanvasToolPalette({ activeTool, onToolSelect }: CanvasToolPaletteProps) {
  return (
    <div aria-label="Drawing tools" className="canvas-tool-palette" role="toolbar">
      {TOOLS.map(({ tool, label, shortcut }) => (
        <button
          aria-label={`${label} (${shortcut})`}
          aria-pressed={activeTool === tool}
          data-tool={tool}
          key={tool}
          onClick={() => onToolSelect(tool)}
          title={`${label} (${shortcut})`}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
