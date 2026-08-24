import { describe, expect, it } from "vitest";
import {
  canStartDirectTextEntry,
  getDefaultKeyboardTextCaretPoint,
  getDirectTextDraftRect,
} from "../../src/canvas/interaction/directTextEntry";
import {
  resolveDirectTextEntryHit,
  resolveDirectTextEntryHitForNativeEvent,
} from "../../src/canvas/interaction/useCanvasInteraction";
import type { CanvasElement, ImageElement, ShapeElement } from "../../src/canvas/model/elements";

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
      source: "keyboard" as const,
    };

    expect(canStartDirectTextEntry(available)).toBe(true);
    expect(canStartDirectTextEntry({ ...available, isModalOrOverlayOpen: true })).toBe(false);
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

  it("prioritizes a front hollow shape label over a lower filled shape", () => {
    const shape = (id: string, zIndex: number, fillColor: string | null): ShapeElement => ({
      createdAt: 1,
      height: 100,
      id,
      locked: false,
      opacity: 1,
      pageId: "page",
      rotation: 0,
      shape: "rectangle",
      style: {
        fillColor: fillColor ? { kind: "fixed", value: fillColor } : null,
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
      [shape("lower-filled", 10, "#fff"), shape("front-hollow-label", 20, null)],
      { x: 100, y: 50 },
    );

    expect(hit).toMatchObject({
      element: { id: "front-hollow-label" },
      kind: "editable",
    });
  });

  it("blocks editing when the front ordinary geometry belongs to a non-editable element", () => {
    const image: ImageElement = {
      assetId: "asset",
      createdAt: 1,
      fileName: "cover.png",
      fit: "contain",
      height: 100,
      id: "front-image",
      locked: false,
      naturalHeight: 100,
      naturalWidth: 200,
      opacity: 1,
      pageId: "page",
      rotation: 0,
      type: "image",
      updatedAt: 1,
      width: 200,
      x: 0,
      y: 0,
      zIndex: 20,
    };

    expect(resolveDirectTextEntryHit([image], { x: 100, y: 50 })).toEqual({ kind: "blocked" });
  });

  it("resolves a 5,000-element blank double click once across capture and bubble", () => {
    const elements: ShapeElement[] = Array.from({ length: 5_000 }, (_, index) => ({
      createdAt: 1,
      height: 20,
      id: `shape-${index}`,
      locked: false,
      opacity: 1,
      pageId: "page",
      rotation: 0,
      shape: "rectangle",
      style: {
        fillColor: null,
        roughness: 1,
        roundness: 0,
        seed: index,
        strokeColor: { kind: "fixed", value: "#000" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
      type: "shape",
      updatedAt: 1,
      width: 20,
      x: index * 25,
      y: 0,
      zIndex: index,
    }));
    const nativeDoubleClick = {};
    const point = { x: -100, y: -100 };
    let resolverTraversals = 0;
    const resolveHit = (scene: readonly CanvasElement[], hitPoint: typeof point) => {
      resolverTraversals += 1;
      return resolveDirectTextEntryHit(scene, hitPoint);
    };

    const startedAt = performance.now();
    const captureHit = resolveDirectTextEntryHitForNativeEvent(
      nativeDoubleClick,
      elements,
      point,
      resolveHit,
    );
    const bubbleHit = resolveDirectTextEntryHitForNativeEvent(
      nativeDoubleClick,
      elements,
      point,
      resolveHit,
    );
    const durationMs = performance.now() - startedAt;

    console.info(`5,000-element direct text event resolution: ${durationMs.toFixed(2)} ms`);
    expect(captureHit).toEqual({ kind: "blank" });
    expect(bubbleHit).toEqual({ kind: "blank" });
    expect(resolverTraversals).toBe(1);
    expect(Number.isFinite(durationMs)).toBe(true);
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
