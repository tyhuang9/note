import { describe, expect, it } from "vitest";
import {
  getOffscreenDirection,
  getSelectionRect,
  rectsIntersect,
} from "../../src/editorUtils";

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
