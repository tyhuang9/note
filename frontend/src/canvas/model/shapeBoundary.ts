import type { CanvasPoint } from "./geometry";

type ShapeBoundaryKind = "rectangle" | "ellipse" | "diamond";

const MIN_VISUAL_RECTANGLE_ROUNDNESS = 0.06;
const DIAMOND_CORNER_INSET = 0.08;
const ROOT_TOLERANCE = 1e-10;
/** Fixed global bracket count; each bracket uses at most 52 bisection steps. */
export const ELLIPSE_STATIONARY_BRACKET_COUNT = 64;

/** The clean intended shape boundary shared by painter and connector binding. */
export function roundedRectanglePath(width: number, height: number, roundness: number): string {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  return serializeBoundarySegments(boundarySegments("rectangle", safeWidth, safeHeight, roundness));
}

export function roundedDiamondPath(width: number, height: number): string {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  return serializeBoundarySegments(boundarySegments("diamond", safeWidth, safeHeight, 0));
}

/** Angular `t` ray intersection with the rendered logical perimeter. */
export function getShapeBoundaryPoint(
  shape: ShapeBoundaryKind,
  width: number,
  height: number,
  roundness: number,
  t: number,
): CanvasPoint | null {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  if (safeWidth <= 0 || safeHeight <= 0) return null;
  const center = { x: safeWidth / 2, y: safeHeight / 2 };
  const radians = t * Math.PI * 2;
  const direction = { x: Math.sin(radians), y: -Math.cos(radians) };
  if (shape === "ellipse") return { x: center.x + direction.x * center.x, y: center.y + direction.y * center.y };
  return rayIntersectionOnSegments(center, direction, boundarySegments(shape, safeWidth, safeHeight, roundness));
}

/** Nearest Euclidean point on the same clean logical perimeter. */
export function projectPointToShapeBoundary(
  shape: ShapeBoundaryKind,
  width: number,
  height: number,
  roundness: number,
  point: CanvasPoint,
): CanvasPoint | null {
  const center = { x: Math.max(0, width) / 2, y: Math.max(0, height) / 2 };
  if (width <= 0 || height <= 0) return null;
  if (shape === "ellipse") return closestEllipsePoint(point, center, center.x, center.y);
  const segments = boundarySegments(shape, Math.max(0, width), Math.max(0, height), roundness);
  if (segments.length === 0) return null;
  let nearest: CanvasPoint | null = null;
  for (const segment of segments) {
    const candidate = segment.kind === "line"
      ? closestPointOnSegment(point, segment.start, segment.end)
      : closestPointOnQuadratic(point, segment.start, segment.control, segment.end);
    if (!nearest || distanceSquared(point, candidate) < distanceSquared(point, nearest)) nearest = candidate;
  }
  return nearest;
}

/** Tests a local point against the same clean boundary used for anchors. */
export function containsPointInsideShapeBoundary(
  shape: ShapeBoundaryKind,
  width: number,
  height: number,
  roundness: number,
  point: CanvasPoint,
): boolean {
  if (!(width > 0 && height > 0)) return false;
  const center = { x: width / 2, y: height / 2 };
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (shape === "ellipse") return (dx / center.x) ** 2 + (dy / center.y) ** 2 <= 1;
  if (dx === 0 && dy === 0) return true;
  const t = Math.atan2(dx, -dy) / (Math.PI * 2);
  const boundary = getShapeBoundaryPoint(shape, width, height, roundness, t);
  return Boolean(boundary && Math.hypot(dx, dy) <= Math.hypot(boundary.x - center.x, boundary.y - center.y) + 1e-10);
}

/**
 * Allocation-free containment for tight model hit-testing loops. It uses the
 * exact same quadratic perimeter segments as `boundarySegments`, but keeps
 * every segment and root scalar so a scene scan never constructs segment or
 * root arrays. Projection and rendering may still use the richer helpers.
 */
export function containsPointInsideShapeBoundaryFast(
  shape: ShapeBoundaryKind,
  width: number,
  height: number,
  roundness: number,
  x: number,
  y: number,
): boolean {
  if (!(width > 0 && height > 0)) return false;
  const centerX = width / 2;
  const centerY = height / 2;
  const directionX = x - centerX;
  const directionY = y - centerY;
  if (shape === "ellipse") {
    return (directionX / centerX) ** 2 + (directionY / centerY) ** 2 <= 1;
  }
  if (directionX === 0 && directionY === 0) return true;
  return shape === "rectangle"
    ? roundedRectangleRayContainsPoint(width, height, roundness, centerX, centerY, directionX, directionY)
    : roundedDiamondRayContainsPoint(width, height, centerX, centerY, directionX, directionY);
}

