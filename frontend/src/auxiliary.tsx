import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./surfaces/surfaces.css";

const WidgetSurface = lazy(() => import("./surfaces/WidgetSurface"));
const QuickCommandSurface = lazy(
  () => import("./surfaces/QuickCommandSurface"),
);
const EventEditorSurface = lazy(
  () => import("./surfaces/EventEditorSurface"),
);
const UnsupportedSurface = lazy(
  () => import("./surfaces/UnsupportedSurface"),
);

const root = document.getElementById("root") as HTMLElement;
const surface = root.dataset.surface;

function AuxiliaryRoot() {
  switch (surface) {
    case "widget":
      return <WidgetSurface />;
    case "quick-command":
      return <QuickCommandSurface />;
    case "event-editor":
      return <EventEditorSurface />;
    default:
      return <UnsupportedSurface label={surface ?? "unknown"} />;
  }
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Suspense
      fallback={
        <main className="surface-loading" aria-label="Loading Note" role="status">
          Loading Note...
        </main>
      }
    >
      <AuxiliaryRoot />
    </Suspense>
  </React.StrictMode>,
);
