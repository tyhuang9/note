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

/** A stable conservative width lets SVG/canvas make a real transparent line gap. */
export function getConnectorLabelGapHalfLength(label: string, style: ConnectorLabelStyle = defaultConnectorLabelStyle) {
  return Math.max(0, label.length * connectorLabelFontPixels(style.fontSize) * 0.31 + 4);
}

/** Follow labels never render upside down. */
export function readableConnectorLabelAngle(start: Readonly<{ x: number; y: number }>, end: Readonly<{ x: number; y: number }>, orientation: ConnectorLabelOrientation) {
  if (orientation === "upright") return 0;
  let angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
  if (angle > 90 || angle < -90) angle += 180;
  return angle;
}
