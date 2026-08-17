import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AppData, AppSessionState, Folder, Page } from "../../types";
import type { CanvasElement, ConnectorElement, RoughStyle, ShapeElement } from "../model/elements";
import {
  isBindableShape,
  isSafeCanvasCoordinate,
  isSafeCanvasDimension,
  isSafeCanvasRotation,
  MAX_CANVAS_VALUE,
  resolveConnectorEndpoint,
} from "../model/connectorBinding";

export const MAX_ASSET_BYTES = 16 * 1024 * 1024;

export type StoragePage = Page & { revision: number };

export type WorkspaceData = {
  folders: Folder[];
  pages: StoragePage[];
  elements: CanvasElement[];
  isDarkMode?: boolean;
  sessionState?: AppSessionState;
  warnings: string[];
};

export type StorageDiagnostics = {
  databasePath: string;
  schemaVersion: number;
  importedLegacyData: boolean;
  backupPath?: string;
  warnings: string[];
};

export type SceneChangeBatch = {
  pageId: string;
  baseRevision: number;
  upserts: CanvasElement[];
  deletedElementIds: string[];
};

export type SceneChangeResult = { pageId: string; newRevision: number };

export type WorkspaceStructure = Pick<AppData, "folders"> & {
  pages: Page[];
  isDarkMode?: boolean;
};

export type WorkspaceStructureResult = { pages: StoragePage[] };

export type SaveAssetRequest = {
  dataBase64: string;
  mediaType: string;
  fileName?: string;
  naturalWidth?: number;
  naturalHeight?: number;
};

export type Asset = {
  id: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  naturalWidth?: number;
  naturalHeight?: number;
  dataBase64?: string;
};

export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export type SceneRepository = {
  initializeStorage(): Promise<StorageDiagnostics>;
  loadWorkspace(): Promise<WorkspaceData>;
  reconcileWorkspaceStructure(
    structure: WorkspaceStructure,
  ): Promise<WorkspaceStructureResult>;
  applySceneChanges(batch: SceneChangeBatch): Promise<SceneChangeResult>;
  saveAsset(request: SaveAssetRequest): Promise<Asset>;
  loadAsset(assetId: string): Promise<Asset>;
  saveSessionState(state: AppSessionState): Promise<void>;
};

/** Typed boundary for all SQLite Tauri calls. React components never issue SQL. */
export function createSceneRepository(invoke: Invoke = tauriInvoke): SceneRepository {
  return {
    initializeStorage: () => invoke<StorageDiagnostics>("initialize_storage"),
    loadWorkspace: async () => {
      const workspace = await invoke<WorkspaceData>("load_workspace_data");
      return { ...workspace, elements: normalizeLoadedCanvasElements(workspace.elements) };
    },
    reconcileWorkspaceStructure: (structure) =>
      invoke<WorkspaceStructureResult>("reconcile_workspace_structure", { structure }),
    applySceneChanges: (batch) =>
      invoke<SceneChangeResult>("apply_scene_changes", { batch }),
    saveAsset: (request) => invoke<Asset>("save_asset", { request }),
    loadAsset: (assetId) => invoke<Asset>("load_asset", { assetId }),
    saveSessionState: (state) => invoke<void>("save_session_state", { state }),
  };
}

/** Fills style fields that predate primitive styling without weakening write validation. */
export function normalizeLoadedCanvasElement(element: CanvasElement): CanvasElement {
  if (element.type === "shape") {
    const style = (element as ShapeElement & { style?: Partial<RoughStyle> }).style;
    return { ...element, style: normalizeRoughStyle(style, element.id) };
  }
  if (element.type === "connector") {
    const style = (element as ConnectorElement & {
      style?: Partial<ConnectorElement["style"]>;
    }).style;
    return {
      ...element,
      style: {
        ...normalizeRoughStyle(style, element.id),
        endArrowhead: style?.endArrowhead ?? "none",
        startArrowhead: style?.startArrowhead ?? "none",
      },
    };
  }
  return element;
}

