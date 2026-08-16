import type { CanvasTool } from "../interaction/types";

type DrawingTool = CanvasTool | "text" | "image";

type CanvasToolPaletteProps = {
  activeTool: DrawingTool;
  isToolLocked: boolean;
  onToolLockChange: (locked: boolean) => void;
  onToolSelect: (tool: DrawingTool) => void;
};

const TOOLS: ReadonlyArray<Readonly<{ tool: DrawingTool; label: string; shortcut: string }>> = [
  { tool: "select", label: "Select", shortcut: "V / 1" },
  { tool: "hand", label: "Hand", shortcut: "Space" },
  { tool: "rectangle", label: "Rectangle", shortcut: "R / 2" },
  { tool: "diamond", label: "Diamond", shortcut: "D / 3" },
  { tool: "ellipse", label: "Ellipse", shortcut: "O / 4" },
  { tool: "arrow", label: "Arrow", shortcut: "A / 5" },
  { tool: "line", label: "Line", shortcut: "L / 6" },
  { tool: "pen", label: "Pen", shortcut: "P / 7" },
  { tool: "text", label: "Text", shortcut: "T / 8" },
  { tool: "image", label: "Image", shortcut: "I / 9" },
  { tool: "eraser", label: "Eraser", shortcut: "E / 0" },
  { tool: "highlighter", label: "Highlighter", shortcut: "H" },
];

/** Small, keyboard discoverable drawing-mode selector kept outside world transforms. */
export function CanvasToolPalette({ activeTool, isToolLocked, onToolLockChange, onToolSelect }: CanvasToolPaletteProps) {
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
      <button
        aria-label="Keep drawing tool active"
        aria-pressed={isToolLocked}
        data-tool-lock
        onClick={() => onToolLockChange(!isToolLocked)}
        title={isToolLocked ? "Unlock drawing tool" : "Keep drawing tool active"}
        type="button"
      >
        {isToolLocked ? "Locked" : "Lock"}
      </button>
    </div>
  );
}
