import type { CSSProperties, ReactNode } from "react";
import { Mark, Node as TiptapNode, mergeAttributes, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { RichTextValue } from "../canvas/model/elements";

export const MAX_RICH_TEXT_BYTES = 16 * 1024 * 1024;
export const MAX_RICH_TEXT_DEPTH = 64;
export const MAX_RICH_TEXT_NODES = 20_000;
export const MAX_RICH_TEXT_PLAIN_BYTES = 4 * 1024 * 1024;
export const MAX_EMBEDDED_RICH_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_RICH_TEXT_ATTRIBUTE_BYTES = 12 * 1024 * 1024;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|gif|webp);base64,([a-z\d+/]*={0,2})$/i;

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
    return [{
      tag: "img[src]",
      getAttrs: (node) => node instanceof HTMLElement && isSafeRichImageSource(node.getAttribute("src") ?? "")
        ? null
        : false,
    }];
  },

  renderHTML({ HTMLAttributes }) {
    const src = typeof HTMLAttributes.src === "string" && isSafeRichImageSource(HTMLAttributes.src)
      ? HTMLAttributes.src
      : undefined;
    return ["img", mergeAttributes(HTMLAttributes, { src })];
  },
});

function positiveNumberAttribute(element: HTMLElement, name: string) {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const richTextExtensions = [
  StarterKit.configure({
    link: {
      isAllowedUri: isSafeLinkHref,
      openOnClick: false,
      HTMLAttributes: { rel: "noopener noreferrer" },
    },
  }),
  TextStyle,
  RichImage,
];

export function isSafeLinkHref(href: string): boolean {
  if (!href || href.length > 8_192) return false;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

export function isSafeRichImageSource(src: string): boolean {
  if (!src || src.length > MAX_RICH_TEXT_BYTES) return false;
  if (/^https?:\/\//i.test(src)) {
    try {
      const url = new URL(src);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }
  const match = SAFE_DATA_IMAGE_PATTERN.exec(src);
  if (!match || match[2].length % 4 !== 0) return false;
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const decodedBytes = match[2].length / 4 * 3 - padding;
  return decodedBytes <= MAX_EMBEDDED_RICH_IMAGE_BYTES;
}

export function validateRichTextDocument(value: unknown): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "richContent cannot be serialized";
  }
  if (new TextEncoder().encode(serialized).length > MAX_RICH_TEXT_BYTES) {
    return "richContent exceeds the byte limit";
  }
  if (!isRecord(value) || value.type !== "doc") return "richContent root type must be doc";
  const totals = { attributeBytes: 0, nodeCount: 0, textBytes: 0 };
  return validateRichTextNode(value, null, 0, totals, "richContent");
}

function validateRichTextNode(
  node: Record<string, unknown>,
  parentType: string | null,
  depth: number,
  totals: { attributeBytes: number; nodeCount: number; textBytes: number },
  context: string,
): string | null {
  if (depth > MAX_RICH_TEXT_DEPTH) return `${context} exceeds the depth limit`;
  totals.nodeCount += 1;
  if (totals.nodeCount > MAX_RICH_TEXT_NODES) return `${context} exceeds the node limit`;
  const type = typeof node.type === "string" ? node.type : "";
  if (!isAllowedChild(parentType, type)) return `${context}.type '${type}' is not supported here`;
  const allowedKeys = new Set(["type", "attrs", "content", "marks", "text"]);
  if (Object.keys(node).some((key) => !allowedKeys.has(key))) return `${context} has an unknown field`;
  const attrsError = validateNodeAttrs(type, node.attrs, context);
  if (attrsError) return attrsError;
  if (node.attrs !== undefined) {
    totals.attributeBytes += utf8Length(JSON.stringify(node.attrs));
    if (totals.attributeBytes > MAX_RICH_TEXT_ATTRIBUTE_BYTES) return `${context}.attrs exceeds the aggregate attribute byte limit`;
  }
  if (type === "text") {
    if (typeof node.text !== "string") return `${context}.text must be a string`;
    if (!node.text) return `${context}.text must not be empty`;
    totals.textBytes += utf8Length(node.text);
    if (totals.textBytes > MAX_RICH_TEXT_PLAIN_BYTES) return `${context}.text exceeds the aggregate byte limit`;
    if (node.content !== undefined) return `${context}.content is not allowed`;
  } else if (node.text !== undefined) return `${context}.text is only valid on text nodes`;
  const marks = node.marks;
  if (marks !== undefined) {
    if (type !== "text") return `${context}.marks is only valid on text nodes`;
    if (!Array.isArray(marks) || marks.length > 32) return `${context}.marks is invalid`;
    const markTypes = new Set<string>();
    for (let index = 0; index < marks.length; index += 1) {
      const error = validateRichTextMark(marks[index], `${context}.marks[${index}]`);
      if (error) return error;
      const mark = marks[index] as Record<string, unknown>;
      if (markTypes.has(mark.type as string)) return `${context}.marks contains a duplicate mark`;
      markTypes.add(mark.type as string);
      if (mark.attrs !== undefined) {
        totals.attributeBytes += utf8Length(JSON.stringify(mark.attrs));
        if (totals.attributeBytes > MAX_RICH_TEXT_ATTRIBUTE_BYTES) return `${context}.marks exceeds the aggregate attribute byte limit`;
      }
    }
    if (markTypes.has("code") && markTypes.size > 1) return `${context}.marks cannot combine code with another mark`;
  }
  if (isLeafNode(type)) {
    if (node.content !== undefined) return `${context}.content is not allowed`;
    return null;
  }
  if (node.content !== undefined && !Array.isArray(node.content)) return `${context}.content must be an array`;
  const children = (node.content ?? []) as unknown[];
  if ((type === "doc" || type === "blockquote" || type === "bulletList" || type === "orderedList") && children.length === 0) return `${context}.content must not be empty`;
  if (type === "listItem" && (children.length === 0 || !isRecord(children[0]) || children[0].type !== "paragraph")) return `${context}.content must start with a paragraph`;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!isRecord(child)) return `${context}.content[${index}] must be an object`;
    const error = validateRichTextNode(child, type, depth + 1, totals, `${context}.content[${index}]`);
    if (error) return error;
  }
  return null;
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).length;
}

