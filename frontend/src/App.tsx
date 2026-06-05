import "./App.css";

function App() {
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
            <div className="nav-item is-active">
              <span>Work</span>
              <span className="item-count">2</span>
            </div>
            <div className="nav-item">
              <span>Personal</span>
              <span className="item-count">2</span>
            </div>
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
            <div className="nav-item is-selected">Meeting Notes</div>
            <div className="nav-item">TODO</div>
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="page-header">
          <div>
            <p className="eyebrow">Current page</p>
            <h2>Meeting Notes</h2>
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
