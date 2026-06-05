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

function App() {
  const [data] = useState<AppData>(initialData);
  const [selectedFolderId] = useState(initialData.folders[0]?.id ?? "");
  const [selectedPageId] = useState(initialData.pages[0]?.id ?? "");

  const selectedPage = data.pages.find((page) => page.id === selectedPageId);
  const visiblePages = data.pages.filter(
    (page) => page.folderId === selectedFolderId,
  );

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
            <button type="button" aria-label="Create folder">
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
                >
                  <span>{folder.name}</span>
                  <span className="item-count">{pageCount}</span>
                </div>
              );
            })}
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
