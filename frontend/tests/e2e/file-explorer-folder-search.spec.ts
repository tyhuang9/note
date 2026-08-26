import { expect, test, type Locator, type Page } from "@playwright/test";

async function createFolder(page: Page, name: string) {
  await page.getByRole("button", { name: "Create folder" }).click();

  const folderNameInput = page.getByRole("textbox", { name: "Folder name" });
  await folderNameInput.fill(name);
  await folderNameInput.press("Enter");

  return page.locator(".nav-item-folder").filter({ hasText: name }).first();
}

async function expectFolderExpanded(folderRow: Locator, expanded: boolean) {
  await expect(folderRow).toHaveAttribute("aria-expanded", String(expanded));
}

test("folder rows toggle from their full surface and file search finds folders", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  const projectFolder = await createFolder(page, "Project notes");
  const otherFolder = await createFolder(page, "Other work");

  const wasInitiallyExpanded =
    (await projectFolder.getAttribute("aria-expanded")) === "true";

  await projectFolder.locator(".nav-label").click();
  await expectFolderExpanded(projectFolder, !wasInitiallyExpanded);

  await projectFolder.locator(".item-count").click();
  await expectFolderExpanded(projectFolder, wasInitiallyExpanded);

  const moreButton = projectFolder.getByRole("button", {
    name: "More actions for Project notes",
  });
  await moreButton.click();
  await expectFolderExpanded(projectFolder, wasInitiallyExpanded);
  await page.keyboard.press("Escape");

  const folderToggle = projectFolder.getByRole("button", {
    name: wasInitiallyExpanded
      ? "Collapse Project notes"
      : "Expand Project notes",
  });
  await folderToggle.click();
  await expectFolderExpanded(projectFolder, !wasInitiallyExpanded);

  await projectFolder.focus();
  await projectFolder.press("Enter");
  await expectFolderExpanded(projectFolder, wasInitiallyExpanded);
  await projectFolder.press(" ");
  await expectFolderExpanded(projectFolder, !wasInitiallyExpanded);
  await projectFolder.press("ArrowRight");
  await expectFolderExpanded(projectFolder, true);
  await projectFolder.press("ArrowLeft");
  await expectFolderExpanded(projectFolder, false);

  await projectFolder
    .getByRole("button", { name: "Create page in Project notes" })
    .click();
  const projectPageTitle = page.getByRole("textbox", { name: "Page title" });
  await projectPageTitle.fill("Project notes draft");
  await projectPageTitle.press("Enter");

  await moreButton.click();
  await page.getByRole("menuitem", { name: "Bookmark" }).click();

  if ((await otherFolder.getAttribute("aria-expanded")) === "true") {
    await otherFolder.locator(".nav-label").click();
  }
  await otherFolder.locator(".nav-label").click();
  await expect(otherFolder).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "1 favorites" }).click();
  const favoriteProjectFolder = page
    .locator(".nav-item-folder")
    .filter({ hasText: "Project notes" })
    .first();
  const favoriteWasExpanded =
    (await favoriteProjectFolder.getAttribute("aria-expanded")) === "true";
  await favoriteProjectFolder.locator(".nav-label").click();
  await expectFolderExpanded(favoriteProjectFolder, !favoriteWasExpanded);
  await favoriteProjectFolder.focus();
  await favoriteProjectFolder.press("Enter");
  await expectFolderExpanded(favoriteProjectFolder, favoriteWasExpanded);

  await page.getByRole("button", { name: "File explorer" }).click();
  if ((await otherFolder.getAttribute("aria-expanded")) === "true") {
    await otherFolder.locator(".nav-label").click();
  }
  await otherFolder.locator(".nav-label").click();
  await expect(otherFolder).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Search files" }).click();
  const search = page.getByRole("searchbox", {
    name: "Search files and notes",
  });
  await search.fill("PROJECT NOT");

  const folderResult = page.locator(".search-result.is-folder").filter({
    hasText: "Project notes",
  });
  await expect(folderResult).toBeVisible();
  await expect(folderResult).toContainText("1 page");
  await expect(folderResult).toContainText("Folder");
  await expect(page.locator(".search-result.is-folder")).toHaveCount(1);
  await expect(
    page.locator(".search-result:not(.is-folder)").filter({
      hasText: "Project notes draft",
    }),
  ).toBeVisible();
  await expect(folderResult).not.toHaveAttribute("aria-current", "true");

  await folderResult.click();
  await expect(folderResult).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "File explorer" }).click();
  await expect(projectFolder).toHaveClass(/is-active/);
  await expect(projectFolder).toHaveAttribute("aria-selected", "true");
});
