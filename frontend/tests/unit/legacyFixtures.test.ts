import { describe, expect, it } from "vitest";
import type { LegacyAppData } from "../../src/canvas/persistence/legacyAppData";
import mixedTextImage from "../fixtures/legacy/mixed-text-image.json";
import plainText from "../fixtures/legacy/plain-text.json";
import richText from "../fixtures/legacy/rich-text.json";
import sessionViewport from "../fixtures/legacy/session-viewport.json";
import standaloneImage from "../fixtures/legacy/standalone-image.json";

const fixtures: Record<string, LegacyAppData> = {
  mixedTextImage,
  plainText,
  richText,
  sessionViewport,
  standaloneImage,
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);

    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }

  return value;
}

for (const fixture of Object.values(fixtures)) {
  deepFreeze(fixture);
}

function assertAppDataFixture(data: LegacyAppData) {
  expect(data).toEqual(expect.objectContaining({
    blocks: expect.any(Array),
    folders: expect.any(Array),
    pages: expect.any(Array),
  }));

  const pageIds = new Set(data.pages.map((page) => page.id));
  const folderIds = new Set(data.folders.map((folder) => folder.id));

  for (const page of data.pages) {
    expect(page.id).toEqual(expect.any(String));
    expect(page.folderId).toEqual(expect.any(String));
    expect(folderIds.has(page.folderId)).toBe(true);
  }

  for (const block of data.blocks) {
    expect(pageIds.has(block.pageId)).toBe(true);
    expect(block.id).toEqual(expect.any(String));
    expect(block.content).toEqual(expect.any(String));
    expect(block.width).toEqual(expect.any(Number));
    expect(block.height).toEqual(expect.any(Number));

    if (block.richContent) {
      expect(block.richContent.type).toBe("doc");
    }

    if (block.imageData) {
      expect(block.imageData.startsWith("data:image/")).toBe(true);
      expect(block.imageName).toEqual(expect.any(String));

      const [, encodedImage] = block.imageData.split(",", 2);
      const imageBytes = Uint8Array.from(atob(encodedImage), (character) =>
        character.charCodeAt(0),
      );

      expect(imageBytes.length).toBeGreaterThan(24);
      expect(Array.from(imageBytes.slice(0, 8))).toEqual([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]);
      expect(Array.from(imageBytes.slice(12, 16))).toEqual([
        0x49,
        0x48,
        0x44,
        0x52,
      ]);
    }
  }

  if (data.sessionState?.pageViewports) {
    for (const [pageId, viewport] of Object.entries(
      data.sessionState.pageViewports,
    )) {
      expect(pageIds.has(pageId)).toBe(true);
      expect(viewport.zoomLevel).toEqual(expect.any(Number));
      expect(viewport.panOffset.x).toEqual(expect.any(Number));
      expect(viewport.panOffset.y).toEqual(expect.any(Number));
    }
  }
}

describe("legacy AppData fixtures", () => {
  it("validate immutable text, image, viewport, and mixed-content snapshots", () => {
    for (const fixture of Object.values(fixtures)) {
      assertAppDataFixture(fixture);
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(Object.isFrozen(fixture.blocks)).toBe(true);
      expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
    }

    expect(
      fixtures.plainText.blocks.some(
        (block) => !block.richContent && !block.imageData,
      ),
    ).toBe(true);
    expect(fixtures.richText.blocks.some((block) => block.richContent)).toBe(true);
    expect(
      fixtures.standaloneImage.blocks.some((block) => block.imageData),
    ).toBe(true);
    expect(fixtures.sessionViewport.sessionState?.pageViewports).toBeDefined();
    expect(
      fixtures.mixedTextImage.blocks.some((block) => !block.imageData),
    ).toBe(true);
    expect(
      fixtures.mixedTextImage.blocks.some((block) => block.imageData),
    ).toBe(true);
  });
});
