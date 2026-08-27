import { expect, test } from "@playwright/test";

test("Trash shows safe metadata and restores a folder to its destination", async ({ page }) => {
  await page.addInitScript(() => {
    let restored = false;
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
      },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { structure?: { pages: Array<Record<string, unknown>> } }) => {
          switch (command) {
            case "initialize_storage":
              return { databasePath: "test.db", importedLegacyData: false, schemaVersion: 5, warnings: [] };
            case "load_workspace_data":
              return workspace();
            case "list_trash":
              return trashEntries.filter((entry) => !restored || entry.id !== "restored-folder");
            case "restore_folder_from_trash":
              return new Promise<void>((resolve) => {
                resolveRestore = resolve;
              });
            case "restore_page_from_trash":
              throw new Error("test restore failure");
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
  await expect(page.locator(".trash-feedback")).toHaveText("Could not restore Duplicate.");

  const restoreFolder = trashedItems.getByRole("listitem").filter({ hasText: "Workspace" }).getByRole("button");
  await restoreFolder.locator("xpath=ancestor::li").hover();
  await restoreFolder.click();
  await expect(restoreFolder).toBeDisabled();
  await expect(restoreFolder).toHaveAttribute("aria-label", "Restoring Duplicate");
  await expect(page.locator(".trash-feedback")).toHaveText("Restoring Duplicate…");
  await page.evaluate(() => (window as typeof window & { __trashTest: { completeRestore(): void } }).__trashTest.completeRestore());
  await expect(page.locator(".trash-feedback")).toHaveText("Restored Duplicate. 1 items remain in Trash.");

  await page.getByRole("button", { name: "File explorer" }).click();
  await expect(page.locator(".nav-item-folder.is-active").filter({ hasText: "Restored folder" })).toBeVisible();
  await expect(page.locator(".nav-item-page.is-open").filter({ hasText: "Restored child" })).toBeVisible();
});
