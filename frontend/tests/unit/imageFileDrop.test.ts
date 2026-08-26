import { describe, expect, it } from "vitest";
import {
  classifyDroppedImageFiles,
  EMPTY_IMAGE_FILE_DROP_ERROR,
  getImageFileDropError,
  getImageFileDropPlacement,
  hasExternalFileDrop,
  MAX_IMAGE_FILE_DROP_BYTES,
  MAX_IMAGE_FILE_DROP_FILES,
} from "../../src/canvas/interaction/imageFileDrop";

const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const IMAGE_FILE_DROP_LIMITS = {
  maxAssetBytes: MAX_ASSET_BYTES,
  maxFiles: MAX_IMAGE_FILE_DROP_FILES,
  maxTotalBytes: MAX_IMAGE_FILE_DROP_BYTES,
};

describe("image file drop helpers", () => {
  it("claims external file transfers without claiming in-app text transfers", () => {
    expect(hasExternalFileDrop({ files: [], items: [], types: ["text/plain"] })).toBe(false);
    expect(hasExternalFileDrop({ files: [], items: [], types: ["application/x-note-page-drag"] })).toBe(false);
    expect(hasExternalFileDrop({ files: [], items: [], types: ["Files"] })).toBe(true);
  });

  it("accepts image MIME types and rejects unsupported or oversized files", () => {
    const result = classifyDroppedImageFiles([
      { name: "canvas.png", size: 20, type: "image/png" },
      { name: "notes.txt", size: 20, type: "text/plain" },
      { name: "large.jpg", size: MAX_ASSET_BYTES + 1, type: "image/jpeg" },
      { name: "misleading.png", size: 20, type: "" },
    ], IMAGE_FILE_DROP_LIMITS);

    expect(result.accepted.map((file) => file.name)).toEqual(["canvas.png"]);
    expect(result.rejectedUnsupported.map((file) => file.name)).toEqual([
      "notes.txt",
      "misleading.png",
    ]);
    expect(result.rejectedOversized.map((file) => file.name)).toEqual(["large.jpg"]);
    expect(getImageFileDropError(result, IMAGE_FILE_DROP_LIMITS)).toBe(
      "Only image files up to 16 MiB can be imported.",
    );
  });

  it("bounds accepted image count and total bytes in drop order before reading files", () => {
    const countLimited = classifyDroppedImageFiles(
      Array.from({ length: MAX_IMAGE_FILE_DROP_FILES + 1 }, (_, index) => ({
        name: `image-${index}.png`,
        size: 1,
        type: "image/png",
      })),
      IMAGE_FILE_DROP_LIMITS,
    );
    expect(countLimited.accepted).toHaveLength(MAX_IMAGE_FILE_DROP_FILES);
    expect(countLimited.rejectedFileLimit.map((file) => file.name)).toEqual(["image-20.png"]);
    expect(getImageFileDropError(countLimited, IMAGE_FILE_DROP_LIMITS)).toBe(
      "You can drop up to 20 images at a time.",
    );

    const byteLimited = classifyDroppedImageFiles([
      { name: "first.png", size: 1536 * 1024, type: "image/png" },
      { name: "second.png", size: 1536 * 1024, type: "image/png" },
    ], { maxAssetBytes: MAX_ASSET_BYTES, maxFiles: 20, maxTotalBytes: 2 * 1024 * 1024 });
    expect(byteLimited.accepted.map((file) => file.name)).toEqual(["first.png"]);
    expect(byteLimited.rejectedTotalBytes.map((file) => file.name)).toEqual(["second.png"]);
    expect(getImageFileDropError(byteLimited, {
      maxAssetBytes: MAX_ASSET_BYTES,
      maxFiles: 20,
      maxTotalBytes: 2 * 1024 * 1024,
    })).toBe("Dropped images exceed the 2 MiB total size limit.");
  });

  it("exposes a clear error for external transfers without readable files", () => {
    expect(EMPTY_IMAGE_FILE_DROP_ERROR).toBe("No readable image files were found in this drop.");
  });

  it("cascades multiple image placements from the drop position", () => {
    expect(getImageFileDropPlacement({ x: 150, y: 225 }, 0)).toEqual({ x: 150, y: 225 });
    expect(getImageFileDropPlacement({ x: 150, y: 225 }, 2)).toEqual({ x: 198, y: 273 });
  });
});
