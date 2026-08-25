import type {
  CanvasColor,
  ConnectorElement,
  ConnectorLabelOrientation,
  ConnectorLabelStyle,
  TextFontFamily,
  TextFontSize,
} from "./elements";

export const MAX_CONNECTOR_LABEL_BYTES = 2_048;
export const defaultConnectorLabelStyle: ConnectorLabelStyle = {
  color: { kind: "theme", token: "foreground" },
  fontFamily: "system-ui",
  fontSize: "14px",
  orientation: "upright",
};

const fontFamilies: readonly TextFontFamily[] = ["system-ui", "Arial", "Georgia", "Times New Roman", "Courier New"];
const fontSizes: readonly TextFontSize[] = ["12px", "14px", "16px", "18px", "24px", "32px"];

export function isCanvasColor(value: unknown): value is CanvasColor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanvasColor>;
  return candidate.kind === "theme"
    ? candidate.token === "foreground" || candidate.token === "muted"
    : candidate.kind === "fixed" && typeof candidate.value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(candidate.value);
}

export function normalizeConnectorLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > MAX_CONNECTOR_LABEL_BYTES) return undefined;
  return normalized;
}

export function isConnectorLabelStyle(value: unknown): value is ConnectorLabelStyle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConnectorLabelStyle>;
  return (candidate.orientation === "upright" || candidate.orientation === "follow")
    && fontFamilies.includes(candidate.fontFamily as TextFontFamily)
    && fontSizes.includes(candidate.fontSize as TextFontSize)
    && isCanvasColor(candidate.color);
}

/** Legacy connectors acquire defaults at read/render time without a migration write. */
export function resolveConnectorLabelStyle(style: ConnectorLabelStyle | undefined): ConnectorLabelStyle {
  return isConnectorLabelStyle(style) ? style : defaultConnectorLabelStyle;
}

export function getConnectorLabel(element: ConnectorElement): string | undefined {
  return normalizeConnectorLabel(element.semantic?.label);
}

export function connectorLabelFontPixels(size: TextFontSize) {
  return Number.parseInt(size, 10);
}

export const CONNECTOR_LABEL_GAP_PADDING = 4;
export const CONNECTOR_LABEL_LINE_HEIGHT = 1.2;

let measurementContext: CanvasRenderingContext2D | null | undefined;

/** Deterministic fallback for workers and test environments without canvas text metrics. */
export function estimateConnectorLabelWidth(label: string, style: ConnectorLabelStyle = defaultConnectorLabelStyle) {
  return Math.max(0, label.length * connectorLabelFontPixels(style.fontSize) * 0.62);
}

/** Uses the same browser font metrics for committed, editing, and transient connector gaps. */
export function measureConnectorLabelWidth(label: string, style: ConnectorLabelStyle = defaultConnectorLabelStyle) {
  if (measurementContext === undefined) {
    measurementContext = null;
    if (typeof document !== "undefined") {
      try {
        measurementContext = document.createElement("canvas").getContext("2d");
      } catch {
        measurementContext = null;
      }
    }
  }
  if (measurementContext) {
    measurementContext.font = `${style.fontSize} ${style.fontFamily}`;
    const measured = measurementContext.measureText(label).width;
    if (Number.isFinite(measured) && measured >= 0) return measured;
  }
  return estimateConnectorLabelWidth(label, style);
}

/** Half of the real transparent line break, including four pixels per side. */
export function getConnectorLabelGapHalfLength(
  label: string,
  style: ConnectorLabelStyle = defaultConnectorLabelStyle,
  minimumTextWidth = 0,
  start?: Readonly<{ x: number; y: number }>,
  end?: Readonly<{ x: number; y: number }>,
) {
  const width = Math.max(minimumTextWidth, measureConnectorLabelWidth(label, style));
  if (style.orientation !== "upright" || !start || !end) {
    return Math.max(0, width / 2 + CONNECTOR_LABEL_GAP_PADDING);
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < Number.EPSILON) {
    return Math.max(0, width / 2 + CONNECTOR_LABEL_GAP_PADDING);
  }
  const lineHeight = connectorLabelFontPixels(style.fontSize) * CONNECTOR_LABEL_LINE_HEIGHT;
  const unitX = Math.abs(dx / distance);
  const unitY = Math.abs(dy / distance);
  // The gap ends where the centered shaft actually exits the upright label's
  // axis-aligned rectangle. Using the rectangle's projection onto the shaft
  // over-reserves space at diagonal and steep angles.
  const horizontalExit = unitX > Number.EPSILON ? width / 2 / unitX : Number.POSITIVE_INFINITY;
  const verticalExit = unitY > Number.EPSILON ? lineHeight / 2 / unitY : Number.POSITIVE_INFINITY;
  const intersectionHalfLength = Math.min(horizontalExit, verticalExit);
  return Math.max(0, intersectionHalfLength + CONNECTOR_LABEL_GAP_PADDING);
}

/** Follow labels never render upside down. */
export function readableConnectorLabelAngle(start: Readonly<{ x: number; y: number }>, end: Readonly<{ x: number; y: number }>, orientation: ConnectorLabelOrientation) {
  if (orientation === "upright") return 0;
  let angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
  if (angle > 90 || angle < -90) angle += 180;
  return angle;
}
