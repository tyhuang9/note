import type { CSSProperties, ReactNode } from "react";
import { Mark, Node as TiptapNode, mergeAttributes, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { RichTextValue } from "../canvas/model/elements";
import { projectRichTextForSearch } from "./richTextSearch";

export const MAX_RICH_TEXT_BYTES = 16 * 1024 * 1024;
export const MAX_RICH_TEXT_DEPTH = 64;
export const MAX_RICH_TEXT_NODES = 20_000;
export const MAX_RICH_TEXT_PLAIN_BYTES = 4 * 1024 * 1024;
export const MAX_EMBEDDED_RICH_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_RICH_TEXT_ATTRIBUTE_BYTES = 12 * 1024 * 1024;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|gif|webp);base64,([a-z\d+/]*={0,2})$/i;
const UNSAFE_URL_CHARACTER_PATTERN = /[\p{White_Space}\p{Cc}]/u;
const shapeRichTextRenderCache = new WeakMap<RichTextValue, Map<string, ReactNode>>();

export type RichTextHighlightRange = Readonly<{
  start: number;
  end: number;
  isActive?: boolean;
}>;

export type RichTextLeafSegment = Readonly<{
  start: number;
  end: number;
  text: string;
  isHighlighted: boolean;
  isActive: boolean;
}>;

export type RichTextHighlightOptions = Readonly<{
  searchableText: string;
  ranges: readonly RichTextHighlightRange[];
}>;

type RichTextHighlightMapping = Readonly<{
  images: readonly Readonly<{ isHighlighted: boolean; isActive: boolean; start: number; end: number }>[];
  leaves: RichTextLeafSegment[][];
}>;

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

function createRichImageExtension(mode: "legacy" | "shape") {
  return TiptapNode.create({
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
        getAttrs: (node) => mode === "legacy"
          || node instanceof HTMLElement && isSafeRichImageSource(node.getAttribute("src") ?? "")
          ? null
          : false,
      }];
    },

    renderHTML({ HTMLAttributes }) {
      const src = typeof HTMLAttributes.src === "string"
        && (mode === "legacy" || isSafeRichImageSource(HTMLAttributes.src))
        ? HTMLAttributes.src
        : undefined;
      return ["img", mergeAttributes(HTMLAttributes, { src })];
    },
  });
}

