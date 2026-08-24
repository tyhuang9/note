import type { CanvasElement, ConnectorElement, ShapeElement, TextElement } from "../model/elements";
import { getConnectorLabel } from "../model/connectorLabel";
import {
  hasRichTextRenderableSearchContent,
  projectRichTextForSearch,
} from "../../editor/richTextSearch";

export const MAX_CANVAS_SEARCH_MATCHES = 500;
export const MAX_CANVAS_SEARCH_MATCHES_PER_ELEMENT = 100;

export type CanvasTextSearchSource = "text" | "shape-text" | "connector-label";

export type CanvasTextSearchMatch = Readonly<{
  elementId: string;
  source: CanvasTextSearchSource;
  start: number;
  end: number;
}>;

export const EMPTY_CANVAS_SEARCH_RANGES: readonly CanvasTextSearchMatch[] = Object.freeze([]);

export function getCanvasSearchRangesForElement(
  matchesByElementId: ReadonlyMap<string, readonly CanvasTextSearchMatch[]>,
  elementId: string,
): readonly CanvasTextSearchMatch[] {
  return matchesByElementId.get(elementId) ?? EMPTY_CANVAS_SEARCH_RANGES;
}

export function getSearchableText(
  element: CanvasElement,
  projectRichText: typeof projectRichTextForSearch = projectRichTextForSearch,
): string | null {
  if (element.type === "text") {
    if (!element.richContent) return element.content;
    const projection = projectRichText(element.richContent);
    return projection && (!element.content.trim() || hasRichTextRenderableSearchContent(element.richContent))
      ? projection.text
      : element.content;
  }
  if (element.type === "shape" && element.text) {
    return element.text.richContent
      ? projectRichText(element.text.richContent)?.text ?? element.text.content
      : element.text.content;
  }
  if (element.type === "connector") return getConnectorLabel(element) ?? null;
  return null;
}

export function createCanvasSearchTextIndex(
  elements: readonly CanvasElement[],
  isActive: boolean,
  projectRichText: typeof projectRichTextForSearch = projectRichTextForSearch,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  if (!isActive) return index;
  for (const element of elements) {
    const text = getSearchableText(element, projectRichText);
    if (text !== null) index.set(element.id, text);
  }
  return index;
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
  searchableTextByElementId?: ReadonlyMap<string, string>,
): CanvasTextSearchResult {
  if (!query.trim()) return { matches: [], isTruncated: false };
  const matches: CanvasTextSearchMatch[] = [];
  let isTruncated = false;

  const ordered = elements
    .map((element, sourceIndex) => ({ element, sourceIndex }))
    .filter((entry): entry is { element: TextElement | (ShapeElement & { text: NonNullable<ShapeElement["text"]> }) | ConnectorElement; sourceIndex: number } => (
      entry.element.type === "text"
      || entry.element.type === "shape" && entry.element.text !== undefined
      || entry.element.type === "connector" && getConnectorLabel(entry.element) !== undefined
    ))
    .sort((first, second) => (
      searchSortY(first.element) - searchSortY(second.element)
      || searchSortX(first.element) - searchSortX(second.element)
      || first.element.zIndex - second.element.zIndex
      || first.sourceIndex - second.sourceIndex
      || first.element.id.localeCompare(second.element.id)
    ));
  for (let elementIndex = 0; elementIndex < ordered.length; elementIndex += 1) {
      const { element } = ordered[elementIndex];
      const searchableText = searchableTextByElementId
        ? searchableTextByElementId.get(element.id) ?? ""
        : getSearchableText(element) ?? "";
      const remainingGlobal = MAX_CANVAS_SEARCH_MATCHES - matches.length;
      const result = findTextSearchRanges(
        searchableText,
        query,
        Math.min(MAX_CANVAS_SEARCH_MATCHES_PER_ELEMENT, remainingGlobal),
      );
      for (const range of result.ranges) {
        matches.push({
          elementId: element.id,
          source: element.type === "text" ? "text" : element.type === "shape" ? "shape-text" : "connector-label",
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

function searchSortX(element: TextElement | ShapeElement | ConnectorElement) {
  return "x" in element ? element.x : element.start.kind === "free" ? element.start.x : 0;
}

function searchSortY(element: TextElement | ShapeElement | ConnectorElement) {
  return "y" in element ? element.y : element.start.kind === "free" ? element.start.y : 0;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
