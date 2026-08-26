import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { HeroIcon } from "./HeroIcon";

export type DesktopPlatform = "linux" | "macos" | "windows";

export function getDesktopPlatform(): DesktopPlatform | null {
  if (!isTauri()) return null;

  try {
    const currentPlatform = platform();
    return currentPlatform === "linux" || currentPlatform === "macos" || currentPlatform === "windows"
      ? currentPlatform
      : null;
  } catch {
    return null;
  }
}

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let isMounted = true;
    const refreshMaximized = async () => {
      try {
        const nextValue = await appWindow.isMaximized();
        if (isMounted) setIsMaximized(nextValue);
      } catch {
        // This component only renders inside a Tauri desktop runtime.
      }
    };

    void refreshMaximized();
    let unlisten: (() => void) | undefined;
    void appWindow.onResized(() => void refreshMaximized()).then((dispose) => {
      unlisten = dispose;
    }).catch(() => undefined);

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, []);

  const runWindowAction = (action: () => Promise<void>) => void action().catch(() => undefined);

  return (
    <div className="window-controls" aria-label="Window controls" role="group">
      <button aria-label="Minimize window" className="window-control" onClick={() => runWindowAction(() => getCurrentWindow().minimize())} type="button">
        <HeroIcon name="minus" />
      </button>
      <button aria-label={isMaximized ? "Restore window" : "Maximize window"} className="window-control" onClick={() => runWindowAction(async () => { const appWindow = getCurrentWindow(); await appWindow.toggleMaximize(); setIsMaximized(await appWindow.isMaximized()); })} type="button">
        <HeroIcon name={isMaximized ? "window-restore" : "window-maximize"} />
      </button>
      <button aria-label="Close window" className="window-control is-close" onClick={() => runWindowAction(() => getCurrentWindow().close())} type="button">
        <HeroIcon name="x-mark" />
      </button>
    </div>
  );
}
