import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CanvasElement, RoughStyle } from "../../src/canvas/model/elements";
import {
  createCanvasSearchTextIndex,
  findCanvasTextSearchMatches,
  findCanvasTextSearchResult,
  findTextSearchRanges,
  getSearchableText,
  MAX_CANVAS_SEARCH_MATCHES,
  MAX_CANVAS_SEARCH_MATCHES_PER_ELEMENT,
} from "../../src/canvas/search/searchModel";
import { mapRichTextHighlightLeaves, renderShapeRichTextContent } from "../../src/editor/richText";
import { projectRichTextForSearch } from "../../src/editor/richTextSearch";

const style: RoughStyle = {
  roughness: 0.5,
  roundness: 0.5,
  seed: 1,
  strokeColor: { kind: "theme", token: "foreground" },
  strokeStyle: "solid",
  strokeWidth: 2,
};

function base<TType extends CanvasElement["type"]>(id: string, type: TType, x: number, y: number) {
  return {
    id,
    pageId: "page-1",
    type,
    x,
    y,
    width: 100,
    height: 80,
    rotation: 0,
    zIndex: 0,
    opacity: 1,
    locked: false,
    createdAt: 1,
    updatedAt: 1,
  } as const;
}

describe("canvas text search", () => {
  it("searches standalone and shape-owned text in deterministic visual order", () => {
    const elements: CanvasElement[] = [
      { ...base("text-lower", "text", 0, 200), backgroundMode: "surface", content: "Beta beta" },
      { ...base("shape-upper", "shape", 200, 10), shape: "rectangle", style, text: { content: "BETA" } },
      { ...base("shape-empty", "shape", 0, 0), shape: "ellipse", style },
    ];

    expect(getSearchableText(elements[0])).toBe("Beta beta");
    expect(getSearchableText(elements[2])).toBeNull();
    expect(findCanvasTextSearchMatches(elements, "beta")).toEqual([
      { elementId: "shape-upper", source: "shape-text", start: 0, end: 4 },
      { elementId: "text-lower", source: "text", start: 0, end: 4 },
      { elementId: "text-lower", source: "text", start: 5, end: 9 },
    ]);
  });

  it("does no rich projection work while search is inactive and projects each rich source once when active", () => {
    const richContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Needle" }] }],
    };
    const elements: CanvasElement[] = [
      { ...base("rich-text", "text", 0, 0), backgroundMode: "surface", content: "legacy", richContent },
      { ...base("rich-shape", "shape", 0, 100), shape: "rectangle", style, text: { content: "legacy", richContent } },
      { ...base("plain-text", "text", 0, 200), backgroundMode: "surface", content: "Needle" },
    ];
    let projectionCount = 0;
    const countingProjector: typeof projectRichTextForSearch = (document) => {
      projectionCount += 1;
      return projectRichTextForSearch(document);
    };

    const inactiveIndex = createCanvasSearchTextIndex(elements, false, countingProjector);
    expect(inactiveIndex.size).toBe(0);
    expect(projectionCount).toBe(0);

    const activeIndex = createCanvasSearchTextIndex(elements, true, countingProjector);
    expect(activeIndex.size).toBe(3);
    expect(projectionCount).toBe(2);
    expect(findCanvasTextSearchResult(elements, "needle", activeIndex).matches).toHaveLength(3);
    expect(projectionCount).toBe(2);
  });

  it("maps one match across differently marked text leaves without changing the tree", () => {
    const document = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "cross", marks: [{ type: "bold" }] },
          { type: "text", text: "mark", marks: [{ type: "italic" }] },
        ],
      }],
    };
    const snapshot = structuredClone(document);

    expect(mapRichTextHighlightLeaves(document, "crossmark", [{ start: 2, end: 8, isActive: true }])).toEqual([
      [
        { start: 0, end: 2, text: "cr", isHighlighted: false, isActive: false },
        { start: 2, end: 5, text: "oss", isHighlighted: true, isActive: true },
      ],
      [
        { start: 5, end: 8, text: "mar", isHighlighted: true, isActive: true },
        { start: 8, end: 9, text: "k", isHighlighted: false, isActive: false },
      ],
    ]);
    expect(document).toEqual(snapshot);
  });

  it("allows structural newlines but falls back on stale or malformed mirror mappings", () => {
    const document = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Alpha" }] },
        { type: "paragraph", content: [{ type: "text", text: "Beta" }] },
        { type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    };

    expect(projectRichTextForSearch(document)?.text).toBe("Alpha\nBeta\n");
    expect(mapRichTextHighlightLeaves(document, "Alpha\nBeta\n", [{ start: 6, end: 10 }])).not.toBeNull();
    expect(mapRichTextHighlightLeaves(document, "Alpha changed Beta", [{ start: 14, end: 18 }])).toBeNull();
    expect(mapRichTextHighlightLeaves(document, "Alpha\nBeta\n", [{ start: 4, end: 7 }])).not.toBeNull();
  });

  it("renders highlights inside the original rich tree and falls back to that tree on mirror mismatch", () => {
    const richContent = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            { type: "text", text: "Alpha", marks: [{ type: "bold" }] },
            { type: "text", text: "Beta", marks: [{ type: "italic" }] },
          ],
        },
        {
          type: "bulletList",
          content: [{
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }],
          }],
        },
        { type: "image", attrs: { src: "data:image/png;base64,AA==", alt: "Diagram" } },
      ],
    };
    const snapshot = structuredClone(richContent);
    const highlighted = renderToStaticMarkup(renderShapeRichTextContent(
      { content: "stale plain mirror", richContent },
      "shape-rich",
      { searchableText: "AlphaBeta\nItem\nDiagram", ranges: [{ start: 2, end: 8, isActive: true }] },
    ));

    expect(highlighted).toContain("<h2>");
    expect(highlighted).toContain("<strong>Al<mark");
    expect(highlighted).toContain("is-active-search-match");
    expect(highlighted).toContain("</mark></strong><em><mark");
    expect(highlighted).toContain("<ul><li><p>Item</p></li></ul>");
    expect(highlighted).toContain('<img alt="Diagram"');
    expect(highlighted).not.toContain("ProseMirror");

    const fallback = renderToStaticMarkup(renderShapeRichTextContent(
      { content: "stale mirror", richContent },
      "shape-rich-fallback",
      { searchableText: "stale mirror", ranges: [{ start: 0, end: 5, isActive: true }] },
    ));
    expect(fallback).toContain("<h2><strong>Alpha</strong><em>Beta</em></h2>");
    expect(fallback).not.toContain("<mark");
    expect(richContent).toEqual(snapshot);
  });

  it("projects structural separators and image alt text for the same search and render offsets", () => {
    const richContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "image", attrs: { src: "data:image/png;base64,AA==", alt: "Diagram" } },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    };
    const projection = projectRichTextForSearch(richContent);
    expect(projection?.text).toBe("Before\nDiagram\nAfter");
    const imageRange = findTextSearchRanges(projection?.text ?? "", "diagram", 10).ranges[0];
    const markup = renderToStaticMarkup(renderShapeRichTextContent(
      { content: "legacy mirror", richContent },
      "image-search",
      { searchableText: projection?.text ?? "", ranges: [{ ...imageRange, isActive: true }] },
    ));
    expect(markup).toContain("canvas-search-image-match is-active-search-match");
  });

  it("caps dense matches during scanning and keeps Unicode offsets on the original UTF-16 text", () => {
    const denseElements = Array.from({ length: 6 }, (_, index): CanvasElement => ({
      ...base(`dense-${index}`, "text", 0, index),
      backgroundMode: "surface",
      content: "a".repeat(1_000),
    }));
    const dense = findCanvasTextSearchResult(denseElements, "a");
    expect(dense.matches).toHaveLength(MAX_CANVAS_SEARCH_MATCHES);
    expect(dense.matches.filter((match) => match.elementId === "dense-0")).toHaveLength(MAX_CANVAS_SEARCH_MATCHES_PER_ELEMENT);
    expect(dense.isTruncated).toBe(true);

    const original = "İA 😀A e\u0301";
    const dottedI = findTextSearchRanges(original, "İa", 10).ranges[0];
    expect(original.slice(dottedI.start, dottedI.end)).toBe("İA");
    expect(findTextSearchRanges(original, "😀", 10).ranges[0]).toEqual({ start: 3, end: 5 });
    const grapheme = findTextSearchRanges(original, "e\u0301", 10).ranges[0];
    expect(original.slice(grapheme.start, grapheme.end)).toBe("e\u0301");
  });
});
