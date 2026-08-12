import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

type MainNavigationPayload = { destination: "calendar" };

function isCalendarNavigation(value: unknown): value is MainNavigationPayload {
  if (typeof value !== "object" || value === null) return false;

  const payload = value as Record<string, unknown>;
  return Object.keys(payload).length === 1 && payload.destination === "calendar";
}

export async function listenForMainCalendarNavigation(
  listener: () => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;

  try {
    if (getCurrentWindow().label !== "main") return () => undefined;
  } catch {
    return () => undefined;
  }

  return listen("note://navigate", (event) => {
    if (isCalendarNavigation(event.payload)) listener();
  });
}
