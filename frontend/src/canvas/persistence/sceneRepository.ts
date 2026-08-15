import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AppData, AppSessionState, Folder, Page } from "../../types";
import type { CanvasElement } from "../model/elements";

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
    loadWorkspace: () => invoke<WorkspaceData>("load_workspace_data"),
    reconcileWorkspaceStructure: (structure) =>
      invoke<WorkspaceStructureResult>("reconcile_workspace_structure", { structure }),
    applySceneChanges: (batch) =>
      invoke<SceneChangeResult>("apply_scene_changes", { batch }),
    saveAsset: (request) => invoke<Asset>("save_asset", { request }),
    loadAsset: (assetId) => invoke<Asset>("load_asset", { assetId }),
    saveSessionState: (state) => invoke<void>("save_session_state", { state }),
  };
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
  return { ...details, dataBase64: match[2], mediaType: match[1].toLowerCase() };
}

export function assetDataUrl(asset: Asset): string {
  if (!asset.dataBase64) {
    throw new Error(`Asset ${asset.id} did not include image data.`);
  }
  return `data:${asset.mediaType};base64,${asset.dataBase64}`;
}
