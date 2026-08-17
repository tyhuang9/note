import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import type {
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
} from "react";
import { useEditorState } from "@tiptap/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./App.css";
import {
  AIProvidersSettings,
  type ProviderConnectionState,
} from "./components/AIProvidersSettings";
import { AssistantPanel } from "./components/AssistantPanel";
import { InlineRename } from "./components/InlineRename";
import { TextBlockView } from "./components/TextBlockView";
import { ImageElementView } from "./components/ImageElementView";
import { CanvasElementRenderer } from "./canvas/components/CanvasElementRenderer";
import { CanvasInteractionOverlay } from "./canvas/components/CanvasInteractionOverlay";
import { CanvasToolPalette } from "./canvas/components/CanvasToolPalette";
import { DrawingPropertiesPanel } from "./canvas/components/DrawingPropertiesPanel";
import { CanvasViewport } from "./canvas/components/CanvasViewport";
import { CanvasWorldLayer } from "./canvas/components/CanvasWorldLayer";
import { InkElementView } from "./canvas/components/InkElementView";
import { ConnectorElementView, ShapeElementView } from "./canvas/components/PrimitiveElementView";
import { ShapeBindingAnchors } from "./canvas/components/ShapeBindingAnchors";
import { useCanvasInteraction } from "./canvas/interaction/useCanvasInteraction";
import { cleanupMarquee } from "./canvas/interaction/marqueeCleanup";
import {
  deterministicSeed,
  type PrimitiveGeometry,
  type PrimitiveTool,
} from "./canvas/interaction/primitiveGeometry";
import {
  drawingToolAfterCreation,
  drawingToolForShortcut,
  useInkInteraction,
  type DrawingTool,
} from "./canvas/interaction/useInkInteraction";
import { ActivityRail } from "./components/workbench/ActivityRail";
import { WorkbenchShell } from "./components/workbench/WorkbenchShell";
import {
  getWorkspaceTabId,
  WORKSPACE_PAGE_PANEL_ID,
  WorkspaceTabs,
} from "./components/workbench/WorkspaceTabs";
import type {
  WorkbenchIconName,
  WorkbenchIconProps,
} from "./components/workbench/icons";
import { useWorkbenchViewport } from "./components/workbench/useWorkbenchViewport";
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_BLOCK_WIDTH,
  DEFAULT_ZOOM,
  GRID_SIZE,
  MAX_ZOOM,
  MIN_ZOOM,
  SAVE_DELAY_MS,
  TEXT_BLOCK_HEADER_HEIGHT,
  ZOOM_STEP,
} from "./constants";
import type {
  TextElementUpdates,
  ImageElementUpdates,
  CanvasPoint,
  CanvasSize,
  InsertionPoint,
  InteractionMode,
  OffscreenGroup,
  PanOffset,
  PageViewport,
  SearchMatch,
  SelectionRect,
  ViewportRect,
} from "./appTypes";
import type {
  AIModel,
  AIProvider,
  AssistantActionKind,
  AssistantActionRequest,
  AssistantMessage,
  ProviderType,
  SttProviderConfig,
} from "./aiTypes";
import {
  blurActiveTextEntry,
  createId,
  emptyData,
  getOffscreenDirection,
  isTextEntryTarget,
} from "./editorUtils";
import {
  callOpenAICompatibleWhisperTranscription,
  DEFAULT_LOCAL_STT_CONFIG,
} from "./services/localModelProviders";
import { listAIProviderModels, testAIProvider } from "./services/aiProviderAdapters";
import { buildAssistantActionRequest } from "./services/assistantActions";
import {
  createAIProvider,
  deleteProviderCredential,
  loadAIProviderSettings,
  saveAIProviderSettings,
} from "./services/aiProviderStorage";
import { buildNotesContext } from "./services/notesContext";
import {
  createLlamaHarnessNoteRun,
  getLlamaHarnessNoteCapabilities,
  getLlamaHarnessSetupStatus,
  type LlamaHarnessAgent,
  type LlamaHarnessAppCapabilities,
  type LlamaHarnessRunResponse,
  type LlamaHarnessRunToolRequest,
  type LlamaHarnessRunToolResult,
  type LlamaHarnessSetupStatus,
  submitLlamaHarnessNoteToolResults,
} from "./services/llamaHarnessAssistant";
import {
  isTextElement,
  isBoxCanvasElement,
  type ImageElement,
  type BoxCanvasElement,
  type CanvasElement,
  type InkElement,
  type ConnectorElement,
  type ShapeElement,
  type TextElement,
} from "./canvas/model/elements";
import {
  HIGHLIGHTER_BRUSH,
  normalizeInkGeometry,
  PEN_BRUSH,
  scaleInkElement,
  type RawInkPoint,
} from "./canvas/model/ink";
import {
  applyDrawingPropertyUpdate,
  createDefaultDrawingPreferences,
  drawingPropertiesFromPreference,
  isDrawingPreferenceTool,
  isPropertySupportedByTool,
  normalizeDrawingPreferences,
  readDrawingProperties,
  updateDrawingPreference,
  type DrawingProperty,
  type DrawingPropertyUpdate,
  type DrawingPreferences,
} from "./canvas/model/drawingPreferences";
import { reorderLayers, type LayerAction } from "./canvas/model/layerOrdering";
import {
  getProportionalScale,
  getOppositeCorner,
  getSelectionElementBounds,
  getSelectionBounds,
  scaleSelection,
  translateSelection,
  type SelectionCorner,
} from "./canvas/model/selectionBounds";
import {
  detachConnectorEndpointsForDeletedTargets,
  resolveConnectorEndpoint,
  snapConnectorEndpoint,
} from "./canvas/model/connectorBinding";
import {
  assetDataUrl,
  assetRequestFromDataUrl,
  createSceneRepository,
  isAssetBlobWithinLimit,
  MAX_ASSET_BYTES,
  type SceneRepository,
  type StoragePage,
} from "./canvas/persistence/sceneRepository";
import {
  SceneChangeQueue,
  type SaveState,
} from "./canvas/persistence/sceneChangeQueue";
import {
  fromLegacyAppData,
  type LegacyAppData,
} from "./canvas/persistence/legacyAppData";
import type { AppData, AppSessionState } from "./types";

type BlockUpdates = TextElementUpdates;

type SidebarProps = {
  bookmarkedPages: AppData["pages"];
  editingFolderId: string | null;
  editingPageId: string | null;
  explorerPanelRef: Ref<HTMLDivElement>;
  explorerToggleButtonRef: Ref<HTMLButtonElement>;
  folders: AppData["folders"];
  isCollapsed: boolean;
  isInert: boolean;
  isNarrowWorkbench: boolean;
  pageSearchFocusRequest: number;
  pageTemplates: AppData["pages"];
  pages: AppData["pages"];
  pageSearchQuery: string;
  pageSearchResults: PageSearchResult[];
  selectedFolderId: string;
  selectedPageId: string;
  onCreateFolder: () => void;
  onCreatePage: () => void;
  onCreatePageFromTemplate: (templatePageId: string) => void;
  onCreateTemplateFromPage: () => void;
  onDeleteFolder: (folderId: string) => void;
  onDeletePage: (pageId: string) => void;
  onDeletePageTemplate: (templatePageId: string) => void;
  onFolderDragLeave: (folderId: string) => void;
  onFolderDragOver: (folderId: string) => void;
  onFocusPageSearch: (trigger?: HTMLElement) => void;
  onPageDragEnd: () => void;
  onPageDragStart: (pageId: string) => boolean;
  onPageDropOnFolder: (folderId: string) => boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRenamePage: (pageId: string, title: string) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectFolder: (folderId: string) => void;
  onSelectPage: (pageId: string, isMultiSelect?: boolean) => void;
  onSetEditingFolderId: (folderId: string | null) => void;
  onSetEditingPageId: (pageId: string | null) => void;
  onToggleCollapse: (trigger?: HTMLElement) => void;
  onTogglePageBookmark: (pageId: string) => void;
  pageDropTargetFolderId: string | null;
  draggedPageIds: string[];
  selectedPageIds: string[];
};

type PageHeaderProps = {
  activeTextEditor: Editor | null;
  assistantToggleButtonRef: Ref<HTMLButtonElement>;
  isAssistantOpen: boolean;
  isGridVisible: boolean;
  isDarkMode: boolean;
  isTextFormattingVisible: boolean;
  isEditingHeaderTitle: boolean;
  isSnapToGridEnabled: boolean;
  openPages: OpenPageTab[];
  selectedPageId: string;
  textFormatState: TextFormatState;
  zoomLevel: number;
  onClosePageTab: (pageId: string) => void;
  onCreatePage: () => void;
  onFocusCanvasSearch: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onRenamePage: (pageId: string, title: string) => void;
  onReorderPageTab: (
    sourcePageId: string,
    targetPageId: string,
    placement: PageTabDropPlacement,
  ) => void;
  onSelectPageTab: (pageId: string) => void;
  onSetEditingHeaderTitle: (isEditing: boolean) => void;
  onToggleAssistant: (trigger?: HTMLElement) => void;
  onToggleGrid: () => void;
  onToggleDarkMode: () => void;
  onToggleSnapToGrid: () => void;
  onSetTextFontFamily: (fontFamily: TextFontFamily) => void;
  onSetTextFontSize: (fontSize: TextFontSize) => void;
  onToggleTextFormat: (formatId: ToolbarActionId) => void;
};

type OpenPageTab = AppData["pages"][number] & {
  isBlankPlaceholder: boolean;
};

type PageTabDropPlacement = "before" | "after";
type WorkbenchOverlay = "assistant" | "explorer";

type ToolbarActionId =
  | "bold"
  | "italic"
  | "strike"
  | "underline"
  | "bulletList"
  | "orderedList"
  | "blockquote"
  | "code";

type TextFontFamily =
  | "system-ui"
  | "Arial"
  | "Georgia"
  | "Times New Roman"
  | "Courier New";

type TextFontSize = "12px" | "14px" | "16px" | "18px" | "24px" | "32px";

type TextFormatState = Record<ToolbarActionId, boolean> & {
  fontFamily: TextFontFamily;
  fontSize: TextFontSize;
};

type CreateTextBlockOptions = {
  fromTool?: boolean;
  placement?: "block-origin" | "text-caret";
};

type PendingImagePlacement = {
  dataUrl: string;
  fileName: string;
  point: CanvasPoint | null;
};

type ClipboardImage =
  | {
      file: File;
      kind: "file";
      name: string;
    }
  | {
      kind: "source";
      name: string;
      source: string;
    };

type ClipboardReadItem = {
  getType: (type: string) => Promise<Blob>;
  types: string[];
};

type DragLayerSession = {
  autoPanRafId: number | null;
  blockIds: string[];
  currentClientX: number;
  currentClientY: number;
  groupElement: HTMLDivElement;
  modeRafId: number | null;
  originId: string;
  overlayElement: HTMLDivElement;
  sourceElements: HTMLElement[];
  selectedBlockIds: string[];
  startClientX: number;
  startClientY: number;
  startPanOffset: PanOffset;
  zoomLevel: number;
};

type ResizeLayerSession = {
  groupElement: HTMLDivElement;
  overlayElement: HTMLDivElement;
  sourceElements: HTMLElement[];
};

type SelectionTransformSession = {
  corner: SelectionCorner | null;
  connectorEndpoint: "start" | "end" | null;
  didMove: boolean;
  pointerId: number;
  startBounds: SelectionRect;
  startClientX: number;
  startClientY: number;
};

type DrawingPropertyPreviewTransaction = {
  baseline: CanvasElement[];
  ownerKey: string;
  selectedIds: string[];
};

type CopyableElement = TextElement | ImageElement;
type CopiedBlock = Omit<CopyableElement, "id" | "pageId" | "x" | "y"> & {
  offsetX: number;
  offsetY: number;
};

type CopiedPageBlock = Omit<CopyableElement, "id" | "pageId">;

type CopiedPage = Omit<AppData["pages"][number], "id" | "folderId"> & {
  elements: CopiedPageBlock[];
  viewport?: PageViewport;
};

type PageSearchResult = {
  contentMatchCount: number;
  folderName: string;
  pageId: string;
  preview: string;
  title: string;
  titleMatches: boolean;
};

type CanvasSearchMatch =
  | ({ kind: "block" } & SearchMatch)
  | { end: number; kind: "title"; start: number };

const DRAG_AUTO_PAN_EDGE_PX = 56;
const DRAG_AUTO_PAN_MAX_STEP_PX = 18;
const MAX_BLOCK_HISTORY_ENTRIES = 100;
const PAGE_SEARCH_PREVIEW_CONTEXT = 44;
const PAGE_TEMPLATE_FOLDER_ID = "__note_page_templates__";
const PAGE_DRAG_MIME_TYPE = "application/x-note-page";
const ROOT_FOLDER_ID = "";
const PASTED_BLOCK_OFFSET = 24;
const TEXT_BLOCK_BORDER_WIDTH = 1;
const TEXT_BLOCK_CONTENT_PADDING_LEFT = 10;
const TEXT_BLOCK_CONTENT_PADDING_TOP = 5;
const LLAMA_HARNESS_SELECTED_AGENT_KEY = "note.llamaHarness.selectedAgentId.v1";
const DEFAULT_PAN_OFFSET: PanOffset = { x: 0, y: 0 };
type SidebarSortOrder =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc";
type SidebarTabId = "files" | "search" | "bookmarks" | "templates";
type PersistenceStatus = SaveState;
type PendingAssetUpload = { dataUrl: string; fileName: string };

type HeroIconName = WorkbenchIconName;

function readSelectedLlamaHarnessAgentId() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(LLAMA_HARNESS_SELECTED_AGENT_KEY) ?? "";
}

function writeSelectedLlamaHarnessAgentId(agentId: string) {
  if (typeof window === "undefined") {
    return;
  }

  if (agentId) {
    window.localStorage.setItem(LLAMA_HARNESS_SELECTED_AGENT_KEY, agentId);
  } else {
    window.localStorage.removeItem(LLAMA_HARNESS_SELECTED_AGENT_KEY);
  }
}

function llamaHarnessSetupMessage(status: LlamaHarnessSetupStatus) {
  switch (status.next_step) {
    case "start_litellm":
      return "Finish setup in llama-harness: start or enable LiteLLM.";
    case "add_provider":
      return "Finish setup in llama-harness: add or verify a provider.";
    case "select_model":
      return "Finish setup in llama-harness: choose an available model.";
    case "create_agent":
      return "Finish setup in llama-harness: create or activate an agent.";
    case "ready":
      return "llama-harness is ready.";
  }
}

const sidebarSortOptions: Array<{ label: string; value: SidebarSortOrder }> = [
  { label: "File name (A to Z)", value: "name-asc" },
  { label: "File name (Z to A)", value: "name-desc" },
  { label: "Modified time (new to old)", value: "modified-desc" },
  { label: "Modified time (old to new)", value: "modified-asc" },
  { label: "Created time (new to old)", value: "created-desc" },
  { label: "Created time (old to new)", value: "created-asc" },
];

function countSearchOccurrences(content: string, normalizedQuery: string) {
  let count = 0;
  let start = content.indexOf(normalizedQuery);

  while (start !== -1) {
    count += 1;
    start = content.indexOf(normalizedQuery, start + normalizedQuery.length);
  }

  return count;
}

function createPageSearchPreview(content: string, normalizedQuery: string) {
  const normalizedContent = content.toLowerCase();
  const matchIndex = normalizedContent.indexOf(normalizedQuery);

  if (matchIndex === -1) {
    return "";
  }

  const start = Math.max(0, matchIndex - PAGE_SEARCH_PREVIEW_CONTEXT);
  const end = Math.min(
    content.length,
    matchIndex + normalizedQuery.length + PAGE_SEARCH_PREVIEW_CONTEXT,
  );
  const prefix = start > 0 ? "... " : "";
  const suffix = end < content.length ? " ..." : "";
  const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();

  return `${prefix}${snippet}${suffix}`;
}

function areStringSetsEqual(firstSet: Set<string>, secondSet: Set<string>) {
  if (firstSet.size !== secondSet.size) {
    return false;
  }

  for (const value of firstSet) {
    if (!secondSet.has(value)) {
      return false;
    }
  }

  return true;
}

function getOffscreenDirectionLabel(
  direction: OffscreenGroup["direction"],
): string {
  const labels: Record<OffscreenGroup["direction"], string> = {
    n: "north",
    ne: "northeast",
    e: "east",
    se: "southeast",
    s: "south",
    sw: "southwest",
    w: "west",
    nw: "northwest",
  };

  return labels[direction];
}

function HeroIcon({ name }: Readonly<WorkbenchIconProps>) {
  return (
    <svg
      aria-hidden="true"
      className="hero-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {name === "adjustments-horizontal" ? (
        <>
          <path d="M4.5 7.5h6m3 0h6M4.5 16.5h9m3 0h3" />
          <path d="M10.5 5.25v4.5M16.5 14.25v4.5" />
        </>
      ) : null}
      {name === "archive-box" ? (
        <>
          <path d="M3.75 7.5h16.5" />
          <path d="M5.25 7.5v10.125A2.625 2.625 0 0 0 7.875 20.25h8.25a2.625 2.625 0 0 0 2.625-2.625V7.5" />
          <path d="M8.25 7.5V5.625A1.875 1.875 0 0 1 10.125 3.75h3.75A1.875 1.875 0 0 1 15.75 5.625V7.5" />
        </>
      ) : null}
      {name === "arrows-up-down" ? (
        <>
          <path d="M8.25 6.75 12 3m0 0 3.75 3.75M12 3v18" />
          <path d="M15.75 17.25 12 21m0 0-3.75-3.75" />
        </>
      ) : null}
      {name === "bookmark" ? (
        <path d="M17.25 21 12 17.25 6.75 21V5.25A2.25 2.25 0 0 1 9 3h6a2.25 2.25 0 0 1 2.25 2.25V21Z" />
      ) : null}
      {name === "bold" ? (
        <>
          <path d="M7.5 4.75h5.25a3.25 3.25 0 0 1 0 6.5H7.5z" />
          <path d="M7.5 11.25h6.25a4 4 0 0 1 0 8H7.5z" />
        </>
      ) : null}
      {name === "check" ? <path d="m4.5 12.75 6 6 9-13.5" /> : null}
      {name === "chevron-down" ? <path d="m6 9 6 6 6-6" /> : null}
      {name === "chevron-right" ? <path d="m9 6 6 6-6 6" /> : null}
      {name === "chevron-up" ? <path d="m6 15 6-6 6 6" /> : null}
      {name === "code-bracket" ? (
        <>
          <path d="m9 7.5-4.5 4.5L9 16.5" />
          <path d="m15 7.5 4.5 4.5-4.5 4.5" />
        </>
      ) : null}
      {name === "document-plus" ? (
        <>
          <path d="M14.25 3.75H7.5A2.25 2.25 0 0 0 5.25 6v12A2.25 2.25 0 0 0 7.5 20.25h9A2.25 2.25 0 0 0 18.75 18V8.25L14.25 3.75Z" />
          <path d="M14.25 3.75v4.5h4.5M12 11.25v5.25m2.625-2.625h-5.25" />
        </>
      ) : null}
      {name === "document-text" ? (
        <>
          <path d="M14.25 3.75H7.5A2.25 2.25 0 0 0 5.25 6v12A2.25 2.25 0 0 0 7.5 20.25h9A2.25 2.25 0 0 0 18.75 18V8.25L14.25 3.75Z" />
          <path d="M14.25 3.75v4.5h4.5M8.25 13.5h7.5M8.25 16.5h4.5" />
        </>
      ) : null}
      {name === "eye" ? (
        <>
          <path d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12s-3.75 6.75-9.75 6.75S2.25 12 2.25 12Z" />
          <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </>
      ) : null}
      {name === "eye-slash" ? (
        <>
          <path d="M3 3 21 21" />
          <path d="M10.5 5.4c.48-.1.98-.15 1.5-.15 6 0 9.75 6.75 9.75 6.75a18.2 18.2 0 0 1-2.76 3.48" />
          <path d="M6.38 6.9C3.74 8.76 2.25 12 2.25 12s3.75 6.75 9.75 6.75c1.86 0 3.5-.65 4.9-1.54" />
          <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
        </>
      ) : null}
      {name === "folder" ? (
        <path d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h4.125l2.25 2.25H18A2.25 2.25 0 0 1 20.25 9v7.5A2.25 2.25 0 0 1 18 18.75H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z" />
      ) : null}
      {name === "folder-plus" ? (
        <>
          <path d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h4.125l2.25 2.25H18A2.25 2.25 0 0 1 20.25 9v7.5A2.25 2.25 0 0 1 18 18.75H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z" />
          <path d="M12 10.5v5.25m2.625-2.625h-5.25" />
        </>
      ) : null}
      {name === "italic" ? <path d="M10.5 5.25h6M7.5 18.75h6M14.25 5.25l-4.5 13.5" /> : null}
      {name === "list-bullet" ? (
        <>
          <path d="M8.25 6.75h11.25M8.25 12h11.25M8.25 17.25h11.25" />
          <path d="M4.5 6.75h.01M4.5 12h.01M4.5 17.25h.01" />
        </>
      ) : null}
      {name === "magnifying-glass" ? (
        <path d="m21 21-4.35-4.35m1.35-5.4a6.75 6.75 0 1 1-13.5 0 6.75 6.75 0 0 1 13.5 0Z" />
      ) : null}
      {name === "moon" ? (
        <path d="M21 14.25A8.25 8.25 0 0 1 9.75 3a7.5 7.5 0 1 0 11.25 11.25Z" />
      ) : null}
      {name === "numbered-list" ? (
        <>
          <path d="M9 6.75h10.5M9 12h10.5M9 17.25h10.5" />
          <path d="M4.5 5.25h1.5v3M4.5 8.25h3" />
          <path d="M4.5 11.25h2.25L4.5 14.25h2.25" />
          <path d="M4.5 16.5h2.25a.75.75 0 0 1 0 1.5H5.25m1.5 0a.75.75 0 0 1 0 1.5H4.5" />
        </>
      ) : null}
      {name === "panel" ? (
        <>
          <path d="M4.5 5.25A1.5 1.5 0 0 1 6 3.75h12a1.5 1.5 0 0 1 1.5 1.5v13.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V5.25Z" />
          <path d="M9 3.75v16.5" />
        </>
      ) : null}
      {name === "pencil-square" ? (
        <>
          <path d="M16.86 4.49 19.5 7.13m-11.25 8.62 2.72-.54a2.25 2.25 0 0 0 1.19-.63l7.08-7.08a1.87 1.87 0 0 0-2.64-2.64l-7.08 7.08a2.25 2.25 0 0 0-.63 1.19l-.54 2.72Z" />
          <path d="M18.75 13.5v4.125a2.625 2.625 0 0 1-2.625 2.625h-9.75A2.625 2.625 0 0 1 3.75 17.625v-9.75A2.625 2.625 0 0 1 6.375 5.25H10.5" />
        </>
      ) : null}
      {name === "plus" ? <path d="M12 5.25v13.5M5.25 12h13.5" /> : null}
      {name === "quote" ? (
        <>
          <path d="M8.75 7.5H6.5A2.5 2.5 0 0 0 4 10v1.75h4.75v4.75H4" />
          <path d="M18.5 7.5h-2.25a2.5 2.5 0 0 0-2.5 2.5v1.75h4.75v4.75h-4.75" />
        </>
      ) : null}
      {name === "rectangle-stack" ? (
        <>
          <path d="M6.75 7.5h10.5M6.75 12h10.5M6.75 16.5h10.5" />
          <path d="M3.75 5.25A1.5 1.5 0 0 1 5.25 3.75h13.5a1.5 1.5 0 0 1 1.5 1.5v13.5a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5V5.25Z" />
        </>
      ) : null}
      {name === "sparkles" ? (
        <>
          <path d="m12 3 1.38 4.12L17.5 8.5l-4.12 1.38L12 14l-1.38-4.12L6.5 8.5l4.12-1.38L12 3Z" />
          <path d="m18.5 13 .78 2.22L21.5 16l-2.22.78L18.5 19l-.78-2.22L15.5 16l2.22-.78L18.5 13ZM5.5 14l.58 1.42L7.5 16l-1.42.58L5.5 18l-.58-1.42L3.5 16l1.42-.58L5.5 14Z" />
        </>
      ) : null}
      {name === "squares-2x2" ? (
        <>
          <path d="M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z" />
        </>
      ) : null}
      {name === "star" ? (
        <path d="m12 3.75 2.53 5.13 5.66.82-4.1 4 1 5.64L12 16.68l-5.09 2.66 1-5.64-4.1-4 5.66-.82L12 3.75Z" />
      ) : null}
      {name === "strikethrough" ? (
        <>
          <path d="M5.25 12h13.5" />
          <path d="M16.5 6.75A4.5 4.5 0 0 0 12.75 5.25h-1a3.25 3.25 0 0 0-1.5 6.13l3.5 1.5a3.25 3.25 0 0 1-1.5 6.12h-1a4.5 4.5 0 0 1-3.75-1.5" />
        </>
      ) : null}
      {name === "sun" ? (
        <>
          <path d="M12 4.5V3M12 21v-1.5M4.5 12H3M21 12h-1.5M6.34 6.34 5.28 5.28M18.72 18.72l-1.06-1.06M17.66 6.34l1.06-1.06M5.28 18.72l1.06-1.06" />
          <path d="M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
        </>
      ) : null}
      {name === "trash" ? (
        <>
          <path d="M4.5 6.75h15M9.75 6.75V5.25A1.5 1.5 0 0 1 11.25 3.75h1.5a1.5 1.5 0 0 1 1.5 1.5v1.5" />
          <path d="m9 10.5.45 7.5m5.55-7.5-.45 7.5M6.75 6.75l.75 12A1.5 1.5 0 0 0 9 20.25h6a1.5 1.5 0 0 0 1.5-1.5l.75-12" />
        </>
      ) : null}
      {name === "underline" ? (
        <>
          <path d="M7.5 5.25v6a4.5 4.5 0 0 0 9 0v-6" />
          <path d="M6 20.25h12" />
        </>
      ) : null}
      {name === "x-mark" ? <path d="M6 6l12 12M18 6 6 18" /> : null}
    </svg>
  );
}

function formatPageSearchSummary(result: PageSearchResult) {
  const summaryParts: string[] = [];

  if (result.titleMatches) {
    summaryParts.push("Title");
  }

  if (result.contentMatchCount > 0) {
    summaryParts.push(
      `${result.contentMatchCount} text ${
        result.contentMatchCount === 1 ? "match" : "matches"
      }`,
    );
  }

  return summaryParts.join(" + ");
}

function areIdSelectionsEqual(firstIds: string[], secondIds: string[]) {
  return (
    firstIds.length === secondIds.length &&
    firstIds.every((blockId, index) => blockId === secondIds[index])
  );
}

function markToolbarInteraction() {
  document.body.dataset.noteToolbarInteraction = "true";
  window.setTimeout(() => {
    delete document.body.dataset.noteToolbarInteraction;
  }, 100);
}

const defaultTextFormatState: TextFormatState = {
  bold: false,
  italic: false,
  strike: false,
  underline: false,
  bulletList: false,
  orderedList: false,
  blockquote: false,
  code: false,
  fontFamily: "system-ui",
  fontSize: "18px",
};

const inlineFormatMarks: Partial<Record<ToolbarActionId, string>> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  underline: "underline",
  code: "code",
};

const textFontFamilyOptions: Array<{ label: string; value: TextFontFamily }> = [
  { label: "System", value: "system-ui" },
  { label: "Arial", value: "Arial" },
  { label: "Georgia", value: "Georgia" },
  { label: "Times", value: "Times New Roman" },
  { label: "Mono", value: "Courier New" },
];

const textFontSizeOptions: TextFontSize[] = [
  "12px",
  "14px",
  "16px",
  "18px",
  "24px",
  "32px",
];

function normalizeTextFontFamily(value: unknown): TextFontFamily {
  return textFontFamilyOptions.some((option) => option.value === value)
    ? (value as TextFontFamily)
    : defaultTextFormatState.fontFamily;
}

function normalizeTextFontSize(value: unknown): TextFontSize {
  return textFontSizeOptions.includes(value as TextFontSize)
    ? (value as TextFontSize)
    : defaultTextFormatState.fontSize;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizePageViewport(
  viewport: NonNullable<AppSessionState["pageViewports"]>[string] | undefined,
): PageViewport | null {
  if (!viewport) {
    return null;
  }

  const panOffset = viewport.panOffset;

  if (
    !panOffset ||
    !isFiniteNumber(panOffset.x) ||
    !isFiniteNumber(panOffset.y)
  ) {
    return null;
  }

  const zoomLevel = isFiniteNumber(viewport.zoomLevel)
    ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoomLevel))
    : DEFAULT_ZOOM;

  return {
    panOffset: {
      x: panOffset.x,
      y: panOffset.y,
    },
    zoomLevel,
  };
}

function normalizePageViewports(
  pageViewports: AppSessionState["pageViewports"] | undefined,
  validPageIds: Set<string>,
) {
  const normalizedViewports = new Map<string, PageViewport>();

  if (!pageViewports) {
    return normalizedViewports;
  }

  for (const [pageId, viewport] of Object.entries(pageViewports)) {
    if (!validPageIds.has(pageId)) {
      continue;
    }

    const normalizedViewport = normalizePageViewport(viewport);

    if (normalizedViewport) {
      normalizedViewports.set(pageId, normalizedViewport);
    }
  }

  return normalizedViewports;
}

function getValidUniquePageIds(
  pageIds: string[] | undefined,
  validPageIds: Set<string>,
) {
  if (!pageIds) {
    return [];
  }

  return pageIds.filter(
    (pageId, index) =>
      validPageIds.has(pageId) && pageIds.indexOf(pageId) === index,
  );
}

function getNextTextFormatState(
  currentState: TextFormatState,
  formatId: ToolbarActionId,
): TextFormatState {
  const nextState = {
    ...currentState,
    [formatId]: !currentState[formatId],
  };

  if (formatId === "bulletList" && nextState.bulletList) {
    nextState.orderedList = false;
  }

  if (formatId === "orderedList" && nextState.orderedList) {
    nextState.bulletList = false;
  }

  return nextState;
}

function hasActiveTextFormat(formatState: TextFormatState) {
  return (
    formatState.bold ||
    formatState.italic ||
    formatState.strike ||
    formatState.underline ||
    formatState.bulletList ||
    formatState.orderedList ||
    formatState.blockquote ||
    formatState.code ||
    formatState.fontFamily !== defaultTextFormatState.fontFamily ||
    formatState.fontSize !== defaultTextFormatState.fontSize
  );
}

function getTextStyleAttrs(formatState: TextFormatState) {
  const attrs: Record<string, string> = {};

  if (formatState.fontFamily !== defaultTextFormatState.fontFamily) {
    attrs.fontFamily = formatState.fontFamily;
  }

  if (formatState.fontSize !== defaultTextFormatState.fontSize) {
    attrs.fontSize = formatState.fontSize;
  }

  return attrs;
}

function createTextMarks(formatState: TextFormatState) {
  const marks: NonNullable<JSONContent["marks"]> = (
    Object.entries(inlineFormatMarks) as [ToolbarActionId, string][]
  )
    .filter(([formatId]) => formatState[formatId])
    .map(([, type]) => ({ type }));
  const textStyleAttrs = getTextStyleAttrs(formatState);

  if (Object.keys(textStyleAttrs).length > 0) {
    marks.push({ type: "textStyle", attrs: textStyleAttrs });
  }

  return marks;
}

function createFormattedParagraph(
  text: string,
  formatState: TextFormatState,
): JSONContent {
  const marks = createTextMarks(formatState);

  return {
    type: "paragraph",
    content: text
      ? [
          {
            type: "text",
            text,
            ...(marks.length ? { marks } : {}),
          },
        ]
      : undefined,
  };
}

function createFormattedRichContent(
  text: string,
  formatState: TextFormatState,
): JSONContent | undefined {
  if (!hasActiveTextFormat(formatState)) {
    return undefined;
  }

  const paragraphs = text.split("\n").map((line) =>
    createFormattedParagraph(line, formatState),
  );
  let content: JSONContent["content"] = paragraphs;

  if (formatState.bulletList || formatState.orderedList) {
    content = [
      {
        type: formatState.bulletList ? "bulletList" : "orderedList",
        content: paragraphs.map((paragraph) => ({
          type: "listItem",
          content: [paragraph],
        })),
      },
    ];
  }

  if (formatState.blockquote) {
    content = [
      {
        type: "blockquote",
        content,
      },
    ];
  }

  return {
    type: "doc",
    content,
  };
}