function isAllowedChild(parent: string | null, child: string) {
  if (parent === null) return child === "doc";
  if (parent === "doc" || parent === "blockquote") return isBlockNode(child);
  if (parent === "bulletList" || parent === "orderedList") return child === "listItem";
  if (parent === "listItem") return child === "paragraph" || isBlockNode(child);
  if (parent === "paragraph" || parent === "heading") return child === "text" || child === "hardBreak";
  if (parent === "codeBlock") return child === "text";
  return false;
}

function isBlockNode(type: string) {
  return ["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule", "image"].includes(type);
}

function isLeafNode(type: string) {
  return type === "text" || type === "image" || type === "hardBreak" || type === "horizontalRule";
}

function validateNodeAttrs(type: string, value: unknown, context: string): string | null {
  const attrs = value === undefined ? undefined : isRecord(value) ? value : null;
  if (attrs === null) return `${context}.attrs must be an object`;
  const allowed = type === "heading" ? ["level"]
    : type === "orderedList" ? ["start", "type"]
      : type === "codeBlock" ? ["language"]
        : type === "image" ? ["alt", "height", "src", "title", "width"]
          : [];
  if (attrs && Object.keys(attrs).some((key) => !allowed.includes(key))) return `${context}.attrs has an unknown field`;
  if (type === "heading" && (!attrs || !Number.isInteger(attrs.level) || Number(attrs.level) < 1 || Number(attrs.level) > 6)) return `${context}.attrs.level is invalid`;
  if (type === "orderedList" && attrs) {
    if (attrs.start !== undefined && (!Number.isInteger(attrs.start) || Number(attrs.start) < 1)) return `${context}.attrs.start is invalid`;
    if (attrs.type !== undefined && attrs.type !== null && typeof attrs.type !== "string") return `${context}.attrs.type is invalid`;
  }
  if (type === "codeBlock" && attrs?.language !== undefined && attrs.language !== null && (typeof attrs.language !== "string" || attrs.language.length > 100)) return `${context}.attrs.language is invalid`;
  if (type === "image") {
    if (!attrs || typeof attrs.src !== "string" || !isSafeRichImageSource(attrs.src)) return `${context}.attrs.src is unsafe`;
    for (const key of ["alt", "title"] as const) {
      const field = attrs[key];
      if (field !== undefined && field !== null && (typeof field !== "string" || field.length > 16_384)) return `${context}.attrs.${key} is invalid`;
    }
    for (const key of ["width", "height"] as const) {
      const field = attrs[key];
      if (field !== undefined && field !== null && (typeof field !== "number" || !Number.isFinite(field) || field <= 0 || field > 1_000_000)) return `${context}.attrs.${key} is invalid`;
    }
  }
  return null;
}

function validateRichTextMark(value: unknown, context: string): string | null {
  if (!isRecord(value) || typeof value.type !== "string") return `${context} must be a typed object`;
  if (Object.keys(value).some((key) => key !== "type" && key !== "attrs")) return `${context} has an unknown field`;
  if (!["bold", "italic", "strike", "underline", "code", "textStyle", "link"].includes(value.type)) return `${context}.type is not supported`;
  const attrs = value.attrs === undefined ? undefined : isRecord(value.attrs) ? value.attrs : null;
  if (attrs === null) return `${context}.attrs must be an object`;
  const allowed = value.type === "textStyle" ? ["fontFamily", "fontSize"]
    : value.type === "link" ? ["href", "target", "rel", "class", "title"] : [];
  if (attrs && Object.keys(attrs).some((key) => !allowed.includes(key))) return `${context}.attrs has an unknown field`;
  if (value.type === "textStyle" && attrs) {
    const family = attrs.fontFamily;
    if (family !== undefined && family !== null && (typeof family !== "string" || family.length > 256)) return `${context}.attrs.fontFamily is invalid`;
    const size = attrs.fontSize;
    if (size !== undefined && size !== null && (typeof size !== "string" || !/^(?:[8-9]|[1-8]\d|9[0-6])px$/.test(size))) return `${context}.attrs.fontSize is invalid`;
  }
  if (value.type === "link") {
    if (!attrs || typeof attrs.href !== "string" || !isSafeLinkHref(attrs.href)) return `${context}.attrs.href is unsafe`;
    for (const key of ["target", "rel", "class", "title"] as const) {
      const field = attrs[key];
      if (field !== undefined && field !== null && (typeof field !== "string" || field.length > 512)) return `${context}.attrs.${key} is invalid`;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  if (
    value.richContent
    && validateRichTextDocument(value.richContent) === null
    && (!value.content.trim() || hasTipTapRenderableContent(value.richContent))
  ) {
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
      if (!isSafeRichImageSource(src)) return null;
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
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        return isSafeLinkHref(href)
          ? <a href={href} key={markKey} rel="noopener noreferrer">{node}</a>
          : node;
      }
      default: return node;
    }
  }, text);
}
