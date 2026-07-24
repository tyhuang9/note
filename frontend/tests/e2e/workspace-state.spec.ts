import { expect, test } from "@playwright/test";
import {
  closeWorkspaceTab,
  restoreWorkspaceState,
} from "../../src/features/workspace/workspaceState";
import type { AppSessionState, Page, WorkspaceTab } from "../../src/types";

const pages: Page[] = [
  { folderId: "", id: "page-1", title: "One" },
  { folderId: "", id: "page-2", title: "Two" },
];

test("legacy tabs restore valid pages, order, and selection", () => {
  const restored = restoreWorkspaceState(
    {
      openPageTabIds: ["missing", "page-2", "page-1", "page-2"],
      selectedPageId: "page-1",
    },
    pages,
  );

  expect(restored.tabs).toEqual([
    noteTab("page-2", "Two"),
    noteTab("page-1", "One"),
  ]);
  expect(restored.selectedTabId).toBe("note:page-1");
});

test("forward state preserves mixed order, view details, and selection", () => {
  const workspaceTabs: WorkspaceTab[] = [
    { id: "agenda", title: "Month", view: { kind: "agenda", view: "month" } },
    noteTab("page-2", "Two"),
    {
      id: "settings",
      title: "Accounts",
      view: { kind: "settings", section: "accounts" },
    },
    noteTab("page-1", "One"),
  ];

  expect(
    restoreWorkspaceState(
      { selectedWorkspaceTabId: "settings", workspaceTabs },
      pages,
    ),
  ).toEqual({ selectedTabId: "settings", tabs: workspaceTabs });
});

test("tolerant restore treats a null settings section as absent", () => {
  const sessionState = {
    selectedWorkspaceTabId: "settings",
    workspaceTabs: [
      { id: "agenda", title: "Agenda", view: { kind: "agenda", view: "agenda" } },
      { id: "settings", title: "Settings", view: { kind: "settings", section: null } },
    ],
  } as unknown as AppSessionState;

  expect(restoreWorkspaceState(sessionState, pages)).toEqual({
    selectedTabId: "settings",
    tabs: [
      { id: "agenda", title: "Agenda", view: { kind: "agenda", view: "agenda" } },
      { id: "settings", title: "Settings", view: { kind: "settings" } },
    ],
  });
});

const invalidForwardStates = [
  {
    openPageTabIds: ["page-2"],
    selectedPageId: "page-2",
    workspaceTabs: [
      {
        id: "agenda",
        title: "Agenda",
        view: { kind: "agenda", view: "agenda" },
      },
    ],
  },
  {
    openPageTabIds: ["page-2"],
    selectedPageId: "page-2",
    selectedWorkspaceTabId: "broken",
    workspaceTabs: [
      { id: "broken", title: "Broken", view: { kind: "agenda", view: "week" } },
    ],
  },
] as unknown as AppSessionState[];

for (const [index, sessionState] of invalidForwardStates.entries()) {
  test(`partial or invalid forward state ${index + 1} falls back to legacy`, () => {
    expect(restoreWorkspaceState(sessionState, pages)).toEqual({
      selectedTabId: "note:page-2",
      tabs: [noteTab("page-2", "Two")],
    });
  });
}

test("generic close selects the adjacent system tab", () => {
  const tabs: WorkspaceTab[] = [
    { id: "agenda", title: "Agenda", view: { kind: "agenda", view: "agenda" } },
    { id: "settings", title: "Settings", view: { kind: "settings" } },
    noteTab("page-1", "One"),
  ];

  expect(closeWorkspaceTab({ selectedTabId: "agenda", tabs }, "agenda")).toEqual({
    selectedTabId: "settings",
    tabs: tabs.slice(1),
  });
});

function noteTab(pageId: string, title: string): WorkspaceTab {
  return {
    id: `note:${pageId}`,
    title,
    view: { kind: "note", pageId },
  };
}
