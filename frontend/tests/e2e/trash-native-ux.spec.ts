import { expect, test } from "@playwright/test";

test("Trash shows safe metadata and restores a folder to its destination", async ({ page }) => {
  await page.addInitScript(() => {
    let restored = false;
    let archived = false;
    let archiveCalls = 0;
    let failNextTrashList = false;
    const commandLog: string[] = [];
    let resolveArchive: (() => void) | undefined;
    let resolveRestore: (() => void) | undefined;
    const trashEntries = [
      {
        id: "restored-folder",
        kind: "folder",
        name: "Duplicate",
        previousLocation: "Workspace",
        trashedAt: 1_700_000_000_000,
      },
      {
        id: "failing-page",
        kind: "page",
        name: "Duplicate",
        previousLocation: "Root",
        trashedAt: 1_699_000_000_000,
      },
    ];
    const workspace = () => ({
      elements: [],
      folders: [
        { id: "other", name: "Other folder", isBookmarked: false },
        ...(restored ? [{ id: "restored-folder", name: "Restored folder", isBookmarked: false }] : []),
      ],
      isDarkMode: true,
      pages: [
        { id: "unrelated", folderId: "other", title: "Unrelated", isBookmarked: false, revision: 0 },
        ...(restored ? [{ id: "restored-child", folderId: "restored-folder", title: "Restored child", isBookmarked: false, revision: 0 }] : []),
      ],
      sessionState: {},
      warnings: [],
    });

    Object.assign(window, {
      isTauri: true,
      __trashTest: {
        completeRestore: () => {
          restored = true;
          resolveRestore?.();
        },
        completeArchive: () => {
          archived = true;
          resolveArchive?.();
        },
        archiveCalls: () => archiveCalls,
        clearCommandLog: () => { commandLog.length = 0; },
        commandLog: () => commandLog,
        failNextTrashList: () => { failNextTrashList = true; },
      },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { structure?: { pages: Array<Record<string, unknown>> } }) => {
          commandLog.push(command);
          switch (command) {
            case "initialize_storage":
              return { databasePath: "test.db", importedLegacyData: false, schemaVersion: 5, warnings: [] };
            case "load_workspace_data":
              return workspace();
            case "list_trash":
              if (failNextTrashList) {
                failNextTrashList = false;
                throw new Error("test trash refresh failure");
              }
              return [
                ...trashEntries.filter((entry) => !restored || entry.id !== "restored-folder"),
                ...(archived ? [{
                  id: "restored-child",
                  kind: "page",
                  name: "Restored child",
                  previousLocation: "Restored folder",
                  trashedAt: 1_701_000_000_000,
                }] : []),
              ];
            case "restore_folder_from_trash":
              return new Promise<void>((resolve) => {
                resolveRestore = resolve;
              });
            case "restore_page_from_trash":
              throw new Error("test restore failure");
            case "move_page_to_trash":
              archiveCalls += 1;
              return new Promise<void>((resolve) => {
                resolveArchive = resolve;
              });
            case "reconcile_workspace_structure":
              return {
                pages: (args?.structure?.pages ?? []).map((entry) => ({ ...entry, revision: 0 })),
              };
            case "apply_scene_changes":
              return { newRevision: 0, pageId: "unrelated" };
            default:
              return undefined;
          }
        },
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "2 items in Trash" }).click();
  const trashedItems = page.getByRole("list", { name: "Trashed items" });
  await expect(trashedItems).toBeVisible();
  await expect(trashedItems.getByRole("listitem").filter({ hasText: "Duplicate" })).toHaveCount(2);
  await expect(trashedItems.getByRole("listitem").filter({ hasText: "Workspace" })).toContainText("Workspace");
  await expect(trashedItems.getByRole("listitem").filter({ hasText: "Root" })).toContainText("Root");

  const restorePage = trashedItems.getByRole("listitem").filter({ hasText: "Root" }).getByRole("button");
  await restorePage.locator("xpath=ancestor::li").hover();
  await restorePage.click();
  await expect(page.locator(".trash-status")).toHaveText("Could not restore Duplicate.");
  await expect(page.locator(".trash-status")).toHaveCSS("color", "rgb(216, 216, 216)");
  await page.getByRole("button", { name: "Dark mode" }).click();
  await expect(page.locator(".trash-status")).toHaveCSS("color", "rgb(71, 84, 103)");
  await page.getByRole("button", { name: "Dark mode" }).click();

  const restoreFolder = trashedItems.getByRole("listitem").filter({ hasText: "Workspace" }).getByRole("button");
  await page.evaluate(() => (window as typeof window & { __trashTest: { clearCommandLog(): void } }).__trashTest.clearCommandLog());
  await restoreFolder.locator("xpath=ancestor::li").hover();
  await restoreFolder.click();
  await expect(restoreFolder).toBeDisabled();
  await expect(restoreFolder).toHaveAttribute("aria-label", "Restoring Duplicate");
  await expect(page.getByRole("button", { name: "Empty Trash" })).toBeDisabled();
  await expect(page.locator(".trash-status")).toHaveText("Restoring Duplicate…");
  const restoreCommands = await page.evaluate(() => (window as typeof window & { __trashTest: { commandLog(): string[] } }).__trashTest.commandLog());
  expect(restoreCommands.indexOf("reconcile_workspace_structure")).toBeGreaterThanOrEqual(0);
  expect(restoreCommands.indexOf("reconcile_workspace_structure")).toBeLessThan(restoreCommands.indexOf("restore_folder_from_trash"));
  await page.evaluate(() => (window as typeof window & { __trashTest: { completeRestore(): void } }).__trashTest.completeRestore());
  await expect(page.locator(".trash-status")).toHaveText("Restored Duplicate. 1 item remains in Trash.");

  await page.getByRole("button", { name: "File explorer" }).click();
  await expect(page.locator(".nav-item-folder.is-active").filter({ hasText: "Restored folder" })).toBeVisible();
  await expect(page.locator(".nav-item-page.is-open").filter({ hasText: "Restored child" })).toBeVisible();

  const archiveChild = page.locator('[data-page-trash-action="restored-child"]');
  await page.evaluate(() => (window as typeof window & { __trashTest: { clearCommandLog(): void } }).__trashTest.clearCommandLog());
  await archiveChild.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(archiveChild).toBeDisabled();
  await expect(archiveChild).toHaveAttribute("aria-label", "Moving Restored child to Trash");
  await page.getByRole("button", { name: "1 item in Trash" }).click();
  await expect(page.getByRole("button", { name: "Empty Trash" })).toBeDisabled();
  await expect(page.locator(".trash-status")).toHaveText("Moving Restored child to Trash…");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __trashTest: { archiveCalls(): number } }).__trashTest.archiveCalls())).toBe(1);
  const archiveCommands = await page.evaluate(() => (window as typeof window & { __trashTest: { commandLog(): string[] } }).__trashTest.commandLog());
  expect(archiveCommands.indexOf("reconcile_workspace_structure")).toBeGreaterThanOrEqual(0);
  expect(archiveCommands.indexOf("reconcile_workspace_structure")).toBeLessThan(archiveCommands.indexOf("move_page_to_trash"));
  await page.evaluate(() => (window as typeof window & { __trashTest: { failNextTrashList(): void } }).__trashTest.failNextTrashList());
  await page.evaluate(() => (window as typeof window & { __trashTest: { completeArchive(): void } }).__trashTest.completeArchive());
  await expect(page.locator('[data-page-trash-action="restored-child"]')).toHaveCount(0);
  await expect(page.locator(".trash-status")).toHaveText("Moved Restored child to Trash. Trash could not refresh; it will update when reopened.");
  await expect(page.locator("#workspace-explorer-panel")).toBeFocused();

  await page.getByRole("button", { name: "File explorer" }).click();
  await page.locator('.folder-menu-trigger[data-folder-id="restored-folder"]').focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(page.locator('.folder-menu-trigger[data-folder-id="restored-folder"]')).toHaveCount(0);
  await expect(page.locator("#workspace-explorer-panel")).toBeFocused();
});

