import { describe, expect, it } from "vitest";
import {
  drawingToolAfterCreation,
  drawingToolForShortcut,
  screenSampleToWorld,
} from "../../src/canvas/interaction/useInkInteraction";
import { inkContainsPoint, pointToSegmentDistance } from "../../src/canvas/model/hitTesting";
import { PEN_BRUSH } from "../../src/canvas/model/ink";
import type { InkElement } from "../../src/canvas/model/elements";

describe("ink pointer normalization", () => {
  const viewport = {
    height: 800,
    left: 100,
    offsetHeight: 400,
    offsetWidth: 500,
    top: 50,
    width: 1_000,
  };

  it("maps transformed client coordinates into finite world coordinates", () => {
    expect(screenSampleToWorld({
      clientX: 300,
      clientY: 250,
      pointerType: "pen",
      pressure: 0.75,
    }, viewport, false)).toEqual({ x: 100, y: 100, pressure: 0.75 });
  });

  it("simulates mouse pressure and rejects invalid viewport samples", () => {
    expect(screenSampleToWorld({
      clientX: 300,
      clientY: 250,
      pointerType: "mouse",
      pressure: Number.NaN,
    }, viewport, true)?.pressure).toBe(0.5);
    expect(screenSampleToWorld({
      clientX: Number.POSITIVE_INFINITY,
      clientY: 250,
      pointerType: "pen",
      pressure: 0.5,
    }, viewport, true)).toBeNull();
    expect(screenSampleToWorld({
      clientX: 300,
      clientY: 250,
      pointerType: "pen",
      pressure: 0.5,
    }, { ...viewport, offsetWidth: 0 }, true)).toBeNull();
    expect(screenSampleToWorld({
      clientX: 300,
      clientY: 250,
      pointerType: "pen",
      pressure: 0.5,
    }, { ...viewport, left: Number.NaN }, true)).toBeNull();
  });
});

describe("drawing shortcuts", () => {
  it.each([
    ["v", "select"],
    ["1", "select"],
    ["r", "rectangle"],
    ["2", "rectangle"],
    ["d", "diamond"],
    ["3", "diamond"],
    ["o", "ellipse"],
    ["4", "ellipse"],
    ["a", "arrow"],
    ["5", "arrow"],
    ["l", "line"],
    ["6", "line"],
    ["P", "pen"],
    ["7", "pen"],
    ["t", "text"],
    ["8", "text"],
    ["i", "image"],
    ["9", "image"],
    ["h", "highlighter"],
    ["E", "eraser"],
    ["0", "eraser"],
    ["Escape", "select"],
  ] as const)("maps %s to %s", (key, tool) => {
    expect(drawingToolForShortcut({ altKey: false, ctrlKey: false, key, metaKey: false })).toBe(tool);
  });

  it("does not claim modified or unrelated shortcuts", () => {
    expect(drawingToolForShortcut({ altKey: false, ctrlKey: true, key: "p", metaKey: false })).toBeNull();
    expect(drawingToolForShortcut({ altKey: false, ctrlKey: false, key: "x", metaKey: false })).toBeNull();
    expect(drawingToolForShortcut({ altKey: false, ctrlKey: false, key: "p", metaKey: false }, false)).toBeNull();
  });

  it("returns creation tools to Select unless tool lock is active", () => {
    expect(drawingToolAfterCreation("rectangle", false)).toBe("select");
    expect(drawingToolAfterCreation("pen", false)).toBe("select");
    expect(drawingToolAfterCreation("text", false)).toBe("select");
    expect(drawingToolAfterCreation("image", false)).toBe("select");
    expect(drawingToolAfterCreation("highlighter", true)).toBe("highlighter");
    expect(drawingToolAfterCreation("arrow", true)).toBe("arrow");
  });
});

describe("painted ink hit testing", () => {
  const ink: InkElement = {
    brush: PEN_BRUSH,
    createdAt: 1,
    height: 30,
    id: "ink-1",
    locked: false,
    opacity: 1,
    pageId: "page-1",
    points: [[0, 0, 0.5], [50, 0, 0.5]],
    rotation: 0,
    type: "ink",
    updatedAt: 1,
    width: 50,
    x: 100,
    y: 100,
    zIndex: 1,
  };

  it("uses the rendered path rather than the ink bounding box", () => {
    expect(inkContainsPoint(ink, { x: 125, y: 103 }, 2)).toBe(true);
    expect(inkContainsPoint(ink, { x: 125, y: 120 }, 2)).toBe(false);
    expect(pointToSegmentDistance({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4);
  });

  it("early-rejects outside expanded bounds without walking points", () => {
    const points = new Proxy(ink.points, {
      get(target, property, receiver) {
        if (property === "0") throw new Error("point walk should be skipped");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(inkContainsPoint({ ...ink, points }, { x: -10_000, y: -10_000 }, 8)).toBe(false);
  });

  it("walks tuples directly without map or slice allocations", () => {
    const points = [...ink.points];
    Object.defineProperties(points, {
      map: { value: () => { throw new Error("map should not run"); } },
      slice: { value: () => { throw new Error("slice should not run"); } },
    });
    expect(inkContainsPoint({ ...ink, points }, { x: 125, y: 102 }, 2)).toBe(true);
  });
});
