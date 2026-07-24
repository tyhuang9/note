import React, { lazy, Suspense, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { resolveSurface, type Surface } from "./surfaces/resolveSurface";
import "./surfaces/surfaces.css";

const MainSurface = lazy(() => import("./surfaces/MainSurface"));
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

function SurfaceRoot() {
  const [surface, setSurface] = useState<Surface | null>(null);

  useEffect(() => {
    let isMounted = true;

    void resolveSurface()
      .then((resolvedSurface) => {
        if (isMounted) {
          setSurface(resolvedSurface);
        }
      })
      .catch(() => {
        if (isMounted) {
          setSurface({
            kind: "unsupported",
            label: "unresolved-native-window",
          });
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  if (!surface) {
    return <SurfaceLoading />;
  }

  switch (surface.kind) {
    case "main":
      return <MainSurface />;
    case "widget":
      return <WidgetSurface />;
    case "quick-command":
      return <QuickCommandSurface />;
    case "event-editor":
      return <EventEditorSurface />;
    case "unsupported":
      return <UnsupportedSurface label={surface.label} />;
  }
}

function SurfaceLoading() {
  return (
    <main className="surface-loading" aria-label="Loading Note" role="status">
      Loading Note...
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={<SurfaceLoading />}>
      <SurfaceRoot />
    </Suspense>
  </React.StrictMode>,
);