function normalizeLoadedCanvasElements(elements: readonly CanvasElement[]): CanvasElement[] {
  const safeElements = elements
    .map(normalizeLoadedCanvasElement)
    .filter(hasSafeLoadedGeometry);
  const elementsById = Object.fromEntries(safeElements.map((element) => [element.id, element]));
  return safeElements.map((element) => {
    if (element.type !== "connector") return element;
    return {
      ...element,
      start: normalizeLoadedConnectorEndpoint(element.start, element, elementsById),
      end: normalizeLoadedConnectorEndpoint(element.end, element, elementsById),
    };
  });
}

function hasSafeLoadedGeometry(element: CanvasElement): boolean {
  if (element.type === "connector") return true;
  return isSafeCanvasCoordinate(element.x)
    && isSafeCanvasCoordinate(element.y)
    && isSafeCanvasDimension(element.width)
    && isSafeCanvasDimension(element.height)
    && isSafeCanvasRotation(element.rotation);
}

function normalizeLoadedConnectorEndpoint(
  endpoint: unknown,
  connector: ConnectorElement,
  elementsById: Readonly<Record<string, CanvasElement>>,
): ConnectorElement["start"] {
  if (!isRecord(endpoint)) return { kind: "free", x: 0, y: 0 };
  if (endpoint.kind === "free") {
    return typeof endpoint.x === "number"
      && typeof endpoint.y === "number"
      && isSafeCanvasCoordinate(endpoint.x)
      && isSafeCanvasCoordinate(endpoint.y)
      ? { kind: "free", x: endpoint.x, y: endpoint.y }
      : { kind: "free", x: 0, y: 0 };
  }
  if (endpoint.kind === "element"
    && typeof endpoint.targetElementId === "string"
    && isRecord(endpoint.anchor)
    && typeof endpoint.anchor.t === "number"
    && Number.isFinite(endpoint.anchor.t)
    && endpoint.anchor.t >= 0
    && endpoint.anchor.t <= 1
    && typeof endpoint.gap === "number"
    && Number.isFinite(endpoint.gap)
    && endpoint.gap >= 0
    && endpoint.gap <= MAX_CANVAS_VALUE) {
    const binding: Extract<ConnectorElement["start"], { kind: "element" }> = {
      anchor: { t: endpoint.anchor.t },
      gap: endpoint.gap,
      kind: "element",
      targetElementId: endpoint.targetElementId,
    };
    const target = elementsById[binding.targetElementId];
    if (
      connector.style.endArrowhead === "arrow"
      && target?.pageId === connector.pageId
      && isBindableShape(target)
    ) return binding;
    const resolved = resolveConnectorEndpoint(binding, elementsById, connector.pageId);
    return { kind: "free", ...(resolved ?? { x: 0, y: 0 }) };
  }
  return { kind: "free", x: 0, y: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAssetBlobWithinLimit(blob: Pick<Blob, "size">): boolean {
  return blob.size <= MAX_ASSET_BYTES;
}

function normalizeRoughStyle(style: Partial<RoughStyle> | undefined, elementId: string): RoughStyle {
  return {
    fillColor: style?.fillColor ?? null,
    roughness: style?.roughness ?? 1.2,
    roundness: style?.roundness ?? 0,
    seed: style?.seed ?? stableSeed(elementId),
    strokeColor: style?.strokeColor ?? { kind: "theme", token: "foreground" },
    strokeStyle: style?.strokeStyle ?? "solid",
    strokeWidth: style?.strokeWidth ?? 2,
  };
}

function stableSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Converts a browser data URL to the bytes-only contract accepted by Rust. */
export function assetRequestFromDataUrl(
  dataUrl: string,
  details: Omit<SaveAssetRequest, "dataBase64" | "mediaType"> = {},
): SaveAssetRequest {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) {
    throw new Error("Standalone image data must be a base64 data URL.");
  }
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const decodedSize = Math.floor((match[2].length * 3) / 4) - padding;
  if (decodedSize > MAX_ASSET_BYTES) {
    throw new Error(`Image exceeds the ${MAX_ASSET_BYTES / (1024 * 1024)} MiB size limit.`);
  }
  return { ...details, dataBase64: match[2], mediaType: match[1].toLowerCase() };
}

export function assetDataUrl(asset: Asset): string {
  if (!asset.dataBase64) {
    throw new Error(`Asset ${asset.id} did not include image data.`);
  }
  return `data:${asset.mediaType};base64,${asset.dataBase64}`;
}
