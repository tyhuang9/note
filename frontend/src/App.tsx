import { useState } from "react";
import "./App.css";
import type { AppData } from "./types";

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

function App() {
  const [data, setData] = useState<AppData>(initialData);
  const [selectedFolderId, setSelectedFolderId] = useState(
    initialData.folders[0]?.id ?? "",
  );
  const [selectedPageId, setSelectedPageId] = useState(
    initialData.pages[0]?.id ?? "",
  );
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);

  const selectedPage = data.pages.find((page) => page.id === selectedPageId);
  const visiblePages = data.pages.filter(
    (page) => page.folderId === selectedFolderId,
  );

  function createFolder() {
    const folderId = createId("folder");

    setData((currentData) => ({
      ...currentData,
      folders: [...currentData.folders, { id: folderId, name: "New folder" }],
    }));
    setSelectedFolderId(folderId);
    setSelectedPageId("");
    setEditingFolderId(folderId);
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
            <button type="button" aria-label="Create page">
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
              >
                {page.title}
              </div>
            ))}
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

        <section className="canvas" aria-label="Freeform note canvas">
          <div className="canvas-empty">
            <p>Canvas ready</p>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
