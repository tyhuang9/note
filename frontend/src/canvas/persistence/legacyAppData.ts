import type { JSONContent } from "@tiptap/core";
import type { AppData, AppSessionState, Folder, Page } from "../../types";
import type { CanvasElement, ImageElement, TextElement } from "../model/elements";

export type LegacyTextBlock = {
  content: string;
  height: number;
  id: string;
  imageData?: string;
  imageName?: string;
  isWidthManuallyResized?: boolean;
  pageId: string;
  richContent?: JSONContent;
  width: number;
  x: number;
  y: number;
};

export type LegacyAppData = {
  blocks: LegacyTextBlock[];
  folders: Folder[];
  isDarkMode?: boolean;
  pages: Page[];
  sessionState?: AppSessionState;
};

export type LegacyLoadResult = {
  data: AppData;
  imageSourcesByAssetId: Map<string, string>;
  warnings: string[];
};

const imageAssetId = (elementId: string) => `legacy-image:${elementId}`;

function timestampNow(now: Date | number) {
  return now instanceof Date ? now.getTime() : now;
}

function hasMeaningfulText(block: LegacyTextBlock) {
  return Boolean(block.content.trim()) || Boolean(block.richContent?.content?.length);
}

function textElementFromLegacy(
  block: LegacyTextBlock,
  zIndex: number,
  timestamp: number,
): TextElement {
  return {
    content: block.content,
    createdAt: timestamp,
    height: block.height,
    id: block.id,
    isWidthManuallyResized: block.isWidthManuallyResized,
    locked: false,
    opacity: 1,
    pageId: block.pageId,
    richContent: block.richContent,
    rotation: 0,
    type: "text",
    updatedAt: timestamp,
    width: block.width,
    x: block.x,
    y: block.y,
    zIndex,
  };
}

function imageElementFromLegacy(
  block: LegacyTextBlock,
  id: string,
  zIndex: number,
  timestamp: number,
): ImageElement {
  return {
    assetId: imageAssetId(id),
    createdAt: timestamp,
    fileName: block.imageName ?? "image",
    fit: "contain",
    height: block.height,
    id,
    locked: false,
    naturalHeight: block.height,
    naturalWidth: block.width,
    opacity: 1,
    pageId: block.pageId,
    rotation: 0,
    type: "image",
    updatedAt: timestamp,
    width: block.width,
    x: block.x,
    y: block.y,
    zIndex,
  };
}

/** Converts the Rust-compatible `{ blocks }` payload into the runtime scene model. */
export function fromLegacyAppData(input: LegacyAppData, now: Date | number): LegacyLoadResult {
  const timestamp = timestampNow(now);
  const elements: CanvasElement[] = [];
  const imageSourcesByAssetId = new Map<string, string>();
  const warnings: string[] = [];
  const reservedIds = new Set<string>();

  for (const block of input.blocks) {
    if (reservedIds.has(block.id)) {
      throw new Error(`Legacy data contains duplicate block id: ${block.id}`);
    }
    reservedIds.add(block.id);
  }

  const allocateSplitImageId = (blockId: string) => {
    let suffix = 1;
    let id = `${blockId}-image`;
    while (reservedIds.has(id)) {
      suffix += 1;
      id = `${blockId}-image-${suffix}`;
    }
    reservedIds.add(id);
    return id;
  };

  for (const block of input.blocks) {
    if (!block.imageData) {
      elements.push(textElementFromLegacy(block, elements.length, timestamp));
      continue;
    }

    if (hasMeaningfulText(block)) {
      elements.push(textElementFromLegacy(block, elements.length, timestamp));
      const image = imageElementFromLegacy(
        block,
        allocateSplitImageId(block.id),
        elements.length,
        timestamp,
      );
      elements.push(image);
      imageSourcesByAssetId.set(image.assetId, block.imageData);
      warnings.push(`Legacy block ${block.id} contained both text and an image; it was split into separate elements.`);
      continue;
    }

    const image = imageElementFromLegacy(block, block.id, elements.length, timestamp);
    elements.push(image);
    imageSourcesByAssetId.set(image.assetId, block.imageData);
  }

  return {
    data: {
      elements,
      folders: input.folders.map((folder) => ({ ...folder })),
      isDarkMode: input.isDarkMode,
      pages: input.pages.map((page) => ({ ...page })),
      sessionState: input.sessionState,
    },
    imageSourcesByAssetId,
    warnings,
  };
}

/**
 * Converts a scene back to the Rust-compatible shape. The conversion is all-or-nothing:
 * any unsupported element or unavailable image source causes the entire save to fail.
 */
export function toLegacyAppData(
  data: AppData,
  imageSourcesByAssetId: ReadonlyMap<string, string>,
): LegacyAppData | null {
  const blocks: LegacyTextBlock[] = [];

  for (const element of [...data.elements].sort((first, second) => first.zIndex - second.zIndex)) {
    if (element.type === "text") {
      blocks.push({
        content: element.content,
        height: element.height,
        id: element.id,
        isWidthManuallyResized: element.isWidthManuallyResized,
        pageId: element.pageId,
        richContent: element.richContent,
        width: element.width,
        x: element.x,
        y: element.y,
      });
      continue;
    }

    if (element.type === "image") {
      const imageData = imageSourcesByAssetId.get(element.assetId);
      if (!imageData) {
        return null;
      }
      blocks.push({
        content: "",
        height: element.height,
        id: element.id,
        imageData,
        imageName: element.fileName,
        pageId: element.pageId,
        width: element.width,
        x: element.x,
        y: element.y,
      });
      continue;
    }

    return null;
  }

  return {
    blocks,
    folders: data.folders.map((folder) => ({ ...folder })),
    isDarkMode: data.isDarkMode,
    pages: data.pages.map((page) => ({ ...page })),
    sessionState: data.sessionState,
  };
}
