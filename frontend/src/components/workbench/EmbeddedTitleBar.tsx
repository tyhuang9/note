import type { Ref } from "react";
import noteAppIcon from "../../../../docs/assets/note-mark-32.png";
import type { WorkbenchIconComponent } from "./icons";
import { WorkspaceTabs, type WorkspaceTab, type WorkspaceTabDropPlacement } from "./WorkspaceTabs";
import { WindowControls, type DesktopPlatform } from "./WindowControls";

export interface EmbeddedTitleBarProps {
  readonly Icon: WorkbenchIconComponent;
  readonly isEditingActiveTab: boolean;
  readonly isExplorerCollapsed: boolean;
  readonly onCloseTab: (pageId: string) => void;
  readonly onCreatePage: () => void;
  readonly onRenamePage: (pageId: string, title: string) => void;
  readonly onReorderTab: (sourcePageId: string, targetPageId: string, placement: WorkspaceTabDropPlacement) => void;
  readonly onSelectTab: (pageId: string) => void;
  readonly onSetEditingActiveTab: (isEditing: boolean) => void;
  readonly onToggleExplorer: (trigger: HTMLButtonElement) => void;
  readonly platform: DesktopPlatform | null;
  readonly selectedPageId: string;
  readonly tabs: readonly WorkspaceTab[];
  readonly titleSearch: Readonly<{ pageId: string; ranges: readonly Readonly<{ end: number; isActive: boolean; start: number }>[] }>;
  readonly toggleButtonRef: Ref<HTMLButtonElement>;
}

export function EmbeddedTitleBar({ Icon, isEditingActiveTab, isExplorerCollapsed, onCloseTab, onCreatePage, onRenamePage, onReorderTab, onSelectTab, onSetEditingActiveTab, onToggleExplorer, platform, selectedPageId, tabs, titleSearch, toggleButtonRef }: Readonly<EmbeddedTitleBarProps>) {
  const hasCustomWindowControls = platform === "windows" || platform === "linux";

  return (
    <header className={`window-titlebar ${platform ? `is-${platform}` : ""}`}>
      {platform === "macos" ? <div aria-hidden="true" className="window-titlebar-macos-inset" /> : null}
      <div className="window-titlebar-brand">
        <img alt="" aria-hidden="true" className="window-titlebar-app-icon" src={noteAppIcon} />
        <span>Note</span>
      </div>
      <button aria-controls="workspace-explorer-panel" aria-expanded={!isExplorerCollapsed} aria-label={isExplorerCollapsed ? "Expand sidebar" : "Collapse sidebar"} className="window-titlebar-sidebar-toggle" onClick={(event) => onToggleExplorer(event.currentTarget)} ref={toggleButtonRef} title={isExplorerCollapsed ? "Expand sidebar" : "Collapse sidebar"} type="button">
        <Icon name="panel" />
      </button>
      <WorkspaceTabs Icon={Icon} isEditingActiveTab={isEditingActiveTab} onCloseTab={onCloseTab} onCreatePage={onCreatePage} onRenamePage={onRenamePage} onReorderTab={onReorderTab} onSelectTab={onSelectTab} onSetEditingActiveTab={onSetEditingActiveTab} selectedPageId={selectedPageId} showWindowDragRegion={platform !== null} tabs={tabs} titleSearch={titleSearch} />
      <div aria-hidden="true" className="window-titlebar-drag-region" data-tauri-drag-region />
      {hasCustomWindowControls ? <WindowControls /> : null}
    </header>
  );
}