function plainTextToRichContent(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : undefined,
    })),
  };
}

function getBlockRichContent(block: TextElement) {
  return block.richContent ?? plainTextToRichContent(block.content);
}

function applyInlineMarkToRichContent(
  content: JSONContent,
  markType: string,
  shouldApply: boolean,
): JSONContent {
  if (content.type === "text") {
    const nextMarks = (content.marks ?? []).filter(
      (mark) => mark.type !== markType,
    );
    const { marks: _marks, ...contentWithoutMarks } = content;

    if (shouldApply) {
      nextMarks.push({ type: markType });
    }

    return nextMarks.length
      ? { ...contentWithoutMarks, marks: nextMarks }
      : contentWithoutMarks;
  }

  if (!content.content) {
    return content;
  }

  return {
    ...content,
    content: content.content.map((child) =>
      applyInlineMarkToRichContent(child, markType, shouldApply),
    ),
  };
}

function applyTextStyleToRichContent(
  content: JSONContent,
  formatState: TextFormatState,
): JSONContent {
  if (content.type === "text") {
    const textStyleAttrs = getTextStyleAttrs(formatState);
    const nextMarks = (content.marks ?? []).filter(
      (mark) => mark.type !== "textStyle",
    );
    const { marks: _marks, ...contentWithoutMarks } = content;

    if (Object.keys(textStyleAttrs).length > 0) {
      nextMarks.push({ type: "textStyle", attrs: textStyleAttrs });
    }

    return nextMarks.length
      ? { ...contentWithoutMarks, marks: nextMarks }
      : contentWithoutMarks;
  }

  if (!content.content) {
    return content;
  }

  return {
    ...content,
    content: content.content.map((child) =>
      applyTextStyleToRichContent(child, formatState),
    ),
  };
}

function applyTextStyleStateToBlock(
  block: TextElement,
  formatState: TextFormatState,
): TextElement {
  return {
    ...block,
    richContent: applyTextStyleToRichContent(
      getBlockRichContent(block),
      formatState,
    ),
  };
}

function applyFormatStateToBlock(
  block: TextElement,
  formatId: ToolbarActionId,
  formatState: TextFormatState,
): TextElement {
  const inlineMark = inlineFormatMarks[formatId];

  if (inlineMark) {
    return {
      ...block,
      richContent: applyInlineMarkToRichContent(
        getBlockRichContent(block),
        inlineMark,
        formatState[formatId],
      ),
    };
  }

  return {
    ...block,
    richContent: createFormattedRichContent(block.content, formatState),
  };
}

