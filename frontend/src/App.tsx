import { useEffect, useRef, useState } from "react";
import "./App.css";
import type { AppData } from "./types";

const DEFAULT_BLOCK_WIDTH = 220;
const DEFAULT_BLOCK_HEIGHT = 96;
const MIN_BLOCK_WIDTH = 140;
const MIN_BLOCK_HEIGHT = 64;

const initialData: AppData = {
  folders: [
    { id: "folder-work", name: "Work" },
    { id: "folder-personal", name: "Personal" },
  ],
  pages: [
    { id: "page-meeting-notes", folderId: "folder-work", title: "Meeting Notes" },
    { id: "page-todo", folderId: "folder-work", title: "TODO" },
    { id: "page-ideas", folderId: "folder-personal", title: "Ideas" },
    { id: "page-journal", folderId: "folder-personal", title: "Journal" },
  ],
  blocks: [],
};

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

type DragState = {
  blockId: string;
  offsetX: number;
  offsetY: number;
};

function App() {
  const [data, setData] = useState<AppData>(initialData);
  const [selectedFolderId, setSelectedFolderId] = useState(
    initialData.folders[0]?.id ?? "",
  );
  const [selectedPageId, setSelectedPageId] = useState(
    initialData.pages[0]?.id ?? "",
  );
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const blockRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const dragState = useRef<DragState | null>(null);

  const selectedPage = data.pages.find((page) => page.id === selectedPageId);
  const visiblePages = data.pages.filter(
    (page) => page.folderId === selectedFolderId,
  );
  const visibleBlocks = data.blocks.filter(
    (block) => block.pageId === selectedPageId,
  );

  useEffect(() => {
    if (!editingBlockId) {
      return;
    }

    const editorElement = editorRefs.current[editingBlockId];
    editorElement?.focus();
  }, [editingBlockId]);

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
      setDraggingBlockId(null);

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

  function updateBlock(
    blockId: string,
    updates: Partial<Pick<AppData["blocks"][number], "content" | "height" | "width" | "x" | "y">>,
  ) {
    setData((currentData) => ({
      ...currentData,
      blocks: currentData.blocks.map((block) =>
        block.id === blockId ? { ...block, ...updates } : block,
      ),
    }));
  }

  function selectBlock(blockId: string) {
    setSelectedBlockId(blockId);
    setEditingBlockId(blockId);
  }

  function saveBlockSize(blockId: string) {
    const blockElement = blockRefs.current[blockId];

    if (!blockElement) {
      return;
    }

    updateBlock(blockId, {
      width: Math.max(MIN_BLOCK_WIDTH, blockElement.offsetWidth),
      height: Math.max(MIN_BLOCK_HEIGHT, blockElement.offsetHeight),
    });
  }

  function startBlockDrag(
    event: React.PointerEvent<HTMLDivElement>,
    blockId: string,
  ) {
    const block = data.blocks.find((item) => item.id === blockId);
    const canvasElement = canvasRef.current;

    if (!block || !canvasElement) {
      return;
    }

    const canvasRect = canvasElement.getBoundingClientRect();

    dragState.current = {
      blockId,
      offsetX: event.clientX - canvasRect.left - block.x,
      offsetY: event.clientY - canvasRect.top - block.y,
    };
    setDraggingBlockId(blockId);
    setSelectedBlockId(blockId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveBlock(event: React.PointerEvent<HTMLDivElement>) {
    const currentDrag = dragState.current;
    const canvasElement = canvasRef.current;

    if (!currentDrag || !canvasElement) {
      return;
    }

    const canvasRect = canvasElement.getBoundingClientRect();
    const x = event.clientX - canvasRect.left - currentDrag.offsetX;
    const y = event.clientY - canvasRect.top - currentDrag.offsetY;

    updateBlock(currentDrag.blockId, {
      x: Math.max(0, x),
      y: Math.max(0, y),
    });
  }

  function endBlockDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragState.current) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    dragState.current = null;
    setDraggingBlockId(null);
  }

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
              const pageCount = data.pages.filter(
                (page) => page.folderId === folder.id,
              ).length;

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
            <div
              className={`text-block ${
                block.id === selectedBlockId ? "is-selected" : ""
              } ${block.id === editingBlockId ? "is-editing" : ""} ${
                block.id === draggingBlockId ? "is-dragging" : ""
              }`}
              key={block.id}
              onClick={(event) => {
                event.stopPropagation();
              }}
              ref={(element) => {
                blockRefs.current[block.id] = element;
              }}
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
                onPointerCancel={endBlockDrag}
                onPointerDown={(event) => startBlockDrag(event, block.id)}
                onPointerMove={moveBlock}
                onPointerUp={endBlockDrag}
                role="button"
                tabIndex={0}
              />
              <textarea
                aria-label="Text block"
                className="text-block-editor"
                onBlur={() => {
                  saveBlockSize(block.id);
                  setEditingBlockId(null);
                }}
                onChange={(event) =>
                  updateBlock(block.id, { content: event.currentTarget.value })
                }
                onFocus={() => selectBlock(block.id)}
                ref={(element) => {
                  editorRefs.current[block.id] = element;
                }}
                value={block.content}
              />
            </div>
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
