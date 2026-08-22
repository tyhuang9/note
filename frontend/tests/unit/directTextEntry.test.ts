import { describe, expect, it } from "vitest";
import {
  canStartDirectTextEntry,
  getDefaultKeyboardTextCaretPoint,
  getDirectTextDraftRect,
} from "../../src/canvas/interaction/directTextEntry";
import { resolveDirectTextEntryHit } from "../../src/canvas/interaction/useCanvasInteraction";
import type { ShapeElement } from "../../src/canvas/model/elements";

describe("direct canvas text entry geometry", () => {
  it("keeps advertised keyboard entry aligned with modal and editor guards", () => {
    const available = {
      activeTool: "text",
      hasConnectorChooser: false,
      hasDirectDraft: false,
      hasPendingImage: false,
      isCanvasAuthoringAvailable: true,
      isEditingText: false,
      isModalOrOverlayOpen: false,
      isSearchOpen: false,
      source: "keyboard" as const,
    };

    expect(canStartDirectTextEntry(available)).toBe(true);
    expect(canStartDirectTextEntry({ ...available, isModalOrOverlayOpen: true })).toBe(false);
    expect(canStartDirectTextEntry({ ...available, isSearchOpen: true })).toBe(false);
    expect(canStartDirectTextEntry({ ...available, hasPendingImage: true })).toBe(false);
    expect(canStartDirectTextEntry({ ...available, source: "pointer" })).toBe(false);
    expect(canStartDirectTextEntry({ ...available, activeTool: "select", source: "pointer" })).toBe(true);
  });

  it("uses visual z-order for overlapping hollow shape text surfaces", () => {
    const shape = (id: string, zIndex: number): ShapeElement => ({
      createdAt: 1,
      height: 100,
      id,
      locked: false,
      opacity: 1,
      pageId: "page",
      rotation: 0,
      shape: "rectangle",
      style: {
        fillColor: null,
        roughness: 1,
        roundness: 0,
        seed: zIndex,
        strokeColor: { kind: "fixed", value: "#000" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
      text: { content: id },
      type: "shape",
      updatedAt: 1,
      width: 200,
      x: 0,
      y: 0,
      zIndex,
    });

    const hit = resolveDirectTextEntryHit(
      [shape("visual-front", 20), shape("source-last-back", 10)],
      { x: 100, y: 50 },
    );
    expect(hit).toMatchObject({
      element: { id: "visual-front" },
      kind: "editable",
    });
  });

  it("places the first caret exactly at the requested world point", () => {
    const point = { x: 125.5, y: -44.25 };
    const rect = getDirectTextDraftRect(point);

    expect(rect).toEqual({
      height: 54,
      width: 220,
      x: 114.5,
      y: -64.25,
    });
  });

  it("rejects unsafe pointer positions instead of clamping the click", () => {
    expect(getDirectTextDraftRect({ x: 1_000_000, y: 0 })).toBeNull();
    expect(getDirectTextDraftRect({ x: Number.NaN, y: 0 })).toBeNull();
  });

  it("centers keyboard entry and keeps near-edge defaults persistence-safe", () => {
    expect(getDefaultKeyboardTextCaretPoint({ x: -500, y: -300, width: 1_000, height: 600 }))
      .toEqual({ x: 0, y: 0 });

    const edgePoint = getDefaultKeyboardTextCaretPoint({
      x: 999_800,
      y: 999_800,
      width: 200,
      height: 200,
    });
    expect(edgePoint).not.toBeNull();
    expect(getDirectTextDraftRect(edgePoint!)).not.toBeNull();
  });

  it("rejects invalid or wholly unsafe keyboard viewports", () => {
    expect(getDefaultKeyboardTextCaretPoint({ x: 0, y: 0, width: 0, height: 100 })).toBeNull();
    expect(getDefaultKeyboardTextCaretPoint({ x: 1_000_001, y: 0, width: 100, height: 100 })).toBeNull();
  });
});
