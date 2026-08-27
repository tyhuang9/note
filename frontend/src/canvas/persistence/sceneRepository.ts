import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AppData, AppSessionState, Folder, Page } from "../../types";
import { isArrowConnector, type CanvasElement, type ConnectorElement, type RoughStyle, type ShapeElement } from "../model/elements";
import { isConnectorLabelStyle, normalizeConnectorLabel } from "../model/connectorLabel";
import { normalizeTextBackgroundMode } from "../model/textPreferences";
import {
  isSafeCanvasCoordinate,
  isSafeCanvasDimension,
  isSafeCanvasRotation,
  isBindableElement,
  isConnectorBindingPersistable,
  MAX_CANVAS_VALUE,
  resolveConnectorEndpoint,
  resolveConnectorPoints,
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

export type TrashEntry = {
  id: string;
  kind: "folder" | "page";
  name: string;
  trashedAt: number;
};

export type TrashPurgePreview = {
  confirmationToken: string;
  folderCount: number;
  pageCount: number;
  elementCount: number;
};

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
  movePageToTrash(pageId: string): Promise<void>;
  moveFolderToTrash(folderId: string): Promise<void>;
  restorePageFromTrash(pageId: string): Promise<void>;
  restoreFolderFromTrash(folderId: string): Promise<void>;
  listTrash(): Promise<TrashEntry[]>;
  getTrashPurgePreview(): Promise<TrashPurgePreview>;
  purgeTrash(preview: TrashPurgePreview): Promise<TrashPurgePreview>;
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
    movePageToTrash: (pageId) => invoke<void>("move_page_to_trash", { pageId }),
    moveFolderToTrash: (folderId) => invoke<void>("move_folder_to_trash", { folderId }),
    restorePageFromTrash: (pageId) => invoke<void>("restore_page_from_trash", { pageId }),
    restoreFolderFromTrash: (folderId) => invoke<void>("restore_folder_from_trash", { folderId }),
    listTrash: () => invoke<TrashEntry[]>("list_trash"),
    getTrashPurgePreview: () => invoke<TrashPurgePreview>("get_trash_purge_preview"),
    purgeTrash: (preview) => invoke<TrashPurgePreview>("purge_trash", {
      request: {
        confirmationToken: preview.confirmationToken,
        expectedFolderCount: preview.folderCount,
        expectedPageCount: preview.pageCount,
        expectedElementCount: preview.elementCount,
      },
    }),
  };
}

