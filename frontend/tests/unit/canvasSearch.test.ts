import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CanvasElement, RoughStyle } from "../../src/canvas/model/elements";
import { findCanvasTextSearchMatches, getSearchableText } from "../../src/canvas/search/searchModel";
import { mapRichTextHighlightLeaves, renderShapeRichTextContent } from "../../src/editor/richText";

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

    expect(mapRichTextHighlightLeaves(document, "Alpha\nBeta", [{ start: 6, end: 10 }])).not.toBeNull();
    expect(mapRichTextHighlightLeaves(document, "Alpha changed Beta", [{ start: 14, end: 18 }])).toBeNull();
    expect(mapRichTextHighlightLeaves(document, "Alpha\nBeta", [{ start: 5, end: 7 }])).toBeNull();
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
      { content: "AlphaBeta\nItem", richContent },
      "shape-rich",
      { searchableText: "AlphaBeta\nItem", ranges: [{ start: 2, end: 8, isActive: true }] },
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
});
