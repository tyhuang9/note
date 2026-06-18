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
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEditorState } from "@tiptap/react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import {
  AIProvidersSettings,
  type ProviderConnectionState,
} from "./components/AIProvidersSettings";
import { AssistantPanel } from "./components/AssistantPanel";
import { InlineRename } from "./components/InlineRename";
import { TextBlockView } from "./components/TextBlockView";
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_BLOCK_WIDTH,
  DEFAULT_ZOOM,
  GRID_SIZE,
  MAX_ZOOM,
  MIN_ZOOM,
  SAVE_DELAY_MS,
  ZOOM_STEP,
} from "./constants";
import type {
  BlockUpdates,
  CanvasPoint,
  CanvasSize,
  InsertionPoint,
  InteractionMode,
  OffscreenGroup,
  PanOffset,
  PageViewport,
  PanState,
  SearchMatch,
  SelectionRect,
  SelectionState,
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
  getSelectionRect,
  isTextEntryTarget,
  rectsIntersect,
} from "./editorUtils";
import {
  callOpenAICompatibleWhisperTranscription,
  DEFAULT_LOCAL_STT_CONFIG,
} from "./services/localModelProviders";
import { listAIProviderModels, testAIProvider } from "./services/aiProviderAdapters";
import { buildAssistantActionRequest, validateAssistantActionRequest } from "./services/assistantActions";
import {
  createAIProvider,
  deleteProviderCredential,
  loadAIProviderSettings,
  saveAIProviderSettings,
} from "./services/aiProviderStorage";
import { buildNotesContext } from "./services/notesContext";
import {
  getLlamaHarnessSetupStatus,
  listLlamaHarnessAgents,
  patchLlamaHarnessAgent,
  sendLlamaHarnessAgentChat,
  type LlamaHarnessAgent,
  type LlamaHarnessAgentPatch,
  type LlamaHarnessSetupStatus,
  type LlamaHarnessToolCall,
} from "./services/llamaHarnessAssistant";
import type { AppData, TextBlock } from "./types";

type SidebarProps = {
  bookmarkedPages: AppData["pages"];
  editingFolderId: string | null;
  editingPageId: string | null;
  folders: AppData["folders"];
  isCollapsed: boolean;
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
  onDeleteFolder: (folderId: string) => void;
  onDeletePage: (pageId: string) => void;
  onFolderDragLeave: (folderId: string) => void;
  onFolderDragOver: (folderId: string) => void;
  onFocusPageSearch: () => void;
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
  onToggleCollapse: () => void;
  onTogglePageBookmark: (pageId: string) => void;
  pageDropTargetFolderId: string | null;
  draggedPageIds: string[];
  selectedPageIds: string[];
};

type PageHeaderProps = {
  activeTextEditor: Editor | null;
  canCreatePageFromTemplate: boolean;
  isAssistantOpen: boolean;
  isGridVisible: boolean;
  isDarkMode: boolean;
  isEditingHeaderTitle: boolean;
  isSnapToGridEnabled: boolean;
  openPages: OpenPageTab[];
  pageTemplates: AppData["pages"];
  selectedPage: AppData["pages"][number] | undefined;
  selectedPageId: string;
  textFormatState: TextFormatState;
  zoomLevel: number;
  onClosePageTab: (pageId: string) => void;
  onCreatePage: () => void;
  onCreatePageFromTemplate: (templatePageId: string) => void;
  onCreateTemplateFromPage: () => void;
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
  onToggleAssistant: () => void;
  onToggleGrid: () => void;
  onTogglePageBookmark: (pageId: string) => void;
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
  startClientX: number;
  startClientY: number;
  startPanOffset: PanOffset;
  zoomLevel: number;
};

type CopiedBlock = Omit<TextBlock, "id" | "pageId" | "x" | "y"> & {
  offsetX: number;
  offsetY: number;
};

type CopiedPageBlock = Omit<TextBlock, "id" | "pageId">;

