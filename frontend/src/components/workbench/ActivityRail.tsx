import { memo } from "react";
import type { Ref } from "react";
import type { WorkbenchIconComponent } from "./icons";

export type ActivityRailTabId =
  | "files"
  | "search"
  | "bookmarks"
  | "templates";

export interface ActivityRailProps {
  readonly activeTab: ActivityRailTabId;
  readonly assistantToggleButtonRef: Ref<HTMLButtonElement>;
  readonly bookmarkedPageCount: number;
  readonly Icon: WorkbenchIconComponent;
  readonly isAssistantOpen: boolean;
  readonly isDarkMode: boolean;
  readonly onSelectTab: (
    tabId: ActivityRailTabId,
    trigger: HTMLButtonElement,
  ) => void;
  readonly onToggleAssistant: (trigger: HTMLButtonElement) => void;
  readonly onToggleDarkMode: () => void;
  readonly templatePageCount: number;
}

export const ActivityRail = memo(function ActivityRail({
  activeTab,
  assistantToggleButtonRef,
  bookmarkedPageCount,
  Icon,
  isAssistantOpen,
  isDarkMode,
  onSelectTab,
  onToggleAssistant,
  onToggleDarkMode,
  templatePageCount,
}: Readonly<ActivityRailProps>) {
  const themeToggleTitle = isDarkMode
    ? "Switch to light mode"
    : "Switch to dark mode";

  return (
    <nav className="activity-rail" aria-label="Primary workspace tools">
      <div className="rail-tabs" aria-label="Workspace views" role="group">
        <button
          type="button"
          className={`rail-button ${activeTab === "files" ? "is-active" : ""}`}
          aria-controls="workspace-explorer-panel"
          aria-label="File explorer"
          aria-pressed={activeTab === "files"}
          onClick={(event) => onSelectTab("files", event.currentTarget)}
          title="File explorer"
        >
          <Icon name="folder" />
        </button>
        <button
          type="button"
          className={`rail-button ${activeTab === "search" ? "is-active" : ""}`}
          aria-controls="workspace-explorer-panel"
          aria-label="Search files"
          aria-pressed={activeTab === "search"}
          onClick={(event) => onSelectTab("search", event.currentTarget)}
          title="Search files"
        >
          <Icon name="magnifying-glass" />
        </button>
        <button
          type="button"
          className={`rail-button ${
            activeTab === "bookmarks" ? "is-active" : ""
          } ${bookmarkedPageCount > 0 ? "has-count" : ""}`}
          aria-controls="workspace-explorer-panel"
          aria-label={`${bookmarkedPageCount} favorites`}
          aria-pressed={activeTab === "bookmarks"}
          onClick={(event) => onSelectTab("bookmarks", event.currentTarget)}
          title="Favorites"
        >
          <Icon name="bookmark" />
        </button>
        <button
          type="button"
          className={`rail-button ${
            activeTab === "templates" ? "is-active" : ""
          } ${templatePageCount > 0 ? "has-count" : ""}`}
          aria-controls="workspace-explorer-panel"
          aria-label={`${templatePageCount} templates`}
          aria-pressed={activeTab === "templates"}
          onClick={(event) => onSelectTab("templates", event.currentTarget)}
          title="Templates"
        >
          <Icon name="rectangle-stack" />
        </button>
      </div>
      <div className="rail-utilities" aria-label="Global utilities" role="group">
        <span className="rail-divider" aria-hidden="true" />
        <button
          aria-controls={isAssistantOpen ? "workspace-assistant-panel" : undefined}
          aria-expanded={isAssistantOpen}
          aria-label="AI assistant"
          className={`rail-button ${isAssistantOpen ? "is-active" : ""}`}
          onClick={(event) => onToggleAssistant(event.currentTarget)}
          ref={assistantToggleButtonRef}
          title="AI assistant"
          type="button"
        >
          <Icon name="sparkles" />
        </button>
        <button
          aria-label="Dark mode"
          aria-pressed={isDarkMode}
          className="rail-button theme-toggle"
          onClick={onToggleDarkMode}
          title={themeToggleTitle}
          type="button"
        >
          <Icon name={isDarkMode ? "sun" : "moon"} />
        </button>
      </div>
    </nav>
  );
});
