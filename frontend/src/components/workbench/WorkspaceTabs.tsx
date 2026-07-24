import { useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, RefObject } from "react";
import type { WorkspaceTab } from "../../types";
import { InlineRename } from "../InlineRename";
import type { WorkbenchIconComponent, WorkbenchIconName } from "./icons";

const PAGE_TAB_DRAG_MIME_TYPE = "application/x-note-page-tab";
export const WORKSPACE_PAGE_PANEL_ID = "workspace-page-panel";

export function getWorkspaceTabId(pageId: string) {
  return `workspace-page-tab-${pageId}`;
}

export type WorkspaceTabDropPlacement = "before" | "after";

export interface WorkspaceTabsProps {
  readonly createPageButtonRef: RefObject<HTMLButtonElement | null>;
  readonly Icon: WorkbenchIconComponent;
  readonly isEditingActiveTab: boolean;
  readonly onCloseTab: (tabId: string) => void;
  readonly onCreatePage: () => void;
  readonly onRenamePage: (pageId: string, title: string) => void;
  readonly onReorderTab: (
    sourcePageId: string,
    targetPageId: string,
    placement: WorkspaceTabDropPlacement,
  ) => void;
  readonly onSelectTab: (tabId: string) => void;
  readonly onSetEditingActiveTab: (isEditing: boolean) => void;
  readonly selectedTabId: string;
  readonly tabs: readonly WorkspaceTab[];
}

export function WorkspaceTabs({
  createPageButtonRef,
  Icon,
  isEditingActiveTab,
  onCloseTab,
  onCreatePage,
  onRenamePage,
  onReorderTab,
  onSelectTab,
  onSetEditingActiveTab,
  selectedTabId,
  tabs,
}: Readonly<WorkspaceTabsProps>) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    pageId: string;
    placement: WorkspaceTabDropPlacement;
  } | null>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLElement>());

  function setTabButtonRef(tabId: string, element: HTMLElement | null) {
    if (element) {
      tabButtonRefs.current.set(tabId, element);
    } else {
      tabButtonRefs.current.delete(tabId);
    }
  }

  function closeTabAndRestoreFocus(tabId: string) {
    const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
    const nextFocusTabId =
      selectedTabId !== tabId && tabs.some((tab) => tab.id === selectedTabId)
        ? selectedTabId
        : tabs[closedIndex + 1]?.id ?? tabs[closedIndex - 1]?.id ?? "";

    onCloseTab(tabId);
    window.requestAnimationFrame(() => {
      if (nextFocusTabId) {
        tabButtonRefs.current.get(nextFocusTabId)?.focus();
      } else {
        createPageButtonRef.current?.focus();
      }
    });
  }

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
    event: KeyboardEvent<HTMLElement>,
    tabIndex: number,
  ) {
    if (event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      closeTabAndRestoreFocus(tabs[tabIndex]?.id ?? "");
      return;
    }

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
    <div
      className="page-tabs"
      role="tablist"
      aria-label="Open workspace views"
    >
      {tabs.map((page, tabIndex) => {
        const notePageId =
          page.view.kind === "note" ? page.view.pageId : null;
        const isNoteTab = notePageId !== null;
        const isActive = page.id === selectedTabId;
        const isEditingThisTab = isNoteTab && isActive && isEditingActiveTab;
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
            draggable={isNoteTab && !isEditingThisTab}
            key={page.id}
            onAuxClick={(event) => {
              if (event.button !== 1) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              closeTabAndRestoreFocus(page.id);
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
              if (!isNoteTab || !hasPageTabDragData(event)) {
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
              if (!isNoteTab || isEditingThisTab) {
                event.preventDefault();
                return;
              }

              event.stopPropagation();
              setDraggedTabId(page.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(
                PAGE_TAB_DRAG_MIME_TYPE,
                notePageId,
              );
              event.dataTransfer.setData("text/plain", page.title);
            }}
            onDrop={(event) => {
              if (!isNoteTab || !hasPageTabDragData(event)) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();

              const sourcePageId =
                event.dataTransfer.getData(PAGE_TAB_DRAG_MIME_TYPE) ||
                draggedTabId;

              if (sourcePageId && sourcePageId !== notePageId) {
                onReorderTab(
                  sourcePageId,
                  notePageId,
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
                  aria-keyshortcuts="Delete"
                  aria-label={page.title}
                  aria-selected="true"
                  className="page-tab-rename-anchor"
                  id={getWorkspaceTabId(page.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, tabIndex)}
                  ref={(element) => setTabButtonRef(page.id, element)}
                  role="tab"
                  tabIndex={0}
                />
                <Icon name="document-text" />
                <InlineRename
                  ariaLabel="Page title"
                  initialValue={page.title}
                  onCancel={() => onSetEditingActiveTab(false)}
                  onCommit={(value) => {
                    onRenamePage(notePageId, value);
                    onSetEditingActiveTab(false);
                  }}
                />
              </>
            ) : (
              <button
                aria-controls={WORKSPACE_PAGE_PANEL_ID}
                aria-keyshortcuts="Delete"
                aria-selected={isActive}
                className="page-tab-main"
                id={getWorkspaceTabId(page.id)}
                onClick={() => onSelectTab(page.id)}
                onDoubleClick={() => {
                  if (isNoteTab && isActive) {
                    onSetEditingActiveTab(true);
                  }
                }}
                onKeyDown={(event) => handleTabKeyDown(event, tabIndex)}
                ref={(element) => setTabButtonRef(page.id, element)}
                title={
                  isNoteTab && isActive
                    ? "Double-click to rename page"
                    : page.title
                }
                role="tab"
                tabIndex={isActive ? 0 : -1}
                type="button"
              >
                <Icon name={getWorkspaceTabIcon(page)} />
                <span className="page-title">{page.title}</span>
              </button>
            )}
            <button
              aria-label={`Close ${page.title}`}
              className="page-tab-close"
              onClick={(event) => {
                event.stopPropagation();
                closeTabAndRestoreFocus(page.id);
              }}
              tabIndex={-1}
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
        ref={createPageButtonRef}
        title="Create root page"
        type="button"
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

function getWorkspaceTabIcon(tab: WorkspaceTab): WorkbenchIconName {
  switch (tab.view.kind) {
    case "note":
      return "document-text";
    case "agenda":
      return "rectangle-stack";
    case "settings":
      return "adjustments-horizontal";
  }
}