function roundedRectangleRayContainsPoint(
  width: number,
  height: number,
  roundness: number,
  centerX: number,
  centerY: number,
  directionX: number,
  directionY: number,
) {
  const radius = roundedRectangleRadius(width, height, roundness);
  return rayLineContainsPoint(centerX, centerY, directionX, directionY, radius, 0, width - radius, 0)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, width - radius, 0, width, 0, width, radius)
    || rayLineContainsPoint(centerX, centerY, directionX, directionY, width, radius, width, height - radius)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, width, height - radius, width, height, width - radius, height)
    || rayLineContainsPoint(centerX, centerY, directionX, directionY, width - radius, height, radius, height)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, radius, height, 0, height, 0, height - radius)
    || rayLineContainsPoint(centerX, centerY, directionX, directionY, 0, height - radius, 0, radius)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, 0, radius, 0, 0, radius, 0);
}

function roundedDiamondRayContainsPoint(
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  directionX: number,
  directionY: number,
) {
  // Keep these scalar in the direct hit path: `diamondMeasures` is useful for
  // path construction but returns an object for the richer geometry helpers.
  const cornerInset = Math.min(width, height) * DIAMOND_CORNER_INSET;
  const diagonal = Math.max(1, Math.hypot(width, height));
  const horizontalInset = cornerInset * width / diagonal;
  const verticalInset = cornerInset * height / diagonal;
  const control = 0.45;
  return rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, centerX, 0, centerX + horizontalInset * control, 0, centerX + horizontalInset, verticalInset)
    || rayLineContainsPoint(centerX, centerY, directionX, directionY, centerX + horizontalInset, verticalInset, width - horizontalInset, centerY - verticalInset)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, width - horizontalInset, centerY - verticalInset, width, centerY - verticalInset * control, width, centerY)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, width, centerY, width, centerY + verticalInset * control, width - horizontalInset, centerY + verticalInset)
    || rayLineContainsPoint(centerX, centerY, directionX, directionY, width - horizontalInset, centerY + verticalInset, centerX + horizontalInset, height - verticalInset)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, centerX + horizontalInset, height - verticalInset, centerX + horizontalInset * control, height, centerX, height)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, centerX, height, centerX - horizontalInset * control, height, centerX - horizontalInset, height - verticalInset)
    || rayLineContainsPoint(centerX, centerY, directionX, directionY, centerX - horizontalInset, height - verticalInset, horizontalInset, centerY + verticalInset)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, horizontalInset, centerY + verticalInset, 0, centerY + verticalInset * control, 0, centerY)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, 0, centerY, 0, centerY - verticalInset * control, horizontalInset, centerY - verticalInset)
    || rayLineContainsPoint(centerX, centerY, directionX, directionY, horizontalInset, centerY - verticalInset, centerX - horizontalInset, verticalInset)
    || rayQuadraticContainsPoint(centerX, centerY, directionX, directionY, centerX - horizontalInset, verticalInset, centerX - horizontalInset * control, 0, centerX, 0);
}

function rayLineContainsPoint(
  originX: number,
  originY: number,
  directionX: number,
  directionY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  const edgeX = endX - startX;
  const edgeY = endY - startY;
  const denominator = directionX * edgeY - directionY * edgeX;
  if (Math.abs(denominator) < 1e-12) return false;
  const deltaX = startX - originX;
  const deltaY = startY - originY;
  const ray = (deltaX * edgeY - deltaY * edgeX) / denominator;
  const segment = (deltaX * directionY - deltaY * directionX) / denominator;
  return ray >= 1 - 1e-10 && segment >= -1e-12 && segment <= 1 + 1e-12;
}

