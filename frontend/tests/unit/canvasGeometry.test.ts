import { describe, expect, it } from "vitest";
import { screenDeltaToWorld, screenRectToWorld, screenToWorld, screenToleranceToWorld, worldDeltaToScreen, worldRectToScreen, worldToScreen, zoomViewportAroundScreenPoint } from "../../src/canvas/model/geometry";

describe("canvas coordinate transforms", () => {
  for (const zoom of [0.5, 1, 2]) {
    it(`round-trips points and rectangles at ${zoom}x`, () => {
      const viewport = { origin: { x: 40, y: 70 }, pan: { x: -120, y: 35 }, zoom };
      const point = { x: 91, y: -42 };
      const rect = { x: -20, y: 15, width: 80, height: 30 };
      expect(screenToWorld(worldToScreen(point, viewport), viewport)).toEqual(point);
      expect(screenRectToWorld(worldRectToScreen(rect, viewport), viewport)).toEqual(rect);
    });
  }

  it("converts deltas independently of viewport origin and pan", () => {
    const viewport = { origin: { x: 100, y: 200 }, pan: { x: -50, y: 25 }, zoom: 2 };
    expect(screenDeltaToWorld({ x: 24, y: -10 }, viewport)).toEqual({ x: 12, y: -5 });
    expect(worldDeltaToScreen({ x: 12, y: -5 }, viewport)).toEqual({ x: 24, y: -10 });
  });

  it("preserves the world point under a zoomed screen point", () => {
    const viewport = { origin: { x: 50, y: 100 }, pan: { x: -20, y: 30 }, zoom: 1 };
    const screen = { x: 190, y: 260 };
    const zoomed = zoomViewportAroundScreenPoint(viewport, screen, 2);
    expect(screenToWorld(screen, zoomed)).toEqual(screenToWorld(screen, viewport));
    expect(screenToleranceToWorld(12, zoomed)).toBe(6);
  });
});
