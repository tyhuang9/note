import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
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
import {
  blurActiveTextEntry,
  createId,
  emptyData,
  getOffscreenDirection,
  getSelectionRect,
  isTextEntryTarget,
  modeLabels,
  rectsIntersect,
} from "./editorUtils";
import type { AppData, TextBlock } from "./types";

type SidebarProps = {
  bookmarkedPages: AppData["pages"];
  editingFolderId: string | null;
  editingPageId: string | null;
  folders: AppData["folders"];
  isCollapsed: boolean;
  pageSearchQuery: string;
  pageSearchResults: PageSearchResult[];
  pageCountsByFolder: Map<string, number>;
  selectedFolderId: string;
  selectedPageId: string;
  visiblePages: AppData["pages"];
  onCreateFolder: () => void;
  onCreatePage: () => void;
  onDeleteFolder: (folderId: string) => void;
  onDeletePage: (pageId: string) => void;
  onDuplicatePage: (pageId: string) => void;
  onOpenSearch: () => void;
  onPointerDown: () => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRenamePage: (pageId: string, title: string) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectFolder: (folderId: string) => void;
  onSelectPage: (pageId: string) => void;
  onSetEditingFolderId: (folderId: string | null) => void;
  onSetEditingPageId: (pageId: string | null) => void;
  onToggleCollapse: () => void;
  onTogglePageBookmark: (pageId: string) => void;
};

