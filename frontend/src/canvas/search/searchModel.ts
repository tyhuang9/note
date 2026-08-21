import type { CanvasElement, ShapeElement, TextElement } from "../model/elements";
import {
  hasRichTextRenderableSearchContent,
  projectRichTextForSearch,
} from "../../editor/richTextSearch";

export const MAX_CANVAS_SEARCH_MATCHES = 500;
export const MAX_CANVAS_SEARCH_MATCHES_PER_ELEMENT = 100;

export type CanvasTextSearchSource = "text" | "shape-text";

export type CanvasTextSearchMatch = Readonly<{
  elementId: string;
  source: CanvasTextSearchSource;
  start: number;
  end: number;
}>;

export function getSearchableText(element: CanvasElement): string | null {
  if (element.type === "text") {
    if (!element.richContent) return element.content;
    const projection = projectRichTextForSearch(element.richContent);
    return projection && (!element.content.trim() || hasRichTextRenderableSearchContent(element.richContent))
      ? projection.text
      : element.content;
  }
  if (element.type === "shape" && element.text) {
    return element.text.richContent
      ? projectRichTextForSearch(element.text.richContent)?.text ?? element.text.content
      : element.text.content;
  }
  return null;
}

export type CanvasTextSearchResult = Readonly<{
  matches: CanvasTextSearchMatch[];
  isTruncated: boolean;
}>;

export type TextSearchRangeResult = Readonly<{
  ranges: ReadonlyArray<Readonly<{ start: number; end: number }>>;
  isTruncated: boolean;
}>;

export function findTextSearchRanges(text: string, query: string, limit: number): TextSearchRangeResult {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || limit <= 0) return { ranges: [], isTruncated: false };
  const pattern = new RegExp(escapeRegExp(trimmedQuery), "giu");
  const ranges: Array<{ start: number; end: number }> = [];
  let match = pattern.exec(text);
  while (match && ranges.length < limit) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  return { ranges, isTruncated: match !== null };
}

export function findCanvasTextSearchMatches(
  elements: readonly CanvasElement[],
  query: string,
): CanvasTextSearchMatch[] {
  return findCanvasTextSearchResult(elements, query).matches;
}

export function findCanvasTextSearchResult(
  elements: readonly CanvasElement[],
  query: string,
): CanvasTextSearchResult {
  if (!query.trim()) return { matches: [], isTruncated: false };
  const matches: CanvasTextSearchMatch[] = [];
  let isTruncated = false;

  const ordered = elements
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
    ));
  for (let elementIndex = 0; elementIndex < ordered.length; elementIndex += 1) {
      const { element } = ordered[elementIndex];
      const searchableText = getSearchableText(element) ?? "";
      const remainingGlobal = MAX_CANVAS_SEARCH_MATCHES - matches.length;
      const result = findTextSearchRanges(
        searchableText,
        query,
        Math.min(MAX_CANVAS_SEARCH_MATCHES_PER_ELEMENT, remainingGlobal),
      );
      for (const range of result.ranges) {
        matches.push({
          elementId: element.id,
          source: element.type === "text" ? "text" : "shape-text",
          start: range.start,
          end: range.end,
        });
      }
      isTruncated ||= result.isTruncated;
      if (matches.length >= MAX_CANVAS_SEARCH_MATCHES) {
        isTruncated ||= elementIndex < ordered.length - 1;
        break;
      }
  }
  return { matches, isTruncated };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