function App() {
  const [data, setData] = useState<AppData>(emptyData);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [selectedPageId, setSelectedPageId] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [isEditingHeaderTitle, setIsEditingHeaderTitle] = useState(false);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<InteractionMode>("canvas");
  const [activeTool, setActiveTool] = useState<DrawingTool>("select");
  const [isToolLocked, setIsToolLocked] = useState(false);
  const [drawingPreferences, setDrawingPreferences] = useState<DrawingPreferences>(
    createDefaultDrawingPreferences,
  );
  const [isPropertiesPanelOpen, setIsPropertiesPanelOpen] = useState(false);
  const [isDrawingPropertyPreviewing, setIsDrawingPropertyPreviewing] = useState(false);
  const [pendingImagePlacement, setPendingImagePlacement] =
    useState<PendingImagePlacement | null>(null);
  const [imageImportError, setImageImportError] = useState<string | null>(null);
  const [panOffset, setPanOffset] = useState<PanOffset>({ x: 0, y: 0 });
  const [livePanOffset, setLivePanOffset] = useState<PanOffset>(panOffset);
  const [insertionPoint, setInsertionPoint] = useState<InsertionPoint | null>(null);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pageSearchFocusRequest, setPageSearchFocusRequest] = useState(0);
  const [pageSearchQuery, setPageSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [openPageTabIds, setOpenPageTabIds] = useState<string[]>([]);
  const [focusEndBlockId, setFocusEndBlockId] = useState<string | null>(null);
  const [isCanvasKeyboardActive, setIsCanvasKeyboardActive] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const { isCompactWorkbench, isNarrowWorkbench } = useWorkbenchViewport();
  const [activeNarrowOverlay, setActiveNarrowOverlay] =
    useState<WorkbenchOverlay | null>(null);
  const [isGridVisible, setIsGridVisible] = useState(false);
  const [isSnapToGridEnabled, setIsSnapToGridEnabled] = useState(false);
  const [dragSourceBlockIds, setDragSourceBlockIds] = useState<string[]>([]);
  const [selectionFramePreview, setSelectionFramePreview] = useState<SelectionRect | null>(null);
  const [connectorEndpointPreview, setConnectorEndpointPreview] = useState<ConnectorElement | null>(null);
  const [isConnectorEndpointRetargeting, setIsConnectorEndpointRetargeting] = useState(false);
  const [selectedSidebarPageIds, setSelectedSidebarPageIds] = useState<string[]>([]);
  const [draggedPageIds, setDraggedPageIds] = useState<string[]>([]);
  const [pageDropTargetFolderId, setPageDropTargetFolderId] = useState<string | null>(null);
  const [isStarterDismissed, setIsStarterDismissed] = useState(false);
  const [activeTextEditor, setActiveTextEditor] = useState<Editor | null>(null);
  const [textFormatState, setTextFormatState] =
    useState<TextFormatState>(defaultTextFormatState);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantStatus, setAssistantStatus] = useState<string | null>(null);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [isAssistantSending, setIsAssistantSending] = useState(false);
  const [isAssistantRecording, setIsAssistantRecording] = useState(false);
  const [llamaHarnessSetupStatus, setLlamaHarnessSetupStatus] =
    useState<LlamaHarnessSetupStatus | null>(null);
  const [llamaHarnessCapabilities, setLlamaHarnessCapabilities] =
    useState<LlamaHarnessAppCapabilities | null>(null);
  const [llamaHarnessAgents, setLlamaHarnessAgents] = useState<LlamaHarnessAgent[]>([]);
  const [selectedLlamaHarnessAgentId, setSelectedLlamaHarnessAgentId] = useState(
    readSelectedLlamaHarnessAgentId,
  );
  const [isLlamaHarnessLoading, setIsLlamaHarnessLoading] = useState(false);
  const [sttProviderConfig] = useState<SttProviderConfig>(DEFAULT_LOCAL_STT_CONFIG);
  const [isAIProvidersOpen, setIsAIProvidersOpen] = useState(false);
  const [isAIProviderSettingsLoaded, setIsAIProviderSettingsLoaded] =
    useState(false);
  const [aiProviders, setAIProviders] = useState<AIProvider[]>([]);
  const [aiModels, setAIModels] = useState<AIModel[]>([]);
  const [selectedAIProviderId, setSelectedAIProviderId] = useState("");
  const [defaultChatModelId, setDefaultChatModelId] = useState("");
  const [defaultEmbeddingModelId, setDefaultEmbeddingModelId] = useState("");
  const [providerConnectionStates, setProviderConnectionStates] = useState<
    Record<string, ProviderConnectionState>
  >({});
  const [isLoaded, setIsLoaded] = useState(false);
  const [persistenceAvailable, setPersistenceAvailable] = useState(false);
  const [persistenceStatus, setPersistenceStatus] =
    useState<PersistenceStatus>({ kind: "saved" });
  const dataRef = useRef<AppData>(data);
  const canvasRef = useRef<HTMLElement | null>(null);
  const canvasContentRef = useRef<HTMLDivElement | null>(null);
  const liveDraftLayerRef = useRef<SVGSVGElement | null>(null);
  const imagePickerInputRef = useRef<HTMLInputElement | null>(null);
  const selectionRectRef = useRef<HTMLDivElement | null>(null);
  const selectionFrameRef = useRef<HTMLDivElement | null>(null);
  const selectionTransformRef = useRef<SelectionTransformSession | null>(null);
  const resizeLayerSessionRef = useRef<ResizeLayerSession | null>(null);
  const cancelCanvasSelectionRef = useRef<() => void>(() => undefined);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const explorerPanelRef = useRef<HTMLDivElement | null>(null);
  const explorerToggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const assistantPanelRef = useRef<HTMLElement | null>(null);
  const assistantToggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  const overlayEntryFocusRequestRef = useRef<WorkbenchOverlay | null>(null);
  const overlayReturnFocusRequestRef = useRef(false);
  const wasNarrowWorkbenchRef = useRef(false);
  const canvasViewportRef = useRef<ViewportRect | null>(null);
  const panOffsetRef = useRef<PanOffset>(panOffset);
  const panRafId = useRef<number | null>(null);
  const selectionRafId = useRef<number | null>(null);
  const pendingSelectionRect = useRef<SelectionRect | null>(null);
  const searchCache = useRef<Map<string, SearchMatch[]>>(new Map());
  const copiedBlocksRef = useRef<CopiedBlock[]>([]);
  const copiedPagesRef = useRef<CopiedPage[]>([]);
  const copiedContentKindRef = useRef<"blocks" | "pages" | null>(null);
  // In-memory assets may outlive their elements during this migration; reclamation is deferred.
  const imageSourcesByAssetIdRef = useRef<Map<string, string>>(new Map());
  const pendingAssetUploadsRef = useRef<Map<string, PendingAssetUpload>>(new Map());
  const repositoryRef = useRef<SceneRepository | null>(null);
  const sceneChangeQueueRef = useRef<SceneChangeQueue | null>(null);
  const pageRevisionsRef = useRef<Map<string, number>>(new Map());
  const persistenceChainRef = useRef<Promise<void>>(Promise.resolve());
  const undoBlockHistoryRef = useRef<CanvasElement[][]>([]);
  const redoBlockHistoryRef = useRef<CanvasElement[][]>([]);
  const blockElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const dragLayerSessionRef = useRef<DragLayerSession | null>(null);
  const assistantMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const assistantRecordingChunksRef = useRef<Blob[]>([]);
  const assistantRecordingStreamRef = useRef<MediaStream | null>(null);
  const openPageTabIdsRef = useRef<string[]>(openPageTabIds);
  const pageViewportsRef = useRef<Map<string, PageViewport>>(new Map());
  const isSnapToGridEnabledRef = useRef(isSnapToGridEnabled);
  const editingBlockIdRef = useRef<string | null>(editingBlockId);
  const selectedBlockIdsRef = useRef<string[]>(selectedBlockIds);
  const selectedFolderIdRef = useRef(selectedFolderId);
  const selectedPageIdRef = useRef(selectedPageId);
  const selectedSidebarPageIdsRef = useRef<string[]>(selectedSidebarPageIds);
  const textFormatStateRef = useRef<TextFormatState>(textFormatState);
  const draggedPageIdsRef = useRef<string[]>([]);
  const draggedPrimaryPageIdRef = useRef<string | null>(null);
  const zoomLevelRef = useRef(zoomLevel);
  const activeToolRef = useRef<DrawingTool>(activeTool);
  const isToolLockedRef = useRef(isToolLocked);
  const drawingPreferencesRef = useRef(drawingPreferences);
  const isTemporaryHandActiveRef = useRef(false);
  const pendingImagePlacementRef = useRef<PendingImagePlacement | null>(null);
  const imagePickerRequestRef = useRef(0);
  const drawingPropertyPreviewRef = useRef<DrawingPropertyPreviewTransaction | null>(null);
  const authoringFocusReturnRafRef = useRef<number | null>(null);
  const previousCanvasAuthoringAvailableRef = useRef(false);
  const isCanvasAuthoringAvailableRef = useRef(false);
  const isWorkbenchOverlayOpenRef = useRef(false);

  dataRef.current = data;
  activeToolRef.current = activeTool;
  isToolLockedRef.current = isToolLocked;
  drawingPreferencesRef.current = drawingPreferences;
  pendingImagePlacementRef.current = pendingImagePlacement;
  isSnapToGridEnabledRef.current = isGridVisible && isSnapToGridEnabled;
  editingBlockIdRef.current = editingBlockId;
  openPageTabIdsRef.current = openPageTabIds;
  selectedBlockIdsRef.current = selectedBlockIds;
  selectedFolderIdRef.current = selectedFolderId;
  selectedPageIdRef.current = selectedPageId;
  selectedSidebarPageIdsRef.current = selectedSidebarPageIds;
  textFormatStateRef.current = textFormatState;
  zoomLevelRef.current = zoomLevel;

  const isExplorerOverlayOpen =
    isNarrowWorkbench && activeNarrowOverlay === "explorer";
  const isAssistantOverlayOpen = isNarrowWorkbench
    ? activeNarrowOverlay === "assistant" ||
      (activeNarrowOverlay === null && isAssistantOpen)
    : isCompactWorkbench && isAssistantOpen;
  const activeWorkbenchOverlay: WorkbenchOverlay | null =
    isExplorerOverlayOpen
      ? "explorer"
      : isAssistantOverlayOpen
        ? "assistant"
        : null;
  const isExplorerPresentationCollapsed = isNarrowWorkbench
    ? !isExplorerOverlayOpen
    : isSidebarCollapsed;
  const shouldRenderAssistantPanel = isNarrowWorkbench
    ? isAssistantOverlayOpen
    : isAssistantOpen;

  const selectedPage = useMemo(
    () => data.pages.find((page) => page.id === selectedPageId),
    [data.pages, selectedPageId],
  );
  const selectedAssistantBlockPreview = useMemo(() => {
    if (selectedBlockIds.length !== 1) {
      return null;
    }

    const selectedBlock = data.elements.find(
      (block) => block.id === selectedBlockIds[0],
    );

    if (!selectedBlock || !isTextElement(selectedBlock)) {
      return null;
    }

    const normalizedContent = selectedBlock.content.replace(/\s+/g, " ").trim();

    return normalizedContent
      ? `${normalizedContent.slice(0, 88)}${normalizedContent.length > 88 ? "…" : ""}`
      : "Empty text block";
  }, [data.elements, selectedBlockIds]);
  const isWorkspaceEmpty =
    isLoaded && data.folders.length === 0 && data.pages.length === 0;
  const pageTemplates = useMemo(
    () => data.pages.filter((page) => page.folderId === PAGE_TEMPLATE_FOLDER_ID),
    [data.pages],
  );
  const explorerPages = useMemo(
    () => data.pages.filter((page) => !isTemplatePage(page)),
    [data.pages],
  );
  const bookmarkedPages = useMemo(
    () => data.pages.filter((page) => page.isBookmarked),
    [data.pages],
  );
  const visibleBlocks = useMemo(
    () => data.elements.filter((block): block is CanvasElement & BoxCanvasElement => block.pageId === selectedPageId && isBoxCanvasElement(block)),
    [data.elements, selectedPageId],
  );
  const visibleCanvasElements = useMemo(
    () => data.elements.filter((element) => element.pageId === selectedPageId),
    [data.elements, selectedPageId],
  );
  const visibleCanvasElementsById = useMemo(
    () => Object.fromEntries(visibleCanvasElements.map((element) => [element.id, element])),
    [visibleCanvasElements],
  );
  const selectionWorldBounds = useMemo(() => {
    const selectedIds = new Set(selectedBlockIds);
    return getSelectionBounds(
      visibleCanvasElements.filter((element) => selectedIds.has(element.id)),
      visibleCanvasElementsById,
    );
  }, [selectedBlockIds, visibleCanvasElements, visibleCanvasElementsById]);
  const selectedDrawingElements = useMemo(() => {
    const selectedIds = new Set(selectedBlockIds);
    return data.elements.filter((element) => element.pageId === selectedPageId && selectedIds.has(element.id));
  }, [data.elements, selectedBlockIds, selectedPageId]);
  const drawingPropertiesContext = useMemo(() => {
    if (selectedDrawingElements.length > 0) {
      const values = readDrawingProperties(selectedDrawingElements);
      const selectedInkKinds = new Set(selectedDrawingElements.flatMap((element) =>
        element.type === "ink" ? [element.brush.kind] : [],
      ));
      return {
        contextLabel: selectedDrawingElements.length === 1 ? selectedDrawingElements[0].type : `${selectedDrawingElements.length} selected`,
        isSelection: true,
        strokeWidthPresets: selectedInkKinds.has("highlighter")
          ? [8, 18, 32] as const
          : selectedInkKinds.has("pen")
            ? [2, 4, 8] as const
            : [1, 2, 4] as const,
        supports: (property: DrawingProperty) => values[property].kind !== "unavailable",
        values,
      };
    }
    if (!isDrawingPreferenceTool(activeTool)) return null;
    const preference = drawingPreferences[activeTool];
    return {
      contextLabel: `${activeTool} defaults`,
      isSelection: false,
      strokeWidthPresets: activeTool === "highlighter"
        ? [8, 18, 32] as const
        : activeTool === "pen"
          ? [2, 4, 8] as const
          : [1, 2, 4] as const,
      supports: (property: DrawingProperty) => isPropertySupportedByTool(activeTool, property),
      values: drawingPropertiesFromPreference(preference),
    };
  }, [activeTool, drawingPreferences, selectedDrawingElements]);
  const isTextFormattingVisible = Boolean(
    activeTextEditor && !activeTextEditor.isDestroyed
  ) || selectedDrawingElements.some((element) => element.type === "text");
  const selectionHasLockedElements = useMemo(
    () => selectedBlockIds.some((id) => data.elements.some((element) => element.id === id && element.locked)),
    [data.elements, selectedBlockIds],
  );
  const selectionHasUnlockedElements = useMemo(
    () => selectedBlockIds.some((id) => data.elements.some((element) => element.id === id && !element.locked)),
    [data.elements, selectedBlockIds],
  );
  const openPages = useMemo<OpenPageTab[]>(() => {
    const pagesById = new Map(
      data.pages
        .filter((page) => !isTemplatePage(page))
        .map((page) => [page.id, page]),
    );
    const pageIdsWithBlocks = new Set(data.elements.map((block) => block.pageId));

    return openPageTabIds.flatMap((pageId) => {
      const page = pagesById.get(pageId);

      return page
        ? [
            {
              ...page,
              isBlankPlaceholder:
                page.title.trim() === "New page" && !pageIdsWithBlocks.has(page.id),
            },
          ]
        : [];
    });
  }, [data.elements, data.pages, openPageTabIds]);
  const shouldShowStarterShortcuts =
    !isStarterDismissed && (isWorkspaceEmpty || openPages.length === 0);
  const folderNamesById = useMemo(() => {
    const folderNames = new Map<string, string>();

    for (const folder of data.folders) {
      folderNames.set(folder.id, folder.name);
    }

    return folderNames;
  }, [data.folders]);
  const blocksByPageId = useMemo(() => {
    const pageBlocks = new Map<string, TextElement[]>();

    for (const block of data.elements) {
      if (!isTextElement(block)) {
        continue;
      }
      const currentBlocks = pageBlocks.get(block.pageId);

      if (currentBlocks) {
        currentBlocks.push(block);
      } else {
        pageBlocks.set(block.pageId, [block]);
      }
    }

    return pageBlocks;
  }, [data.elements]);
  const pageSearchResults = useMemo<PageSearchResult[]>(() => {
    const normalizedQuery = pageSearchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return [];
    }

    return data.pages.flatMap((page) => {
      if (isTemplatePage(page)) {
        return [];
      }

      const titleMatches = page.title.toLowerCase().includes(normalizedQuery);
      const pageBlocks = blocksByPageId.get(page.id) ?? [];
      let contentMatchCount = 0;
      let preview = "";

      for (const block of pageBlocks) {
        const normalizedContent = block.content.toLowerCase();

        if (!normalizedContent.includes(normalizedQuery)) {
          continue;
        }

        contentMatchCount += countSearchOccurrences(
          normalizedContent,
          normalizedQuery,
        );

        if (!preview) {
          preview = createPageSearchPreview(block.content, normalizedQuery);
        }
      }

      if (!titleMatches && contentMatchCount === 0) {
        return [];
      }

      return [
        {
          contentMatchCount,
          folderName:
            page.folderId === ROOT_FOLDER_ID
              ? "Root"
              : folderNamesById.get(page.folderId) ?? "Unknown folder",
          pageId: page.id,
          preview: preview || (titleMatches ? "Title match" : ""),
          title: page.title,
          titleMatches,
        },
      ];
    });
  }, [blocksByPageId, data.pages, folderNamesById, pageSearchQuery]);
  const blockSearchMatches = useMemo<SearchMatch[]>(() => {
    const nextQuery = searchQuery.trim().toLowerCase();

    if (!nextQuery) {
      return [];
    }

    const textVisibleBlocks = visibleBlocks.filter(isTextElement);
    const cacheKey = `${selectedPageId}:${nextQuery}:${textVisibleBlocks
      .map((block) => `${block.id}:${block.x}:${block.y}:${block.content}`)
      .join("|")}`;
    const cachedMatches = searchCache.current.get(cacheKey);

    if (cachedMatches) {
      return cachedMatches;
    }

    const nextMatches = textVisibleBlocks
      .flatMap((block) => {
        const matches: SearchMatch[] = [];
        const content = block.content.toLowerCase();
        let start = content.indexOf(nextQuery);

        while (start !== -1) {
          matches.push({
            blockId: block.id,
            start,
            end: start + nextQuery.length,
          });
          start = content.indexOf(nextQuery, start + nextQuery.length);
        }

        return matches;
      })
      .sort((firstMatch, secondMatch) => {
        const firstBlock = textVisibleBlocks.find((block) => block.id === firstMatch.blockId);
        const secondBlock = textVisibleBlocks.find((block) => block.id === secondMatch.blockId);

        if (!firstBlock || !secondBlock) {
          return 0;
        }

        return (
          firstBlock.y - secondBlock.y ||
          firstBlock.x - secondBlock.x ||
          firstMatch.start - secondMatch.start
        );
      });

    searchCache.current.set(cacheKey, nextMatches);

    if (searchCache.current.size > 20) {
      const oldestKey = searchCache.current.keys().next().value;

      if (oldestKey) {
        searchCache.current.delete(oldestKey);
      }
    }

    return nextMatches;
  }, [searchQuery, selectedPageId, visibleBlocks]);
  const titleSearchMatches = useMemo<CanvasSearchMatch[]>(() => {
    const nextQuery = searchQuery.trim().toLowerCase();

    if (!nextQuery || !selectedPage) {
      return [];
    }

    const title = selectedPage.title.toLowerCase();
    const matches: CanvasSearchMatch[] = [];
    let start = title.indexOf(nextQuery);

    while (start !== -1) {
      matches.push({
        end: start + nextQuery.length,
        kind: "title",
        start,
      });
      start = title.indexOf(nextQuery, start + nextQuery.length);
    }

    return matches;
  }, [searchQuery, selectedPage]);
  const searchMatches = useMemo<CanvasSearchMatch[]>(
    () => [
      ...titleSearchMatches,
      ...blockSearchMatches.map((match) => ({
        ...match,
        kind: "block" as const,
      })),
    ],
    [blockSearchMatches, titleSearchMatches],
  );
  const activeCanvasSearchMatch = searchMatches[activeSearchIndex] ?? null;
  const activeSearchMatch =
    activeCanvasSearchMatch?.kind === "block" ? activeCanvasSearchMatch : null;
  const canvasViewport = useMemo<ViewportRect | null>(() => {
    if (canvasSize.width === 0 || canvasSize.height === 0) {
      return null;
    }

    return {
      x: -livePanOffset.x / zoomLevel,
      y: -livePanOffset.y / zoomLevel,
      width: canvasSize.width / zoomLevel,
      height: canvasSize.height / zoomLevel,
    };
  }, [
    canvasSize.height,
    canvasSize.width,
    livePanOffset.x,
    livePanOffset.y,
    zoomLevel,
  ]);
  const isCanvasAuthoringAvailable = Boolean(
    selectedPage && !isTemplatePage(selectedPage) && canvasViewport,
  );
  const availableDrawingPropertiesContext = isCanvasAuthoringAvailable
    ? drawingPropertiesContext
    : null;
  isCanvasAuthoringAvailableRef.current = isCanvasAuthoringAvailable;
  isWorkbenchOverlayOpenRef.current =
    isAssistantOverlayOpen || isExplorerOverlayOpen;
  useEffect(() => {
    if (!drawingPropertiesContext) setIsPropertiesPanelOpen(false);
  }, [drawingPropertiesContext]);
  useEffect(() => {
    const wasCanvasAuthoringAvailable = previousCanvasAuthoringAvailableRef.current;
    previousCanvasAuthoringAvailableRef.current = isCanvasAuthoringAvailable;
    if (authoringFocusReturnRafRef.current !== null) {
      window.cancelAnimationFrame(authoringFocusReturnRafRef.current);
      authoringFocusReturnRafRef.current = null;
    }
    if (!isCanvasAuthoringAvailable) setIsPropertiesPanelOpen(false);
    if (
      !wasCanvasAuthoringAvailable ||
      isCanvasAuthoringAvailable ||
      isAssistantOverlayOpen ||
      isExplorerOverlayOpen
    ) return;

    authoringFocusReturnRafRef.current = window.requestAnimationFrame(() => {
      authoringFocusReturnRafRef.current = null;
      if (
        isCanvasAuthoringAvailableRef.current ||
        isWorkbenchOverlayOpenRef.current
      ) return;
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      canvasRef.current?.focus({ preventScroll: true });
    });

    return () => {
      if (authoringFocusReturnRafRef.current === null) return;
      window.cancelAnimationFrame(authoringFocusReturnRafRef.current);
      authoringFocusReturnRafRef.current = null;
    };
  }, [isAssistantOverlayOpen, isCanvasAuthoringAvailable, isExplorerOverlayOpen]);
  canvasViewportRef.current = canvasViewport;
  const renderedCanvasElements = useMemo(() => {
    const withConnectorPreview = connectorEndpointPreview
      ? visibleCanvasElements.map((element) => element.id === connectorEndpointPreview.id ? connectorEndpointPreview : element)
      : visibleCanvasElements;
    if (!canvasViewport) return withConnectorPreview;
    const overscan = 160 / Math.max(zoomLevel, 0.01);
    const selectedIds = new Set(selectedBlockIds);
    return withConnectorPreview.filter((element) =>
      element.type !== "ink" ||
      selectedIds.has(element.id) ||
      (
        element.x + element.width >= canvasViewport.x - overscan &&
        element.x <= canvasViewport.x + canvasViewport.width + overscan &&
        element.y + element.height >= canvasViewport.y - overscan &&
        element.y <= canvasViewport.y + canvasViewport.height + overscan
      ),
    );
  }, [canvasViewport, connectorEndpointPreview, selectedBlockIds, visibleCanvasElements, zoomLevel]);
  const renderedCanvasElementsById = useMemo(
    () => Object.fromEntries(renderedCanvasElements.map((element) => [element.id, element])),
    [renderedCanvasElements],
  );
  const offscreenGroups = useMemo<OffscreenGroup[]>(() => {
    if (!canvasViewport || visibleBlocks.length === 0) {
      return [];
    }

    const counts = new Map<OffscreenGroup["direction"], number>();

    for (const block of visibleBlocks) {
      const direction = getOffscreenDirection(block, canvasViewport);

      if (!direction) {
        continue;
      }

      counts.set(direction, (counts.get(direction) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([direction, count]) => ({
      direction,
      count,
    }));
  }, [canvasViewport, visibleBlocks]);
  const activeLlamaHarnessAgents = useMemo(
    () => llamaHarnessCapabilities?.allowedAgents ?? llamaHarnessAgents,
    [llamaHarnessAgents, llamaHarnessCapabilities],
  );
  const selectedLlamaHarnessAgent = useMemo(
    () =>
      activeLlamaHarnessAgents.find((agent) => agent.id === selectedLlamaHarnessAgentId) ??
      activeLlamaHarnessAgents[0] ??
      null,
    [activeLlamaHarnessAgents, selectedLlamaHarnessAgentId],
  );
  const assistantAgentLabel = selectedLlamaHarnessAgent
    ? `${selectedLlamaHarnessAgent.name} / ${llamaHarnessCapabilities?.model.modelName || "model not set"}`
    : llamaHarnessSetupStatus?.ready
      ? "No active agent selected"
      : "llama-harness setup incomplete";

  useEffect(() => {
    const wasNarrowWorkbench = wasNarrowWorkbenchRef.current;

    if (isNarrowWorkbench && !wasNarrowWorkbench) {
      setActiveNarrowOverlay(isAssistantOpen ? "assistant" : null);
    } else if (isNarrowWorkbench && isAssistantOpen) {
      setActiveNarrowOverlay((currentOverlay) => currentOverlay ?? "assistant");
    } else if (!isNarrowWorkbench && wasNarrowWorkbench) {
      setActiveNarrowOverlay(null);
    }

    wasNarrowWorkbenchRef.current = isNarrowWorkbench;
  }, [isAssistantOpen, isNarrowWorkbench]);

  useEffect(() => {
    const requestedEntryOverlay = overlayEntryFocusRequestRef.current;
    const shouldFocusEntry = Boolean(
      requestedEntryOverlay && requestedEntryOverlay === activeWorkbenchOverlay,
    );
    const shouldRestoreFocus =
      overlayReturnFocusRequestRef.current && !activeWorkbenchOverlay;

    if (!shouldFocusEntry && !shouldRestoreFocus) {
      if (requestedEntryOverlay && requestedEntryOverlay !== activeWorkbenchOverlay) {
        overlayEntryFocusRequestRef.current = null;
      }
      if (overlayReturnFocusRequestRef.current && activeWorkbenchOverlay) {
        overlayReturnFocusRequestRef.current = false;
      }
      if (!activeWorkbenchOverlay) {
        overlayReturnFocusRef.current = null;
      }
      return;
    }

    overlayEntryFocusRequestRef.current = null;
    overlayReturnFocusRequestRef.current = false;
    const frameId = window.requestAnimationFrame(() => {
      if (shouldFocusEntry && activeWorkbenchOverlay === "explorer") {
        explorerPanelRef.current?.focus();
      } else if (shouldFocusEntry && activeWorkbenchOverlay === "assistant") {
        assistantPanelRef.current?.focus();
      } else if (shouldRestoreFocus) {
        overlayReturnFocusRef.current?.focus();
        overlayReturnFocusRef.current = null;
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeWorkbenchOverlay]);

  useEffect(() => {
    if (!activeWorkbenchOverlay) {
      return;
    }

    const overlay: WorkbenchOverlay = activeWorkbenchOverlay;

    function handleOverlayKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeWorkbenchOverlay(overlay);
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const overlayPanel =
        overlay === "explorer"
          ? explorerPanelRef.current
          : assistantPanelRef.current;
      if (!overlayPanel) {
        return;
      }

      const focusBoundary =
        overlay === "explorer"
          ? (overlayPanel.closest<HTMLElement>(".sidebar") ?? overlayPanel)
          : overlayPanel;

      const focusableElements = Array.from(
        focusBoundary.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          element.getAttribute("aria-hidden") !== "true" &&
          element.getClientRects().length > 0,
      );
      const firstFocusableElement = focusableElements[0];
      const lastFocusableElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (!firstFocusableElement || !lastFocusableElement) {
        event.preventDefault();
        overlayPanel.focus();
        return;
      }

      if (!focusBoundary.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastFocusableElement : firstFocusableElement).focus();
        return;
      }

      if (
        event.shiftKey &&
        (activeElement === firstFocusableElement || activeElement === overlayPanel)
      ) {
        event.preventDefault();
        lastFocusableElement.focus();
      } else if (!event.shiftKey && activeElement === lastFocusableElement) {
        event.preventDefault();
        firstFocusableElement.focus();
      }
    }

    window.addEventListener("keydown", handleOverlayKeyDown, true);
    return () => window.removeEventListener("keydown", handleOverlayKeyDown, true);
  }, [activeWorkbenchOverlay, isNarrowWorkbench]);

  useEffect(() => {
    panOffsetRef.current = panOffset;
    setLivePanOffset(panOffset);
    setCanvasContentTransform(panOffset);
  }, [panOffset, zoomLevel]);

  useEffect(() => {
    return () => {
      if (panRafId.current !== null) {
        window.cancelAnimationFrame(panRafId.current);
      }

      cancelCanvasSelectionSession();
      cancelSelectionFrameInteraction(false);

      if (dragLayerSessionRef.current) {
        cleanupDragLayerSession(dragLayerSessionRef.current);
        dragLayerSessionRef.current = null;
      }

      stopAssistantRecordingStream();
    };
  }, []);

  useEffect(() => {
    function handleWindowBlur() {
      cancelCanvasSelectionSession();
      cancelSelectionFrameInteraction();
      if (!dragLayerSessionRef.current) {
        return;
      }

      cleanupDragLayerSession(dragLayerSessionRef.current);
      dragLayerSessionRef.current = null;
      setActiveMode("selected");
    }

    window.addEventListener("blur", handleWindowBlur);

    return () => window.removeEventListener("blur", handleWindowBlur);
  }, []);

  useEffect(() => {
    cancelCanvasSelectionSession();
    cancelSelectionFrameInteraction();
  }, [activeTool, selectedPageId]);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      try {
        const repository = createSceneRepository();
        const diagnostics = await repository.initializeStorage();
        const workspace = await repository.loadWorkspace();
        const savedData: AppData = {
          elements: workspace.elements,
          folders: workspace.folders,
          isDarkMode: workspace.isDarkMode,
          pages: workspace.pages.map(({ revision: _revision, ...page }) => page),
          sessionState: workspace.sessionState,
        };
        const imageSourcesByAssetId = new Map<string, string>();
        const imageElements = workspace.elements.filter(
          (element): element is ImageElement => element.type === "image",
        );
        const imageResults = await Promise.allSettled(
          imageElements.map(async (element) => ({
            assetId: element.assetId,
            source: assetDataUrl(await repository.loadAsset(element.assetId)),
          })),
        );
        for (const result of imageResults) {
          if (result.status === "fulfilled") {
            imageSourcesByAssetId.set(result.value.assetId, result.value.source);
          } else {
            console.warn("Could not load a managed canvas image.", result.reason);
          }
        }
        for (const warning of [...diagnostics.warnings, ...workspace.warnings]) {
          console.warn(warning);
        }

        if (!isMounted) {
          return;
        }

        const validPages = savedData.pages.filter((page) => !isTemplatePage(page));
        const validPageIds = new Set(validPages.map((page) => page.id));
        const validFolderIds = new Set([
          ROOT_FOLDER_ID,
          ...savedData.folders.map((folder) => folder.id),
        ]);
        const savedSessionState = savedData.sessionState;
        const hasSavedSessionState = Boolean(savedSessionState);
        const savedOpenPageIds = getValidUniquePageIds(
          savedSessionState?.openPageTabIds,
          validPageIds,
        );
        let nextSelectedPageId =
          savedSessionState?.selectedPageId &&
          validPageIds.has(savedSessionState.selectedPageId)
            ? savedSessionState.selectedPageId
            : "";

        if (!nextSelectedPageId && savedOpenPageIds.length > 0) {
          nextSelectedPageId = savedOpenPageIds[0];
        }

        if (!hasSavedSessionState && !nextSelectedPageId) {
          nextSelectedPageId = validPages[0]?.id ?? "";
        }

        const nextOpenPageIds = hasSavedSessionState
          ? [...savedOpenPageIds]
          : nextSelectedPageId
            ? [nextSelectedPageId]
            : [];

        if (
          nextSelectedPageId &&
          !nextOpenPageIds.includes(nextSelectedPageId)
        ) {
          nextOpenPageIds.push(nextSelectedPageId);
        }

        const nextSelectedPage = validPages.find(
          (page) => page.id === nextSelectedPageId,
        );
        const savedFolderId = savedSessionState?.selectedFolderId;
        const nextFolderId =
          nextSelectedPage?.folderId ??
          (savedFolderId && validFolderIds.has(savedFolderId)
            ? savedFolderId
            : savedData.folders[0]?.id ?? ROOT_FOLDER_ID);

        repositoryRef.current = repository;
        imageSourcesByAssetIdRef.current = imageSourcesByAssetId;
        pageRevisionsRef.current = new Map(
          workspace.pages.map((page: StoragePage) => [page.id, page.revision]),
        );
        const queue = new SceneChangeQueue(
          (batch) => repository.applySceneChanges(batch),
          (_pageId, state) => {
            if (isMounted) {
              setPersistenceStatus(state);
            }
          },
        );
        for (const page of workspace.pages) {
          queue.seed(
            page.id,
            page.revision,
            workspace.elements.filter((element) => element.pageId === page.id),
          );
        }
        sceneChangeQueueRef.current = queue;
        setData(savedData);
        setIsDarkMode(savedData.isDarkMode ?? true);
        setIsSidebarCollapsed(savedSessionState?.isExplorerCollapsed ?? false);
        setIsAssistantOpen(savedSessionState?.isAssistantOpen ?? false);
        setIsToolLocked(savedSessionState?.isDrawingToolLocked ?? false);
        setDrawingPreferences(normalizeDrawingPreferences(savedSessionState?.drawingPreferences));
        pageViewportsRef.current = normalizePageViewports(
          savedSessionState?.pageViewports,
          validPageIds,
        );
        setSelectedFolderId(nextFolderId);
        setSelectedPageId(nextSelectedPageId);
        setOpenPageTabIds(nextOpenPageIds);
        setSidebarPageSelection(nextSelectedPageId ? [nextSelectedPageId] : []);
        restorePageViewport(nextSelectedPageId);
        setSelectedBlockIds([]);
        setEditingBlockId(null);
        setActiveMode("canvas");
        setInsertionPoint(null);
        setIsEditingHeaderTitle(false);
        setPersistenceAvailable(true);
        setPersistenceStatus({ kind: "saved" });
      } catch (error) {
        // Vite/Playwright runs without a Tauri command bridge. Keep that path
        // usable in-memory. A desktop storage failure must never look like a
        // successful empty workspace, so show read-only legacy data if it is
        // still available and leave persistence disabled.
        console.warn("SQLite note storage is unavailable; using this session only.", error);
        repositoryRef.current = null;
        sceneChangeQueueRef.current = null;
        setPersistenceAvailable(false);
        if (!isTauri() || !isMounted) {
          return;
        }
        const storageError = error instanceof Error ? error : new Error(String(error));
        setPersistenceStatus({ kind: "failed", error: storageError });
        try {
          const legacy = fromLegacyAppData(
            await invoke<LegacyAppData>("load_app_data"),
            new Date(),
          );
          if (!isMounted) {
            return;
          }
          imageSourcesByAssetIdRef.current = legacy.imageSourcesByAssetId;
          setData(legacy.data);
          setIsDarkMode(legacy.data.isDarkMode ?? true);
          setIsToolLocked(legacy.data.sessionState?.isDrawingToolLocked ?? false);
          setDrawingPreferences(normalizeDrawingPreferences(legacy.data.sessionState?.drawingPreferences));
          const legacyPageIds = new Set(
            legacy.data.pages
              .filter((page) => !isTemplatePage(page))
              .map((page) => page.id),
          );
          const recoveredPageId = legacy.data.sessionState?.selectedPageId &&
            legacyPageIds.has(legacy.data.sessionState.selectedPageId)
            ? legacy.data.sessionState.selectedPageId
            : legacy.data.pages.find((page) => !isTemplatePage(page))?.id ?? "";
          const recoveredPage = legacy.data.pages.find((page) => page.id === recoveredPageId);
          pageViewportsRef.current = normalizePageViewports(
            legacy.data.sessionState?.pageViewports,
            legacyPageIds,
          );
          setSelectedFolderId(recoveredPage?.folderId ?? ROOT_FOLDER_ID);
          setSelectedPageId(recoveredPageId);
          setOpenPageTabIds(recoveredPageId ? [recoveredPageId] : []);
          restorePageViewport(recoveredPageId);
        } catch (legacyError) {
          console.error("Could not recover legacy note data after SQLite failed.", legacyError);
        }
      } finally {
        if (isMounted) {
          setIsLoaded(true);
        }
      }
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadProviderSettings() {
      try {
        const settings = await loadAIProviderSettings();

        if (!isMounted) {
          return;
        }

        setAIProviders(settings.providers);
        setAIModels(settings.models);
        setDefaultChatModelId(settings.defaultChatModelId ?? "");
        setDefaultEmbeddingModelId(settings.defaultEmbeddingModelId ?? "");
        setSelectedAIProviderId(settings.providers[0]?.id ?? "");
      } finally {
        if (isMounted) {
          setIsAIProviderSettingsLoaded(true);
        }
      }
    }

    loadProviderSettings();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isAIProviderSettingsLoaded) {
      return;
    }

    saveAIProviderSettings({
      defaultChatModelId: defaultChatModelId || undefined,
      defaultEmbeddingModelId: defaultEmbeddingModelId || undefined,
      models: aiModels,
      providers: aiProviders,
    }).catch((error) => {
      console.warn("Could not save AI provider settings.", error);
    });
  }, [
    aiModels,
    aiProviders,
    defaultChatModelId,
    defaultEmbeddingModelId,
    isAIProviderSettingsLoaded,
  ]);

  useEffect(() => {
    const validPageIds = new Set(
      data.pages
        .filter((page) => !isTemplatePage(page))
        .map((page) => page.id),
    );
    const retainedPageIds = selectedSidebarPageIdsRef.current.filter((pageId) =>
      validPageIds.has(pageId),
    );

    for (const pageId of pageViewportsRef.current.keys()) {
      if (!validPageIds.has(pageId)) {
        pageViewportsRef.current.delete(pageId);
      }
    }

    if (!areIdSelectionsEqual(selectedSidebarPageIdsRef.current, retainedPageIds)) {
      setSidebarPageSelection(retainedPageIds);
    }
  }, [data.pages]);

  useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [isSearchOpen]);

  useEffect(() => {
    const validPageIds = new Set(
      data.pages
        .filter((page) => !isTemplatePage(page))
        .map((page) => page.id),
    );

    setOpenPageTabIds((currentPageIds) => {
      const nextPageIds = currentPageIds.filter((pageId) => validPageIds.has(pageId));

      return areIdSelectionsEqual(currentPageIds, nextPageIds)
        ? currentPageIds
        : nextPageIds;
    });
  }, [data.pages]);

  useEffect(() => {
    if (!selectedPageId) {
      return;
    }

    const selectedPageExists = data.pages.some(
      (page) => page.id === selectedPageId && !isTemplatePage(page),
    );

    if (!selectedPageExists) {
      return;
    }

    setOpenPageTabIds((currentPageIds) =>
      currentPageIds.includes(selectedPageId)
        ? currentPageIds
        : [...currentPageIds, selectedPageId],
    );
  }, [data.pages, selectedPageId]);

  useEffect(() => {
    if (!isWorkspaceEmpty) {
      setIsStarterDismissed(false);
    }
  }, [isWorkspaceEmpty]);

  useEffect(() => {
    if (openPages.length > 0) {
      setIsStarterDismissed(false);
    }
  }, [openPages.length]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [searchQuery, selectedPageId]);

  useEffect(() => {
    if (activeSearchIndex >= searchMatches.length) {
      setActiveSearchIndex(0);
    }
  }, [activeSearchIndex, searchMatches.length]);

  useEffect(() => {
    const canvasElement = canvasRef.current;

    if (!canvasElement) {
      return;
    }

    function updateCanvasSize() {
      setCanvasSize({
        width: canvasElement?.clientWidth ?? 0,
        height: canvasElement?.clientHeight ?? 0,
      });
    }

    updateCanvasSize();
    const resizeObserver = new ResizeObserver(updateCanvasSize);
    resizeObserver.observe(canvasElement);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!isLoaded || !persistenceAvailable || isDrawingPropertyPreviewing) {
      return;
    }

    const saveTimer = window.setTimeout(() => {
      queueWorkspacePersistence({
        ...data,
        isDarkMode,
        sessionState: getSessionState(),
      });
    }, SAVE_DELAY_MS);

    return () => window.clearTimeout(saveTimer);
  }, [
    data,
    drawingPreferences,
    isAssistantOpen,
    isDarkMode,
    isDrawingPropertyPreviewing,
    isLoaded,
    isToolLocked,
    isSidebarCollapsed,
    openPageTabIds,
    panOffset.x,
    panOffset.y,
    persistenceAvailable,
    selectedFolderId,
    selectedPageId,
    zoomLevel,
  ]);

  useEffect(() => {
    if (!persistenceAvailable) {
      return;
    }
    const flushBeforeClose = () => {
      // Browsers do not guarantee async completion during unload, but this is
      // still useful for Tauri lifecycle paths that permit the promise to run.
      void flushPendingPersistence();
    };
    window.addEventListener("beforeunload", flushBeforeClose);
    return () => window.removeEventListener("beforeunload", flushBeforeClose);
  }, [
    isAssistantOpen,
    drawingPreferences,
    isDarkMode,
    isSidebarCollapsed,
    isToolLocked,
    openPageTabIds,
    panOffset.x,
    panOffset.y,
    persistenceAvailable,
    selectedFolderId,
    selectedPageId,
    zoomLevel,
  ]);

  useEffect(() => {
    writeSelectedLlamaHarnessAgentId(selectedLlamaHarnessAgentId);
  }, [selectedLlamaHarnessAgentId]);

  useEffect(() => {
    if (isAssistantOpen) {
      void refreshLlamaHarnessAssistant();
    }
  }, [isAssistantOpen]);

  useEffect(() => {
    const shouldDisableSelection =
      activeMode === "dragging" ||
      activeMode === "resizing" ||
      activeMode === "selecting" ||
      activeMode === "panning";

    if (!shouldDisableSelection) {
      return;
    }

    document.body.classList.add("is-interacting");

    return () => document.body.classList.remove("is-interacting");
  }, [activeMode]);

  function cloneBlocks(blocks: CanvasElement[]) {
    return blocks.map((block) =>
      isTextElement(block)
        ? { ...block, richContent: cloneRichContent(block.richContent) }
        : { ...block },
    );
  }

  function cloneRichContent(richContent: TextElement["richContent"]) {
    return richContent ? structuredClone(richContent) : undefined;
  }

  function cloneCopiedPageBlock(block: CopyableElement): CopiedPageBlock {
    const { id: _id, pageId: _pageId, ...blockFields } = block;

    return {
      ...blockFields,
      ...(isTextElement(block) && block.richContent
        ? { richContent: cloneRichContent(block.richContent) }
        : {}),
    };
  }

  function clonePageViewport(pageId: string): PageViewport | undefined {
    const sourceViewport =
      pageId === selectedPageIdRef.current
        ? {
            panOffset: { ...panOffsetRef.current },
            zoomLevel: zoomLevelRef.current,
          }
        : pageViewportsRef.current.get(pageId);

    if (!sourceViewport) {
      return undefined;
    }

    return {
      panOffset: { ...sourceViewport.panOffset },
      zoomLevel: sourceViewport.zoomLevel,
    };
  }

  function getSessionState(): AppSessionState {
    rememberPageViewport(selectedPageIdRef.current);

    const validPageIds = new Set(
      dataRef.current.pages
        .filter((page) => !isTemplatePage(page))
        .map((page) => page.id),
    );
    const pageViewports: NonNullable<AppSessionState["pageViewports"]> = {};

    for (const [pageId, viewport] of pageViewportsRef.current.entries()) {
      if (!validPageIds.has(pageId)) {
        continue;
      }

      pageViewports[pageId] = {
        panOffset: { ...viewport.panOffset },
        zoomLevel: viewport.zoomLevel,
      };
    }

    return {
      drawingPreferences: drawingPreferencesRef.current,
      isAssistantOpen,
      isDrawingToolLocked: isToolLockedRef.current,
      isExplorerCollapsed: isSidebarCollapsed,
      selectedFolderId: selectedFolderIdRef.current || undefined,
      selectedPageId: selectedPageIdRef.current || undefined,
      openPageTabIds: getValidUniquePageIds(
        openPageTabIdsRef.current,
        validPageIds,
      ),
      pageViewports,
    };
  }

  function queueWorkspacePersistence(snapshot: AppData): Promise<void> {
    const next = persistenceChainRef.current
      .catch(() => undefined)
      .then(() => persistWorkspaceSnapshot(snapshot));
    persistenceChainRef.current = next;
    // Effects intentionally do not await this promise. Keep the rejection
    // handled here while still returning it to explicit flush/retry callers.
    void next.catch(() => undefined);
    return next;
  }

  async function uploadPendingAssets(
    repository: SceneRepository,
    snapshot: AppData,
  ): Promise<AppData> {
    const replacements = new Map<string, { assetId: string; source: string; naturalHeight: number; naturalWidth: number }>();
    for (const image of snapshot.elements.filter(
      (element): element is ImageElement => element.type === "image",
    )) {
      const pending = pendingAssetUploadsRef.current.get(image.assetId);
      if (!pending) {
        continue;
      }
      const saved = await repository.saveAsset(
        assetRequestFromDataUrl(
          await managedImageDataUrl(pending.dataUrl),
          { fileName: pending.fileName },
        ),
      );
      replacements.set(image.assetId, {
        assetId: saved.id,
        naturalHeight: saved.naturalHeight ?? image.naturalHeight,
        naturalWidth: saved.naturalWidth ?? image.naturalWidth,
        source: pending.dataUrl,
      });
    }
    if (replacements.size === 0) {
      return snapshot;
    }
    const uploadTimestamp = Date.now();
    const replaceElements = (elements: CanvasElement[]) => elements.map((element) => {
      if (element.type !== "image") {
        return element;
      }
      const replacement = replacements.get(element.assetId);
      return replacement
        ? {
            ...element,
            assetId: replacement.assetId,
            naturalHeight: replacement.naturalHeight,
            naturalWidth: replacement.naturalWidth,
            updatedAt: uploadTimestamp,
          }
        : element;
    });
    for (const [oldAssetId, replacement] of replacements) {
      pendingAssetUploadsRef.current.delete(oldAssetId);
      imageSourcesByAssetIdRef.current.delete(oldAssetId);
      imageSourcesByAssetIdRef.current.set(replacement.assetId, replacement.source);
    }
    const uploadedSnapshot = {
      ...snapshot,
      elements: replaceElements(snapshot.elements),
    };
    const currentData = dataRef.current;
    const nextData = {
      ...currentData,
      elements: replaceElements(currentData.elements),
    };
    dataRef.current = nextData;
    setData(nextData);
    return uploadedSnapshot;
  }

  async function persistWorkspaceSnapshot(snapshot: AppData): Promise<void> {
    const repository = repositoryRef.current;
    const queue = sceneChangeQueueRef.current;
    if (!repository || !queue) {
      return;
    }

    setPersistenceStatus({ kind: "saving" });
    try {
      const persistableSnapshot = await uploadPendingAssets(repository, snapshot);
      // Do not delete a page or folder while an older element batch is still
      // queued. The structure transaction can then safely cascade deletions.
      await queue.flush();
      const structure = await repository.reconcileWorkspaceStructure({
        folders: persistableSnapshot.folders,
        isDarkMode: persistableSnapshot.isDarkMode,
        pages: persistableSnapshot.pages,
      });
      const currentPageIds = new Set(persistableSnapshot.pages.map((page) => page.id));
      for (const pageId of pageRevisionsRef.current.keys()) {
        if (!currentPageIds.has(pageId)) {
          queue.forgetPage(pageId);
        }
      }
      pageRevisionsRef.current = new Map(
        structure.pages.map((page) => [page.id, page.revision]),
      );
      for (const page of structure.pages) {
        queue.setRevision(page.id, page.revision);
      }
      await Promise.all(
        structure.pages.map((page) =>
          queue.replacePage(
            page.id,
            persistableSnapshot.elements.filter((element) => element.pageId === page.id),
          ),
        ),
      );
      await repository.saveSessionState(persistableSnapshot.sessionState ?? {});
      setPersistenceStatus({ kind: "saved" });
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      setPersistenceStatus({ kind: "failed", error });
      throw error;
    }
  }

  async function flushPendingPersistence(): Promise<void> {
    if (!persistenceAvailable) {
      return;
    }
    await queueWorkspacePersistence({
      ...dataRef.current,
      isDarkMode,
      sessionState: getSessionState(),
    });
  }

  function retryPersistence() {
    void flushPendingPersistence();
  }

  function cloneBlocksForPage(blocks: CanvasElement[], pageId: string) {
    return blocks.map((block) => ({
      ...block,
      id: createId("block"),
      pageId,
      ...(isTextElement(block)
        ? { richContent: cloneRichContent(block.richContent) }
        : {}),
    }));
  }

  function isTemplatePage(page: AppData["pages"][number]) {
    return page.folderId === PAGE_TEMPLATE_FOLDER_ID;
  }

  function insertPagesAfterLastPageInFolder(
    pages: AppData["pages"],
    folderId: string,
    insertedPages: AppData["pages"],
  ) {
    let insertIndex = pages.length;

    for (let index = pages.length - 1; index >= 0; index -= 1) {
      if (pages[index].folderId === folderId) {
        insertIndex = index + 1;
        break;
      }
    }

    return [
      ...pages.slice(0, insertIndex),
      ...insertedPages,
      ...pages.slice(insertIndex),
    ];
  }

  function setSidebarPageSelection(pageIds: string[]) {
    const nextPageIds = pageIds.filter(
      (pageId, index) => pageId && pageIds.indexOf(pageId) === index,
    );

    selectedSidebarPageIdsRef.current = nextPageIds;
    setSelectedSidebarPageIds((currentPageIds) =>
      areIdSelectionsEqual(currentPageIds, nextPageIds)
        ? currentPageIds
        : nextPageIds,
    );
  }

  function toggleSidebarPageSelection(pageId: string) {
    const currentPageIds = selectedSidebarPageIdsRef.current;
    const nextPageIds = currentPageIds.includes(pageId)
      ? currentPageIds.filter((currentPageId) => currentPageId !== pageId)
      : [...currentPageIds, pageId];

    setSidebarPageSelection(nextPageIds);
  }

  function snapValue(value: number) {
    return Math.round(value / GRID_SIZE) * GRID_SIZE;
  }

  function snapPoint(point: CanvasPoint): CanvasPoint {
    if (!isSnapToGridEnabledRef.current) {
      return point;
    }

    return {
      x: snapValue(point.x),
      y: snapValue(point.y),
    };
  }

  function snapBlockPosition<T extends BoxCanvasElement>(block: T): T {
    if (!isSnapToGridEnabledRef.current) {
      return block;
    }

    return {
      ...block,
      x: snapValue(block.x),
      y: snapValue(block.y),
    };
  }

  function snapManualResizeUpdates(updates: BlockUpdates): BlockUpdates {
    if (!isSnapToGridEnabledRef.current || !updates.isWidthManuallyResized) {
      return updates;
    }

    const snappedUpdates: BlockUpdates = {
      ...updates,
    };

    if (updates.x !== undefined) {
      snappedUpdates.x = snapValue(updates.x);
    }

    if (updates.y !== undefined) {
      snappedUpdates.y = snapValue(updates.y);
    }

    if (updates.width !== undefined) {
      snappedUpdates.width = Math.max(GRID_SIZE, snapValue(updates.width));
    }

    return snappedUpdates;
  }

  function areBlocksEqual(firstBlocks: CanvasElement[], secondBlocks: CanvasElement[]) {
    if (firstBlocks.length !== secondBlocks.length) {
      return false;
    }

    return firstBlocks.every((firstBlock, index) => JSON.stringify(firstBlock) === JSON.stringify(secondBlocks[index]));
  }

  function pushBlockUndoSnapshot(blocks: CanvasElement[]) {
    undoBlockHistoryRef.current = [
      ...undoBlockHistoryRef.current.slice(-(MAX_BLOCK_HISTORY_ENTRIES - 1)),
      cloneBlocks(blocks),
    ];
    redoBlockHistoryRef.current = [];
  }

  function setBlocksWithHistory(
    getNextBlocks: (currentBlocks: CanvasElement[]) => CanvasElement[],
  ) {
    const currentData = dataRef.current;
    const nextBlocks = getNextBlocks(currentData.elements);

    if (areBlocksEqual(currentData.elements, nextBlocks)) {
      return;
    }

    pushBlockUndoSnapshot(currentData.elements);

    const nextData = {
      ...currentData,
      elements: nextBlocks,
    };

    dataRef.current = nextData;
    setData(nextData);
  }

  function drawingPropertyPreviewOwnerKey() {
    return `${selectedPageIdRef.current}\u0000${[...selectedBlockIdsRef.current].sort().join("\u0000")}`;
  }

  const cancelDrawingPropertyPreview = useCallback(() => {
    const transaction = drawingPropertyPreviewRef.current;
    if (!transaction) return;
    drawingPropertyPreviewRef.current = null;
    const nextData = { ...dataRef.current, elements: transaction.baseline };
    dataRef.current = nextData;
    setData(nextData);
    setIsDrawingPropertyPreviewing(false);
  }, []);

  function previewDrawingProperty(update: DrawingPropertyUpdate) {
    const selectedIds = new Set(selectedBlockIdsRef.current);
    if (selectedIds.size === 0) return;
    const ownerKey = drawingPropertyPreviewOwnerKey();
    let transaction = drawingPropertyPreviewRef.current;
    if (transaction && transaction.ownerKey !== ownerKey) {
      cancelDrawingPropertyPreview();
      transaction = null;
    }
    if (!transaction) {
      transaction = {
        baseline: dataRef.current.elements,
        ownerKey,
        selectedIds: [...selectedIds],
      };
      drawingPropertyPreviewRef.current = transaction;
      setIsDrawingPropertyPreviewing(true);
    }
    const nextElements = applyDrawingPropertyUpdate(transaction.baseline, new Set(transaction.selectedIds), update);
    const nextData = { ...dataRef.current, elements: nextElements };
    dataRef.current = nextData;
    setData(nextData);
  }

  function updateDrawingProperty(update: DrawingPropertyUpdate) {
    const selectedIds = new Set(selectedBlockIdsRef.current);
    if (selectedIds.size > 0) {
      const transaction = drawingPropertyPreviewRef.current;
      if (transaction) {
        if (transaction.ownerKey !== drawingPropertyPreviewOwnerKey()) {
          cancelDrawingPropertyPreview();
          return;
        }
        const ownedIds = new Set(transaction.selectedIds);
        const nextElements = applyDrawingPropertyUpdate(transaction.baseline, ownedIds, update);
        drawingPropertyPreviewRef.current = null;
        setIsDrawingPropertyPreviewing(false);
        if (!areBlocksEqual(transaction.baseline, nextElements)) pushBlockUndoSnapshot(transaction.baseline);
        const nextData = { ...dataRef.current, elements: nextElements };
        dataRef.current = nextData;
        setData(nextData);
        return;
      }
      setBlocksWithHistory((elements) => applyDrawingPropertyUpdate(elements, selectedIds, update));
      return;
    }
    const tool = activeToolRef.current;
    if (!isDrawingPreferenceTool(tool)) return;
    setDrawingPreferences((current) => updateDrawingPreference(current, tool, update));
  }

  const drawingPropertyPreviewOwner = `${selectedPageId}\u0000${[...selectedBlockIds].sort().join("\u0000")}`;
  useEffect(() => {
    const transaction = drawingPropertyPreviewRef.current;
    if (transaction && transaction.ownerKey !== drawingPropertyPreviewOwner) {
      cancelDrawingPropertyPreview();
    }
  }, [cancelDrawingPropertyPreview, drawingPropertyPreviewOwner]);

  useEffect(() => {
    window.addEventListener("blur", cancelDrawingPropertyPreview);
    return () => {
      window.removeEventListener("blur", cancelDrawingPropertyPreview);
      cancelDrawingPropertyPreview();
    };
  }, [cancelDrawingPropertyPreview]);

  function updateSelectedLayer(action: LayerAction) {
    const selectedIds = new Set(selectedBlockIdsRef.current);
    if (selectedIds.size === 0) return;
    setBlocksWithHistory((elements) => reorderLayers(elements, selectedIds, action));
  }

  function restoreBlockHistory(direction: "undo" | "redo") {
    const fromStack =
      direction === "undo"
        ? undoBlockHistoryRef.current
        : redoBlockHistoryRef.current;
    const snapshot = fromStack[fromStack.length - 1];

    if (!snapshot) {
      return;
    }

    if (direction === "undo") {
      undoBlockHistoryRef.current = undoBlockHistoryRef.current.slice(0, -1);
    } else {
      redoBlockHistoryRef.current = redoBlockHistoryRef.current.slice(0, -1);
    }

    const currentData = dataRef.current;
    const currentSnapshot = cloneBlocks(currentData.elements);

    if (direction === "undo") {
      redoBlockHistoryRef.current = [
        ...redoBlockHistoryRef.current.slice(
          -(MAX_BLOCK_HISTORY_ENTRIES - 1),
        ),
        currentSnapshot,
      ];
    } else {
      undoBlockHistoryRef.current = [
        ...undoBlockHistoryRef.current.slice(
          -(MAX_BLOCK_HISTORY_ENTRIES - 1),
        ),
        currentSnapshot,
      ];
    }

    const nextData = {
      ...currentData,
      elements: cloneBlocks(snapshot),
    };

    dataRef.current = nextData;
    setData(nextData);
    const retainedSelectedBlockIds = selectedBlockIdsRef.current.filter(
      (blockId) =>
        snapshot.some((block) => block.id === blockId),
    );

    setSelectedBlockIds(retainedSelectedBlockIds);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode(
      retainedSelectedBlockIds.length > 0 ? "selected" : "canvas",
    );
  }

  function copySelectedBlocks() {
    const selectedBlockIdSet = new Set(selectedBlockIds);
    const blocksToCopy = visibleBlocks.filter((block) =>
      selectedBlockIdSet.has(block.id),
    );

    if (blocksToCopy.length === 0) {
      return false;
    }

    const minX = Math.min(...blocksToCopy.map((block) => block.x));
    const minY = Math.min(...blocksToCopy.map((block) => block.y));

    copiedBlocksRef.current = blocksToCopy
      .filter((block): block is CopyableElement => block.type === "text" || block.type === "image")
      .map((block) => {
        const { id: _id, pageId: _pageId, x, y, ...blockFields } = block;
        return {
          ...blockFields,
          ...(isTextElement(block) && block.richContent
            ? { richContent: cloneRichContent(block.richContent) }
            : {}),
          offsetX: x - minX,
          offsetY: y - minY,
        } as CopiedBlock;
      });
    copiedContentKindRef.current = "blocks";

    return true;
  }

  function copySelectedPages() {
    const currentData = dataRef.current;
    const selectedPageIdSet = new Set(selectedSidebarPageIdsRef.current);
    const pagesToCopy = currentData.pages.filter(
      (page) => selectedPageIdSet.has(page.id) && !isTemplatePage(page),
    );

    if (pagesToCopy.length === 0) {
      return false;
    }

    copiedPagesRef.current = pagesToCopy.map((page) => {
      const { id: _id, folderId: _folderId, ...pageFields } = page;

      return {
        ...pageFields,
        elements: currentData.elements
          .filter((block): block is CopyableElement =>
            block.pageId === page.id && (block.type === "text" || block.type === "image"),
          )
          .map(cloneCopiedPageBlock),
        viewport: clonePageViewport(page.id),
      };
    });
    copiedContentKindRef.current = "pages";

    return true;
  }

  function getPasteOrigin() {
    if (insertionPoint) {
      return insertionPoint;
    }

    const currentCanvasViewport = canvasViewportRef.current;

    if (currentCanvasViewport) {
      return {
        x: currentCanvasViewport.x + currentCanvasViewport.width / 2,
        y: currentCanvasViewport.y + currentCanvasViewport.height / 2,
      };
    }

    return { x: PASTED_BLOCK_OFFSET, y: PASTED_BLOCK_OFFSET };
  }

  function getImagePasteOrigin() {
    if (insertionPoint) {
      return insertionPoint;
    }

    const currentEditingBlockId = editingBlockIdRef.current;
    const currentEditingBlock = currentEditingBlockId
      ? dataRef.current.elements.find((block) => block.id === currentEditingBlockId)
      : null;

    if (currentEditingBlock && isBoxCanvasElement(currentEditingBlock)) {
      return snapPoint({
        x: currentEditingBlock.x,
        y: currentEditingBlock.y + currentEditingBlock.height + PASTED_BLOCK_OFFSET,
      });
    }

    return getPasteOrigin();
  }

  function getClipboardImage(clipboardData: DataTransfer | null): ClipboardImage | null {
    const clipboardItems = Array.from(clipboardData?.items ?? []);
    const imageItem = clipboardItems.find((item) =>
      item.type.startsWith("image/"),
    );
    const imageItemFile = imageItem?.getAsFile();

    if (imageItemFile) {
      return {
        file: imageItemFile,
        kind: "file",
        name: imageItemFile.name || "Pasted image",
      };
    }

    const imageFile = Array.from(clipboardData?.files ?? []).find((file) =>
      file.type.startsWith("image/"),
    );

    if (imageFile) {
      return {
        file: imageFile,
        kind: "file",
        name: imageFile.name || "Pasted image",
      };
    }

    const html = clipboardData?.getData("text/html") ?? "";
    const htmlImageSource = getClipboardHtmlImageSource(html);

    if (htmlImageSource) {
      return {
        kind: "source",
        name: getImageNameFromSource(htmlImageSource),
        source: htmlImageSource,
      };
    }

    return null;
  }

  function getClipboardHtmlImageSource(html: string) {
    if (!html.trim()) {
      return null;
    }

    const template = document.createElement("template");
    template.innerHTML = html;
    const imageElement = template.content.querySelector("img");
    const imageSource = imageElement?.getAttribute("src")?.trim();

    if (!imageSource || !isPasteableImageSource(imageSource)) {
      return null;
    }

    return imageSource;
  }

  function isPasteableImageSource(source: string) {
    return source.startsWith("data:image/") || /^https?:\/\//i.test(source);
  }

  function getImageNameFromSource(source: string) {
    if (source.startsWith("data:image/")) {
      return "Pasted image";
    }

    try {
      const pathName = new URL(source).pathname;
      const pathParts = pathName.split("/").filter(Boolean);
      const name = decodeURIComponent(pathParts[pathParts.length - 1] ?? "");

      return name || "Pasted image";
    } catch {
      return "Pasted image";
    }
  }

  function shouldReadNavigatorClipboardImage(clipboardData: DataTransfer | null) {
    const clipboard = navigator.clipboard as
      | (Clipboard & { read?: () => Promise<ClipboardReadItem[]> })
      | undefined;

    return (
      typeof clipboard?.read === "function" &&
      (clipboardData?.items.length ?? 0) === 0 &&
      (clipboardData?.files.length ?? 0) === 0 &&
      (clipboardData?.types.length ?? 0) === 0
    );
  }

  function createImageBlockFromBlob(
    pasteOrigin: CanvasPoint,
    imageBlob: Blob,
    imageName: string,
  ) {
    if (rejectOversizedImageBlob(imageBlob)) return;
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        return;
      }

      void createImageBlock(
        pasteOrigin.x,
        pasteOrigin.y,
        reader.result,
        imageName,
      );
    };
    reader.readAsDataURL(imageBlob);
  }

  async function pasteNavigatorClipboardImage(pasteOrigin: CanvasPoint) {
    const clipboard = navigator.clipboard as
      | (Clipboard & { read?: () => Promise<ClipboardReadItem[]> })
      | undefined;

    if (typeof clipboard?.read !== "function") {
      return;
    }

    try {
      const clipboardItems = await clipboard.read();

      for (const clipboardItem of clipboardItems) {
        const imageType = clipboardItem.types.find((type) =>
          type.startsWith("image/"),
        );

        if (!imageType) {
          continue;
        }

        const imageBlob = await clipboardItem.getType(imageType);
        createImageBlockFromBlob(pasteOrigin, imageBlob, "Pasted image");
        return;
      }
    } catch {
      return;
    }
  }

  function pasteClipboardImage(event: ClipboardEvent) {
    if (!selectedPageIdRef.current) {
      return false;
    }

    const clipboardImage = getClipboardImage(event.clipboardData);

    if (!clipboardImage) {
      if (!shouldReadNavigatorClipboardImage(event.clipboardData)) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      void pasteNavigatorClipboardImage(getImagePasteOrigin());
      return true;
    }

    event.preventDefault();
    event.stopPropagation();
    const pasteOrigin = getImagePasteOrigin();

    if (clipboardImage.kind === "source") {
      void createImageBlock(
        pasteOrigin.x,
        pasteOrigin.y,
        clipboardImage.source,
        clipboardImage.name,
      );
      return true;
    }

    createImageBlockFromBlob(pasteOrigin, clipboardImage.file, clipboardImage.name);
    return true;
  }

  function pasteCopiedBlocks() {
    if (
      copiedContentKindRef.current !== "blocks" ||
      !selectedPageId ||
      copiedBlocksRef.current.length === 0
    ) {
      return false;
    }

    const pasteOrigin = snapPoint(getPasteOrigin());
    const isViewportCenteredPaste =
      !insertionPoint && Boolean(canvasViewportRef.current);
    const pastedGroupSize = copiedBlocksRef.current.reduce(
      (currentSize, block) => ({
        width: Math.max(currentSize.width, block.offsetX + block.width),
        height: Math.max(currentSize.height, block.offsetY + block.height),
      }),
      { width: 0, height: 0 },
    );
    const pastedGroupOrigin = isViewportCenteredPaste
      ? {
          x: pasteOrigin.x - pastedGroupSize.width / 2,
          y: pasteOrigin.y - pastedGroupSize.height / 2,
        }
      : pasteOrigin;
    const pastedBlocks: CopyableElement[] = copiedBlocksRef.current.map(
      ({ offsetX, offsetY, ...block }) => ({
        ...block,
        id: createId("block"),
        pageId: selectedPageId,
        x: pastedGroupOrigin.x + offsetX,
        y: pastedGroupOrigin.y + offsetY,
      } as CopyableElement),
    );

    setBlocksWithHistory((currentBlocks) => [
      ...currentBlocks,
      ...pastedBlocks.map(snapBlockPosition),
    ]);
    setSelectedBlockIds(pastedBlocks.map((block) => block.id));
    setEditingBlockId(null);
    setIsCanvasKeyboardActive(true);
    setInsertionPoint(null);
    setActiveMode("selected");

    return true;
  }

  function pasteCopiedPages() {
    if (
      copiedContentKindRef.current !== "pages" ||
      copiedPagesRef.current.length === 0
    ) {
      return false;
    }

    const currentData = dataRef.current;
    const folderId = selectedFolderIdRef.current || ROOT_FOLDER_ID;

    const pastedPages: AppData["pages"] = [];
    const pastedBlocks: CanvasElement[] = [];

    for (const copiedPage of copiedPagesRef.current) {
      const { elements, viewport, ...pageFields } = copiedPage;
      const pageId = createId("page");

      pastedPages.push({
        ...pageFields,
        id: pageId,
        folderId,
      });
      pastedBlocks.push(
        ...elements.map((block) => ({
          ...block,
          id: createId("block"),
          pageId,
        } as CanvasElement)),
      );

      if (viewport) {
        pageViewportsRef.current.set(pageId, {
          panOffset: { ...viewport.panOffset },
          zoomLevel: viewport.zoomLevel,
        });
      }
    }

    if (pastedPages.length === 0) {
      return false;
    }

    const nextData = {
      ...currentData,
      pages: insertPagesAfterLastPageInFolder(
        currentData.pages,
        folderId,
        pastedPages,
      ),
      elements: [...currentData.elements, ...pastedBlocks],
    };
    const firstPastedPageId = pastedPages[0].id;

    dataRef.current = nextData;
    setData(nextData);
    rememberPageViewport(selectedPageIdRef.current);
    selectedFolderIdRef.current = folderId;
    selectedPageIdRef.current = firstPastedPageId;
    setSelectedFolderId(folderId);
    setSelectedPageId(firstPastedPageId);
    setSidebarPageSelection(pastedPages.map((page) => page.id));
    restorePageViewport(firstPastedPageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(false);
    setActiveMode("canvas");

    return true;
  }

  const deleteBlocks = useCallback((blockIds: string[]) => {
    const requestedIds = new Set(blockIds);
    const blockIdsToDelete = new Set(
      dataRef.current.elements
        .filter((block) => requestedIds.has(block.id) && !block.locked)
        .map((block) => block.id),
    );
    if (blockIdsToDelete.size === 0) return false;

    setBlocksWithHistory((currentBlocks) =>
      detachConnectorEndpointsForDeletedTargets(currentBlocks, blockIdsToDelete)
        .filter((block) => !blockIdsToDelete.has(block.id)),
    );
    setSelectedBlockIds((currentBlockIds) =>
      currentBlockIds.filter((blockId) => !blockIdsToDelete.has(blockId)),
    );
    setEditingBlockId((currentBlockId) =>
      currentBlockId && blockIdsToDelete.has(currentBlockId)
        ? null
        : currentBlockId,
    );
    return true;
  }, []);

  const selectAllVisibleBlocks = useCallback(() => {
    const currentPageId = selectedPageIdRef.current;
    const visibleBlockIds = dataRef.current.elements
      .filter((block) => block.pageId === currentPageId)
      .map((block) => block.id);

    if (visibleBlockIds.length === 0) {
      return false;
    }

    selectedBlockIdsRef.current = visibleBlockIds;
    setSelectedBlockIds((currentBlockIds) =>
      areIdSelectionsEqual(currentBlockIds, visibleBlockIds)
        ? currentBlockIds
        : visibleBlockIds,
    );
    editingBlockIdRef.current = null;
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
    return true;
  }, []);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (activeWorkbenchOverlay) {
        return;
      }

      if (event.key === "Escape") {
        cancelCanvasSelectionSession();
        cancelSelectionFrameInteraction();
        clearPendingImagePlacement();
      }

      const currentEditingBlockId = editingBlockIdRef.current;

      if (
        event.code === "Space" &&
        !currentEditingBlockId &&
        !isTextEntryTarget(event.target) &&
        isCanvasKeyboardActive
      ) {
        event.preventDefault();
        isTemporaryHandActiveRef.current = true;
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "n" &&
        !currentEditingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();

        if (isWorkspaceEmpty) {
          createStarterPage();
        } else {
          createPage();
        }

        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "o" &&
        !currentEditingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();
        focusPageSearch();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        focusCanvasSearch();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z" &&
        !currentEditingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();
        restoreBlockHistory(event.shiftKey ? "redo" : "undo");
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "y" &&
        !currentEditingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();
        restoreBlockHistory("redo");
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "c" &&
        !currentEditingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        const didCopy = isCanvasKeyboardActive
          ? copySelectedBlocks()
          : copySelectedPages();

        if (didCopy) {
          event.preventDefault();
        }

        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "a" &&
        !currentEditingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();

        if (!isCanvasKeyboardActive || visibleBlocks.length === 0) {
          return;
        }

        selectAllVisibleBlocks();
        return;
      }

      const shortcutTarget = event.target instanceof Element ? event.target : null;
      const hasCanvasOrToolFocus =
        shortcutTarget === canvasRef.current ||
        Boolean(shortcutTarget?.closest(".canvas-tool-palette, [data-canvas-element-id], [data-block-id]"));
      const shortcutTool = drawingToolForShortcut(event, hasCanvasOrToolFocus);
      if (
        !currentEditingBlockId &&
        !isTextEntryTarget(event.target) &&
        (!insertionPoint || event.key === "Escape") &&
        shortcutTool
      ) {
        event.preventDefault();
        selectDrawingTool(shortcutTool);
        return;
      }

      if (
        !currentEditingBlockId &&
        insertionPoint &&
        selectedPageId &&
        event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();
        createTextBlock(insertionPoint.x, insertionPoint.y, event.key, {
          placement: "text-caret",
        });
        setInsertionPoint(null);
        return;
      }

      if (currentEditingBlockId || isTextEntryTarget(event.target)) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        updateZoom(ZOOM_STEP);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "-") {
        event.preventDefault();
        updateZoom(-ZOOM_STEP);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        setZoomLevel(DEFAULT_ZOOM);
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedBlockIds.length > 0
      ) {
        event.preventDefault();
        const lockedIds = new Set(
          dataRef.current.elements
            .filter((element) => element.locked && selectedBlockIds.includes(element.id))
            .map((element) => element.id),
        );
        if (deleteBlocks(selectedBlockIds)) {
          setActiveMode(lockedIds.size > 0 ? "selected" : "canvas");
        }
        return;
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code === "Space") {
        isTemporaryHandActiveRef.current = false;
      }
    }

    document.addEventListener("keydown", handleKeyboard);
    document.addEventListener("keyup", handleKeyUp);

    return () => {
      document.removeEventListener("keydown", handleKeyboard);
      document.removeEventListener("keyup", handleKeyUp);
      isTemporaryHandActiveRef.current = false;
    };
  }, [
    activeWorkbenchOverlay,
    deleteBlocks,
    insertionPoint,
    isCanvasKeyboardActive,
    isStarterDismissed,
    isWorkspaceEmpty,
    selectAllVisibleBlocks,
    selectedBlockIds,
    selectedPageId,
    visibleBlocks,
  ]);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (activeWorkbenchOverlay) {
        return;
      }

      const isTextEntryPaste = isTextEntryTarget(event.target);

      if (isTextEntryPaste) {
        return;
      }

      if (pasteCopiedPages()) {
        event.preventDefault();
        return;
      }

      if (!selectedPageId) {
        return;
      }

      if (pasteCopiedBlocks()) {
        event.preventDefault();
        return;
      }

      if (pasteClipboardImage(event)) {
        return;
      }

      const pastedText = event.clipboardData?.getData("text/plain");

      if (pastedText && insertionPoint) {
        event.preventDefault();
        createTextBlock(insertionPoint.x, insertionPoint.y, pastedText, {
          placement: "text-caret",
        });
      }
    }

    document.addEventListener("paste", handlePaste, true);

    return () => document.removeEventListener("paste", handlePaste, true);
  }, [activeWorkbenchOverlay, insertionPoint, selectedPageId]);

  function setCanvasContentTransform(nextPanOffset: PanOffset) {
    const canvasContentElement = canvasContentRef.current;

    if (!canvasContentElement) {
      return;
    }

    canvasContentElement.style.transform = `translate3d(${nextPanOffset.x}px, ${nextPanOffset.y}px, 0) scale(${zoomLevel})`;
  }

  function scheduleCanvasContentTransform(nextPanOffset: PanOffset) {
    panOffsetRef.current = nextPanOffset;

    if (panRafId.current !== null) {
      return;
    }

    panRafId.current = window.requestAnimationFrame(() => {
      setCanvasContentTransform(panOffsetRef.current);
      setLivePanOffset(panOffsetRef.current);
      panRafId.current = null;
    });
  }

  function clearMarquee() {
    cleanupMarquee(selectionRafId, pendingSelectionRect, selectionRectRef);
  }

  function cancelCanvasSelectionSession() {
    cancelCanvasSelectionRef.current();
    clearMarquee();
  }

  function scheduleSelectionRectangle(rect: SelectionRect) {
    pendingSelectionRect.current = rect;

    if (selectionRafId.current !== null) {
      return;
    }

    selectionRafId.current = window.requestAnimationFrame(() => {
      const nextRect = pendingSelectionRect.current;
      const selectionElement = selectionRectRef.current;

      if (nextRect && selectionElement) {
        const zoom = zoomLevelRef.current;
        const pan = panOffsetRef.current;
        selectionElement.style.display = "block";
        selectionElement.style.left = `${pan.x + nextRect.x * zoom}px`;
        selectionElement.style.top = `${pan.y + nextRect.y * zoom}px`;
        selectionElement.style.width = `${nextRect.width * zoom}px`;
        selectionElement.style.height = `${nextRect.height * zoom}px`;
      }

      selectionRafId.current = null;
      pendingSelectionRect.current = null;
    });
  }

  function updateZoom(delta: number) {
    setZoomLevel((currentZoom) =>
      Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom + delta)),
    );
  }

  function getDefaultPageViewport(): PageViewport {
    return {
      panOffset: { ...DEFAULT_PAN_OFFSET },
      zoomLevel: DEFAULT_ZOOM,
    };
  }

  function rememberPageViewport(pageId: string) {
    if (!pageId) {
      return;
    }

    pageViewportsRef.current.set(pageId, {
      panOffset: { ...panOffsetRef.current },
      zoomLevel: zoomLevelRef.current,
    });
  }

  function restorePageViewport(pageId: string) {
    const nextViewport =
      pageViewportsRef.current.get(pageId) ?? getDefaultPageViewport();

    panOffsetRef.current = { ...nextViewport.panOffset };
    setPanOffset(nextViewport.panOffset);
    setLivePanOffset(nextViewport.panOffset);
    setZoomLevel(nextViewport.zoomLevel);
  }

  function switchSelectedPage(nextPageId: string) {
    if (selectedPageId === nextPageId) {
      return;
    }

    void flushPendingPersistence();
    rememberPageViewport(selectedPageId);
    selectedPageIdRef.current = nextPageId;
    setSelectedPageId(nextPageId);
    restorePageViewport(nextPageId);
  }

  function forgetPageViewports(pageIds: Iterable<string>) {
    for (const pageId of pageIds) {
      pageViewportsRef.current.delete(pageId);
    }
  }

  function createFolder() {
    const folderId = createId("folder");

    setData((currentData) => ({
      ...currentData,
      folders: [...currentData.folders, { id: folderId, name: "New folder" }],
    }));
    rememberPageViewport(selectedPageId);
    selectedFolderIdRef.current = folderId;
    selectedPageIdRef.current = "";
    setSelectedFolderId(folderId);
    setSelectedPageId("");
    setSidebarPageSelection([]);
    restorePageViewport("");
    setEditingFolderId(folderId);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function renameFolder(folderId: string, name: string) {
    const nextName = name.trim();

    if (!nextName) {
      return;
    }

    setData((currentData) => ({
      ...currentData,
      folders: currentData.folders.map((folder) =>
        folder.id === folderId ? { ...folder, name: nextName } : folder,
      ),
    }));
  }

  function deleteFolder(folderId: string) {
    setData((currentData) => {
      const nextFolders = currentData.folders.filter(
        (folder) => folder.id !== folderId,
      );
      const deletedPageIds = new Set(
        currentData.pages
          .filter((page) => page.folderId === folderId)
          .map((page) => page.id),
      );
      const nextPages = currentData.pages.filter(
        (page) => page.folderId !== folderId,
      );
      const nextRootPage = nextPages.find(
        (page) => page.folderId === ROOT_FOLDER_ID && !isTemplatePage(page),
      );
      const nextFolderId = nextRootPage?.folderId ?? nextFolders[0]?.id ?? ROOT_FOLDER_ID;
      const nextSelectedPageId =
        nextRootPage?.id ??
        nextPages.find((page) => page.folderId === nextFolderId)?.id ??
        "";

      forgetPageViewports(deletedPageIds);
      selectedFolderIdRef.current = nextFolderId;
      selectedPageIdRef.current = nextSelectedPageId;
      setSelectedFolderId(nextFolderId);
      setSelectedPageId(nextSelectedPageId);
      setSidebarPageSelection(nextSelectedPageId ? [nextSelectedPageId] : []);
      restorePageViewport(nextSelectedPageId);
      setEditingFolderId(null);
      setEditingPageId(null);
      setIsEditingHeaderTitle(false);
      setSelectedBlockIds([]);
      setEditingBlockId(null);
      setInsertionPoint(null);
      setActiveMode("canvas");

      return {
        folders: nextFolders,
        pages: nextPages,
        elements: currentData.elements.filter(
          (block) => !deletedPageIds.has(block.pageId),
        ),
      };
    });
  }

  function selectFolder(folderId: string) {
    const firstPage = data.pages.find((page) => page.folderId === folderId);
    const nextSelectedPageId = firstPage?.id ?? "";

    rememberPageViewport(selectedPageId);
    selectedFolderIdRef.current = folderId;
    selectedPageIdRef.current = nextSelectedPageId;
    setSelectedFolderId(folderId);
    setSelectedPageId(nextSelectedPageId);
    setSidebarPageSelection(nextSelectedPageId ? [nextSelectedPageId] : []);
    restorePageViewport(nextSelectedPageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function createPage() {
    const folderId = ROOT_FOLDER_ID;

    const pageId = createId("page");

    setData((currentData) => ({
      ...currentData,
      pages: [
        ...currentData.pages,
        { id: pageId, folderId, title: "New page" },
      ],
    }));
    rememberPageViewport(selectedPageId);
    selectedFolderIdRef.current = folderId;
    selectedPageIdRef.current = pageId;
    setSelectedFolderId(folderId);
    setSelectedPageId(pageId);
    setSidebarPageSelection([pageId]);
    restorePageViewport(pageId);
    setEditingFolderId(null);
    setEditingPageId(pageId);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function rememberOverlayTrigger(
    trigger: HTMLElement | undefined,
    fallback: HTMLElement | null,
  ) {
    overlayReturnFocusRef.current = trigger ?? fallback;
  }

  function requestOverlayEntryFocus(
    overlay: WorkbenchOverlay,
    trigger: HTMLElement | undefined,
    fallback: HTMLElement | null,
  ) {
    rememberOverlayTrigger(trigger, fallback);
    overlayEntryFocusRequestRef.current = overlay;
    overlayReturnFocusRequestRef.current = false;
  }

  function closeWorkbenchOverlay(overlay: WorkbenchOverlay) {
    if (activeWorkbenchOverlay === overlay) {
      if (!overlayReturnFocusRef.current) {
        overlayReturnFocusRef.current =
          overlay === "explorer"
            ? explorerToggleButtonRef.current
            : assistantToggleButtonRef.current;
      }
      overlayEntryFocusRequestRef.current = null;
      overlayReturnFocusRequestRef.current = true;
    }

    if (overlay === "explorer") {
      setActiveNarrowOverlay((currentOverlay) =>
        currentOverlay === "explorer" ? null : currentOverlay,
      );
      return;
    }

    setActiveNarrowOverlay((currentOverlay) =>
      currentOverlay === "assistant" ? null : currentOverlay,
    );
    setIsAssistantOpen(false);
  }

  function toggleExplorerPresentation(trigger?: HTMLElement) {
    if (isNarrowWorkbench) {
      const shouldOpenExplorer = activeNarrowOverlay !== "explorer";
      if (shouldOpenExplorer) {
        requestOverlayEntryFocus(
          "explorer",
          trigger,
          explorerToggleButtonRef.current,
        );
        setActiveNarrowOverlay("explorer");
        setIsAssistantOpen(false);
      } else {
        rememberOverlayTrigger(trigger, explorerToggleButtonRef.current);
        closeWorkbenchOverlay("explorer");
      }
      return;
    }

    setIsSidebarCollapsed((currentValue) => !currentValue);
  }

  function toggleAssistantPanel(trigger?: HTMLElement) {
    if (isNarrowWorkbench) {
      const shouldOpenAssistant = activeNarrowOverlay !== "assistant";
      if (shouldOpenAssistant) {
        requestOverlayEntryFocus(
          "assistant",
          trigger,
          assistantToggleButtonRef.current,
        );
        setActiveNarrowOverlay("assistant");
        setIsAssistantOpen(true);
      } else {
        rememberOverlayTrigger(trigger, assistantToggleButtonRef.current);
        closeWorkbenchOverlay("assistant");
      }
      return;
    }

    if (isCompactWorkbench) {
      if (isAssistantOpen) {
        rememberOverlayTrigger(trigger, assistantToggleButtonRef.current);
        closeWorkbenchOverlay("assistant");
      } else {
        requestOverlayEntryFocus(
          "assistant",
          trigger,
          assistantToggleButtonRef.current,
        );
        setIsAssistantOpen(true);
      }
      return;
    }

    setIsAssistantOpen((currentValue) => !currentValue);
  }

  function closeAssistantPanel() {
    closeWorkbenchOverlay("assistant");
  }

  function focusPageSearch(trigger?: HTMLElement) {
    if (isNarrowWorkbench) {
      rememberOverlayTrigger(trigger, explorerToggleButtonRef.current);
      overlayEntryFocusRequestRef.current = null;
      overlayReturnFocusRequestRef.current = false;
      setActiveNarrowOverlay("explorer");
      setIsAssistantOpen(false);
    } else {
      setIsSidebarCollapsed(false);
    }

    setPageSearchFocusRequest((currentRequest) => currentRequest + 1);
  }

  function focusCanvasSearch() {
    setIsSearchOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }

  function getAssistantErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  async function refreshLlamaHarnessAssistant() {
    setIsLlamaHarnessLoading(true);
    setAssistantError(null);

    try {
      const setupStatus = await getLlamaHarnessSetupStatus();
      setLlamaHarnessSetupStatus(setupStatus);

      if (!setupStatus.ready) {
        setLlamaHarnessCapabilities(null);
        setLlamaHarnessAgents([]);
        setAssistantStatus(llamaHarnessSetupMessage(setupStatus));
        return;
      }

      const capabilities = await getLlamaHarnessNoteCapabilities();
      const activeAgents = capabilities.allowedAgents;
      setLlamaHarnessCapabilities(capabilities);
      setLlamaHarnessAgents(activeAgents);
      setSelectedLlamaHarnessAgentId((currentAgentId) => {
        if (activeAgents.some((agent) => agent.id === currentAgentId)) {
          return currentAgentId;
        }

        return capabilities.defaultAgent.id || activeAgents[0]?.id || "";
      });
      setAssistantStatus(activeAgents.length ? null : "Allow an active Note agent in llama-harness.");
    } catch (error) {
      setLlamaHarnessSetupStatus(null);
      setLlamaHarnessCapabilities(null);
      setLlamaHarnessAgents([]);
      setAssistantError(`llama-harness is not reachable at http://127.0.0.1:8787. ${getAssistantErrorMessage(error)}`);
      setAssistantStatus(null);
    } finally {
      setIsLlamaHarnessLoading(false);
    }
  }

  function getLatestAssistantOutput() {
    for (let index = assistantMessages.length - 1; index >= 0; index -= 1) {
      const message = assistantMessages[index];

      if (message.role === "assistant" && message.content.trim()) {
        return message.content;
      }
    }

    return "";
  }

  function executeLlamaHarnessToolRequests(
    toolRequests: LlamaHarnessRunToolRequest[],
  ): LlamaHarnessRunToolResult[] {
    return toolRequests.map((toolRequest) => {
      try {
        return {
          toolCallId: toolRequest.id,
          toolId: toolRequest.toolId,
          result: executeLlamaHarnessToolRequest(toolRequest),
        };
      } catch (error) {
        return {
          toolCallId: toolRequest.id,
          toolId: toolRequest.toolId,
          error: getAssistantErrorMessage(error),
        };
      }
    });
  }

  function executeLlamaHarnessToolRequest(toolRequest: LlamaHarnessRunToolRequest) {
    const args = getToolArguments(toolRequest.arguments);

    switch (toolRequest.toolId) {
      case "note.getCurrentPage":
        return getCurrentPageToolResult(Boolean(args.includeBlocks));
      case "note.getSelectedBlocks":
        return {
          blocks: getSelectedTextBlocks().map(toToolBlock),
        };
      case "note.searchPages":
        return searchPagesForTool(requireStringArg(args, "query"));
      case "note.createBlock":
        return createBlockFromTool(args);
      case "note.updateBlock":
        return updateBlockFromTool(args);
      case "note.deleteBlock":
        return deleteBlockFromTool(toolRequest, args);
      case "note.moveBlock":
        return moveBlockFromTool(args);
      case "note.createPage":
        return createPageFromTool(args);
      case "note.renamePage":
        return renamePageFromTool(args);
      case "note.openPage":
        return openPageFromTool(args);
      default:
        throw new Error(`Unsupported Note tool: ${toolRequest.toolId}`);
    }
  }

  function getCurrentPageToolResult(includeBlocks: boolean) {
    const page = getActivePageForTool();

    return {
      page,
      ...(includeBlocks
        ? {
            blocks: dataRef.current.elements
              .filter((block): block is TextElement =>
                block.pageId === page.id && isTextElement(block),
              )
              .sort(compareToolBlocksByPosition)
              .map(toToolBlock),
          }
        : {}),
    };
  }

  function getSelectedTextBlocks() {
    const selectedIds = new Set(selectedBlockIdsRef.current);

    return dataRef.current.elements
      .filter((block): block is TextElement =>
        selectedIds.has(block.id) && isTextElement(block),
      )
      .sort(compareToolBlocksByPosition);
  }

  function searchPagesForTool(query: string) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      throw new Error("query is required.");
    }

    const pages = dataRef.current.pages
      .map((page) => {
        const matchedBlocks = dataRef.current.elements.filter(
          (block): block is TextElement =>
            block.pageId === page.id &&
            isTextElement(block) &&
            block.content.toLocaleLowerCase().includes(normalizedQuery),
        );
        const titleMatches = page.title.toLocaleLowerCase().includes(normalizedQuery);

        return titleMatches || matchedBlocks.length > 0
          ? {
              folderId: page.folderId,
              id: page.id,
              matchedBlockIds: matchedBlocks.map((block) => block.id),
              title: page.title,
            }
          : null;
      })
      .filter((page): page is NonNullable<typeof page> => Boolean(page))
      .slice(0, 20);

    return { pages };
  }

  function createBlockFromTool(args: Record<string, unknown>) {
    const page = getActivePageForTool();
    const content = requireStringArg(args, "content");
    const blockId = createId("block");
    const xArg = optionalNumberArg(args, "x");
    const yArg = optionalNumberArg(args, "y");
    const currentCanvasViewport = canvasViewportRef.current;
    const origin =
      xArg !== undefined && yArg !== undefined
        ? { x: xArg, y: yArg }
        : insertionPoint ??
          (currentCanvasViewport
            ? {
                x: currentCanvasViewport.x + currentCanvasViewport.width / 2,
                y: currentCanvasViewport.y + currentCanvasViewport.height / 2,
              }
            : { x: PASTED_BLOCK_OFFSET, y: PASTED_BLOCK_OFFSET });
    const blockPosition = snapPoint(origin);
    const formattedRichContent = createFormattedRichContent(
      content,
      textFormatStateRef.current,
    );
    const timestamp = Date.now();
    const block: TextElement = {
      createdAt: timestamp,
      id: blockId,
      pageId: page.id,
      x: blockPosition.x,
      y: blockPosition.y,
      width: DEFAULT_BLOCK_WIDTH,
      height: DEFAULT_BLOCK_HEIGHT,
      content,
      locked: false,
      opacity: 1,
      rotation: 0,
      type: "text",
      updatedAt: timestamp,
      zIndex: dataRef.current.elements.length,
      ...(formattedRichContent ? { richContent: formattedRichContent } : {}),
      isWidthManuallyResized: false,
    };

    setBlocksWithHistory((currentBlocks) => [...currentBlocks, block]);
    setSelectedBlockIds([blockId]);
    setEditingBlockId(blockId);
    setFocusEndBlockId(blockId);
    setIsCanvasKeyboardActive(true);
    setActiveMode("editing");
    setInsertionPoint(null);

    return { block: toToolBlock(block) };
  }

  function updateBlockFromTool(args: Record<string, unknown>) {
    const blockId = requireStringArg(args, "blockId");
    const block = getActivePageBlockForTool(blockId);
    const content = optionalStringArg(args, "content");
    const x = optionalNumberArg(args, "x");
    const y = optionalNumberArg(args, "y");
    const width = optionalNumberArg(args, "width");
    const height = optionalNumberArg(args, "height");

    if (
      content === undefined &&
      x === undefined &&
      y === undefined &&
      width === undefined &&
      height === undefined
    ) {
      throw new Error("At least one block field is required.");
    }

    const nextBlock: TextElement = {
      ...block,
      ...(content !== undefined ? { content, richContent: undefined } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };

    setBlocksWithHistory((currentBlocks) =>
      currentBlocks.map((currentBlock) =>
        currentBlock.id === blockId ? nextBlock : currentBlock,
      ),
    );
    setSelectedBlockIds([blockId]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");

    return { block: toToolBlock(nextBlock) };
  }

  function deleteBlockFromTool(
    toolRequest: LlamaHarnessRunToolRequest,
    args: Record<string, unknown>,
  ) {
    const blockId = requireStringArg(args, "blockId");
    const block = getActivePageBlockForTool(blockId);

    if (
      toolRequest.riskLevel === "high" &&
      !window.confirm(`Allow assistant to delete this Note block?\n\n${truncateForTool(block.content, 160)}`)
    ) {
      throw new Error("User denied approval for note.deleteBlock.");
    }

    deleteBlocks([blockId]);

    return { deletedBlockId: blockId };
  }

  function moveBlockFromTool(args: Record<string, unknown>) {
    const blockId = requireStringArg(args, "blockId");
    const block = getActivePageBlockForTool(blockId);
    const point = snapPoint({
      x: requireNumberArg(args, "x"),
      y: requireNumberArg(args, "y"),
    });
    const nextBlock = { ...block, x: point.x, y: point.y };

    setBlocksWithHistory((currentBlocks) =>
      currentBlocks.map((currentBlock) =>
        currentBlock.id === blockId ? nextBlock : currentBlock,
      ),
    );
    setSelectedBlockIds([blockId]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");

    return { block: toToolBlock(nextBlock) };
  }

  function createPageFromTool(args: Record<string, unknown>) {
    const title = requireStringArg(args, "title").trim();
    if (!title) {
      throw new Error("title is required.");
    }
    const folderId = optionalStringArg(args, "folderId") ?? selectedFolderIdRef.current ?? ROOT_FOLDER_ID;
    if (folderId && !dataRef.current.folders.some((folder) => folder.id === folderId)) {
      throw new Error("folderId does not exist.");
    }
    const pageId = createId("page");
    const page = { id: pageId, folderId, title };
    const nextData = {
      ...dataRef.current,
      pages: [...dataRef.current.pages, page],
    };

    dataRef.current = nextData;
    setData(nextData);
    rememberPageViewport(selectedPageIdRef.current);
    selectedFolderIdRef.current = folderId;
    selectedPageIdRef.current = pageId;
    setSelectedFolderId(folderId);
    setSelectedPageId(pageId);
    setSidebarPageSelection([pageId]);
    restorePageViewport(pageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");

    return { page };
  }

  function renamePageFromTool(args: Record<string, unknown>) {
    const pageId = requireStringArg(args, "pageId");
    const title = requireStringArg(args, "title").trim();
    const page = dataRef.current.pages.find((currentPage) => currentPage.id === pageId);

    if (!page) {
      throw new Error("pageId does not exist.");
    }
    if (!title) {
      throw new Error("title is required.");
    }

    const nextPage = { ...page, title };
    const nextData = {
      ...dataRef.current,
      pages: dataRef.current.pages.map((currentPage) =>
        currentPage.id === pageId ? nextPage : currentPage,
      ),
    };

    dataRef.current = nextData;
    setData(nextData);

    return { page: nextPage };
  }

  function openPageFromTool(args: Record<string, unknown>) {
    const pageId = requireStringArg(args, "pageId");
    const page = dataRef.current.pages.find((currentPage) => currentPage.id === pageId);

    if (!page) {
      throw new Error("pageId does not exist.");
    }

    rememberPageViewport(selectedPageIdRef.current);
    selectedFolderIdRef.current = page.folderId;
    selectedPageIdRef.current = pageId;
    setSelectedFolderId(page.folderId);
    setSelectedPageId(pageId);
    setSidebarPageSelection([pageId]);
    restorePageViewport(pageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(false);
    setActiveMode("canvas");

    return { page };
  }

  function getActivePageForTool() {
    const pageId = selectedPageIdRef.current;
    const page = dataRef.current.pages.find((currentPage) => currentPage.id === pageId);

    if (!page) {
      throw new Error("Select a page before using Note tools.");
    }

    return page;
  }

  function getActivePageBlockForTool(blockId: string) {
    const page = getActivePageForTool();
    const block = dataRef.current.elements.find((currentBlock) => currentBlock.id === blockId);

    if (!block) {
      throw new Error("blockId does not exist.");
    }
    if (block.pageId !== page.id) {
      throw new Error("Mutating Note tools are scoped to the active page.");
    }
    if (!isTextElement(block)) {
      throw new Error("Only text blocks are supported by Note tools.");
    }

    return block;
  }

  function toToolBlock(block: TextElement) {
    return {
      content: block.content,
      height: block.height,
      id: block.id,
      pageId: block.pageId,
      width: block.width,
      x: block.x,
      y: block.y,
    };
  }

  function compareToolBlocksByPosition(firstBlock: TextElement, secondBlock: TextElement) {
    return (
      firstBlock.y - secondBlock.y ||
      firstBlock.x - secondBlock.x ||
      firstBlock.id.localeCompare(secondBlock.id)
    );
  }

  function getToolArguments(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function requireStringArg(args: Record<string, unknown>, name: string) {
    const value = optionalStringArg(args, name);
    if (value === undefined) {
      throw new Error(`${name} is required.`);
    }

    return value;
  }

  function optionalStringArg(args: Record<string, unknown>, name: string) {
    const value = args[name];

    return typeof value === "string" ? value : undefined;
  }

  function requireNumberArg(args: Record<string, unknown>, name: string) {
    const value = optionalNumberArg(args, name);
    if (value === undefined) {
      throw new Error(`${name} is required.`);
    }

    return value;
  }

  function optionalNumberArg(args: Record<string, unknown>, name: string) {
    const value = args[name];

    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  function truncateForTool(value: string, maxLength: number) {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  }

  function stopAssistantRecordingStream() {
    assistantRecordingStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());
    assistantRecordingStreamRef.current = null;
  }

  function setProviderConnectionState(
    providerId: string,
    updates: ProviderConnectionState,
  ) {
    setProviderConnectionStates((currentStates) => ({
      ...currentStates,
      [providerId]: updates,
    }));
  }

  function addAIProvider(type: ProviderType) {
    const provider = createAIProvider(type);

    setAIProviders((currentProviders) => [...currentProviders, provider]);
    setSelectedAIProviderId(provider.id);
    setProviderConnectionState(provider.id, { status: "idle" });
    setIsAIProvidersOpen(true);
  }

  function updateAIProvider(
    providerId: string,
    updates: Partial<AIProvider>,
  ) {
    setAIProviders((currentProviders) =>
      currentProviders.map((provider) =>
        provider.id === providerId ? { ...provider, ...updates } : provider,
      ),
    );
    setProviderConnectionState(providerId, { status: "idle" });
  }

  function deleteAIProvider(providerId: string) {
    setAIProviders((currentProviders) =>
      currentProviders.filter((provider) => provider.id !== providerId),
    );
    setAIModels((currentModels) =>
      currentModels.filter((model) => model.providerId !== providerId),
    );
    setProviderConnectionStates((currentStates) => {
      const nextStates = { ...currentStates };

      delete nextStates[providerId];
      return nextStates;
    });
    setDefaultChatModelId((currentModelId) => {
      const currentModel = aiModels.find((model) => model.id === currentModelId);

      return currentModel?.providerId === providerId ? "" : currentModelId;
    });
    setDefaultEmbeddingModelId((currentModelId) => {
      const currentModel = aiModels.find((model) => model.id === currentModelId);

      return currentModel?.providerId === providerId ? "" : currentModelId;
    });
    setSelectedAIProviderId((currentProviderId) => {
      if (currentProviderId !== providerId) {
        return currentProviderId;
      }

      return aiProviders.find((provider) => provider.id !== providerId)?.id ?? "";
    });
    deleteProviderCredential(providerId).catch((error) => {
      console.warn("Could not delete AI provider credential.", error);
    });
  }

  async function testProviderConnection(providerId: string) {
    const provider = aiProviders.find(
      (currentProvider) => currentProvider.id === providerId,
    );

    if (!provider) {
      return;
    }

    setProviderConnectionState(providerId, {
      isTesting: true,
      message: "Testing connection...",
      status: "idle",
    });

    try {
      const result = await testAIProvider(provider);
      const latencyMessage = result.latencyMs ? ` (${result.latencyMs} ms)` : "";

      setProviderConnectionState(providerId, {
        message: `${result.message}${latencyMessage}`,
        status: result.ok ? "ok" : "error",
      });
    } catch (error) {
      setProviderConnectionState(providerId, {
        message: getAssistantErrorMessage(error),
        status: "error",
      });
    }
  }

  async function refreshProviderModels(providerId: string) {
    const provider = aiProviders.find(
      (currentProvider) => currentProvider.id === providerId,
    );

    if (!provider) {
      return;
    }

    setProviderConnectionState(providerId, {
      isRefreshing: true,
      message: "Refreshing models...",
      status: "idle",
    });

    try {
      const providerModels = await listAIProviderModels(provider);

      setAIModels((currentModels) => {
        const retainedModels = currentModels.filter(
          (model) => model.providerId !== providerId,
        );

        return [...retainedModels, ...providerModels];
      });
      setDefaultChatModelId((currentModelId) => {
        if (currentModelId) {
          return currentModelId;
        }

        return providerModels.find((model) => model.capabilities.chat)?.id ?? "";
      });
      setDefaultEmbeddingModelId((currentModelId) => {
        if (currentModelId) {
          return currentModelId;
        }

        return (
          providerModels.find((model) => model.capabilities.embeddings)?.id ?? ""
        );
      });
      setProviderConnectionState(providerId, {
        message: `Found ${providerModels.length} models.`,
        status: "ok",
      });
    } catch (error) {
      setProviderConnectionState(providerId, {
        message: getAssistantErrorMessage(error),
        status: "error",
      });
    }
  }

  async function requestAssistantChat(messages: AssistantMessage[]) {
    if (!llamaHarnessSetupStatus?.ready) {
      throw new Error(
        llamaHarnessSetupStatus
          ? llamaHarnessSetupMessage(llamaHarnessSetupStatus)
          : "llama-harness setup status has not loaded.",
      );
    }

    if (!selectedLlamaHarnessAgent) {
      throw new Error("Create or activate an agent in llama-harness.");
    }

    const notesContext = buildNotesContext({
      data: dataRef.current,
      selectedBlockIds: selectedBlockIdsRef.current,
      selectedPageId: selectedPageIdRef.current,
    });
    let response: LlamaHarnessRunResponse = await createLlamaHarnessNoteRun({
      agentId: selectedLlamaHarnessAgent.id,
      messages,
      notesContext,
    });

    for (let iteration = 0; response.status === "requires_action"; iteration += 1) {
      if (iteration >= 5) {
        throw new Error("llama-harness requested too many tool result rounds.");
      }
      if (response.toolRequests.length === 0) {
        throw new Error("llama-harness requested action without tool requests.");
      }

      setAssistantStatus(`Executing ${response.toolRequests.length} Note tool request${response.toolRequests.length === 1 ? "" : "s"}`);
      const toolResults = executeLlamaHarnessToolRequests(response.toolRequests);
      response = await submitLlamaHarnessNoteToolResults({
        runId: response.runId,
        toolResults,
      });
    }

    return response;
  }

  async function sendAssistantMessage() {
    const prompt = assistantInput.trim();

    if (!prompt || isAssistantSending) {
      return;
    }

    const userMessage: AssistantMessage = {
      id: createId("assistant-message"),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...assistantMessages, userMessage];

    setAssistantMessages(nextMessages);
    setAssistantInput("");
    setAssistantError(null);
    setAssistantStatus("Sending to local LLM");
    setIsAssistantSending(true);

    try {
      const response = await requestAssistantChat(nextMessages);
      const content = response.output?.trim() || "Done.";
      const assistantMessage: AssistantMessage = {
        id: createId("assistant-message"),
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
      };

      setAssistantMessages([...nextMessages, assistantMessage]);
      setAssistantStatus(`Received response from ${assistantAgentLabel}`);
    } catch (error) {
      setAssistantError(getAssistantErrorMessage(error));
      setAssistantStatus(null);
    } finally {
      setIsAssistantSending(false);
    }
  }

  async function transcribeAssistantRecording(audio: Blob, fileName: string) {
    if (audio.size === 0) {
      setAssistantError("No audio was captured.");
      setAssistantStatus(null);
      return;
    }

    setAssistantError(null);
    setAssistantStatus("Transcribing local audio");

    try {
      const transcription = await callOpenAICompatibleWhisperTranscription({
        audio,
        config: sttProviderConfig,
        fileName,
      });
      const nextText = transcription.text.trim();

      if (!nextText) {
        setAssistantError("The STT provider returned an empty transcription.");
        setAssistantStatus(null);
        return;
      }

      setAssistantInput((currentInput) => {
        const trimmedInput = currentInput.trimEnd();

        return trimmedInput ? `${trimmedInput} ${nextText}` : nextText;
      });
      setAssistantStatus("Transcription added to prompt");
    } catch (error) {
      setAssistantError(getAssistantErrorMessage(error));
      setAssistantStatus(null);
    }
  }

  async function toggleAssistantRecording() {
    if (isAssistantRecording) {
      assistantMediaRecorderRef.current?.stop();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setAssistantError("Audio recording is not available in this environment.");
      setAssistantStatus(null);
      return;
    }

    setAssistantError(null);
    setAssistantStatus("Requesting microphone access");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      assistantRecordingStreamRef.current = stream;
      assistantRecordingChunksRef.current = [];
      assistantMediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          assistantRecordingChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setAssistantError("Audio recording failed.");
        setAssistantStatus(null);
        setIsAssistantRecording(false);
        stopAssistantRecordingStream();
      };
      recorder.onstop = () => {
        const chunks = assistantRecordingChunksRef.current;
        const mimeType = recorder.mimeType || "audio/webm";
        const audio = new Blob(chunks, { type: mimeType });

        assistantMediaRecorderRef.current = null;
        assistantRecordingChunksRef.current = [];
        setIsAssistantRecording(false);
        stopAssistantRecordingStream();
        void transcribeAssistantRecording(audio, "note-dictation.webm");
      };

      recorder.start();
      setIsAssistantRecording(true);
      setAssistantStatus("Recording audio");
    } catch (error) {
      stopAssistantRecordingStream();
      setIsAssistantRecording(false);
      setAssistantError(getAssistantErrorMessage(error));
      setAssistantStatus(null);
    }
  }

  function executeAssistantActionRequest(action: AssistantActionRequest) {
    if (action.kind === "insert-text-block") {
      if (!selectedPageIdRef.current) {
        setAssistantError("Select a page before inserting assistant output.");
        setAssistantStatus(null);
        return false;
      }

      const currentCanvasViewport = canvasViewportRef.current;
      const origin = insertionPoint ??
        (currentCanvasViewport
          ? {
              x: currentCanvasViewport.x + currentCanvasViewport.width / 2,
              y: currentCanvasViewport.y + currentCanvasViewport.height / 2,
            }
          : { x: PASTED_BLOCK_OFFSET, y: PASTED_BLOCK_OFFSET });

      createTextBlock(origin.x, origin.y, action.content, {
        placement: insertionPoint ? "text-caret" : "block-origin",
      });
      setAssistantError(null);
      setAssistantStatus("Inserted assistant output");
      return true;
    }

    const selectedBlockId = selectedBlockIdsRef.current.length === 1
      ? selectedBlockIdsRef.current[0]
      : null;

    if (!selectedBlockId) {
      setAssistantError("Select one text block before using this assistant action.");
      setAssistantStatus(null);
      return false;
    }

    const selectedBlock = dataRef.current.elements.find(
      (block) => block.id === selectedBlockId,
    );

    if (!selectedBlock) {
      setAssistantError("The selected text block no longer exists.");
      setAssistantStatus(null);
      return false;
    }

    if (!isTextElement(selectedBlock)) {
      setAssistantError("Select one text block before using this assistant action.");
      setAssistantStatus(null);
      return false;
    }

    const nextContent =
      action.kind === "append-to-selected-block"
        ? [selectedBlock.content.trimEnd(), action.content]
            .filter(Boolean)
            .join("\n\n")
        : action.content;

    setBlocksWithHistory((currentBlocks) =>
      currentBlocks.map((block) =>
        block.id === selectedBlockId
          ? { ...block, content: nextContent, richContent: undefined }
          : block,
      ),
    );
    setSelectedBlockIds([selectedBlockId]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
    setAssistantError(null);
    setAssistantStatus(
      action.kind === "append-to-selected-block"
        ? "Appended assistant output"
        : "Replaced selected text block",
    );
    return true;
  }

  function runAssistantAction(kind: AssistantActionKind) {
    const action = buildAssistantActionRequest(kind, getLatestAssistantOutput());

    if (!action.ok) {
      setAssistantError(action.message);
      setAssistantStatus(null);
      return;
    }

    executeAssistantActionRequest(action.request);
  }

  function closePageTab(pageId: string) {
    const currentTabIds = openPageTabIds;

    if (!currentTabIds.includes(pageId)) {
      return;
    }

    void flushPendingPersistence();
    const closedTabIndex = currentTabIds.indexOf(pageId);
    const nextTabIds = currentTabIds.filter((currentPageId) => currentPageId !== pageId);

    setOpenPageTabIds(nextTabIds);

    if (selectedPageIdRef.current !== pageId) {
      return;
    }

    const nextSelectedPageId =
      nextTabIds[closedTabIndex] ?? nextTabIds[closedTabIndex - 1] ?? "";
    const nextPage = nextSelectedPageId
      ? dataRef.current.pages.find((page) => page.id === nextSelectedPageId)
      : undefined;
    const nextFolderId = nextPage?.folderId ?? ROOT_FOLDER_ID;

    rememberPageViewport(pageId);
    selectedFolderIdRef.current = nextFolderId;
    selectedPageIdRef.current = nextSelectedPageId;
    setSelectedFolderId(nextFolderId);
    setSelectedPageId(nextSelectedPageId);
    setSidebarPageSelection(nextSelectedPageId ? [nextSelectedPageId] : []);
    restorePageViewport(nextSelectedPageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(false);
    setActiveMode("canvas");
  }

  function reorderPageTab(
    sourcePageId: string,
    targetPageId: string,
    placement: PageTabDropPlacement,
  ) {
    if (sourcePageId === targetPageId) {
      return;
    }

    setOpenPageTabIds((currentPageIds) => {
      if (
        !currentPageIds.includes(sourcePageId) ||
        !currentPageIds.includes(targetPageId)
      ) {
        return currentPageIds;
      }

      const nextPageIds = currentPageIds.filter(
        (pageId) => pageId !== sourcePageId,
      );
      const targetIndex = nextPageIds.indexOf(targetPageId);

      if (targetIndex === -1) {
        return currentPageIds;
      }

      nextPageIds.splice(
        placement === "after" ? targetIndex + 1 : targetIndex,
        0,
        sourcePageId,
      );

      return areIdSelectionsEqual(currentPageIds, nextPageIds)
        ? currentPageIds
        : nextPageIds;
    });
  }

  function createStarterPage() {
    const folderId = ROOT_FOLDER_ID;
    const pageId = createId("page");

    setData((currentData) => ({
      ...currentData,
      pages: [
        ...currentData.pages,
        { id: pageId, folderId, title: "New page" },
      ],
    }));
    rememberPageViewport(selectedPageId);
    selectedFolderIdRef.current = folderId;
    selectedPageIdRef.current = pageId;
    setSelectedFolderId(folderId);
    setSelectedPageId(pageId);
    setSidebarPageSelection([pageId]);
    restorePageViewport(pageId);
    setEditingFolderId(null);
    setEditingPageId(pageId);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function createTemplateFromSelectedPage() {
    const sourcePageId = selectedPageIdRef.current;

    if (!sourcePageId) {
      return;
    }

    const currentData = dataRef.current;
    const sourcePage = currentData.pages.find(
      (page) => page.id === sourcePageId && !isTemplatePage(page),
    );

    if (!sourcePage) {
      return;
    }

    const templatePageId = createId("template-page");
    const templateBlocks = cloneBlocksForPage(
      currentData.elements.filter((block) => block.pageId === sourcePageId),
      templatePageId,
    );
    const nextData = {
      ...currentData,
      pages: [
        ...currentData.pages,
        {
          id: templatePageId,
          folderId: PAGE_TEMPLATE_FOLDER_ID,
          title: sourcePage.title,
        },
      ],
      elements: [...currentData.elements, ...templateBlocks],
    };

    dataRef.current = nextData;
    setData(nextData);
  }

  function createPageFromTemplate(templatePageId: string) {
    const currentData = dataRef.current;
    const templatePage = currentData.pages.find(
      (page) => page.id === templatePageId && isTemplatePage(page),
    );
    const folderId = selectedFolderIdRef.current || ROOT_FOLDER_ID;

    if (!templatePage) {
      return;
    }

    const pageId = createId("page");
    const nextData = {
      ...currentData,
      pages: [
        ...currentData.pages,
        { id: pageId, folderId, title: templatePage.title },
      ],
      elements: [
        ...currentData.elements,
        ...cloneBlocksForPage(
          currentData.elements.filter((block) => block.pageId === templatePageId),
          pageId,
        ),
      ],
    };

    dataRef.current = nextData;
    setData(nextData);
    rememberPageViewport(selectedPageIdRef.current);
    selectedFolderIdRef.current = folderId;
    selectedPageIdRef.current = pageId;
    setSelectedFolderId(folderId);
    setSelectedPageId(pageId);
    setSidebarPageSelection([pageId]);
    restorePageViewport(pageId);
    setEditingFolderId(null);
    setEditingPageId(pageId);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function deletePageTemplate(templatePageId: string) {
    const currentData = dataRef.current;
    const templatePage = currentData.pages.find(
      (page) => page.id === templatePageId && isTemplatePage(page),
    );

    if (!templatePage) {
      return;
    }

    const nextData = {
      ...currentData,
      pages: currentData.pages.filter((page) => page.id !== templatePageId),
      elements: currentData.elements.filter(
        (block) => block.pageId !== templatePageId,
      ),
    };

    dataRef.current = nextData;
    setData(nextData);
  }

  function beginPageDrag(pageId: string) {
    const currentData = dataRef.current;
    const sourcePage = currentData.pages.find(
      (page) => page.id === pageId && !isTemplatePage(page),
    );

    if (!sourcePage) {
      return false;
    }

    const selectedPageIdSet = new Set(selectedSidebarPageIdsRef.current);
    const nextDraggedPageIds = selectedPageIdSet.has(pageId)
      ? currentData.pages
          .filter((page) => selectedPageIdSet.has(page.id) && !isTemplatePage(page))
          .map((page) => page.id)
      : [pageId];

    draggedPageIdsRef.current = nextDraggedPageIds;
    draggedPrimaryPageIdRef.current = pageId;
    setDraggedPageIds(nextDraggedPageIds);

    return true;
  }

  function endPageDrag() {
    draggedPageIdsRef.current = [];
    draggedPrimaryPageIdRef.current = null;
    setDraggedPageIds([]);
    setPageDropTargetFolderId(null);
  }

  function moveDraggedPagesToFolder(folderId: string) {
    const currentData = dataRef.current;
    const targetFolder = currentData.folders.find((folder) => folder.id === folderId);
    const draggedPageIdSet = new Set(draggedPageIdsRef.current);

    if (!targetFolder || draggedPageIdSet.size === 0) {
      return false;
    }

    const draggedPages = currentData.pages.filter(
      (page) => draggedPageIdSet.has(page.id) && !isTemplatePage(page),
    );

    if (
      draggedPages.length === 0 ||
      draggedPages.every((page) => page.folderId === folderId)
    ) {
      return false;
    }

    const stationaryPages = currentData.pages.filter(
      (page) => !draggedPageIdSet.has(page.id),
    );
    const movedPages = draggedPages.map((page) => ({
      ...page,
      folderId,
    }));
    const nextData = {
      ...currentData,
      pages: insertPagesAfterLastPageInFolder(
        stationaryPages,
        folderId,
        movedPages,
      ),
    };
    const primaryMovedPageId =
      movedPages.find((page) => page.id === draggedPrimaryPageIdRef.current)?.id ??
      movedPages[0].id;

    rememberPageViewport(selectedPageIdRef.current);
    dataRef.current = nextData;
    setData(nextData);
    selectedFolderIdRef.current = folderId;
    selectedPageIdRef.current = primaryMovedPageId;
    setSelectedFolderId(folderId);
    setSelectedPageId(primaryMovedPageId);
    setSidebarPageSelection(movedPages.map((page) => page.id));
    restorePageViewport(primaryMovedPageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");

    return true;
  }

  function renamePage(pageId: string, title: string) {
    const nextTitle = title.trim();

    if (!nextTitle) {
      return;
    }

    setData((currentData) => ({
      ...currentData,
      pages: currentData.pages.map((page) =>
        page.id === pageId ? { ...page, title: nextTitle } : page,
      ),
    }));
  }

  function togglePageBookmark(pageId: string) {
    setData((currentData) => ({
      ...currentData,
      pages: currentData.pages.map((page) =>
        page.id === pageId
          ? { ...page, isBookmarked: !page.isBookmarked }
          : page,
      ),
    }));
  }

  function deletePage(pageId: string) {
    setData((currentData) => {
      const pageToDelete = currentData.pages.find((page) => page.id === pageId);
      const nextPages = currentData.pages.filter((page) => page.id !== pageId);
      const folderId = pageToDelete?.folderId ?? selectedFolderId;
      const nextSelectedPageId =
        pageId === selectedPageId
          ? nextPages.find((page) => page.folderId === folderId)?.id ?? ""
          : selectedPageId;
      const nextPageIdSet = new Set(nextPages.map((page) => page.id));
      const retainedSelectedPageIds = selectedSidebarPageIdsRef.current.filter(
        (selectedSidebarPageId) => nextPageIdSet.has(selectedSidebarPageId),
      );
      const nextSidebarPageIds =
        retainedSelectedPageIds.length > 0
          ? retainedSelectedPageIds
          : nextSelectedPageId
            ? [nextSelectedPageId]
            : [];

      forgetPageViewports([pageId]);
      selectedPageIdRef.current = nextSelectedPageId;
      setSelectedPageId(nextSelectedPageId);
      setSidebarPageSelection(nextSidebarPageIds);
      if (pageId === selectedPageId) {
        restorePageViewport(nextSelectedPageId);
      }
      setEditingPageId(null);
      setIsEditingHeaderTitle(false);
      setSelectedBlockIds([]);
      setEditingBlockId(null);
      setInsertionPoint(null);
      setActiveMode("canvas");

      return {
        ...currentData,
        pages: nextPages,
        elements: currentData.elements.filter((block) => block.pageId !== pageId),
      };
    });
  }

  const deleteBlock = useCallback(
    (blockId: string) => deleteBlocks([blockId]),
    [deleteBlocks],
  );

  function selectPage(pageId: string, isMultiSelect = false) {
    const nextPage = data.pages.find((page) => page.id === pageId);

    if (!nextPage) {
      return;
    }

    if (isMultiSelect) {
      toggleSidebarPageSelection(pageId);
      setEditingFolderId(null);
      setEditingPageId(null);
      setIsEditingHeaderTitle(false);
      setSelectedBlockIds([]);
      setEditingBlockId(null);
      setInsertionPoint(null);
      setIsCanvasKeyboardActive(false);
      setActiveMode("canvas");
      return;
    }

    setSidebarPageSelection([pageId]);
    selectedFolderIdRef.current = nextPage.folderId;
    setSelectedFolderId(nextPage.folderId);
    switchSelectedPage(pageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(false);
    setActiveMode("canvas");
  }

  function getTextBlockPositionForCreation(
    point: CanvasPoint,
    options: CreateTextBlockOptions = {},
  ) {
    if (options.placement === "text-caret") {
      return {
        x: point.x - TEXT_BLOCK_BORDER_WIDTH - TEXT_BLOCK_CONTENT_PADDING_LEFT,
        y:
          point.y -
          TEXT_BLOCK_BORDER_WIDTH -
          TEXT_BLOCK_HEADER_HEIGHT -
          TEXT_BLOCK_CONTENT_PADDING_TOP,
      };
    }

    return snapPoint(point);
  }

  function createTextBlock(
    x: number,
    y: number,
    content: string,
    options: CreateTextBlockOptions = {},
  ) {
    if (!selectedPageId) {
      return;
    }

    const blockId = createId("block");
    const blockPosition = getTextBlockPositionForCreation({ x, y }, options);
    const formattedRichContent = createFormattedRichContent(
      content,
      textFormatStateRef.current,
    );
    const timestamp = Date.now();

    setBlocksWithHistory((currentBlocks) => [
      ...currentBlocks,
      {
        createdAt: timestamp,
        id: blockId,
        locked: false,
        opacity: 1,
        pageId: selectedPageId,
        rotation: 0,
        type: "text",
        updatedAt: timestamp,
        x: blockPosition.x,
        y: blockPosition.y,
        width: DEFAULT_BLOCK_WIDTH,
        height: DEFAULT_BLOCK_HEIGHT,
        content,
        ...(formattedRichContent ? { richContent: formattedRichContent } : {}),
        isWidthManuallyResized: false,
        zIndex: currentBlocks.length,
      },
    ]);
    editingBlockIdRef.current = blockId;
    setSelectedBlockIds([blockId]);
    setEditingBlockId(blockId);
    setFocusEndBlockId(blockId);
    setIsCanvasKeyboardActive(true);
    setActiveMode("editing");
    setInsertionPoint(null);
    if (options.fromTool) {
      const nextTool = drawingToolAfterCreation("text", isToolLockedRef.current);
      if (nextTool !== "text") {
        activeToolRef.current = nextTool;
        setActiveTool(nextTool);
      }
    }
  }

  function readBlobAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Could not read image data."));
      reader.onload = () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Could not read image data."));
      reader.readAsDataURL(blob);
    });
  }

  function clearPendingImagePlacement() {
    imagePickerRequestRef.current += 1;
    pendingImagePlacementRef.current = null;
    setPendingImagePlacement(null);
  }

  function requestImagePicker() {
    setImageImportError(null);
    activeToolRef.current = "image";
    setActiveTool("image");
    const input = imagePickerInputRef.current;
    if (input) {
      input.value = "";
      input.click();
    }
  }

  function selectDrawingTool(tool: DrawingTool) {
    if (tool === "image") {
      requestImagePicker();
      return;
    }
    clearPendingImagePlacement();
    activeToolRef.current = tool;
    setActiveTool(tool);
    setInsertionPoint(null);
  }

  async function handleImageFileSelected(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    if (rejectOversizedImageBlob(file)) return;
    setImageImportError(null);
    const requestId = imagePickerRequestRef.current + 1;
    imagePickerRequestRef.current = requestId;
    let dataUrl: string;
    try {
      dataUrl = await readBlobAsDataUrl(file);
    } catch {
      return;
    }
    if (imagePickerRequestRef.current !== requestId) return;
    const pending = {
      dataUrl,
      fileName: file.name || "Canvas image",
      point: null,
    };
    pendingImagePlacementRef.current = pending;
    setPendingImagePlacement(pending);
  }

  function placePendingImage(point: CanvasPoint) {
    const pending = pendingImagePlacementRef.current;
    if (!pending) {
      requestImagePicker();
      return;
    }
    void createImageBlock(point.x, point.y, pending.dataUrl, pending.fileName);
    const nextTool = drawingToolAfterCreation("image", isToolLockedRef.current);
    if (nextTool !== "image") {
      clearPendingImagePlacement();
      activeToolRef.current = nextTool;
      setActiveTool(nextTool);
    }
  }

  async function managedImageDataUrl(source: string): Promise<string> {
    if (source.startsWith("data:image/")) {
      return source;
    }
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Could not download pasted image (${response.status}).`);
    }
    const blob = await response.blob();
    if (!isAssetBlobWithinLimit(blob)) {
      throw new Error(`Image exceeds the ${MAX_ASSET_BYTES / (1024 * 1024)} MiB size limit.`);
    }
    return readBlobAsDataUrl(blob);
  }

  function rejectOversizedImageBlob(blob: Pick<Blob, "size">): boolean {
    if (isAssetBlobWithinLimit(blob)) return false;
    const message = `Image exceeds the ${MAX_ASSET_BYTES / (1024 * 1024)} MiB size limit.`;
    setImageImportError(message);
    setPersistenceStatus({
      kind: "failed",
      error: new Error(message),
    });
    return true;
  }

  async function createImageBlock(
    x: number,
    y: number,
    imageData: string,
    imageName: string,
  ) {
    const pageId = selectedPageIdRef.current;
    if (!pageId) {
      return;
    }

    const blockId = createId("block");
    let assetId = createId("image-asset");
    let sourceForDisplay = imageData;
    let naturalWidth = 320;
    let naturalHeight = 220;
    const repository = repositoryRef.current;
    if (repository) {
      try {
        const managedDataUrl = await managedImageDataUrl(imageData);
        const asset = await repository.saveAsset(
          assetRequestFromDataUrl(managedDataUrl, { fileName: imageName }),
        );
        assetId = asset.id;
        sourceForDisplay = managedDataUrl;
        naturalWidth = asset.naturalWidth ?? naturalWidth;
        naturalHeight = asset.naturalHeight ?? naturalHeight;
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        // Keep the user-visible image in memory and let the normal retry path
        // upload it before the scene batch is ever sent.
        pendingAssetUploadsRef.current.set(assetId, {
          dataUrl: imageData,
          fileName: imageName,
        });
        setPersistenceStatus({ kind: "failed", error });
      }
    }
    const blockPosition = snapPoint({ x, y });
    const timestamp = Date.now();

    setBlocksWithHistory((currentBlocks) => [
      ...currentBlocks,
      {
        assetId,
        createdAt: timestamp,
        fileName: imageName,
        fit: "contain",
        id: blockId,
        locked: false,
        naturalHeight,
        naturalWidth,
        opacity: 1,
        pageId,
        rotation: 0,
        type: "image",
        updatedAt: timestamp,
        x: blockPosition.x,
        y: blockPosition.y,
        width: naturalWidth,
        height: naturalHeight,
        zIndex: currentBlocks.length,
      },
    ]);
    imageSourcesByAssetIdRef.current.set(assetId, sourceForDisplay);
    setSelectedBlockIds([blockId]);
    setEditingBlockId(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
    setInsertionPoint(null);
  }

  const updateBlock = useCallback((blockId: string, updates: BlockUpdates) => {
    const nextUpdates = snapManualResizeUpdates(updates);

    setData((currentData) => {
      let didChange = false;
      const nextBlocks = currentData.elements.map((block) => {
        if (block.id !== blockId) {
          return block;
        }

        const hasBlockChanges = Object.entries(nextUpdates).some(
          ([key, value]) => block[key as keyof typeof block] !== value,
        );

        if (!hasBlockChanges) {
          return block;
        }

        didChange = true;
        return { ...block, ...nextUpdates, updatedAt: Date.now() };
      });

      return didChange ? { ...currentData, elements: nextBlocks } : currentData;
    });
  }, []);

  const updateImageElement = useCallback((elementId: string, updates: ImageElementUpdates) => {
    setData((currentData) => {
      let didChange = false;
      const elements = currentData.elements.map((element) => {
        if (element.id !== elementId || element.type !== "image") return element;
        const hasChanges = Object.entries(updates).some(
          ([key, value]) => element[key as keyof ImageElement] !== value,
        );
        if (!hasChanges) return element;
        didChange = true;
        return { ...element, ...updates, updatedAt: Date.now() };
      });
      return didChange ? { ...currentData, elements } : currentData;
    });
  }, []);

  const updateInkElement = useCallback((elementId: string, updates: { x?: number; y?: number }) => {
    setBlocksWithHistory((currentElements) => currentElements.map((element) =>
      element.id === elementId && element.type === "ink" && !element.locked
        ? { ...element, ...updates, updatedAt: Date.now() }
        : element,
    ));
  }, []);

  const resizeInkElement = useCallback((elementId: string, ratio: number) => {
    setBlocksWithHistory((currentElements) => currentElements.map((element) =>
      element.id === elementId && element.type === "ink" && !element.locked
        ? { ...scaleInkElement(element, ratio), updatedAt: Date.now() }
        : element,
    ));
  }, []);

  const moveCanvasElementByKeyboard = useCallback((elementId: string, delta: Readonly<{ x: number; y: number }>) => {
    setBlocksWithHistory((currentElements) =>
      translateSelection(currentElements, new Set([elementId]), delta),
    );
    setActiveMode("selected");
  }, []);

  const eraseCanvasElements = useCallback((elementIds: readonly string[]) => {
    const ids = new Set(elementIds);
    if (ids.size === 0) return;
    setBlocksWithHistory((currentElements) =>
      detachConnectorEndpointsForDeletedTargets(currentElements, ids)
        .filter((element) => element.locked || !ids.has(element.id)),
    );
    const nextSelection = selectedBlockIdsRef.current.filter((id) => !ids.has(id));
    selectedBlockIdsRef.current = nextSelection;
    setSelectedBlockIds(nextSelection);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode(nextSelection.length > 0 ? "selected" : "canvas");
  }, []);

  const registerBlockElement = useCallback(
    (blockId: string, element: HTMLDivElement | null) => {
      if (element) {
        blockElementsRef.current.set(blockId, element);

        const dragSession = dragLayerSessionRef.current;

        if (dragSession?.blockIds.includes(blockId)) {
          element.classList.add("is-drag-source-hidden");

          if (!dragSession.sourceElements.includes(element)) {
            dragSession.sourceElements = [
              ...dragSession.sourceElements.filter(
                (sourceElement) => sourceElement.isConnected,
              ),
              element,
            ];
          }
        }

        return;
      }

      blockElementsRef.current.delete(blockId);
    },
    [],
  );

  function cleanupDragLayerSession(session: DragLayerSession) {
    if (session.modeRafId !== null) {
      window.cancelAnimationFrame(session.modeRafId);
      session.modeRafId = null;
    }

    if (session.autoPanRafId !== null) {
      window.cancelAnimationFrame(session.autoPanRafId);
      session.autoPanRafId = null;
    }

    for (const sourceElement of session.sourceElements) {
      sourceElement.classList.remove("is-drag-source-hidden");
    }

    session.overlayElement.remove();
  }

  function selectDraggedBlocks(blockIds: string[]) {
    setSelectedBlockIds((currentBlockIds) => {
      if (
        currentBlockIds.length === blockIds.length &&
        currentBlockIds.every((blockId, index) => blockId === blockIds[index])
      ) {
        return currentBlockIds;
      }

      return blockIds;
    });
  }

  function getDragAutoPanDelta(clientX: number, clientY: number): PanOffset {
    const canvasElement = canvasRef.current;

    if (!canvasElement) {
      return { x: 0, y: 0 };
    }

    const canvasRect = canvasElement.getBoundingClientRect();

    function getAxisDelta(
      pointerPosition: number,
      startEdge: number,
      endEdge: number,
    ) {
      if (pointerPosition < startEdge + DRAG_AUTO_PAN_EDGE_PX) {
        const intensity =
          (startEdge + DRAG_AUTO_PAN_EDGE_PX - pointerPosition) /
          DRAG_AUTO_PAN_EDGE_PX;

        return DRAG_AUTO_PAN_MAX_STEP_PX * Math.min(1, intensity);
      }

      if (pointerPosition > endEdge - DRAG_AUTO_PAN_EDGE_PX) {
        const intensity =
          (pointerPosition - (endEdge - DRAG_AUTO_PAN_EDGE_PX)) /
          DRAG_AUTO_PAN_EDGE_PX;

        return -DRAG_AUTO_PAN_MAX_STEP_PX * Math.min(1, intensity);
      }

      return 0;
    }

    return {
      x: getAxisDelta(clientX, canvasRect.left, canvasRect.right),
      y: getAxisDelta(clientY, canvasRect.top, canvasRect.bottom),
    };
  }

  function updateDragLayerVisual(session: DragLayerSession) {
    session.groupElement.style.transform = `translate3d(${
      session.currentClientX - session.startClientX
    }px, ${
      session.currentClientY - session.startClientY
    }px, 0)`;
  }

  function getDragCommitOffset(session: DragLayerSession): PanOffset {
    return {
      x:
        (session.currentClientX -
          session.startClientX -
          (panOffsetRef.current.x - session.startPanOffset.x)) /
        session.zoomLevel,
      y:
        (session.currentClientY -
          session.startClientY -
          (panOffsetRef.current.y - session.startPanOffset.y)) /
        session.zoomLevel,
    };
  }

  function scheduleDragAutoPan(session: DragLayerSession) {
    if (session.autoPanRafId !== null) {
      return;
    }

    session.autoPanRafId = window.requestAnimationFrame(() => {
      session.autoPanRafId = null;

      if (dragLayerSessionRef.current !== session) {
        return;
      }

      const panDelta = getDragAutoPanDelta(
        session.currentClientX,
        session.currentClientY,
      );

      if (panDelta.x === 0 && panDelta.y === 0) {
        return;
      }

      scheduleCanvasContentTransform({
        x: panOffsetRef.current.x + panDelta.x,
        y: panOffsetRef.current.y + panDelta.y,
      });
      updateDragLayerVisual(session);
      scheduleDragAutoPan(session);
    });
  }

  const startVisualDrag = useCallback(
    (originId: string, clientX: number, clientY: number) => {
      if (dragLayerSessionRef.current) {
        cleanupDragLayerSession(dragLayerSessionRef.current);
        dragLayerSessionRef.current = null;
      }

      const currentSelectedBlockIds = selectedBlockIdsRef.current;
      const isGroupDrag =
        currentSelectedBlockIds.includes(originId) &&
        currentSelectedBlockIds.length > 1;
      const selectedBlockIds = isGroupDrag ? [...currentSelectedBlockIds] : [originId];
      const requestedBlockIds = selectedBlockIds
        .filter((blockId) => {
          const block = dataRef.current.elements.find((element) => element.id === blockId);
          return Boolean(block && !block.locked);
        });
      const sourceEntries = requestedBlockIds
        .map((blockId) => ({
          blockId,
          element: blockElementsRef.current.get(blockId) ?? null,
        }))
        .filter(
          (entry): entry is { blockId: string; element: HTMLElement } =>
            Boolean(entry.element),
        );

      if (!sourceEntries.some((entry) => entry.blockId === originId)) {
        return false;
      }

      const canvasElement = canvasRef.current;

      if (!canvasElement) {
        return false;
      }

      const overlayElement = document.createElement("div");
      const groupElement = document.createElement("div");
      const currentZoomLevel = zoomLevelRef.current;
      const canvasRect = canvasElement.getBoundingClientRect();

      overlayElement.className = "drag-layer";
      groupElement.className = "drag-layer-group";
      overlayElement.append(groupElement);

      for (const { element } of sourceEntries) {
        const elementRect = element.getBoundingClientRect();
        const cloneElement = element.cloneNode(true) as HTMLElement;

        cloneElement.removeAttribute("data-block-id");
        cloneElement.setAttribute("aria-hidden", "true");
        cloneElement.classList.remove(
          "is-content-selected",
          "is-drag-source-hidden",
          "is-editing",
        );
        cloneElement.classList.add(
          "is-canvas-mode",
          "is-dragging",
          "is-selected",
          "drag-layer-clone",
        );
        cloneElement.style.position = "absolute";
        cloneElement.style.left = `${elementRect.left - canvasRect.left}px`;
        cloneElement.style.top = `${elementRect.top - canvasRect.top}px`;
        cloneElement.style.width = `${element.offsetWidth}px`;
        cloneElement.style.height = `${element.offsetHeight}px`;
        cloneElement.style.margin = "0";
        cloneElement.style.pointerEvents = "none";
        cloneElement.style.transform = `scale(${currentZoomLevel})`;
        cloneElement.style.transformOrigin = "0 0";
        groupElement.append(cloneElement);
      }

      canvasElement.append(overlayElement);

      const dragSession: DragLayerSession = {
        autoPanRafId: null,
        blockIds: sourceEntries.map((entry) => entry.blockId),
        currentClientX: clientX,
        currentClientY: clientY,
        groupElement,
        modeRafId: null,
        originId,
        overlayElement,
        sourceElements: sourceEntries.map((entry) => entry.element),
        selectedBlockIds,
        startClientX: clientX,
        startClientY: clientY,
        startPanOffset: { ...panOffsetRef.current },
        zoomLevel: currentZoomLevel,
      };

      dragLayerSessionRef.current = dragSession;
      setDragSourceBlockIds(dragSession.blockIds);

      for (const sourceElement of dragSession.sourceElements) {
        sourceElement.classList.add("is-drag-source-hidden");
      }

      dragSession.modeRafId = window.requestAnimationFrame(() => {
        if (dragLayerSessionRef.current !== dragSession) {
          return;
        }

        dragSession.modeRafId = null;
        setActiveMode("dragging");
      });

      return true;
    },
    [],
  );

  const moveVisualDrag = useCallback((clientX: number, clientY: number) => {
    const dragSession = dragLayerSessionRef.current;

    if (!dragSession) {
      return;
    }

    dragSession.currentClientX = clientX;
    dragSession.currentClientY = clientY;
    updateDragLayerVisual(dragSession);
    scheduleDragAutoPan(dragSession);
  }, []);

  const endVisualDrag = useCallback((clientX: number, clientY: number) => {
    const dragSession = dragLayerSessionRef.current;

    if (!dragSession) {
      return;
    }

    dragSession.currentClientX = clientX;
    dragSession.currentClientY = clientY;

    const offset = getDragCommitOffset(dragSession);
    const movedEnough = Math.abs(offset.x) > 0.01 || Math.abs(offset.y) > 0.01;
    const blockIdsToMove = new Set(dragSession.blockIds);

    cleanupDragLayerSession(dragSession);
    dragLayerSessionRef.current = null;
    setDragSourceBlockIds([]);
    setPanOffset(panOffsetRef.current);

    if (movedEnough) {
      setBlocksWithHistory((currentBlocks) => {
        const translated = translateSelection(currentBlocks, blockIdsToMove, offset);
        if (!isSnapToGridEnabledRef.current) return translated;
        return translated.map((block) =>
          blockIdsToMove.has(block.id) && isBoxCanvasElement(block) ? snapBlockPosition(block) : block,
        );
      });
    }

    selectDraggedBlocks(dragSession.selectedBlockIds);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
  }, []);

  const cancelVisualDrag = useCallback((updateState = true) => {
    const dragSession = dragLayerSessionRef.current;

    if (!dragSession) {
      return;
    }

    cleanupDragLayerSession(dragSession);
    dragLayerSessionRef.current = null;
    if (updateState) {
      setDragSourceBlockIds([]);
      setActiveMode("selected");
    }
  }, []);

  function cleanupResizeLayerSession(session: ResizeLayerSession) {
    for (const sourceElement of session.sourceElements) {
      sourceElement.classList.remove("is-drag-source-hidden");
    }
    session.overlayElement.remove();
  }

  function startSelectionResizePreview(bounds: SelectionRect, corner: SelectionCorner) {
    if (resizeLayerSessionRef.current) return true;
    const canvasElement = canvasRef.current;
    if (!canvasElement) return false;

    const sourceEntries = selectedBlockIdsRef.current
      .map((blockId) => ({
        blockId,
        element: blockElementsRef.current.get(blockId) ?? null,
      }))
      .filter(
        (entry): entry is { blockId: string; element: HTMLElement } => {
          const block = dataRef.current.elements.find((candidate) => candidate.id === entry.blockId);
          return Boolean(entry.element && block && !block.locked && isBoxCanvasElement(block));
        },
      );
    if (sourceEntries.length === 0) return false;

    const canvasRect = canvasElement.getBoundingClientRect();
    const overlayElement = document.createElement("div");
    const groupElement = document.createElement("div");
    const zoom = zoomLevelRef.current;
    const anchor = getOppositeCorner(bounds, corner);
    overlayElement.className = "drag-layer resize-layer";
    groupElement.className = "drag-layer-group resize-layer-group";
    groupElement.style.transformOrigin = `${panOffsetRef.current.x + anchor.x * zoom}px ${panOffsetRef.current.y + anchor.y * zoom}px`;
    overlayElement.append(groupElement);

    for (const { element } of sourceEntries) {
      const elementRect = element.getBoundingClientRect();
      const cloneElement = element.cloneNode(true) as HTMLElement;
      cloneElement.removeAttribute("data-block-id");
      cloneElement.setAttribute("aria-hidden", "true");
      cloneElement.classList.remove("is-content-selected", "is-drag-source-hidden", "is-editing");
      cloneElement.classList.add("is-canvas-mode", "is-selected", "drag-layer-clone", "resize-layer-clone");
      cloneElement.style.position = "absolute";
      cloneElement.style.left = `${elementRect.left - canvasRect.left}px`;
      cloneElement.style.top = `${elementRect.top - canvasRect.top}px`;
      cloneElement.style.width = `${element.offsetWidth}px`;
      cloneElement.style.height = `${element.offsetHeight}px`;
      cloneElement.style.margin = "0";
      cloneElement.style.pointerEvents = "none";
      cloneElement.style.transform = `scale(${zoom})`;
      cloneElement.style.transformOrigin = "0 0";
      groupElement.append(cloneElement);
    }

    canvasElement.append(overlayElement);
    const session = {
      groupElement,
      overlayElement,
      sourceElements: sourceEntries.map((entry) => entry.element),
    };
    resizeLayerSessionRef.current = session;
    setDragSourceBlockIds(sourceEntries.map((entry) => entry.blockId));
    for (const sourceElement of session.sourceElements) {
      sourceElement.classList.add("is-drag-source-hidden");
    }
    setActiveMode("resizing");
    return true;
  }

  function updateSelectionResizePreview(scale: number) {
    const session = resizeLayerSessionRef.current;
    if (session) session.groupElement.style.transform = `scale(${scale})`;
  }

  function finishSelectionResizePreview(updateState = true) {
    const session = resizeLayerSessionRef.current;
    if (!session) return;
    cleanupResizeLayerSession(session);
    resizeLayerSessionRef.current = null;
    if (updateState) setDragSourceBlockIds([]);
  }

  function setSelectionFrameVisualBounds(bounds: SelectionRect) {
    const frame = selectionFrameRef.current;
    if (!frame) return;
    const zoom = zoomLevelRef.current;
    const pan = panOffsetRef.current;
    frame.style.left = `${pan.x + bounds.x * zoom}px`;
    frame.style.top = `${pan.y + bounds.y * zoom}px`;
    frame.style.width = `${bounds.width * zoom}px`;
    frame.style.height = `${bounds.height * zoom}px`;
  }

  function cancelSelectionFrameInteraction(updateMode = true) {
    const session = selectionTransformRef.current;
    selectionTransformRef.current = null;
    if (session?.corner) {
      finishSelectionResizePreview(updateMode);
      setSelectionFrameVisualBounds(session.startBounds);
    } else if (session) {
      cancelVisualDrag(updateMode);
    }
    if (updateMode) {
      setConnectorEndpointPreview(null);
      setSelectionFramePreview(null);
    }
    setIsConnectorEndpointRetargeting(false);
    if (updateMode && session) setActiveMode(selectedBlockIdsRef.current.length > 0 ? "selected" : "canvas");
  }

  function selectionResizePreview(
    bounds: SelectionRect,
    corner: SelectionCorner,
    clientX: number,
    clientY: number,
    session: SelectionTransformSession,
  ) {
    const draggedCorner = {
      x: (corner.includes("e") ? bounds.x + bounds.width : bounds.x) + (clientX - session.startClientX) / zoomLevelRef.current,
      y: (corner.includes("s") ? bounds.y + bounds.height : bounds.y) + (clientY - session.startClientY) / zoomLevelRef.current,
    };
    const scale = getProportionalScale(bounds, corner, draggedCorner);
    const anchor = getOppositeCorner(bounds, corner);
    const width = bounds.width * scale;
    const height = bounds.height * scale;
    return {
      scale,
      bounds: {
        x: corner.includes("e") ? anchor.x : anchor.x - width,
        y: corner.includes("s") ? anchor.y : anchor.y - height,
        width,
        height,
      },
    };
  }

  function startSelectionFrameInteraction(
    event: ReactPointerEvent<HTMLElement>,
    corner: SelectionCorner | null,
    connectorEndpoint: "start" | "end" | null = null,
  ) {
    const bounds = selectionWorldBounds;
    if (event.button !== 0 || !bounds) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectionTransformRef.current = {
      corner,
      connectorEndpoint,
      didMove: false,
      pointerId: event.pointerId,
      startBounds: bounds,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    const selectedConnector = connectorEndpoint
      ? dataRef.current.elements.find((element): element is ConnectorElement =>
        element.id === selectedBlockIdsRef.current[0] && element.type === "connector",
      )
      : null;
    setIsConnectorEndpointRetargeting(selectedConnector?.style.endArrowhead === "arrow");
  }

  function getConnectorEndpointPreview(
    endpoint: "start" | "end",
    clientX: number,
    clientY: number,
  ): ConnectorElement | null {
    const selectedId = selectedBlockIdsRef.current.length === 1 ? selectedBlockIdsRef.current[0] : null;
    const connector = selectedId
      ? dataRef.current.elements.find((element): element is ConnectorElement => element.id === selectedId && element.type === "connector")
      : null;
    const canvas = canvasRef.current;
    if (!connector || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: (clientX - rect.left - panOffsetRef.current.x) / zoomLevelRef.current,
      y: (clientY - rect.top - panOffsetRef.current.y) / zoomLevelRef.current,
    };
    const nextEndpoint = snapConnectorEndpoint(
      point,
      dataRef.current.elements.filter((element) => element.pageId === connector.pageId),
      zoomLevelRef.current,
      connector.style.endArrowhead === "arrow",
    );
    return endpoint === "start"
      ? { ...connector, start: nextEndpoint }
      : { ...connector, end: nextEndpoint };
  }

  function moveSelectionFrameInteraction(event: ReactPointerEvent<HTMLElement>) {
    const session = selectionTransformRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const movedEnough = Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY) >= 3;
    if (!movedEnough) return;
    event.preventDefault();
    session.didMove = true;

    if (session.connectorEndpoint) {
      const preview = getConnectorEndpointPreview(session.connectorEndpoint, event.clientX, event.clientY);
      if (!preview) return;
      setConnectorEndpointPreview(preview);
      const previewElementsById = {
        ...Object.fromEntries(dataRef.current.elements.map((element) => [element.id, element])),
        [preview.id]: preview,
      };
      setSelectionFramePreview(getSelectionElementBounds(preview, previewElementsById));
      return;
    }

    if (session.corner) {
      const preview = selectionResizePreview(session.startBounds, session.corner, event.clientX, event.clientY, session);
      if (!startSelectionResizePreview(session.startBounds, session.corner)) return;
      updateSelectionResizePreview(preview.scale);
      setSelectionFrameVisualBounds(preview.bounds);
      return;
    }

    if (!dragLayerSessionRef.current) {
      const movableId = selectedBlockIdsRef.current.find((id) => {
        const element = dataRef.current.elements.find((candidate) => candidate.id === id);
        return Boolean(element && !element.locked);
      });
      if (!movableId || !startVisualDrag(movableId, session.startClientX, session.startClientY)) return;
    }
    moveVisualDrag(event.clientX, event.clientY);
  }

  function finishSelectionFrameInteraction(event: ReactPointerEvent<HTMLElement>, cancelled = false) {
    const session = selectionTransformRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    selectionTransformRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);

    if (cancelled) {
      if (session.corner) {
        finishSelectionResizePreview();
        setSelectionFrameVisualBounds(session.startBounds);
      } else if (!session.connectorEndpoint) {
        cancelVisualDrag();
      }
      setConnectorEndpointPreview(null);
      setSelectionFramePreview(null);
      setIsConnectorEndpointRetargeting(false);
      return;
    }

    if (session.connectorEndpoint && session.didMove) {
      const preview = getConnectorEndpointPreview(session.connectorEndpoint, event.clientX, event.clientY);
      if (preview) {
        setBlocksWithHistory((currentBlocks) => currentBlocks.map((element) =>
          element.id === preview.id ? { ...preview, updatedAt: Date.now() } : element,
        ));
      }
    } else if (session.corner && session.didMove) {
      const preview = selectionResizePreview(session.startBounds, session.corner, event.clientX, event.clientY, session);
      const selectedIds = new Set(selectedBlockIdsRef.current);
      finishSelectionResizePreview();
      setBlocksWithHistory((currentBlocks) =>
        scaleSelection(currentBlocks, selectedIds, session.startBounds, session.corner!, preview.scale),
      );
    } else if (!session.corner && session.didMove) {
      endVisualDrag(event.clientX, event.clientY);
    }

    setConnectorEndpointPreview(null);
    setSelectionFramePreview(null);
    setIsConnectorEndpointRetargeting(false);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
  }

  function moveSelectionByKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const step = (event.shiftKey ? 10 : 1) / zoomLevelRef.current;
    const delta = event.key === "ArrowLeft"
      ? { x: -step, y: 0 }
      : event.key === "ArrowRight"
        ? { x: step, y: 0 }
        : event.key === "ArrowUp"
          ? { x: 0, y: -step }
          : event.key === "ArrowDown"
            ? { x: 0, y: step }
            : null;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const selectedIds = new Set(selectedBlockIdsRef.current);
    setBlocksWithHistory((currentBlocks) => translateSelection(currentBlocks, selectedIds, delta));
    setActiveMode("selected");
  }

  function resizeSelectionByKeyboard(corner: SelectionCorner) {
    return (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const bounds = selectionWorldBounds;
      if (!bounds || !event.key.startsWith("Arrow")) return;
      const step = (event.shiftKey ? 10 : 1) / zoomLevelRef.current;
      const draggedCorner = {
        x: corner.includes("e") ? bounds.x + bounds.width : bounds.x,
        y: corner.includes("s") ? bounds.y + bounds.height : bounds.y,
      };
      if (event.key === "ArrowLeft") draggedCorner.x -= step;
      if (event.key === "ArrowRight") draggedCorner.x += step;
      if (event.key === "ArrowUp") draggedCorner.y -= step;
      if (event.key === "ArrowDown") draggedCorner.y += step;
      event.preventDefault();
      event.stopPropagation();
      const scale = getProportionalScale(bounds, corner, draggedCorner);
      const selectedIds = new Set(selectedBlockIdsRef.current);
      setBlocksWithHistory((currentBlocks) => scaleSelection(currentBlocks, selectedIds, bounds, corner, scale));
      setActiveMode("selected");
    };
  }

  function moveConnectorEndpointByKeyboard(endpoint: "start" | "end") {
    return (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!event.key.startsWith("Arrow")) return;
      const step = (event.shiftKey ? 10 : 1) / zoomLevelRef.current;
      const delta = event.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight"
          ? { x: step, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -step }
            : { x: 0, y: step };
      event.preventDefault();
      event.stopPropagation();
      const selectedId = selectedBlockIdsRef.current.length === 1 ? selectedBlockIdsRef.current[0] : null;
      if (!selectedId) return;
      const elementsById = Object.fromEntries(dataRef.current.elements.map((element) => [element.id, element]));
      setBlocksWithHistory((currentBlocks) => currentBlocks.map((element) => {
        if (element.id !== selectedId || element.type !== "connector" || element.locked) return element;
        const resolved = resolveConnectorEndpoint(element[endpoint], elementsById);
        if (!resolved) return element;
        const moved = { kind: "free" as const, x: resolved.x + delta.x, y: resolved.y + delta.y };
        return endpoint === "start"
          ? { ...element, start: moved, updatedAt: Date.now() }
          : { ...element, end: moved, updatedAt: Date.now() };
      }));
      setActiveMode("selected");
    };
  }

  const selectBlock = useCallback((blockId: string, additive = false) => {
    const isDeselectingOnlyBlock =
      additive &&
      selectedBlockIdsRef.current.length === 1 &&
      selectedBlockIdsRef.current[0] === blockId;

    setSelectedBlockIds((currentBlockIds) => {
      if (additive) {
        if (currentBlockIds.includes(blockId)) {
          return currentBlockIds.filter(
            (currentBlockId) => currentBlockId !== blockId,
          );
        }

        return [...currentBlockIds, blockId];
      }

      if (currentBlockIds.includes(blockId) && currentBlockIds.length > 1) {
        return currentBlockIds;
      }

      if (currentBlockIds.length === 1 && currentBlockIds[0] === blockId) {
        return currentBlockIds;
      }

      return [blockId];
    });
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode(isDeselectingOnlyBlock ? "canvas" : "selected");
  }, []);

  const editBlock = useCallback((blockId: string) => {
    editingBlockIdRef.current = blockId;
    setSelectedBlockIds((currentBlockIds) =>
      currentBlockIds.length === 1 && currentBlockIds[0] === blockId
        ? currentBlockIds
        : [blockId],
    );
    setEditingBlockId(blockId);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("editing");
  }, []);

  const endBlockEdit = useCallback((blockId: string) => {
    if (editingBlockIdRef.current !== blockId) {
      return;
    }

    editingBlockIdRef.current = null;
    setEditingBlockId(null);
    setActiveMode((currentMode) =>
      currentMode === "editing" ? "selected" : currentMode,
    );
  }, []);

  const handleFocusEndHandled = useCallback(() => {
    setFocusEndBlockId(null);
  }, []);

  function getActiveWritableTextEditor() {
    return activeTextEditor && !activeTextEditor.isDestroyed
      ? activeTextEditor
      : null;
  }

  function applyFormattingToSelectedBlocks(
    updateBlockFormat: (block: TextElement) => TextElement,
  ) {
    const selectedIds = new Set(selectedBlockIdsRef.current);

    if (selectedIds.size === 0) {
      return;
    }

    setBlocksWithHistory((currentBlocks) =>
      currentBlocks.map((block) =>
        selectedIds.has(block.id) && isTextElement(block)
          ? updateBlockFormat(block)
          : block,
      ),
    );
  }

  function leaveTextEditing() {
    blurActiveTextEntry();
    window.getSelection()?.removeAllRanges();
    setActiveTextEditor(null);
    setEditingBlockId(null);
  }

  function setTextFontFamily(fontFamily: TextFontFamily) {
    const nextFormatState = {
      ...textFormatStateRef.current,
      fontFamily,
    };
    const editor = getActiveWritableTextEditor();

    textFormatStateRef.current = nextFormatState;
    setTextFormatState(nextFormatState);

    if (editor) {
      editor
        .chain()
        .focus()
        .setMark("textStyle", getTextStyleAttrs(nextFormatState))
        .run();
      return;
    }

    applyFormattingToSelectedBlocks((block) =>
      applyTextStyleStateToBlock(block, nextFormatState),
    );
  }

  function setTextFontSize(fontSize: TextFontSize) {
    const nextFormatState = {
      ...textFormatStateRef.current,
      fontSize,
    };
    const editor = getActiveWritableTextEditor();

    textFormatStateRef.current = nextFormatState;
    setTextFormatState(nextFormatState);

    if (editor) {
      editor
        .chain()
        .focus()
        .setMark("textStyle", getTextStyleAttrs(nextFormatState))
        .run();
      return;
    }

    applyFormattingToSelectedBlocks((block) =>
      applyTextStyleStateToBlock(block, nextFormatState),
    );
  }

  function toggleTextFormat(formatId: ToolbarActionId) {
    const nextFormatState = getNextTextFormatState(
      textFormatStateRef.current,
      formatId,
    );
    const editor = getActiveWritableTextEditor();

    textFormatStateRef.current = nextFormatState;
    setTextFormatState(nextFormatState);

    if (editor) {
      switch (formatId) {
        case "bold":
          editor.chain().focus().toggleBold().run();
          return;
        case "italic":
          editor.chain().focus().toggleItalic().run();
          return;
        case "strike":
          editor.chain().focus().toggleStrike().run();
          return;
        case "underline":
          editor.chain().focus().toggleUnderline().run();
          return;
        case "bulletList":
          editor.chain().focus().toggleBulletList().run();
          return;
        case "orderedList":
          editor.chain().focus().toggleOrderedList().run();
          return;
        case "blockquote":
          editor.chain().focus().toggleBlockquote().run();
          return;
        case "code":
          editor.chain().focus().toggleCode().run();
          return;
      }
    }

    applyFormattingToSelectedBlocks((block) =>
      applyFormatStateToBlock(block, formatId, nextFormatState),
    );
  }

  function handleChromePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!isTextEntryTarget(event.target)) {
      leaveTextEditing();
      setActiveMode((currentMode) =>
        currentMode === "editing" ? "selected" : currentMode,
      );
    }

    setIsCanvasKeyboardActive(false);
  }

  const completePrimitiveCreation = useCallback(
    (tool: PrimitiveTool, geometry: PrimitiveGeometry) => {
      const pageId = selectedPageIdRef.current;
      if (!pageId) return;
      const elementId = createId(tool === "line" || tool === "arrow" ? "connector" : "shape");
      const timestamp = Date.now();
      const preference = drawingPreferencesRef.current[tool];
      const style = {
        fillColor: tool === "line" || tool === "arrow" ? null : preference.backgroundColor,
        roughness: preference.roughness,
        roundness: tool === "rectangle" ? preference.roundness : 0,
        seed: deterministicSeed(elementId),
        strokeColor: preference.strokeColor,
        strokeStyle: preference.strokeStyle,
        strokeWidth: preference.strokeWidth,
      };

      setBlocksWithHistory((currentElements) => {
        if (geometry.kind === "connector") {
          const canBind = tool === "arrow";
          const pageElements = currentElements.filter((element) => element.pageId === pageId);
          const connector: ConnectorElement = {
            createdAt: timestamp,
            end: snapConnectorEndpoint(geometry.end, pageElements, zoomLevelRef.current, canBind),
            id: elementId,
            locked: false,
            opacity: preference.opacity,
            pageId,
            routing: "straight",
            start: snapConnectorEndpoint(geometry.start, pageElements, zoomLevelRef.current, canBind),
            style: {
              ...style,
              endArrowhead: tool === "arrow" ? "arrow" : "none",
              startArrowhead: "none",
            },
            type: "connector",
            updatedAt: timestamp,
            zIndex: currentElements.length,
          };
          return [...currentElements, connector];
        }

        const shape: ShapeElement = {
          ...geometry.rect,
          createdAt: timestamp,
          id: elementId,
          locked: false,
          opacity: preference.opacity,
          pageId,
          rotation: 0,
          shape: tool as ShapeElement["shape"],
          style,
          type: "shape",
          updatedAt: timestamp,
          zIndex: currentElements.length,
        };
        return [...currentElements, shape];
      });
      selectedBlockIdsRef.current = [elementId];
      setSelectedBlockIds([elementId]);
      editingBlockIdRef.current = null;
      setEditingBlockId(null);
      setInsertionPoint(null);
      setIsCanvasKeyboardActive(true);
      setActiveMode("selected");
      const nextTool = drawingToolAfterCreation(tool, isToolLockedRef.current);
      if (nextTool !== tool) {
        activeToolRef.current = nextTool;
        setActiveTool(nextTool);
      }
    },
    [],
  );

  const canvasInteraction = useCanvasInteraction({
    activeToolRef,
    canvasContentRef,
    canvasRef,
    cleanupMarquee: clearMarquee,
    hasPendingImage: () => pendingImagePlacementRef.current !== null,
    isTemporaryHandActiveRef,
    leaveTextEditing,
    liveDraftLayerRef,
    maxZoom: MAX_ZOOM,
    minZoom: MIN_ZOOM,
    onCreatePrimitive: completePrimitiveCreation,
    onCreateText: (point) =>
      createTextBlock(point.x, point.y, "", {
        fromTool: true,
        placement: "block-origin",
      }),
    onImagePreviewPointChange: (point) => {
      const current = pendingImagePlacementRef.current;
      if (!current) return;
      const next = { ...current, point };
      pendingImagePlacementRef.current = next;
      setPendingImagePlacement(next);
    },
    onPlaceImage: placePendingImage,
    onRequestImagePicker: requestImagePicker,
    panOffsetRef,
    scheduleCanvasContentTransform,
    scheduleSelectionRectangle,
    setActiveMode,
    setInsertionPoint,
    setIsCanvasKeyboardActive,
    setLivePanOffset,
    setPanOffset,
    selectedElementIdsRef: selectedBlockIdsRef,
    setSelectedElementIds: setSelectedBlockIds,
    setZoomLevel,
    visibleElements: visibleCanvasElements,
    zoomLevelRef,
    zoomStep: ZOOM_STEP,
  });
  cancelCanvasSelectionRef.current = canvasInteraction.cancelMarquee;

  const completeInkStroke = useCallback(
    (tool: "pen" | "highlighter", points: readonly RawInkPoint[]) => {
      const pageId = selectedPageIdRef.current;
      if (!pageId) return;

      const preference = drawingPreferencesRef.current[tool];
      const brush = {
        ...(tool === "pen" ? PEN_BRUSH : HIGHLIGHTER_BRUSH),
        color: preference.strokeColor,
        opacity: preference.opacity,
        size: preference.strokeWidth,
      };
      const geometry = normalizeInkGeometry(
        points,
        brush.size,
        brush.simulatePressure,
      );
      const elementId = createId("ink");
      const timestamp = Date.now();

      setBlocksWithHistory((currentElements) => {
        const element: InkElement = {
          ...geometry,
          brush: {
            ...brush,
            color: { ...brush.color },
          },
          createdAt: timestamp,
          id: elementId,
          locked: false,
          opacity: brush.opacity,
          pageId,
          rotation: 0,
          type: "ink",
          updatedAt: timestamp,
          zIndex: currentElements.length,
        };
        return [...currentElements, element];
      });
      selectedBlockIdsRef.current = [elementId];
      setSelectedBlockIds([elementId]);
      setEditingBlockId(null);
      setInsertionPoint(null);
      setIsCanvasKeyboardActive(true);
      setActiveMode("selected");
      const nextTool = drawingToolAfterCreation(tool, isToolLockedRef.current);
      if (nextTool !== tool) {
        activeToolRef.current = nextTool;
        setActiveTool(nextTool);
      }
    },
    [],
  );

  const inkInteraction = useInkInteraction({
    activeToolRef,
    canvasContentRef,
    getBrush: (tool) => {
      const preference = drawingPreferencesRef.current[tool];
      return {
        ...(tool === "pen" ? PEN_BRUSH : HIGHLIGHTER_BRUSH),
        color: preference.strokeColor,
        opacity: preference.opacity,
        size: preference.strokeWidth,
      };
    },
    liveDraftLayerRef,
    onCompleteStroke: completeInkStroke,
    onEraseElements: eraseCanvasElements,
    visibleElements: () => dataRef.current.elements.filter(
      (element) => element.pageId === selectedPageIdRef.current,
    ),
    zoomLevelRef,
  });

  function focusSearchMatch(matchIndex: number) {
    if (searchMatches.length === 0) {
      return;
    }

    const normalizedIndex =
      ((matchIndex % searchMatches.length) + searchMatches.length) %
      searchMatches.length;
    const match = searchMatches[normalizedIndex];

    blurActiveTextEntry();
    setActiveSearchIndex(normalizedIndex);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("canvas");

    if (match.kind === "title") {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
      return;
    }

    const block = visibleBlocks.find((currentBlock) => currentBlock.id === match.blockId);

    if (!block) {
      return;
    }

    setPanOffset({
      x: canvasSize.width / 2 - (block.x + block.width / 2) * zoomLevel,
      y: canvasSize.height / 2 - (block.y + block.height / 2) * zoomLevel,
    });
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  function panToOffscreenGroup(direction: OffscreenGroup["direction"]) {
    if (!canvasViewport) {
      return;
    }

    const targetBlocks = visibleBlocks.filter(
      (block) => getOffscreenDirection(block, canvasViewport) === direction,
    );

    if (targetBlocks.length === 0) {
      return;
    }

    const bounds = targetBlocks.reduce(
      (currentBounds, block) => ({
        minX: Math.min(currentBounds.minX, block.x),
        minY: Math.min(currentBounds.minY, block.y),
        maxX: Math.max(currentBounds.maxX, block.x + block.width),
        maxY: Math.max(currentBounds.maxY, block.y + block.height),
      }),
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      },
    );
    const targetCenter = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };

    blurActiveTextEntry();
    setSelectedBlockIds(targetBlocks.map((block) => block.id));
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("selected");
    setPanOffset({
      x: canvasSize.width / 2 - targetCenter.x * zoomLevel,
      y: canvasSize.height / 2 - targetCenter.y * zoomLevel,
    });
  }

  const hasCanvasSearchQuery = Boolean(searchQuery.trim());
  const activeSearchDisplayIndex =
    searchMatches.length > 0
      ? Math.min(activeSearchIndex, searchMatches.length - 1) + 1
      : 0;
  const canvasSearchResultLabel =
    hasCanvasSearchQuery && searchMatches.length > 0
      ? `${activeSearchDisplayIndex} / ${searchMatches.length}`
      : "0 / 0";
  const canvasSearchSourceLabel =
    activeCanvasSearchMatch?.kind === "title" ? "Title" : "Text";

  return (
    <WorkbenchShell
      isAssistantOpen={shouldRenderAssistantPanel}
      isAssistantOverlayOpen={isAssistantOverlayOpen}
      isCompactWorkbench={isCompactWorkbench}
      isDarkMode={isDarkMode}
      isExplorerCollapsed={isExplorerPresentationCollapsed}
      isExplorerOverlayOpen={isExplorerOverlayOpen}
      isNarrowWorkbench={isNarrowWorkbench}
      onCloseAssistantOverlay={() => closeWorkbenchOverlay("assistant")}
      onCloseExplorerOverlay={() => closeWorkbenchOverlay("explorer")}
    >
      <Sidebar
        bookmarkedPages={bookmarkedPages}
        editingFolderId={editingFolderId}
        editingPageId={editingPageId}
        explorerPanelRef={explorerPanelRef}
        explorerToggleButtonRef={explorerToggleButtonRef}
        folders={data.folders}
        isCollapsed={isExplorerPresentationCollapsed}
        isInert={isAssistantOverlayOpen}
        isNarrowWorkbench={isNarrowWorkbench}
        pageSearchFocusRequest={pageSearchFocusRequest}
        pageTemplates={pageTemplates}
        pages={explorerPages}
        pageSearchQuery={pageSearchQuery}
        pageSearchResults={pageSearchResults}
        selectedFolderId={selectedFolderId}
        selectedPageId={selectedPageId}
        onCreateFolder={createFolder}
        onCreatePage={createPage}
        onCreatePageFromTemplate={createPageFromTemplate}
        onCreateTemplateFromPage={createTemplateFromSelectedPage}
        onDeleteFolder={deleteFolder}
        onDeletePage={deletePage}
        onDeletePageTemplate={deletePageTemplate}
        onFolderDragLeave={(folderId) => {
          if (pageDropTargetFolderId === folderId) {
            setPageDropTargetFolderId(null);
          }
        }}
        onFolderDragOver={setPageDropTargetFolderId}
        onFocusPageSearch={focusPageSearch}
        onPageDragEnd={endPageDrag}
        onPageDragStart={beginPageDrag}
        onPageDropOnFolder={(folderId) => {
          const didMovePages = moveDraggedPagesToFolder(folderId);

          endPageDrag();
          return didMovePages;
        }}
        onPointerDown={handleChromePointerDown}
        onRenameFolder={renameFolder}
        onRenamePage={renamePage}
        onSearchQueryChange={setPageSearchQuery}
        onSelectFolder={selectFolder}
        onSelectPage={selectPage}
        onSetEditingFolderId={setEditingFolderId}
        onSetEditingPageId={setEditingPageId}
        onToggleCollapse={toggleExplorerPresentation}
        onTogglePageBookmark={togglePageBookmark}
        pageDropTargetFolderId={pageDropTargetFolderId}
        draggedPageIds={draggedPageIds}
        selectedPageIds={selectedSidebarPageIds}
      />

      <section
        className={`workspace ${isTextFormattingVisible ? "has-text-formatting" : ""} ${isPropertiesPanelOpen && availableDrawingPropertiesContext ? "has-compact-properties" : ""}`}
        inert={
          isAssistantOverlayOpen || isExplorerOverlayOpen ? true : undefined
        }
      >
        <PageHeader
          activeTextEditor={activeTextEditor}
          assistantToggleButtonRef={assistantToggleButtonRef}
          isAssistantOpen={shouldRenderAssistantPanel}
          isGridVisible={isGridVisible}
          isDarkMode={isDarkMode}
          isEditingHeaderTitle={isEditingHeaderTitle}
          isSnapToGridEnabled={isSnapToGridEnabled}
          isTextFormattingVisible={isTextFormattingVisible}
          openPages={openPages}
          selectedPageId={selectedPageId}
          textFormatState={textFormatState}
          zoomLevel={zoomLevel}
          onClosePageTab={closePageTab}
          onCreatePage={createPage}
          onFocusCanvasSearch={focusCanvasSearch}
          onPointerDown={handleChromePointerDown}
          onRenamePage={renamePage}
          onReorderPageTab={reorderPageTab}
          onSelectPageTab={selectPage}
          onSetEditingHeaderTitle={setIsEditingHeaderTitle}
          onToggleAssistant={toggleAssistantPanel}
          onToggleGrid={() =>
            setIsGridVisible((currentValue) => {
              const nextValue = !currentValue;

              if (!nextValue) {
                setIsSnapToGridEnabled(false);
              }

              return nextValue;
            })
          }
          onToggleDarkMode={() => setIsDarkMode((currentMode) => !currentMode)}
          onToggleSnapToGrid={() =>
            setIsSnapToGridEnabled((currentValue) =>
              isGridVisible ? !currentValue : false,
            )
          }
          onSetTextFontFamily={setTextFontFamily}
          onSetTextFontSize={setTextFontSize}
          onToggleTextFormat={toggleTextFormat}
        />

        {persistenceAvailable || persistenceStatus.kind === "failed" ? (
          <div
            aria-live="polite"
            className={`persistence-status persistence-status-${persistenceStatus.kind}`}
            role="status"
          >
            {persistenceStatus.kind === "saving" ? "Saving" : null}
            {persistenceStatus.kind === "saved" ? "Saved" : null}
            {persistenceStatus.kind === "failed" ? (
              <>
                <span>Save failed: {persistenceStatus.error.message}</span>
                <button onClick={retryPersistence} type="button">Retry save</button>
              </>
            ) : null}
          </div>
        ) : null}

        <CanvasViewport
          labelledBy={
            selectedPageId ? getWorkspaceTabId(selectedPageId) : undefined
          }
          activeMode={activeMode}
          id={WORKSPACE_PAGE_PANEL_ID}
          onLostPointerCapture={canvasInteraction.handlePointerCancel}
          onPointerCancel={canvasInteraction.handlePointerCancel}
          onPointerCancelCapture={inkInteraction.handlePointerCancelCapture}
          onPointerDown={canvasInteraction.handlePointerDown}
          onPointerDownCapture={(event) => {
            canvasInteraction.handlePointerDownCapture(event);
            if (!event.defaultPrevented) inkInteraction.handlePointerDownCapture(event);
          }}
          onPointerMove={canvasInteraction.handlePointerMove}
          onPointerMoveCapture={(event) => {
            canvasInteraction.handlePointerMoveCapture(event);
            inkInteraction.handlePointerMoveCapture(event);
          }}
          onPointerUp={canvasInteraction.handlePointerEnd}
          onPointerUpCapture={inkInteraction.handlePointerUpCapture}
          onWheel={canvasInteraction.handleWheel}
          ref={canvasRef}
        >
          {isCanvasAuthoringAvailable ? <>
            <div onPointerDown={(event) => event.stopPropagation()}>
              <CanvasToolPalette
                activeTool={activeTool}
                isPropertiesPanelAvailable={Boolean(availableDrawingPropertiesContext)}
                isPropertiesPanelOpen={isPropertiesPanelOpen}
                isToolLocked={isToolLocked}
                onPropertiesPanelToggle={() => setIsPropertiesPanelOpen((open) => !open)}
                onToolLockChange={setIsToolLocked}
                onToolSelect={selectDrawingTool}
              />
              <input
                accept="image/*"
                aria-hidden="true"
                hidden
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void handleImageFileSelected(file);
                }}
                ref={imagePickerInputRef}
                tabIndex={-1}
                type="file"
              />
            </div>
            {imageImportError ? <div className="canvas-image-import-error" role="alert">{imageImportError}</div> : null}
            {availableDrawingPropertiesContext ? (
              <DrawingPropertiesPanel
                contextLabel={availableDrawingPropertiesContext.contextLabel}
                isCompactOpen={isPropertiesPanelOpen}
                isSelection={availableDrawingPropertiesContext.isSelection}
                onCancelPreview={cancelDrawingPropertyPreview}
                onLayerAction={updateSelectedLayer}
                onPreview={previewDrawingProperty}
                onUpdate={updateDrawingProperty}
                strokeWidthPresets={availableDrawingPropertiesContext.strokeWidthPresets}
                supports={availableDrawingPropertiesContext.supports}
                values={availableDrawingPropertiesContext.values}
              />
            ) : null}
          </> : null}
          {offscreenGroups.length > 0 ? (
            <div
              className={`offscreen-indicators ${
                isSearchOpen ? "has-search-panel" : ""
              }`}
              aria-label="Offscreen textboxes"
            >
              {offscreenGroups.map((group) => (
                <button
                  aria-label={`${group.count} ${
                    group.count === 1 ? "textbox" : "textboxes"
                  } offscreen ${getOffscreenDirectionLabel(group.direction)}`}
                  className={`offscreen-arrow offscreen-${group.direction}`}
                  key={group.direction}
                  onClick={(event) => {
                    event.stopPropagation();
                    panToOffscreenGroup(group.direction);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  type="button"
                >
                  <HeroIcon name="chevron-right" />
                  <span className="offscreen-count">{group.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {isSearchOpen ? (
            <div className="search-panel" onPointerDown={(event) => event.stopPropagation()}>
              <HeroIcon name="magnifying-glass" />
              <input
                aria-label="Find in canvas"
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    focusSearchMatch(
                      activeSearchIndex + (event.shiftKey ? -1 : 1),
                    );
                  }

                  if (event.key === "Escape") {
                    setIsSearchOpen(false);
                    setSearchQuery("");
                  }
                }}
                placeholder="Find in canvas"
                ref={searchInputRef}
                value={searchQuery}
              />
              <span className="search-panel-count">
                {canvasSearchResultLabel}
                {hasCanvasSearchQuery && searchMatches.length > 0 ? (
                  <small>{canvasSearchSourceLabel}</small>
                ) : null}
              </span>
              <button
                aria-label="Previous match"
                disabled={searchMatches.length === 0}
                onClick={() => focusSearchMatch(activeSearchIndex - 1)}
                title="Previous match"
                type="button"
              >
                <HeroIcon name="chevron-up" />
              </button>
              <button
                aria-label="Next match"
                disabled={searchMatches.length === 0}
                onClick={() => focusSearchMatch(activeSearchIndex + 1)}
                title="Next match"
                type="button"
              >
                <HeroIcon name="chevron-down" />
              </button>
              <button
                aria-label="Close search"
                onClick={() => {
                  setIsSearchOpen(false);
                  setSearchQuery("");
                }}
                title="Close search"
                type="button"
              >
                <HeroIcon name="x-mark" />
              </button>
            </div>
          ) : null}
          <CanvasWorldLayer
            isGridVisible={isGridVisible}
            liveDraftLayerRef={liveDraftLayerRef}
            panOffset={panOffset}
            ref={canvasContentRef}
            zoomLevel={zoomLevel}
          >
            {renderedCanvasElements.map((element) => (
              <CanvasElementRenderer
                element={element}
                key={element.id}
                renderConnector={(connector) => (
                  <ConnectorElementView
                    element={connector}
                    elementsById={renderedCanvasElementsById}
                    isDragSourceHidden={dragSourceBlockIds.includes(connector.id)}
                    isSelected={selectedBlockIds.includes(connector.id)}
                    onElementChange={registerBlockElement}
                    onKeyboardMove={moveCanvasElementByKeyboard}
                    onSelect={selectBlock}
                  />
                )}
                renderInk={(inkElement) => (
                  <InkElementView
                    element={inkElement}
                    isDragSourceHidden={dragSourceBlockIds.includes(inkElement.id)}
                    isMultiSelected={selectedBlockIds.length > 1}
                    isSelected={selectedBlockIds.includes(inkElement.id)}
                    onCanvasPanStart={canvasInteraction.startPan}
                    onElementChange={registerBlockElement}
                    onInteractionModeChange={setActiveMode}
                    onResize={resizeInkElement}
                    onSelect={selectBlock}
                    onUpdate={updateInkElement}
                    onVisualDragCancel={cancelVisualDrag}
                    onVisualDragEnd={endVisualDrag}
                    onVisualDragMove={moveVisualDrag}
                    onVisualDragStart={startVisualDrag}
                    zoomLevel={zoomLevel}
                  />
                )}
                renderShape={(shape) => (
                  <ShapeElementView
                    element={shape}
                    isDragSourceHidden={dragSourceBlockIds.includes(shape.id)}
                    isSelected={selectedBlockIds.includes(shape.id)}
                    onElementChange={registerBlockElement}
                    onKeyboardMove={moveCanvasElementByKeyboard}
                    onSelect={selectBlock}
                  />
                )}
                renderText={(block) => (
                  <TextBlockView
                block={block}
                activeSearchRange={
                  activeSearchMatch?.blockId === block.id ? activeSearchMatch : null
                }
                isEditing={block.id === editingBlockId}
                isDragSourceHidden={dragSourceBlockIds.includes(block.id)}
                isMultiSelected={selectedBlockIds.length > 1}
                isSelected={selectedBlockIds.includes(block.id)}
                key={block.id}
                onDelete={deleteBlock}
                onEdit={editBlock}
                onEditEnd={endBlockEdit}
                onSelectAllBlocks={selectAllVisibleBlocks}
                onCanvasPanEnd={canvasInteraction.handlePointerEnd}
                onCanvasPanMove={canvasInteraction.handlePointerMove}
                onCanvasPanStart={canvasInteraction.startPan}
                onFocusEndHandled={handleFocusEndHandled}
                onActiveEditorChange={setActiveTextEditor}
                onInteractionModeChange={setActiveMode}
                onBlockElementChange={registerBlockElement}
                onSelect={selectBlock}
                onUpdate={updateBlock}
                onVisualDragCancel={cancelVisualDrag}
                onVisualDragEnd={endVisualDrag}
                onVisualDragMove={moveVisualDrag}
                onVisualDragStart={startVisualDrag}
                searchQuery={searchQuery}
                shouldFocusEnd={focusEndBlockId === block.id}
                zoomLevel={zoomLevel}
                  />
                )}
                renderImage={(block) => (
                  <ImageElementView
                  element={block}
                  imageSource={imageSourcesByAssetIdRef.current.get(block.assetId)}
                  isDragSourceHidden={dragSourceBlockIds.includes(block.id)}
                  isMultiSelected={selectedBlockIds.length > 1}
                  isSelected={selectedBlockIds.includes(block.id)}
                  key={block.id}
                  onBlockElementChange={registerBlockElement}
                  onCanvasPanStart={canvasInteraction.startPan}
                  onInteractionModeChange={setActiveMode}
                  onSelect={selectBlock}
                  onUpdate={updateImageElement}
                  onVisualDragCancel={cancelVisualDrag}
                  onVisualDragEnd={endVisualDrag}
                  onVisualDragMove={moveVisualDrag}
                  onVisualDragStart={startVisualDrag}
                  zoomLevel={zoomLevel}
                  />
                )}
              />
            ))}
            {activeTool === "arrow" || isConnectorEndpointRetargeting ? (
              <ShapeBindingAnchors
                shapes={visibleCanvasElements.filter((element): element is ShapeElement => element.type === "shape")}
              />
            ) : null}
            {pendingImagePlacement?.point ? (
              <img
                alt=""
                aria-hidden="true"
                className="canvas-image-placement-preview"
                src={pendingImagePlacement.dataUrl}
                style={{
                  left: pendingImagePlacement.point.x,
                  top: pendingImagePlacement.point.y,
                }}
              />
            ) : null}
            {insertionPoint ? (
              <div
                className="canvas-caret"
                style={{
                  left: insertionPoint.x,
                  top: insertionPoint.y,
                }}
              />
            ) : null}
          </CanvasWorldLayer>
          <CanvasInteractionOverlay
            marqueeRef={selectionRectRef}
            selectionFrameRef={selectionFrameRef}
            selectionFrame={(() => {
              const bounds = selectionFramePreview ?? selectionWorldBounds;
              if (activeTool !== "select" || !bounds || selectedBlockIds.length === 0 || editingBlockId) return undefined;
              const selected = selectedBlockIds.length === 1
                ? connectorEndpointPreview?.id === selectedBlockIds[0]
                  ? connectorEndpointPreview
                  : visibleCanvasElements.find((block) => block.id === selectedBlockIds[0])
                : undefined;
              const usesNativeSingleElementInteraction = Boolean(
                selected && (selected.type === "text" || selected.type === "image"),
              );
              const framePadding = 4;
              const resizeCorners: readonly SelectionCorner[] = selectionHasLockedElements
                ? []
                : selectedBlockIds.length > 1
                  ? ["nw", "ne", "se", "sw"]
                  : selected?.type === "shape"
                    ? ["nw", "ne", "se", "sw"]
                    : [];
              const connectorEndpointPoints = selected?.type === "connector"
                ? {
                    start: resolveConnectorEndpoint(selected.start, renderedCanvasElementsById),
                    end: resolveConnectorEndpoint(selected.end, renderedCanvasElementsById),
                  }
                : null;
              const connectorEndpointHandles = selected?.type === "connector" && !selected.locked && connectorEndpointPoints?.start && connectorEndpointPoints.end
                ? ([
                    { endpoint: "start" as const, point: connectorEndpointPoints.start },
                    { endpoint: "end" as const, point: connectorEndpointPoints.end },
                  ]).map(({ endpoint, point }) => ({
                    endpoint,
                    onKeyDown: moveConnectorEndpointByKeyboard(endpoint),
                    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => startSelectionFrameInteraction(event, null, endpoint),
                    x: (point.x - bounds.x) * zoomLevel + framePadding,
                    y: (point.y - bounds.y) * zoomLevel + framePadding,
                  }))
                : undefined;
              return {
                connectorEndpointHandles,
                height: bounds.height * zoomLevel + framePadding * 2,
                moveLabel: selectionHasLockedElements ? "Move unlocked selected elements" : "Move selected elements",
                onDoubleClick: () => {
                  const selected = visibleCanvasElements.find((block) => block.id === selectedBlockIds[0]);
                  if (selectedBlockIds.length === 1 && selected && isTextElement(selected)) editBlock(selected.id);
                },
                onMoveKeyDown: moveSelectionByKeyboard,
                onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => finishSelectionFrameInteraction(event, true),
                onLostPointerCapture: (event: ReactPointerEvent<HTMLButtonElement>) => finishSelectionFrameInteraction(event, true),
                onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => startSelectionFrameInteraction(event, null),
                onPointerMove: moveSelectionFrameInteraction,
                onPointerUp: finishSelectionFrameInteraction,
                onResizeKeyDown: resizeSelectionByKeyboard,
                onResizePointerDown: (corner: SelectionCorner) => (event: ReactPointerEvent<HTMLButtonElement>) => startSelectionFrameInteraction(event, corner),
                preserveNativeSoutheastHandle: selected?.type === "ink",
                resizeCorners,
                showMoveSurface: selectionHasUnlockedElements && !usesNativeSingleElementInteraction,
                width: bounds.width * zoomLevel + framePadding * 2,
                x: panOffset.x + bounds.x * zoomLevel - framePadding,
                y: panOffset.y + bounds.y * zoomLevel - framePadding,
              };
            })()}
          />
          {shouldShowStarterShortcuts ? (
            <div
              className="canvas-starter"
              aria-label="Empty workspace shortcuts"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <button
                className="canvas-starter-action"
                onClick={createStarterPage}
                type="button"
              >
                Create new note <span>Ctrl + N</span>
              </button>
              <button
                className="canvas-starter-action"
                onClick={() => focusPageSearch()}
                type="button"
              >
                Go to file <span>Ctrl + O</span>
              </button>
            </div>
          ) : !isWorkspaceEmpty && openPages.length > 0 && !selectedPageId ? (
            <div className="canvas-empty">
              <p>Select or create a page</p>
            </div>
          ) : null}
        </CanvasViewport>
      </section>
      {isAIProvidersOpen ? (
        <AIProvidersSettings
          connectionStates={providerConnectionStates}
          defaultChatModelId={defaultChatModelId}
          defaultEmbeddingModelId={defaultEmbeddingModelId}
          models={aiModels}
          providers={aiProviders}
          selectedProviderId={selectedAIProviderId}
          onAddProvider={addAIProvider}
          onClose={() => setIsAIProvidersOpen(false)}
          onDeleteProvider={deleteAIProvider}
          onRefreshModels={refreshProviderModels}
          onSelectProvider={setSelectedAIProviderId}
          onSetDefaultChatModel={setDefaultChatModelId}
          onSetDefaultEmbeddingModel={setDefaultEmbeddingModelId}
          onTestConnection={testProviderConnection}
          onUpdateProvider={updateAIProvider}
        />
      ) : null}
      {shouldRenderAssistantPanel ? (
        <AssistantPanel
          assistantError={assistantError}
          assistantStatus={assistantStatus}
          defaultChatModelLabel={assistantAgentLabel}
          harnessAgents={activeLlamaHarnessAgents}
          isHarnessLoading={isLlamaHarnessLoading}
          isHarnessReady={Boolean(llamaHarnessSetupStatus?.ready)}
          inputValue={assistantInput}
          isRecording={isAssistantRecording}
          isSending={isAssistantSending}
          messages={assistantMessages}
          onClose={closeAssistantPanel}
          onInputChange={setAssistantInput}
          onRefreshHarness={refreshLlamaHarnessAssistant}
          onRunAction={runAssistantAction}
          onSend={sendAssistantMessage}
          onSelectHarnessAgent={setSelectedLlamaHarnessAgentId}
          onToggleRecording={toggleAssistantRecording}
          panelRef={assistantPanelRef}
          selectedBlockCount={selectedBlockIds.length}
          selectedBlockPreview={selectedAssistantBlockPreview}
          selectedHarnessAgentId={selectedLlamaHarnessAgent?.id ?? ""}
          selectedPageTitle={selectedPage?.title ?? null}
        />
      ) : null}
    </WorkbenchShell>
  );
}

const Sidebar = memo(function Sidebar({
  bookmarkedPages,
  editingFolderId,
  editingPageId,
  explorerPanelRef,
  explorerToggleButtonRef,
  folders,
  isCollapsed,
  isInert,
  pageSearchFocusRequest,
  pageTemplates,
  pages,
  pageSearchQuery,
  pageSearchResults,
  selectedFolderId,
  selectedPageId,
  onCreateFolder,
  onCreatePage,
  onCreatePageFromTemplate,
  onCreateTemplateFromPage,
  onDeleteFolder,
  onDeletePage,
  onDeletePageTemplate,
  onFolderDragLeave,
  onFolderDragOver,
  onFocusPageSearch,
  onPageDragEnd,
  onPageDragStart,
  onPageDropOnFolder,
  onPointerDown,
  onRenameFolder,
  onRenamePage,
  onSearchQueryChange,
  onSelectFolder,
  onSelectPage,
  onSetEditingFolderId,
  onSetEditingPageId,
  onToggleCollapse,
  onTogglePageBookmark,
  pageDropTargetFolderId,
  draggedPageIds,
  selectedPageIds,
}: SidebarProps) {
  const pageSearchInputRef = useRef<HTMLInputElement>(null);
  const sortMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTabId>("files");
  const [isPageSearchFocused, setIsPageSearchFocused] = useState(false);
  const [isSearchOptionsOpen, setIsSearchOptionsOpen] = useState(false);
  const canCreateTemplateFromPage = pages.some(
    (page) => page.id === selectedPageId,
  );
  const [sortMenuPosition, setSortMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [sortOrder, setSortOrder] = useState<SidebarSortOrder>("name-asc");
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [isAutoRevealEnabled, setIsAutoRevealEnabled] = useState(true);
  const folderNamesById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );
  const folderOrderIndexById = useMemo(
    () => new Map(folders.map((folder, index) => [folder.id, index])),
    [folders],
  );
  const pageOrderIndexById = useMemo(
    () => new Map(pages.map((page, index) => [page.id, index])),
    [pages],
  );
  const selectedPageIdSet = useMemo(
    () => new Set(selectedPageIds),
    [selectedPageIds],
  );
  const draggedPageIdSet = useMemo(
    () => new Set(draggedPageIds),
    [draggedPageIds],
  );
  const selectedPageFolderId =
    pages.find((page) => page.id === selectedPageId)?.folderId ?? selectedFolderId;
  const sortedFolders = useMemo(() => {
    const nextFolders = [...folders];

    nextFolders.sort((firstFolder, secondFolder) => {
      if (sortOrder === "name-asc" || sortOrder === "name-desc") {
        const result = firstFolder.name.localeCompare(secondFolder.name, undefined, {
          sensitivity: "base",
        });

        return sortOrder === "name-asc" ? result : -result;
      }

      const firstIndex = folderOrderIndexById.get(firstFolder.id) ?? 0;
      const secondIndex = folderOrderIndexById.get(secondFolder.id) ?? 0;
      const result = firstIndex - secondIndex;

      return sortOrder.endsWith("desc") ? -result : result;
    });

    return nextFolders;
  }, [folderOrderIndexById, folders, sortOrder]);
  const pagesByFolderId = useMemo(() => {
    const nextPagesByFolderId = new Map<string, AppData["pages"]>();

    for (const page of pages) {
      const folderPages = nextPagesByFolderId.get(page.folderId) ?? [];
      folderPages.push(page);
      nextPagesByFolderId.set(page.folderId, folderPages);
    }

    for (const folderPages of nextPagesByFolderId.values()) {
      folderPages.sort((firstPage, secondPage) => {
        if (sortOrder === "name-asc" || sortOrder === "name-desc") {
          const result = firstPage.title.localeCompare(secondPage.title, undefined, {
            sensitivity: "base",
          });

          return sortOrder === "name-asc" ? result : -result;
        }

        const firstIndex = pageOrderIndexById.get(firstPage.id) ?? 0;
        const secondIndex = pageOrderIndexById.get(secondPage.id) ?? 0;
        const result = firstIndex - secondIndex;

        return sortOrder.endsWith("desc") ? -result : result;
      });
    }

    return nextPagesByFolderId;
  }, [pageOrderIndexById, pages, sortOrder]);
  const rootPages = pagesByFolderId.get(ROOT_FOLDER_ID) ?? [];
  const allFolderIds = useMemo(
    () => folders.map((folder) => folder.id),
    [folders],
  );
  const areAllFoldersExpanded =
    allFolderIds.length > 0 &&
    allFolderIds.every((folderId) => expandedFolderIds.has(folderId));

  function hasPageDragData(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes(PAGE_DRAG_MIME_TYPE);
  }

  function updateSortMenuPosition() {
    const buttonBounds = sortMenuButtonRef.current?.getBoundingClientRect();

    if (!buttonBounds) {
      return;
    }

    const menuWidth = 236;
    const left = Math.max(
      8,
      Math.min(buttonBounds.right - menuWidth + 8, window.innerWidth - menuWidth - 8),
    );

    setSortMenuPosition({
      left,
      top: buttonBounds.bottom + 6,
    });
  }

  function openSidebarTab(tabId: SidebarTabId, trigger: HTMLButtonElement) {
    setActiveSidebarTab(tabId);

    if (isCollapsed && tabId !== "search") {
      onToggleCollapse(trigger);
    }

    if (tabId === "search") {
      onFocusPageSearch(trigger);
    }
  }

  function closeSortMenu() {
    setIsSortMenuOpen(false);
    setSortMenuPosition(null);
  }

  useEffect(() => {
    if (pageSearchFocusRequest === 0) {
      return;
    }

    setActiveSidebarTab("search");
  }, [pageSearchFocusRequest]);

  useEffect(() => {
    if (
      isCollapsed ||
      activeSidebarTab !== "search" ||
      pageSearchFocusRequest === 0
    ) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      pageSearchInputRef.current?.focus();
      pageSearchInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeSidebarTab, isCollapsed, pageSearchFocusRequest]);

  useEffect(() => {
    if (!isSortMenuOpen) {
      return;
    }

    updateSortMenuPosition();
    window.addEventListener("resize", updateSortMenuPosition);

    return () => window.removeEventListener("resize", updateSortMenuPosition);
  }, [isSortMenuOpen]);

  useEffect(() => {
    setExpandedFolderIds((currentFolderIds) => {
      const validFolderIds = new Set(allFolderIds);
      const nextFolderIds = new Set(
        Array.from(currentFolderIds).filter((folderId) =>
          validFolderIds.has(folderId),
        ),
      );

      if (currentFolderIds.size === 0) {
        for (const folderId of allFolderIds) {
          nextFolderIds.add(folderId);
        }
      }

      if (isAutoRevealEnabled && selectedPageFolderId) {
        nextFolderIds.add(selectedPageFolderId);
      }

      return areStringSetsEqual(currentFolderIds, nextFolderIds)
        ? currentFolderIds
        : nextFolderIds;
    });
  }, [allFolderIds, isAutoRevealEnabled, selectedPageFolderId]);

  useEffect(() => {
    if (!isAutoRevealEnabled || !selectedPageFolderId) {
      return;
    }

    setExpandedFolderIds((currentFolderIds) => {
      if (currentFolderIds.has(selectedPageFolderId)) {
        return currentFolderIds;
      }

      const nextFolderIds = new Set(currentFolderIds);
      nextFolderIds.add(selectedPageFolderId);
      return nextFolderIds;
    });
  }, [isAutoRevealEnabled, selectedPageFolderId]);

  function toggleFolderExpanded(folderId: string) {
    setExpandedFolderIds((currentFolderIds) => {
      const nextFolderIds = new Set(currentFolderIds);

      if (nextFolderIds.has(folderId)) {
        nextFolderIds.delete(folderId);
      } else {
        nextFolderIds.add(folderId);
      }

      return nextFolderIds;
    });
  }

  function toggleAllFolders() {
    setExpandedFolderIds(() =>
      areAllFoldersExpanded ? new Set() : new Set(allFolderIds),
    );
  }

  return (
    <aside
      className={`sidebar ${isCollapsed ? "is-collapsed" : ""}`}
      aria-label="Workspace navigation"
      inert={isInert ? true : undefined}
      onPointerDown={onPointerDown}
    >
      <ActivityRail
        activeTab={activeSidebarTab}
        bookmarkedPageCount={bookmarkedPages.length}
        Icon={HeroIcon}
        isExplorerCollapsed={isCollapsed}
        onSelectTab={openSidebarTab}
        onToggleExplorer={onToggleCollapse}
        templatePageCount={pageTemplates.length}
        toggleButtonRef={explorerToggleButtonRef}
      />

      <div
        className="sidebar-main"
        id="workspace-explorer-panel"
        ref={explorerPanelRef}
        tabIndex={-1}
      >
        {!isCollapsed ? (
          <div className="sidebar-content">
          {activeSidebarTab === "search" ? (
          <section
            className="sidebar-section sidebar-tab-panel sidebar-search"
            aria-labelledby="sidebar-search-title"
          >
            <div className="sidebar-tab-header">
              <h2 id="sidebar-search-title">Search</h2>
            </div>
            <div
              className={`file-search-control ${
                isPageSearchFocused || isSearchOptionsOpen ? "is-active" : ""
              }`}
            >
              <HeroIcon name="magnifying-glass" />
              <input
                aria-label="Search files and notes"
                className="sidebar-search-input"
                onBlur={() => {
                  window.setTimeout(() => setIsPageSearchFocused(false), 80);
                }}
                onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
                onFocus={() => setIsPageSearchFocused(true)}
                placeholder="Search..."
                ref={pageSearchInputRef}
                type="search"
                value={pageSearchQuery}
              />
              <span className="file-search-case" aria-hidden="true">
                Aa
              </span>
              <button
                type="button"
                className="file-search-options-button"
                aria-label="Toggle search options"
                aria-pressed={isSearchOptionsOpen}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setIsSearchOptionsOpen((currentValue) => !currentValue)}
                title="Search options"
              >
                <HeroIcon name="adjustments-horizontal" />
              </button>
            </div>
            {(isSearchOptionsOpen ||
              (isPageSearchFocused && !pageSearchQuery.trim())) ? (
              <div className="search-options-popover">
                <div className="search-options-title">
                  <span>Search options</span>
                  <span aria-hidden="true">ⓘ</span>
                </div>
                <p><strong>path:</strong> match path of the file</p>
                <p><strong>file:</strong> match file name</p>
                <p><strong>tag:</strong> search for tags</p>
                <p><strong>line:</strong> search keywords on same line</p>
                <p><strong>section:</strong> search keywords under same heading</p>
                <p><strong>[property]</strong> match property</p>
              </div>
            ) : null}
            {pageSearchQuery.trim() ? (
              <div className="search-results" aria-label="Search results">
                {pageSearchResults.length > 0 ? (
                  pageSearchResults.map((result) => (
                    <button
                      className={`search-result ${
                        result.pageId === selectedPageId ? "is-selected" : ""
                      }`}
                      key={result.pageId}
                      onClick={() => onSelectPage(result.pageId)}
                      type="button"
                    >
                      <span className="search-result-title-row">
                        <span className="search-result-title">{result.title}</span>
                        <span className="search-result-count">
                          {formatPageSearchSummary(result)}
                        </span>
                      </span>
                      <span className="search-result-folder">
                        {result.folderName}
                      </span>
                      <span className="search-result-preview">
                        {result.preview}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="empty-state">No matching pages</p>
                )}
              </div>
            ) : null}
          </section>
          ) : null}

          {activeSidebarTab === "files" ? (
          <section
            className="sidebar-section sidebar-tab-panel file-explorer"
            aria-labelledby="explorer-title"
          >
            <div className="file-explorer-header">
              <h2 id="explorer-title">Files</h2>
              <div className="file-explorer-toolbar" aria-label="File explorer actions">
                <button
                  type="button"
                  className="section-action"
                  aria-label="Create page"
                  onClick={onCreatePage}
                  title="Create page"
                >
                  <HeroIcon name="pencil-square" />
                </button>
                <button
                  type="button"
                  className="section-action"
                  aria-label="Create folder"
                  onClick={onCreateFolder}
                  title="Create folder"
                >
                  <HeroIcon name="folder-plus" />
                </button>
                <span className="sort-menu">
                  <button
                    type="button"
                    className="section-action"
                    aria-expanded={isSortMenuOpen}
                    aria-haspopup="menu"
                    aria-label="Change sort order"
                    onClick={() => {
                      if (!isSortMenuOpen) {
                        updateSortMenuPosition();
                      } else {
                        setSortMenuPosition(null);
                      }

                      setIsSortMenuOpen((currentValue) => !currentValue);
                    }}
                    ref={sortMenuButtonRef}
                    title="Change sort order"
                  >
                    <HeroIcon name="arrows-up-down" />
                  </button>
                  {isSortMenuOpen ? (
                    <div
                      className="sort-menu-popover"
                      role="menu"
                      style={
                        sortMenuPosition
                          ? {
                              left: sortMenuPosition.left,
                              top: sortMenuPosition.top,
                            }
                          : undefined
                      }
                    >
                      {sidebarSortOptions.map((sortOption, index) => (
                        <button
                          className="sort-menu-item"
                          key={sortOption.value}
                          onClick={() => {
                            setSortOrder(sortOption.value);
                            closeSortMenu();
                          }}
                          role="menuitemradio"
                          aria-checked={sortOrder === sortOption.value}
                          type="button"
                        >
                          <span>{sortOption.label}</span>
                          {sortOrder === sortOption.value ? (
                            <HeroIcon name="check" />
                          ) : null}
                          {index === 1 || index === 3 ? (
                            <span className="sort-menu-separator" aria-hidden="true" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="section-action"
                  aria-pressed={isAutoRevealEnabled}
                  aria-label="Auto-reveal current file"
                  onClick={() =>
                    setIsAutoRevealEnabled((currentValue) => !currentValue)
                  }
                  title="Auto-reveal current file"
                >
                  <HeroIcon name={isAutoRevealEnabled ? "eye" : "eye-slash"} />
                </button>
                <button
                  type="button"
                  className="section-action"
                  aria-label={areAllFoldersExpanded ? "Collapse all" : "Expand all"}
                  onClick={toggleAllFolders}
                  title={areAllFoldersExpanded ? "Collapse all" : "Expand all"}
                >
                  <HeroIcon name="archive-box" />
                </button>
              </div>
            </div>
            <div className="file-tree" role="tree" aria-label="Folders and pages">
              {rootPages.map((page) => {
                const isPageSelected = selectedPageIdSet.has(page.id);
                const isPageOpen = page.id === selectedPageId;
                const isPageDragging = draggedPageIdSet.has(page.id);

                return (
                  <div
                    className={`nav-item nav-item-page file-tree-row file-tree-root-page ${
                      isPageSelected ? "is-selected" : ""
                    } ${isPageOpen ? "is-open" : ""} ${
                      isPageDragging ? "is-dragging" : ""
                    }`}
                    draggable={editingPageId !== page.id}
                    key={page.id}
                    role="treeitem"
                    onDoubleClick={() => onSetEditingPageId(page.id)}
                    onClick={(event) =>
                      onSelectPage(page.id, event.metaKey || event.ctrlKey)
                    }
                    onDragEnd={onPageDragEnd}
                    onDragStart={(event) => {
                      if (!onPageDragStart(page.id)) {
                        event.preventDefault();
                        return;
                      }

                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(PAGE_DRAG_MIME_TYPE, page.id);
                      event.dataTransfer.setData("text/plain", page.title);
                    }}
                  >
                    <span className="file-row-spacer" aria-hidden="true" />
                    <span className="file-row-icon">
                      <HeroIcon name="document-text" />
                    </span>
                    {editingPageId === page.id ? (
                      <InlineRename
                        ariaLabel="Page title"
                        initialValue={page.title}
                        onCancel={() => onSetEditingPageId(null)}
                        onCommit={(value) => {
                          onRenamePage(page.id, value);
                          onSetEditingPageId(null);
                        }}
                      />
                    ) : (
                      <span className="nav-label">{page.title}</span>
                    )}
                    <span className="file-kind">CANVAS</span>
                    <button
                      type="button"
                      className={`bookmark-toggle ${
                        page.isBookmarked ? "is-bookmarked" : ""
                      }`}
                      aria-label={`${
                        page.isBookmarked ? "Remove bookmark from" : "Bookmark"
                      } ${page.title}`}
                      aria-pressed={Boolean(page.isBookmarked)}
                      title={page.isBookmarked ? "Remove bookmark" : "Bookmark"}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePageBookmark(page.id);
                      }}
                    >
                      <HeroIcon name="bookmark" />
                    </button>
                    <span className="nav-actions">
                      <button
                        type="button"
                        aria-label={`Delete ${page.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeletePage(page.id);
                        }}
                        title={`Delete ${page.title}`}
                      >
                        <HeroIcon name="trash" />
                      </button>
                    </span>
                  </div>
                );
              })}
              {sortedFolders.map((folder) => {
                const folderPages = pagesByFolderId.get(folder.id) ?? [];
                const isFolderExpanded = expandedFolderIds.has(folder.id);

                return (
                  <div className="file-tree-group" key={folder.id}>
                    <div
                      className={`nav-item nav-item-folder file-tree-row ${
                        folder.id === selectedFolderId ? "is-active" : ""
                      } ${
                        folder.id === pageDropTargetFolderId ? "is-drop-target" : ""
                      }`}
                      aria-expanded={isFolderExpanded}
                      role="treeitem"
                      onDoubleClick={() => onSetEditingFolderId(folder.id)}
                      onClick={() => onSelectFolder(folder.id)}
                      onDragLeave={(event) => {
                        if (
                          event.currentTarget.contains(event.relatedTarget as Node | null)
                        ) {
                          return;
                        }

                        onFolderDragLeave(folder.id);
                      }}
                      onDragOver={(event) => {
                        if (!hasPageDragData(event)) {
                          return;
                        }

                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        onFolderDragOver(folder.id);
                      }}
                      onDrop={(event) => {
                        if (!hasPageDragData(event)) {
                          return;
                        }

                        event.preventDefault();
                        event.stopPropagation();
                        onPageDropOnFolder(folder.id);
                      }}
                    >
                      <button
                        type="button"
                        className="folder-disclosure"
                        aria-label={isFolderExpanded ? "Collapse folder" : "Expand folder"}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFolderExpanded(folder.id);
                        }}
                      >
                        <HeroIcon name={isFolderExpanded ? "chevron-down" : "chevron-right"} />
                      </button>
                      <span className="file-row-icon">
                        <HeroIcon name="folder" />
                      </span>
                      {editingFolderId === folder.id ? (
                        <InlineRename
                          ariaLabel="Folder name"
                          initialValue={folder.name}
                          onCancel={() => onSetEditingFolderId(null)}
                          onCommit={(value) => {
                            onRenameFolder(folder.id, value);
                            onSetEditingFolderId(null);
                          }}
                        />
                      ) : (
                        <span className="nav-label">{folder.name}</span>
                      )}
                      <span className="item-count">{folderPages.length}</span>
                      <span className="nav-actions">
                        <button
                          type="button"
                          aria-label={`Delete ${folder.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteFolder(folder.id);
                          }}
                          title={`Delete ${folder.name}`}
                        >
                          <HeroIcon name="trash" />
                        </button>
                      </span>
                    </div>
                    {isFolderExpanded ? (
                      <div className="file-tree-children" role="group">
                        {folderPages.map((page) => {
                          const isPageSelected = selectedPageIdSet.has(page.id);
                          const isPageOpen = page.id === selectedPageId;
                          const isPageDragging = draggedPageIdSet.has(page.id);

                          return (
                            <div
                              className={`nav-item nav-item-page file-tree-row ${
                                isPageSelected ? "is-selected" : ""
                              } ${isPageOpen ? "is-open" : ""} ${
                                isPageDragging ? "is-dragging" : ""
                              }`}
                              draggable={editingPageId !== page.id}
                              key={page.id}
                              role="treeitem"
                              onDoubleClick={() => onSetEditingPageId(page.id)}
                              onClick={(event) =>
                                onSelectPage(page.id, event.metaKey || event.ctrlKey)
                              }
                              onDragEnd={onPageDragEnd}
                              onDragStart={(event) => {
                                if (!onPageDragStart(page.id)) {
                                  event.preventDefault();
                                  return;
                                }

                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData(PAGE_DRAG_MIME_TYPE, page.id);
                                event.dataTransfer.setData("text/plain", page.title);
                              }}
                            >
                              <span className="file-row-spacer" aria-hidden="true" />
                              <span className="file-row-icon">
                                <HeroIcon name="document-text" />
                              </span>
                              {editingPageId === page.id ? (
                                <InlineRename
                                  ariaLabel="Page title"
                                  initialValue={page.title}
                                  onCancel={() => onSetEditingPageId(null)}
                                  onCommit={(value) => {
                                    onRenamePage(page.id, value);
                                    onSetEditingPageId(null);
                                  }}
                                />
                              ) : (
                                <span className="nav-label">{page.title}</span>
                              )}
                              <span className="file-kind">CANVAS</span>
                              <button
                                type="button"
                                className={`bookmark-toggle ${
                                  page.isBookmarked ? "is-bookmarked" : ""
                                }`}
                                aria-label={`${
                                  page.isBookmarked ? "Remove bookmark from" : "Bookmark"
                                } ${page.title}`}
                                aria-pressed={Boolean(page.isBookmarked)}
                                title={page.isBookmarked ? "Remove bookmark" : "Bookmark"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onTogglePageBookmark(page.id);
                                }}
                              >
                                <HeroIcon name="bookmark" />
                              </button>
                              <span className="nav-actions">
                                <button
                                  type="button"
                                  aria-label={`Delete ${page.title}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onDeletePage(page.id);
                                  }}
                                  title={`Delete ${page.title}`}
                                >
                                  <HeroIcon name="trash" />
                                </button>
                              </span>
                            </div>
                          );
                        })}
                        {folderPages.length === 0 ? (
                          <p className="empty-state file-tree-empty">No pages</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {sortedFolders.length === 0 && rootPages.length === 0 ? (
                <p className="empty-state">No pages or folders yet</p>
              ) : null}
            </div>
          </section>
          ) : null}

          {activeSidebarTab === "bookmarks" ? (
            <section
              className="sidebar-section sidebar-tab-panel compact-section"
              aria-labelledby="favorites-title"
            >
              <div className="section-header">
                <h2 id="favorites-title">Favorites</h2>
              </div>
              {bookmarkedPages.length > 0 ? (
                <div className="nav-list">
                  {bookmarkedPages.map((page) => (
                    <div
                      className={`nav-item nav-item-bookmark ${
                        page.id === selectedPageId ? "is-selected" : ""
                      }`}
                      key={page.id}
                      onClick={() => onSelectPage(page.id)}
                    >
                      <span className="file-row-icon">
                        <HeroIcon name="bookmark" />
                      </span>
                      <span className="nav-label">{page.title}</span>
                      <span className="bookmark-folder-label">
                        {page.folderId === ROOT_FOLDER_ID
                          ? "Root"
                          : folderNamesById.get(page.folderId) ?? "Missing folder"}
                      </span>
                      <button
                        type="button"
                        className="bookmark-toggle is-bookmarked"
                        aria-label={`Remove bookmark from ${page.title}`}
                        aria-pressed="true"
                        title="Remove bookmark"
                        onClick={(event) => {
                          event.stopPropagation();
                          onTogglePageBookmark(page.id);
                        }}
                      >
                        <HeroIcon name="bookmark" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="sidebar-placeholder">
                  <HeroIcon name="bookmark" />
                  No favorites
                </p>
              )}
            </section>
          ) : null}

          {activeSidebarTab === "templates" ? (
            <section
              className="sidebar-section sidebar-tab-panel compact-section"
              aria-labelledby="templates-title"
            >
              <div className="section-header">
                <h2 id="templates-title">Templates</h2>
                <button
                  aria-label="Save current page as template"
                  className="section-action"
                  disabled={!canCreateTemplateFromPage}
                  onClick={onCreateTemplateFromPage}
                  title="Save current page as template"
                  type="button"
                >
                  <HeroIcon name="rectangle-stack" />
                </button>
              </div>
              {pageTemplates.length > 0 ? (
                <div className="nav-list">
                  {pageTemplates.map((templatePage) => (
                    <div
                      className="nav-item nav-item-template"
                      key={templatePage.id}
                    >
                      <button
                        aria-label={`Create page from ${templatePage.title}`}
                        className="template-create-button"
                        onClick={() => onCreatePageFromTemplate(templatePage.id)}
                        title={`Create page from ${templatePage.title}`}
                        type="button"
                      >
                        <span className="file-row-icon">
                          <HeroIcon name="rectangle-stack" />
                        </span>
                        <span className="nav-label">{templatePage.title}</span>
                        <span className="file-kind">TEMPLATE</span>
                      </button>
                      <span className="nav-actions">
                        <button
                          aria-label={`Delete template ${templatePage.title}`}
                          onClick={() => {
                            const didConfirm = window.confirm(
                              `Delete template "${templatePage.title}"?\n\nPages already created from this template will not be affected.`,
                            );

                            if (didConfirm) {
                              onDeletePageTemplate(templatePage.id);
                            }
                          }}
                          title={`Delete template ${templatePage.title}`}
                          type="button"
                        >
                          <HeroIcon name="trash" />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="sidebar-placeholder">
                  <HeroIcon name="rectangle-stack" />
                  No templates
                </p>
              )}
            </section>
          ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}, areSidebarPropsEqual);

function areSidebarPropsEqual(previous: SidebarProps, next: SidebarProps) {
  return (
    previous.bookmarkedPages === next.bookmarkedPages &&
    previous.draggedPageIds === next.draggedPageIds &&
    previous.editingFolderId === next.editingFolderId &&
    previous.editingPageId === next.editingPageId &&
    previous.folders === next.folders &&
    previous.isCollapsed === next.isCollapsed &&
    previous.isInert === next.isInert &&
    previous.isNarrowWorkbench === next.isNarrowWorkbench &&
    previous.pageSearchFocusRequest === next.pageSearchFocusRequest &&
    previous.pageTemplates === next.pageTemplates &&
    previous.pages === next.pages &&
    previous.pageSearchQuery === next.pageSearchQuery &&
    previous.pageSearchResults === next.pageSearchResults &&
    previous.pageDropTargetFolderId === next.pageDropTargetFolderId &&
    previous.selectedFolderId === next.selectedFolderId &&
    previous.selectedPageId === next.selectedPageId &&
    previous.selectedPageIds === next.selectedPageIds
  );
}

const PageHeader = memo(function PageHeader({
  activeTextEditor,
  assistantToggleButtonRef,
  isAssistantOpen,
  isGridVisible,
  isDarkMode,
  isEditingHeaderTitle,
  isSnapToGridEnabled,
  isTextFormattingVisible,
  openPages,
  selectedPageId,
  textFormatState,
  zoomLevel,
  onClosePageTab,
  onCreatePage,
  onFocusCanvasSearch,
  onPointerDown,
  onRenamePage,
  onReorderPageTab,
  onSelectPageTab,
  onSetEditingHeaderTitle,
  onToggleAssistant,
  onToggleGrid,
  onToggleDarkMode,
  onToggleSnapToGrid,
  onSetTextFontFamily,
  onSetTextFontSize,
  onToggleTextFormat,
}: PageHeaderProps) {
  const gridToggleTitle = isGridVisible ? "Hide grid" : "Show grid";
  const snapToggleTitle = !isGridVisible
    ? "Show grid to enable snap to grid"
    : isSnapToGridEnabled
      ? "Disable snap to grid"
      : "Enable snap to grid";
  const themeToggleTitle = isDarkMode
    ? "Switch to light mode"
    : "Switch to dark mode";

  return (
    <header
      className="page-header"
      onPointerDown={onPointerDown}
    >
      <WorkspaceTabs
        Icon={HeroIcon}
        isEditingActiveTab={isEditingHeaderTitle}
        onCloseTab={onClosePageTab}
        onCreatePage={onCreatePage}
        onRenamePage={onRenamePage}
        onReorderTab={onReorderPageTab}
        onSelectTab={onSelectPageTab}
        onSetEditingActiveTab={onSetEditingHeaderTitle}
        selectedPageId={selectedPageId}
        tabs={openPages}
      />
      <div className="page-header-actions">
        {isTextFormattingVisible ? (
          <GlobalTextToolbar
            editor={activeTextEditor && !activeTextEditor.isDestroyed ? activeTextEditor : null}
            formatState={textFormatState}
            onSetFontFamily={onSetTextFontFamily}
            onSetFontSize={onSetTextFontSize}
            onToggleFormat={onToggleTextFormat}
          />
        ) : null}
        <div
          aria-label="Canvas controls"
          className="canvas-controls"
          role="toolbar"
        >
          <button
            aria-label="Find in canvas"
            className="header-toggle icon-button"
            data-tooltip="Find in canvas (Ctrl+F)"
            onClick={onFocusCanvasSearch}
            type="button"
          >
            <HeroIcon name="magnifying-glass" />
          </button>
          <button
            aria-controls="workspace-assistant-panel"
            aria-expanded={isAssistantOpen}
            aria-label="AI assistant"
            aria-pressed={isAssistantOpen}
            className="header-toggle icon-button"
            data-tooltip="AI assistant"
            onClick={(event) => onToggleAssistant(event.currentTarget)}
            ref={assistantToggleButtonRef}
            type="button"
          >
            <HeroIcon name="sparkles" />
          </button>
          <span
            aria-label={`Zoom ${Math.round(zoomLevel * 100)}%`}
            className="zoom-indicator"
            data-tooltip="Zoom level"
          >
            {Math.round(zoomLevel * 100)}%
          </span>
          <button
            aria-label="Grid"
            aria-pressed={isGridVisible}
            className="header-toggle icon-button"
            data-tooltip={gridToggleTitle}
            onClick={onToggleGrid}
            type="button"
          >
            <HeroIcon name="squares-2x2" />
          </button>
          <button
            aria-label="Snap to grid"
            aria-pressed={isGridVisible && isSnapToGridEnabled}
            className="header-toggle icon-button"
            data-tooltip={snapToggleTitle}
            disabled={!isGridVisible}
            onClick={onToggleSnapToGrid}
            type="button"
          >
            <HeroIcon name="adjustments-horizontal" />
          </button>
          <button
            aria-label="Dark mode"
            aria-pressed={isDarkMode}
            className="theme-toggle icon-button"
            data-tooltip={themeToggleTitle}
            onClick={onToggleDarkMode}
            type="button"
          >
            <HeroIcon name={isDarkMode ? "sun" : "moon"} />
          </button>
        </div>
      </div>
    </header>
  );
}, arePageHeaderPropsEqual);

type ToolbarAction = {
  icon: HeroIconName;
  id: ToolbarActionId;
  isActive: boolean;
  isDisabled?: boolean;
  title: string;
};

function GlobalTextToolbar({
  editor,
  formatState,
  onSetFontFamily,
  onSetFontSize,
  onToggleFormat,
}: {
  editor: Editor | null;
  formatState: TextFormatState;
  onSetFontFamily: (fontFamily: TextFontFamily) => void;
  onSetFontSize: (fontSize: TextFontSize) => void;
  onToggleFormat: (formatId: ToolbarActionId) => void;
}) {
  const toolbarState = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor || editor.isDestroyed) {
        return null;
      }

      return {
        canToggleBlockquote: editor.can().chain().focus().toggleBlockquote().run(),
        canToggleBold: editor.can().chain().focus().toggleBold().run(),
        canToggleBulletList: editor.can().chain().focus().toggleBulletList().run(),
        canToggleCode: editor.can().chain().focus().toggleCode().run(),
        canToggleItalic: editor.can().chain().focus().toggleItalic().run(),
        canToggleOrderedList: editor.can().chain().focus().toggleOrderedList().run(),
        canToggleStrike: editor.can().chain().focus().toggleStrike().run(),
        canToggleUnderline: editor.can().chain().focus().toggleUnderline().run(),
        fontFamily: normalizeTextFontFamily(
          editor.getAttributes("textStyle").fontFamily,
        ),
        fontSize: normalizeTextFontSize(
          editor.getAttributes("textStyle").fontSize,
        ),
        isBlockquote: editor.isActive("blockquote"),
        isBold: editor.isActive("bold"),
        isBulletList: editor.isActive("bulletList"),
        isCode: editor.isActive("code"),
        isItalic: editor.isActive("italic"),
        isOrderedList: editor.isActive("orderedList"),
        isStrike: editor.isActive("strike"),
        isUnderline: editor.isActive("underline"),
      };
    },
  });
  const activeFontFamily = toolbarState?.fontFamily ?? formatState.fontFamily;
  const activeFontSize = toolbarState?.fontSize ?? formatState.fontSize;

  const actions: ToolbarAction[] = [
    {
      icon: "bold",
      id: "bold",
      isActive: toolbarState?.isBold ?? formatState.bold,
      isDisabled: toolbarState ? !toolbarState.canToggleBold : false,
      title: "Bold",
    },
    {
      icon: "italic",
      id: "italic",
      isActive: toolbarState?.isItalic ?? formatState.italic,
      isDisabled: toolbarState ? !toolbarState.canToggleItalic : false,
      title: "Italic",
    },
    {
      icon: "strikethrough",
      id: "strike",
      isActive: toolbarState?.isStrike ?? formatState.strike,
      isDisabled: toolbarState ? !toolbarState.canToggleStrike : false,
      title: "Strikethrough",
    },
    {
      icon: "underline",
      id: "underline",
      isActive: toolbarState?.isUnderline ?? formatState.underline,
      isDisabled: toolbarState ? !toolbarState.canToggleUnderline : false,
      title: "Underline",
    },
    {
      icon: "list-bullet",
      id: "bulletList",
      isActive: toolbarState?.isBulletList ?? formatState.bulletList,
      isDisabled: toolbarState ? !toolbarState.canToggleBulletList : false,
      title: "Bullet list",
    },
    {
      icon: "numbered-list",
      id: "orderedList",
      isActive: toolbarState?.isOrderedList ?? formatState.orderedList,
      isDisabled: toolbarState ? !toolbarState.canToggleOrderedList : false,
      title: "Ordered list",
    },
    {
      icon: "quote",
      id: "blockquote",
      isActive: toolbarState?.isBlockquote ?? formatState.blockquote,
      isDisabled: toolbarState ? !toolbarState.canToggleBlockquote : false,
      title: "Quote",
    },
    {
      icon: "code-bracket",
      id: "code",
      isActive: toolbarState?.isCode ?? formatState.code,
      isDisabled: toolbarState ? !toolbarState.canToggleCode : false,
      title: "Code",
    },
  ];

  return (
    <div
      aria-label="Text formatting"
      className="global-text-toolbar"
      onMouseDown={(event) => {
        markToolbarInteraction();

        if (!(event.target instanceof HTMLSelectElement)) {
          event.preventDefault();
        }
      }}
      onPointerDown={(event) => {
        markToolbarInteraction();
        event.stopPropagation();

        if (!(event.target instanceof HTMLSelectElement)) {
          event.preventDefault();
        }
      }}
      role="toolbar"
    >
      <select
        aria-label="Font family"
        className="text-toolbar-select text-toolbar-font"
        onChange={(event) =>
          onSetFontFamily(event.currentTarget.value as TextFontFamily)
        }
        title="Font family"
        value={activeFontFamily}
      >
        {textFontFamilyOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="toolbar-divider" aria-hidden="true" />
      <select
        aria-label="Font size"
        className="text-toolbar-select text-toolbar-size"
        onChange={(event) =>
          onSetFontSize(event.currentTarget.value as TextFontSize)
        }
        title="Font size"
        value={activeFontSize}
      >
        {textFontSizeOptions.map((fontSize) => (
          <option key={fontSize} value={fontSize}>
            {fontSize.replace("px", "")}
          </option>
        ))}
      </select>
      <span className="toolbar-divider" aria-hidden="true" />
      {actions.map((action, index) => (
        <Fragment key={action.title}>
          <button
            aria-label={action.title}
            aria-pressed={action.isActive}
            className={action.isActive ? "is-active" : undefined}
            disabled={action.isDisabled}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFormat(action.id);
            }}
            title={action.title}
            type="button"
          >
            <HeroIcon name={action.icon} />
          </button>
          {index === 3 || index === 5 ? (
            <span className="toolbar-divider" aria-hidden="true" />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

function arePageHeaderPropsEqual(previous: PageHeaderProps, next: PageHeaderProps) {
  return (
    previous.activeTextEditor === next.activeTextEditor &&
    previous.isAssistantOpen === next.isAssistantOpen &&
    previous.isGridVisible === next.isGridVisible &&
    previous.isDarkMode === next.isDarkMode &&
    previous.isEditingHeaderTitle === next.isEditingHeaderTitle &&
    previous.isSnapToGridEnabled === next.isSnapToGridEnabled &&
    previous.isTextFormattingVisible === next.isTextFormattingVisible &&
    previous.openPages === next.openPages &&
    previous.selectedPageId === next.selectedPageId &&
    previous.textFormatState === next.textFormatState &&
    previous.zoomLevel === next.zoomLevel
  );
}

export default App;