type PageHeaderProps = {
  activeMode: InteractionMode;
  activeTextEditor: Editor | null;
  canCreatePageFromTemplate: boolean;
  isGridVisible: boolean;
  isDarkMode: boolean;
  isEditingHeaderTitle: boolean;
  isSnapToGridEnabled: boolean;
  pageTemplates: AppData["pages"];
  selectedPage: AppData["pages"][number] | undefined;
  zoomLevel: number;
  onCreatePageFromTemplate: (templatePageId: string) => void;
  onCreateTemplateFromPage: () => void;
  onPointerDown: () => void;
  onRenamePage: (pageId: string, title: string) => void;
  onSetEditingHeaderTitle: (isEditing: boolean) => void;
  onToggleGrid: () => void;
  onTogglePageBookmark: (pageId: string) => void;
  onToggleDarkMode: () => void;
  onToggleSnapToGrid: () => void;
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

type PageSearchResult = {
  contentMatchCount: number;
  folderName: string;
  pageId: string;
  preview: string;
  title: string;
  titleMatches: boolean;
};

const DRAG_AUTO_PAN_EDGE_PX = 56;
const DRAG_AUTO_PAN_MAX_STEP_PX = 18;
const MAX_BLOCK_HISTORY_ENTRIES = 100;
const PAGE_SEARCH_PREVIEW_CONTEXT = 44;
const PAGE_TEMPLATE_FOLDER_ID = "__note_page_templates__";
const PASTED_BLOCK_OFFSET = 24;
const DEFAULT_PAN_OFFSET: PanOffset = { x: 0, y: 0 };

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
  const [pageSearchQuery, setPageSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [focusEndBlockId, setFocusEndBlockId] = useState<string | null>(null);
  const [isCanvasKeyboardActive, setIsCanvasKeyboardActive] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isGridVisible, setIsGridVisible] = useState(false);
  const [isSnapToGridEnabled, setIsSnapToGridEnabled] = useState(false);
  const [dragSourceBlockIds, setDragSourceBlockIds] = useState<string[]>([]);
  const [activeTextEditor, setActiveTextEditor] = useState<Editor | null>(null);
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
  const undoBlockHistoryRef = useRef<TextBlock[][]>([]);
  const redoBlockHistoryRef = useRef<TextBlock[][]>([]);
  const blockElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const dragLayerSessionRef = useRef<DragLayerSession | null>(null);
  const pageViewportsRef = useRef<Map<string, PageViewport>>(new Map());
  const isSnapToGridEnabledRef = useRef(isSnapToGridEnabled);
  const selectedBlockIdsRef = useRef<string[]>(selectedBlockIds);
  const selectedFolderIdRef = useRef(selectedFolderId);
  const selectedPageIdRef = useRef(selectedPageId);
  const zoomLevelRef = useRef(zoomLevel);

  dataRef.current = data;
  isSnapToGridEnabledRef.current = isGridVisible && isSnapToGridEnabled;
  selectedBlockIdsRef.current = selectedBlockIds;
  selectedFolderIdRef.current = selectedFolderId;
  selectedPageIdRef.current = selectedPageId;
  zoomLevelRef.current = zoomLevel;

  const selectedPage = useMemo(
    () => data.pages.find((page) => page.id === selectedPageId),
    [data.pages, selectedPageId],
  );
  const pageTemplates = useMemo(
    () => data.pages.filter((page) => page.folderId === PAGE_TEMPLATE_FOLDER_ID),
    [data.pages],
  );
  const visiblePages = useMemo(
    () => data.pages.filter((page) => page.folderId === selectedFolderId),
    [data.pages, selectedFolderId],
  );
  const bookmarkedPages = useMemo(
    () => data.pages.filter((page) => page.isBookmarked),
    [data.pages],
  );
  const visibleBlocks = useMemo(
    () => data.blocks.filter((block) => block.pageId === selectedPageId),
    [data.blocks, selectedPageId],
  );
  const pageCountsByFolder = useMemo(() => {
    const pageCounts = new Map<string, number>();

    for (const page of data.pages) {
      pageCounts.set(page.folderId, (pageCounts.get(page.folderId) ?? 0) + 1);
    }

    return pageCounts;
  }, [data.pages]);
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
          folderName: folderNamesById.get(page.folderId) ?? "Unknown folder",
          pageId: page.id,
          preview: preview || (titleMatches ? "Title match" : ""),
          title: page.title,
          titleMatches,
        },
      ];
    });
  }, [blocksByPageId, data.pages, folderNamesById, pageSearchQuery]);
  const searchMatches = useMemo<SearchMatch[]>(() => {
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
  const activeSearchMatch = searchMatches[activeSearchIndex] ?? null;
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

        const firstFolderId = savedData.folders[0]?.id ?? "";
        const firstPageId =
          savedData.pages.find((page) => page.folderId === firstFolderId)?.id ??
          "";

        setData(savedData);
        setIsDarkMode(Boolean(savedData.isDarkMode));
        pageViewportsRef.current.clear();
        setSelectedFolderId(firstFolderId);
        setSelectedPageId(firstPageId);
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
    if (isSearchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [isSearchOpen]);

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

  function cloneBlocksForPage(blocks: TextBlock[], pageId: string) {
    return blocks.map((block) => ({
      ...block,
      id: createId("block"),
      pageId,
      richContent: block.richContent
        ? structuredClone(block.richContent)
        : undefined,
    }));
  }

  function isTemplatePage(page: AppData["pages"][number]) {
    return page.folderId === PAGE_TEMPLATE_FOLDER_ID;
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
      ({ id: _id, pageId: _pageId, x, y, ...block }) => ({
        ...block,
        offsetX: x - minX,
        offsetY: y - minY,
      }),
    );

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
    if (!selectedPageId || copiedBlocksRef.current.length === 0) {
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
      richContent: block.richContent,
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z" &&
        !editingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();
        restoreBlockHistory(event.shiftKey ? "redo" : "undo");
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "y" &&
        !editingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();
        restoreBlockHistory("redo");
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "c" &&
        !editingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        if (copySelectedBlocks()) {
          event.preventDefault();
        }

        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "a" &&
        !editingBlockId &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();

        if (!isCanvasKeyboardActive || visibleBlocks.length === 0) {
          return;
        }

        setSelectedBlockIds(visibleBlocks.map((block) => block.id));
        setEditingBlockId(null);
        setActiveMode("selected");
        return;
      }

      if (
        !editingBlockId &&
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

      if (editingBlockId || isTextEntryTarget(event.target)) {
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
    editingBlockId,
    insertionPoint,
    isCanvasKeyboardActive,
    selectedBlockIds,
    selectedPageId,
    visibleBlocks,
  ]);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (!selectedPageId || isTextEntryTarget(event.target)) {
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
    setSelectedFolderId(folderId);
    setSelectedPageId("");
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
      const nextFolderId = nextFolders[0]?.id ?? "";
      const nextSelectedPageId =
        nextPages.find((page) => page.folderId === nextFolderId)?.id ?? "";

      forgetPageViewports(deletedPageIds);
      setSelectedFolderId(nextFolderId);
      setSelectedPageId(nextSelectedPageId);
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
    setSelectedFolderId(folderId);
    setSelectedPageId(nextSelectedPageId);
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
    const folderId = selectedFolderId || data.folders[0]?.id;

    if (!folderId) {
      return;
    }

    const pageId = createId("page");

    setData((currentData) => ({
      ...currentData,
      pages: [
        ...currentData.pages,
        { id: pageId, folderId, title: "New page" },
      ],
    }));
    rememberPageViewport(selectedPageId);
    setSelectedFolderId(folderId);
    setSelectedPageId(pageId);
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
    const folderId = selectedFolderIdRef.current || currentData.folders[0]?.id;

    if (!templatePage || !folderId) {
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
    restorePageViewport(pageId);
    setEditingFolderId(null);
    setEditingPageId(pageId);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function duplicatePage(pageId: string) {
    const currentData = dataRef.current;
    const sourcePageIndex = currentData.pages.findIndex(
      (page) => page.id === pageId && !isTemplatePage(page),
    );

    if (sourcePageIndex === -1) {
      return;
    }

    const sourcePage = currentData.pages[sourcePageIndex];
    const duplicatePageId = createId("page");
    const duplicatePage = {
      ...sourcePage,
      id: duplicatePageId,
    };
    const duplicateBlocks = cloneBlocksForPage(
      currentData.blocks.filter((block) => block.pageId === sourcePage.id),
      duplicatePageId,
    );
    const nextData = {
      ...currentData,
      pages: [
        ...currentData.pages.slice(0, sourcePageIndex + 1),
        duplicatePage,
        ...currentData.pages.slice(sourcePageIndex + 1),
      ],
      blocks: [...currentData.blocks, ...duplicateBlocks],
    };
    const sourceViewport =
      sourcePage.id === selectedPageId
        ? {
            panOffset: { ...panOffsetRef.current },
            zoomLevel: zoomLevelRef.current,
          }
        : pageViewportsRef.current.get(sourcePage.id);

    dataRef.current = nextData;
    setData(nextData);
    rememberPageViewport(selectedPageIdRef.current);

    if (sourceViewport) {
      pageViewportsRef.current.set(duplicatePageId, {
        panOffset: { ...sourceViewport.panOffset },
        zoomLevel: sourceViewport.zoomLevel,
      });
    }

    setSelectedFolderId(sourcePage.folderId);
    setSelectedPageId(duplicatePageId);
    restorePageViewport(duplicatePageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
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

      forgetPageViewports([pageId]);
      setSelectedPageId(nextSelectedPageId);
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

  function selectPage(pageId: string) {
    const nextPage = data.pages.find((page) => page.id === pageId);

    if (!nextPage) {
      return;
    }

    setSelectedFolderId(nextPage.folderId);
    switchSelectedPage(pageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setIsEditingHeaderTitle(false);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setActiveMode("canvas");
  }

  function createTextBlock(x: number, y: number, content: string) {
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
        width: DEFAULT_BLOCK_WIDTH,
        height: DEFAULT_BLOCK_HEIGHT,
        content,
        isWidthManuallyResized: false,
      },
    ]);
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
        cloneElement.classList.remove("is-drag-source-hidden");
        cloneElement.classList.add("is-dragging", "drag-layer-clone");
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

  function selectCanvas() {
    blurActiveTextEntry();
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    hideSelectionRectangle();
    setIsCanvasKeyboardActive(true);
    setActiveMode("canvas");
  }

  function startCanvasPan(event: React.PointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    blurActiveTextEntry();
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
    if (event.target !== event.currentTarget) {
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

    const nextPanOffset = {
      x: panOffsetRef.current.x - (event.shiftKey ? event.deltaY : event.deltaX),
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
    const block = visibleBlocks.find((currentBlock) => currentBlock.id === match.blockId);

    if (!block) {
      return;
    }

    blurActiveTextEntry();
    setActiveSearchIndex(normalizedIndex);
    setSelectedBlockIds([]);
    setEditingBlockId(null);
    setInsertionPoint(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("canvas");
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

  return (
    <main
      className={`app-shell ${isDarkMode ? "is-dark" : ""} ${
        isSidebarCollapsed ? "is-sidebar-collapsed" : ""
      }`}
    >
      <Sidebar
        bookmarkedPages={bookmarkedPages}
        editingFolderId={editingFolderId}
        editingPageId={editingPageId}
        folders={data.folders}
        isCollapsed={isSidebarCollapsed}
        pageSearchQuery={pageSearchQuery}
        pageSearchResults={pageSearchResults}
        pageCountsByFolder={pageCountsByFolder}
        selectedFolderId={selectedFolderId}
        selectedPageId={selectedPageId}
        visiblePages={visiblePages}
        onCreateFolder={createFolder}
        onCreatePage={createPage}
        onDeleteFolder={deleteFolder}
        onDeletePage={deletePage}
        onDuplicatePage={duplicatePage}
        onOpenSearch={() => setIsSearchOpen(true)}
        onPointerDown={() => setIsCanvasKeyboardActive(false)}
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
      />

      <section className="workspace">
        <PageHeader
          activeMode={activeMode}
          activeTextEditor={activeTextEditor}
          canCreatePageFromTemplate={data.folders.length > 0}
          isGridVisible={isGridVisible}
          isDarkMode={isDarkMode}
          isEditingHeaderTitle={isEditingHeaderTitle}
          isSnapToGridEnabled={isSnapToGridEnabled}
          pageTemplates={pageTemplates}
          selectedPage={selectedPage}
          zoomLevel={zoomLevel}
          onCreatePageFromTemplate={createPageFromTemplate}
          onCreateTemplateFromPage={createTemplateFromSelectedPage}
          onPointerDown={() => setIsCanvasKeyboardActive(false)}
          onRenamePage={renamePage}
          onSetEditingHeaderTitle={setIsEditingHeaderTitle}
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
              <input
                aria-label="Search textboxes"
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
                placeholder="Search"
                ref={searchInputRef}
                value={searchQuery}
              />
              <span>{searchMatches.length}</span>
              <button
                aria-label="Close search"
                onClick={() => {
                  setIsSearchOpen(false);
                  setSearchQuery("");
                }}
                type="button"
              >
                X
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
          {!selectedPageId ? (
            <div className="canvas-empty">
              <p>Select or create a page</p>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

const Sidebar = memo(function Sidebar({
  bookmarkedPages,
  editingFolderId,
  editingPageId,
  folders,
  isCollapsed,
  pageSearchQuery,
  pageSearchResults,
  pageCountsByFolder,
  selectedFolderId,
  selectedPageId,
  visiblePages,
  onCreateFolder,
  onCreatePage,
  onDeleteFolder,
  onDeletePage,
  onDuplicatePage,
  onOpenSearch,
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
}: SidebarProps) {
  const folderNamesById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );

  return (
    <aside
      className={`sidebar ${isCollapsed ? "is-collapsed" : ""}`}
      aria-label="Workspace navigation"
      onPointerDown={onPointerDown}
    >
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark" aria-hidden="true">
            N
          </span>
          <h1 className="sidebar-title">Note</h1>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapse}
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {isCollapsed ? ">" : "<"}
        </button>
      </div>

      {!isCollapsed ? (
        <div className="sidebar-content">
          <section className="sidebar-section sidebar-search" aria-labelledby="search-title">
            <div className="section-header">
              <h2 id="search-title">Search</h2>
            </div>
            <input
              aria-label="Search pages and textboxes"
              className="sidebar-search-input"
              onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
              placeholder="Search notes"
              type="search"
              value={pageSearchQuery}
            />
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
            <button
              type="button"
              className="sidebar-search-button"
              onClick={onOpenSearch}
            >
              <span>Search current page</span>
              <span className="keyboard-hint">Ctrl F</span>
            </button>
          </section>

          <section className="sidebar-section" aria-labelledby="folders-title">
            <div className="section-header">
              <h2 id="folders-title">Folders</h2>
              <button
                type="button"
                className="section-action"
                aria-label="Create folder"
                onClick={onCreateFolder}
                title="Create folder"
              >
                +
              </button>
            </div>
            <div className="nav-list">
              {folders.map((folder) => {
                const pageCount = pageCountsByFolder.get(folder.id) ?? 0;

                return (
                  <div
                    className={`nav-item nav-item-folder ${
                      folder.id === selectedFolderId ? "is-active" : ""
                    }`}
                    key={folder.id}
                    onDoubleClick={() => onSetEditingFolderId(folder.id)}
                    onClick={() => onSelectFolder(folder.id)}
                  >
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
                    <span className="item-count">{pageCount}</span>
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
                        X
                      </button>
                    </span>
                  </div>
                );
              })}
              {folders.length === 0 ? (
                <p className="empty-state">No folders yet</p>
              ) : null}
            </div>
          </section>

          <section className="sidebar-section" aria-labelledby="favorites-title">
            <div className="section-header">
              <h2 id="favorites-title">Favorites</h2>
            </div>
            <div className="nav-list">
              {bookmarkedPages.map((page) => (
                <div
                  className={`nav-item nav-item-bookmark ${
                    page.id === selectedPageId ? "is-selected" : ""
                  }`}
                  key={page.id}
                  onClick={() => onSelectPage(page.id)}
                >
                  <span className="nav-label">{page.title}</span>
                  <span className="bookmark-folder-label">
                    {folderNamesById.get(page.folderId) ?? "Missing folder"}
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
                    ★
                  </button>
                </div>
              ))}
              {bookmarkedPages.length === 0 ? (
                <p className="empty-state">No favorites yet</p>
              ) : null}
            </div>
          </section>

          <section className="sidebar-section" aria-labelledby="pages-title">
            <div className="section-header">
              <h2 id="pages-title">Pages</h2>
              <button
                type="button"
                className="section-action"
                aria-label="Create page"
                disabled={folders.length === 0}
                onClick={onCreatePage}
                title="Create page"
              >
                +
              </button>
            </div>
            <div className="nav-list">
              {visiblePages.map((page) => (
                <div
                  className={`nav-item nav-item-page ${
                    page.id === selectedPageId ? "is-selected" : ""
                  }`}
                  key={page.id}
                  onDoubleClick={() => onSetEditingPageId(page.id)}
                  onClick={() => onSelectPage(page.id)}
                >
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
                    {page.isBookmarked ? "★" : "☆"}
                  </button>
                  <span className="nav-actions is-page-actions">
                    <button
                      type="button"
                      aria-label={`Duplicate ${page.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDuplicatePage(page.id);
                      }}
                      title={`Duplicate ${page.title}`}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${page.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeletePage(page.id);
                      }}
                      title={`Delete ${page.title}`}
                    >
                      X
                    </button>
                  </span>
                </div>
              ))}
              {selectedFolderId && visiblePages.length === 0 ? (
                <p className="empty-state">No pages in this folder</p>
              ) : null}
              {!selectedFolderId ? (
                <p className="empty-state">Select or create a folder</p>
              ) : null}
            </div>
          </section>

          <section className="sidebar-section" aria-labelledby="templates-title">
            <div className="section-header">
              <h2 id="templates-title">Templates</h2>
            </div>
            <p className="sidebar-placeholder">No templates yet</p>
          </section>
        </div>
      ) : null}
    </aside>
  );
}, areSidebarPropsEqual);

function areSidebarPropsEqual(previous: SidebarProps, next: SidebarProps) {
  return (
    previous.bookmarkedPages === next.bookmarkedPages &&
    previous.editingFolderId === next.editingFolderId &&
    previous.editingPageId === next.editingPageId &&
    previous.folders === next.folders &&
    previous.isCollapsed === next.isCollapsed &&
    previous.pageSearchQuery === next.pageSearchQuery &&
    previous.pageSearchResults === next.pageSearchResults &&
    previous.pageCountsByFolder === next.pageCountsByFolder &&
    previous.selectedFolderId === next.selectedFolderId &&
    previous.selectedPageId === next.selectedPageId &&
    previous.visiblePages === next.visiblePages
  );
}

const PageHeader = memo(function PageHeader({
  activeMode,
  activeTextEditor,
  canCreatePageFromTemplate,
  isGridVisible,
  isDarkMode,
  isEditingHeaderTitle,
  isSnapToGridEnabled,
  pageTemplates,
  selectedPage,
  zoomLevel,
  onCreatePageFromTemplate,
  onCreateTemplateFromPage,
  onPointerDown,
  onRenamePage,
  onSetEditingHeaderTitle,
  onToggleGrid,
  onTogglePageBookmark,
  onToggleDarkMode,
  onToggleSnapToGrid,
}: PageHeaderProps) {
  return (
    <header
      className="page-header"
      onPointerDown={onPointerDown}
    >
      <div className="page-title-group">
        <span className="app-title">Note</span>
        {selectedPage && isEditingHeaderTitle ? (
          <InlineRename
            ariaLabel="Page title"
            initialValue={selectedPage.title}
            onCancel={() => onSetEditingHeaderTitle(false)}
            onCommit={(value) => {
              onRenamePage(selectedPage.id, value);
              onSetEditingHeaderTitle(false);
            }}
          />
        ) : (
          <h2
            className="page-title"
            onDoubleClick={() => {
              if (selectedPage) {
                onSetEditingHeaderTitle(true);
              }
            }}
          >
            {selectedPage?.title ?? "No page selected"}
          </h2>
        )}
      </div>
      <div className="page-header-actions">
        {activeTextEditor && !activeTextEditor.isDestroyed ? (
          <GlobalTextToolbar editor={activeTextEditor} />
        ) : null}
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
            {selectedPage.isBookmarked ? "★" : "☆"}
          </button>
        ) : null}
        <div className="template-actions">
          <button
            aria-label="Create template from current page"
            className="template-button"
            disabled={!selectedPage}
            onClick={onCreateTemplateFromPage}
            title="Create template from current page"
            type="button"
          >
            Save template
          </button>
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
            value=""
          >
            <option value="">Use template</option>
            {pageTemplates.map((templatePage) => (
              <option key={templatePage.id} value={templatePage.id}>
                {templatePage.title}
              </option>
            ))}
          </select>
        </div>
        <span className="zoom-indicator">{Math.round(zoomLevel * 100)}%</span>
        <span className="mode-indicator">{modeLabels[activeMode]}</span>
        <button
          aria-pressed={isGridVisible}
          className="header-toggle"
          onClick={onToggleGrid}
          type="button"
        >
          Grid
        </button>
        <button
          aria-pressed={isGridVisible && isSnapToGridEnabled}
          className="header-toggle"
          disabled={!isGridVisible}
          onClick={onToggleSnapToGrid}
          type="button"
        >
          Snap
        </button>
        <button
          aria-pressed={isDarkMode}
          className="theme-toggle"
          onClick={onToggleDarkMode}
          type="button"
        >
          {isDarkMode ? "Light" : "Dark"}
        </button>
      </div>
    </header>
  );
}, arePageHeaderPropsEqual);

type ToolbarAction = {
  isActive: boolean;
  isDisabled?: boolean;
  label: string;
  title: string;
  onClick: () => void;
};

function GlobalTextToolbar({ editor }: { editor: Editor }) {
  const toolbarState = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (editor.isDestroyed) {
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
        isBlockquote: editor.isActive("blockquote"),
        isBold: editor.isActive("bold"),
        isBulletList: editor.isActive("bulletList"),
        isCode: editor.isActive("code"),
        isItalic: editor.isActive("italic"),
        isOrderedList: editor.isActive("orderedList"),
        isStrike: editor.isActive("strike"),
      };
    },
  });

  if (editor.isDestroyed || !toolbarState) {
    return null;
  }

  const actions: ToolbarAction[] = [
    {
      isActive: toolbarState.isBold,
      isDisabled: !toolbarState.canToggleBold,
      label: "B",
      title: "Bold",
      onClick: () => editor.chain().focus().toggleBold().run(),
    },
    {
      isActive: toolbarState.isItalic,
      isDisabled: !toolbarState.canToggleItalic,
      label: "I",
      title: "Italic",
      onClick: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      isActive: toolbarState.isStrike,
      isDisabled: !toolbarState.canToggleStrike,
      label: "S",
      title: "Strikethrough",
      onClick: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      isActive: toolbarState.isBulletList,
      isDisabled: !toolbarState.canToggleBulletList,
      label: "•",
      title: "Bullet list",
      onClick: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      isActive: toolbarState.isOrderedList,
      isDisabled: !toolbarState.canToggleOrderedList,
      label: "1.",
      title: "Ordered list",
      onClick: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      isActive: toolbarState.isBlockquote,
      isDisabled: !toolbarState.canToggleBlockquote,
      label: "\"",
      title: "Quote",
      onClick: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      isActive: toolbarState.isCode,
      isDisabled: !toolbarState.canToggleCode,
      label: "</>",
      title: "Code",
      onClick: () => editor.chain().focus().toggleCode().run(),
    },
  ];

  return (
    <div
      aria-label="Text formatting"
      className="global-text-toolbar"
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      role="toolbar"
    >
      {actions.map((action) => (
        <button
          aria-label={action.title}
          aria-pressed={action.isActive}
          className={action.isActive ? "is-active" : undefined}
          disabled={action.isDisabled}
          key={action.title}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            action.onClick();
          }}
          title={action.title}
          type="button"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function arePageHeaderPropsEqual(previous: PageHeaderProps, next: PageHeaderProps) {
  return (
    previous.activeMode === next.activeMode &&
    previous.activeTextEditor === next.activeTextEditor &&
    previous.canCreatePageFromTemplate === next.canCreatePageFromTemplate &&
    previous.isGridVisible === next.isGridVisible &&
    previous.isDarkMode === next.isDarkMode &&
    previous.isEditingHeaderTitle === next.isEditingHeaderTitle &&
    previous.isSnapToGridEnabled === next.isSnapToGridEnabled &&
    previous.pageTemplates === next.pageTemplates &&
    previous.selectedPage === next.selectedPage &&
    previous.zoomLevel === next.zoomLevel
  );
}

export default App;