function rayQuadraticContainsPoint(
  originX: number,
  originY: number,
  directionX: number,
  directionY: number,
  startX: number,
  startY: number,
  controlX: number,
  controlY: number,
  endX: number,
  endY: number,
) {
  const ax = startX - 2 * controlX + endX;
  const ay = startY - 2 * controlY + endY;
  const bx = 2 * (controlX - startX);
  const by = 2 * (controlY - startY);
  const cx = startX - originX;
  const cy = startY - originY;
  const coefficientA = ax * directionY - ay * directionX;
  const coefficientB = bx * directionY - by * directionX;
  const coefficientC = cx * directionY - cy * directionX;
  if (Math.abs(coefficientA) < 1e-12) {
    return Math.abs(coefficientB) >= 1e-12
      && quadraticRayRatioContainsPoint(-coefficientC / coefficientB, originX, originY, directionX, directionY, startX, startY, controlX, controlY, endX, endY);
  }
  const discriminant = coefficientB * coefficientB - 4 * coefficientA * coefficientC;
  if (discriminant < -1e-12) return false;
  const root = Math.sqrt(Math.max(0, discriminant));
  return quadraticRayRatioContainsPoint((-coefficientB - root) / (2 * coefficientA), originX, originY, directionX, directionY, startX, startY, controlX, controlY, endX, endY)
    || quadraticRayRatioContainsPoint((-coefficientB + root) / (2 * coefficientA), originX, originY, directionX, directionY, startX, startY, controlX, controlY, endX, endY);
}

function quadraticRayRatioContainsPoint(
  ratio: number,
  originX: number,
  originY: number,
  directionX: number,
  directionY: number,
  startX: number,
  startY: number,
  controlX: number,
  controlY: number,
  endX: number,
  endY: number,
) {
  if (ratio < -1e-12 || ratio > 1 + 1e-12) return false;
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const reverse = 1 - clampedRatio;
  const pointX = reverse * reverse * startX + 2 * reverse * clampedRatio * controlX + clampedRatio * clampedRatio * endX;
  const pointY = reverse * reverse * startY + 2 * reverse * clampedRatio * controlY + clampedRatio * clampedRatio * endY;
  const pointDirectionX = pointX - originX;
  const pointDirectionY = pointY - originY;
  const directionLengthSquared = directionX * directionX + directionY * directionY;
  const ray = (pointDirectionX * directionX + pointDirectionY * directionY) / directionLengthSquared;
  return ray >= 1 - 1e-10;
}

function roundedRectangleRadius(width: number, height: number, roundness: number) {
  const boundedRoundness = Math.max(MIN_VISUAL_RECTANGLE_ROUNDNESS, Math.min(1, roundness));
  return Math.min(width, height) * boundedRoundness / 2;
}

function diamondMeasures(width: number, height: number) {
  const cornerInset = Math.min(width, height) * DIAMOND_CORNER_INSET;
  const diagonal = Math.max(1, Math.hypot(width, height));
  return {
    centerX: width / 2,
    centerY: height / 2,
    horizontalInset: cornerInset * width / diagonal,
    verticalInset: cornerInset * height / diagonal,
  };
}

