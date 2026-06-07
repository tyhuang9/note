import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { InlineRename } from "./components/InlineRename";
import { TextBlockView } from "./components/TextBlockView";
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_BLOCK_WIDTH,
  DEFAULT_ZOOM,
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
import type { AppData } from "./types";

type SidebarProps = {
  editingFolderId: string | null;
  editingPageId: string | null;
  folders: AppData["folders"];
  pageCountsByFolder: Map<string, number>;
  selectedFolderId: string;
  selectedPageId: string;
  visiblePages: AppData["pages"];
  onCreateFolder: () => void;
  onCreatePage: () => void;
  onDeleteFolder: (folderId: string) => void;
  onDeletePage: (pageId: string) => void;
  onPointerDown: () => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRenamePage: (pageId: string, title: string) => void;
  onSelectFolder: (folderId: string) => void;
  onSelectPage: (pageId: string) => void;
  onSetEditingFolderId: (folderId: string | null) => void;
  onSetEditingPageId: (pageId: string | null) => void;
};

type PageHeaderProps = {
  activeMode: InteractionMode;
  isDarkMode: boolean;
  isEditingHeaderTitle: boolean;
  selectedPage: AppData["pages"][number] | undefined;
  zoomLevel: number;
  onPointerDown: () => void;
  onRenamePage: (pageId: string, title: string) => void;
  onSetEditingHeaderTitle: (isEditing: boolean) => void;
  onToggleDarkMode: () => void;
};

