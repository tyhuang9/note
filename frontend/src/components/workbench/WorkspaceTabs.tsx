import { useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { InlineRename } from "../InlineRename";
import type { WorkbenchIconComponent } from "./icons";

const PAGE_TAB_DRAG_MIME_TYPE = "application/x-note-page-tab";
export const WORKSPACE_PAGE_PANEL_ID = "workspace-page-panel";

export function getWorkspaceTabId(pageId: string) {
  return `workspace-page-tab-${pageId}`;
}

export type WorkspaceTabDropPlacement = "before" | "after";

export interface WorkspaceTab {
  readonly id: string;
  readonly title: string;
}

export interface WorkspaceTabsProps {
  readonly Icon: WorkbenchIconComponent;
  readonly isEditingActiveTab: boolean;
  readonly onCloseTab: (pageId: string) => void;
  readonly onCreatePage: () => void;
  readonly onRenamePage: (pageId: string, title: string) => void;
  readonly onReorderTab: (
    sourcePageId: string,
    targetPageId: string,
    placement: WorkspaceTabDropPlacement,
  ) => void;
  readonly onSelectTab: (pageId: string) => void;
  readonly onSetEditingActiveTab: (isEditing: boolean) => void;
  readonly selectedPageId: string;
  readonly tabs: readonly WorkspaceTab[];
  readonly titleSearch?: Readonly<{
    pageId: string;
    ranges: readonly Readonly<{ end: number; isActive: boolean; start: number }>[];
  }>;
}

function renderHighlightedTitle(
  title: string,
  ranges: readonly Readonly<{ end: number; isActive: boolean; start: number }>[],
): ReactNode {
  const content: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) content.push(title.slice(cursor, range.start));
    content.push(
      <mark
        className={`canvas-search-match page-title-search-match${range.isActive ? " is-active-search-match" : ""}`}
        data-search-end={range.end}
        data-search-start={range.start}
        key={`title-search-${range.start}-${range.end}-${index}`}
      >
        {title.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < title.length) content.push(title.slice(cursor));
  return content;
}

export function WorkspaceTabs({
  Icon,
  isEditingActiveTab,
  onCloseTab,
  onCreatePage,
  onRenamePage,
  onReorderTab,
  onSelectTab,
  onSetEditingActiveTab,
  selectedPageId,
  tabs,
  titleSearch,
}: Readonly<WorkspaceTabsProps>) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    pageId: string;
    placement: WorkspaceTabDropPlacement;
  } | null>(null);

  function getTabDropPlacement(event: DragEvent<HTMLElement>) {
    const tabBounds = event.currentTarget.getBoundingClientRect();

    return event.clientX > tabBounds.left + tabBounds.width / 2
      ? "after"
      : "before";
  }

  function hasPageTabDragData(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes(PAGE_TAB_DRAG_MIME_TYPE);
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tabIndex: number,
  ) {
    let nextTabIndex: number;

    switch (event.key) {
      case "ArrowLeft":
        nextTabIndex = (tabIndex - 1 + tabs.length) % tabs.length;
        break;
      case "ArrowRight":
        nextTabIndex = (tabIndex + 1) % tabs.length;
        break;
      case "Home":
        nextTabIndex = 0;
        break;
      case "End":
        nextTabIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    const nextTab = tabs[nextTabIndex];
    if (!nextTab) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSelectTab(nextTab.id);
    window.requestAnimationFrame(() => {
      document.getElementById(getWorkspaceTabId(nextTab.id))?.focus();
    });
  }

  return (
    <div className="page-tabs" role="tablist" aria-label="Open pages">
      {tabs.map((page, tabIndex) => {
        const isActive = page.id === selectedPageId;
        const isEditingThisTab = isActive && isEditingActiveTab;
        const isDraggedTab = draggedTabId === page.id;
        const tabDropPlacement =
          tabDropTarget?.pageId === page.id ? tabDropTarget.placement : null;

        return (
          <div
            className={`page-tab ${isActive ? "is-active" : ""} ${
              isEditingThisTab ? "is-editing" : ""
            } ${isDraggedTab ? "is-tab-dragging" : ""} ${
              tabDropPlacement === "before" ? "is-tab-drop-before" : ""
            } ${
              tabDropPlacement === "after" ? "is-tab-drop-after" : ""
            } has-close`}
            draggable={!isEditingThisTab}
            key={page.id}
            onAuxClick={(event) => {
              if (event.button !== 1) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              onCloseTab(page.id);
            }}
            onDragEnd={() => {
              setDraggedTabId(null);
              setTabDropTarget(null);
            }}
            onDragLeave={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
              ) {
                return;
              }

              setTabDropTarget((currentTarget) =>
                currentTarget?.pageId === page.id ? null : currentTarget,
              );
            }}
            onDragOver={(event) => {
              if (!hasPageTabDragData(event)) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              setTabDropTarget({
                pageId: page.id,
                placement: getTabDropPlacement(event),
              });
            }}
            onDragStart={(event) => {
              if (isEditingThisTab) {
                event.preventDefault();
                return;
              }

              event.stopPropagation();
              setDraggedTabId(page.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(PAGE_TAB_DRAG_MIME_TYPE, page.id);
              event.dataTransfer.setData("text/plain", page.title);
            }}
            onDrop={(event) => {
              if (!hasPageTabDragData(event)) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();

              const sourcePageId =
                event.dataTransfer.getData(PAGE_TAB_DRAG_MIME_TYPE) ||
                draggedTabId;

              if (sourcePageId && sourcePageId !== page.id) {
                onReorderTab(
                  sourcePageId,
                  page.id,
                  getTabDropPlacement(event),
                );
              }

              setDraggedTabId(null);
              setTabDropTarget(null);
            }}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
              }
            }}
            role="presentation"
          >
            {isEditingThisTab ? (
              <>
                <span
                  aria-controls={WORKSPACE_PAGE_PANEL_ID}
                  aria-label={page.title}
                  aria-selected="true"
                  className="page-tab-rename-anchor"
                  id={getWorkspaceTabId(page.id)}
                  role="tab"
                />
                <Icon name="document-text" />
                <InlineRename
                  ariaLabel="Page title"
                  initialValue={page.title}
                  onCancel={() => onSetEditingActiveTab(false)}
                  onCommit={(value) => {
                    onRenamePage(page.id, value);
                    onSetEditingActiveTab(false);
                  }}
                />
              </>
            ) : (
              <button
                aria-controls={WORKSPACE_PAGE_PANEL_ID}
                aria-selected={isActive}
                className="page-tab-main"
                id={getWorkspaceTabId(page.id)}
                onClick={() => onSelectTab(page.id)}
                onDoubleClick={() => {
                  if (isActive) {
                    onSetEditingActiveTab(true);
                  }
                }}
                onKeyDown={(event) => handleTabKeyDown(event, tabIndex)}
                title={isActive ? "Double-click to rename page" : page.title}
                role="tab"
                tabIndex={isActive ? 0 : -1}
                type="button"
              >
                <Icon name="document-text" />
                <span className="page-title">
                  {titleSearch?.pageId === page.id && titleSearch.ranges.length > 0
                    ? renderHighlightedTitle(page.title, titleSearch.ranges)
                    : page.title}
                </span>
              </button>
            )}
            <button
              aria-label={`Close ${page.title}`}
              className="page-tab-close"
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(page.id);
              }}
              title="Close tab"
              type="button"
            >
              <Icon name="x-mark" />
            </button>
          </div>
        );
      })}
      <button
        className="page-tab-add"
        aria-label="Create root page"
        onClick={onCreatePage}
        title="Create root page"
        type="button"
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
