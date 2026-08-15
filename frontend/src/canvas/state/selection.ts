import type { CanvasElement, ElementId } from "../model/elements";

export function replaceSelection(ids: readonly ElementId[], availableIds: ReadonlySet<ElementId>): ElementId[] {
  return uniqueExisting(ids, availableIds);
}

export function toggleSelection(selectedIds: readonly ElementId[], id: ElementId, availableIds: ReadonlySet<ElementId>): ElementId[] {
  if (!availableIds.has(id)) return [...selectedIds];
  return selectedIds.includes(id) ? selectedIds.filter((selectedId) => selectedId !== id) : [...selectedIds, id];
}

export function clearSelection(): ElementId[] { return []; }

export function pruneSelection(selectedIds: readonly ElementId[], elementsById: Readonly<Record<ElementId, CanvasElement>>): ElementId[] {
  return uniqueExisting(selectedIds, new Set(Object.keys(elementsById)));
}

function uniqueExisting(ids: readonly ElementId[], availableIds: ReadonlySet<ElementId>): ElementId[] {
  const seen = new Set<ElementId>();
  return ids.filter((id) => availableIds.has(id) && !seen.has(id) && (seen.add(id), true));
}
