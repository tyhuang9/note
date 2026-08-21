import { describe, expect, it } from "vitest";
import {
  containsPointInsideShapeBoundary,
  containsPointInsideShapeBoundaryFast,
  ELLIPSE_STATIONARY_BRACKET_COUNT,
  getShapeBoundaryPoint,
  projectPointToShapeBoundary,
  roundedDiamondPath,
  roundedRectanglePath,
} from "../../src/canvas/model/shapeBoundary";

type Point = { x: number; y: number };
type Shape = "rectangle" | "diamond";
type ExpectedSegment =
  | { kind: "line"; start: Point; end: Point }
  | { kind: "quadratic"; start: Point; control: Point; end: Point };
type ExpectedSegmentDefinition =
  | { kind: "line"; end: Point }
  | { kind: "quadratic"; control: Point; end: Point };

const MIN_EXPECTED_ROUNDNESS = 0.06;
const EXPECTED_DIAMOND_INSET = 0.08;

function distance(first: Point, second: Point) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function expectedRoundedRectangleSegments(width: number, height: number, roundness: number): ExpectedSegment[] {
  const radius = Math.min(width, height) * Math.max(MIN_EXPECTED_ROUNDNESS, Math.min(1, roundness)) / 2;
  return chainExpectedSegments([
    { kind: "line", end: { x: width - radius, y: 0 } },
    { kind: "quadratic", control: { x: width, y: 0 }, end: { x: width, y: radius } },
    { kind: "line", end: { x: width, y: height - radius } },
    { kind: "quadratic", control: { x: width, y: height }, end: { x: width - radius, y: height } },
    { kind: "line", end: { x: radius, y: height } },
    { kind: "quadratic", control: { x: 0, y: height }, end: { x: 0, y: height - radius } },
    { kind: "line", end: { x: 0, y: radius } },
    { kind: "quadratic", control: { x: 0, y: 0 }, end: { x: radius, y: 0 } },
  ], { x: radius, y: 0 });
}

function expectedDiamondSegments(width: number, height: number): ExpectedSegment[] {
  const cornerInset = Math.min(width, height) * EXPECTED_DIAMOND_INSET;
  const diagonal = Math.max(1, Math.hypot(width, height));
  const centerX = width / 2;
  const centerY = height / 2;
  const horizontalInset = cornerInset * width / diagonal;
  const verticalInset = cornerInset * height / diagonal;

  return chainExpectedSegments([
    { kind: "quadratic", control: { x: centerX, y: 0 }, end: { x: centerX + horizontalInset, y: verticalInset } },
    { kind: "line", end: { x: width - horizontalInset, y: centerY - verticalInset } },
    { kind: "quadratic", control: { x: width, y: centerY }, end: { x: width - horizontalInset, y: centerY + verticalInset } },
    { kind: "line", end: { x: centerX + horizontalInset, y: height - verticalInset } },
    { kind: "quadratic", control: { x: centerX, y: height }, end: { x: centerX - horizontalInset, y: height - verticalInset } },
    { kind: "line", end: { x: horizontalInset, y: centerY + verticalInset } },
    { kind: "quadratic", control: { x: 0, y: centerY }, end: { x: horizontalInset, y: centerY - verticalInset } },
    { kind: "line", end: { x: centerX - horizontalInset, y: verticalInset } },
  ], { x: centerX - horizontalInset, y: verticalInset });
}

function chainExpectedSegments(
  segments: readonly ExpectedSegmentDefinition[],
  start: Point,
): ExpectedSegment[] {
  const result: ExpectedSegment[] = [];
  let current = start;
  for (const segment of segments) {
    const complete = { ...segment, start: current } as ExpectedSegment;
    result.push(complete);
    current = segment.end;
  }
  return result;
}

function expectedSegments(shape: Shape, width: number, height: number, roundness: number) {
  return shape === "rectangle"
    ? expectedRoundedRectangleSegments(width, height, roundness)
    : expectedDiamondSegments(width, height);
}

