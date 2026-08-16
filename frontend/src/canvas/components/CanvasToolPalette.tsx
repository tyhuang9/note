import type { CanvasTool } from "../interaction/types";
import { ArrowRight, Circle, Diamond, Eraser, Hand, Highlighter, Image, LockKeyhole, MousePointer2, PenLine, RectangleHorizontal, Slash, Type } from "lucide-react";

type DrawingTool = CanvasTool | "text" | "image";

type CanvasToolPaletteProps = {
  activeTool: DrawingTool;
  isToolLocked: boolean;
  onToolLockChange: (locked: boolean) => void;
  onToolSelect: (tool: DrawingTool) => void;
};

const TOOLS = [
  { tool: "select", label: "Select", shortcut: "V / 1", Icon: MousePointer2 }, { tool: "hand", label: "Hand", shortcut: "Space", Icon: Hand }, { tool: "rectangle", label: "Rectangle", shortcut: "R / 2", Icon: RectangleHorizontal }, { tool: "diamond", label: "Diamond", shortcut: "D / 3", Icon: Diamond }, { tool: "ellipse", label: "Ellipse", shortcut: "O / 4", Icon: Circle }, { tool: "arrow", label: "Arrow", shortcut: "A / 5", Icon: ArrowRight }, { tool: "line", label: "Line", shortcut: "L / 6", Icon: Slash }, { tool: "pen", label: "Pen", shortcut: "P / 7", Icon: PenLine }, { tool: "text", label: "Text", shortcut: "T / 8", Icon: Type }, { tool: "image", label: "Image", shortcut: "I / 9", Icon: Image }, { tool: "eraser", label: "Eraser", shortcut: "E / 0", Icon: Eraser }, { tool: "highlighter", label: "Highlighter", shortcut: "H", Icon: Highlighter },
] as const satisfies ReadonlyArray<Readonly<{ tool: DrawingTool; label: string; shortcut: string; Icon: typeof MousePointer2 }>>;

/** Small, keyboard discoverable drawing-mode selector kept outside world transforms. */
export function CanvasToolPalette({ activeTool, isToolLocked, onToolLockChange, onToolSelect }: CanvasToolPaletteProps) {
  return (
    <div aria-label="Drawing tools" className="canvas-tool-palette" role="toolbar">
      {TOOLS.map(({ tool, label, shortcut, Icon }) => (
        <button
          aria-label={`${label} (${shortcut})`}
          aria-pressed={activeTool === tool}
          data-tool={tool}
          key={tool}
          onClick={() => onToolSelect(tool)}
          title={`${label} (${shortcut})`}
          type="button"
        >
          <Icon aria-hidden="true" size={20} />
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
        <LockKeyhole aria-hidden="true" size={20} />
      </button>
    </div>
  );
}
