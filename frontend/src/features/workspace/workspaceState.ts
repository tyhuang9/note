import type {
  AppSessionState,
  Page,
  WorkspaceTab,
  WorkspaceView,
} from "../../types";

export type WorkspaceState = {
  readonly selectedTabId: string;
  readonly tabs: WorkspaceTab[];
};

export function getNoteWorkspaceTabId(pageId: string) {
  return `note:${pageId}`;
}

export function createNoteWorkspaceTab(page: Pick<Page, "id" | "title">) {
  return {
    id: getNoteWorkspaceTabId(page.id),
    title: page.title,
    view: { kind: "note", pageId: page.id },
  } satisfies WorkspaceTab;
}

export function restoreWorkspaceState(
  sessionState: AppSessionState | undefined,
  pages: readonly Page[],
): WorkspaceState {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const hasForwardFields = Boolean(
    sessionState &&
      (Object.prototype.hasOwnProperty.call(sessionState, "workspaceTabs") ||
        Object.prototype.hasOwnProperty.call(
          sessionState,
          "selectedWorkspaceTabId",
        )),
  );

  if (hasForwardFields) {
    const forwardState = readForwardWorkspaceState(sessionState, pagesById);

    if (forwardState) {
      return forwardState;
    }
  }

  return restoreLegacyWorkspaceState(sessionState, pages, pagesById);
}

export function getOpenNotePageIds(tabs: readonly WorkspaceTab[]) {
  return tabs.flatMap((tab) =>
    tab.view.kind === "note" ? [tab.view.pageId] : [],
  );
}

export function getSelectedNotePageId(
  tabs: readonly WorkspaceTab[],
  selectedTabId: string,
) {
  const selectedTab = tabs.find((tab) => tab.id === selectedTabId);

  return selectedTab?.view.kind === "note" ? selectedTab.view.pageId : "";
}

export function syncWorkspaceTabsWithPages(
  tabs: WorkspaceTab[],
  pages: readonly Page[],
) {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  let didChange = false;

  const nextTabs = tabs.flatMap((tab) => {
    if (tab.view.kind !== "note") {
      return [tab];
    }

    const page = pagesById.get(tab.view.pageId);

    if (!page) {
      didChange = true;
      return [];
    }
    if (tab.title === page.title) {
      return [tab];
    }

    didChange = true;
    return [{ ...tab, title: page.title }];
  });

  return didChange ? nextTabs : tabs;
}

export function reconcileWorkspaceNoteTabs(
  tabs: readonly WorkspaceTab[],
  nextPageIds: readonly string[],
  pages: readonly Page[],
) {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const existingNoteTabs = new Map(
    tabs.flatMap((tab) =>
      tab.view.kind === "note" ? [[tab.view.pageId, tab] as const] : [],
    ),
  );
  const seenPageIds = new Set<string>();
  const orderedNoteTabs = nextPageIds.flatMap((pageId) => {
    const page = pagesById.get(pageId);

    if (!page || seenPageIds.has(pageId)) {
      return [];
    }

    seenPageIds.add(pageId);
    const existingTab = existingNoteTabs.get(pageId);

    return [
      existingTab
        ? { ...existingTab, title: page.title }
        : createNoteWorkspaceTab(page),
    ];
  });
  let nextNoteIndex = 0;
  const nextTabs = tabs.flatMap((tab) => {
    if (tab.view.kind !== "note") {
      return [tab];
    }

    const replacement = orderedNoteTabs[nextNoteIndex];
    nextNoteIndex += 1;
    return replacement ? [replacement] : [];
  });

  return [...nextTabs, ...orderedNoteTabs.slice(nextNoteIndex)];
}

