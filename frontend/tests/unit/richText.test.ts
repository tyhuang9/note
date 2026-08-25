import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import {
  cloneRichTextValue,
  getCanonicalRichTextDocument,
  getCanonicalShapeRichTextDocument,
  getShapeTextAccessibleExcerpt,
  hasTipTapRenderableContent,
  richTextToPlainText,
  MAX_EMBEDDED_RICH_IMAGE_BYTES,
  renderShapeRichTextContent,
  validateRichTextDocument,
  richTextExtensions,
} from "../../src/editor/richText";
import vectors from "../../../tests/fixtures/rich-text-security-vectors.json";

describe("shared rich text model", () => {
  it("canonicalizes plain text without mutating its owner", () => {
    const value = { content: "First\nSecond" };
    expect(getCanonicalRichTextDocument(value)).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      ],
    });
    expect(value).toEqual({ content: "First\nSecond" });
  });

  it("preserves supported rich structure and flattens it for accessible text", () => {
    const richContent = {
      type: "doc",
      content: [{
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Important", marks: [{ type: "bold" }] }],
          }],
        }],
      }],
    };
    expect(getCanonicalRichTextDocument({ content: "Important", richContent })).toBe(richContent);
    expect(hasTipTapRenderableContent(richContent)).toBe(true);
    expect(richTextToPlainText(richContent)).toBe("Important\n");
  });

  it("builds a bounded accessible excerpt from canonical rich text and image alt", () => {
    const value = {
      content: "stale fallback that must not be announced",
      richContent: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Canonical label" }] },
          { type: "image", attrs: { src: "data:image/png;base64,AA==", alt: "Diagram description" } },
          { type: "paragraph", content: [{ type: "text", text: "x".repeat(200) }] },
        ],
      },
    };
    const excerpt = getShapeTextAccessibleExcerpt(value);
    expect(excerpt).toContain("Canonical label Diagram description");
    expect(excerpt).not.toContain("stale fallback");
    expect(excerpt).toHaveLength(120);
    expect(excerpt.endsWith("...")).toBe(true);
  });

  it("separates block image alt text from adjacent accessible text", () => {
    expect(richTextToPlainText({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "image", attrs: { src: "data:image/png;base64,AA==", alt: "Diagram" } },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    })).toBe("Before\nDiagram\nAfter\n");
  });

  it("deep-clones nested documents while preserving optional omission", () => {
    const unlabeled = { content: "" };
    expect(cloneRichTextValue(unlabeled)).toEqual({ content: "" });

    const original = {
      content: "Label",
      richContent: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Label" }] }],
      },
    };
    const clone = cloneRichTextValue(original);
    expect(clone).toEqual(original);
    expect(clone).not.toBe(original);
    expect(clone.richContent).not.toBe(original.richContent);
    expect(clone.richContent?.content?.[0]).not.toBe(original.richContent.content?.[0]);
  });

  it("matches the shared security grammar vectors", () => {
    for (const vector of vectors.valid) {
      expect(validateRichTextDocument(vector.doc), vector.name).toBeNull();
    }
    for (const vector of vectors.invalid) {
      expect(validateRichTextDocument(vector.doc), vector.name).not.toBeNull();
    }
  });

  it("memoizes shape rendering by owner text reference and invalidates copied JSON", () => {
    const value = {
      content: "Memoized",
      richContent: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Memoized" }] }],
      },
    };
    const first = renderShapeRichTextContent(value, "shape-text");
    expect(renderShapeRichTextContent(value, "shape-text")).toBe(first);
    expect(renderShapeRichTextContent(cloneRichTextValue(value), "shape-text")).not.toBe(first);
  });

  it("preserves legacy standalone rich JSON while strict shape mode rejects it", () => {
    const legacyRich = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "legacy", marks: [{ type: "link", attrs: { href: "custom:destination" } }, { type: "textStyle", attrs: { fontSize: "144px", legacy: true } }] }] },
        { type: "image", attrs: { src: "data:image/svg+xml;base64,PHN2Zz4=" } },
      ],
    };
    const value = { content: "legacy", richContent: legacyRich };
    expect(getCanonicalRichTextDocument(value)).toBe(legacyRich);
    expect(validateRichTextDocument(legacyRich)).not.toBeNull();
    expect(getCanonicalShapeRichTextDocument(value)).not.toBe(legacyRich);
  });

  it("round-trips the editor-default golden through the actual Tiptap schema", () => {
    const golden = vectors.valid[0].doc;
    expect(getSchema(richTextExtensions).nodeFromJSON(golden).toJSON()).toEqual(golden);
  });

  it("accepts the decoded embedded-image boundary and rejects one byte over", () => {
    const zeroBytesAsBase64 = (bytes: number) => {
      const remainder = bytes % 3;
      return `${"AAAA".repeat(Math.floor(bytes / 3))}${remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : ""}`;
    };
    const documentForBytes = (bytes: number) => ({
      type: "doc",
      content: [{
        type: "image",
        attrs: { src: `data:image/png;base64,${zeroBytesAsBase64(bytes)}` },
      }],
    });
    expect(validateRichTextDocument(documentForBytes(MAX_EMBEDDED_RICH_IMAGE_BYTES))).toBeNull();
    expect(validateRichTextDocument(documentForBytes(MAX_EMBEDDED_RICH_IMAGE_BYTES + 1))).not.toBeNull();
  });

  it("enforces aggregate text and attribute byte budgets", () => {
    const text = "x".repeat(3 * 1024 * 1024);
    expect(validateRichTextDocument({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text }] },
        { type: "paragraph", content: [{ type: "text", text }] },
      ],
    })).toContain("aggregate");

    const image = (bytes: number) => ({
      type: "image",
      attrs: { src: `data:image/png;base64,${"AAAA".repeat(Math.floor(bytes / 3))}` },
    });
    expect(validateRichTextDocument({ type: "doc", content: [image(5 * 1024 * 1024), image(5 * 1024 * 1024)] })).toContain("aggregate attribute");
  });
});
