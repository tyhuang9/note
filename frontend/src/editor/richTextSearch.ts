import type { JSONContent } from "@tiptap/core";

export type RichTextSearchToken = Readonly<{
  kind: "text" | "separator" | "image-alt";
  start: number;
  end: number;
  text: string;
}>;

export type RichTextSearchProjection = Readonly<{
  text: string;
  tokens: readonly RichTextSearchToken[];
}>;

const SEPARATING_PARENTS = new Set(["doc", "blockquote", "bulletList", "orderedList", "listItem"]);

export function hasRichTextRenderableSearchContent(content: JSONContent): boolean {
  if (content.type === "text") return Boolean(content.text?.trim());
  if (content.type === "image") return typeof content.attrs?.src === "string";
  if (content.type === "horizontalRule") return true;
  return content.content?.some(hasRichTextRenderableSearchContent) ?? false;
}

/** Builds a read-only, deterministic search view without repairing the source JSON. */
export function projectRichTextForSearch(document: JSONContent): RichTextSearchProjection | null {
  if (!document || document.type !== "doc") return null;
  const parts: string[] = [];
  const pending: Array<{ kind: RichTextSearchToken["kind"]; text: string }> = [];

  function visit(node: JSONContent): boolean {
    if (!node || typeof node.type !== "string") return false;
    if (node.type === "text") {
      if (typeof node.text !== "string") return false;
      if (node.text) pending.push({ kind: "text", text: node.text });
      return true;
    }
    if (node.type === "hardBreak" || node.type === "horizontalRule") {
      pending.push({ kind: "separator", text: "\n" });
      return true;
    }
    if (node.type === "image") {
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      pending.push({ kind: "image-alt", text: alt });
      return true;
    }
    if (!Array.isArray(node.content)) return node.type === "paragraph";
    for (let index = 0; index < node.content.length; index += 1) {
      if (index > 0 && SEPARATING_PARENTS.has(node.type)) {
        pending.push({ kind: "separator", text: "\n" });
      }
      if (!visit(node.content[index])) return false;
    }
    return true;
  }

  if (!visit(document)) return null;
  const tokens: RichTextSearchToken[] = [];
  let offset = 0;
  for (const token of pending) {
    const start = offset;
    parts.push(token.text);
    offset += token.text.length;
    tokens.push({ ...token, start, end: offset });
  }
  return { text: parts.join(""), tokens };
}
