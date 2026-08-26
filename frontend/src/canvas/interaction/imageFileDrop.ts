import type { CanvasPoint } from "../../appTypes";

export type DroppedImageFile = Pick<File, "name" | "size" | "type">;

export type ImageFileDropResult<T extends DroppedImageFile = DroppedImageFile> = Readonly<{
  accepted: readonly T[];
  rejectedFileLimit: readonly T[];
  rejectedOversized: readonly T[];
  rejectedTotalBytes: readonly T[];
  rejectedUnsupported: readonly T[];
}>;

export const IMAGE_FILE_DROP_CASCADE_OFFSET = 24;
export const MAX_IMAGE_FILE_DROP_FILES = 20;
export const MAX_IMAGE_FILE_DROP_BYTES = 64 * 1024 * 1024;
export const EMPTY_IMAGE_FILE_DROP_ERROR = "No readable image files were found in this drop.";

export type ImageFileDropLimits = Readonly<{
  maxAssetBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}>;

type FileDropDataTransfer = Readonly<{
  files: ArrayLike<File>;
  items: Iterable<Pick<DataTransferItem, "getAsFile" | "kind">>;
  types: Iterable<string>;
}>;

/** True only for operating-system file drags, never for in-app page or tab transfers. */
export function hasExternalFileDrop(
  dataTransfer: FileDropDataTransfer | null,
): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;
  if (Array.from(dataTransfer.items).some((item) => item.kind === "file")) return true;
  return Array.from(dataTransfer.types).includes("Files");
}

/** Reads files from both browser implementations that populate `files` and ones that only expose items. */
export function getDroppedFiles(
  dataTransfer: Pick<FileDropDataTransfer, "files" | "items"> | null,
): File[] {
  if (!dataTransfer) return [];

  const files = Array.from(dataTransfer.files);
  if (files.length > 0) return files;

  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function classifyDroppedImageFiles<T extends DroppedImageFile>(
  files: readonly T[],
  limits: ImageFileDropLimits,
): ImageFileDropResult<T> {
  const accepted: T[] = [];
  const rejectedFileLimit: T[] = [];
  const rejectedOversized: T[] = [];
  const rejectedTotalBytes: T[] = [];
  const rejectedUnsupported: T[] = [];
  let acceptedBytes = 0;

  for (const file of files) {
    if (!file.type.toLowerCase().startsWith("image/")) {
      rejectedUnsupported.push(file);
    } else if (file.size > limits.maxAssetBytes) {
      rejectedOversized.push(file);
    } else if (accepted.length >= limits.maxFiles) {
      rejectedFileLimit.push(file);
    } else if (acceptedBytes + file.size > limits.maxTotalBytes) {
      rejectedTotalBytes.push(file);
    } else {
      accepted.push(file);
      acceptedBytes += file.size;
    }
  }

  return {
    accepted,
    rejectedFileLimit,
    rejectedOversized,
    rejectedTotalBytes,
    rejectedUnsupported,
  };
}

export function getImageFileDropError(
  result: Pick<
    ImageFileDropResult,
    "rejectedFileLimit" | "rejectedOversized" | "rejectedTotalBytes" | "rejectedUnsupported"
  >,
  limits: ImageFileDropLimits,
): string | null {
  const hasFileLimit = result.rejectedFileLimit.length > 0;
  const hasOversized = result.rejectedOversized.length > 0;
  const hasTotalBytes = result.rejectedTotalBytes.length > 0;
  const hasUnsupported = result.rejectedUnsupported.length > 0;

  if (hasFileLimit && hasTotalBytes) {
    return `You can drop up to ${limits.maxFiles} images totaling ${limits.maxTotalBytes / (1024 * 1024)} MiB at a time.`;
  }
  if (hasFileLimit) {
    return `You can drop up to ${limits.maxFiles} images at a time.`;
  }
  if (hasTotalBytes) {
    return `Dropped images exceed the ${limits.maxTotalBytes / (1024 * 1024)} MiB total size limit.`;
  }
  if (hasOversized && hasUnsupported) {
    return `Only image files up to ${limits.maxAssetBytes / (1024 * 1024)} MiB can be imported.`;
  }
  if (hasOversized) {
    return `Image exceeds the ${limits.maxAssetBytes / (1024 * 1024)} MiB size limit.`;
  }
  if (hasUnsupported) {
    return "Only image files can be imported.";
  }
  return null;
}

export function getImageFileDropPlacement(
  origin: CanvasPoint,
  index: number,
): CanvasPoint {
  const offset = index * IMAGE_FILE_DROP_CASCADE_OFFSET;
  return { x: origin.x + offset, y: origin.y + offset };
}
