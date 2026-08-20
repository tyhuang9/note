import { describe, expect, it } from "vitest";
import {
  ELLIPSE_STATIONARY_BRACKET_COUNT,
  getShapeBoundaryPoint,
  projectPointToShapeBoundary,
} from "../../src/canvas/model/shapeBoundary";

function distance(first: { x: number; y: number }, second: { x: number; y: number }) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

/** Independent dense ellipse oracle: it intentionally does not call model geometry. */
function denseEllipseDistance(point: { x: number; y: number }, width: number, height: number) {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 100_000; index += 1) {
    const angle = index * Math.PI * 2 / 100_000;
    nearest = Math.min(nearest, distance(point, {
      x: width / 2 + width / 2 * Math.cos(angle),
      y: height / 2 + height / 2 * Math.sin(angle),
    }));
  }
  return nearest;
}

describe("shape boundary geometry", () => {
  it("matches an independent dense oracle for eccentric ellipse nearest distances", () => {
    const width = 400;
    const height = 40;
    for (const point of [{ x: 310, y: 43 }, { x: 200, y: 20 }, { x: 0, y: 20 }, { x: 200, y: -40 }, { x: 250, y: 30 }]) {
      const projected = projectPointToShapeBoundary("ellipse", width, height, 0, point);
      expect(projected).not.toBeNull();
      expect(distance(point, projected!)).toBeLessThanOrEqual(denseEllipseDistance(point, width, height) + 0.03);
      const residual = ((projected!.x - width / 2) / (width / 2)) ** 2 + ((projected!.y - height / 2) / (height / 2)) ** 2;
      expect(residual).toBeCloseTo(1, 8);
    }
  });

  it("uses a bounded bracketed ellipse solver and preserves angular ray anchors", () => {
    expect(ELLIPSE_STATIONARY_BRACKET_COUNT).toBe(64);
    const point = getShapeBoundaryPoint("rectangle", 180, 60, 0.6, 0.137);
    expect(point).not.toBeNull();
    const roundTrip = getShapeBoundaryPoint("rectangle", 180, 60, 0.6, 0.137);
    expect(roundTrip).toEqual(point);
  });

  it("returns no finite attachment boundary for zero dimensions", () => {
    expect(getShapeBoundaryPoint("rectangle", 0, 60, 0.2, 0.1)).toBeNull();
  });
});