/** Parse the clean path syntax independently from the model's segment builder. */
function parseBoundaryPath(path: string): ExpectedSegment[] {
  const tokens = path.match(/[MLQZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? [];
  let index = 0;
  const command = () => tokens[index++];
  const number = () => Number(tokens[index++]);
  if (command() !== "M") throw new Error(`Expected M in ${path}`);
  let current = { x: number(), y: number() };
  const result: ExpectedSegment[] = [];
  while (index < tokens.length) {
    const next = command();
    if (next === "Z") break;
    if (next === "L") {
      const end = { x: number(), y: number() };
      result.push({ kind: "line", start: current, end });
      current = end;
      continue;
    }
    if (next === "Q") {
      const control = { x: number(), y: number() };
      const end = { x: number(), y: number() };
      result.push({ kind: "quadratic", start: current, control, end });
      current = end;
      continue;
    }
    throw new Error(`Unexpected path command ${next}`);
  }
  return result;
}

function expectSegmentsClose(actual: ExpectedSegment[], expected: ExpectedSegment[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((segment, index) => {
    const target = expected[index];
    expect(segment.kind).toBe(target.kind);
    expect(segment.start.x).toBeCloseTo(target.start.x, 12);
    expect(segment.start.y).toBeCloseTo(target.start.y, 12);
    expect(segment.end.x).toBeCloseTo(target.end.x, 12);
    expect(segment.end.y).toBeCloseTo(target.end.y, 12);
    if (segment.kind === "quadratic" && target.kind === "quadratic") {
      expect(segment.control.x).toBeCloseTo(target.control.x, 12);
      expect(segment.control.y).toBeCloseTo(target.control.y, 12);
    }
  });
}

function quadraticPoint(segment: Extract<ExpectedSegment, { kind: "quadratic" }>, ratio: number): Point {
  const reverse = 1 - ratio;
  return {
    x: reverse * reverse * segment.start.x + 2 * reverse * ratio * segment.control.x + ratio * ratio * segment.end.x,
    y: reverse * reverse * segment.start.y + 2 * reverse * ratio * segment.control.y + ratio * ratio * segment.end.y,
  };
}

function closestPointOnLine(point: Point, segment: Extract<ExpectedSegment, { kind: "line" }>): Point {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const size = dx * dx + dy * dy;
  const ratio = size === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / size));
  return { x: segment.start.x + dx * ratio, y: segment.start.y + dy * ratio };
}

/** Dense independent Q oracle; it deliberately does not call model projection. */
function denseBoundaryDistance(point: Point, segments: readonly ExpectedSegment[]) {
  let nearest = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    if (segment.kind === "line") {
      nearest = Math.min(nearest, distance(point, closestPointOnLine(point, segment)));
      continue;
    }
    for (let index = 0; index <= 8_000; index += 1) {
      nearest = Math.min(nearest, distance(point, quadraticPoint(segment, index / 8_000)));
    }
  }
  return nearest;
}

/** Independent angular intersection against the expected line/Q segments. */
function expectedRayIntersection(center: Point, direction: Point, segments: readonly ExpectedSegment[]) {
  let nearest: Point | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    const candidates = segment.kind === "line"
      ? [rayLineIntersection(center, direction, segment)]
      : rayQuadraticIntersections(center, direction, segment);
    for (const candidate of candidates) {
      if (candidate && distance(center, candidate) < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance(center, candidate);
      }
    }
  }
  return nearest;
}

function cross(first: Point, second: Point) {
  return first.x * second.y - first.y * second.x;
}

function rayLineIntersection(center: Point, direction: Point, segment: Extract<ExpectedSegment, { kind: "line" }>) {
  const edge = { x: segment.end.x - segment.start.x, y: segment.end.y - segment.start.y };
  const denominator = cross(direction, edge);
  if (Math.abs(denominator) < 1e-12) return null;
  const delta = { x: segment.start.x - center.x, y: segment.start.y - center.y };
  const ray = cross(delta, edge) / denominator;
  const segmentRatio = cross(delta, direction) / denominator;
  return ray >= 0 && segmentRatio >= -1e-12 && segmentRatio <= 1 + 1e-12
    ? { x: center.x + direction.x * ray, y: center.y + direction.y * ray }
    : null;
}

