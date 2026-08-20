import { describe, expect, it } from "vitest";
import {
  getOffscreenDirection,
  getSelectionRect,
  hasCanvasToolShortcutContext,
  rectsIntersect,
} from "../../src/editorUtils";

const canvasShortcutContext = {
  activeElement: null,
  canvasElement: {} as HTMLElement,
  hasCanvasKeyboardOwnership: true,
  isCanvasAuthoringAvailable: true,
  isModalOrOverlayOpen: false,
  isTextEditing: false,
  target: null,
};

const shortcutEvent = (overrides: Partial<KeyboardEvent> = {}) => ({
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  key: "r",
  metaKey: false,
  repeat: false,
  ...overrides,
}) as KeyboardEvent;

describe("getSelectionRect", () => {
  it("normalizes a selection dragged in either direction", () => {
    expect(
      getSelectionRect({
        currentX: 20,
        currentY: 15,
        didMove: true,
        startX: 80,
        startY: 55,
      }),
    ).toEqual({ x: 20, y: 15, width: 60, height: 40 });
  });
});

describe("rectsIntersect", () => {
  it("requires a meaningful overlapping area", () => {
    const first = { height: 20, width: 20, x: 0, y: 0 };

    expect(rectsIntersect(first, { height: 20, width: 20, x: 10, y: 10 })).toBe(
      true,
    );
    expect(rectsIntersect(first, { height: 4, width: 4, x: 18, y: 18 })).toBe(
      false,
    );
    expect(rectsIntersect(first, { height: 20, width: 20, x: 20, y: 0 })).toBe(
      false,
    );
  });
});

describe("getOffscreenDirection", () => {
  const viewport = { height: 100, width: 100, x: 0, y: 0 };

  it("returns null for visible blocks and compass directions for offscreen blocks", () => {
    expect(
      getOffscreenDirection(
        { height: 20, width: 20, x: 40, y: 40 },
        viewport,
      ),
    ).toBeNull();
    expect(
      getOffscreenDirection(
        { height: 20, width: 20, x: 140, y: -60 },
        viewport,
      ),
    ).toBe("ne");
    expect(
      getOffscreenDirection(
        { height: 20, width: 20, x: -140, y: 40 },
        viewport,
      ),
    ).toBe("w");
  });
});

describe("hasCanvasToolShortcutContext", () => {
  it("allows bare shortcuts after the canvas owns the keyboard", () => {
    expect(hasCanvasToolShortcutContext(shortcutEvent(), canvasShortcutContext)).toBe(true);
  });

  it.each([
    ["there is no live authoring canvas", { isCanvasAuthoringAvailable: false }],
    ["a modal or overlay is open", { isModalOrOverlayOpen: true }],
    ["a text block is editing", { isTextEditing: true }],
    ["the key repeats", {}, { repeat: true }],
    ["the IME is composing", {}, { isComposing: true }],
    ["the browser shortcut has a modifier", {}, { ctrlKey: true }],
  ] as const)("rejects shortcuts when %s", (
    _reason: string,
    contextOverrides: Partial<typeof canvasShortcutContext>,
    eventOverrides: Partial<KeyboardEvent> = {},
  ) => {
    expect(hasCanvasToolShortcutContext(
      shortcutEvent(eventOverrides),
      { ...canvasShortcutContext, ...contextOverrides },
    )).toBe(false);
  });

  it("requires canvas ownership when the event is outside canvas DOM", () => {
    expect(hasCanvasToolShortcutContext(shortcutEvent(), {
      ...canvasShortcutContext,
      hasCanvasKeyboardOwnership: false,
    })).toBe(false);
  });
});