type DragLayerSession = {
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
  zoomLevel: number;
};




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
  const [insertionPoint, setInsertionPoint] = useState<InsertionPoint | null>(null);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [focusEndBlockId, setFocusEndBlockId] = useState<string | null>(null);
  const [isCanvasKeyboardActive, setIsCanvasKeyboardActive] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [persistenceAvailable, setPersistenceAvailable] = useState(false);
  const canvasRef = useRef<HTMLElement | null>(null);
  const canvasContentRef = useRef<HTMLDivElement | null>(null);
  const selectionRectRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const panState = useRef<PanState | null>(null);
  const panOffsetRef = useRef<PanOffset>(panOffset);
  const panRafId = useRef<number | null>(null);
  const selectionState = useRef<SelectionState | null>(null);
  const selectionRafId = useRef<number | null>(null);
  const pendingSelectionRect = useRef<SelectionRect | null>(null);
  const searchCache = useRef<Map<string, SearchMatch[]>>(new Map());
  const blockElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const dragLayerSessionRef = useRef<DragLayerSession | null>(null);
  const selectedBlockIdsRef = useRef<string[]>(selectedBlockIds);
  const zoomLevelRef = useRef(zoomLevel);

  selectedBlockIdsRef.current = selectedBlockIds;
  zoomLevelRef.current = zoomLevel;

  const selectedPage = useMemo(
    () => data.pages.find((page) => page.id === selectedPageId),
    [data.pages, selectedPageId],
  );
  const visiblePages = useMemo(
    () => data.pages.filter((page) => page.folderId === selectedFolderId),
    [data.pages, selectedFolderId],
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
      x: -panOffset.x / zoomLevel,
      y: -panOffset.y / zoomLevel,
      width: canvasSize.width / zoomLevel,
      height: canvasSize.height / zoomLevel,
    };
  }, [canvasSize.height, canvasSize.width, panOffset.x, panOffset.y, zoomLevel]);
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
        setSelectedFolderId(firstFolderId);
        setSelectedPageId(firstPageId);
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

  const deleteBlocks = useCallback((blockIds: string[]) => {
    const blockIdsToDelete = new Set(blockIds);

    setData((currentData) => ({
      ...currentData,
      blocks: currentData.blocks.filter(
        (block) => !blockIdsToDelete.has(block.id),
      ),
    }));
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

      if (
        insertionPoint &&
        selectedPageId &&
        event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        createTextBlock(insertionPoint.x, insertionPoint.y, event.key);
        setInsertionPoint(null);
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
      if (!insertionPoint || !selectedPageId || isTextEntryTarget(event.target)) {
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

  function createFolder() {
    const folderId = createId("folder");

    setData((currentData) => ({
      ...currentData,
      folders: [...currentData.folders, { id: folderId, name: "New folder" }],
    }));
    setSelectedFolderId(folderId);
    setSelectedPageId("");
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

      setSelectedFolderId(nextFolderId);
      setSelectedPageId(nextSelectedPageId);
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

    setSelectedFolderId(folderId);
    setSelectedPageId(firstPage?.id ?? "");
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
    setSelectedFolderId(folderId);
    setSelectedPageId(pageId);
    setEditingFolderId(null);
    setEditingPageId(pageId);
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

  function deletePage(pageId: string) {
    setData((currentData) => {
      const pageToDelete = currentData.pages.find((page) => page.id === pageId);
      const nextPages = currentData.pages.filter((page) => page.id !== pageId);
      const folderId = pageToDelete?.folderId ?? selectedFolderId;
      const nextSelectedPageId =
        pageId === selectedPageId
          ? nextPages.find((page) => page.folderId === folderId)?.id ?? ""
          : selectedPageId;

      setSelectedPageId(nextSelectedPageId);
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
    setSelectedPageId(pageId);
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

    setData((currentData) => ({
      ...currentData,
      blocks: [
        ...currentData.blocks,
        {
          id: blockId,
          pageId: selectedPageId,
          x,
          y,
          width: DEFAULT_BLOCK_WIDTH,
          height: DEFAULT_BLOCK_HEIGHT,
          content,
          isWidthManuallyResized: false,
        },
      ],
    }));
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

    setData((currentData) => ({
      ...currentData,
      blocks: [
        ...currentData.blocks,
        {
          id: blockId,
          pageId: selectedPageId,
          x,
          y,
          width: 320,
          height: 220,
          content: imageName,
          isWidthManuallyResized: true,
          imageData,
          imageName,
        },
      ],
    }));
    setSelectedBlockIds([blockId]);
    setEditingBlockId(null);
    setIsCanvasKeyboardActive(true);
    setActiveMode("selected");
    setInsertionPoint(null);
  }

  const updateBlock = useCallback((blockId: string, updates: BlockUpdates) => {
    setData((currentData) => {
      let didChange = false;
      const nextBlocks = currentData.blocks.map((block) => {
        if (block.id !== blockId) {
          return block;
        }

        const hasBlockChanges = Object.entries(updates).some(
          ([key, value]) => block[key as keyof typeof block] !== value,
        );

        if (!hasBlockChanges) {
          return block;
        }

        didChange = true;
        return { ...block, ...updates };
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

      const overlayElement = document.createElement("div");
      const groupElement = document.createElement("div");
      const currentZoomLevel = zoomLevelRef.current;

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
        cloneElement.style.left = `${elementRect.left}px`;
        cloneElement.style.top = `${elementRect.top}px`;
        cloneElement.style.width = `${element.offsetWidth}px`;
        cloneElement.style.height = `${element.offsetHeight}px`;
        cloneElement.style.margin = "0";
        cloneElement.style.pointerEvents = "none";
        cloneElement.style.transform = `scale(${currentZoomLevel})`;
        cloneElement.style.transformOrigin = "0 0";
        groupElement.append(cloneElement);
      }

      const dragLayerHost =
        (canvasRef.current?.closest(".app-shell") as HTMLElement | null) ??
        document.body;

      dragLayerHost.append(overlayElement);

      const dragSession: DragLayerSession = {
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
        zoomLevel: currentZoomLevel,
      };

      dragLayerSessionRef.current = dragSession;

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
    dragSession.groupElement.style.transform = `translate3d(${
      clientX - dragSession.startClientX
    }px, ${clientY - dragSession.startClientY}px, 0)`;
  }, []);

  const endVisualDrag = useCallback((clientX: number, clientY: number) => {
    const dragSession = dragLayerSessionRef.current;

    if (!dragSession) {
      return;
    }

    dragSession.currentClientX = clientX;
    dragSession.currentClientY = clientY;

    const offset = {
      x: (dragSession.currentClientX - dragSession.startClientX) /
        dragSession.zoomLevel,
      y: (dragSession.currentClientY - dragSession.startClientY) /
        dragSession.zoomLevel,
    };
    const movedEnough = Math.abs(offset.x) > 0.01 || Math.abs(offset.y) > 0.01;
    const blockIdsToMove = new Set(dragSession.blockIds);

    cleanupDragLayerSession(dragSession);
    dragLayerSessionRef.current = null;

    if (movedEnough) {
      setData((currentData) => ({
        ...currentData,
        blocks: currentData.blocks.map((block) =>
          blockIdsToMove.has(block.id)
            ? { ...block, x: block.x + offset.x, y: block.y + offset.y }
            : block,
        ),
      }));
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
    setActiveMode("selected");
  }, []);

  const selectBlock = useCallback((blockId: string) => {
    setSelectedBlockIds((currentBlockIds) => {
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
    setActiveMode("selected");
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

    if (event.shiftKey) {
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

    event.currentTarget.releasePointerCapture(event.pointerId);

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
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    updateZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
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
    <main className={`app-shell ${isDarkMode ? "is-dark" : ""}`}>
      <Sidebar
        editingFolderId={editingFolderId}
        editingPageId={editingPageId}
        folders={data.folders}
        pageCountsByFolder={pageCountsByFolder}
        selectedFolderId={selectedFolderId}
        selectedPageId={selectedPageId}
        visiblePages={visiblePages}
        onCreateFolder={createFolder}
        onCreatePage={createPage}
        onDeleteFolder={deleteFolder}
        onDeletePage={deletePage}
        onPointerDown={() => setIsCanvasKeyboardActive(false)}
        onRenameFolder={renameFolder}
        onRenamePage={renamePage}
        onSelectFolder={selectFolder}
        onSelectPage={selectPage}
        onSetEditingFolderId={setEditingFolderId}
        onSetEditingPageId={setEditingPageId}
      />

      <section className="workspace">
        <PageHeader
          activeMode={activeMode}
          isDarkMode={isDarkMode}
          isEditingHeaderTitle={isEditingHeaderTitle}
          selectedPage={selectedPage}
          zoomLevel={zoomLevel}
          onPointerDown={() => setIsCanvasKeyboardActive(false)}
          onRenamePage={renamePage}
          onSetEditingHeaderTitle={setIsEditingHeaderTitle}
          onToggleDarkMode={() => setIsDarkMode((currentMode) => !currentMode)}
        />

        <section
          className={`canvas ${activeMode === "canvas" ? "is-canvas-selected" : ""} ${
            activeMode === "panning" ? "is-panning" : ""
          } ${activeMode === "selecting" ? "is-selecting" : ""
          }`}
          aria-label="Freeform note canvas"
          onPointerCancel={endCanvasInteraction}
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
            {visibleBlocks.map((block) => (
              <TextBlockView
                block={block}
                activeSearchRange={
                  activeSearchMatch?.blockId === block.id ? activeSearchMatch : null
                }
                isEditing={block.id === editingBlockId}
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
  editingFolderId,
  editingPageId,
  folders,
  pageCountsByFolder,
  selectedFolderId,
  selectedPageId,
  visiblePages,
  onCreateFolder,
  onCreatePage,
  onDeleteFolder,
  onDeletePage,
  onPointerDown,
  onRenameFolder,
  onRenamePage,
  onSelectFolder,
  onSelectPage,
  onSetEditingFolderId,
  onSetEditingPageId,
}: SidebarProps) {
  return (
    <aside
      className="sidebar"
      aria-label="Workspace navigation"
      onPointerDown={onPointerDown}
    >
      <div className="sidebar-header">
        <h1>Note</h1>
      </div>

      <section className="sidebar-section" aria-labelledby="folders-title">
        <div className="section-header">
          <h2 id="folders-title">Folders</h2>
          <button type="button" aria-label="Create folder" onClick={onCreateFolder}>
            +
          </button>
        </div>
        <div className="nav-list">
          {folders.map((folder) => {
            const pageCount = pageCountsByFolder.get(folder.id) ?? 0;

            return (
              <div
                className={`nav-item ${
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

      <section className="sidebar-section" aria-labelledby="pages-title">
        <div className="section-header">
          <h2 id="pages-title">Pages</h2>
          <button
            type="button"
            aria-label="Create page"
            disabled={folders.length === 0}
            onClick={onCreatePage}
          >
            +
          </button>
        </div>
        <div className="nav-list">
          {visiblePages.map((page) => (
            <div
              className={`nav-item ${
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
              <span className="nav-actions">
                <button
                  type="button"
                  aria-label={`Delete ${page.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeletePage(page.id);
                  }}
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
    </aside>
  );
}, areSidebarPropsEqual);

function areSidebarPropsEqual(previous: SidebarProps, next: SidebarProps) {
  return (
    previous.editingFolderId === next.editingFolderId &&
    previous.editingPageId === next.editingPageId &&
    previous.folders === next.folders &&
    previous.pageCountsByFolder === next.pageCountsByFolder &&
    previous.selectedFolderId === next.selectedFolderId &&
    previous.selectedPageId === next.selectedPageId &&
    previous.visiblePages === next.visiblePages
  );
}

const PageHeader = memo(function PageHeader({
  activeMode,
  isDarkMode,
  isEditingHeaderTitle,
  selectedPage,
  zoomLevel,
  onPointerDown,
  onRenamePage,
  onSetEditingHeaderTitle,
  onToggleDarkMode,
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
        <span className="zoom-indicator">{Math.round(zoomLevel * 100)}%</span>
        <span className="mode-indicator">{modeLabels[activeMode]}</span>
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

function arePageHeaderPropsEqual(previous: PageHeaderProps, next: PageHeaderProps) {
  return (
    previous.activeMode === next.activeMode &&
    previous.isDarkMode === next.isDarkMode &&
    previous.isEditingHeaderTitle === next.isEditingHeaderTitle &&
    previous.selectedPage === next.selectedPage &&
    previous.zoomLevel === next.zoomLevel
  );
}

export default App;