function rayQuadraticIntersections(
  center: Point,
  direction: Point,
  segment: Extract<ExpectedSegment, { kind: "quadratic" }>,
) {
  const a = {
    x: segment.start.x - 2 * segment.control.x + segment.end.x,
    y: segment.start.y - 2 * segment.control.y + segment.end.y,
  };
  const b = {
    x: 2 * (segment.control.x - segment.start.x),
    y: 2 * (segment.control.y - segment.start.y),
  };
  const c = { x: segment.start.x - center.x, y: segment.start.y - center.y };
  const roots = quadraticRoots(cross(a, direction), cross(b, direction), cross(c, direction));
  return roots
    .filter((ratio) => ratio >= -1e-12 && ratio <= 1 + 1e-12)
    .map((ratio) => quadraticPoint(segment, ratio))
    .filter((point) => (point.x - center.x) * direction.x + (point.y - center.y) * direction.y >= -1e-12);
}

function quadraticRoots(a: number, b: number, c: number) {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -1e-12) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

/** Independent dense ellipse oracle: it intentionally does not call model geometry. */
function denseEllipseDistance(point: Point, width: number, height: number) {
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

function angularParameter(point: Point, center: Point) {
  const angle = Math.atan2(point.x - center.x, -(point.y - center.y));
  return (angle < 0 ? angle + Math.PI * 2 : angle) / (Math.PI * 2);
}

describe("shape boundary geometry", () => {
  it("matches independently expected clean quadratic paths for rounded rectangles and diamonds", () => {
    const rectangle = parseBoundaryPath(roundedRectanglePath(180, 60, 0.6));
    expectSegmentsClose(rectangle, expectedRoundedRectangleSegments(180, 60, 0.6));

    const diamond = parseBoundaryPath(roundedDiamondPath(160, 100));
    expectSegmentsClose(diamond, expectedDiamondSegments(160, 100));
  });

  it("returns known ray intersections on rounded quadratic corners", () => {
    const rectangleT = 0.22;
    const rectangle = getShapeBoundaryPoint("rectangle", 180, 60, 0.6, rectangleT);
    const expectedRectangle = expectedRayIntersection(
      { x: 90, y: 30 },
      { x: Math.sin(rectangleT * Math.PI * 2), y: -Math.cos(rectangleT * Math.PI * 2) },
      expectedRoundedRectangleSegments(180, 60, 0.6),
    );
    expect(rectangle).not.toBeNull();
    expect(expectedRectangle).not.toBeNull();
    expect(rectangle!.x).toBeCloseTo(179.57839329894335, 9);
    expect(rectangle!.y).toBeCloseTo(12.91200757987925, 9);
    expect(distance(rectangle!, expectedRectangle!)).toBeLessThan(1e-9);

    const diamondT = 0.245;
    const diamond = getShapeBoundaryPoint("diamond", 160, 100, 0, diamondT);
    expect(diamond).not.toBeNull();
    expect(diamond!.x).toBeCloseTo(155.54455715540996, 9);
    expect(diamond!.y).toBeCloseTo(47.625916648706934, 9);
  });

  it("matches a dense independent Q oracle for rectangle and diamond nearest distances", () => {
    const cases: { shape: Shape; width: number; height: number; roundness: number; points: Point[] }[] = [
      {
        shape: "rectangle",
        width: 180,
        height: 60,
        roundness: 0.6,
        points: [{ x: 172, y: 8 }, { x: 90, y: 0 }, { x: 90, y: 30 }, { x: 210, y: 80 }, { x: 5, y: 56 }],
      },
      {
        shape: "diamond",
        width: 160,
        height: 100,
        roundness: 0,
        points: [{ x: 157, y: 48 }, { x: 80, y: 0 }, { x: 80, y: 50 }, { x: 185, y: 88 }, { x: 9, y: 45 }],
      },
    ];
    for (const testCase of cases) {
      const segments = expectedSegments(testCase.shape, testCase.width, testCase.height, testCase.roundness);
      for (const point of testCase.points) {
        const projected = projectPointToShapeBoundary(testCase.shape, testCase.width, testCase.height, testCase.roundness, point);
        expect(projected).not.toBeNull();
        expect(distance(point, projected!)).toBeLessThanOrEqual(denseBoundaryDistance(point, segments) + 0.02);
        expect(denseBoundaryDistance(projected!, segments)).toBeLessThan(0.02);
      }
    }
  });

  it.each([
    ["rectangle", 180, 60, 0.6],
    ["diamond", 160, 100, 0],
  ] as const)("round-trips forward and nearest boundary points for %s", (shape, width, height, roundness) => {
    const center = { x: width / 2, y: height / 2 };
    for (const t of [0, 0.032, 0.137, 0.22, 0.25, 0.493, 0.71, 0.999]) {
      const forward = getShapeBoundaryPoint(shape, width, height, roundness, t);
      expect(forward).not.toBeNull();
      const projected = projectPointToShapeBoundary(shape, width, height, roundness, forward!);
      expect(projected).not.toBeNull();
      expect(distance(projected!, forward!)).toBeLessThan(1e-8);
      const recovered = getShapeBoundaryPoint(shape, width, height, roundness, angularParameter(projected!, center));
      expect(recovered).not.toBeNull();
      expect(distance(recovered!, forward!)).toBeLessThan(1e-8);
    }
  });

  it("matches the visible boundary at every cardinal ray", () => {
    for (const [shape, width, height, roundness] of [["rectangle", 180, 60, 0.6], ["diamond", 160, 100, 0]] as const) {
      const center = { x: width / 2, y: height / 2 };
      const segments = expectedSegments(shape, width, height, roundness);
      for (const t of [0, 0.25, 0.5, 0.75]) {
        const radians = t * Math.PI * 2;
        const expected = expectedRayIntersection(center, {
          x: Math.sin(radians),
          y: -Math.cos(radians),
        }, segments);
        const actual = getShapeBoundaryPoint(shape, width, height, roundness, t);
        expect(actual).not.toBeNull();
        expect(expected).not.toBeNull();
        expect(actual!.x).toBeCloseTo(expected!.x, 12);
        expect(actual!.y).toBeCloseTo(expected!.y, 12);
      }
    }
  });

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

  it("uses a bounded bracketed ellipse solver", () => {
    expect(ELLIPSE_STATIONARY_BRACKET_COUNT).toBe(64);
  });

  it("keeps the allocation-free containment predicate exactly aligned with the shared perimeter", () => {
    for (const [shape, width, height, roundness] of [
      ["rectangle", 180, 60, 0],
      ["rectangle", 180, 60, 0.6],
      ["rectangle", 60, 180, 1],
      ["diamond", 160, 100, 0],
      ["diamond", 100, 160, 0],
      ["ellipse", 160, 100, 0],
    ] as const) {
      for (let x = -12; x <= width + 12; x += 3) {
        for (let y = -12; y <= height + 12; y += 3) {
          expect(containsPointInsideShapeBoundaryFast(shape, width, height, roundness, x, y)).toBe(
            containsPointInsideShapeBoundary(shape, width, height, roundness, { x, y }),
          );
        }
      }
    }
  });

  it("normalizes path dimensions and rejects degenerate public boundaries", () => {
    expect(roundedRectanglePath(0, -10, -2)).toBe(roundedRectanglePath(1, 1, 0));
    expect(roundedDiamondPath(0, -10)).toBe(roundedDiamondPath(1, 1));
    for (const shape of ["rectangle", "ellipse", "diamond"] as const) {
      expect(getShapeBoundaryPoint(shape, 0, 60, 0.2, 0.1)).toBeNull();
      expect(getShapeBoundaryPoint(shape, -10, 60, 0.2, 0.1)).toBeNull();
      expect(projectPointToShapeBoundary(shape, 0, 60, 0.2, { x: 10, y: 10 })).toBeNull();
      expect(projectPointToShapeBoundary(shape, -10, 60, 0.2, { x: 10, y: 10 })).toBeNull();
    }
  });
});