type CopiedPage = Omit<AppData["pages"][number], "id" | "folderId"> & {
  blocks: CopiedPageBlock[];
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
const PAGE_TAB_DRAG_MIME_TYPE = "application/x-note-page-tab";
const ROOT_FOLDER_ID = "";
const PASTED_BLOCK_OFFSET = 24;
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

type HeroIconName =
  | "adjustments-horizontal"
  | "archive-box"
  | "arrows-up-down"
  | "bookmark"
  | "bold"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "chevron-up"
  | "code-bracket"
  | "document-plus"
  | "document-text"
  | "eye"
  | "eye-slash"
  | "folder"
  | "folder-plus"
  | "italic"
  | "list-bullet"
  | "magnifying-glass"
  | "moon"
  | "numbered-list"
  | "panel"
  | "pencil-square"
  | "plus"
  | "quote"
  | "rectangle-stack"
  | "sparkles"
  | "squares-2x2"
  | "star"
  | "strikethrough"
  | "sun"
  | "trash"
  | "underline"
  | "x-mark";

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

function assistantActionKindFromToolName(name: string | undefined): AssistantActionKind | null {
  switch (name) {
    case "insert_text_block":
      return "insert-text-block";
    case "append_to_selected_block":
      return "append-to-selected-block";
    case "replace_selected_block":
      return "replace-selected-block";
    default:
      return null;
  }
}

function parseToolCallArguments(args: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) {
    return {};
  }

  if (typeof args !== "string") {
    return args;
  }

  try {
    const parsed = JSON.parse(args) as unknown;

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
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

function HeroIcon({ name }: { name: HeroIconName }) {
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

function getBlockRichContent(block: TextBlock) {
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
  block: TextBlock,
  formatState: TextFormatState,
): TextBlock {
  return {
    ...block,
    richContent: applyTextStyleToRichContent(
      getBlockRichContent(block),
      formatState,
    ),
  };
}

function applyFormatStateToBlock(
  block: TextBlock,
  formatId: ToolbarActionId,
  formatState: TextFormatState,
): TextBlock {
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
  const [isGridVisible, setIsGridVisible] = useState(false);
  const [isSnapToGridEnabled, setIsSnapToGridEnabled] = useState(false);
  const [dragSourceBlockIds, setDragSourceBlockIds] = useState<string[]>([]);
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
  const dataRef = useRef<AppData>(data);
  const canvasRef = useRef<HTMLElement | null>(null);
  const canvasContentRef = useRef<HTMLDivElement | null>(null);
  const selectionRectRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const canvasViewportRef = useRef<ViewportRect | null>(null);
  const panState = useRef<PanState | null>(null);
  const panOffsetRef = useRef<PanOffset>(panOffset);
  const panRafId = useRef<number | null>(null);
  const selectionState = useRef<SelectionState | null>(null);
  const selectionRafId = useRef<number | null>(null);
  const pendingSelectionRect = useRef<SelectionRect | null>(null);
  const searchCache = useRef<Map<string, SearchMatch[]>>(new Map());
  const copiedBlocksRef = useRef<CopiedBlock[]>([]);
  const copiedPagesRef = useRef<CopiedPage[]>([]);
  const copiedContentKindRef = useRef<"blocks" | "pages" | null>(null);
  const undoBlockHistoryRef = useRef<TextBlock[][]>([]);
  const redoBlockHistoryRef = useRef<TextBlock[][]>([]);
  const blockElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const dragLayerSessionRef = useRef<DragLayerSession | null>(null);
  const assistantMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const assistantRecordingChunksRef = useRef<Blob[]>([]);
  const assistantRecordingStreamRef = useRef<MediaStream | null>(null);
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

  dataRef.current = data;
  isSnapToGridEnabledRef.current = isGridVisible && isSnapToGridEnabled;
  editingBlockIdRef.current = editingBlockId;
  selectedBlockIdsRef.current = selectedBlockIds;
  selectedFolderIdRef.current = selectedFolderId;
  selectedPageIdRef.current = selectedPageId;
  selectedSidebarPageIdsRef.current = selectedSidebarPageIds;
  textFormatStateRef.current = textFormatState;
  zoomLevelRef.current = zoomLevel;

  const selectedPage = useMemo(
    () => data.pages.find((page) => page.id === selectedPageId),
    [data.pages, selectedPageId],
  );
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
    () => data.blocks.filter((block) => block.pageId === selectedPageId),
    [data.blocks, selectedPageId],
  );
  const openPages = useMemo<OpenPageTab[]>(() => {
    const pagesById = new Map(
      data.pages
        .filter((page) => !isTemplatePage(page))
        .map((page) => [page.id, page]),
    );
    const pageIdsWithBlocks = new Set(data.blocks.map((block) => block.pageId));

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
  }, [data.blocks, data.pages, openPageTabIds]);
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
    const pageBlocks = new Map<string, TextBlock[]>();

    for (const block of data.blocks) {
      const currentBlocks = pageBlocks.get(block.pageId);

      if (currentBlocks) {
        currentBlocks.push(block);
      } else {
        pageBlocks.set(block.pageId, [block]);
      }
    }

    return pageBlocks;
  }, [data.blocks]);
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

    const cacheKey = `${selectedPageId}:${nextQuery}:${visibleBlocks
      .map((block) => `${block.id}:${block.x}:${block.y}:${block.content}`)
      .join("|")}`;
    const cachedMatches = searchCache.current.get(cacheKey);

    if (cachedMatches) {
      return cachedMatches;
    }

    const nextMatches = visibleBlocks
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
        const firstBlock = visibleBlocks.find((block) => block.id === firstMatch.blockId);
        const secondBlock = visibleBlocks.find((block) => block.id === secondMatch.blockId);

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
  canvasViewportRef.current = canvasViewport;
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
    () => llamaHarnessAgents.filter((agent) => agent.status === "active"),
    [llamaHarnessAgents],
  );
  const selectedLlamaHarnessAgent = useMemo(
    () =>
      activeLlamaHarnessAgents.find((agent) => agent.id === selectedLlamaHarnessAgentId) ??
      activeLlamaHarnessAgents[0] ??
      null,
    [activeLlamaHarnessAgents, selectedLlamaHarnessAgentId],
  );
  const assistantAgentLabel = selectedLlamaHarnessAgent
    ? `${selectedLlamaHarnessAgent.name} / ${selectedLlamaHarnessAgent.default_model || "model not set"}`
    : llamaHarnessSetupStatus?.ready
      ? "No active agent selected"
      : "llama-harness setup incomplete";

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

      if (selectionRafId.current !== null) {
        window.cancelAnimationFrame(selectionRafId.current);
      }

      if (dragLayerSessionRef.current) {
        cleanupDragLayerSession(dragLayerSessionRef.current);
        dragLayerSessionRef.current = null;
      }

      stopAssistantRecordingStream();
    };
  }, []);

  useEffect(() => {
    function handleWindowBlur() {
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
    let isMounted = true;

    async function loadData() {
      try {
        const savedData = await invoke<AppData>("load_app_data");

        if (!isMounted) {
          return;
        }

        const firstPage = savedData.pages.find((page) => !isTemplatePage(page));
        const firstFolderId =
          firstPage?.folderId ?? savedData.folders[0]?.id ?? ROOT_FOLDER_ID;
        const firstPageId = firstPage?.id ?? "";

        setData(savedData);
        setIsDarkMode(savedData.isDarkMode ?? true);
        pageViewportsRef.current.clear();
        setSelectedFolderId(firstFolderId);
        setSelectedPageId(firstPageId);
        setOpenPageTabIds(firstPageId ? [firstPageId] : []);
        setSidebarPageSelection(firstPageId ? [firstPageId] : []);
        restorePageViewport(firstPageId);
        setSelectedBlockIds([]);
        setEditingBlockId(null);
        setActiveMode("canvas");
        setInsertionPoint(null);
        setIsEditingHeaderTitle(false);
        setPersistenceAvailable(true);
      } catch (error) {
        console.warn("Could not load local note data.", error);
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
    if (!isLoaded || !persistenceAvailable) {
      return;
    }

    const saveTimer = window.setTimeout(() => {
      invoke("save_app_data", { data: { ...data, isDarkMode } }).catch((error) => {
        console.warn("Could not save local note data.", error);
      });
    }, SAVE_DELAY_MS);

    return () => window.clearTimeout(saveTimer);
  }, [data, isDarkMode, isLoaded, persistenceAvailable]);

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

  function cloneBlocks(blocks: TextBlock[]) {
    return blocks.map((block) => ({ ...block }));
  }

  function cloneRichContent(richContent: TextBlock["richContent"]) {
    return richContent ? structuredClone(richContent) : undefined;
  }

  function cloneCopiedPageBlock(block: TextBlock): CopiedPageBlock {
    const { id: _id, pageId: _pageId, richContent, ...blockFields } = block;

    return {
      ...blockFields,
      ...(richContent ? { richContent: cloneRichContent(richContent) } : {}),
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

  function cloneBlocksForPage(blocks: TextBlock[], pageId: string) {
    return blocks.map((block) => ({
      ...block,
      id: createId("block"),
      pageId,
      richContent: cloneRichContent(block.richContent),
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

  function snapBlockPosition<T extends Pick<TextBlock, "x" | "y">>(block: T): T {
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

  function areBlocksEqual(firstBlocks: TextBlock[], secondBlocks: TextBlock[]) {
    if (firstBlocks.length !== secondBlocks.length) {
      return false;
    }

    return firstBlocks.every((firstBlock, index) => {
      const secondBlock = secondBlocks[index];

      return (
        firstBlock.id === secondBlock.id &&
        firstBlock.pageId === secondBlock.pageId &&
        firstBlock.x === secondBlock.x &&
        firstBlock.y === secondBlock.y &&
        firstBlock.width === secondBlock.width &&
        firstBlock.height === secondBlock.height &&
        firstBlock.content === secondBlock.content &&
        JSON.stringify(firstBlock.richContent) ===
          JSON.stringify(secondBlock.richContent) &&
        firstBlock.isWidthManuallyResized ===
          secondBlock.isWidthManuallyResized &&
        firstBlock.imageData === secondBlock.imageData &&
        firstBlock.imageName === secondBlock.imageName
      );
    });
  }

  function pushBlockUndoSnapshot(blocks: TextBlock[]) {
    undoBlockHistoryRef.current = [
      ...undoBlockHistoryRef.current.slice(-(MAX_BLOCK_HISTORY_ENTRIES - 1)),
      cloneBlocks(blocks),
    ];
    redoBlockHistoryRef.current = [];
  }

  function setBlocksWithHistory(
    getNextBlocks: (currentBlocks: TextBlock[]) => TextBlock[],
  ) {
    const currentData = dataRef.current;
    const nextBlocks = getNextBlocks(currentData.blocks);

    if (areBlocksEqual(currentData.blocks, nextBlocks)) {
      return;
    }

    pushBlockUndoSnapshot(currentData.blocks);

    const nextData = {
      ...currentData,
      blocks: nextBlocks,
    };

    dataRef.current = nextData;
    setData(nextData);
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
    const currentSnapshot = cloneBlocks(currentData.blocks);

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
      blocks: cloneBlocks(snapshot),
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

    copiedBlocksRef.current = blocksToCopy.map(
      ({ id: _id, pageId: _pageId, x, y, richContent, ...block }) => ({
        ...block,
        ...(richContent ? { richContent: cloneRichContent(richContent) } : {}),
        offsetX: x - minX,
        offsetY: y - minY,
      }),
    );
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
        blocks: currentData.blocks
          .filter((block) => block.pageId === page.id)
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
    const pastedBlocks = copiedBlocksRef.current.map((block) => ({
      id: createId("block"),
      pageId: selectedPageId,
      x: pastedGroupOrigin.x + block.offsetX,
      y: pastedGroupOrigin.y + block.offsetY,
      width: block.width,
      height: block.height,
      content: block.content,
      richContent: cloneRichContent(block.richContent),
      isWidthManuallyResized: block.isWidthManuallyResized,
      imageData: block.imageData,
      imageName: block.imageName,
    }));

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
    const pastedBlocks: TextBlock[] = [];

    for (const copiedPage of copiedPagesRef.current) {
      const { blocks, viewport, ...pageFields } = copiedPage;
      const pageId = createId("page");

      pastedPages.push({
        ...pageFields,
        id: pageId,
        folderId,
      });
      pastedBlocks.push(
        ...blocks.map((block) => ({
          ...block,
          id: createId("block"),
          pageId,
          richContent: cloneRichContent(block.richContent),
        })),
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
      blocks: [...currentData.blocks, ...pastedBlocks],
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
    const blockIdsToDelete = new Set(blockIds);

    setBlocksWithHistory((currentBlocks) =>
      currentBlocks.filter(
        (block) => !blockIdsToDelete.has(block.id),
      ),
    );
    setSelectedBlockIds((currentBlockIds) =>
      currentBlockIds.filter((blockId) => !blockIdsToDelete.has(blockId)),
    );
    setEditingBlockId((currentBlockId) =>
      currentBlockId && blockIdsToDelete.has(currentBlockId)
        ? null
        : currentBlockId,
    );
  }, []);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      const currentEditingBlockId = editingBlockIdRef.current;

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

        const visibleBlockIds = visibleBlocks.map((block) => block.id);

        setSelectedBlockIds((currentBlockIds) =>
          areIdSelectionsEqual(currentBlockIds, visibleBlockIds)
            ? currentBlockIds
            : visibleBlockIds,
        );
        setEditingBlockId(null);
        setActiveMode("selected");
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
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        createTextBlock(insertionPoint.x, insertionPoint.y, event.key);
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
        deleteBlocks(selectedBlockIds);
        setActiveMode("canvas");
        return;
      }
    }

    document.addEventListener("keydown", handleKeyboard);

    return () => document.removeEventListener("keydown", handleKeyboard);
  }, [
    deleteBlocks,
    insertionPoint,
    isCanvasKeyboardActive,
    isStarterDismissed,
    isWorkspaceEmpty,
    selectedBlockIds,
    selectedPageId,
    visibleBlocks,
  ]);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (isTextEntryTarget(event.target)) {
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

      if (!insertionPoint) {
        return;
      }

      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const imageItem = clipboardItems.find((item) =>
        item.type.startsWith("image/"),
      );

      if (imageItem) {
        const imageFile = imageItem.getAsFile();

        if (!imageFile) {
          return;
        }

        event.preventDefault();
        const reader = new FileReader();

        reader.onload = () => {
          if (typeof reader.result !== "string") {
            return;
          }

          createImageBlock(
            insertionPoint.x,
            insertionPoint.y,
            reader.result,
            imageFile.name || "Pasted image",
          );
        };
        reader.readAsDataURL(imageFile);
        return;
      }

      const pastedText = event.clipboardData?.getData("text/plain");

      if (pastedText) {
        event.preventDefault();
        createTextBlock(insertionPoint.x, insertionPoint.y, pastedText);
      }
    }

    document.addEventListener("paste", handlePaste);

    return () => document.removeEventListener("paste", handlePaste);
  }, [insertionPoint, selectedPageId]);

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

  function hideSelectionRectangle() {
    const selectionElement = selectionRectRef.current;

    if (!selectionElement) {
      return;
    }

    selectionElement.style.display = "none";
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
        selectionElement.style.display = "block";
        selectionElement.style.left = `${nextRect.x}px`;
        selectionElement.style.top = `${nextRect.y}px`;
        selectionElement.style.width = `${nextRect.width}px`;
        selectionElement.style.height = `${nextRect.height}px`;
      }

      selectionRafId.current = null;
    });
  }

  function getCanvasPoint(clientX: number, clientY: number): CanvasPoint | null {
    const canvasElement = canvasRef.current;

    if (!canvasElement) {
      return null;
    }

    const canvasRect = canvasElement.getBoundingClientRect();

    return {
      x: (clientX - canvasRect.left - panOffsetRef.current.x) / zoomLevel,
      y: (clientY - canvasRect.top - panOffsetRef.current.y) / zoomLevel,
    };
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
        blocks: currentData.blocks.filter(
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

  function focusPageSearch() {
    setIsSidebarCollapsed(false);
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
        setLlamaHarnessAgents([]);
        setAssistantStatus(llamaHarnessSetupMessage(setupStatus));
        return;
      }

      const agents = await listLlamaHarnessAgents();
      const activeAgents = agents.filter((agent) => agent.status === "active");
      setLlamaHarnessAgents(agents);
      setSelectedLlamaHarnessAgentId((currentAgentId) => {
        if (activeAgents.some((agent) => agent.id === currentAgentId)) {
          return currentAgentId;
        }

        return activeAgents[0]?.id ?? "";
      });
      setAssistantStatus(activeAgents.length ? null : "Create or activate an agent in llama-harness.");
    } catch (error) {
      setLlamaHarnessSetupStatus(null);
      setLlamaHarnessAgents([]);
      setAssistantError(`llama-harness is not reachable at http://127.0.0.1:8787. ${getAssistantErrorMessage(error)}`);
      setAssistantStatus(null);
    } finally {
      setIsLlamaHarnessLoading(false);
    }
  }

  async function updateSelectedLlamaHarnessAgent(patch: LlamaHarnessAgentPatch) {
    if (!selectedLlamaHarnessAgent || Object.keys(patch).length === 0) {
      return;
    }

    try {
      const updated = await patchLlamaHarnessAgent(selectedLlamaHarnessAgent.id, patch);
      setLlamaHarnessAgents((agents) =>
        agents.map((agent) => (agent.id === updated.id ? updated : agent)),
      );
      setAssistantStatus("Agent saved in llama-harness");
      setAssistantError(null);
    } catch (error) {
      setAssistantError(getAssistantErrorMessage(error));
      setAssistantStatus(null);
      await refreshLlamaHarnessAssistant().catch(() => undefined);
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

    return sendLlamaHarnessAgentChat({
      agentId: selectedLlamaHarnessAgent.id,
      messages,
      notesContext,
    });
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
      const assistantMessage: AssistantMessage = {
        id: createId("assistant-message"),
        role: "assistant",
        content: response.content,
        createdAt: new Date().toISOString(),
      };

      setAssistantMessages([...nextMessages, assistantMessage]);
      const executedToolCallCount = executeAssistantToolCalls(response.toolCalls);
      if (executedToolCallCount === 0) {
        setAssistantStatus(`Received response from ${assistantAgentLabel}`);
      }
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

      createTextBlock(origin.x, origin.y, action.content);
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

    const selectedBlock = dataRef.current.blocks.find(
      (block) => block.id === selectedBlockId,
    );

    if (!selectedBlock) {
      setAssistantError("The selected text block no longer exists.");
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

  function executeAssistantToolCalls(toolCalls: LlamaHarnessToolCall[]) {
    let executedCount = 0;

    for (const toolCall of toolCalls) {
      const actionKind = assistantActionKindFromToolName(toolCall.function?.name);
      if (!actionKind) {
        continue;
      }

      const args = parseToolCallArguments(toolCall.function?.arguments);
      const action = validateAssistantActionRequest({
        ...args,
        kind: actionKind,
      });

      if (!action.ok) {
        setAssistantError(action.message);
        setAssistantStatus(null);
        continue;
      }

      if (executeAssistantActionRequest(action.request)) {
        executedCount += 1;
      }
    }

    return executedCount;
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
      currentData.blocks.filter((block) => block.pageId === sourcePageId),
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
      blocks: [...currentData.blocks, ...templateBlocks],
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
      blocks: [
        ...currentData.blocks,
        ...cloneBlocksForPage(
          currentData.blocks.filter((block) => block.pageId === templatePageId),
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
        blocks: currentData.blocks.filter((block) => block.pageId !== pageId),
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

  function createTextBlock(x: number, y: number, content: string) {
    if (!selectedPageId) {
      return;
    }

    const blockId = createId("block");
    const blockPosition = snapPoint({ x, y });
    const formattedRichContent = createFormattedRichContent(
      content,
      textFormatStateRef.current,
    );

    setBlocksWithHistory((currentBlocks) => [
      ...currentBlocks,
      {
        id: blockId,
        pageId: selectedPageId,
        x: blockPosition.x,
        y: blockPosition.y,
        width: DEFAULT_BLOCK_WIDTH,
        height: DEFAULT_BLOCK_HEIGHT,
        content,
        ...(formattedRichContent ? { richContent: formattedRichContent } : {}),
        isWidthManuallyResized: false,
      },
    ]);
    editingBlockIdRef.current = blockId;
    setSelectedBlockIds([blockId]);
    setEditingBlockId(blockId);
    setFocusEndBlockId(blockId);
    setIsCanvasKeyboardActive(true);
    setActiveMode("editing");
    setInsertionPoint(null);
  }

  function createImageBlock(
    x: number,
    y: number,
    imageData: string,
    imageName: string,
  ) {
    if (!selectedPageId) {
      return;
    }

    const blockId = createId("block");
    const blockPosition = snapPoint({ x, y });

    setBlocksWithHistory((currentBlocks) => [
      ...currentBlocks,
      {
        id: blockId,
        pageId: selectedPageId,
        x: blockPosition.x,
        y: blockPosition.y,
        width: 320,
        height: 220,
        content: imageName,
        isWidthManuallyResized: true,
        imageData,
        imageName,
      },
    ]);
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
      const nextBlocks = currentData.blocks.map((block) => {
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
        return { ...block, ...nextUpdates };
      });

      return didChange ? { ...currentData, blocks: nextBlocks } : currentData;
    });
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
      const requestedBlockIds = isGroupDrag ? currentSelectedBlockIds : [originId];
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
      setBlocksWithHistory((currentBlocks) =>
        currentBlocks.map((block) =>
          blockIdsToMove.has(block.id)
            ? snapBlockPosition({
                ...block,
                x: block.x + offset.x,
                y: block.y + offset.y,
              })
            : block,
        ),
      );
    }

    selectDraggedBlocks(dragSession.blockIds);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
  }, []);

  const cancelVisualDrag = useCallback(() => {
    const dragSession = dragLayerSessionRef.current;

    if (!dragSession) {
      return;
    }

    cleanupDragLayerSession(dragSession);
    dragLayerSessionRef.current = null;
    setDragSourceBlockIds([]);
    setActiveMode("selected");
  }, []);

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

  const endBlockEdit = useCallback(() => {
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
    updateBlockFormat: (block: TextBlock) => TextBlock,
  ) {
    const selectedIds = new Set(selectedBlockIdsRef.current);

    if (selectedIds.size === 0) {
      return;
    }

    setBlocksWithHistory((currentBlocks) =>
      currentBlocks.map((block) =>
        selectedIds.has(block.id) && !block.imageData
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

  function selectCanvas() {
    leaveTextEditing();
    setSelectedBlockIds([]);
    hideSelectionRectangle();
    setIsCanvasKeyboardActive(true);
    setActiveMode("canvas");
  }

  function isCanvasBackgroundTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if (
      target.closest(
        ".text-block, .offscreen-indicators, .search-panel, .canvas-starter",
      )
    ) {
      return false;
    }

    return target.closest(".canvas, .canvas-content, .canvas-grid") !== null;
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

  function startCanvasPan(event: React.PointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    leaveTextEditing();
    panState.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: panOffsetRef.current.x,
      startPanY: panOffsetRef.current.y,
      currentPanX: panOffsetRef.current.x,
      currentPanY: panOffsetRef.current.y,
    };
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("panning");
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startCanvasInteraction(event: React.PointerEvent<HTMLElement>) {
    if (!isCanvasBackgroundTarget(event.target)) {
      return;
    }

    selectCanvas();
    event.preventDefault();

    if (event.button === 2) {
      startCanvasPan(event);
    } else {
      const startPoint = getCanvasPoint(event.clientX, event.clientY);

      if (!startPoint) {
        return;
      }

      selectionState.current = {
        startX: startPoint.x,
        startY: startPoint.y,
        currentX: startPoint.x,
        currentY: startPoint.y,
        didMove: false,
      };
      setInsertionPoint(startPoint);
      hideSelectionRectangle();
    }

    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateCanvasInteraction(event: React.PointerEvent<HTMLElement>) {
    const currentPan = panState.current;
    const currentSelection = selectionState.current;

    if (!currentPan && !currentSelection) {
      return;
    }

    if (currentPan) {
      const deltaX = event.clientX - currentPan.startClientX;
      const deltaY = event.clientY - currentPan.startClientY;
      const nextPanOffset = {
        x: currentPan.startPanX + deltaX,
        y: currentPan.startPanY + deltaY,
      };

      currentPan.currentPanX = nextPanOffset.x;
      currentPan.currentPanY = nextPanOffset.y;
      scheduleCanvasContentTransform(nextPanOffset);
      return;
    }

    const canvasElement = canvasRef.current;

    if (!currentSelection || !canvasElement) {
      return;
    }

    const currentPoint = getCanvasPoint(event.clientX, event.clientY);

    if (!currentPoint) {
      return;
    }

    currentSelection.currentX = currentPoint.x;
    currentSelection.currentY = currentPoint.y;

    if (
      Math.abs(currentSelection.currentX - currentSelection.startX) > 2 ||
      Math.abs(currentSelection.currentY - currentSelection.startY) > 2
    ) {
      if (!currentSelection.didMove) {
        currentSelection.didMove = true;
        setActiveMode("selecting");
        setInsertionPoint(null);
      }

      scheduleSelectionRectangle(getSelectionRect(currentSelection));
    }
  }

  function endCanvasInteraction(event: React.PointerEvent<HTMLElement>) {
    const currentPan = panState.current;
    const currentSelection = selectionState.current;

    if (!currentPan && !currentSelection) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (currentPan) {
      const nextPanOffset = {
        x: currentPan.currentPanX,
        y: currentPan.currentPanY,
      };

      panOffsetRef.current = nextPanOffset;
      setPanOffset(nextPanOffset);
      setActiveMode("canvas");
    }

    if (currentSelection?.didMove) {
      const nextSelectionRect = getSelectionRect(currentSelection);
      const nextSelectedBlockIds = visibleBlocks
        .filter((block) =>
          rectsIntersect(nextSelectionRect, {
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
          }),
        )
        .map((block) => block.id);

      setSelectedBlockIds(nextSelectedBlockIds);
      setActiveMode(nextSelectedBlockIds.length > 0 ? "selected" : "canvas");
    } else {
      setActiveMode("canvas");
    }

    panState.current = null;
    selectionState.current = null;
    pendingSelectionRect.current = null;
    hideSelectionRectangle();
  }

  function handleCanvasWheel(event: React.WheelEvent<HTMLElement>) {
    event.preventDefault();

    if (event.metaKey || event.ctrlKey) {
      updateZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
      return;
    }

    const shiftScrollDelta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    const nextPanOffset = {
      x:
        panOffsetRef.current.x -
        (event.shiftKey ? shiftScrollDelta : event.deltaX),
      y: panOffsetRef.current.y - (event.shiftKey ? 0 : event.deltaY),
    };

    panOffsetRef.current = nextPanOffset;
    setLivePanOffset(nextPanOffset);
    setPanOffset(nextPanOffset);
  }

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
    <main
      className={`app-shell ${isDarkMode ? "is-dark" : ""} ${
        isSidebarCollapsed ? "is-sidebar-collapsed" : ""
      } ${isAssistantOpen ? "has-assistant-panel" : ""}`}
    >
      <Sidebar
        bookmarkedPages={bookmarkedPages}
        editingFolderId={editingFolderId}
        editingPageId={editingPageId}
        folders={data.folders}
        isCollapsed={isSidebarCollapsed}
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
        onDeleteFolder={deleteFolder}
        onDeletePage={deletePage}
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
        onToggleCollapse={() =>
          setIsSidebarCollapsed((currentValue) => !currentValue)
        }
        onTogglePageBookmark={togglePageBookmark}
        pageDropTargetFolderId={pageDropTargetFolderId}
        draggedPageIds={draggedPageIds}
        selectedPageIds={selectedSidebarPageIds}
      />

      <section className="workspace">
        <PageHeader
          activeTextEditor={activeTextEditor}
          canCreatePageFromTemplate={true}
          isAssistantOpen={isAssistantOpen}
          isGridVisible={isGridVisible}
          isDarkMode={isDarkMode}
          isEditingHeaderTitle={isEditingHeaderTitle}
          isSnapToGridEnabled={isSnapToGridEnabled}
          openPages={openPages}
          pageTemplates={pageTemplates}
          selectedPage={selectedPage}
          selectedPageId={selectedPageId}
          textFormatState={textFormatState}
          zoomLevel={zoomLevel}
          onClosePageTab={closePageTab}
          onCreatePage={createPage}
          onCreatePageFromTemplate={createPageFromTemplate}
          onCreateTemplateFromPage={createTemplateFromSelectedPage}
          onFocusCanvasSearch={focusCanvasSearch}
          onPointerDown={handleChromePointerDown}
          onRenamePage={renamePage}
          onReorderPageTab={reorderPageTab}
          onSelectPageTab={selectPage}
          onSetEditingHeaderTitle={setIsEditingHeaderTitle}
          onToggleAssistant={() =>
            setIsAssistantOpen((currentValue) => !currentValue)
          }
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
          onTogglePageBookmark={togglePageBookmark}
          onToggleSnapToGrid={() =>
            setIsSnapToGridEnabled((currentValue) =>
              isGridVisible ? !currentValue : false,
            )
          }
          onSetTextFontFamily={setTextFontFamily}
          onSetTextFontSize={setTextFontSize}
          onToggleTextFormat={toggleTextFormat}
        />

        <section
          className={`canvas ${activeMode === "canvas" ? "is-canvas-selected" : ""} ${
            activeMode === "panning" ? "is-panning" : ""
          } ${activeMode === "selecting" ? "is-selecting" : ""
          }`}
          aria-label="Freeform note canvas"
          onPointerCancel={endCanvasInteraction}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={startCanvasInteraction}
          onPointerMove={updateCanvasInteraction}
          onPointerUp={endCanvasInteraction}
          onWheel={handleCanvasWheel}
          ref={canvasRef}
        >
          {offscreenGroups.length > 0 ? (
            <div className="offscreen-indicators" aria-label="Offscreen textboxes">
              {offscreenGroups.map((group) => (
                <button
                  aria-label={`${group.count} textboxes offscreen ${group.direction}`}
                  className={`offscreen-arrow offscreen-${group.direction}`}
                  key={group.direction}
                  onClick={(event) => {
                    event.stopPropagation();
                    panToOffscreenGroup(group.direction);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  type="button"
                >
                  <span>{group.count}</span>
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
          <div
            className="canvas-content"
            ref={canvasContentRef}
            style={{
              transform: `translate3d(${panOffset.x}px, ${panOffset.y}px, 0) scale(${zoomLevel})`,
            }}
          >
            {isGridVisible ? <div className="canvas-grid" /> : null}
            {visibleBlocks.map((block) => (
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
                onCanvasPanEnd={endCanvasInteraction}
                onCanvasPanMove={updateCanvasInteraction}
                onCanvasPanStart={startCanvasPan}
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
            ))}
            <div className="selection-rectangle" ref={selectionRectRef} />
            {insertionPoint ? (
              <div
                className="canvas-caret"
                style={{
                  left: insertionPoint.x,
                  top: insertionPoint.y,
                }}
              />
            ) : null}
          </div>
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
                onClick={focusPageSearch}
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
        </section>
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
      {isAssistantOpen ? (
        <AssistantPanel
          assistantError={assistantError}
          assistantStatus={assistantStatus}
          defaultChatModelLabel={assistantAgentLabel}
          harnessAgents={activeLlamaHarnessAgents}
          harnessAgentModel={selectedLlamaHarnessAgent?.default_model ?? ""}
          harnessAgentName={selectedLlamaHarnessAgent?.name ?? ""}
          harnessAgentSystemPrompt={selectedLlamaHarnessAgent?.system_prompt ?? ""}
          isHarnessLoading={isLlamaHarnessLoading}
          isHarnessReady={Boolean(llamaHarnessSetupStatus?.ready)}
          inputValue={assistantInput}
          isRecording={isAssistantRecording}
          isSending={isAssistantSending}
          messages={assistantMessages}
          onClose={() => setIsAssistantOpen(false)}
          onInputChange={setAssistantInput}
          onRefreshHarness={refreshLlamaHarnessAssistant}
          onRunAction={runAssistantAction}
          onSaveHarnessAgent={updateSelectedLlamaHarnessAgent}
          onSend={sendAssistantMessage}
          onSelectHarnessAgent={setSelectedLlamaHarnessAgentId}
          onToggleRecording={toggleAssistantRecording}
          selectedHarnessAgentId={selectedLlamaHarnessAgent?.id ?? ""}
        />
      ) : null}
    </main>
  );
}

const Sidebar = memo(function Sidebar({
  bookmarkedPages,
  editingFolderId,
  editingPageId,
  folders,
  isCollapsed,
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
  onDeleteFolder,
  onDeletePage,
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

  function openSidebarTab(tabId: SidebarTabId) {
    setActiveSidebarTab(tabId);

    if (isCollapsed && tabId !== "search") {
      onToggleCollapse();
    }

    if (tabId === "search") {
      onFocusPageSearch();
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
      onPointerDown={onPointerDown}
    >
      <nav className="activity-rail" aria-label="Primary workspace tools">
        <button
          type="button"
          className="rail-button"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapse}
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <HeroIcon name="panel" />
        </button>
        <div className="rail-tabs" role="tablist" aria-label="Sidebar tabs">
          <button
            type="button"
            className={`rail-button ${activeSidebarTab === "files" ? "is-active" : ""}`}
            aria-label="File explorer"
            aria-selected={activeSidebarTab === "files"}
            onClick={() => openSidebarTab("files")}
            role="tab"
            title="File explorer"
          >
            <HeroIcon name="folder" />
          </button>
          <button
            type="button"
            className={`rail-button ${activeSidebarTab === "search" ? "is-active" : ""}`}
            aria-label="Search files"
            aria-selected={activeSidebarTab === "search"}
            onClick={() => openSidebarTab("search")}
            role="tab"
            title="Search files"
          >
            <HeroIcon name="magnifying-glass" />
          </button>
          <button
            type="button"
            className={`rail-button ${
              activeSidebarTab === "bookmarks" ? "is-active" : ""
            } ${bookmarkedPages.length > 0 ? "has-count" : ""}`}
            aria-label={`${bookmarkedPages.length} favorites`}
            aria-selected={activeSidebarTab === "bookmarks"}
            onClick={() => openSidebarTab("bookmarks")}
            role="tab"
            title="Favorites"
          >
            <HeroIcon name="bookmark" />
          </button>
          <button
            type="button"
            className={`rail-button ${
              activeSidebarTab === "templates" ? "is-active" : ""
            } ${pageTemplates.length > 0 ? "has-count" : ""}`}
            aria-label={`${pageTemplates.length} templates`}
            aria-selected={activeSidebarTab === "templates"}
            onClick={() => openSidebarTab("templates")}
            role="tab"
            title="Templates"
          >
            <HeroIcon name="rectangle-stack" />
          </button>
        </div>
      </nav>

      <div className="sidebar-main">
        {!isCollapsed ? (
          <div className="sidebar-content">
          {activeSidebarTab === "search" ? (
          <section
            className="sidebar-section sidebar-tab-panel sidebar-search"
            aria-labelledby="sidebar-search-title"
            role="tabpanel"
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
            role="tabpanel"
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
              role="tabpanel"
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
              role="tabpanel"
            >
              <div className="section-header">
                <h2 id="templates-title">Templates</h2>
              </div>
              {pageTemplates.length > 0 ? (
                <div className="nav-list">
                  {pageTemplates.map((templatePage) => (
                    <button
                      className="nav-item nav-item-template"
                      key={templatePage.id}
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
  canCreatePageFromTemplate,
  isAssistantOpen,
  isGridVisible,
  isDarkMode,
  isEditingHeaderTitle,
  isSnapToGridEnabled,
  openPages,
  pageTemplates,
  selectedPage,
  selectedPageId,
  textFormatState,
  zoomLevel,
  onClosePageTab,
  onCreatePage,
  onCreatePageFromTemplate,
  onCreateTemplateFromPage,
  onFocusCanvasSearch,
  onPointerDown,
  onRenamePage,
  onReorderPageTab,
  onSelectPageTab,
  onSetEditingHeaderTitle,
  onToggleAssistant,
  onToggleGrid,
  onTogglePageBookmark,
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
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    pageId: string;
    placement: PageTabDropPlacement;
  } | null>(null);

  function getTabDropPlacement(event: DragEvent<HTMLElement>) {
    const tabBounds = event.currentTarget.getBoundingClientRect();

    return event.clientX > tabBounds.left + tabBounds.width / 2
      ? "after"
      : "before";
  }

  function hasPageTabDragData(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes(PAGE_TAB_DRAG_MIME_TYPE);
  }

  return (
    <header
      className="page-header"
      onPointerDown={onPointerDown}
    >
      <div className="page-tabs" role="tablist" aria-label="Open pages">
        {openPages.map((page) => {
          const isActive = page.id === selectedPageId;
          const isEditingThisTab = isActive && isEditingHeaderTitle;
          const isDraggedTab = draggedTabId === page.id;
          const tabDropPlacement =
            tabDropTarget?.pageId === page.id ? tabDropTarget.placement : null;

          return (
            <div
              aria-selected={isActive}
              className={`page-tab ${isActive ? "is-active" : ""} ${
                isEditingThisTab ? "is-editing" : ""
              } ${isDraggedTab ? "is-tab-dragging" : ""} ${
                tabDropPlacement === "before" ? "is-tab-drop-before" : ""
              } ${
                tabDropPlacement === "after" ? "is-tab-drop-after" : ""
              } has-close`}
              draggable={!isEditingThisTab}
              key={page.id}
              onAuxClick={(event) => {
                if (event.button !== 1) {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();
                onClosePageTab(page.id);
              }}
              onDragEnd={() => {
                setDraggedTabId(null);
                setTabDropTarget(null);
              }}
              onDragLeave={(event) => {
                if (
                  event.currentTarget.contains(event.relatedTarget as Node | null)
                ) {
                  return;
                }

                setTabDropTarget((currentTarget) =>
                  currentTarget?.pageId === page.id ? null : currentTarget,
                );
              }}
              onDragOver={(event) => {
                if (!hasPageTabDragData(event)) {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";

                const placement = getTabDropPlacement(event);

                setTabDropTarget({
                  pageId: page.id,
                  placement,
                });
              }}
              onDragStart={(event) => {
                if (isEditingThisTab) {
                  event.preventDefault();
                  return;
                }

                event.stopPropagation();
                setDraggedTabId(page.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PAGE_TAB_DRAG_MIME_TYPE, page.id);
                event.dataTransfer.setData("text/plain", page.title);
              }}
              onDrop={(event) => {
                if (!hasPageTabDragData(event)) {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();

                const sourcePageId =
                  event.dataTransfer.getData(PAGE_TAB_DRAG_MIME_TYPE) ||
                  draggedTabId;

                if (sourcePageId && sourcePageId !== page.id) {
                  onReorderPageTab(
                    sourcePageId,
                    page.id,
                    getTabDropPlacement(event),
                  );
                }

                setDraggedTabId(null);
                setTabDropTarget(null);
              }}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                }
              }}
              role="tab"
            >
              {isEditingThisTab ? (
                <>
                  <HeroIcon name="document-text" />
                  <InlineRename
                    ariaLabel="Page title"
                    initialValue={page.title}
                    onCancel={() => onSetEditingHeaderTitle(false)}
                    onCommit={(value) => {
                      onRenamePage(page.id, value);
                      onSetEditingHeaderTitle(false);
                    }}
                  />
                </>
              ) : (
                <button
                  className="page-tab-main"
                  onClick={() => onSelectPageTab(page.id)}
                  onDoubleClick={() => {
                    if (isActive) {
                      onSetEditingHeaderTitle(true);
                    }
                  }}
                  title={isActive ? "Double-click to rename page" : page.title}
                  type="button"
                >
                  <HeroIcon name="document-text" />
                  <span className="page-title">{page.title}</span>
                </button>
              )}
              <button
                aria-label={`Close ${page.title}`}
                className="page-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onClosePageTab(page.id);
                }}
                title="Close tab"
                type="button"
              >
                <HeroIcon name="x-mark" />
              </button>
            </div>
          );
        })}
        <button
          className="page-tab-add"
          aria-label="Create root page"
          onClick={onCreatePage}
          title="Create root page"
          type="button"
        >
          <HeroIcon name="plus" />
        </button>
      </div>
      <div className="page-header-actions">
        <GlobalTextToolbar
          editor={activeTextEditor && !activeTextEditor.isDestroyed ? activeTextEditor : null}
          formatState={textFormatState}
          onSetFontFamily={onSetTextFontFamily}
          onSetFontSize={onSetTextFontSize}
          onToggleFormat={onToggleTextFormat}
        />
        <button
          aria-label="AI assistant"
          aria-pressed={isAssistantOpen}
          className="header-toggle icon-button"
          onClick={onToggleAssistant}
          title="AI assistant"
          type="button"
        >
          <HeroIcon name="sparkles" />
        </button>
        <button
          aria-label="Find in canvas"
          className="header-toggle icon-button"
          onClick={onFocusCanvasSearch}
          title="Find in canvas (Ctrl+F)"
          type="button"
        >
          <HeroIcon name="magnifying-glass" />
        </button>
        {selectedPage ? (
          <button
            type="button"
            className={`bookmark-toggle header-bookmark-toggle ${
              selectedPage.isBookmarked ? "is-bookmarked" : ""
            }`}
            aria-label={`${
              selectedPage.isBookmarked ? "Remove bookmark from" : "Bookmark"
            } ${selectedPage.title}`}
            aria-pressed={Boolean(selectedPage.isBookmarked)}
            title={selectedPage.isBookmarked ? "Remove bookmark" : "Bookmark"}
            onClick={() => onTogglePageBookmark(selectedPage.id)}
          >
            <HeroIcon name="bookmark" />
          </button>
        ) : null}
        <div className="template-actions">
          <button
            aria-label="Save current page as template"
            className="template-button icon-button"
            disabled={!selectedPage}
            onClick={onCreateTemplateFromPage}
            title="Save current page as template"
            type="button"
          >
            <HeroIcon name="rectangle-stack" />
          </button>
          <span className="template-select-wrapper">
            <select
              aria-label="Create page from template"
              className="template-select"
              disabled={!canCreatePageFromTemplate || pageTemplates.length === 0}
              onChange={(event) => {
                const templatePageId = event.currentTarget.value;

                if (templatePageId) {
                  onCreatePageFromTemplate(templatePageId);
                }

                event.currentTarget.value = "";
              }}
              title="Create page from template"
              value=""
            >
              <option value="">Use template</option>
              {pageTemplates.map((templatePage) => (
                <option key={templatePage.id} value={templatePage.id}>
                  {templatePage.title}
                </option>
              ))}
            </select>
            <span className="template-select-icon" aria-hidden="true">
              <HeroIcon name="document-plus" />
            </span>
          </span>
        </div>
        <span className="zoom-indicator" title="Zoom">
          {Math.round(zoomLevel * 100)}%
        </span>
        <button
          aria-label="Grid"
          aria-pressed={isGridVisible}
          className="header-toggle icon-button"
          onClick={onToggleGrid}
          title={gridToggleTitle}
          type="button"
        >
          <HeroIcon name="squares-2x2" />
        </button>
        <button
          aria-label="Snap to grid"
          aria-pressed={isGridVisible && isSnapToGridEnabled}
          className="header-toggle icon-button"
          disabled={!isGridVisible}
          onClick={onToggleSnapToGrid}
          title={snapToggleTitle}
          type="button"
        >
          <HeroIcon name="adjustments-horizontal" />
        </button>
        <button
          aria-label="Dark mode"
          aria-pressed={isDarkMode}
          className="theme-toggle icon-button"
          onClick={onToggleDarkMode}
          title={themeToggleTitle}
          type="button"
        >
          <HeroIcon name={isDarkMode ? "sun" : "moon"} />
        </button>
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
    previous.canCreatePageFromTemplate === next.canCreatePageFromTemplate &&
    previous.isAssistantOpen === next.isAssistantOpen &&
    previous.isGridVisible === next.isGridVisible &&
    previous.isDarkMode === next.isDarkMode &&
    previous.isEditingHeaderTitle === next.isEditingHeaderTitle &&
    previous.isSnapToGridEnabled === next.isSnapToGridEnabled &&
    previous.openPages === next.openPages &&
    previous.pageTemplates === next.pageTemplates &&
    previous.selectedPage === next.selectedPage &&
    previous.selectedPageId === next.selectedPageId &&
    previous.textFormatState === next.textFormatState &&
    previous.zoomLevel === next.zoomLevel
  );
}

export default App;