test("Empty Trash flushes first, refreshes an empty preview, and reports deferred asset cleanup", async ({ page }) => {
  await page.addInitScript(() => {
    const mode = window.sessionStorage.getItem("trash-native-mode") ?? "empty";
    let purged = false;
    let refreshedEmptyPreview = false;
    const commandLog: string[] = [];
    const trashEntries = [{
      id: "trashed-page",
      kind: "page",
      name: "Trashed page",
      previousLocation: "Root",
      trashedAt: 1_700_000_000_000,
    }];
    const workspace = () => ({
      elements: [],
      folders: [{ id: "", name: "Root", isBookmarked: false }],
      isDarkMode: false,
      pages: [{ id: "active-page", folderId: "", title: "Active page", isBookmarked: false, revision: 0 }],
      sessionState: {},
      warnings: [],
    });

    Object.assign(window, {
      isTauri: true,
      __trashCorrection: {
        clearCommandLog: () => { commandLog.length = 0; },
        commandLog: () => commandLog,
      },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { structure?: { pages: Array<Record<string, unknown>> } }) => {
          commandLog.push(command);
          switch (command) {
            case "initialize_storage":
              return { databasePath: "test.db", importedLegacyData: false, schemaVersion: 5, warnings: [] };
            case "load_workspace_data":
              return workspace();
            case "list_trash":
              return (mode === "empty" && refreshedEmptyPreview) || purged ? [] : trashEntries;
            case "get_trash_purge_preview":
              refreshedEmptyPreview = mode === "empty";
              return mode === "empty"
                ? { confirmationToken: "empty", folderCount: 0, pageCount: 0, elementCount: 0 }
                : { confirmationToken: "warning", folderCount: 0, pageCount: 1, elementCount: 0 };
            case "purge_trash":
              purged = true;
              return {
                confirmationToken: "warning",
                folderCount: 0,
                pageCount: 1,
                elementCount: 0,
                cleanupWarning: "retry deferred asset cleanup",
              };
            case "reconcile_workspace_structure":
              return { pages: (args?.structure?.pages ?? []).map((entry) => ({ ...entry, revision: 0 })) };
            case "apply_scene_changes":
              return { newRevision: 0, pageId: "active-page" };
            default:
              return undefined;
          }
        },
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "1 item in Trash" }).click();
  await page.evaluate(() => (window as typeof window & { __trashCorrection: { clearCommandLog(): void } }).__trashCorrection.clearCommandLog());
  await page.getByRole("button", { name: "Empty Trash" }).click();
  await expect(page.locator(".trash-status")).toHaveText("Trash is already empty.");
  await expect(page.getByRole("list", { name: "Trashed items" }).getByRole("listitem")).toHaveCount(0);
  const emptyCommands = await page.evaluate(() => (window as typeof window & { __trashCorrection: { commandLog(): string[] } }).__trashCorrection.commandLog());
  expect(emptyCommands.indexOf("reconcile_workspace_structure")).toBeGreaterThanOrEqual(0);
  expect(emptyCommands.indexOf("reconcile_workspace_structure")).toBeLessThan(emptyCommands.indexOf("get_trash_purge_preview"));
  expect(emptyCommands).not.toContain("purge_trash");

  await page.evaluate(() => window.sessionStorage.setItem("trash-native-mode", "warning"));
  await page.reload();
  await page.getByRole("button", { name: "1 item in Trash" }).click();
  await page.evaluate(() => (window as typeof window & { __trashCorrection: { clearCommandLog(): void } }).__trashCorrection.clearCommandLog());
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Empty Trash" }).click();
  await expect(page.locator(".trash-status")).toHaveText("Permanently deleted 0 folders, 1 page, and 0 canvas elements. Some purged assets will be cleaned up automatically.");
  const purgeCommands = await page.evaluate(() => (window as typeof window & { __trashCorrection: { commandLog(): string[] } }).__trashCorrection.commandLog());
  expect(purgeCommands.indexOf("reconcile_workspace_structure")).toBeGreaterThanOrEqual(0);
  expect(purgeCommands.indexOf("reconcile_workspace_structure")).toBeLessThan(purgeCommands.indexOf("purge_trash"));
});

test("Trash metadata startup failure keeps native persistence active", async ({ page }) => {
  await page.addInitScript(() => {
    let archiveCalls = 0;
    let legacyLoadCalls = 0;
    const workspace = {
      elements: [],
      folders: [{ id: "folder", name: "Stored folder", isBookmarked: false }],
      isDarkMode: false,
      pages: [{ id: "stored-page", folderId: "folder", title: "Stored page", isBookmarked: false, revision: 0 }],
      sessionState: {},
      warnings: [],
    };
    Object.assign(window, {
      isTauri: true,
      __trashStartup: {
        archiveCalls: () => archiveCalls,
        legacyLoadCalls: () => legacyLoadCalls,
      },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { structure?: { pages: Array<Record<string, unknown>> } }) => {
          switch (command) {
            case "initialize_storage":
              return { databasePath: "startup.db", importedLegacyData: false, schemaVersion: 5, warnings: [] };
            case "load_workspace_data":
              return workspace;
            case "list_trash":
              throw new Error("temporary Trash metadata failure");
            case "move_page_to_trash":
              archiveCalls += 1;
              return undefined;
            case "load_app_data":
              legacyLoadCalls += 1;
              throw new Error("legacy fallback should not run");
            case "reconcile_workspace_structure":
              return { pages: (args?.structure?.pages ?? []).map((entry) => ({ ...entry, revision: 0 })) };
            case "apply_scene_changes":
              return { newRevision: 0, pageId: "stored-page" };
            default:
              return undefined;
          }
        },
      },
    });
  });

  await page.goto("/");
  await expect(page.locator('[data-page-trash-action="stored-page"]')).toBeVisible();
  await expect(page.locator("[data-trash-announcement]")).toHaveText("Trash could not load; it will refresh when reopened.");
  await expect(page.locator("[data-trash-announcement][role=status]")).toHaveCount(1);
  await page.getByRole("button", { name: "0 items in Trash" }).click();
  await expect(page.locator(".trash-status")).toHaveText("Trash could not load; it will refresh when reopened.");
  await expect(page.locator(".trash-status[role=status]")).toHaveCount(0);
  await page.getByRole("button", { name: "File explorer" }).click();
  await page.locator('[data-page-trash-action="stored-page"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __trashStartup: { archiveCalls(): number; legacyLoadCalls(): number } }).__trashStartup.archiveCalls())).toBe(1);
  await expect(page.locator('[data-page-trash-action="stored-page"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __trashStartup: { legacyLoadCalls(): number } }).__trashStartup.legacyLoadCalls())).toBe(0);
});
