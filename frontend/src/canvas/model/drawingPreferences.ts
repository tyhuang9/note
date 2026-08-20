import type {
  CanvasColor,
  CanvasElement,
  ConnectorElement,
  InkElement,
  RoughStyle,
  ShapeElement,
  TextBackgroundMode,
  TextElement,
} from "./elements";
import type { TextPreferences } from "./textPreferences";

export type DrawingPreferenceTool =
  | "pen"
  | "highlighter"
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "line"
  | "arrow";

export type DrawingToolPreference = Readonly<{
  backgroundColor: CanvasColor | null;
  opacity: number;
  roughness: number;
  roundness: number;
  strokeColor: CanvasColor;
  strokeStyle: RoughStyle["strokeStyle"];
  strokeWidth: number;
}>;

export type DrawingPreferences = Readonly<Record<DrawingPreferenceTool, DrawingToolPreference>>;

export type DrawingProperty =
  | "backgroundColor"
  | "backgroundMode"
  | "opacity"
  | "roughness"
  | "roundness"
  | "strokeColor"
  | "strokeStyle"
  | "strokeWidth";

export type DrawingPropertyUpdate =
  | { property: "backgroundColor"; value: CanvasColor | null }
  | { property: "backgroundMode"; value: TextBackgroundMode }
  | { property: "opacity"; value: number }
  | { property: "roughness"; value: number }
  | { property: "roundness"; value: number }
  | { property: "strokeColor"; value: CanvasColor }
  | { property: "strokeStyle"; value: RoughStyle["strokeStyle"] }
  | { property: "strokeWidth"; value: number };

export type PropertyValue<T> =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "mixed" }>
  | Readonly<{ kind: "value"; value: T }>;

export type DrawingPropertyValues = Readonly<{
  backgroundColor: PropertyValue<CanvasColor | null>;
  backgroundMode: PropertyValue<TextBackgroundMode>;
  opacity: PropertyValue<number>;
  roughness: PropertyValue<number>;
  roundness: PropertyValue<number>;
  strokeColor: PropertyValue<CanvasColor>;
  strokeStyle: PropertyValue<RoughStyle["strokeStyle"]>;
  strokeWidth: PropertyValue<number>;
}>;

const foreground = (): CanvasColor => ({ kind: "theme", token: "foreground" });
const fixed = (value: string): CanvasColor => ({ kind: "fixed", value });

function preference(overrides: Partial<DrawingToolPreference> = {}): DrawingToolPreference {
  return {
    backgroundColor: null,
    opacity: 1,
    roughness: 1.2,
    roundness: 0,
    strokeColor: foreground(),
    strokeStyle: "solid",
    strokeWidth: 2,
    ...overrides,
  };
}

export function createDefaultDrawingPreferences(): DrawingPreferences {
  return {
    arrow: preference(),
    diamond: preference(),
    ellipse: preference(),
    highlighter: preference({ opacity: 0.38, roughness: 0, strokeColor: fixed("#f4c542"), strokeWidth: 18 }),
    line: preference(),
    pen: preference({ roughness: 0, strokeWidth: 4 }),
    // New rectangles use the existing rounded preset. Loaded element styles
    // intentionally keep their own legacy fallback of 0 in sceneRepository.
    rectangle: preference({ roundness: 0.18 }),
  };
}

const preferenceTools: readonly DrawingPreferenceTool[] = [
  "pen",
  "highlighter",
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
];

function isCanvasColor(value: unknown): value is CanvasColor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanvasColor>;
  return candidate.kind === "theme"
    ? candidate.token === "foreground" || candidate.token === "muted"
    : candidate.kind === "fixed" && typeof candidate.value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(candidate.value);
}

