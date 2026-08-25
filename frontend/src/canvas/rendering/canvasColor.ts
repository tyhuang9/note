import type { CanvasColor } from "../model/elements";

export type CanvasTheme = "light" | "dark";

type RgbColor = Readonly<{ blue: number; green: number; red: number }>;
type RgbaColor = RgbColor & Readonly<{ alpha: number }>;

/** Resolved values of the CSS tokens used by the canvas in each app theme. */
export const CANVAS_THEME_PALETTE: Readonly<Record<CanvasTheme, Readonly<{
  foreground: string;
  muted: string;
  surface: string;
}>>> = {
  light: {
    foreground: "#202936",
    muted: "#9b9b9b",
    surface: "#f5f7fa",
  },
  dark: {
    foreground: "#f5f5f5",
    muted: "#9b9b9b",
    surface: "#161616",
  },
};

/** Resolves persisted canvas colors to the same theme-aware CSS tokens used by element views. */
export function canvasColorToCss(color: CanvasColor): string {
  if (color.kind === "fixed") return color.value;
  return color.token === "muted"
    ? "var(--workbench-text-secondary)"
    : "var(--canvas-tool-text)";
}

/** Resolves persisted colors without consulting DOM or computed styles. */
export function resolveCanvasColor(color: CanvasColor, theme: CanvasTheme): RgbaColor | null {
  if (color.kind === "theme") {
    const resolved = parseHexColor(CANVAS_THEME_PALETTE[theme][color.token]);
    return resolved && { ...resolved, alpha: 1 };
  }
  return parseHexColor(color.value);
}

/** Produces the opaque pixel color made by a fill over the real canvas surface. */
export function compositeCanvasFill(color: CanvasColor, theme: CanvasTheme): RgbColor | null {
  const foreground = resolveCanvasColor(color, theme);
  const background = parseHexColor(CANVAS_THEME_PALETTE[theme].surface);
  if (!foreground || !background) return null;
  return {
    red: compositeChannel(foreground.red, background.red, foreground.alpha),
    green: compositeChannel(foreground.green, background.green, foreground.alpha),
    blue: compositeChannel(foreground.blue, background.blue, foreground.alpha),
  };
}

export function rgbColorToHex(color: RgbColor): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function readableTextColor(background: RgbColor): "#000000" | "#ffffff" {
  return relativeLuminance(background) > 0.179 ? "#000000" : "#ffffff";
}

function parseHexColor(value: string): RgbaColor | null {
  const shorthand = /^#([\da-f])([\da-f])([\da-f])$/i.exec(value);
  if (shorthand) {
    return {
      red: Number.parseInt(`${shorthand[1]}${shorthand[1]}`, 16),
      green: Number.parseInt(`${shorthand[2]}${shorthand[2]}`, 16),
      blue: Number.parseInt(`${shorthand[3]}${shorthand[3]}`, 16),
      alpha: 1,
    };
  }
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i.exec(value);
  if (!full) return null;
  return {
    red: Number.parseInt(full[1], 16),
    green: Number.parseInt(full[2], 16),
    blue: Number.parseInt(full[3], 16),
    alpha: full[4] ? Number.parseInt(full[4], 16) / 255 : 1,
  };
}

function compositeChannel(foreground: number, background: number, alpha: number): number {
  return Math.round(foreground * alpha + background * (1 - alpha));
}

function relativeLuminance(color: RgbColor): number {
  return [color.red, color.green, color.blue]
    .map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
