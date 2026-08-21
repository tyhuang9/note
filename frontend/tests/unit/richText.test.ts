import { describe, expect, it } from "vitest";
import {
  cloneRichTextValue,
  getCanonicalRichTextDocument,
  hasTipTapRenderableContent,
  richTextToPlainText,
  MAX_EMBEDDED_RICH_IMAGE_BYTES,
  validateRichTextDocument,
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
});