type BoundarySegment = { kind: "line"; start: CanvasPoint; end: CanvasPoint } | { kind: "quadratic"; start: CanvasPoint; control: CanvasPoint; end: CanvasPoint };
function boundarySegments(shape: Exclude<ShapeBoundaryKind, "ellipse">, width: number, height: number, roundness: number): BoundarySegment[] {
  if (shape === "rectangle") {
    const radius = roundedRectangleRadius(width, height, roundness);
    return chainSegments([
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
  const { centerX, centerY, horizontalInset, verticalInset } = diamondMeasures(width, height);
  const control = 0.45;
  return chainSegments([
    { kind: "quadratic", control: { x: centerX + horizontalInset * control, y: 0 }, end: { x: centerX + horizontalInset, y: verticalInset } },
    { kind: "line", end: { x: width - horizontalInset, y: centerY - verticalInset } },
    { kind: "quadratic", control: { x: width, y: centerY - verticalInset * control }, end: { x: width, y: centerY } },
    { kind: "quadratic", control: { x: width, y: centerY + verticalInset * control }, end: { x: width - horizontalInset, y: centerY + verticalInset } },
    { kind: "line", end: { x: centerX + horizontalInset, y: height - verticalInset } },
    { kind: "quadratic", control: { x: centerX + horizontalInset * control, y: height }, end: { x: centerX, y: height } },
    { kind: "quadratic", control: { x: centerX - horizontalInset * control, y: height }, end: { x: centerX - horizontalInset, y: height - verticalInset } },
    { kind: "line", end: { x: horizontalInset, y: centerY + verticalInset } },
    { kind: "quadratic", control: { x: 0, y: centerY + verticalInset * control }, end: { x: 0, y: centerY } },
    { kind: "quadratic", control: { x: 0, y: centerY - verticalInset * control }, end: { x: horizontalInset, y: centerY - verticalInset } },
    { kind: "line", end: { x: centerX - horizontalInset, y: verticalInset } },
    { kind: "quadratic", control: { x: centerX - horizontalInset * control, y: 0 }, end: { x: centerX, y: 0 } },
  ], { x: centerX, y: 0 });
}

type Segment = { kind: "line"; end: CanvasPoint } | { kind: "quadratic"; control: CanvasPoint; end: CanvasPoint };
function chainSegments(segments: readonly Segment[], start: CanvasPoint): BoundarySegment[] {
  const result: BoundarySegment[] = [];
  let current = start;
  for (const segment of segments) {
    result.push({ ...segment, start: current });
    current = segment.end;
  }
  return result;
}

function serializeBoundarySegments(segments: readonly BoundarySegment[]): string {
  const first = segments[0];
  if (!first) return "";
  return [`M ${first.start.x} ${first.start.y}`, ...segments.map((segment) => segment.kind === "line"
    ? `L ${segment.end.x} ${segment.end.y}`
    : `Q ${segment.control.x} ${segment.control.y} ${segment.end.x} ${segment.end.y}`)].join(" ");
}

function rayIntersectionOnSegments(center: CanvasPoint, direction: CanvasPoint, segments: readonly BoundarySegment[]) {
  let best: CanvasPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    const candidates = segment.kind === "line"
      ? [raySegmentIntersection(center, direction, segment.start, segment.end)]
      : rayQuadraticIntersections(center, direction, segment.start, segment.control, segment.end);
    for (const point of candidates) {
      if (point && distanceSquared(center, point) < bestDistance) {
        best = point;
        bestDistance = distanceSquared(center, point);
      }
    }
  }
  return best;
}

function raySegmentIntersection(origin: CanvasPoint, direction: CanvasPoint, start: CanvasPoint, end: CanvasPoint) {
  const edge = { x: end.x - start.x, y: end.y - start.y };
  const denominator = cross(direction, edge);
  if (Math.abs(denominator) < 1e-12) return null;
  const delta = { x: start.x - origin.x, y: start.y - origin.y };
  const ray = cross(delta, edge) / denominator;
  const segment = cross(delta, direction) / denominator;
  return ray >= 0 && segment >= -1e-12 && segment <= 1 + 1e-12
    ? { x: origin.x + direction.x * ray, y: origin.y + direction.y * ray }
    : null;
}

function rayQuadraticIntersections(
  origin: CanvasPoint,
  direction: CanvasPoint,
  start: CanvasPoint,
  control: CanvasPoint,
  end: CanvasPoint,
) {
  const a = {
    x: start.x - 2 * control.x + end.x,
    y: start.y - 2 * control.y + end.y,
  };
  const b = { x: 2 * (control.x - start.x), y: 2 * (control.y - start.y) };
  const c = { x: start.x - origin.x, y: start.y - origin.y };
  const roots = quadraticRoots(cross(a, direction), cross(b, direction), cross(c, direction));
  return roots
    .filter((ratio) => ratio >= -1e-12 && ratio <= 1 + 1e-12)
    .map((ratio) => quadraticPoint(start, control, end, ratio))
    .filter((point) => (point.x - origin.x) * direction.x + (point.y - origin.y) * direction.y >= -1e-12);
}

function quadraticRoots(a: number, b: number, c: number) {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -1e-12) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

function closestPointOnSegment(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint): CanvasPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const size = dx * dx + dy * dy;
  const ratio = size === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / size));
  return { x: start.x + dx * ratio, y: start.y + dy * ratio };
}

function quadraticPoint(start: CanvasPoint, control: CanvasPoint, end: CanvasPoint, ratio: number) {
  const reverse = 1 - ratio;
  return {
    x: reverse * reverse * start.x + 2 * reverse * ratio * control.x + ratio * ratio * end.x,
    y: reverse * reverse * start.y + 2 * reverse * ratio * control.y + ratio * ratio * end.y,
  };
}

