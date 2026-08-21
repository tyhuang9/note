import type { CSSProperties, ReactNode } from "react";
import { Mark, Node as TiptapNode, mergeAttributes, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { RichTextValue } from "../canvas/model/elements";

const TextStyle = Mark.create({
  name: "textStyle",

  addAttributes() {
    return {
      fontFamily: {
        default: null,
        parseHTML: (element: HTMLElement) => element.style.fontFamily || null,
      },
      fontSize: {
        default: null,
        parseHTML: (element: HTMLElement) => element.style.fontSize || null,
      },
    };
  },

  parseHTML() {
    return [{
      tag: "span",
      getAttrs: (node) => node instanceof HTMLElement
        && (node.style.fontFamily || node.style.fontSize)
        ? null
        : false,
    }];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const attrs = mark.attrs as { fontFamily?: string | null; fontSize?: string | null };
    const style = [
      attrs.fontFamily ? `font-family: ${attrs.fontFamily}` : "",
      attrs.fontSize ? `font-size: ${attrs.fontSize}` : "",
    ].filter(Boolean).join("; ");
    return ["span", mergeAttributes(HTMLAttributes, style ? { style } : {}), 0];
  },
});

const RichImage = TiptapNode.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: false,
  selectable: true,

  addAttributes() {
    return {
      alt: { default: null },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => positiveNumberAttribute(element, "height"),
      },
      src: { default: null },
      title: { default: null },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => positiveNumberAttribute(element, "width"),
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },
});

function positiveNumberAttribute(element: HTMLElement, name: string) {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const richTextExtensions = [StarterKit, TextStyle, RichImage];

export function cloneRichTextValue(value: RichTextValue): RichTextValue {
  return {
    content: value.content,
    ...(value.richContent ? { richContent: structuredClone(value.richContent) } : {}),
  };
}

export function plainTextToTipTapDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : undefined,
    })),
  };
}

export function hasTipTapRenderableContent(content: JSONContent): boolean {
  if (content.type === "text") return Boolean(content.text?.trim());
  if (content.type === "image") return typeof content.attrs?.src === "string";
  if (content.type === "horizontalRule") return true;
  return content.content?.some(hasTipTapRenderableContent) ?? false;
}

export function getCanonicalRichTextDocument(value: RichTextValue): JSONContent {
  if (value.richContent && (!value.content.trim() || hasTipTapRenderableContent(value.richContent))) {
    return value.richContent;
  }
  return plainTextToTipTapDoc(value.content);
}

export function richTextToPlainText(content: JSONContent): string {
  const lines: string[] = [];
  collectPlainText(content, lines);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function collectPlainText(content: JSONContent, lines: string[]) {
  if (content.type === "text") {
    appendInline(lines, content.text ?? "");
    return;
  }
  if (content.type === "hardBreak") {
    lines.push("");
    return;
  }
  if (content.type === "image") {
    const alt = typeof content.attrs?.alt === "string" ? content.attrs.alt : "";
    if (alt) appendInline(lines, alt);
    return;
  }
  const isBlock = ["paragraph", "heading", "codeBlock", "blockquote", "listItem"].includes(content.type ?? "");
  const startLength = lines.length;
  content.content?.forEach((child) => collectPlainText(child, lines));
  if (isBlock && lines.length === startLength) lines.push("");
  if (isBlock && lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
}

function appendInline(lines: string[], text: string) {
  if (lines.length === 0) lines.push(text);
  else lines[lines.length - 1] += text;
}

export function renderRichTextContent(value: RichTextValue, key = "root"): ReactNode {
  try {
    return renderTipTapContent(getCanonicalRichTextDocument(value), key);
  } catch {
    return value.content.split("\n").map((line, index) => (
      <p key={`${key}-fallback-${index}`}>{line || <br />}</p>
    ));
  }
}

function renderTipTapContent(content: JSONContent, key: string): ReactNode {
  if (content.type === "text") return renderTextMarks(content.text ?? "", content.marks ?? [], key);
  const children = content.content?.map((child, index) => renderTipTapContent(child, `${key}-${index}`));
  switch (content.type) {
    case "doc": return children;
    case "paragraph": return <p key={key}>{children?.length ? children : <br />}</p>;
    case "bulletList": return <ul key={key}>{children}</ul>;
    case "orderedList": return <ol key={key}>{children}</ol>;
    case "listItem": return <li key={key}>{children}</li>;
    case "blockquote": return <blockquote key={key}>{children}</blockquote>;
    case "codeBlock": return <pre key={key}><code>{children}</code></pre>;
    case "heading": {
      const level = Number(content.attrs?.level);
      const Heading = `h${Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1}` as
        | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Heading key={key}>{children}</Heading>;
    }
    case "image": {
      const src = typeof content.attrs?.src === "string" ? content.attrs.src : "";
      if (!src) return null;
      const alt = typeof content.attrs?.alt === "string" ? content.attrs.alt : "Pasted image";
      const title = typeof content.attrs?.title === "string" ? content.attrs.title : undefined;
      const width = Number(content.attrs?.width);
      const height = Number(content.attrs?.height);
      return <img alt={alt} className="text-block-rich-image" height={Number.isFinite(height) && height > 0 ? height : undefined} key={key} src={src} title={title} width={Number.isFinite(width) && width > 0 ? width : undefined} />;
    }
    case "hardBreak": return <br key={key} />;
    case "horizontalRule": return <hr key={key} />;
    default: return children;
  }
}

function renderTextMarks(text: string, marks: NonNullable<JSONContent["marks"]>, key: string) {
  return marks.reduce<ReactNode>((node, mark, index) => {
    const markKey = `${key}-mark-${index}`;
    switch (mark.type) {
      case "bold": return <strong key={markKey}>{node}</strong>;
      case "italic": return <em key={markKey}>{node}</em>;
      case "strike": return <s key={markKey}>{node}</s>;
      case "underline": return <u key={markKey}>{node}</u>;
      case "code": return <code key={markKey}>{node}</code>;
      case "textStyle": {
        const style: CSSProperties = {};
        if (typeof mark.attrs?.fontFamily === "string") style.fontFamily = mark.attrs.fontFamily;
        if (typeof mark.attrs?.fontSize === "string") style.fontSize = mark.attrs.fontSize;
        return <span key={markKey} style={style}>{node}</span>;
      }
      default: return node;
    }
  }, text);
}
