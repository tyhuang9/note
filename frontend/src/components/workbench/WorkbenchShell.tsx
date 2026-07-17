import type { ReactNode } from "react";

export interface WorkbenchShellProps {
  readonly children: ReactNode;
  readonly isAssistantOverlayOpen: boolean;
  readonly isAssistantOpen: boolean;
  readonly isCompactWorkbench: boolean;
  readonly isDarkMode: boolean;
  readonly isExplorerCollapsed: boolean;
  readonly isExplorerOverlayOpen: boolean;
  readonly isNarrowWorkbench: boolean;
  readonly onCloseAssistantOverlay: () => void;
  readonly onCloseExplorerOverlay: () => void;
}

export function WorkbenchShell({
  children,
  isAssistantOverlayOpen,
  isAssistantOpen,
  isCompactWorkbench,
  isDarkMode,
  isExplorerCollapsed,
  isExplorerOverlayOpen,
  isNarrowWorkbench,
  onCloseAssistantOverlay,
  onCloseExplorerOverlay,
}: Readonly<WorkbenchShellProps>) {
  return (
    <main
      className={`app-shell workbench-shell ${isDarkMode ? "is-dark" : ""} ${
        isExplorerCollapsed ? "is-sidebar-collapsed" : ""
      } ${isAssistantOpen ? "has-assistant-panel" : ""} ${
        isCompactWorkbench ? "is-compact-workbench" : ""
      } ${isNarrowWorkbench ? "is-narrow-workbench" : ""} ${
        isExplorerOverlayOpen ? "is-explorer-overlay-open" : ""
      } ${isAssistantOverlayOpen ? "is-assistant-overlay-open" : ""}`}
    >
      {children}
      {isExplorerOverlayOpen ? (
        <button
          aria-label="Close explorer"
          className="workbench-overlay-backdrop is-explorer-backdrop"
          onClick={onCloseExplorerOverlay}
          type="button"
        />
      ) : null}
      {isAssistantOverlayOpen ? (
        <button
          aria-label="Close assistant"
          className="workbench-overlay-backdrop is-assistant-backdrop"
          onClick={onCloseAssistantOverlay}
          type="button"
        />
      ) : null}
    </main>
  );
}