export function closeWorkspaceTab(
  state: WorkspaceState,
  tabId: string,
): WorkspaceState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);

  if (closedIndex === -1) {
    return state;
  }

  const tabs = state.tabs.filter((tab) => tab.id !== tabId);

  if (state.selectedTabId !== tabId) {
    return { ...state, tabs };
  }

  return {
    selectedTabId:
      tabs[closedIndex]?.id ?? tabs[closedIndex - 1]?.id ?? "",
    tabs,
  };
}

function readForwardWorkspaceState(
  sessionState: AppSessionState | undefined,
  pagesById: ReadonlyMap<string, Page>,
): WorkspaceState | null {
  if (!sessionState || !Array.isArray(sessionState.workspaceTabs)) {
    return null;
  }

  const tabs: WorkspaceTab[] = [];
  const tabIds = new Set<string>();
  const notePageIds = new Set<string>();

  for (const value of sessionState.workspaceTabs as unknown[]) {
    const tab = readWorkspaceTab(value, pagesById);

    if (
      !tab ||
      tabIds.has(tab.id) ||
      (tab.view.kind === "note" && notePageIds.has(tab.view.pageId))
    ) {
      return null;
    }

    tabIds.add(tab.id);
    if (tab.view.kind === "note") {
      notePageIds.add(tab.view.pageId);
    }
    tabs.push(tab);
  }

  const selectedTabId = sessionState.selectedWorkspaceTabId;

  if (tabs.length === 0) {
    return selectedTabId === undefined ? { selectedTabId: "", tabs } : null;
  }

  return typeof selectedTabId === "string" && tabIds.has(selectedTabId)
    ? { selectedTabId, tabs }
    : null;
}

function readWorkspaceTab(
  value: unknown,
  pagesById: ReadonlyMap<string, Page>,
): WorkspaceTab | null {
  if (!isRecord(value) || typeof value.id !== "string" ||
    typeof value.title !== "string" || !isRecord(value.view)) {
    return null;
  }

  const view = readWorkspaceView(value.view, pagesById);

  return view ? { id: value.id, title: value.title, view } : null;
}

function readWorkspaceView(
  value: Record<string, unknown>,
  pagesById: ReadonlyMap<string, Page>,
): WorkspaceView | null {
  switch (value.kind) {
    case "note":
      return typeof value.pageId === "string" && pagesById.has(value.pageId)
        ? { kind: "note", pageId: value.pageId }
        : null;
    case "agenda":
      return value.view === "agenda" || value.view === "month"
        ? { kind: "agenda", view: value.view }
        : null;
    case "settings":
      return value.section === undefined || value.section === null ||
        typeof value.section === "string"
        ? {
            kind: "settings",
            ...(typeof value.section === "string"
              ? { section: value.section }
              : {}),
          }
        : null;
    default:
      return null;
  }
}

function restoreLegacyWorkspaceState(
  sessionState: AppSessionState | undefined,
  pages: readonly Page[],
  pagesById: ReadonlyMap<string, Page>,
): WorkspaceState {
  const seenPageIds = new Set<string>();
  const pageIds = (sessionState?.openPageTabIds ?? []).filter((pageId) => {
    if (!pagesById.has(pageId) || seenPageIds.has(pageId)) {
      return false;
    }

    seenPageIds.add(pageId);
    return true;
  });
  let selectedPageId =
    sessionState?.selectedPageId && pagesById.has(sessionState.selectedPageId)
      ? sessionState.selectedPageId
      : "";

  if (!selectedPageId && pageIds.length > 0) {
    selectedPageId = pageIds[0];
  }
  if (!sessionState && !selectedPageId) {
    selectedPageId = pages[0]?.id ?? "";
  }
  if (selectedPageId && !pageIds.includes(selectedPageId)) {
    pageIds.push(selectedPageId);
  }

  return {
    selectedTabId: selectedPageId
      ? getNoteWorkspaceTabId(selectedPageId)
      : "",
    tabs: pageIds.flatMap((pageId) => {
      const page = pagesById.get(pageId);
      return page ? [createNoteWorkspaceTab(page)] : [];
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
