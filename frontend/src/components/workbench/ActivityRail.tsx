import { memo } from "react";
import type { WorkbenchIconComponent } from "./icons";

export type ActivityRailTabId =
  | "files"
  | "search"
  | "bookmarks"
  | "templates";

export interface ActivityRailProps {
  readonly activeTab: ActivityRailTabId;
  readonly bookmarkedPageCount: number;
  readonly Icon: WorkbenchIconComponent;
  readonly onSelectTab: (
    tabId: ActivityRailTabId,
    trigger: HTMLButtonElement,
  ) => void;
  readonly templatePageCount: number;
}

export const ActivityRail = memo(function ActivityRail({
  activeTab,
  bookmarkedPageCount,
  Icon,
  onSelectTab,
  templatePageCount,
}: Readonly<ActivityRailProps>) {
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
    </nav>
  );
});
