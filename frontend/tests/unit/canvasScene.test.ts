import { describe, expect, it } from "vitest";
import type { ImageElement, TextElement } from "../../src/canvas/model/elements";
import { isBoxCanvasElement } from "../../src/canvas/model/elements";
import { getMarqueeElementIds, getTopmostElementAtPoint } from "../../src/canvas/model/hitTesting";
import { emptySceneHistory, executeSceneCommand, redoSceneCommand, undoSceneCommand } from "../../src/canvas/state/history";
import { createSceneState, reduceScene } from "../../src/canvas/state/scene";

function text(id: string, overrides: Partial<TextElement> = {}): TextElement {
  return { id, pageId: "page", type: "text", zIndex: 0, opacity: 1, locked: false, createdAt: 1, updatedAt: 1, x: 0, y: 0, width: 20, height: 20, rotation: 0, backgroundMode: "surface", content: id, ...overrides };
}

function xOf(element: Parameters<typeof isBoxCanvasElement>[0]): number {
  if (!isBoxCanvasElement(element)) throw new Error("expected a box element");
  return element.x;
}

function image(id: string, overrides: Partial<ImageElement> = {}): ImageElement {
  return { id, pageId: "page", type: "image", zIndex: 0, opacity: 1, locked: false, createdAt: 1, updatedAt: 1, x: 15, y: 15, width: 20, height: 20, rotation: 0, assetId: "asset", naturalWidth: 20, naturalHeight: 20, fit: "contain", ...overrides };
}

describe("scene state", () => {
  it("initializes deterministic z-order and supports selection plus interaction", () => {
    const state = createSceneState([text("first"), text("second")]);
    expect(state.orderedElementIds).toEqual(["first", "second"]);
    const selected = reduceScene(state, { type: "select-replace", elementIds: ["second", "missing", "second"] });
    expect(selected.selectedElementIds).toEqual(["second"]);
    expect(reduceScene(selected, { type: "select-toggle", elementId: "first" }).selectedElementIds).toEqual(["second", "first"]);
    expect(reduceScene(selected, { type: "set-interaction", interaction: { kind: "marquee", pointerId: 1, startWorld: { x: 0, y: 0 }, currentWorld: { x: 1, y: 1 }, additive: false } }).interaction.kind).toBe("marquee");
  });

  it("adds, updates, removes, batches, and replaces elements", () => {
    let state = createSceneState([text("one")]);
    state = reduceScene(state, { type: "command", command: { type: "batch", commands: [
      { type: "add-elements", elements: [text("two")] },
      { type: "update-elements", elements: [text("one", { x: 50 })] },
    ] } });
    expect(state.orderedElementIds).toEqual(["one", "two"]);
    expect(xOf(state.elementsById.one)).toBe(50);
    state = reduceScene(state, { type: "command", command: { type: "remove-elements", elementIds: ["one"] } });
    expect(state.orderedElementIds).toEqual(["two"]);
    state = reduceScene({ ...state, selectedElementIds: ["two"], interaction: { kind: "panning", pointerId: 1, startScreen: { x: 0, y: 0 }, startPan: { x: 0, y: 0 } } }, { type: "replace-elements", elements: [text("three")] });
    expect(state.selectedElementIds).toEqual([]);
    expect(state.interaction).toEqual({ kind: "idle" });
  });

  it("records one history entry per command and restores it with undo/redo", () => {
    let state = createSceneState([text("one")]);
    let history = emptySceneHistory();
    ({ state, history } = executeSceneCommand(state, history, { type: "batch", commands: [
      { type: "add-elements", elements: [text("two")] },
      { type: "update-elements", elements: [text("one", { x: 10 })] },
    ] }));
    expect(history.past).toHaveLength(1);
    expect(xOf(state.elementsById.one)).toBe(10);
    ({ state, history } = undoSceneCommand(state, history));
    expect(state.orderedElementIds).toEqual(["one"]);
    expect(xOf(state.elementsById.one)).toBe(0);
    ({ state } = redoSceneCommand(state, history));
    expect(xOf(state.elementsById.one)).toBe(10);
  });

  it("allows selecting locked elements but not mutating or deleting them", () => {
    const locked = text("locked", { locked: true });
    let state = reduceScene(createSceneState([locked]), { type: "select-replace", elementIds: ["locked"] });
    state = reduceScene(state, { type: "command", command: { type: "update-elements", elements: [text("locked", { x: 9, locked: true })] } });
    expect(state.selectedElementIds).toEqual(["locked"]);
    expect(xOf(state.elementsById.locked)).toBe(0);
    state = reduceScene(state, { type: "command", command: { type: "remove-elements", elementIds: ["locked"] } });
    expect(state.elementsById.locked).toBeDefined();
  });
});

describe("generic hit testing", () => {
  it("returns topmost elements and supports containing/intersecting mixed marquee", () => {
    const elements = { text: text("text", { x: 0, y: 0, width: 20, height: 20 }), image: image("image") };
    const ordered = ["text", "image"];
    expect(getTopmostElementAtPoint(elements, ordered, { x: 18, y: 18 })?.id).toBe("image");
    expect(getMarqueeElementIds(elements, ordered, { x: 0, y: 0, width: 25, height: 25 }, "contain")).toEqual(["text"]);
    expect(getMarqueeElementIds(elements, ordered, { x: 0, y: 0, width: 25, height: 25 }, "intersect")).toEqual(["text", "image"]);
  });
});
