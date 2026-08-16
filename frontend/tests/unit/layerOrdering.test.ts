import { describe, expect, it } from "vitest";
import type { TextElement } from "../../src/canvas/model/elements";
import { reorderLayers } from "../../src/canvas/model/layerOrdering";

function text(id: string, zIndex: number, pageId = "page", locked = false): TextElement {
  return { content: id, createdAt: 1, height: 20, id, locked, opacity: 1, pageId, rotation: 0, type: "text", updatedAt: 1, width: 20, x: 0, y: 0, zIndex };
}

function order(elements: readonly TextElement[], pageId = "page") {
  return elements.filter((element) => element.pageId === pageId).sort((a, b) => a.zIndex - b.zIndex).map((element) => element.id);
}

describe("layer ordering", () => {
  it("moves a multi-selection forward one layer while preserving its order", () => {
    const elements = [text("a", 0), text("b", 1), text("c", 2), text("d", 3)];
    const updated = reorderLayers(elements, new Set(["a", "b"]), "bring-forward", 10) as TextElement[];
    expect(order(updated)).toEqual(["c", "a", "b", "d"]);
    expect(updated.map((element) => element.zIndex).sort()).toEqual([0, 1, 2, 3]);
  });

  it("sends a selection to the back independently per page", () => {
    const elements = [text("a", 8), text("b", 20), text("other", 4, "other")];
    const updated = reorderLayers(elements, new Set(["b", "other"]), "send-to-back", 10) as TextElement[];
    expect(order(updated)).toEqual(["b", "a"]);
    expect(order(updated, "other")).toEqual(["other"]);
    expect(updated.find((element) => element.id === "other")?.zIndex).toBe(0);
  });

  it("does not move a locked selected element but still normalizes sparse z-indices", () => {
    const elements = [text("a", 5), text("locked", 9, "page", true), text("c", 22)];
    const updated = reorderLayers(elements, new Set(["locked"]), "bring-to-front", 10) as TextElement[];
    expect(order(updated)).toEqual(["a", "locked", "c"]);
    expect(updated.map((element) => element.zIndex)).toEqual([0, 1, 2]);
  });
});

