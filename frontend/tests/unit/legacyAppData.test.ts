import { describe, expect, it } from "vitest";
import {
  fromLegacyAppData,
  toLegacyAppData,
  type LegacyAppData,
} from "../../src/canvas/persistence/legacyAppData";

const now = 1_786_185_600_000;
const source = "data:image/png;base64,AA==";

function legacy(blocks: LegacyAppData["blocks"]): LegacyAppData {
  return {
    blocks,
    folders: [{ id: "folder-1", name: "Folder" }],
    isDarkMode: false,
    pages: [{ folderId: "folder-1", id: "page-1", title: "Page" }],
  };
}

describe("legacy canvas persistence adapter", () => {
  it("converts plain and rich text while injecting scene defaults", () => {
    const result = fromLegacyAppData(legacy([
      { content: "plain", height: 80, id: "text-1", pageId: "page-1", width: 240, x: 10, y: 20 },
      {
        content: "rich", height: 80, id: "text-2", pageId: "page-1", width: 240, x: 20, y: 30,
        richContent: { type: "doc", content: [{ type: "paragraph" }] },
      },
    ]), now);

    expect(result.data.elements).toMatchObject([
      { type: "text", id: "text-1", content: "plain", zIndex: 0, opacity: 1, locked: false, rotation: 0, createdAt: now, updatedAt: now },
      { type: "text", id: "text-2", richContent: { type: "doc" }, zIndex: 1 },
    ]);
  });

  it("round-trips standalone image sources through the in-memory asset map", () => {
    const input = legacy([
      { content: "", height: 80, id: "image-1", imageData: source, imageName: "pixel.png", pageId: "page-1", width: 120, x: 10, y: 20 },
    ]);
    const result = fromLegacyAppData(input, now);
    const element = result.data.elements[0];

    expect(element).toMatchObject({ type: "image", assetId: "legacy-image:image-1", fileName: "pixel.png", naturalWidth: 120, naturalHeight: 80, fit: "contain" });
    expect(result.imageSourcesByAssetId.get("legacy-image:image-1")).toBe(source);
    expect(toLegacyAppData(result.data, result.imageSourcesByAssetId)).toEqual(input);
  });

  it("preserves mixed legacy content by splitting it and warning", () => {
    const result = fromLegacyAppData(legacy([
      { content: "keep me", height: 80, id: "mixed", imageData: source, imageName: "mixed.png", pageId: "page-1", width: 120, x: 10, y: 20 },
    ]), now);

    expect(result.data.elements).toMatchObject([
      { type: "text", id: "mixed", content: "keep me", zIndex: 0 },
      { type: "image", id: "mixed-image", assetId: "legacy-image:mixed-image", zIndex: 1 },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.imageSourcesByAssetId.get("legacy-image:mixed-image")).toBe(source);
  });

  it("fails closed when an image source is missing or an element is unsupported", () => {
    const result = fromLegacyAppData(legacy([
      { content: "", height: 80, id: "image-1", imageData: source, pageId: "page-1", width: 120, x: 10, y: 20 },
    ]), now);

    expect(toLegacyAppData(result.data, new Map())).toBeNull();
    expect(toLegacyAppData({
      ...result.data,
      elements: [{
        ...result.data.elements[0],
        type: "ink",
        points: [],
        brush: {
          kind: "pen",
          color: { kind: "fixed", value: "#000" },
          size: 1,
          opacity: 1,
          thinning: 0,
          smoothing: 0,
          streamline: 0,
          simulatePressure: true,
        },
      }] as unknown as typeof result.data.elements,
    }, result.imageSourcesByAssetId)).toBeNull();
  });

  it("rejects duplicate legacy block IDs before conversion", () => {
    expect(() => fromLegacyAppData(legacy([
      { content: "first", height: 80, id: "same", pageId: "page-1", width: 120, x: 0, y: 0 },
      { content: "second", height: 80, id: "same", pageId: "page-1", width: 120, x: 0, y: 0 },
    ]), now)).toThrow("duplicate block id: same");
  });

  it("allocates a collision-free split image ID and round-trips both sources", () => {
    const input = legacy([
      { content: "text", height: 80, id: "x", imageData: source, imageName: "mixed.png", pageId: "page-1", width: 120, x: 0, y: 0 },
      { content: "", height: 80, id: "x-image", imageData: "data:image/png;base64,BB==", imageName: "existing.png", pageId: "page-1", width: 100, x: 1, y: 1 },
    ]);
    const result = fromLegacyAppData(input, now);

    expect(result.data.elements.map((element) => element.id)).toEqual(["x", "x-image-2", "x-image"]);
    expect(result.imageSourcesByAssetId.get("legacy-image:x-image-2")).toBe(source);
    expect(result.imageSourcesByAssetId.get("legacy-image:x-image")).toBe("data:image/png;base64,BB==");
    expect(toLegacyAppData(result.data, result.imageSourcesByAssetId)).toEqual({
      ...input,
      blocks: [
        { ...input.blocks[0], imageData: undefined, imageName: undefined },
        { content: "", height: 80, id: "x-image-2", imageData: source, imageName: "mixed.png", pageId: "page-1", width: 120, x: 0, y: 0 },
        input.blocks[1],
      ],
    });
  });
});
