import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { ConnectorEndpointChooser } from "./canvas/components/ConnectorEndpointChooser";
import { CanvasInteractionOverlay } from "./canvas/components/CanvasInteractionOverlay";
import { CanvasToolPalette } from "./canvas/components/CanvasToolPalette";
import { DrawingPropertiesPanel } from "./canvas/components/DrawingPropertiesPanel";
import { CanvasViewport } from "./canvas/components/CanvasViewport";
import { CanvasWorldLayer } from "./canvas/components/CanvasWorldLayer";
import { InkElementView } from "./canvas/components/InkElementView";
import { ConnectorElementView, ShapeElementView, type ShapeTextEditSession } from "./canvas/components/PrimitiveElementView";
import { ConnectorBindingTargetHighlight } from "./canvas/components/ConnectorBindingTargetHighlight";
import {
  getSuppressedConnectorControlPlacement,
  isCanonicalConnectorRouteSuppressed,
  SuppressedConnectorControl,
} from "./canvas/components/SuppressedConnectorControl";
import { useCanvasInteraction, type ArrowAuthoringVisual } from "./canvas/interaction/useCanvasInteraction";
import { cleanupMarquee } from "./canvas/interaction/marqueeCleanup";
import { createLatestFrameQueue, type LatestFrameQueue } from "./canvas/interaction/latestFrame";
import {
  forEachAffectedConnectorGeometry,
  overlayTransformedElements,
} from "./canvas/interaction/transformPreview";
import { ConnectorPreviewCanvas } from "./canvas/rendering/connectorPreviewCanvas";
import { compareConnectorPreviewStack, type ConnectorPreviewCommand } from "./canvas/rendering/connectorPreviewProtocol";
import { resolveCanvasColor } from "./canvas/rendering/canvasColor";
import {
  deterministicSeed,
  getDefaultKeyboardShapeGeometry,
  isPersistableShapeRect,
  type PrimitiveGeometry,
  type PrimitiveTool,
  type ShapeTool,
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
  MIN_BLOCK_HEIGHT,
  MIN_BLOCK_WIDTH,
  MIN_ZOOM,
  SAVE_DELAY_MS,
  TEXT_BLOCK_HEIGHT_BUFFER,
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
  hasCanvasToolShortcutContext,
  isTextEntryTarget,
} from "./editorUtils";
import { cloneRichTextValue } from "./editor/richText";
import {
  createCanvasSearchTextIndex,
  findCanvasTextSearchResult,
  findTextSearchRanges,
  getCanvasSearchRangesForElement,
  MAX_CANVAS_SEARCH_MATCHES,
} from "./canvas/search/searchModel";
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
  type RichTextValue,
  type RoughStyle,
  type ConnectorElement,
  type ConnectorEndpoint,
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
  drawingPropertiesFromTextPreferences,
  isDrawingPreferenceTool,
  isPropertySupportedByTool,
  normalizeDrawingPreferences,
  readDrawingProperties,
  updateDrawingPreference,
  type DrawingProperty,
  type DrawingPropertyUpdate,
  type DrawingPreferences,
} from "./canvas/model/drawingPreferences";
import {
  DEFAULT_TEXT_PREFERENCES,
  normalizeTextPreferences,
} from "./canvas/model/textPreferences";
import { reorderLayers, type LayerAction } from "./canvas/model/layerOrdering";
import {
  getProportionalScale,
  getOppositeCorner,
  getSelectionElementBounds,
  getSelectionBounds,
  getSelectionResizePreviewConnectorIds,
  scaleSelection,
  translateSelection,
  type SelectionCorner,
  type TextSelectionSize,
} from "./canvas/model/selectionBounds";
import { getDrawingToolLockPreference } from "./canvas/state/drawingToolLock";
import { getDirectBindableTargetAtPoint } from "./canvas/model/hitTesting";
import {
  detachConnectorEndpointsForDeletedTargets,
  getConnectorCandidateAnnouncement,
  getConnectorCandidateAnnouncementKey,
  getDefaultKeyboardArrowEndpoints,
  getConnectorEndpointDetachPoint,
  getConnectorAuthoringCandidate,
  isBindableElement,
  isConnectorBindingPersistable,
  normalizeFreeConnectorEndpoint,
  resolveConnectorPoints,
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
  canvasSearchButtonRef: Ref<HTMLButtonElement>;
  isAssistantOpen: boolean;
  isGridVisible: boolean;
  isDarkMode: boolean;
  isCanvasSearchUnavailable: boolean;
  isTextFormattingVisible: boolean;
  isEditingHeaderTitle: boolean;
  isSnapToGridEnabled: boolean;
  openPages: OpenPageTab[];
  selectedPageId: string;
  textFormatState: TextFormatState;
  titleSearchHighlights: readonly Readonly<{ end: number; isActive: boolean; start: number }>[];
  zoomLevel: number;
  onClosePageTab: (pageId: string) => void;
  onCreatePage: () => void;
  onFocusCanvasSearch: (trigger?: HTMLElement | null) => void;
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

type ConnectorPreviewRecord = Readonly<{
  bounds: Readonly<{ height: number; left: number; top: number; width: number }>;
  end: CanvasPoint;
  start: CanvasPoint;
}>;

type ConnectorPreviewElement = HTMLCanvasElement & {
  __connectorPreviewRecords?: ReadonlyMap<string, ConnectorPreviewRecord>;
};

type ConnectorPreviewLayer = {
  renderer: ConnectorPreviewCanvas | null;
};

type DragLayerSession = {
  affectedConnectorIds: ReadonlySet<string>;
  autoPanRafId: number | null;
  baseElementsById: Readonly<Record<string, CanvasElement>>;
  blockIds: string[];
  currentClientX: number;
  currentClientY: number;
  groupElement: HTMLDivElement;
  overlayElement: HTMLDivElement;
  sourceElements: HTMLElement[];
  connectorPreviewElements: ConnectorPreviewLayer;
  connectorSourceElements: HTMLElement[];
  selectedBlockIds: string[];
  selectedElements: readonly CanvasElement[];
  selectedIds: ReadonlySet<string>;
  startClientX: number;
  startClientY: number;
  startPanOffset: PanOffset;
  zoomLevel: number;
};

type ResizeLayerSession = {
  baseElementsById: Readonly<Record<string, CanvasElement>>;
  connectorIds: ReadonlySet<string>;
  items: {
    cloneElement: HTMLElement;
    element: CanvasElement & BoxCanvasElement;
    wrapperElement: HTMLDivElement;
  }[];
  overlayElement: HTMLDivElement;
  sourceElements: HTMLElement[];
  connectorPreviewElements: ConnectorPreviewLayer;
  connectorSourceElements: HTMLElement[];
  selectedElements: readonly CanvasElement[];
  selectedIds: ReadonlySet<string>;
};

type TextResizeSession = {
  affectedConnectorIds: ReadonlySet<string>;
  baseElementsById: Readonly<Record<string, CanvasElement>>;
  block: TextElement;
  connectorPreviewElements: ConnectorPreviewLayer;
  connectorSourceElements: HTMLElement[];
  handleElement: HTMLButtonElement | null;
  originalHeight: string;
  originalHandleLeft: string;
  originalHandleTop: string;
  originalLeft: string;
  originalTop: string;
  originalWidth: string;
  sourceElement: HTMLElement;
};

type SelectionTransformSession = {
  baseElementsById: Readonly<Record<string, CanvasElement>>;
  captureTarget: HTMLElement;
  corner: SelectionCorner | null;
  connectorEndpoint: "start" | "end" | null;
  didMove: boolean;
  pointerId: number;
  previewFrame: LatestFrameQueue<Readonly<{ clientX: number; clientY: number }>>;
  startBounds: SelectionRect;
  startClientX: number;
  startClientY: number;
  selectionScale: number | null;
  textResize: boolean;
  textSizes: ReadonlyMap<string, TextSelectionSize> | null;
};

type ConnectorEndpointChooserState = {
  endpoint: "start" | "end";
  targetElementId: string | null;
};

type DrawingPropertyPreviewTransaction = {
  baseline: CanvasElement[];
  ownerKey: string;
  selectedIds: string[];
};

type CopyableElement = TextElement | ImageElement | ShapeElement;
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
  | ({ kind: "element" } & SearchMatch)
  | { end: number; kind: "title"; start: number };

const DRAG_AUTO_PAN_EDGE_PX = 56;
const DRAG_AUTO_PAN_MAX_STEP_PX = 18;
const SELECTION_FRAME_PADDING_PX = 4;
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
const SEARCH_CONTROL_COMMAND_KEYS = new Set(["a", "f", "n", "o", "y", "z", "+", "=", "-", "0"]);

function createConnectorPreviewLayer(): ConnectorPreviewLayer {
  return { renderer: null };
}

function cleanupConnectorPreviewLayer(layer: ConnectorPreviewLayer) {
  layer.renderer?.dispose();
  layer.renderer = null;
}

const lightPreviewColorCache = new WeakMap<ConnectorElement["style"]["strokeColor"], string>();
const darkPreviewColorCache = new WeakMap<ConnectorElement["style"]["strokeColor"], string>();

function resolvedPreviewColor(color: ConnectorElement["style"]["strokeColor"], darkMode: boolean) {
  const cache = darkMode ? darkPreviewColorCache : lightPreviewColorCache;
  const cached = cache.get(color);
  if (cached) return cached;
  const resolved = resolveCanvasColor(color, darkMode ? "dark" : "light");
  const value = resolved
    ? `rgba(${resolved.red}, ${resolved.green}, ${resolved.blue}, ${resolved.alpha})`
    : "#000000";
  cache.set(color, value);
  return value;
}
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

function isCanvasSearchPanelTarget(target: EventTarget | null): target is Element {
  return target instanceof Element && target.closest(".search-panel") !== null;
}

function guardCanvasSearchPanelKeyboardEvent(event: KeyboardEvent): boolean {
  if (!isCanvasSearchPanelTarget(event.target)) return false;
  if (isTextEntryTarget(event.target)) return true;
  const isAppCommand = (event.ctrlKey || event.metaKey)
    && SEARCH_CONTROL_COMMAND_KEYS.has(event.key.toLowerCase());
  const isCanvasDeletion = event.key === "Delete" || event.key === "Backspace";
  const isToolCommand = drawingToolForShortcut(event, true) !== null;
  if (isAppCommand || isCanvasDeletion || isToolCommand) event.preventDefault();
  return true;
}

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

function hasShapeContainedText(
  element: CanvasElement,
): element is ShapeElement & Required<Pick<ShapeElement, "text">> {
  return element.type === "shape" && element.text !== undefined;
}

function hasShapeContainedTextDifference(first: CanvasElement[], second: CanvasElement[]) {
  const firstText = new Map(first.filter(hasShapeContainedText).map((element) => [element.id, JSON.stringify(element.text)]));
  const secondText = new Map(second.filter(hasShapeContainedText).map((element) => [element.id, JSON.stringify(element.text)]));
  return firstText.size !== secondText.size
    || [...firstText].some(([elementId, text]) => secondText.get(elementId) !== text);
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
  const [selectedPageId, setSelectedPageIdState] = useState("");
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
  const [textPreferences, setTextPreferences] = useState(DEFAULT_TEXT_PREFERENCES);
  const [isPropertiesPanelOpen, setIsPropertiesPanelOpen] = useState(false);
  const [isDrawingPropertyPreviewing, setIsDrawingPropertyPreviewing] = useState(false);
  const [pendingImagePlacement, setPendingImagePlacement] =
    useState<PendingImagePlacement | null>(null);
  const [imageImportError, setImageImportError] = useState<string | null>(null);
  const [panOffset, setPanOffset] = useState<PanOffset>({ x: 0, y: 0 });
  const [livePanOffset, setLivePanOffset] = useState<PanOffset>(panOffset);
  const [searchPanOffset, setSearchPanOffset] = useState<PanOffset | null>(null);
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
  const [selectionFramePreview, setSelectionFramePreview] = useState<SelectionRect | null>(null);
  const [textResizeHandleGeometry, setTextResizeHandleGeometry] = useState<TextElement | null>(null);
  const [connectorEndpointPreview, setConnectorEndpointPreview] = useState<ConnectorElement | null>(null);
  const [isConnectorEndpointRetargeting, setIsConnectorEndpointRetargeting] = useState(false);
  const [connectorEndpointRetargetVisual, setConnectorEndpointRetargetVisual] = useState<ArrowAuthoringVisual | null>(null);
  const [connectorEndpointChooser, setConnectorEndpointChooser] = useState<ConnectorEndpointChooserState | null>(null);
  const [connectorBindingAnnouncement, setConnectorBindingAnnouncement] = useState("");
  const [keyboardArrowEndpointAccessId, setKeyboardArrowEndpointAccessId] = useState<string | null>(null);
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
  const selectionFrameVisualBoundsRef = useRef<SelectionRect | null>(null);
  const selectionTransformRef = useRef<SelectionTransformSession | null>(null);
  const resizeLayerSessionRef = useRef<ResizeLayerSession | null>(null);
  const textResizeHandleRef = useRef<HTMLButtonElement | null>(null);
  const textResizeSessionRef = useRef<TextResizeSession | null>(null);
  const cancelCanvasSelectionRef = useRef<() => void>(() => undefined);
  const cancelVisualDragRef = useRef<(updateState?: boolean) => void>(() => undefined);
  const cancelCapturedCanvasInteractionsRef = useRef<() => void>(() => undefined);
  const cancelCanvasInteractionTransitionRef = useRef<() => void>(() => undefined);
  const canvasSearchButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);
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
  const shapeTextEditSessionRef = useRef<{ elementId: string; session: ShapeTextEditSession } | null>(null);
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
  const isCanvasKeyboardActiveRef = useRef(isCanvasKeyboardActive);
  const drawingPreferencesRef = useRef(drawingPreferences);
  const textPreferencesRef = useRef(textPreferences);
  const isTemporaryHandActiveRef = useRef(false);
  const pendingImagePlacementRef = useRef<PendingImagePlacement | null>(null);
  const imagePickerRequestRef = useRef(0);
  const drawingPropertyPreviewRef = useRef<DrawingPropertyPreviewTransaction | null>(null);
  const authoringFocusReturnRafRef = useRef<number | null>(null);
  const previousCanvasAuthoringAvailableRef = useRef(false);
  const isCanvasAuthoringAvailableRef = useRef(false);
  const isWorkbenchOverlayOpenRef = useRef(false);
  const connectorEndpointChooserRef = useRef<ConnectorEndpointChooserState | null>(null);
  const connectorEndpointRetargetAnnouncementRef = useRef<string | null>(null);
  const connectorEndpointOriginFocusRef = useRef<HTMLButtonElement | null>(null);
  const connectorEndpointFocusReturnRafRef = useRef<number | null>(null);
  const suppressedConnectorStatusRef = useRef<Readonly<{
    pageId: string | null;
    states: ReadonlyMap<string, string>;
  }> | null>(null);
  const keyboardArrowCreationRef = useRef<() => boolean>(() => false);
  const keyboardShapeCreationRef = useRef<(tool: ShapeTool) => boolean>(() => false);
  const keyboardShapeAnnouncementSequenceRef = useRef(0);
  const pointerShapeAnnouncementSequenceRef = useRef(0);
  const keyboardArrowEndpointFocusRafRef = useRef<number | null>(null);

  const setSelectedPageId = useCallback((nextPageId: string) => {
    cancelCanvasInteractionTransitionRef.current();
    setSelectedPageIdState(nextPageId);
  }, []);

  useLayoutEffect(() => {
    const bounds = selectionFrameVisualBoundsRef.current;
    if (bounds) applySelectionFrameVisualBounds(bounds);
  }, [livePanOffset.x, livePanOffset.y]);

  dataRef.current = data;
  activeToolRef.current = activeTool;
  isToolLockedRef.current = isToolLocked;
  isCanvasKeyboardActiveRef.current = isCanvasKeyboardActive;
  drawingPreferencesRef.current = drawingPreferences;
  textPreferencesRef.current = textPreferences;
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
  connectorEndpointChooserRef.current = connectorEndpointChooser;

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
  useLayoutEffect(() => {
    const selectedId = selectedBlockIds.length === 1 ? selectedBlockIds[0] : null;
    const selected = selectedId
      ? visibleCanvasElements.find((element): element is TextElement =>
        element.id === selectedId && element.type === "text" && !element.locked,
      )
      : null;
    const sourceElement = selected ? blockElementsRef.current.get(selected.id) : null;
    const nextGeometry = selected
      ? sourceElement
        ? getRenderedTextResizeBlock(selected, sourceElement)
        : selected
      : null;
    setTextResizeHandleGeometry((current) => {
      if (
        current &&
        nextGeometry &&
        current.id === nextGeometry.id &&
        current.x === nextGeometry.x &&
        current.y === nextGeometry.y &&
        current.width === nextGeometry.width &&
        current.height === nextGeometry.height &&
        current.rotation === nextGeometry.rotation
      ) {
        return current;
      }
      return nextGeometry;
    });
  }, [selectedBlockIds, visibleCanvasElements]);
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
        isBackgroundModeDisabled: !selectedDrawingElements.some(
          (element) => isTextElement(element) && !element.locked,
        ),
        supports: (property: DrawingProperty) => values[property].kind !== "unavailable",
        values,
      };
    }
    if (activeTool === "text") {
      return {
        contextLabel: "text defaults",
        isBackgroundModeDisabled: false,
        isSelection: false,
        strokeWidthPresets: [] as const,
        supports: (property: DrawingProperty) => property === "backgroundMode",
        values: drawingPropertiesFromTextPreferences(textPreferences),
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
        isBackgroundModeDisabled: true,
        supports: (property: DrawingProperty) => isPropertySupportedByTool(activeTool, property),
        values: drawingPropertiesFromPreference(preference),
      };
  }, [activeTool, drawingPreferences, selectedDrawingElements, textPreferences]);
  const isTextFormattingVisible = Boolean(
    activeTextEditor && !activeTextEditor.isDestroyed
  ) || selectedDrawingElements.some((element) => element.type === "text");
  const isShapeTextEditing = Boolean(
    editingBlockId && data.elements.some((element) => element.id === editingBlockId && element.type === "shape"),
  );
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
  const isCanvasElementSearchActive = isSearchOpen && Boolean(searchQuery.trim());
  const canvasSearchTextIndex = useMemo(
    () => createCanvasSearchTextIndex(visibleBlocks, isCanvasElementSearchActive),
    [isCanvasElementSearchActive, visibleBlocks],
  );
  const elementSearchResult = useMemo(
    () => isCanvasElementSearchActive
      ? findCanvasTextSearchResult(visibleBlocks, searchQuery, canvasSearchTextIndex)
      : { matches: [], isTruncated: false },
    [canvasSearchTextIndex, isCanvasElementSearchActive, searchQuery, visibleBlocks],
  );
  const titleSearchResult = useMemo(() => {
    if (!searchQuery.trim() || !selectedPage) {
      return { matches: [] as CanvasSearchMatch[], isTruncated: false };
    }
    const result = findTextSearchRanges(selectedPage.title, searchQuery, MAX_CANVAS_SEARCH_MATCHES);
    return {
      matches: result.ranges.map((range) => ({ ...range, kind: "title" as const })),
      isTruncated: result.isTruncated,
    };
  }, [searchQuery, selectedPage]);
  const searchMatches = useMemo<CanvasSearchMatch[]>(
    () => [
      ...titleSearchResult.matches,
      ...elementSearchResult.matches.map((match) => ({
        ...match,
        kind: "element" as const,
      })),
    ].slice(0, MAX_CANVAS_SEARCH_MATCHES),
    [elementSearchResult.matches, titleSearchResult.matches],
  );
  const isSearchTruncated = titleSearchResult.isTruncated
    || elementSearchResult.isTruncated
    || titleSearchResult.matches.length + elementSearchResult.matches.length > MAX_CANVAS_SEARCH_MATCHES;
  const activeCanvasSearchMatch = searchMatches[activeSearchIndex] ?? null;
  const activeSearchMatch =
    activeCanvasSearchMatch?.kind === "element" ? activeCanvasSearchMatch : null;
  const titleSearchHighlights = useMemo(
    () => searchMatches.flatMap((match, index) => match.kind === "title" ? [{
      end: match.end,
      isActive: index === activeSearchIndex,
      start: match.start,
    }] : []),
    [activeSearchIndex, searchMatches],
  );
  const searchMatchesByElementId = useMemo(() => {
    const matchesByElementId = new Map<string, SearchMatch[]>();
    for (const match of searchMatches) {
      if (match.kind !== "element") continue;
      const matches = matchesByElementId.get(match.elementId);
      if (matches) matches.push(match);
      else matchesByElementId.set(match.elementId, [match]);
    }
    return matchesByElementId;
  }, [searchMatches]);
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
  const activeKeyboardShapeLabel = !isCanvasAuthoringAvailable || isSearchOpen
    ? null
    : activeTool === "rectangle"
    ? "Rectangle"
    : activeTool === "ellipse"
      ? "Ellipse"
      : activeTool === "diamond"
        ? "Diamond"
        : null;
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
  useEffect(() => setConnectorEndpointRetargetVisual(null), [activeTool, selectedPageId]);
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
  const suppressedConnectorCandidates = useMemo(() => {
    let arrowOrdinal = 0;
    let lineOrdinal = 0;
    return visibleCanvasElements.flatMap((element) => {
      if (element.type !== "connector") return [];
      const isArrow = element.style.endArrowhead === "arrow";
      const ordinal = isArrow ? ++arrowOrdinal : ++lineOrdinal;
      if (!isCanonicalConnectorRouteSuppressed(element, visibleCanvasElementsById)) return [];
      const semanticLabel = element.semantic?.label?.trim();
      return [{
        connector: element,
        label: semanticLabel || `${isArrow ? "Arrow" : "Line"} connector ${ordinal}`,
      }];
    });
  }, [visibleCanvasElements, visibleCanvasElementsById]);
  const suppressedConnectorControls = useMemo(() => (
    suppressedConnectorCandidates.flatMap(({ connector, label }) => {
      const placement = getSuppressedConnectorControlPlacement(
        connector,
        visibleCanvasElementsById,
        canvasSize,
        livePanOffset,
        zoomLevel,
        isSearchOpen,
      );
      if (!placement) return [];
      return [{ connector, label, placement }];
    })
  ), [
    canvasSize,
    isSearchOpen,
    livePanOffset,
    suppressedConnectorCandidates,
    visibleCanvasElementsById,
    zoomLevel,
  ]);
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
  useEffect(() => {
    const currentStates = new Map(
      suppressedConnectorCandidates.map(({ connector, label }) => [connector.id, label]),
    );
    const previous = suppressedConnectorStatusRef.current;
    const currentElementIds = new Set(visibleCanvasElements.map((element) => element.id));
    const announcements: string[] = [];

    if (!previous || previous.pageId !== selectedPageId) {
      for (const label of currentStates.values()) {
        announcements.push(`${label} hidden because its bound objects overlap. Use its visible marker to manage endpoints.`);
      }
    } else {
      for (const [connectorId, label] of currentStates) {
        if (!previous.states.has(connectorId)) {
          announcements.push(`${label} hidden because its bound objects overlap. Use its visible marker to manage endpoints.`);
        }
      }
      for (const [connectorId, label] of previous.states) {
        if (!currentStates.has(connectorId) && currentElementIds.has(connectorId)) {
          announcements.push(`${label} restored. Its route is visible again.`);
        }
      }
    }

    suppressedConnectorStatusRef.current = { pageId: selectedPageId, states: currentStates };
    if (announcements.length > 0) setConnectorBindingAnnouncement(announcements.join(" "));
  }, [selectedPageId, suppressedConnectorCandidates, visibleCanvasElements]);
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
      if (connectorEndpointFocusReturnRafRef.current !== null) {
        window.cancelAnimationFrame(connectorEndpointFocusReturnRafRef.current);
      }
      if (keyboardArrowEndpointFocusRafRef.current !== null) {
        window.cancelAnimationFrame(keyboardArrowEndpointFocusRafRef.current);
      }

      cancelCanvasSelectionSession();
      cancelSelectionFrameInteraction(false);
      cancelVisualDragRef.current(false);

      stopAssistantRecordingStream();
    };
  }, []);

  useEffect(() => {
    function handleWindowBlur() {
      cancelCapturedCanvasInteractionsRef.current();
    }

    window.addEventListener("blur", handleWindowBlur);

    return () => window.removeEventListener("blur", handleWindowBlur);
  }, []);

  useEffect(() => {
    cancelCanvasInteractionTransitionRef.current();
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
        setIsToolLocked(getDrawingToolLockPreference(savedSessionState));
        setDrawingPreferences(normalizeDrawingPreferences(savedSessionState?.drawingPreferences));
        setTextPreferences(normalizeTextPreferences(savedSessionState?.textPreferences));
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
          setIsToolLocked(getDrawingToolLockPreference(legacy.data.sessionState));
          setDrawingPreferences(normalizeDrawingPreferences(legacy.data.sessionState?.drawingPreferences));
          setTextPreferences(normalizeTextPreferences(legacy.data.sessionState?.textPreferences));
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
    setSearchPanOffset(null);
  }, [searchQuery, selectedPageId]);

  useEffect(() => {
    setSearchPanOffset(null);
  }, [panOffset.x, panOffset.y, zoomLevel]);

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
    textPreferences,
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
    return blocks.map((block) => ({
      ...block,
      ...(isTextElement(block)
        ? { richContent: cloneRichContent(block.richContent) }
        : block.type === "shape" && block.text
          ? { text: cloneRichTextValue(block.text) }
          : {}),
    }));
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
        : block.type === "shape" && block.text
          ? { text: cloneRichTextValue(block.text) }
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
      textPreferences: textPreferencesRef.current,
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
        : block.type === "shape" && block.text
          ? { text: cloneRichTextValue(block.text) }
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

  function isLiveConnectorBindingPersistable(
    candidate: ConnectorElement,
    currentElements: readonly CanvasElement[] = dataRef.current.elements,
  ) {
    return isConnectorBindingPersistable(candidate, indexCanvasElements(currentElements));
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
    if (update.property === "backgroundMode") {
      const hasUnlockedSelectedText = [...selectedIds].some((id) =>
        dataRef.current.elements.some(
          (element) => element.id === id && isTextElement(element) && !element.locked,
        ),
      );
      if (hasUnlockedSelectedText) {
        setTextPreferences({ backgroundMode: update.value });
      }
    }
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
    if (tool === "text" && update.property === "backgroundMode") {
      setTextPreferences({ backgroundMode: update.value });
      return;
    }
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
    const changedShapeContainedText = hasShapeContainedTextDifference(currentData.elements, snapshot);

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
    if (changedShapeContainedText) {
      setConnectorBindingAnnouncement(`${direction === "undo" ? "Undid" : "Redid"} a shape-contained text change.`);
    }
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
      .filter((block): block is CopyableElement => block.type === "text" || block.type === "image" || block.type === "shape")
      .map((block) => {
        const { id: _id, pageId: _pageId, x, y, ...blockFields } = block;
        return {
          ...blockFields,
          ...(isTextElement(block) && block.richContent
            ? { richContent: cloneRichContent(block.richContent) }
            : block.type === "shape" && block.text
              ? { text: cloneRichTextValue(block.text) }
            : {}),
          offsetX: x - minX,
          offsetY: y - minY,
        } as CopiedBlock;
      });
    copiedContentKindRef.current = "blocks";
    const copiedShapeTextCount = blocksToCopy.filter(hasShapeContainedText).length;
    if (copiedShapeTextCount > 0) {
      setConnectorBindingAnnouncement(`Copied ${copiedShapeTextCount === 1 ? "one shape" : `${copiedShapeTextCount} shapes`} with contained text.`);
    }

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
            block.pageId === page.id && (block.type === "text" || block.type === "image" || block.type === "shape"),
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
    const deletedShapeTextCount = dataRef.current.elements.filter(
      (element) => blockIdsToDelete.has(element.id) && hasShapeContainedText(element),
    ).length;
    const detachedBlocks = detachConnectorEndpointsForDeletedTargets(
      dataRef.current.elements,
      blockIdsToDelete,
    );
    if (!detachedBlocks) {
      setConnectorBindingAnnouncement("Could not delete because a connector endpoint has no safe in-canvas detach position.");
      return false;
    }

    setBlocksWithHistory(() => detachedBlocks.filter((block) => !blockIdsToDelete.has(block.id)));
    setSelectedBlockIds((currentBlockIds) =>
      currentBlockIds.filter((blockId) => !blockIdsToDelete.has(blockId)),
    );
    setEditingBlockId((currentBlockId) =>
      currentBlockId && blockIdsToDelete.has(currentBlockId)
        ? null
        : currentBlockId,
    );
    if (deletedShapeTextCount > 0) {
      setConnectorBindingAnnouncement(`Deleted ${deletedShapeTextCount === 1 ? "one shape" : `${deletedShapeTextCount} shapes`} with contained text. Undo is available.`);
    }
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
      if (guardCanvasSearchPanelKeyboardEvent(event)) return;
      // Opening the endpoint chooser is a React state transition, so the portal
      // and its focus target may not exist for the next key in the same input
      // burst. The ref is set synchronously by the opener and remains the
      // authoritative modal state until close, rather than relying on the
      // current active element to suppress canvas shortcuts.
      if (connectorEndpointChooserRef.current !== null) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeConnectorEndpointChooser();
        }
        return;
      }
      if (event.target instanceof Element && event.target.closest(".connector-endpoint-chooser")) {
        return;
      }
      if (activeWorkbenchOverlay) {
        return;
      }

      const shapeTextSession = shapeTextEditSessionRef.current;
      const isShapeTextToolbarTarget = event.target instanceof Element
        && event.target.closest(".global-text-toolbar") !== null;
      if (shapeTextSession && isShapeTextToolbarTarget) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          shapeTextEditSessionRef.current = null;
          shapeTextSession.session.cancel();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          shapeTextEditSessionRef.current = null;
          shapeTextSession.session.commit();
          return;
        }
      }

      if (event.key === "Escape") {
        cancelCapturedCanvasInteractionsRef.current();
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
        canvasRef.current?.setAttribute("data-temporary-hand", "true");
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

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f" &&
        !isCanvasSearchInteractionBlocked() &&
        !isTextEntryTarget(event.target) &&
        !isTextEntryTarget(document.activeElement)
      ) {
        event.preventDefault();
        focusCanvasSearch(
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : event.target instanceof HTMLElement
              ? event.target
              : null,
        );
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

      if (
        event.key === "Enter"
        && event.target === canvasRef.current
        && document.activeElement === canvasRef.current
        && (
          activeToolRef.current === "rectangle"
          || activeToolRef.current === "ellipse"
          || activeToolRef.current === "diamond"
        )
        && isCanvasAuthoringAvailableRef.current
        && connectorEndpointChooserRef.current === null
        && !currentEditingBlockId
        && !event.isComposing
        && !event.repeat
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
      ) {
        event.preventDefault();
        keyboardShapeCreationRef.current(activeToolRef.current);
        return;
      }

      if (
        event.key === "Enter"
        && event.target === canvasRef.current
        && document.activeElement === canvasRef.current
        && activeToolRef.current === "arrow"
        && isCanvasAuthoringAvailableRef.current
        && connectorEndpointChooserRef.current === null
        && !currentEditingBlockId
        && !event.isComposing
        && !event.repeat
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
      ) {
        event.preventDefault();
        keyboardArrowCreationRef.current();
        return;
      }

      const hasToolShortcutContext = hasCanvasToolShortcutContext(event, {
        activeElement: document.activeElement,
        canvasElement: canvasRef.current,
        hasCanvasKeyboardOwnership: isCanvasKeyboardActiveRef.current,
        isCanvasAuthoringAvailable: isCanvasAuthoringAvailableRef.current,
        isModalOrOverlayOpen: Boolean(activeWorkbenchOverlay),
        isTextEditing: Boolean(currentEditingBlockId),
        target: event.target,
      });
      const shortcutTool = drawingToolForShortcut(event, hasToolShortcutContext);
      if (
        shortcutTool
      ) {
        event.preventDefault();
        isCanvasKeyboardActiveRef.current = true;
        setIsCanvasKeyboardActive(true);
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
        canvasRef.current?.removeAttribute("data-temporary-hand");
        return;
      }
      if (isCanvasSearchPanelTarget(event.target)) return;
    }

    function clearTemporaryHandForWindowBlur() {
      isTemporaryHandActiveRef.current = false;
      canvasRef.current?.removeAttribute("data-temporary-hand");
    }

    document.addEventListener("keydown", handleKeyboard);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearTemporaryHandForWindowBlur);

    return () => {
      document.removeEventListener("keydown", handleKeyboard);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearTemporaryHandForWindowBlur);
      isTemporaryHandActiveRef.current = false;
      canvasRef.current?.removeAttribute("data-temporary-hand");
    };
  }, [
    activeNarrowOverlay,
    activeTextEditor,
    activeWorkbenchOverlay,
    connectorEndpointChooser,
    deleteBlocks,
    editingFolderId,
    editingPageId,
    insertionPoint,
    isCanvasKeyboardActive,
    isEditingHeaderTitle,
    isAIProvidersOpen,
    isStarterDismissed,
    isWorkspaceEmpty,
    selectAllVisibleBlocks,
    selectedBlockIds,
    selectedPageId,
    visibleBlocks,
  ]);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (isCanvasSearchPanelTarget(event.target)) return;
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

    canvasContentElement.style.transform = `translate3d(${nextPanOffset.x}px, ${nextPanOffset.y}px, 0) scale(${zoomLevelRef.current})`;
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

  function isCanvasSearchInteractionBlocked() {
    return Boolean(
      editingBlockIdRef.current
      || activeTextEditor && !activeTextEditor.isDestroyed
      || shapeTextEditSessionRef.current
      || isEditingHeaderTitle
      || editingFolderId
      || editingPageId
      || connectorEndpointChooser
      || activeNarrowOverlay
      || isAIProvidersOpen
      || document.querySelector(
        '.slash-command-popup, .connector-endpoint-chooser, [role="dialog"], [aria-modal="true"]',
      )
    );
  }

  function focusCanvasSearch(trigger?: HTMLElement | null) {
    if (isCanvasSearchInteractionBlocked()) return;
    cancelCapturedCanvasInteractionsRef.current();
    searchReturnFocusRef.current = trigger?.isConnected && trigger !== document.body
      ? trigger
      : canvasRef.current;
    setIsSearchOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }

  function closeCanvasSearch({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    const returnFocusTarget = searchReturnFocusRef.current;
    searchReturnFocusRef.current = null;
    setIsSearchOpen(false);
    setSearchQuery("");
    setSearchPanOffset(null);
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      const fallbackTarget = canvasSearchButtonRef.current?.isConnected
        && !canvasSearchButtonRef.current.disabled
        ? canvasSearchButtonRef.current
        : canvasRef.current;
      const focusTarget = returnFocusTarget?.isConnected
        && !(returnFocusTarget instanceof HTMLButtonElement && returnFocusTarget.disabled)
        ? returnFocusTarget
        : fallbackTarget;
      focusTarget?.focus({ preventScroll: true });
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
      backgroundMode: textPreferencesRef.current.backgroundMode,
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

    if (!deleteBlocks([blockId])) {
      throw new Error("Block could not be deleted because a connector endpoint has no safe in-canvas detach position.");
    }

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
    finishActiveShapeTextEdit();

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
        backgroundMode: textPreferencesRef.current.backgroundMode,
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
    cancelCanvasInteractionTransitionRef.current();
    finishActiveShapeTextEdit();
    isCanvasKeyboardActiveRef.current = true;
    setIsCanvasKeyboardActive(true);
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

  const updateShapeText = useCallback((elementId: string, text: RichTextValue | undefined) => {
    setBlocksWithHistory((elements) => elements.map((element) => {
      if (element.id !== elementId || element.type !== "shape") return element;
      if (JSON.stringify(element.text) === JSON.stringify(text)) return element;
      if (!text) {
        const { text: _text, ...shapeWithoutText } = element;
        return { ...shapeWithoutText, updatedAt: Date.now() };
      }
      return { ...element, text: cloneRichTextValue(text), updatedAt: Date.now() };
    }));
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
    const currentSelectedIds = selectedBlockIdsRef.current;
    const selectedElements = currentSelectedIds
      .map((selectedId) => dataRef.current.elements.find((element) => element.id === selectedId))
      .filter((element): element is CanvasElement => Boolean(element));
    const shouldMoveAllSelectedText =
      currentSelectedIds.includes(elementId) &&
      selectedElements.length > 1 &&
      selectedElements.length === currentSelectedIds.length &&
      selectedElements.every((element) => element.type === "text");
    const elementIds = new Set(shouldMoveAllSelectedText ? currentSelectedIds : [elementId]);
    setBlocksWithHistory((currentElements) =>
      translateSelection(currentElements, elementIds, delta),
    );
    setActiveMode("selected");
  }, []);

  const eraseCanvasElements = useCallback((elementIds: readonly string[]) => {
    const ids = new Set(elementIds);
    if (ids.size === 0) return;
    const detachedElements = detachConnectorEndpointsForDeletedTargets(dataRef.current.elements, ids);
    if (!detachedElements) {
      setConnectorBindingAnnouncement("Could not erase because a connector endpoint has no safe in-canvas detach position.");
      return;
    }
    setBlocksWithHistory(() =>
      detachedElements.filter((element) => element.locked || !ids.has(element.id)),
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
        const resizeSession = resizeLayerSessionRef.current;

        const isResizeSource = resizeSession?.items.some((item) => item.element.id === blockId);
        if (dragSession?.blockIds.includes(blockId) || isResizeSource) {
          element.classList.add("is-drag-source-hidden");

          if (dragSession && !dragSession.sourceElements.includes(element)) {
            dragSession.sourceElements = [
              ...dragSession.sourceElements.filter(
                (sourceElement) => sourceElement.isConnected,
              ),
              element,
            ];
          }
          if (resizeSession && !resizeSession.sourceElements.includes(element)) {
            resizeSession.sourceElements = [
              ...resizeSession.sourceElements.filter((sourceElement) => sourceElement.isConnected),
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
    if (session.autoPanRafId !== null) {
      window.cancelAnimationFrame(session.autoPanRafId);
      session.autoPanRafId = null;
    }

    for (const sourceElement of session.sourceElements) {
      sourceElement.classList.remove("is-drag-source-hidden");
    }
    for (const sourceElement of session.connectorSourceElements) {
      sourceElement.classList.remove("is-drag-source-hidden");
    }
    cleanupConnectorPreviewLayer(session.connectorPreviewElements);

    session.overlayElement.remove();
    document.body.classList.remove("is-interacting");
  }

  function getBoundConnectorIdsForTargets(
    elements: readonly CanvasElement[],
    targetIds: ReadonlySet<string>,
  ) {
    return new Set(elements.flatMap((element) => {
      if (element.type !== "connector") return [];
      return [element.start, element.end].some((endpoint) =>
        endpoint.kind === "element" && targetIds.has(endpoint.targetElementId),
      ) ? [element.id] : [];
    }));
  }

  function indexCanvasElements(elements: readonly CanvasElement[]) {
    return Object.fromEntries(elements.map((element) => [element.id, element]));
  }

  function renderTransientConnectorPreviews(
    elementsById: Readonly<Record<string, CanvasElement>>,
    connectorIds: ReadonlySet<string>,
    previewLayer: ConnectorPreviewLayer,
  ) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const zoom = zoomLevelRef.current;
    const pan = panOffsetRef.current;
    const canvasBounds = canvas.getBoundingClientRect();
    const records = connectorIds.size <= 32 ? new Map<string, ConnectorPreviewRecord>() : null;
    const commands: ConnectorPreviewCommand[] = [];
    let sceneIndex = 0;
    forEachAffectedConnectorGeometry(elementsById, connectorIds, ({ connector, points }) => {
      if (!points) return;
      const start = { x: pan.x + points.start.x * zoom, y: pan.y + points.start.y * zoom };
      const end = { x: pan.x + points.end.x * zoom, y: pan.y + points.end.y * zoom };
      if (records) {
        const padding = Math.max(8, connector.style.strokeWidth * 2) * zoom;
        records.set(connector.id, {
          bounds: {
            height: Math.max(1, Math.abs(end.y - start.y) + padding * 2),
            left: Math.min(start.x, end.x) - padding,
            top: Math.min(start.y, end.y) - padding,
            width: Math.max(1, Math.abs(end.x - start.x) + padding * 2),
          },
          end: points.end,
          start: points.start,
        });
      }
      commands.push({
        end,
        endArrowhead: connector.style.endArrowhead,
        opacity: connector.opacity,
        roughness: connector.style.roughness * zoom,
        sceneIndex: sceneIndex++,
        seed: connector.style.seed,
        start,
        stroke: resolvedPreviewColor(connector.style.strokeColor, isDarkMode),
        strokeStyle: connector.style.strokeStyle,
        strokeWidth: connector.style.strokeWidth * zoom,
        visualScale: zoom,
        zIndex: connector.zIndex,
      });
    });
    if (commands.length === 0) {
      cleanupConnectorPreviewLayer(previewLayer);
      return;
    }
    if (!previewLayer.renderer) {
      const preview = document.createElement("canvas") as ConnectorPreviewElement;
      preview.className = "connector-transform-preview connector-transform-preview-layer";
      preview.setAttribute("aria-hidden", "true");
      preview.style.height = "100%";
      preview.style.inset = "0";
      preview.style.pointerEvents = "none";
      preview.style.position = "absolute";
      preview.style.width = "100%";
      preview.style.zIndex = "18";
      canvas.append(preview);
      previewLayer.renderer = new ConnectorPreviewCanvas(preview);
    }
    const preview = previewLayer.renderer.element as ConnectorPreviewElement;
    preview.__connectorPreviewRecords = records ?? undefined;
    preview.dataset.connectorCount = `${commands.length}`;
    previewLayer.renderer.render({
      commands: commands.sort(compareConnectorPreviewStack),
      devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
      height: canvasBounds.height,
      width: canvasBounds.width,
    });
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
    const previewElements = translateSelection(
      session.selectedElements,
      session.selectedIds,
      getDragCommitOffset(session),
    );
    const previewElementsById = overlayTransformedElements(session.baseElementsById, previewElements);
    renderTransientConnectorPreviews(
      previewElementsById,
      session.affectedConnectorIds,
      session.connectorPreviewElements,
    );
    const previewBounds = getPreviewSelectionBounds(
      previewElements,
      session.selectedIds,
      previewElementsById,
    );
    if (previewBounds) previewSelectionFrameVisualBounds(previewBounds);
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

  function scheduleDragFrame(session: DragLayerSession) {
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

      if (panDelta.x !== 0 || panDelta.y !== 0) {
        scheduleCanvasContentTransform({
          x: panOffsetRef.current.x + panDelta.x,
          y: panOffsetRef.current.y + panDelta.y,
        });
      }
      updateDragLayerVisual(session);
      if (panDelta.x !== 0 || panDelta.y !== 0) scheduleDragFrame(session);
    });
  }

  function flushDragFrame(session: DragLayerSession) {
    if (session.autoPanRafId !== null) {
      window.cancelAnimationFrame(session.autoPanRafId);
      session.autoPanRafId = null;
    }
    updateDragLayerVisual(session);
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
      const affectedConnectorIds = getBoundConnectorIdsForTargets(
        dataRef.current.elements,
        new Set(requestedBlockIds),
      );
      const baseElementsById = indexCanvasElements(dataRef.current.elements);
      const selectedIds = new Set(selectedBlockIds);
      const selectedElements = selectedBlockIds.flatMap((id) => {
        const element = baseElementsById[id];
        return element ? [element] : [];
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

      for (const { blockId, element } of sourceEntries) {
        if (affectedConnectorIds.has(blockId)) continue;
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
        affectedConnectorIds,
        autoPanRafId: null,
        baseElementsById,
        blockIds: sourceEntries.map((entry) => entry.blockId),
        currentClientX: clientX,
        currentClientY: clientY,
        groupElement,
        overlayElement,
        sourceElements: sourceEntries.map((entry) => entry.element),
        connectorPreviewElements: createConnectorPreviewLayer(),
        connectorSourceElements: Array.from(affectedConnectorIds).flatMap((id) => {
          const element = blockElementsRef.current.get(id);
          return element ? [element] : [];
        }),
        selectedBlockIds,
        selectedElements,
        selectedIds,
        startClientX: clientX,
        startClientY: clientY,
        startPanOffset: { ...panOffsetRef.current },
        zoomLevel: currentZoomLevel,
      };

      dragLayerSessionRef.current = dragSession;
      document.body.classList.add("is-interacting");

      for (const sourceElement of dragSession.sourceElements) {
        sourceElement.classList.add("is-drag-source-hidden");
      }
      for (const sourceElement of dragSession.connectorSourceElements) {
        sourceElement.classList.add("is-drag-source-hidden");
      }
      renderTransientConnectorPreviews(
        dragSession.baseElementsById,
        affectedConnectorIds,
        dragSession.connectorPreviewElements,
      );

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
    scheduleDragFrame(dragSession);
  }, []);

  const endVisualDrag = useCallback((clientX: number, clientY: number) => {
    const dragSession = dragLayerSessionRef.current;

    if (!dragSession) {
      return;
    }

    dragSession.currentClientX = clientX;
    dragSession.currentClientY = clientY;
    flushDragFrame(dragSession);

    const offset = getDragCommitOffset(dragSession);
    const movedEnough = Math.abs(offset.x) > 0.01 || Math.abs(offset.y) > 0.01;
    const blockIdsToMove = new Set(dragSession.blockIds);

    cleanupDragLayerSession(dragSession);
    dragLayerSessionRef.current = null;
    setPanOffset(panOffsetRef.current);
    clearSelectionFrameVisualBounds();

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
      const selectedIds = new Set(selectedBlockIdsRef.current);
      const restoredBounds = getPreviewSelectionBounds(dataRef.current.elements, selectedIds);
      clearSelectionFrameVisualBounds(restoredBounds ?? undefined);
      return;
    }

    cleanupDragLayerSession(dragSession);
    dragLayerSessionRef.current = null;
    if (updateState) {
      scheduleCanvasContentTransform({ ...dragSession.startPanOffset });
    }
    const selectedIds = new Set(dragSession.selectedBlockIds);
    const restoredBounds = getPreviewSelectionBounds(dataRef.current.elements, selectedIds);
    clearSelectionFrameVisualBounds(restoredBounds ?? undefined);
    if (updateState) {
      setActiveMode("selected");
    }
  }, []);
  cancelVisualDragRef.current = cancelVisualDrag;

  function cleanupResizeLayerSession(session: ResizeLayerSession) {
    for (const sourceElement of session.sourceElements) {
      sourceElement.classList.remove("is-drag-source-hidden");
    }
    for (const sourceElement of session.connectorSourceElements) {
      sourceElement.classList.remove("is-drag-source-hidden");
    }
    cleanupConnectorPreviewLayer(session.connectorPreviewElements);
    session.overlayElement.remove();
    document.body.classList.remove("is-interacting");
  }

  function resolveTextResizeWidth(width: number) {
    const finiteWidth = Number.isFinite(width) ? width : MIN_BLOCK_WIDTH;
    const resolvedWidth = Math.max(MIN_BLOCK_WIDTH, finiteWidth);
    return isSnapToGridEnabledRef.current
      ? Math.max(MIN_BLOCK_WIDTH, snapValue(resolvedWidth))
      : resolvedWidth;
  }

  function measureTextReflowSize(
    block: TextElement,
    requestedWidth: number,
    sourceElement = blockElementsRef.current.get(block.id),
  ): TextSelectionSize {
    const width = resolveTextResizeWidth(requestedWidth);
    if (!sourceElement) {
      return { height: Math.max(MIN_BLOCK_HEIGHT, block.height), width };
    }

    const clone = sourceElement.cloneNode(true) as HTMLElement;
    clone.removeAttribute("data-block-id");
    clone.setAttribute("aria-hidden", "true");
    clone.style.height = "";
    clone.style.left = "-100000px";
    clone.style.pointerEvents = "none";
    clone.style.position = "fixed";
    clone.style.top = "0";
    clone.style.transform = "none";
    clone.style.visibility = "hidden";
    clone.style.width = `${width}px`;
    const heightMeasurer = clone.querySelector<HTMLElement>(".text-block-height-measurer");
    if (heightMeasurer) heightMeasurer.style.width = `${width}px`;
    document.body.append(clone);
    const measuredHeight = heightMeasurer?.scrollHeight ?? clone.scrollHeight;
    clone.remove();
    return {
      height: Number.isFinite(measuredHeight)
        ? Math.max(MIN_BLOCK_HEIGHT, measuredHeight + TEXT_BLOCK_HEADER_HEIGHT + TEXT_BLOCK_HEIGHT_BUFFER)
        : Math.max(MIN_BLOCK_HEIGHT, block.height),
      width,
    };
  }

  function getTextSelectionSizes(
    elements: readonly CanvasElement[],
    selectedIds: ReadonlySet<string>,
    scale: number,
    sourceElementsById: ReadonlyMap<string, HTMLElement> = new Map(),
  ) {
    const sizes = new Map<string, TextSelectionSize>();
    const factor = Number.isFinite(scale) ? Math.max(0.01, scale) : 0.01;
    for (const element of elements) {
      if (!selectedIds.has(element.id) || element.locked || element.type !== "text") continue;
      const previewClone = sourceElementsById.get(element.id);
      if (previewClone) previewClone.style.height = "";
      const sourceElement = previewClone ?? blockElementsRef.current.get(element.id);
      sizes.set(
        element.id,
        measureTextReflowSize(element, element.width * factor, sourceElement),
      );
    }
    return sizes;
  }

  function getEastResizedTextPreview(block: TextElement, size: TextSelectionSize): TextElement {
    const angle = (block.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const originalCenter = { x: block.x + block.width / 2, y: block.y + block.height / 2 };
    const fixedWestMidpoint = {
      x: originalCenter.x - block.width / 2 * cos,
      y: originalCenter.y - block.width / 2 * sin,
    };
    const nextCenter = {
      x: fixedWestMidpoint.x + size.width / 2 * cos,
      y: fixedWestMidpoint.y + size.width / 2 * sin,
    };
    return {
      ...block,
      height: size.height,
      isWidthManuallyResized: true,
      width: size.width,
      x: nextCenter.x - size.width / 2,
      y: nextCenter.y - size.height / 2,
    };
  }

  function getTextEastResizeHandlePoint(block: TextElement) {
    const angle = (block.rotation * Math.PI) / 180;
    return {
      x: block.x + block.width / 2 + block.width / 2 * Math.cos(angle),
      y: block.y + block.height / 2 + block.width / 2 * Math.sin(angle),
    };
  }

  function getTextResizeCursorClass(rotation: number) {
    const normalized = ((rotation % 180) + 180) % 180;
    if (normalized < 22.5 || normalized >= 157.5) return "is-ew-resize";
    if (normalized < 67.5) return "is-nwse-resize";
    if (normalized < 112.5) return "is-ns-resize";
    return "is-nesw-resize";
  }

  function positionTextResizeHandle(handleElement: HTMLButtonElement | null, block: TextElement) {
    if (!handleElement) return;
    const point = getTextEastResizeHandlePoint(block);
    const zoom = zoomLevelRef.current;
    const pan = panOffsetRef.current;
    handleElement.style.left = `${pan.x + point.x * zoom - 22}px`;
    handleElement.style.top = `${pan.y + point.y * zoom - 22}px`;
  }

  function getRenderedTextResizeBlock(block: TextElement, sourceElement: HTMLElement): TextElement {
    const fromStyle = (property: "height" | "left" | "top" | "width", fallback: number) => {
      const value = Number.parseFloat(sourceElement.style[property]);
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      ...block,
      height: fromStyle("height", block.height),
      width: fromStyle("width", block.width),
      x: fromStyle("left", block.x),
      y: fromStyle("top", block.y),
    };
  }

  function startTextResizePreview(block: TextElement): boolean {
    if (textResizeSessionRef.current) return textResizeSessionRef.current.block.id === block.id;
    const sourceElement = blockElementsRef.current.get(block.id);
    if (!sourceElement) return false;
    const affectedConnectorIds = getBoundConnectorIdsForTargets(
      dataRef.current.elements,
      new Set([block.id]),
    );
    const baseElementsById = indexCanvasElements(dataRef.current.elements);
    const handleElement = textResizeHandleRef.current;
    const session: TextResizeSession = {
      affectedConnectorIds,
      baseElementsById,
      block: getRenderedTextResizeBlock(block, sourceElement),
      connectorPreviewElements: createConnectorPreviewLayer(),
      connectorSourceElements: Array.from(affectedConnectorIds).flatMap((id) => {
        const element = blockElementsRef.current.get(id);
        return element ? [element] : [];
      }),
      handleElement,
      originalHeight: sourceElement.style.height,
      originalHandleLeft: handleElement?.style.left ?? "",
      originalHandleTop: handleElement?.style.top ?? "",
      originalLeft: sourceElement.style.left,
      originalTop: sourceElement.style.top,
      originalWidth: sourceElement.style.width,
      sourceElement,
    };
    textResizeSessionRef.current = session;
    sourceElement.classList.add("is-resizing");
    for (const connectorElement of session.connectorSourceElements) {
      connectorElement.classList.add("is-drag-source-hidden");
    }
    document.body.classList.add("is-interacting");
    renderTransientConnectorPreviews(baseElementsById, affectedConnectorIds, session.connectorPreviewElements);
    return true;
  }

  function updateTextResizePreview(
    session: TextResizeSession,
    startClientX: number,
    startClientY: number,
    clientX: number,
    clientY: number,
  ) {
    const angle = (session.block.rotation * Math.PI) / 180;
    const projectedDelta = (
      (clientX - startClientX) * Math.cos(angle) +
      (clientY - startClientY) * Math.sin(angle)
    ) / zoomLevelRef.current;
    const size = measureTextReflowSize(
      session.block,
      session.block.width + projectedDelta,
      session.sourceElement,
    );
    const preview = getEastResizedTextPreview(session.block, size);
    session.sourceElement.style.left = `${preview.x}px`;
    session.sourceElement.style.top = `${preview.y}px`;
    session.sourceElement.style.width = `${preview.width}px`;
    session.sourceElement.style.height = `${preview.height}px`;
    positionTextResizeHandle(session.handleElement, preview);
    const previewElementsById = overlayTransformedElements(session.baseElementsById, [preview]);
    renderTransientConnectorPreviews(
      previewElementsById,
      session.affectedConnectorIds,
      session.connectorPreviewElements,
    );
    return preview;
  }

  function cleanupTextResizePreview(session: TextResizeSession, handleBlock = session.block) {
    session.sourceElement.classList.remove("is-resizing");
    session.sourceElement.style.width = session.originalWidth;
    session.sourceElement.style.height = session.originalHeight;
    session.sourceElement.style.left = session.originalLeft;
    session.sourceElement.style.top = session.originalTop;
    if (handleBlock === session.block) {
      session.handleElement?.style.setProperty("left", session.originalHandleLeft);
      session.handleElement?.style.setProperty("top", session.originalHandleTop);
    } else {
      positionTextResizeHandle(session.handleElement, handleBlock);
    }
    for (const connectorElement of session.connectorSourceElements) {
      connectorElement.classList.remove("is-drag-source-hidden");
    }
    cleanupConnectorPreviewLayer(session.connectorPreviewElements);
    document.body.classList.remove("is-interacting");
  }

  function finishTextResizePreview(handleBlock?: TextElement) {
    const session = textResizeSessionRef.current;
    if (!session) return null;
    textResizeSessionRef.current = null;
    cleanupTextResizePreview(session, handleBlock);
    return session;
  }

  function commitTextResize(block: TextElement) {
    setBlocksWithHistory((currentBlocks) => currentBlocks.map((element) =>
      element.id === block.id && element.type === "text" && !element.locked
        ? {
            ...element,
            height: block.height,
            isWidthManuallyResized: true,
            width: block.width,
            x: block.x,
            y: block.y,
            updatedAt: Date.now(),
          }
        : element,
    ));
  }

  function startSelectionResizePreview() {
    if (resizeLayerSessionRef.current) return true;
    const canvasElement = canvasRef.current;
    if (!canvasElement) return false;

    const sourceEntries = selectedBlockIdsRef.current
      .map((blockId) => ({
        blockId,
        element: blockElementsRef.current.get(blockId) ?? null,
        model: dataRef.current.elements.find((candidate) => candidate.id === blockId),
      }))
      .filter(
        (entry): entry is {
          blockId: string;
          element: HTMLElement;
          model: CanvasElement & BoxCanvasElement;
        } =>
          Boolean(entry.element && entry.model && !entry.model.locked && isBoxCanvasElement(entry.model)),
      );
    if (sourceEntries.length === 0) return false;
    const connectorIds = getSelectionResizePreviewConnectorIds(
      dataRef.current.elements,
      new Set(selectedBlockIdsRef.current),
      new Set(sourceEntries.map((entry) => entry.blockId)),
    );
    const baseElementsById = indexCanvasElements(dataRef.current.elements);
    const selectedIds = new Set(selectedBlockIdsRef.current);
    const selectedElements = selectedBlockIdsRef.current.flatMap((id) => {
      const element = baseElementsById[id];
      return element ? [element] : [];
    });

    const overlayElement = document.createElement("div");
    const groupElement = document.createElement("div");
    overlayElement.className = "drag-layer resize-layer";
    groupElement.className = "drag-layer-group resize-layer-group";
    overlayElement.append(groupElement);

    const items = sourceEntries.map(({ element, model }) => {
      const wrapperElement = document.createElement("div");
      const cloneElement = element.cloneNode(true) as HTMLElement;
      cloneElement.removeAttribute("data-block-id");
      cloneElement.setAttribute("aria-hidden", "true");
      cloneElement.classList.remove("is-content-selected", "is-drag-source-hidden", "is-editing");
      cloneElement.classList.add("is-canvas-mode", "is-selected", "drag-layer-clone", "resize-layer-clone");
      cloneElement.style.position = "absolute";
      cloneElement.style.left = "0";
      cloneElement.style.top = "0";
      cloneElement.style.width = `${model.width}px`;
      cloneElement.style.height = `${model.height}px`;
      cloneElement.style.margin = "0";
      cloneElement.style.pointerEvents = "none";
      wrapperElement.style.position = "absolute";
      wrapperElement.style.left = "0";
      wrapperElement.style.top = "0";
      wrapperElement.style.transformOrigin = "0 0";
      wrapperElement.append(cloneElement);
      groupElement.append(wrapperElement);
      return { cloneElement, element: model, wrapperElement };
    });

    canvasElement.append(overlayElement);
    const session = {
      baseElementsById,
      connectorIds,
      items,
      overlayElement,
      sourceElements: sourceEntries.map((entry) => entry.element),
      connectorPreviewElements: createConnectorPreviewLayer(),
      connectorSourceElements: Array.from(connectorIds).flatMap((id) => {
        const element = blockElementsRef.current.get(id);
        return element ? [element] : [];
      }),
      selectedElements,
      selectedIds,
    };
    resizeLayerSessionRef.current = session;
    document.body.classList.add("is-interacting");
    for (const sourceElement of session.sourceElements) {
      sourceElement.classList.add("is-drag-source-hidden");
    }
    for (const sourceElement of session.connectorSourceElements) {
      sourceElement.classList.add("is-drag-source-hidden");
    }
    renderTransientConnectorPreviews(baseElementsById, connectorIds, session.connectorPreviewElements);
    return true;
  }

  function updateSelectionResizePreview(
    scale: number,
    previewElements: readonly CanvasElement[],
    previewElementsById: Readonly<Record<string, CanvasElement>>,
  ) {
    const session = resizeLayerSessionRef.current;
    if (!session) return;
    const zoom = zoomLevelRef.current;
    const pan = panOffsetRef.current;
    const previewById = new Map(previewElements.map((element) => [element.id, element]));
    for (const item of session.items) {
      const preview = previewById.get(item.element.id);
      if (!preview || !isBoxCanvasElement(preview)) continue;
      if (preview.type === "text") {
        item.cloneElement.style.width = `${preview.width}px`;
        item.cloneElement.style.height = `${preview.height}px`;
      }
      const visualScale = zoom * (item.element.type === "text" ? 1 : scale);
      item.wrapperElement.style.transform = `translate3d(${pan.x + preview.x * zoom}px, ${pan.y + preview.y * zoom}px, 0) scale(${visualScale})`;
    }
    renderTransientConnectorPreviews(
      previewElementsById,
      session.connectorIds,
      session.connectorPreviewElements,
    );
  }

  function finishSelectionResizePreview() {
    const session = resizeLayerSessionRef.current;
    if (!session) return;
    cleanupResizeLayerSession(session);
    resizeLayerSessionRef.current = null;
  }

  function applySelectionFrameVisualBounds(bounds: SelectionRect) {
    const frame = selectionFrameRef.current;
    if (!frame) return;
    const zoom = zoomLevelRef.current;
    const pan = panOffsetRef.current;
    frame.style.left = `${pan.x + bounds.x * zoom - SELECTION_FRAME_PADDING_PX}px`;
    frame.style.top = `${pan.y + bounds.y * zoom - SELECTION_FRAME_PADDING_PX}px`;
    frame.style.width = `${bounds.width * zoom + SELECTION_FRAME_PADDING_PX * 2}px`;
    frame.style.height = `${bounds.height * zoom + SELECTION_FRAME_PADDING_PX * 2}px`;
  }

  function previewSelectionFrameVisualBounds(bounds: SelectionRect) {
    selectionFrameVisualBoundsRef.current = bounds;
    applySelectionFrameVisualBounds(bounds);
  }

  function clearSelectionFrameVisualBounds(restoredBounds?: SelectionRect) {
    selectionFrameVisualBoundsRef.current = null;
    if (restoredBounds) applySelectionFrameVisualBounds(restoredBounds);
  }

  function releaseSelectionPointerCapture(session: SelectionTransformSession) {
    if (session.captureTarget.hasPointerCapture(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId);
    }
  }

  function getPreviewSelectionBounds(
    elements: readonly CanvasElement[],
    selectedIds: ReadonlySet<string>,
    elementsById = indexCanvasElements(elements),
  ) {
    return getSelectionBounds(
      elements.filter((element) => selectedIds.has(element.id)),
      elementsById,
    );
  }

  function cancelSelectionFrameInteraction(updateMode = true) {
    const session = selectionTransformRef.current;
    session?.previewFrame.cancel();
    selectionTransformRef.current = null;
    if (session) releaseSelectionPointerCapture(session);
    if (session?.textResize) {
      finishTextResizePreview();
    } else if (session?.corner) {
      finishSelectionResizePreview();
      clearSelectionFrameVisualBounds(session.startBounds);
    } else if (session) {
      cancelVisualDrag(updateMode);
    }
    if (updateMode) {
      setConnectorEndpointPreview(null);
      setSelectionFramePreview(null);
      setConnectorEndpointChooser(null);
    }
    if (session?.connectorEndpoint) {
      cancelConnectorEndpointRetargetAnnouncement();
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
    const scale = getSelectionResizeScale(bounds, corner, clientX, clientY, session);
    const anchor = getOppositeCorner(bounds, corner);
    const width = bounds.width * scale;
    const height = bounds.height * scale;
    const resizeSession = resizeLayerSessionRef.current;
    if (!resizeSession) return null;
    const textSources = new Map(
      resizeSession?.items
        .filter((item) => item.element.type === "text")
        .map((item) => [item.element.id, item.cloneElement]) ?? [],
    );
    const textSizes = getTextSelectionSizes(
      resizeSession.selectedElements,
      resizeSession.selectedIds,
      scale,
      textSources,
    );
    const previewElements = scaleSelection(
      resizeSession.selectedElements,
      resizeSession.selectedIds,
      bounds,
      corner,
      scale,
      textSizes,
    );
    const previewElementsById = overlayTransformedElements(
      resizeSession.baseElementsById,
      previewElements,
    );
    return {
      scale,
      textSizes,
      elements: previewElements,
      elementsById: previewElementsById,
      bounds: getPreviewSelectionBounds(
        previewElements,
        resizeSession.selectedIds,
        previewElementsById,
      ) ?? {
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
    if (connectorEndpoint) {
      connectorEndpointRetargetAnnouncementRef.current = null;
      setConnectorBindingAnnouncement("");
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    let session: SelectionTransformSession;
    session = {
      baseElementsById: indexCanvasElements(dataRef.current.elements),
      captureTarget: event.currentTarget,
      corner,
      connectorEndpoint,
      didMove: false,
      pointerId: event.pointerId,
      previewFrame: createLatestFrameQueue(({ clientX, clientY }) => {
        applySelectionFrameInteractionMove(session, clientX, clientY);
      }),
      startBounds: bounds,
      startClientX: event.clientX,
      startClientY: event.clientY,
      selectionScale: null,
      textResize: false,
      textSizes: null,
    };
    selectionTransformRef.current = session;
    const selectedConnector = connectorEndpoint
      ? dataRef.current.elements.find((element): element is ConnectorElement =>
        element.id === selectedBlockIdsRef.current[0] && element.type === "connector",
      )
      : null;
    setIsConnectorEndpointRetargeting(selectedConnector?.style.endArrowhead === "arrow");
  }

  function startTextResizeInteraction(event: ReactPointerEvent<HTMLButtonElement>) {
    const selectedId = selectedBlockIdsRef.current.length === 1
      ? selectedBlockIdsRef.current[0]
      : null;
    const block = selectedId
      ? dataRef.current.elements.find((element): element is TextElement =>
        element.id === selectedId && element.type === "text" && !element.locked,
      )
      : null;
    if (event.button !== 0 || !block || editingBlockIdRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (!startTextResizePreview(block)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    let session: SelectionTransformSession;
    session = {
      baseElementsById: indexCanvasElements(dataRef.current.elements),
      captureTarget: event.currentTarget,
      connectorEndpoint: null,
      corner: null,
      didMove: false,
      pointerId: event.pointerId,
      previewFrame: createLatestFrameQueue(({ clientX, clientY }) => {
        applySelectionFrameInteractionMove(session, clientX, clientY);
      }),
      startBounds: getSelectionElementBounds(block) ?? {
        height: block.height,
        width: block.width,
        x: block.x,
        y: block.y,
      },
      startClientX: event.clientX,
      startClientY: event.clientY,
      selectionScale: null,
      textResize: true,
      textSizes: null,
    };
    selectionTransformRef.current = session;
    setActiveMode("resizing");
  }

  function announceConnectorEndpointRetargetCandidate(
    candidate: ReturnType<typeof getConnectorAuthoringCandidate>,
  ) {
    const nextKey = getConnectorCandidateAnnouncementKey(candidate);
    const previousKey = connectorEndpointRetargetAnnouncementRef.current;
    if (nextKey === previousKey) return;
    connectorEndpointRetargetAnnouncementRef.current = nextKey;
    if (candidate) {
      setConnectorBindingAnnouncement(getConnectorCandidateAnnouncement(candidate, getBindableTargetLabel(candidate.target)));
    } else if (previousKey !== null) {
      setConnectorBindingAnnouncement(getConnectorCandidateAnnouncement(null));
    }
  }

  function cancelConnectorEndpointRetargetAnnouncement() {
    connectorEndpointRetargetAnnouncementRef.current = null;
    setConnectorBindingAnnouncement("Endpoint retargeting canceled. Existing binding remains unchanged.");
  }

  function announceConnectorBindingRefusal(
    endpoint: "start" | "end",
    reason: "same-target" | "safe-boundary",
  ) {
    const refusalKey = `refusal:${endpoint}:${reason}`;
    if (connectorEndpointRetargetAnnouncementRef.current === refusalKey) return;
    connectorEndpointRetargetAnnouncementRef.current = refusalKey;
    setConnectorBindingAnnouncement(reason === "same-target"
      ? `Could not bind ${endpoint} endpoint. Choose a different target for each connector endpoint.`
      : `Could not bind ${endpoint} endpoint because the connector's visible stroke would exceed the safe canvas boundary.`);
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
    const targets = dataRef.current.elements.filter((element) => element.pageId === connector.pageId);
    const opposite = connector[endpoint === "start" ? "end" : "start"];
    const oppositeTargetId = opposite.kind === "element" ? opposite.targetElementId : null;
    const directTargetId = getDirectBindableTargetAtPoint(targets, point)?.id;
    const unfilteredCandidate = connector.style.endArrowhead === "arrow"
      ? getConnectorAuthoringCandidate(point, targets, zoomLevelRef.current, directTargetId)
      : null;
    if (oppositeTargetId && unfilteredCandidate?.target.id === oppositeTargetId) {
      announceConnectorBindingRefusal(endpoint, "same-target");
      setConnectorEndpointRetargetVisual(null);
      return null;
    }
    const eligibleTargets = oppositeTargetId
      ? targets.filter((target) => target.id !== oppositeTargetId)
      : targets;
    const candidate = connector.style.endArrowhead === "arrow"
      ? getConnectorAuthoringCandidate(point, eligibleTargets, zoomLevelRef.current, directTargetId)
      : null;
    announceConnectorEndpointRetargetCandidate(candidate);
    setConnectorEndpointRetargetVisual(candidate ? {
      isSnapped: candidate.endpoint.kind === "element",
      target: candidate.target,
    } : null);
    const nextEndpoint = candidate?.endpoint ?? snapConnectorEndpoint(
      point, eligibleTargets, zoomLevelRef.current, connector.style.endArrowhead === "arrow",
    );
    const preview = endpoint === "start"
      ? { ...connector, start: nextEndpoint }
      : { ...connector, end: nextEndpoint };
    if (!isLiveConnectorBindingPersistable(preview)) {
      announceConnectorBindingRefusal(endpoint, "safe-boundary");
      setConnectorEndpointRetargetVisual(null);
      return null;
    }
    return preview;
  }

  function applySelectionFrameInteractionMove(
    session: SelectionTransformSession,
    clientX: number,
    clientY: number,
  ) {
    if (selectionTransformRef.current !== session) return;
    session.didMove = true;

    if (session.textResize) {
      const textResize = textResizeSessionRef.current;
      if (!textResize) return;
      const preview = updateTextResizePreview(
        textResize,
        session.startClientX,
        session.startClientY,
        clientX,
        clientY,
      );
      session.didMove = Math.abs(preview.width - textResize.block.width) > 0.01 ||
        Math.abs(preview.height - textResize.block.height) > 0.01 ||
        Math.abs(preview.x - textResize.block.x) > 0.01 ||
        Math.abs(preview.y - textResize.block.y) > 0.01;
      return;
    }

    if (session.connectorEndpoint) {
      const preview = getConnectorEndpointPreview(session.connectorEndpoint, clientX, clientY);
      if (!preview) {
        setConnectorEndpointPreview(null);
        setSelectionFramePreview(null);
        return;
      }
      setConnectorEndpointPreview(preview);
      const previewElementsById = overlayTransformedElements(session.baseElementsById, [preview]);
      setSelectionFramePreview(getSelectionElementBounds(preview, previewElementsById));
      return;
    }

    if (session.corner) {
      if (!startSelectionResizePreview()) return;
      const preview = selectionResizePreview(session.startBounds, session.corner, clientX, clientY, session);
      if (!preview) return;
      session.selectionScale = preview.scale;
      session.textSizes = preview.textSizes;
      updateSelectionResizePreview(preview.scale, preview.elements, preview.elementsById);
      previewSelectionFrameVisualBounds(preview.bounds);
    }
  }

  function moveSelectionFrameInteraction(event: ReactPointerEvent<HTMLElement>) {
    const session = selectionTransformRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const movedEnough = Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY) >= 3;
    if (!movedEnough) return;
    event.preventDefault();
    if (session.textResize || session.connectorEndpoint || session.corner) {
      session.previewFrame.schedule({ clientX: event.clientX, clientY: event.clientY });
      return;
    }
    session.didMove = true;
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
    const usesQueuedPreview = Boolean(session.textResize || session.connectorEndpoint || session.corner);
    const movedEnough = Math.hypot(
      event.clientX - session.startClientX,
      event.clientY - session.startClientY,
    ) >= 3;
    if (!cancelled && usesQueuedPreview && movedEnough) {
      session.previewFrame.flush({ clientX: event.clientX, clientY: event.clientY });
    } else {
      session.previewFrame.cancel();
    }
    selectionTransformRef.current = null;
    releaseSelectionPointerCapture(session);

    if (cancelled) {
      if (session.textResize) {
        finishTextResizePreview();
      } else if (session.corner) {
        finishSelectionResizePreview();
        clearSelectionFrameVisualBounds(session.startBounds);
      } else if (!session.connectorEndpoint) {
        cancelVisualDrag();
      }
      setConnectorEndpointPreview(null);
      setConnectorEndpointRetargetVisual(null);
      setSelectionFramePreview(null);
      setConnectorEndpointChooser(null);
      if (session.connectorEndpoint) cancelConnectorEndpointRetargetAnnouncement();
      setIsConnectorEndpointRetargeting(false);
      setIsCanvasKeyboardActive(true);
      setActiveMode(selectedBlockIdsRef.current.length > 0 ? "selected" : "canvas");
      return;
    }

    if (session.connectorEndpoint && session.didMove) {
      const connectorEndpoint = session.connectorEndpoint;
      const preview = getConnectorEndpointPreview(connectorEndpoint, event.clientX, event.clientY);
      if (preview) {
        if (!isLiveConnectorBindingPersistable(preview)) {
          announceConnectorBindingRefusal(connectorEndpoint, "safe-boundary");
        } else {
          setBlocksWithHistory((currentBlocks) => {
            const liveConnector = currentBlocks.find((element): element is ConnectorElement =>
              element.id === preview.id && element.type === "connector",
            );
            if (!liveConnector || liveConnector.style.endArrowhead !== "arrow") return currentBlocks;
            const proposedEndpoint = preview[connectorEndpoint];
            const oppositeEndpoint = liveConnector[connectorEndpoint === "start" ? "end" : "start"];
            if (
              proposedEndpoint.kind === "element"
              && oppositeEndpoint.kind === "element"
              && proposedEndpoint.targetElementId === oppositeEndpoint.targetElementId
            ) return currentBlocks;
            const candidate = connectorEndpoint === "start"
              ? { ...liveConnector, start: proposedEndpoint }
              : { ...liveConnector, end: proposedEndpoint };
            if (!isLiveConnectorBindingPersistable(candidate, currentBlocks)) {
              announceConnectorBindingRefusal(connectorEndpoint, "safe-boundary");
              return currentBlocks;
            }
            return currentBlocks.map((element) => element.id === candidate.id
              ? { ...candidate, updatedAt: Date.now() }
              : element);
          });
        }
      }
    } else if (session.textResize) {
      const textResize = textResizeSessionRef.current;
      if (textResize && session.didMove) {
        const preview = updateTextResizePreview(
          textResize,
          session.startClientX,
          session.startClientY,
          event.clientX,
          event.clientY,
        );
        const didResize = Math.abs(preview.width - textResize.block.width) > 0.01 ||
          Math.abs(preview.height - textResize.block.height) > 0.01 ||
          Math.abs(preview.x - textResize.block.x) > 0.01 ||
          Math.abs(preview.y - textResize.block.y) > 0.01;
        finishTextResizePreview(preview);
        if (didResize) commitTextResize(preview);
      } else if (textResize) {
        finishTextResizePreview();
      }
    } else if (session.corner && session.didMove) {
      const selectedIds = new Set(selectedBlockIdsRef.current);
      const scale = session.selectionScale ?? getSelectionResizeScale(
        session.startBounds,
        session.corner,
        event.clientX,
        event.clientY,
        session,
      );
      finishSelectionResizePreview();
      clearSelectionFrameVisualBounds();
      setBlocksWithHistory((currentBlocks) =>
        scaleSelection(
          currentBlocks,
          selectedIds,
          session.startBounds,
          session.corner!,
          scale,
          session.textSizes ?? new Map(),
        ),
      );
    } else if (!session.corner && session.didMove) {
      endVisualDrag(event.clientX, event.clientY);
    }

    setConnectorEndpointPreview(null);
    setConnectorEndpointRetargetVisual(null);
    connectorEndpointRetargetAnnouncementRef.current = null;
    setSelectionFramePreview(null);
    setConnectorEndpointChooser(null);
    setIsConnectorEndpointRetargeting(false);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
  }

  function moveSelectionByKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "F2" && selectedBlockIdsRef.current.length === 1) {
      const selected = dataRef.current.elements.find(
        (element) => element.id === selectedBlockIdsRef.current[0],
      );
      if (selected?.type === "text" || selected?.type === "shape") {
        event.preventDefault();
        event.stopPropagation();
        editBlock(selected.id);
      }
      return;
    }
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
      const textSizes = getTextSelectionSizes(dataRef.current.elements, selectedIds, scale);
      setBlocksWithHistory((currentBlocks) =>
        scaleSelection(currentBlocks, selectedIds, bounds, corner, scale, textSizes),
      );
      setActiveMode("selected");
    };
  }

  function getSelectionResizeScale(
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
    return getProportionalScale(bounds, corner, draggedCorner);
  }

  function resizeTextWidthByKeyboard(
    blockId: string,
    direction: -1 | 1,
    zoom: number,
  ) {
    const block = dataRef.current.elements.find((element): element is TextElement =>
      element.id === blockId && element.type === "text" && !element.locked,
    );
    if (!block) return;
    const size = measureTextReflowSize(block, block.width + direction * 10 / zoom);
    commitTextResize(getEastResizedTextPreview(block, size));
    setActiveMode("selected");
  }

  function moveConnectorEndpointByKeyboard(endpoint: "start" | "end") {
    return (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!event.key.startsWith("Arrow") || connectorEndpointChooserRef.current !== null) return;
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
      setBlocksWithHistory((currentBlocks) => {
        const elementsById = Object.fromEntries(currentBlocks.map((element) => [element.id, element]));
        return currentBlocks.map((element) => {
          if (element.id !== selectedId || element.type !== "connector" || element.locked) return element;
          const currentEndpoint = element[endpoint];
          const points = resolveConnectorPoints(element, elementsById);
          const resolved = points?.[endpoint]
            ?? (currentEndpoint.kind === "free" ? currentEndpoint : null)
            ?? getConnectorEndpointDetachPoint(element, endpoint, elementsById);
          if (!resolved) {
            if (currentEndpoint.kind === "element") {
              setConnectorBindingAnnouncement(`Could not detach ${endpoint} endpoint because no safe in-canvas position is available.`);
            }
            return element;
          }
          let moved = normalizeFreeConnectorEndpoint({ x: resolved.x + delta.x, y: resolved.y + delta.y });
          if (!moved) return element;
          let candidate = endpoint === "start"
            ? { ...element, start: moved, updatedAt: Date.now() }
            : { ...element, end: moved, updatedAt: Date.now() };
          if (currentEndpoint.kind === "element" && !resolveConnectorPoints(candidate, elementsById)) {
            moved = { kind: "free", ...resolved };
            candidate = endpoint === "start"
              ? { ...element, start: moved, updatedAt: Date.now() }
              : { ...element, end: moved, updatedAt: Date.now() };
            if (!resolveConnectorPoints(candidate, elementsById)) {
              setConnectorBindingAnnouncement(`Could not detach ${endpoint} endpoint because no safe in-canvas position is available.`);
              return element;
            }
          }
          if (currentEndpoint.kind === "element") {
            setConnectorBindingAnnouncement(`Detached and moved ${endpoint} endpoint. It is now free.`);
          }
          return candidate;
        });
      });
      setActiveMode("selected");
    };
  }

  function getSelectedArrowConnector(): ConnectorElement | null {
    const selectedId = selectedBlockIdsRef.current.length === 1 ? selectedBlockIdsRef.current[0] : null;
    const connector = selectedId
      ? dataRef.current.elements.find((element): element is ConnectorElement =>
        element.id === selectedId && element.type === "connector",
      )
      : null;
    return connector?.style.endArrowhead === "arrow" ? connector : null;
  }

  function getConnectorBindingTargets(pageId: string): readonly Readonly<{ element: ShapeElement | TextElement; label: string }>[] {
    const shapeOrdinals = new Map<ShapeElement["shape"], number>();
    let textOrdinal = 0;
    return dataRef.current.elements
      .filter((element): element is ShapeElement | TextElement => element.pageId === pageId && isBindableElement(element))
      .map((element) => {
        if (element.type === "text") {
          textOrdinal += 1;
          const centerX = Math.round(element.x + element.width / 2);
          const centerY = Math.round(element.y + element.height / 2);
          const excerpt = element.content.trim().replace(/\s+/g, " ").slice(0, 32);
          return { element, label: `Text ${textOrdinal}${excerpt ? ` (${excerpt})` : ""} (center ${centerX}, ${centerY})` };
        }
        const ordinal = (shapeOrdinals.get(element.shape) ?? 0) + 1;
        shapeOrdinals.set(element.shape, ordinal);
        const centerX = Math.round(element.x + element.width / 2);
        const centerY = Math.round(element.y + element.height / 2);
        return {
          element,
          label: `${element.shape[0].toUpperCase()}${element.shape.slice(1)} ${ordinal} (center ${centerX}, ${centerY})`,
        };
      });
  }

  function getBindableTargetLabel(target: ShapeElement | TextElement): string {
    return getConnectorBindingTargets(target.pageId).find(({ element }) => element.id === target.id)?.label
      ?? `${target.type === "text" ? "Text" : `${target.shape[0].toUpperCase()}${target.shape.slice(1)}`} (center ${Math.round(target.x + target.width / 2)}, ${Math.round(target.y + target.height / 2)})`;
  }

  function getConnectorBindingTargetsForEndpoint(
    connector: ConnectorElement,
    endpoint: "start" | "end",
  ) {
    const opposite = connector[endpoint === "start" ? "end" : "start"];
    return getConnectorBindingTargets(connector.pageId).filter(({ element }) => (
      opposite.kind !== "element" || element.id !== opposite.targetElementId
    ));
  }

  function getConnectorEndpointDescription(
    connector: ConnectorElement,
    endpoint: "start" | "end",
  ): string {
    const current = connector[endpoint];
    if (connector.style.endArrowhead !== "arrow") {
      return `Currently free. This line endpoint cannot bind to elements. Arrow keys move it.`;
    }
    if (current.kind !== "element") {
      return `Currently free. Press Enter to choose a target shape or text block. Arrow keys move the endpoint.`;
    }
    const target = dataRef.current.elements.find((element): element is ShapeElement | TextElement =>
      element.id === current.targetElementId && element.pageId === connector.pageId && isBindableElement(element),
    );
    const targetLabel = target ? getBindableTargetLabel(target) : "an unavailable target";
    return `Currently bound to ${targetLabel}. The endpoint follows the nearest facing visible boundary automatically. Press Enter to rebind or detach. Arrow keys detach and move the endpoint.`;
  }

  function openConnectorEndpointChooser(endpoint: "start" | "end", origin: HTMLButtonElement) {
    const connector = getSelectedArrowConnector();
    if (!connector || connector.locked) return;
    const targets = getConnectorBindingTargetsForEndpoint(connector, endpoint);
    const current = connector[endpoint];
    if (targets.length === 0 && current.kind !== "element") {
      setConnectorBindingAnnouncement(`No compatible shapes or text blocks are available to bind the ${endpoint} endpoint.`);
      return;
    }
    setConnectorBindingAnnouncement("");
    const currentTargetId = current.kind === "element" && targets.some(({ element }) => element.id === current.targetElementId)
      ? current.targetElementId
      : targets[0]?.element.id ?? null;
    connectorEndpointOriginFocusRef.current = origin;
    if (connectorEndpointFocusReturnRafRef.current !== null) {
      window.cancelAnimationFrame(connectorEndpointFocusReturnRafRef.current);
      connectorEndpointFocusReturnRafRef.current = null;
    }
    const chooser = {
      endpoint,
      targetElementId: currentTargetId,
    };
    connectorEndpointChooserRef.current = chooser;
    setConnectorEndpointChooser(chooser);
  }

  function closeConnectorEndpointChooser() {
    const endpoint = connectorEndpointChooserRef.current?.endpoint ?? connectorEndpointChooser?.endpoint;
    const origin = connectorEndpointOriginFocusRef.current;
    connectorEndpointOriginFocusRef.current = null;
    connectorEndpointChooserRef.current = null;
    setConnectorEndpointChooser(null);
    if (!endpoint) return;
    if (connectorEndpointFocusReturnRafRef.current !== null) {
      window.cancelAnimationFrame(connectorEndpointFocusReturnRafRef.current);
    }
    connectorEndpointFocusReturnRafRef.current = window.requestAnimationFrame(() => {
      connectorEndpointFocusReturnRafRef.current = null;
      if (connectorEndpointChooserRef.current !== null) return;
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      const fallback = document.querySelector<HTMLButtonElement>(`[data-connector-endpoint-handle="${endpoint}"]`);
      (origin?.isConnected ? origin : fallback)?.focus({ preventScroll: true });
    });
  }

  function bindSelectedConnectorEndpoint() {
    const chooser = connectorEndpointChooser;
    const connector = getSelectedArrowConnector();
    if (!chooser || !connector || !chooser.targetElementId) return;
    const target = dataRef.current.elements.find((element): element is ShapeElement | TextElement =>
      element.id === chooser.targetElementId
        && element.pageId === connector.pageId
        && isBindableElement(element),
    );
    if (!target) return;
    const opposite = connector[chooser.endpoint === "start" ? "end" : "start"];
    if (opposite.kind === "element" && opposite.targetElementId === target.id) {
      setConnectorBindingAnnouncement("Choose a different target for each connector endpoint.");
      return;
    }
    const previous = connector[chooser.endpoint];
    const next = {
      kind: "element" as const,
      targetElementId: target.id,
      gap: 0,
    };
    const candidate = chooser.endpoint === "start"
      ? { ...connector, start: next }
      : { ...connector, end: next };
    if (!isLiveConnectorBindingPersistable(candidate)) {
      setConnectorBindingAnnouncement(
        `Could not bind ${chooser.endpoint} endpoint because the connector's visible stroke would exceed the safe canvas boundary.`,
      );
      return;
    }
    setBlocksWithHistory((currentBlocks) => currentBlocks.map((element) => {
      if (element.id !== connector.id || element.type !== "connector") return element;
      return { ...candidate, updatedAt: Date.now() };
    }));
    setConnectorBindingAnnouncement(
      `${previous.kind === "element" ? "Rebound" : "Bound"} ${chooser.endpoint} endpoint to ${getBindableTargetLabel(target)}. The connector will follow the nearest facing visible boundaries automatically.`,
    );
    closeConnectorEndpointChooser();
  }

  function detachSelectedConnectorEndpoint() {
    const chooser = connectorEndpointChooser;
    const connector = getSelectedArrowConnector();
    if (!chooser || !connector) return;
    const current = connector[chooser.endpoint];
    if (current.kind !== "element") {
      setConnectorBindingAnnouncement(`${chooser.endpoint} endpoint is already free.`);
      closeConnectorEndpointChooser();
      return;
    }
    const elementsById = Object.fromEntries(dataRef.current.elements.map((element) => [element.id, element]));
    const resolved = getConnectorEndpointDetachPoint(connector, chooser.endpoint, elementsById);
    if (!resolved) {
      setConnectorBindingAnnouncement(`Could not detach ${chooser.endpoint} endpoint because no safe in-canvas position is available.`);
      return;
    }
    const next = normalizeFreeConnectorEndpoint(resolved);
    if (!next) {
      setConnectorBindingAnnouncement(`Could not detach ${chooser.endpoint} endpoint because its position is unavailable.`);
      return;
    }
    setBlocksWithHistory((currentBlocks) => currentBlocks.map((element) => {
      if (element.id !== connector.id || element.type !== "connector") return element;
      return chooser.endpoint === "start"
        ? { ...element, start: next, updatedAt: Date.now() }
        : { ...element, end: next, updatedAt: Date.now() };
    }));
    setConnectorBindingAnnouncement(`Detached ${chooser.endpoint} endpoint. It is now free.`);
    closeConnectorEndpointChooser();
  }

  const selectBlock = useCallback((blockId: string, additive = false) => {
    finishActiveShapeTextEdit();
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
    setConnectorEndpointChooser(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode(isDeselectingOnlyBlock ? "canvas" : "selected");
  }, []);

  const editBlock = useCallback((blockId: string) => {
    const shape = dataRef.current.elements.find(
      (element): element is ShapeElement => element.id === blockId && element.type === "shape",
    );
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
    if (shape) {
      setConnectorBindingAnnouncement(`Editing text inside ${shape.shape} shape. Escape cancels; Control+Enter saves.`);
    }
  }, []);

  const endBlockEdit = useCallback((blockId: string, outcome?: "canceled" | "committed" | "unchanged", restoreFocus = true) => {
    if (editingBlockIdRef.current !== blockId) {
      return;
    }

    editingBlockIdRef.current = null;
    setEditingBlockId(null);
    setActiveMode((currentMode) =>
      currentMode === "editing" ? "selected" : currentMode,
    );
    const shape = dataRef.current.elements.find((element) => element.id === blockId && element.type === "shape");
    if (shape && outcome) {
      setConnectorBindingAnnouncement(outcome === "committed"
        ? "Shape text saved."
        : outcome === "unchanged"
          ? "Shape text unchanged."
          : "Shape text editing canceled.");
    }
    if (shape && restoreFocus) {
      window.requestAnimationFrame(() => {
        blockElementsRef.current.get(blockId)?.focus({ preventScroll: true });
      });
    }
  }, []);

  const registerShapeTextEditSession = useCallback((elementId: string, session: ShapeTextEditSession | null) => {
    if (session) {
      shapeTextEditSessionRef.current = { elementId, session };
    } else if (shapeTextEditSessionRef.current?.elementId === elementId) {
      shapeTextEditSessionRef.current = null;
    }
  }, []);

  function finishActiveShapeTextEdit() {
    const session = shapeTextEditSessionRef.current;
    if (!session) return false;
    shapeTextEditSessionRef.current = null;
    session.session.commit();
    return true;
  }

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
    const finishedShapeSession = finishActiveShapeTextEdit();
    blurActiveTextEntry();
    window.getSelection()?.removeAllRanges();
    if (!finishedShapeSession) {
      setActiveTextEditor(null);
      setEditingBlockId(null);
    }
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

  const getPrimitiveAppearance = useCallback((tool: PrimitiveTool, elementId: string) => {
    const preference = drawingPreferencesRef.current[tool];
    return {
      opacity: preference.opacity,
      style: {
        fillColor: tool === "line" ? null : preference.backgroundColor,
        roughness: preference.roughness,
        roundness: tool === "rectangle" ? preference.roundness : 0,
        seed: deterministicSeed(elementId),
        strokeColor: preference.strokeColor,
        strokeStyle: preference.strokeStyle,
        strokeWidth: preference.strokeWidth,
      },
    };
  }, []);

  const completePrimitiveCreation = useCallback(
    (elementId: string, tool: PrimitiveTool, geometry: PrimitiveGeometry, appearance: Readonly<{ opacity: number; style: RoughStyle }>) => {
      const pageId = selectedPageIdRef.current;
      if (!pageId) return false;
      if (geometry.kind === "shape" && !isPersistableShapeRect(geometry.rect)) return false;
      const timestamp = Date.now();
      const { opacity, style } = appearance;

      setBlocksWithHistory((currentElements) => {
        if (geometry.kind === "connector") {
          const connector: ConnectorElement = {
            createdAt: timestamp,
            end: { kind: "free", ...geometry.end },
            id: elementId,
            locked: false,
            opacity,
            pageId,
            routing: "straight",
            start: { kind: "free", ...geometry.start },
            style: {
              ...style,
              endArrowhead: "none",
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
          opacity,
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
      return true;
    },
    [],
  );

  const completeArrowCreation = useCallback((elementId: string, start: ConnectorEndpoint, end: ConnectorEndpoint) => {
    const pageId = selectedPageIdRef.current;
    if (!pageId) return false;
    const elementsById = Object.fromEntries(dataRef.current.elements.map((element) => [element.id, element]));
    const isValidEndpoint = (endpoint: ConnectorEndpoint) => {
      if (endpoint.kind === "free") return normalizeFreeConnectorEndpoint(endpoint) !== null;
      if (endpoint.kind !== "element") return false;
      const target = elementsById[endpoint.targetElementId];
      return isBindableElement(target) && target.pageId === pageId;
    };
    if (!isValidEndpoint(start) || !isValidEndpoint(end) || (
      start.kind === "element"
      && end.kind === "element"
      && start.targetElementId === end.targetElementId
    )) {
      return false;
    }
    const timestamp = Date.now();
    const preference = drawingPreferencesRef.current.arrow;
    const connector: ConnectorElement = {
      createdAt: timestamp,
      end,
      id: elementId,
      locked: false,
      opacity: preference.opacity,
      pageId,
      routing: "straight",
      start,
      style: {
        endArrowhead: "arrow",
        fillColor: null,
        roughness: preference.roughness,
        roundness: 0,
        seed: deterministicSeed(elementId),
        startArrowhead: "none",
        strokeColor: preference.strokeColor,
        strokeStyle: preference.strokeStyle,
        strokeWidth: preference.strokeWidth,
      },
      type: "connector",
      updatedAt: timestamp,
      zIndex: dataRef.current.elements.length,
    };
    if (!isLiveConnectorBindingPersistable(connector)) return false;
    setBlocksWithHistory((currentElements) => [...currentElements, {
      ...connector,
      zIndex: currentElements.length,
    }]);
    selectedBlockIdsRef.current = [elementId];
    setSelectedBlockIds([elementId]);
    editingBlockIdRef.current = null;
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
    const nextTool = drawingToolAfterCreation("arrow", isToolLockedRef.current);
    if (nextTool !== "arrow") {
      activeToolRef.current = nextTool;
      setActiveTool(nextTool);
    }
    return true;
  }, []);

  const canvasInteraction = useCanvasInteraction({
    activeToolRef,
    canvasContentRef,
    canvasRef,
    cleanupMarquee: clearMarquee,
    createArrowId: () => createId("connector"),
    createPrimitiveId: (tool) => createId(tool === "line" ? "connector" : "shape"),
    getArrowCreatedStatus: () => isToolLockedRef.current
      ? "Arrow created. Tool lock kept Arrow active. Use the endpoint handles to bind or move it."
      : "Arrow created. Switched to Select. Use the endpoint handles to bind or move it.",
    getArrowPreviewStyle: (elementId) => {
      const preference = drawingPreferencesRef.current.arrow;
      return {
        endArrowhead: "arrow",
        fillColor: null,
        roughness: preference.roughness,
        roundness: 0,
        seed: deterministicSeed(elementId),
        startArrowhead: "none",
        strokeColor: preference.strokeColor,
        strokeStyle: preference.strokeStyle,
        strokeWidth: preference.strokeWidth,
      };
    },
    getArrowTargetLabel: getBindableTargetLabel,
    getPrimitivePreviewAppearance: getPrimitiveAppearance,
    hasPendingImage: () => pendingImagePlacementRef.current !== null,
    interactionCancellationKey: `${activeTool}:${selectedPageId ?? ""}`,
    isTemporaryHandActiveRef,
    leaveTextEditing,
    liveDraftLayerRef,
    maxZoom: MAX_ZOOM,
    minZoom: MIN_ZOOM,
    onArrowStatusChange: setConnectorBindingAnnouncement,
    onCreateArrow: completeArrowCreation,
    onCreatePrimitive: completePrimitiveCreation,
    onPrimitiveStatusChange: (tool) => {
      pointerShapeAnnouncementSequenceRef.current += 1;
      const label = tool === "rectangle" ? "Rectangle" : tool === "ellipse" ? "Ellipse" : "Diamond";
      setConnectorBindingAnnouncement(
        `Shape gesture ${pointerShapeAnnouncementSequenceRef.current} was not created. ${label} needs horizontal and vertical size within the available canvas area.`,
      );
    },
    onCreateText: (point) =>
      createTextBlock(point.x, point.y, "", {
        fromTool: true,
        placement: "block-origin",
      }),
    onEditBindableText: editBlock,
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
  cancelCanvasSelectionRef.current = canvasInteraction.cancelCapturedPointerInteraction;
  keyboardShapeCreationRef.current = (tool) => {
    canvasInteraction.cancelArrowAuthoring();
    canvasInteraction.cancelCapturedPointerInteraction();
    const geometry = canvasViewportRef.current
      ? getDefaultKeyboardShapeGeometry(tool, canvasViewportRef.current)
      : null;
    const label = tool === "rectangle" ? "Rectangle" : tool === "ellipse" ? "Ellipse" : "Diamond";
    keyboardShapeAnnouncementSequenceRef.current += 1;
    const sequence = keyboardShapeAnnouncementSequenceRef.current;
    if (!geometry) {
      setConnectorBindingAnnouncement(`Keyboard shape ${sequence} was not created. ${label} is unavailable at the current canvas position.`);
      return false;
    }
    const elementId = createId("shape");
    const keepsToolActive = isToolLockedRef.current;
    if (!completePrimitiveCreation(elementId, tool, geometry, getPrimitiveAppearance(tool, elementId))) {
      setConnectorBindingAnnouncement(`Keyboard shape ${sequence} was not created. ${label} is unavailable at the current canvas position.`);
      return false;
    }
    setConnectorBindingAnnouncement(keepsToolActive
      ? `Keyboard shape ${sequence} created. ${label} was placed in the current viewport. Tool lock kept ${label} active.`
      : `Keyboard shape ${sequence} created. ${label} was placed in the current viewport. Switched to Select.`);
    canvasRef.current?.focus({ preventScroll: true });
    return true;
  };
  keyboardArrowCreationRef.current = () => {
    canvasInteraction.cancelArrowAuthoring();
    const endpoints = canvasViewportRef.current
      ? getDefaultKeyboardArrowEndpoints(canvasViewportRef.current)
      : null;
    if (!endpoints) {
      setConnectorBindingAnnouncement("Arrow is unavailable at the current canvas position.");
      return false;
    }
    const elementId = createId("connector");
    const keepsArrowActive = isToolLockedRef.current;
    if (!completeArrowCreation(elementId, endpoints.start, endpoints.end)) {
      setConnectorBindingAnnouncement("Arrow is unavailable at the current canvas position.");
      return false;
    }
    setKeyboardArrowEndpointAccessId(elementId);
    setConnectorBindingAnnouncement(keepsArrowActive
      ? "Arrow created. Tool lock kept Arrow active. Use the endpoint handles to bind or move it."
      : "Arrow created. Switched to Select. Use the endpoint handles to bind or move it.");
    if (keyboardArrowEndpointFocusRafRef.current !== null) {
      window.cancelAnimationFrame(keyboardArrowEndpointFocusRafRef.current);
    }
    keyboardArrowEndpointFocusRafRef.current = window.requestAnimationFrame(() => {
      keyboardArrowEndpointFocusRafRef.current = null;
      document.querySelector<HTMLButtonElement>('[data-connector-endpoint-handle="start"]')
        ?.focus({ preventScroll: true });
    });
    return true;
  };

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
  cancelCapturedCanvasInteractionsRef.current = () => {
    canvasInteraction.cancelCapturedPointerInteraction();
    inkInteraction.cancelCapturedPointerInteraction();
    cancelSelectionFrameInteraction();
    cancelVisualDragRef.current();
    isTemporaryHandActiveRef.current = false;
    canvasRef.current?.removeAttribute("data-temporary-hand");
    document.body.classList.remove("is-interacting");
  };
  cancelCanvasInteractionTransitionRef.current = () => {
    cancelCapturedCanvasInteractionsRef.current();
    canvasInteraction.cancelArrowAuthoring();
  };

  function focusSearchMatch(matchIndex: number) {
    if (searchMatches.length === 0 || isCanvasSearchInteractionBlocked()) {
      return;
    }

    const normalizedIndex =
      ((matchIndex % searchMatches.length) + searchMatches.length) %
      searchMatches.length;
    const match = searchMatches[normalizedIndex];

    setActiveSearchIndex(normalizedIndex);

    if (match.kind === "title") {
      setSearchPanOffset(null);
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
      return;
    }

    const block = visibleBlocks.find((currentBlock) => currentBlock.id === match.elementId);

    if (!block || !isBoxCanvasElement(block)) {
      return;
    }

    setSearchPanOffset({
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
      ? `${activeSearchDisplayIndex} / ${searchMatches.length}${isSearchTruncated ? "+" : ""}`
      : "0 / 0";
  const canvasSearchSourceLabel =
    activeCanvasSearchMatch?.kind === "title"
      ? "Page title"
      : activeCanvasSearchMatch?.source === "shape-text"
        ? "Shape text"
        : "Text";
  const canvasSearchStatusLabel = !hasCanvasSearchQuery
    ? "Enter a search query."
    : searchMatches.length === 0
      ? "No results."
      : `Result ${activeSearchDisplayIndex} of ${searchMatches.length}${isSearchTruncated ? " or more" : ""}, ${canvasSearchSourceLabel}`;
  const isCanvasSearchUnavailable = Boolean(
    editingBlockId
    || activeTextEditor && !activeTextEditor.isDestroyed
    || isEditingHeaderTitle
    || editingFolderId
    || editingPageId
    || connectorEndpointChooser
    || activeNarrowOverlay
    || isAIProvidersOpen
  );

  useEffect(() => {
    if (isSearchOpen && isCanvasSearchUnavailable) closeCanvasSearch({ restoreFocus: false });
  }, [isCanvasSearchUnavailable, isSearchOpen]);

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
        className={`workspace ${isTextFormattingVisible ? "has-text-formatting" : ""} ${isShapeTextEditing ? "is-shape-text-editing" : ""} ${isPropertiesPanelOpen && availableDrawingPropertiesContext ? "has-compact-properties" : ""}`}
        inert={
          isAssistantOverlayOpen || isExplorerOverlayOpen ? true : undefined
        }
      >
        <PageHeader
          activeTextEditor={activeTextEditor}
          assistantToggleButtonRef={assistantToggleButtonRef}
          canvasSearchButtonRef={canvasSearchButtonRef}
          isAssistantOpen={shouldRenderAssistantPanel}
          isCanvasSearchUnavailable={isCanvasSearchUnavailable}
          isGridVisible={isGridVisible}
          isDarkMode={isDarkMode}
          isEditingHeaderTitle={isEditingHeaderTitle}
          isSnapToGridEnabled={isSnapToGridEnabled}
          isTextFormattingVisible={isTextFormattingVisible}
          openPages={openPages}
          selectedPageId={selectedPageId}
          textFormatState={textFormatState}
          titleSearchHighlights={titleSearchHighlights}
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

        {activeKeyboardShapeLabel ? (
          <span className="canvas-accessibility-status" id="canvas-shape-authoring-instruction">
            {`${activeKeyboardShapeLabel} tool selected. Drag to draw, or press Enter to add a default ${activeKeyboardShapeLabel.toLowerCase()} in the current viewport.`}
          </span>
        ) : null}
        <CanvasViewport
          describedBy={activeKeyboardShapeLabel ? "canvas-shape-authoring-instruction" : undefined}
          labelledBy={
            selectedPageId ? getWorkspaceTabId(selectedPageId) : undefined
          }
          activeMode={activeMode}
          activeTool={activeTool}
          id={WORKSPACE_PAGE_PANEL_ID}
          isInteractionDisabled={isSearchOpen}
          isKeyboardShapeCreationAvailable={activeKeyboardShapeLabel !== null}
          onDoubleClick={canvasInteraction.handleDoubleClick}
          onLostPointerCapture={(event) => {
            inkInteraction.handlePointerCancelCapture(event);
            canvasInteraction.handlePointerCancel(event);
          }}
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
            <div
              className="canvas-authoring-controls"
              inert={isSearchOpen ? true : undefined}
              onPointerDown={(event) => event.stopPropagation()}
            >
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
                isBackgroundModeDisabled={availableDrawingPropertiesContext.isBackgroundModeDisabled}
                isCompactOpen={isPropertiesPanelOpen}
                isInert={isSearchOpen}
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
              inert={isSearchOpen ? true : undefined}
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
            <div
              className="search-panel"
              inert={isCanvasSearchUnavailable ? true : undefined}
              onPointerDownCapture={(event) => {
                if (isCanvasSearchInteractionBlocked()) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onKeyDown={(event) => {
                if (isCanvasSearchInteractionBlocked()) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeCanvasSearch();
                  return;
                }
                if (event.key !== "Tab") return;
                const focusableControls = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    'input:not([disabled]), button:not([disabled])',
                  ),
                );
                const firstControl = focusableControls[0];
                const lastControl = focusableControls[focusableControls.length - 1];
                if (!firstControl || !lastControl) return;
                if (event.shiftKey && document.activeElement === firstControl) {
                  event.preventDefault();
                  lastControl.focus();
                } else if (!event.shiftKey && document.activeElement === lastControl) {
                  event.preventDefault();
                  firstControl.focus();
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="search-panel-query">
                <HeroIcon name="magnifying-glass" />
                <input
                  aria-describedby="canvas-search-paused-description canvas-search-status"
                  aria-label="Find in canvas"
                  disabled={isCanvasSearchUnavailable}
                  onChange={(event) => {
                    if (!isCanvasSearchInteractionBlocked()) setSearchQuery(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (isCanvasSearchInteractionBlocked()) {
                      event.preventDefault();
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      focusSearchMatch(
                        activeSearchIndex + (event.shiftKey ? -1 : 1),
                      );
                    }

                  }}
                  placeholder="Find in canvas"
                  ref={searchInputRef}
                  value={searchQuery}
                />
              </div>
              <span
                aria-atomic="true"
                aria-live="polite"
                className="search-panel-count"
                id="canvas-search-status"
                role="status"
              >
                <span aria-hidden="true">
                  {canvasSearchResultLabel}
                  {hasCanvasSearchQuery && searchMatches.length > 0 ? (
                    <small>{canvasSearchSourceLabel}</small>
                  ) : null}
                </span>
                <span className="search-status-announcement">{canvasSearchStatusLabel}</span>
              </span>
              <div className="search-panel-actions">
                <button
                  aria-label="Previous match"
                  disabled={searchMatches.length === 0 || isCanvasSearchUnavailable}
                  onClick={() => focusSearchMatch(activeSearchIndex - 1)}
                  title="Previous match"
                  type="button"
                >
                  <HeroIcon name="chevron-up" />
                </button>
                <button
                  aria-label="Next match"
                  disabled={searchMatches.length === 0 || isCanvasSearchUnavailable}
                  onClick={() => focusSearchMatch(activeSearchIndex + 1)}
                  title="Next match"
                  type="button"
                >
                  <HeroIcon name="chevron-down" />
                </button>
                <button
                  aria-label="Close search"
                  disabled={isCanvasSearchUnavailable}
                  onClick={() => {
                    closeCanvasSearch();
                  }}
                  title="Close search"
                  type="button"
                >
                  <HeroIcon name="x-mark" />
                </button>
              </div>
              <span className="search-panel-paused-cue" id="canvas-search-paused-description">
                Canvas interactions paused while Find is open.
              </span>
            </div>
          ) : null}
          <CanvasWorldLayer
            isGridVisible={isGridVisible}
            isInert={isSearchOpen}
            liveDraftLayerRef={liveDraftLayerRef}
            panOffset={searchPanOffset ?? panOffset}
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
                    isSelected={selectedBlockIds.includes(connector.id)}
                    onElementChange={registerBlockElement}
                    onKeyboardMove={moveCanvasElementByKeyboard}
                    onSelect={selectBlock}
                  />
                )}
                renderInk={(inkElement) => (
                  <InkElementView
                    element={inkElement}
                    isDragSourceHidden={false}
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
                    activeSearchRange={
                      activeSearchMatch?.elementId === shape.id ? activeSearchMatch : null
                    }
                    canvasTheme={isDarkMode ? "dark" : "light"}
                    element={shape}
                    isEditing={shape.id === editingBlockId}
                    isSelected={selectedBlockIds.includes(shape.id)}
                    onActiveEditorChange={setActiveTextEditor}
                    onEdit={editBlock}
                    onEditEnd={endBlockEdit}
                    onEditSessionChange={registerShapeTextEditSession}
                    onElementChange={registerBlockElement}
                    onKeyboardMove={moveCanvasElementByKeyboard}
                    onSelect={selectBlock}
                    onTextCommit={updateShapeText}
                    searchRanges={getCanvasSearchRangesForElement(searchMatchesByElementId, shape.id)}
                    searchableText={canvasSearchTextIndex.get(shape.id) ?? ""}
                  />
                )}
                renderText={(block) => (
                  <TextBlockView
                block={block}
                activeSearchRange={
                  activeSearchMatch?.elementId === block.id ? activeSearchMatch : null
                }
                isEditing={block.id === editingBlockId}
                isDragSourceHidden={false}
                interactionCancellationKey={`${activeTool}:${selectedPageId ?? ""}`}
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
                onBlockElementChange={registerBlockElement}
                onKeyboardMove={moveCanvasElementByKeyboard}
                onKeyboardResize={resizeTextWidthByKeyboard}
                onSelect={selectBlock}
                onUpdate={updateBlock}
                onVisualDragCancel={cancelVisualDrag}
                onVisualDragEnd={endVisualDrag}
                onVisualDragMove={moveVisualDrag}
                onVisualDragStart={startVisualDrag}
                searchRanges={getCanvasSearchRangesForElement(searchMatchesByElementId, block.id)}
                searchableText={canvasSearchTextIndex.get(block.id) ?? ""}
                shouldFocusEnd={focusEndBlockId === block.id}
                zoomLevel={zoomLevel}
                  />
                )}
                renderImage={(block) => (
                  <ImageElementView
                  element={block}
                  imageSource={imageSourcesByAssetIdRef.current.get(block.assetId)}
                  isDragSourceHidden={false}
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
            {canvasInteraction.arrowAuthoringVisual ? (
              <ConnectorBindingTargetHighlight
                isSnapped={canvasInteraction.arrowAuthoringVisual.isSnapped}
                target={canvasInteraction.arrowAuthoringVisual.target}
              />
            ) : isConnectorEndpointRetargeting && connectorEndpointRetargetVisual ? (
              <ConnectorBindingTargetHighlight
                isSnapped={connectorEndpointRetargetVisual.isSnapped}
                target={connectorEndpointRetargetVisual.target}
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
            isInert={isSearchOpen}
            marqueeRef={selectionRectRef}
            selectionFrameRef={selectionFrameRef}
            textResizeHandle={(() => {
              const selectedId = selectedBlockIds.length === 1 ? selectedBlockIds[0] : null;
              const selected = selectedId
                ? visibleCanvasElements.find((element): element is TextElement =>
                  element.id === selectedId && element.type === "text" && !element.locked,
                )
                : null;
              if (!selected || activeTool !== "select" || editingBlockId) return undefined;
              const handleBlock = textResizeHandleGeometry?.id === selected.id
                ? textResizeHandleGeometry
                : selected;
              const point = getTextEastResizeHandlePoint(handleBlock);
              return {
                cursorClass: getTextResizeCursorClass(handleBlock.rotation),
                onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  event.stopPropagation();
                  resizeTextWidthByKeyboard(
                    selected.id,
                    event.key === "ArrowLeft" ? -1 : 1,
                    zoomLevelRef.current,
                  );
                },
                onLostPointerCapture: (event: ReactPointerEvent<HTMLButtonElement>) => finishSelectionFrameInteraction(event, true),
                onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => finishSelectionFrameInteraction(event, true),
                onPointerDown: startTextResizeInteraction,
                onPointerMove: moveSelectionFrameInteraction,
                onPointerUp: finishSelectionFrameInteraction,
                ref: textResizeHandleRef,
                rotation: handleBlock.rotation,
                x: panOffset.x + point.x * zoomLevel,
                y: panOffset.y + point.y * zoomLevel,
              };
            })()}
            selectionFrame={(() => {
              const bounds = selectionFramePreview ?? selectionWorldBounds;
              const isKeyboardArrowEndpointAccess = activeTool === "arrow"
                && selectedBlockIds.length === 1
                && selectedBlockIds[0] === keyboardArrowEndpointAccessId;
              if (
                (activeTool !== "select" && !isKeyboardArrowEndpointAccess)
                || !bounds
                || selectedBlockIds.length === 0
                || editingBlockId
              ) return undefined;
              const selected = selectedBlockIds.length === 1
                ? connectorEndpointPreview?.id === selectedBlockIds[0]
                  ? connectorEndpointPreview
                  : visibleCanvasElements.find((block) => block.id === selectedBlockIds[0])
                : undefined;
              if (selectedBlockIds.length === 1 && selected?.type === "text") return undefined;
              const usesNativeSingleElementInteraction = Boolean(
                selected && (selected.type === "text" || selected.type === "image"),
              );
              const framePadding = SELECTION_FRAME_PADDING_PX;
              const resizeCorners: readonly SelectionCorner[] = !selectionHasUnlockedElements
                ? []
                : selectedBlockIds.length > 1
                  ? ["nw", "ne", "se", "sw"]
                  : selected?.type === "shape"
                    ? ["nw", "ne", "se", "sw"]
                    : [];
              const connectorEndpointPoints = selected?.type === "connector"
                ? resolveConnectorPoints(selected, renderedCanvasElementsById)
                : null;
              const connectorEndpointHandles = selected?.type === "connector" && !selected.locked && connectorEndpointPoints?.start && connectorEndpointPoints.end
                ? ([
                  { endpoint: "start" as const, point: connectorEndpointPoints.start },
                  { endpoint: "end" as const, point: connectorEndpointPoints.end },
                ]).map(({ endpoint, point }) => ({
                    description: getConnectorEndpointDescription(selected, endpoint),
                    endpoint,
                    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        openConnectorEndpointChooser(endpoint, event.currentTarget);
                        return;
                      }
                      moveConnectorEndpointByKeyboard(endpoint)(event);
                    },
                    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => startSelectionFrameInteraction(event, null, endpoint),
                    x: (point.x - bounds.x) * zoomLevel + framePadding,
                    y: (point.y - bounds.y) * zoomLevel + framePadding,
                  }))
                : undefined;
              return {
                connectorEndpointHandles,
                height: bounds.height * zoomLevel + framePadding * 2,
                moveLabel: selectionHasLockedElements ? "Move unlocked selected elements" : "Move selected elements",
                onMoveKeyDown: moveSelectionByKeyboard,
                onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => finishSelectionFrameInteraction(event, true),
                onLostPointerCapture: (event: ReactPointerEvent<HTMLButtonElement>) => finishSelectionFrameInteraction(event, true),
                onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => startSelectionFrameInteraction(event, null),
                onPointerMove: moveSelectionFrameInteraction,
                onPointerUp: finishSelectionFrameInteraction,
                onResizeKeyDown: resizeSelectionByKeyboard,
                onResizePointerDown: (corner: SelectionCorner) => (event: ReactPointerEvent<HTMLButtonElement>) => startSelectionFrameInteraction(event, corner),
                preserveNativeSoutheastHandle: selected?.type === "ink",
                resizeLabel: (corner: SelectionCorner) => selectionHasLockedElements
                  ? `Resize unlocked selected elements from ${corner}`
                  : `Resize selected elements from ${corner}`,
                resizeCorners,
                showMoveSurface: activeTool === "select" && selectionHasUnlockedElements && !usesNativeSingleElementInteraction,
                width: bounds.width * zoomLevel + framePadding * 2,
                x: panOffset.x + bounds.x * zoomLevel - framePadding,
                y: panOffset.y + bounds.y * zoomLevel - framePadding,
              };
            })()}
          >
            {suppressedConnectorControls.map(({ connector, label, placement }) => (
              <SuppressedConnectorControl
                connectorId={connector.id}
                isLocked={connector.locked}
                isSelected={selectedBlockIds.length === 1 && selectedBlockIds[0] === connector.id}
                key={connector.id}
                label={label}
                left={placement.left}
                onDelete={() => {
                  if (!deleteBlocks([connector.id])) return;
                  setConnectorBindingAnnouncement(`Deleted ${label}. Undo is available.`);
                  setActiveMode("canvas");
                  window.requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }));
                }}
                onManageEndpoint={(endpoint, origin) => openConnectorEndpointChooser(endpoint, origin)}
                onSelect={() => selectBlock(connector.id)}
                side={placement.side}
                top={placement.top}
              />
            ))}
          </CanvasInteractionOverlay>
          {connectorEndpointChooser && (() => {
            const connector = visibleCanvasElements.find((element): element is ConnectorElement =>
              element.id === selectedBlockIds[0] && element.type === "connector" && element.style.endArrowhead === "arrow",
            );
            if (!connector) return null;
            const chooserEndpoint = connector[connectorEndpointChooser.endpoint];
            const targets = getConnectorBindingTargetsForEndpoint(connector, connectorEndpointChooser.endpoint)
              .map(({ element, label }) => ({ id: element.id, label }));
            return (
              <ConnectorEndpointChooser
                endpoint={connectorEndpointChooser.endpoint}
                isBound={chooserEndpoint.kind === "element"}
                isDarkMode={isDarkMode}
                onBind={bindSelectedConnectorEndpoint}
                onClose={closeConnectorEndpointChooser}
                onDetach={detachSelectedConnectorEndpoint}
                onSelectTarget={(targetElementId) => setConnectorEndpointChooser((current) =>
                  current ? { ...current, targetElementId } : current,
                )}
                statusMessage={connectorBindingAnnouncement}
                targets={targets}
                targetElementId={connectorEndpointChooser.targetElementId}
              />
            );
          })()}
          <div aria-atomic="true" aria-live="polite" className="canvas-accessibility-status" role="status">
            {connectorBindingAnnouncement}
          </div>
          {shouldShowStarterShortcuts ? (
            <div
              className="canvas-starter"
              aria-label="Empty workspace shortcuts"
              inert={isSearchOpen ? true : undefined}
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
  canvasSearchButtonRef,
  isAssistantOpen,
  isGridVisible,
  isDarkMode,
  isCanvasSearchUnavailable,
  isEditingHeaderTitle,
  isSnapToGridEnabled,
  isTextFormattingVisible,
  openPages,
  selectedPageId,
  textFormatState,
  titleSearchHighlights,
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
        titleSearch={{ pageId: selectedPageId, ranges: titleSearchHighlights }}
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
            disabled={isCanvasSearchUnavailable}
            onClick={(event) => {
              if (isCanvasSearchUnavailable) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }

              onFocusCanvasSearch(event.currentTarget);
            }}
            onPointerDown={(event) => {
              if (isCanvasSearchUnavailable) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            ref={canvasSearchButtonRef}
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
    previous.isCanvasSearchUnavailable === next.isCanvasSearchUnavailable &&
    previous.isEditingHeaderTitle === next.isEditingHeaderTitle &&
    previous.isSnapToGridEnabled === next.isSnapToGridEnabled &&
    previous.isTextFormattingVisible === next.isTextFormattingVisible &&
    previous.openPages === next.openPages &&
    previous.selectedPageId === next.selectedPageId &&
    previous.textFormatState === next.textFormatState &&
    previous.titleSearchHighlights === next.titleSearchHighlights &&
    previous.zoomLevel === next.zoomLevel
  );
}

export default App;