function closestPointOnQuadratic(
  point: CanvasPoint,
  start: CanvasPoint,
  control: CanvasPoint,
  end: CanvasPoint,
) {
  const a = {
    x: start.x - 2 * control.x + end.x,
    y: start.y - 2 * control.y + end.y,
  };
  const b = { x: 2 * (control.x - start.x), y: 2 * (control.y - start.y) };
  const c = { x: start.x - point.x, y: start.y - point.y };
  const roots = [
    0,
    1,
    ...cubicRealRoots(2 * dot(a, a), 3 * dot(a, b), dot(b, b) + 2 * dot(a, c), dot(b, c)),
  ]
    .filter((ratio) => ratio >= -ROOT_TOLERANCE && ratio <= 1 + ROOT_TOLERANCE)
    .map((ratio) => Math.max(0, Math.min(1, ratio)));
  return roots
    .map((ratio) => quadraticPoint(start, control, end, ratio))
    .reduce((nearest, candidate) => distanceSquared(point, candidate) < distanceSquared(point, nearest) ? candidate : nearest);
}
/** All real cubic roots via critical-point intervals; repeated roots are tested explicitly. */
function cubicRealRoots(a: number, b: number, c: number, d: number) {
  if (Math.abs(a) < ROOT_TOLERANCE) return quadraticRoots(b, c, d);
  const evaluate = (x: number) => ((a * x + b) * x + c) * x + d;
  const critical = quadraticRoots(3 * a, 2 * b, c).sort((first, second) => first - second);
  const bounds = [-1_000_000, ...critical, 1_000_000];
  const roots: number[] = [];
  for (const criticalPoint of critical) {
    if (Math.abs(evaluate(criticalPoint)) < ROOT_TOLERANCE) roots.push(criticalPoint);
  }
  for (let index = 0; index < bounds.length - 1; index += 1) {
    let low = bounds[index];
    let high = bounds[index + 1];
    let lowValue = evaluate(low);
    const highValue = evaluate(high);
    if (lowValue === 0) roots.push(low);
    if (lowValue * highValue >= 0) continue;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const middle = (low + high) / 2;
      const value = evaluate(middle);
      if (Math.abs(value) < ROOT_TOLERANCE) {
        low = middle;
        high = middle;
        break;
      }
      if (lowValue * value < 0) high = middle;
      else {
        low = middle;
        lowValue = value;
      }
    }
    roots.push((low + high) / 2);
  }
  return roots;
}

/** Globally bracketed stationary-point search over the ellipse parameter. */
function closestEllipsePoint(
  point: CanvasPoint,
  center: CanvasPoint,
  radiusX: number,
  radiusY: number,
): CanvasPoint | null {
  if (radiusX === 0 || radiusY === 0) return { x: center.x, y: center.y };
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const stationary = (angle: number) =>
    (radiusY * radiusY - radiusX * radiusX) * Math.sin(angle) * Math.cos(angle)
    + radiusX * dx * Math.sin(angle) - radiusY * dy * Math.cos(angle);
  const roots = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
  let previousAngle = 0;
  let previousValue = stationary(previousAngle);
  for (let index = 1; index <= ELLIPSE_STATIONARY_BRACKET_COUNT; index += 1) {
    const nextAngle = index * Math.PI * 2 / ELLIPSE_STATIONARY_BRACKET_COUNT;
    const nextValue = stationary(nextAngle);
    if (Math.abs(previousValue) < ROOT_TOLERANCE) roots.push(previousAngle);
    if (previousValue * nextValue < 0) {
      let low = previousAngle;
      let high = nextAngle;
      let lowValue = previousValue;
      for (let iteration = 0; iteration < 52; iteration += 1) {
        const middle = (low + high) / 2;
        const value = stationary(middle);
        if (Math.abs(value) < ROOT_TOLERANCE) { low = middle; high = middle; break; }
        if (lowValue * value <= 0) high = middle;
        else { low = middle; lowValue = value; }
      }
      roots.push((low + high) / 2);
    }
    previousAngle = nextAngle;
    previousValue = nextValue;
  }
  return roots.map((angle) => ({
    x: center.x + radiusX * Math.cos(angle),
    y: center.y + radiusY * Math.sin(angle),
  })).reduce((best, candidate) => distanceSquared(point, candidate) < distanceSquared(point, best) ? candidate : best);
}
function cross(first: CanvasPoint, second: CanvasPoint) {
  return first.x * second.y - first.y * second.x;
}

function dot(first: CanvasPoint, second: CanvasPoint) {
  return first.x * second.x + first.y * second.y;
}

function distanceSquared(first: CanvasPoint, second: CanvasPoint) {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return dx * dx + dy * dy;
}