function positiveNumberAttribute(element: HTMLElement, name: string) {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const richTextExtensions = [StarterKit, TextStyle, createRichImageExtension("legacy")];
export const shapeRichTextExtensions = [
  StarterKit.configure({
    link: {
      isAllowedUri: isSafeLinkHref,
      openOnClick: false,
      HTMLAttributes: { rel: "noopener noreferrer" },
    },
  }),
  TextStyle,
  createRichImageExtension("shape"),
];

export function isSafeLinkHref(href: string): boolean {
  if (!href || utf8Length(href) > 8_192 || UNSAFE_URL_CHARACTER_PATTERN.test(href)) return false;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

export function isSafeRichImageSource(src: string): boolean {
  if (!src || src.length > MAX_RICH_TEXT_BYTES) return false;
  const match = SAFE_DATA_IMAGE_PATTERN.exec(src);
  if (!match || match[2].length % 4 !== 0) return false;
  const payload = match[2];
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const lastDataCharacter = payload[payload.length - padding - 1];
  const lastValue = lastDataCharacter ? base64CharacterValue(lastDataCharacter) : 0;
  if (padding === 2 && (lastValue & 0b1111) !== 0) return false;
  if (padding === 1 && (lastValue & 0b11) !== 0) return false;
  const decodedBytes = payload.length / 4 * 3 - padding;
  return decodedBytes <= MAX_EMBEDDED_RICH_IMAGE_BYTES;
}

function base64CharacterValue(character: string) {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return character === "+" ? 62 : 63;
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
      if (field !== undefined && field !== null && (typeof field !== "string" || utf8Length(field) > 16_384)) return `${context}.attrs.${key} is invalid`;
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
  if (value.type === "textStyle") {
    if (!attrs) return `${context}.attrs must be an object`;
    const family = attrs.fontFamily;
    if (family !== undefined && family !== null && (typeof family !== "string" || utf8Length(family) > 256)) return `${context}.attrs.fontFamily is invalid`;
    const size = attrs.fontSize;
    if (size !== undefined && size !== null && (typeof size !== "string" || !/^(?:[8-9]|[1-8]\d|9[0-6])px$/.test(size))) return `${context}.attrs.fontSize is invalid`;
  }
  if (value.type === "link") {
    if (!attrs || typeof attrs.href !== "string" || !isSafeLinkHref(attrs.href)) return `${context}.attrs.href is unsafe`;
    for (const key of ["target", "rel", "class", "title"] as const) {
      const field = attrs[key];
      if (field !== undefined && field !== null && (typeof field !== "string" || utf8Length(field) > 512)) return `${context}.attrs.${key} is invalid`;
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
    && (!value.content.trim() || hasTipTapRenderableContent(value.richContent))
  ) {
    return value.richContent;
  }
  return plainTextToTipTapDoc(value.content);
}

export function getCanonicalShapeRichTextDocument(value: RichTextValue): JSONContent {
  return value.richContent && validateRichTextDocument(value.richContent) === null
    ? value.richContent
    : plainTextToTipTapDoc(value.content);
}

export function richTextToPlainText(content: JSONContent): string {
  const lines: string[] = [];
  collectPlainText(content, lines);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function getShapeTextAccessibleExcerpt(value: RichTextValue, maximumLength = 120) {
  const label = richTextToPlainText(getCanonicalShapeRichTextDocument(value))
    .trim()
    .replace(/\s+/g, " ");
  if (label.length <= maximumLength) return label;
  return `${label.slice(0, Math.max(0, maximumLength - 3)).trimEnd()}...`;
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
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
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

export function renderRichTextContent(
  value: RichTextValue,
  key = "root",
  highlights?: RichTextHighlightOptions,
): ReactNode {
  try {
    const document = getCanonicalRichTextDocument(value);
    return renderTipTapContent(document, key, "legacy", createHighlightRenderPlan(document, highlights));
  } catch {
    return value.content.split("\n").map((line, index) => (
      <p key={`${key}-fallback-${index}`}>{line || <br />}</p>
    ));
  }
}

export function renderShapeRichTextContent(
  value: RichTextValue,
  key = "root",
  highlights?: RichTextHighlightOptions,
): ReactNode {
  const document = getCanonicalShapeRichTextDocument(value);
  if (highlights) {
    return renderTipTapContent(document, key, "shape", createHighlightRenderPlan(document, highlights));
  }
  let cachedByKey = shapeRichTextRenderCache.get(value);
  if (!cachedByKey) {
    cachedByKey = new Map();
    shapeRichTextRenderCache.set(value, cachedByKey);
  }
  if (!cachedByKey.has(key)) {
    cachedByKey.set(key, renderTipTapContent(document, key, "shape"));
  }
  return cachedByKey.get(key);
}

/**
 * Maps presentation-only search ranges onto existing rich-text leaves. The
 * document and its plain-text mirror are never repaired or normalized. If the
 * mirror cannot be mapped exactly (apart from structural whitespace between
 * leaves), callers must render the original rich document without highlights.
 */
export function mapRichTextHighlightLeaves(
  document: JSONContent,
  searchableText: string,
  ranges: readonly RichTextHighlightRange[],
): RichTextLeafSegment[][] | null {
  return mapRichTextHighlights(document, searchableText, ranges)?.leaves ?? null;
}

function mapRichTextHighlights(
  document: JSONContent,
  searchableText: string,
  ranges: readonly RichTextHighlightRange[],
): RichTextHighlightMapping | null {
  const projection = projectRichTextForSearch(document);
  if (!projection || projection.text !== searchableText) return null;
  const normalizedRanges = [...ranges].sort((first, second) => first.start - second.start);
  if (normalizedRanges.some((range, index) => (
    Number.isInteger(range.start)
    && Number.isInteger(range.end)
    && range.start >= 0
    && range.end > range.start
    && range.end <= searchableText.length
    && (index === 0 || normalizedRanges[index - 1].end <= range.start)
  ) === false)) return null;

  const leaves: RichTextLeafSegment[][] = [];
  const images: Array<{ isHighlighted: boolean; isActive: boolean; start: number; end: number }> = [];
  let rangeIndex = 0;
  for (const token of projection.tokens) {
    while (normalizedRanges[rangeIndex]?.end <= token.start) rangeIndex += 1;
    if (token.kind === "separator") continue;
    if (token.kind === "image-alt") {
      let imageRangeIndex = rangeIndex;
      let isHighlighted = false;
      let isActive = false;
      while (normalizedRanges[imageRangeIndex]?.start < token.end) {
        const range = normalizedRanges[imageRangeIndex];
        if (range.end > token.start) {
          isHighlighted = true;
          isActive ||= range.isActive === true;
        }
        imageRangeIndex += 1;
      }
      images.push({ start: token.start, end: token.end, isHighlighted, isActive });
      continue;
    }
    const segments: RichTextLeafSegment[] = [];
    let cursor = token.start;
    let localRangeIndex = rangeIndex;
    while (normalizedRanges[localRangeIndex]?.start < token.end) {
      const range = normalizedRanges[localRangeIndex];
      const start = Math.max(cursor, range.start, token.start);
      const end = Math.min(token.end, range.end);
      if (start > cursor) segments.push({ start: cursor, end: start, text: token.text.slice(cursor - token.start, start - token.start), isHighlighted: false, isActive: false });
      if (end > start) segments.push({ start, end, text: token.text.slice(start - token.start, end - token.start), isHighlighted: true, isActive: range.isActive === true });
      cursor = Math.max(cursor, end);
      localRangeIndex += 1;
    }
    if (cursor < token.end) segments.push({ start: cursor, end: token.end, text: token.text.slice(cursor - token.start), isHighlighted: false, isActive: false });
    leaves.push(segments);
  }
  return { images, leaves };
}

type HighlightRenderPlan = {
  imageIndex: number;
  images: RichTextHighlightMapping["images"];
  leafIndex: number;
  leaves: RichTextLeafSegment[][];
};

function createHighlightRenderPlan(
  document: JSONContent,
  highlights?: RichTextHighlightOptions,
): HighlightRenderPlan | undefined {
  if (!highlights || highlights.ranges.length === 0) return undefined;
  const mapping = mapRichTextHighlights(document, highlights.searchableText, highlights.ranges);
  return mapping ? { imageIndex: 0, images: mapping.images, leafIndex: 0, leaves: mapping.leaves } : undefined;
}

function renderTipTapContent(
  content: JSONContent,
  key: string,
  mode: "legacy" | "shape",
  highlightPlan?: HighlightRenderPlan,
): ReactNode {
  if (content.type === "text") {
    const segments = highlightPlan?.leaves[highlightPlan.leafIndex++];
    const text = segments ? renderHighlightedLeaf(segments, key) : content.text ?? "";
    return renderTextMarks(text, content.marks ?? [], key, mode);
  }
  const children = content.content?.map((child, index) => renderTipTapContent(child, `${key}-${index}`, mode, highlightPlan));
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
      const imageHighlight = highlightPlan?.images[highlightPlan.imageIndex++];
      const src = typeof content.attrs?.src === "string" ? content.attrs.src : "";
      if (!src || mode === "shape" && !isSafeRichImageSource(src)) return null;
      const alt = typeof content.attrs?.alt === "string" ? content.attrs.alt : "Pasted image";
      const title = typeof content.attrs?.title === "string" ? content.attrs.title : undefined;
      const width = Number(content.attrs?.width);
      const height = Number(content.attrs?.height);
      const className = `text-block-rich-image${imageHighlight?.isHighlighted ? " canvas-search-image-match" : ""}${imageHighlight?.isActive ? " is-active-search-match" : ""}`;
      return <img alt={alt} className={className} height={Number.isFinite(height) && height > 0 ? height : undefined} key={key} src={src} title={title} width={Number.isFinite(width) && width > 0 ? width : undefined} />;
    }
    case "hardBreak": return <br key={key} />;
    case "horizontalRule": return <hr key={key} />;
    default: return children;
  }
}

function renderHighlightedLeaf(segments: readonly RichTextLeafSegment[], key: string): ReactNode {
  return segments.map((segment, index) => segment.isHighlighted ? (
    <mark
      className={`canvas-search-match${segment.isActive ? " is-active-search-match" : ""}`}
      data-search-end={segment.end}
      data-search-start={segment.start}
      key={`${key}-highlight-${index}`}
    >
      {segment.text}
    </mark>
  ) : (
    segment.text
  ));
}

function renderTextMarks(
  text: ReactNode,
  marks: NonNullable<JSONContent["marks"]>,
  key: string,
  mode: "legacy" | "shape",
) {
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
        return mode === "shape" && isSafeLinkHref(href)
          ? <span className="shape-text-link" key={markKey}>{node}</span>
          : node;
      }
      default: return node;
    }
  }, text);
}
