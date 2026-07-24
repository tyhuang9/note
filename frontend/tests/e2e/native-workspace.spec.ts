import { expect, test, type Page } from "@playwright/test";
import type { AppData, WorkspaceTab } from "../../src/types";

const workspaceTabs: WorkspaceTab[] = [
  { id: "agenda", title: "Agenda", view: { kind: "agenda", view: "month" } },
  {
    id: "note:page-1",
    title: "One",
    view: { kind: "note", pageId: "page-1" },
  },
  {
    id: "settings",
    title: "Accounts",
    view: { kind: "settings", section: "accounts" },
  },
  {
    id: "note:page-2",
    title: "Two",
    view: { kind: "note", pageId: "page-2" },
  },
];
const savedData: AppData = {
  blocks: [],
  folders: [],
  pages: [
    { folderId: "", id: "page-1", title: "One" },
    { folderId: "", id: "page-2", title: "Two" },
  ],
  sessionState: {
    selectedWorkspaceTabId: "agenda",
    workspaceTabs,
  },
};

test("mixed workspace tabs support keyboard selection and generic close", async ({
  page,
}) => {
  await installNativeMock(page, { loadData: savedData });
  await page.goto("/");

  const tablist = page.getByRole("tablist", {
    name: "Open workspace views",
  });
  const agendaTab = tablist.getByRole("tab", { name: "Agenda" });
  const noteTab = tablist.getByRole("tab", { name: "One" });
  const settingsTab = tablist.getByRole("tab", { name: "Accounts" });

  await expect(agendaTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#workspace-page-panel")).toBeVisible();
  await expect(agendaTab.locator("xpath=..")).toHaveAttribute("draggable", "false");
  await agendaTab.dblclick();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveCount(0);

  await agendaTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(noteTab).toBeFocused();
  await expect(noteTab).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowRight");
  await expect(settingsTab).toBeFocused();
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Settings section: accounts")).toBeVisible();
  await expect(settingsTab.locator("xpath=..")).toHaveAttribute("draggable", "false");

  await settingsTab.dblclick();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveCount(0);

  const closeSettingsButton = tablist.getByRole("button", {
    name: "Close Accounts",
  });
  await expect(closeSettingsButton).toHaveAttribute("tabindex", "-1");
  await closeSettingsButton.click();
  await expect(settingsTab).toHaveCount(0);
  const twoTab = tablist.getByRole("tab", { name: "Two" });
  await expect(twoTab).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(twoTab).toBeFocused();
});

test("Agenda rail opens and focuses one system tab without adding notes", async ({
  page,
}) => {
  const noteOnlyData: AppData = {
    ...savedData,
    sessionState: {
      selectedWorkspaceTabId: "note:page-1",
      workspaceTabs: [workspaceTabs[1]],
    },
  };

  await installNativeMock(page, { loadData: noteOnlyData });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "One" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const agendaRailButton = page.getByRole("button", { name: "Open Agenda" });
  await expect(agendaRailButton).toHaveAttribute("aria-pressed", "false");
  await expect(agendaRailButton).not.toHaveClass(/is-active/);

  await page.evaluate(() => {
    window.__savedAppData = undefined;
  });
  await page.getByRole("button", { name: "Open Agenda" }).click();

  const agendaTab = page.getByRole("tab", { name: "Agenda" });
  await expect(agendaTab).toHaveCount(1);
  await expect(agendaTab).toHaveAttribute("aria-selected", "true");
  await expect(agendaTab).toBeFocused();
  await expect(agendaRailButton).toHaveAttribute("aria-pressed", "true");
  await expect(agendaRailButton).toHaveClass(/is-active/);
  await expect(page.locator("#workspace-page-panel")).toHaveClass(
    /workspace-calendar-panel/,
  );
  await expect.poll(() => page.evaluate(() => window.__savedAppData?.pages)).toEqual(
    savedData.pages,
  );
});

test("workspace tabs expose one Tab stop and Delete restores adjacent focus", async ({
  page,
}) => {
  await installNativeMock(page, { loadData: savedData });
  await page.goto("/");

  const tablist = page.getByRole("tablist", {
    name: "Open workspace views",
  });
  const createPageButton = tablist.getByRole("button", {
    name: "Create root page",
  });
  const agendaTab = tablist.getByRole("tab", { name: "Agenda" });

  await expect(tablist.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(tablist.locator('[role="tab"][tabindex="-1"]')).toHaveCount(3);
  await createPageButton.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(agendaTab).toBeFocused();
  await expect(agendaTab).toHaveAttribute("aria-keyshortcuts", "Delete");

  await page.keyboard.press("Delete");
  const oneTab = tablist.getByRole("tab", { name: "One" });
  await expect(agendaTab).toHaveCount(0);
  await expect(oneTab).toBeFocused();
  await expect(oneTab).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Delete");
  await expect(tablist.getByRole("tab", { name: "Accounts" })).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(tablist.getByRole("tab", { name: "Two" })).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(tablist.getByRole("tab")).toHaveCount(0);
  await expect(createPageButton).toBeFocused();
});

test("system views expose only global actions and note shortcuts stay contextual", async ({
  page,
}) => {
  await installNativeMock(page, { loadData: savedData });
  await page.goto("/");

  const workspaceControls = page.getByRole("toolbar", {
    name: "Workspace controls",
  });
  await expect(workspaceControls.getByRole("button", { name: "AI assistant" })).toBeVisible();
  await expect(workspaceControls.getByRole("button", { name: "Dark mode" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find in canvas" })).toHaveCount(0);
  await expect(page.getByRole("button", { exact: true, name: "Grid" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Snap to grid" })).toHaveCount(0);
  await expect(page.getByLabel(/Zoom \d+%/)).toHaveCount(0);

  await page.keyboard.press("Control+F");
  await expect(page.getByRole("textbox", { name: "Find in canvas" })).toHaveCount(0);

  await page.getByRole("tab", { name: "One" }).click();
  await expect(page.getByRole("toolbar", { name: "Canvas controls" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Text formatting" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find in canvas" })).toBeVisible();
  await expect(page.getByRole("button", { exact: true, name: "Grid" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Snap to grid" })).toBeVisible();
  await expect(page.getByLabel("Zoom 100%")).toBeVisible();

  await page.keyboard.press("Control+F");
  await expect(page.getByRole("textbox", { name: "Find in canvas" })).toBeFocused();
});

test("raw save preserves canonical mixed tab order and system selection", async ({
  page,
}) => {
  await installNativeMock(page, { loadData: savedData });
  await page.goto("/");

  await expect
    .poll(() => page.evaluate(() => Boolean(window.__savedAppData)))
    .toBe(true);

  const saved = await page.evaluate(() => ({
    data: window.__savedAppData,
    wasRaw: window.__saveBodyWasRaw,
  }));

  expect(saved.wasRaw).toBe(true);
  expect(saved.data?.sessionState?.workspaceTabs).toEqual(workspaceTabs);
  expect(saved.data?.sessionState?.selectedWorkspaceTabId).toBe("agenda");
  expect(saved.data?.sessionState?.openPageTabIds).toEqual(["page-1", "page-2"]);
  expect(saved.data?.sessionState?.selectedPageId).toBeUndefined();
});

test("structured load failure stays visible with recovery guidance", async ({
  page,
}) => {
  await installNativeMock(page, {
    loadData: savedData,
    loadError: {
      code: "invalid_data",
      field: "noteData",
      message: "Saved note data is invalid.",
    },
  });
  await page.goto("/");

  const alert = page.getByRole("alert", { name: "Notes persistence status" });
  await expect(alert).toContainText("Saved notes couldn’t be loaded");
  await expect(alert).toContainText("Your stored notes are unchanged.");
  await expect(alert).toContainText("New edits stay only in memory and are not saved.");
  await expect(alert).toContainText("Copy any new content somewhere safe before retrying.");
  await expect(alert).not.toContainText("Saved note data is invalid.");
  await expect(alert).not.toContainText("invalid_data");
  await expect(alert).not.toContainText("noteData");
  await expect(alert.getByRole("button", { name: "Retry loading" })).toBeVisible();
});

test("structured save failure marks changes unsaved and offers retry", async ({
  page,
}) => {
  await installNativeMock(page, {
    loadData: savedData,
    saveError: {
      code: "mutation_unavailable",
      field: "noteData",
      message: "The note store is busy.",
    },
  });
  await page.goto("/");

  const alert = page.getByRole("alert", { name: "Notes persistence status" });
  await expect(alert).toHaveAttribute("data-unsaved", "true");
  await expect(alert).toContainText("Changes aren’t being saved");
  await expect(alert).toContainText("Your stored notes are unchanged.");
  await expect(alert).toContainText("current edits are only in memory");
  await expect(alert).toContainText("Keep this window open and retry saving.");
  await expect(alert).not.toContainText("The note store is busy.");
  await expect(alert).not.toContainText("mutation_unavailable");
  await expect(alert).not.toContainText("noteData");
  await expect(alert.getByRole("button", { name: "Retry saving" })).toBeVisible();
});

test("successful save retry announces progress and returns focus", async ({
  page,
}) => {
  await installNativeMock(page, {
    loadData: savedData,
    saveDelayMs: 250,
    saveError: {
      code: "mutation_unavailable",
      field: "noteData",
      message: "The note store is busy.",
    },
  });
  await page.goto("/");

  const alert = page.getByRole("alert", { name: "Notes persistence status" });
  const status = page.getByRole("status", {
    name: "Notes persistence updates",
  });
  const retryButton = alert.locator("button");

  await expect(retryButton).toHaveText("Retry saving");
  await page.evaluate(() => {
    window.__allowSaveSuccess = true;
  });
  await retryButton.click();
  await expect(alert).toHaveAttribute("aria-busy", "true");
  await expect(retryButton).toBeDisabled();
  await expect(retryButton).toHaveText("Retrying…");
  await expect(retryButton.locator(".persistence-retry-spinner")).toBeVisible();
  await expect(status).toHaveText("Retrying save");
  await expect(alert).toHaveCount(0);
  await expect(status).toHaveText("Changes saved");
  await expect(
    page.getByRole("tab", { name: "Agenda" }),
  ).toBeFocused();
});

test("failed save retry announces the repeated failure and preserves focus", async ({
  page,
}) => {
  await installNativeMock(page, {
    loadData: savedData,
    saveDelayMs: 250,
    saveError: {
      code: "mutation_unavailable",
      field: "noteData",
      message: "The note store is busy.",
    },
  });
  await page.goto("/");

  const alert = page.getByRole("alert", { name: "Notes persistence status" });
  const status = page.getByRole("status", {
    name: "Notes persistence updates",
  });
  const retryButton = alert.locator("button");

  await expect(retryButton).toHaveText("Retry saving");
  await retryButton.click();
  await expect(alert).toHaveAttribute("aria-busy", "true");
  await expect(retryButton).toBeDisabled();
  await expect(retryButton).toHaveText("Retrying…");
  await expect(retryButton.locator(".persistence-retry-spinner")).toBeVisible();
  await expect(status).toHaveText("Retrying save");
  await expect(alert).toHaveAttribute("aria-busy", "false");
  await expect(status).toHaveText(
    "Changes are still not saved. Retry saving when ready.",
  );
  await expect(retryButton).toHaveText("Retry saving");
  await expect(retryButton).toBeEnabled();
  await expect(retryButton).toBeFocused();
});

type NativeMockOptions = {
  loadData: AppData;
  loadError?: { code: string; field?: string; message: string };
  saveDelayMs?: number;
  saveError?: { code: string; field?: string; message: string };
};

async function installNativeMock(page: Page, options: NativeMockOptions) {
  await page.addInitScript((mockOptions) => {
    window.isTauri = true;
    window.__allowSaveSuccess = !mockOptions.saveError;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command: string, body: unknown) => {
        if (command === "load_app_data") {
          if (mockOptions.loadError) {
            throw mockOptions.loadError;
          }
          return mockOptions.loadData;
        }

        if (command === "save_app_data") {
          window.__saveBodyWasRaw = body instanceof Uint8Array;
          if (mockOptions.saveDelayMs) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, mockOptions.saveDelayMs),
            );
          }
          if (mockOptions.saveError && !window.__allowSaveSuccess) {
            throw mockOptions.saveError;
          }
          window.__savedAppData = JSON.parse(
            new TextDecoder().decode(body as Uint8Array),
          ) as AppData;
          return undefined;
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      metadata: { currentWindow: { label: "main" } },
    };
  }, options);
}

declare global {
  interface Window {
    __allowSaveSuccess: boolean;
    __savedAppData?: AppData;
    __saveBodyWasRaw?: boolean;
    __TAURI_INTERNALS__: {
      invoke: (command: string, body: unknown) => Promise<unknown>;
      metadata: { currentWindow: { label: string } };
    };
    isTauri: boolean;
  }
}
