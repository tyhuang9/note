import type { CanvasElement, ShapeElement, TextElement } from "../model/elements";

export type CanvasTextSearchSource = "text" | "shape-text";

export type CanvasTextSearchMatch = Readonly<{
  elementId: string;
  source: CanvasTextSearchSource;
  start: number;
  end: number;
}>;

export function getSearchableText(element: CanvasElement): string | null {
  if (element.type === "text") return element.content;
  if (element.type === "shape" && element.text) return element.text.content;
  return null;
}

export function findCanvasTextSearchMatches(
  elements: readonly CanvasElement[],
  query: string,
): CanvasTextSearchMatch[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  return elements
    .map((element, sourceIndex) => ({ element, sourceIndex }))
    .filter((entry): entry is { element: TextElement | (ShapeElement & { text: NonNullable<ShapeElement["text"]> }); sourceIndex: number } => (
      entry.element.type === "text"
      || entry.element.type === "shape" && entry.element.text !== undefined
    ))
    .sort((first, second) => (
      first.element.y - second.element.y
      || first.element.x - second.element.x
      || first.element.zIndex - second.element.zIndex
      || first.sourceIndex - second.sourceIndex
      || first.element.id.localeCompare(second.element.id)
    ))
    .flatMap(({ element }) => {
      const searchableText = getSearchableText(element) ?? "";
      const normalizedText = searchableText.toLowerCase();
      const matches: CanvasTextSearchMatch[] = [];
      let start = normalizedText.indexOf(normalizedQuery);

      while (start !== -1) {
        matches.push({
          elementId: element.id,
          source: element.type === "text" ? "text" : "shape-text",
          start,
          end: start + normalizedQuery.length,
        });
        start = normalizedText.indexOf(normalizedQuery, start + normalizedQuery.length);
      }

      return matches;
    });
}
