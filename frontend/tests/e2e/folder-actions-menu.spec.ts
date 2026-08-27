import { expect, test, type Locator, type Page } from "@playwright/test";

async function createFolder(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await page.getByRole("button", { name: "Create folder" }).click();

  const folderNameInput = page.getByRole("textbox", { name: "Folder name" });
  await folderNameInput.fill(name);
  await folderNameInput.press("Enter");

  return page.locator(".nav-item-folder").filter({ hasText: name }).first();
}

async function expectMenuInsideViewport(page: Page, menu: Locator) {
  const viewport = page.viewportSize();
  const bounds = await menu.boundingBox();

  expect(viewport).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(8);
  expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(8);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
    (viewport?.width ?? 0) - 8,
  );
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
    (viewport?.height ?? 0) - 8,
  );
}

async function clickRowAction(row: Locator, action: Locator) {
  await row.hover();
  await action.click();
}

test("folder More and right-click share one accessible action menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  const folderRow = await createFolder(page, "Project notes");
  const rootPageTrashAction = page.getByRole("button", {
    name: "Move New page to Trash",
  });
  await expect(rootPageTrashAction).toHaveCount(1);
  await rootPageTrashAction.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-explorer-panel")).toBeFocused();
  await expect(page.locator("[data-trash-announcement]")).toHaveText(
    "Moved New page to Trash.",
  );
  const addPageButton = folderRow.getByRole("button", {
    name: "Create page in Project notes",
  });
  const moreButton = folderRow.getByRole("button", {
    name: "More actions for Project notes",
  });

  await expect(addPageButton).toHaveCount(1);
  await expect(moreButton).toHaveCount(1);
  await expect(folderRow.getByRole("button", { name: /move .* to trash/i })).toHaveCount(0);
  await expect(folderRow.getByRole("button", { name: /bookmark/i })).toHaveCount(0);

  await clickRowAction(folderRow, moreButton);
  const menu = page.getByRole("menu", { name: "Folder actions for Project notes" });
  const menuItems = menu.getByRole("menuitem");

  await expect(menu).toBeVisible();
  await expect(menuItems).toHaveText(["Bookmark", "Rename", "Move to Trash"]);
  await expect(menuItems.first()).toBeFocused();
  await expect(moreButton).toHaveAttribute("aria-expanded", "true");
  await expectMenuInsideViewport(page, menu);

  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Move to Trash" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(moreButton).toBeFocused();

  await clickRowAction(folderRow, moreButton);
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement !== document.body))
    .toBe(true);

  await clickRowAction(folderRow, moreButton);
  await page.keyboard.press("Shift+Tab");
  await expect(menu).toHaveCount(0);
  await expect(addPageButton).toBeFocused();

  await clickRowAction(folderRow, moreButton);
  await page.getByRole("heading", { name: "Files" }).click();
  await expect(menu).toHaveCount(0);

  await page.setViewportSize({ width: 1024, height: 220 });
  await clickRowAction(folderRow, moreButton);
  await expectMenuInsideViewport(page, menu);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1024, height: 720 });

  await folderRow.click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(menuItems).toHaveText(["Bookmark", "Rename", "Move to Trash"]);
  await menu.getByRole("menuitem", { name: "Rename" }).click();

  const renameInput = page.getByRole("textbox", { name: "Folder name" });
  await expect(renameInput).toBeFocused();
  await renameInput.fill("Renamed project");
  await renameInput.press("Enter");

  const renamedRow = page
    .locator(".nav-item-folder")
    .filter({ hasText: "Renamed project" })
    .first();
  await clickRowAction(
    renamedRow,
    renamedRow.getByRole("button", { name: "More actions for Renamed project" }),
  );
  await page.getByRole("menuitem", { name: "Bookmark" }).click();
  await expect(page.getByRole("button", { name: "1 favorites" })).toBeVisible();

  await clickRowAction(
    renamedRow,
    renamedRow.getByRole("button", { name: "Create page in Renamed project" }),
  );
  await expect(page.getByRole("textbox", { name: "Page title" })).toBeFocused();
  await page.getByRole("textbox", { name: "Page title" }).press("Escape");

  await page.getByRole("button", { name: "1 favorites" }).click();
  const favoriteRow = page
    .locator(".nav-item-folder")
    .filter({ hasText: "Renamed project" })
    .first();
  await clickRowAction(
    favoriteRow,
    favoriteRow.getByRole("button", { name: "More actions for Renamed project" }),
  );
  await page.getByRole("menuitem", { name: "Remove bookmark" }).click();
  const emptyFavoritesButton = page.getByRole("button", { name: "0 favorites" });
  await expect(emptyFavoritesButton).toBeFocused();

  await page.getByRole("button", { name: "File explorer" }).click();
  const fileRow = page
    .locator(".nav-item-folder")
    .filter({ hasText: "Renamed project" })
    .first();

  await fileRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(fileRow).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create folder" })).toBeFocused();
  await expect(page.locator("[data-trash-announcement]")).toHaveText(
    "Moved Renamed project to Trash.",
  );
  await page.getByRole("button", { name: "2 items in Trash" }).click();
  await expect(page.getByRole("list", { name: "Trashed items" })).toBeVisible();
  const trashedFolder = page.getByRole("listitem").filter({ hasText: "Renamed project" });
  await expect(trashedFolder).toContainText("Renamed project");
  await expect(trashedFolder).toContainText("Workspace");
  await expect(trashedFolder.locator(".trash-entry-detail")).toContainText("·");
  await expect(page.locator(".trash-feedback")).toHaveText("Moved Renamed project to Trash.");
});