/** Fills style fields that predate primitive styling without weakening write validation. */
export function normalizeLoadedCanvasElement(element: CanvasElement): CanvasElement {
  if (element.type === "text") {
    const rawManualHeight = (element as typeof element & { manualHeight?: unknown }).manualHeight;
    const { manualHeight: _ignoredManualHeight, ...legacySafeElement } = element as typeof element & { manualHeight?: unknown };
    const manualHeight = typeof rawManualHeight === "number" && Number.isFinite(rawManualHeight) && rawManualHeight > 0
      ? rawManualHeight
      : undefined;
    return {
      ...legacySafeElement,
      backgroundMode: normalizeTextBackgroundMode(
        (element as typeof element & { backgroundMode?: unknown }).backgroundMode,
      ),
      ...(manualHeight === undefined ? {} : { manualHeight }),
    };
  }
  if (element.type === "shape") {
    const style = (element as ShapeElement & { style?: Partial<RoughStyle> }).style;
    return { ...element, style: normalizeRoughStyle(style, element.id) };
  }
  if (element.type === "connector") {
    const style = (element as ConnectorElement & {
      style?: Partial<ConnectorElement["style"]>;
    }).style;
    const rawSemantic = element.semantic;
    const label = normalizeConnectorLabel(rawSemantic?.label);
    const normalizedStyle: ConnectorElement["style"] = {
      ...normalizeRoughStyle(style, element.id),
      endArrowhead: style?.endArrowhead === "arrow" ? "arrow" : "none",
      startArrowhead: style?.startArrowhead === "arrow" ? "arrow" : "none",
    };
    const normalizedConnector = { ...element, style: normalizedStyle };
    const isArrow = isArrowConnector(normalizedConnector);
    const semantic = rawSemantic && typeof rawSemantic === "object"
      ? {
          ...(typeof rawSemantic.relationshipType === "string" ? { relationshipType: rawSemantic.relationshipType } : {}),
          ...(isArrow && label ? { label } : {}),
        }
      : undefined;
    const rawLabelStyle = (element as ConnectorElement & { labelStyle?: unknown }).labelStyle;
    return {
      ...normalizedConnector,
      ...(semantic && Object.keys(semantic).length > 0 ? { semantic } : { semantic: undefined }),
      ...(isArrow && isConnectorLabelStyle(rawLabelStyle) ? { labelStyle: rawLabelStyle } : { labelStyle: undefined }),
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
    const [start, end] = normalizeLoadedConnectorEndpoints(element, elementsById);
    return {
      ...element,
      start,
      end,
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

function normalizeLoadedConnectorEndpoints(
  connector: ConnectorElement,
  elementsById: Readonly<Record<string, CanvasElement>>,
): readonly [ConnectorElement["start"], ConnectorElement["end"]] {
  const start = normalizeLoadedConnectorEndpoint(connector.start, connector, elementsById);
  const end = normalizeLoadedConnectorEndpoint(connector.end, connector, elementsById);
  if (
    isArrowConnector(connector)
    && start.kind === "element"
    && end.kind === "element"
    && start.targetElementId === end.targetElementId
  ) {
    const rawStartEndpoint: unknown = connector.start;
    const rawEndEndpoint: unknown = connector.end;
    const rawStart = isRecord(rawStartEndpoint) && isRecord(rawStartEndpoint.anchor)
      ? { ...start, anchor: { t: rawStartEndpoint.anchor.t as number } }
      : null;
    const rawEnd = isRecord(rawEndEndpoint) && isRecord(rawEndEndpoint.anchor)
      ? { ...end, anchor: { t: rawEndEndpoint.anchor.t as number } }
      : null;
    if (rawStart && rawEnd) {
      const startPoint = resolveConnectorEndpoint(rawStart, elementsById, connector.pageId);
      const endPoint = resolveConnectorEndpoint(rawEnd, elementsById, connector.pageId);
      if (startPoint && endPoint) return [{ kind: "free", ...startPoint }, { kind: "free", ...endPoint }];
    }
    return [{ kind: "free", x: 0, y: 0 }, { kind: "free", x: 0, y: 0 }];
  }
  if (isArrowConnector(connector)) {
    const candidate = { ...connector, start, end };
    return isConnectorBindingPersistable(candidate, elementsById)
      ? [start, end]
      : [
        start.kind === "free" ? start : { kind: "free", x: 0, y: 0 },
        end.kind === "free" ? end : { kind: "free", x: 0, y: 0 },
      ];
  }
  const candidate = { ...connector, start, end };
  const points = resolveConnectorPoints(candidate, elementsById);
  return points
    ? [{ kind: "free", ...points.start }, { kind: "free", ...points.end }]
    : [
      start.kind === "free" ? start : { kind: "free", x: 0, y: 0 },
      end.kind === "free" ? end : { kind: "free", x: 0, y: 0 },
    ];
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
    && typeof endpoint.gap === "number"
    && Number.isFinite(endpoint.gap)
    && endpoint.gap >= 0
    && endpoint.gap <= MAX_CANVAS_VALUE) {
    const target = elementsById[endpoint.targetElementId];
    const hasValidLegacyAnchor = endpoint.anchor === undefined || (
      isRecord(endpoint.anchor)
      && Object.keys(endpoint.anchor).length === 1
      && Object.prototype.hasOwnProperty.call(endpoint.anchor, "t")
      && typeof endpoint.anchor.t === "number"
      && Number.isFinite(endpoint.anchor.t)
      && endpoint.anchor.t >= 0
      && endpoint.anchor.t <= 1
    );
    const binding: Extract<ConnectorElement["start"], { kind: "element" }> = {
      gap: endpoint.gap,
      kind: "element",
      targetElementId: endpoint.targetElementId,
    };
    if (!hasValidLegacyAnchor || !isBindableElement(target) || target.pageId !== connector.pageId) {
      return { kind: "free", x: 0, y: 0 };
    }
    if (endpoint.anchor !== undefined) {
      const legacyBinding = {
        ...binding,
        anchor: { t: (endpoint.anchor as Record<string, unknown>).t as number },
      };
      if (!resolveConnectorEndpoint(legacyBinding, elementsById, connector.pageId)) {
        return { kind: "free", x: 0, y: 0 };
      }
    }
    return binding;
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
