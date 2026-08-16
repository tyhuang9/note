import type { CanvasElement } from "./elements";

export type LayerAction = "bring-forward" | "bring-to-front" | "send-backward" | "send-to-back";

/** Reorders selected unlocked elements within each page and normalizes every page to dense z-indices. */
export function reorderLayers(
  elements: readonly CanvasElement[],
  selectedIds: ReadonlySet<string>,
  action: LayerAction,
  updatedAt = Date.now(),
): CanvasElement[] {
  const originalIndex = new Map(elements.map((element, index) => [element.id, index]));
  const pages = new Map<string, CanvasElement[]>();
  for (const element of elements) {
    const page = pages.get(element.pageId) ?? [];
    page.push(element);
    pages.set(element.pageId, page);
  }

  const nextById = new Map<string, CanvasElement>();
  for (const page of pages.values()) {
    const ordered = [...page].sort((first, second) =>
      first.zIndex - second.zIndex || (originalIndex.get(first.id) ?? 0) - (originalIndex.get(second.id) ?? 0),
    );
    const movable = new Set(ordered.filter((element) => selectedIds.has(element.id) && !element.locked).map((element) => element.id));
    if (movable.size === 0) continue;
    reorder(ordered, movable, action);
    ordered.forEach((element, zIndex) => {
      nextById.set(element.id, element.zIndex === zIndex
        ? element
        : { ...element, zIndex, updatedAt });
    });
  }

  return elements.map((element) => nextById.get(element.id) ?? element);
}

function reorder(elements: CanvasElement[], selectedIds: ReadonlySet<string>, action: LayerAction) {
  if (selectedIds.size === 0) return;
  if (action === "bring-to-front" || action === "send-to-back") {
    const selected = elements.filter((element) => selectedIds.has(element.id));
    const remaining = elements.filter((element) => !selectedIds.has(element.id));
    elements.splice(0, elements.length, ...(action === "bring-to-front" ? [...remaining, ...selected] : [...selected, ...remaining]));
    return;
  }
  if (action === "bring-forward") {
    for (let index = elements.length - 2; index >= 0; index -= 1) {
      if (selectedIds.has(elements[index].id) && !selectedIds.has(elements[index + 1].id)) {
        [elements[index], elements[index + 1]] = [elements[index + 1], elements[index]];
      }
    }
    return;
  }
  for (let index = 1; index < elements.length; index += 1) {
    if (selectedIds.has(elements[index].id) && !selectedIds.has(elements[index - 1].id)) {
      [elements[index], elements[index - 1]] = [elements[index - 1], elements[index]];
    }
  }
}
