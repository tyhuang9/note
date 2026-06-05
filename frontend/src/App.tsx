import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import type { AppData, TextBlock } from "./types";

const DEFAULT_BLOCK_WIDTH = 220;
const DEFAULT_BLOCK_HEIGHT = 96;
const MIN_BLOCK_WIDTH = 140;
const MIN_BLOCK_HEIGHT = 64;
const TEXT_COMMIT_DELAY_MS = 500;
const SAVE_DELAY_MS = 500;

const emptyData: AppData = {
  folders: [],
  pages: [],
  blocks: [],
};

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

type DragState = {
  canvasLeft: number;
  canvasTop: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  rafId: number | null;
  translateX: number;
  translateY: number;
};

type BlockUpdates = Partial<Pick<TextBlock, "content" | "height" | "width" | "x" | "y">>;

type TextBlockViewProps = {
  block: TextBlock;
  canvasRef: React.RefObject<HTMLElement | null>;
  isEditing: boolean;
  isSelected: boolean;
  onEditEnd: () => void;
  onSelect: (blockId: string) => void;
  onUpdate: (blockId: string, updates: BlockUpdates) => void;
};

const TextBlockView = memo(function TextBlockView({
  block,
  canvasRef,
  isEditing,
  isSelected,
  onEditEnd,
  onSelect,
  onUpdate,
}: TextBlockViewProps) {
  const blockRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const dragState = useRef<DragState | null>(null);
  const [draftContent, setDraftContent] = useState(block.content);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    setDraftContent(block.content);
  }, [block.content, block.id]);

  useEffect(() => {
    if (isEditing) {
      editorRef.current?.focus();
    }
  }, [isEditing]);

  useEffect(() => {
    if (draftContent === block.content) {
      return;
    }

    const commitTimer = window.setTimeout(() => {
      onUpdate(block.id, { content: draftContent });
    }, TEXT_COMMIT_DELAY_MS);

    return () => window.clearTimeout(commitTimer);
  }, [block.content, block.id, draftContent, onUpdate]);

  function getSizeUpdates() {
    const blockElement = blockRef.current;
    const updates: BlockUpdates = {};

    if (!blockElement) {
      return updates;
    }

    const width = Math.max(MIN_BLOCK_WIDTH, blockElement.offsetWidth);
    const height = Math.max(MIN_BLOCK_HEIGHT, blockElement.offsetHeight);

    if (width !== block.width) {
      updates.width = width;
    }

    if (height !== block.height) {
      updates.height = height;
    }

    return updates;
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    const canvasElement = canvasRef.current;

    if (!canvasElement) {
      return;
    }

    const canvasRect = canvasElement.getBoundingClientRect();

    dragState.current = {
      canvasLeft: canvasRect.left,
      canvasTop: canvasRect.top,
      offsetX: event.clientX - canvasRect.left - block.x,
      offsetY: event.clientY - canvasRect.top - block.y,
      startX: block.x,
      startY: block.y,
      currentX: block.x,
      currentY: block.y,
      rafId: null,
      translateX: 0,
      translateY: 0,
    };
    setIsDragging(true);
    onSelect(block.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveBlock(event: React.PointerEvent<HTMLDivElement>) {
    const currentDrag = dragState.current;
    const blockElement = blockRef.current;

    if (!currentDrag || !blockElement) {
      return;
    }

    const x = Math.max(
      0,
      event.clientX - currentDrag.canvasLeft - currentDrag.offsetX,
    );
    const y = Math.max(
      0,
      event.clientY - currentDrag.canvasTop - currentDrag.offsetY,
    );

    currentDrag.currentX = x;
    currentDrag.currentY = y;
    currentDrag.translateX = x - currentDrag.startX;
    currentDrag.translateY = y - currentDrag.startY;

    if (currentDrag.rafId !== null) {
      return;
    }

    currentDrag.rafId = window.requestAnimationFrame(() => {
      if (!dragState.current || !blockRef.current) {
        return;
      }

      blockRef.current.style.transform = `translate3d(${dragState.current.translateX}px, ${dragState.current.translateY}px, 0)`;
      dragState.current.rafId = null;
    });
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const currentDrag = dragState.current;

    if (!currentDrag) {
      return;
    }

    if (currentDrag.rafId !== null) {
      window.cancelAnimationFrame(currentDrag.rafId);
    }

    if (blockRef.current) {
      blockRef.current.style.transform = "";
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    onUpdate(block.id, {
      x: currentDrag.currentX,
      y: currentDrag.currentY,
    });
    dragState.current = null;
    setIsDragging(false);
  }

  return (
    <div
      className={`text-block ${isSelected ? "is-selected" : ""} ${
        isEditing ? "is-editing" : ""
      } ${isDragging ? "is-dragging" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
      }}
      ref={blockRef}
      style={{
        left: block.x,
        top: block.y,
        width: block.width,
        height: block.height,
      }}
    >
      <div
        aria-label="Move text block"
        className="text-block-handle"
        onPointerCancel={endDrag}
        onPointerDown={startDrag}
        onPointerMove={moveBlock}
        onPointerUp={endDrag}
        role="button"
        tabIndex={0}
      />
      <textarea
        aria-label="Text block"
        className="text-block-editor"
        onBlur={() => {
          const updates = getSizeUpdates();

          if (draftContent !== block.content) {
            updates.content = draftContent;
          }

          if (Object.keys(updates).length > 0) {
            onUpdate(block.id, updates);
          }

          onEditEnd();
        }}
        onChange={(event) => setDraftContent(event.currentTarget.value)}
        onFocus={() => onSelect(block.id)}
        ref={editorRef}
        value={draftContent}
      />
    </div>
  );
});

function App() {
  const [data, setData] = useState<AppData>(emptyData);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [selectedPageId, setSelectedPageId] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [persistenceAvailable, setPersistenceAvailable] = useState(false);
  const canvasRef = useRef<HTMLElement | null>(null);

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
        setSelectedFolderId(firstFolderId);
        setSelectedPageId(firstPageId);
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
    if (!isLoaded || !persistenceAvailable) {
      return;
    }

    const saveTimer = window.setTimeout(() => {
      invoke("save_app_data", { data }).catch((error) => {
        console.warn("Could not save local note data.", error);
      });
    }, SAVE_DELAY_MS);

    return () => window.clearTimeout(saveTimer);
  }, [data, isLoaded, persistenceAvailable]);

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
    setSelectedBlockId(null);
    setEditingBlockId(null);
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
      setSelectedBlockId(null);
      setEditingBlockId(null);

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
    setSelectedBlockId(null);
    setEditingBlockId(null);
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
    setSelectedBlockId(null);
    setEditingBlockId(null);
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
      setSelectedBlockId(null);
      setEditingBlockId(null);

      return {
        ...currentData,
        pages: nextPages,
        blocks: currentData.blocks.filter((block) => block.pageId !== pageId),
      };
    });
  }

  function selectPage(pageId: string) {
    setSelectedPageId(pageId);
    setEditingFolderId(null);
    setEditingPageId(null);
    setSelectedBlockId(null);
    setEditingBlockId(null);
  }

  function createBlock(event: React.MouseEvent<HTMLElement>) {
    if (!selectedPageId) {
      setSelectedBlockId(null);
      setEditingBlockId(null);
      return;
    }

    const canvasRect = event.currentTarget.getBoundingClientRect();
    const blockId = createId("block");
    const x = event.clientX - canvasRect.left;
    const y = event.clientY - canvasRect.top;

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
          content: "",
        },
      ],
    }));
    setSelectedBlockId(blockId);
    setEditingBlockId(blockId);
  }

  const updateBlock = useCallback((blockId: string, updates: BlockUpdates) => {
    setData((currentData) => ({
      ...currentData,
      blocks: currentData.blocks.map((block) =>
        block.id === blockId ? { ...block, ...updates } : block,
      ),
    }));
  }, []);

  const selectBlock = useCallback((blockId: string) => {
    setSelectedBlockId(blockId);
    setEditingBlockId(blockId);
  }, []);

  const endBlockEdit = useCallback(() => {
    setEditingBlockId(null);
  }, []);

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>Note</h1>
          </div>
        </div>

        <section className="sidebar-section" aria-labelledby="folders-title">
          <div className="section-header">
            <h2 id="folders-title">Folders</h2>
            <button type="button" aria-label="Create folder" onClick={createFolder}>
              +
            </button>
          </div>
          <div className="nav-list">
            {data.folders.map((folder) => {
              const pageCount = pageCountsByFolder.get(folder.id) ?? 0;

              return (
                <div
                  className={`nav-item ${
                    folder.id === selectedFolderId ? "is-active" : ""
                  }`}
                  key={folder.id}
                  onClick={() => selectFolder(folder.id)}
                >
                  {editingFolderId === folder.id ? (
                    <input
                      aria-label="Folder name"
                      autoFocus
                      className="inline-input"
                      defaultValue={folder.name}
                      onBlur={(event) => {
                        renameFolder(folder.id, event.currentTarget.value);
                        setEditingFolderId(null);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }

                        if (event.key === "Escape") {
                          setEditingFolderId(null);
                        }
                      }}
                    />
                  ) : (
                    <span className="nav-label">{folder.name}</span>
                  )}
                  <span className="item-count">{pageCount}</span>
                  <span className="nav-actions">
                    <button
                      type="button"
                      aria-label={`Rename ${folder.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditingFolderId(folder.id);
                      }}
                    >
                      R
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${folder.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteFolder(folder.id);
                      }}
                    >
                      X
                    </button>
                  </span>
                </div>
              );
            })}
            {data.folders.length === 0 ? (
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
              disabled={data.folders.length === 0}
              onClick={createPage}
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
                onClick={() => selectPage(page.id)}
              >
                {editingPageId === page.id ? (
                  <input
                    aria-label="Page title"
                    autoFocus
                    className="inline-input"
                    defaultValue={page.title}
                    onBlur={(event) => {
                      renamePage(page.id, event.currentTarget.value);
                      setEditingPageId(null);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }

                      if (event.key === "Escape") {
                        setEditingPageId(null);
                      }
                    }}
                  />
                ) : (
                  <span className="nav-label">{page.title}</span>
                )}
                <span className="nav-actions">
                  <button
                    type="button"
                    aria-label={`Rename ${page.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingPageId(page.id);
                    }}
                  >
                    R
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${page.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      deletePage(page.id);
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

      <section className="workspace">
        <header className="page-header">
          <div>
            <p className="eyebrow">Current page</p>
            <h2>{selectedPage?.title ?? "No page selected"}</h2>
          </div>
        </header>

        <section
          className="canvas"
          aria-label="Freeform note canvas"
          onClick={createBlock}
          ref={canvasRef}
        >
          {visibleBlocks.map((block) => (
            <TextBlockView
              block={block}
              canvasRef={canvasRef}
              isEditing={block.id === editingBlockId}
              isSelected={block.id === selectedBlockId}
              key={block.id}
              onEditEnd={endBlockEdit}
              onSelect={selectBlock}
              onUpdate={updateBlock}
            />
          ))}
          {selectedPageId && visibleBlocks.length === 0 ? (
            <div className="canvas-empty">
              <p>Click anywhere to add a textbox</p>
            </div>
          ) : null}
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

export default App;
