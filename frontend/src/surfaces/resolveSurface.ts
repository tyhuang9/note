import { isTauri } from "@tauri-apps/api/core";

export type Surface =
  | { kind: "main" | "widget" | "quick-command" | "event-editor" }
  | { kind: "unsupported"; label: string };

export type SurfaceResolverDependencies = {
  readonly getNativeWindowLabel: () => Promise<string>;
  readonly getSearch: () => string;
  readonly isDevelopment: boolean;
  readonly isNative: () => boolean;
};

export function surfaceFromLabel(label: string): Surface {
  switch (label) {
    case "main":
    case "widget":
    case "quick-command":
    case "event-editor":
      return { kind: label };
    default:
      return { kind: "unsupported", label };
  }
}

export async function resolveSurface(
  dependencies: SurfaceResolverDependencies = defaultDependencies,
): Promise<Surface> {
  if (dependencies.isNative()) {
    return surfaceFromLabel(await dependencies.getNativeWindowLabel());
  }

  if (dependencies.isDevelopment) {
    const override = new URLSearchParams(dependencies.getSearch()).get(
      "surface",
    );

    if (
      override === "widget" ||
      override === "quick-command" ||
      override === "event-editor" ||
      override === "unknown"
    ) {
      return surfaceFromLabel(override);
    }
  }

  return { kind: "main" };
}

const defaultDependencies: SurfaceResolverDependencies = {
  getNativeWindowLabel: async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label;
  },
  getSearch: () => window.location.search,
  isDevelopment: import.meta.env?.DEV ?? false,
  isNative: isTauri,
};