function finiteInRange(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

/** Safely loads optional session preferences without trusting persisted JSON. */
export function normalizeDrawingPreferences(value: unknown): DrawingPreferences {
  const defaults = createDefaultDrawingPreferences();
  if (!value || typeof value !== "object") return defaults;
  const source = value as Partial<Record<DrawingPreferenceTool, unknown>>;
  return Object.fromEntries(preferenceTools.map((tool) => {
    const fallback = defaults[tool];
    const candidate = source[tool];
    if (!candidate || typeof candidate !== "object") return [tool, fallback];
    const raw = candidate as Partial<DrawingToolPreference>;
    return [tool, {
      backgroundColor: raw.backgroundColor === null || isCanvasColor(raw.backgroundColor)
        ? raw.backgroundColor
        : fallback.backgroundColor,
      opacity: finiteInRange(raw.opacity, fallback.opacity, 0, 1),
      roughness: finiteInRange(raw.roughness, fallback.roughness, 0, 10),
      roundness: finiteInRange(raw.roundness, fallback.roundness, 0, 1),
      strokeColor: isCanvasColor(raw.strokeColor) ? raw.strokeColor : fallback.strokeColor,
      strokeStyle: raw.strokeStyle === "solid" || raw.strokeStyle === "dashed" || raw.strokeStyle === "dotted"
        ? raw.strokeStyle
        : fallback.strokeStyle,
      strokeWidth: finiteInRange(raw.strokeWidth, fallback.strokeWidth, 0.25, 512),
    }];
  })) as DrawingPreferences;
}

export function updateDrawingPreference(
  preferences: DrawingPreferences,
  tool: DrawingPreferenceTool,
  update: DrawingPropertyUpdate,
): DrawingPreferences {
  if (!isPropertySupportedByTool(tool, update.property)) return preferences;
  return {
    ...preferences,
    [tool]: { ...preferences[tool], [update.property]: update.value },
  };
}

export function isDrawingPreferenceTool(tool: string): tool is DrawingPreferenceTool {
  return preferenceTools.includes(tool as DrawingPreferenceTool);
}

export function isPropertySupportedByTool(tool: DrawingPreferenceTool, property: DrawingProperty) {
  if (property === "opacity" || property === "strokeColor" || property === "strokeWidth") return true;
  if (tool === "pen" || tool === "highlighter") return false;
  if (property === "backgroundColor") return tool !== "line" && tool !== "arrow";
  if (property === "roundness") return tool === "rectangle";
  return true;
}

export function readDrawingProperties(elements: readonly CanvasElement[]): DrawingPropertyValues {
  return {
    backgroundColor: readCompatible(elements, "backgroundColor"),
    backgroundMode: readCompatible(elements, "backgroundMode"),
    opacity: readCompatible(elements, "opacity"),
    roughness: readCompatible(elements, "roughness"),
    roundness: readCompatible(elements, "roundness"),
    strokeColor: readCompatible(elements, "strokeColor"),
    strokeStyle: readCompatible(elements, "strokeStyle"),
    strokeWidth: readCompatible(elements, "strokeWidth"),
  };
}

export function drawingPropertiesFromPreference(preference: DrawingToolPreference): DrawingPropertyValues {
  return {
    backgroundColor: { kind: "value", value: preference.backgroundColor },
    backgroundMode: { kind: "unavailable" },
    opacity: { kind: "value", value: preference.opacity },
    roughness: { kind: "value", value: preference.roughness },
    roundness: { kind: "value", value: preference.roundness },
    strokeColor: { kind: "value", value: preference.strokeColor },
    strokeStyle: { kind: "value", value: preference.strokeStyle },
    strokeWidth: { kind: "value", value: preference.strokeWidth },
  };
}

function readCompatible<P extends DrawingProperty>(
  elements: readonly CanvasElement[],
  property: P,
): PropertyValue<PropertyType<P>> {
  const values = elements.flatMap((element) => {
    const value = readElementProperty(element, property);
    return value === unavailable ? [] : [value];
  });
  if (values.length === 0) return { kind: "unavailable" };
  const first = values[0];
  return values.every((value) => valuesEqual(first, value))
    ? { kind: "value", value: first }
    : { kind: "mixed" };
}

type PropertyType<P extends DrawingProperty> =
  P extends "backgroundColor" ? CanvasColor | null :
  P extends "backgroundMode" ? TextBackgroundMode :
  P extends "strokeColor" ? CanvasColor :
  P extends "strokeStyle" ? RoughStyle["strokeStyle"] : number;

const unavailable = Symbol("unavailable");

function readElementProperty<P extends DrawingProperty>(
  element: CanvasElement,
  property: P,
): PropertyType<P> | typeof unavailable {
  if (property === "opacity") return element.opacity as PropertyType<P>;
  if (element.type === "text" && property === "backgroundMode") {
    return element.backgroundMode as PropertyType<P>;
  }
  if (element.type === "ink") {
    if (property === "strokeColor") return element.brush.color as PropertyType<P>;
    if (property === "strokeWidth") return element.brush.size as PropertyType<P>;
    return unavailable;
  }
  if (element.type === "shape" || element.type === "connector") {
    if (property === "backgroundColor") {
      return element.type === "shape" ? (element.style.fillColor ?? null) as PropertyType<P> : unavailable;
    }
    if (property === "roundness") {
      return element.type === "shape" && element.shape === "rectangle"
        ? element.style.roundness as PropertyType<P>
        : unavailable;
    }
    return element.style[property as keyof RoughStyle] as PropertyType<P>;
  }
  return unavailable;
}

function valuesEqual(first: unknown, second: unknown) {
  return typeof first === "object" || typeof second === "object"
    ? JSON.stringify(first) === JSON.stringify(second)
    : first === second;
}

/** Applies a property only to selected, unlocked element kinds that support it. */
export function applyDrawingPropertyUpdate(
  elements: readonly CanvasElement[],
  selectedIds: ReadonlySet<string>,
  update: DrawingPropertyUpdate,
  updatedAt = Date.now(),
): CanvasElement[] {
  return elements.map((element) => {
    if (!selectedIds.has(element.id) || element.locked) return element;
    if (update.property === "opacity") {
      return element.opacity === update.value ? element : { ...element, opacity: update.value, updatedAt };
    }
    if (element.type === "text") return updateText(element, update, updatedAt);
    if (element.type === "ink") return updateInk(element, update, updatedAt);
    if (element.type === "shape") return updateShape(element, update, updatedAt);
    if (element.type === "connector") return updateConnector(element, update, updatedAt);
    return element;
  });
}

export function drawingPropertiesFromTextPreferences(
  preferences: TextPreferences,
): DrawingPropertyValues {
  return {
    backgroundColor: { kind: "unavailable" },
    backgroundMode: { kind: "value", value: preferences.backgroundMode },
    opacity: { kind: "unavailable" },
    roughness: { kind: "unavailable" },
    roundness: { kind: "unavailable" },
    strokeColor: { kind: "unavailable" },
    strokeStyle: { kind: "unavailable" },
    strokeWidth: { kind: "unavailable" },
  };
}

function updateText(element: TextElement, update: DrawingPropertyUpdate, updatedAt: number): TextElement {
  if (update.property !== "backgroundMode" || element.backgroundMode === update.value) {
    return element;
  }
  return { ...element, backgroundMode: update.value, updatedAt };
}

function updateInk(element: InkElement, update: DrawingPropertyUpdate, updatedAt: number): InkElement {
  if (update.property === "strokeColor") {
    return valuesEqual(element.brush.color, update.value)
      ? element
      : { ...element, brush: { ...element.brush, color: update.value }, updatedAt };
  }
  if (update.property === "strokeWidth" && element.brush.size !== update.value) {
    return reboxInkForBrush({ ...element, brush: { ...element.brush, size: update.value }, updatedAt });
  }
  return element;
}

function updateShape(element: ShapeElement, update: DrawingPropertyUpdate, updatedAt: number): ShapeElement {
  if (update.property === "backgroundColor") return withStyle(element, "fillColor", update.value, updatedAt);
  if (update.property === "roundness" && element.shape !== "rectangle") return element;
  if (update.property === "strokeColor" || update.property === "strokeStyle" || update.property === "strokeWidth" || update.property === "roughness" || update.property === "roundness") {
    return withStyle(element, update.property, update.value, updatedAt);
  }
  return element;
}

function updateConnector(element: ConnectorElement, update: DrawingPropertyUpdate, updatedAt: number): ConnectorElement {
  if (update.property === "strokeColor" || update.property === "strokeStyle" || update.property === "strokeWidth" || update.property === "roughness") {
    return withStyle(element, update.property, update.value, updatedAt);
  }
  return element;
}

function withStyle<T extends ShapeElement | ConnectorElement>(
  element: T,
  property: keyof RoughStyle,
  value: RoughStyle[keyof RoughStyle],
  updatedAt: number,
): T {
  return valuesEqual(element.style[property as keyof typeof element.style], value)
    ? element
    : { ...element, style: { ...element.style, [property]: value }, updatedAt } as T;
}

/** Recomputes the ink wrapper after brush restyling while preserving every world-space point. */
export function reboxInkForBrush(element: InkElement): InkElement {
  if (element.points.length === 0) return element;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of element.points) {
    minX = Math.min(minX, element.x + x);
    minY = Math.min(minY, element.y + y);
    maxX = Math.max(maxX, element.x + x);
    maxY = Math.max(maxY, element.y + y);
  }
  const padding = Math.max(2, element.brush.size * 1.5);
  const x = round(minX - padding);
  const y = round(minY - padding);
  return {
    ...element,
    height: round(Math.max(1, maxY - minY + padding * 2)),
    points: element.points.map(([pointX, pointY, pressure]) => [
      round(element.x + pointX - x),
      round(element.y + pointY - y),
      pressure,
    ]),
    width: round(Math.max(1, maxX - minX + padding * 2)),
    x,
    y,
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
