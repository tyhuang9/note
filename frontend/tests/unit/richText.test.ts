import { describe, expect, it } from "vitest";
import {
  cloneRichTextValue,
  getCanonicalRichTextDocument,
  hasTipTapRenderableContent,
  richTextToPlainText,
} from "../../src/editor/richText";

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
});
