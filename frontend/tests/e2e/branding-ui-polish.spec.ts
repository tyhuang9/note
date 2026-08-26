import { expect, test, type Page } from "@playwright/test";

async function createWorkspace(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
}

test("titlebar mark follows the app theme without left-edge selection accents", async ({
  page,
}) => {
  await createWorkspace(page);

  const titlebarMark = page.locator(".window-titlebar-app-icon");
  const themeToggle = page.getByRole("button", { name: "Dark mode" });
  const activeRailButton = page.locator('.rail-button[aria-pressed="true"]');
  const selectedFile = page.locator(".nav-item-page.is-selected").first();

  await expect(themeToggle).toHaveAttribute("aria-pressed", "true");
  await expect(titlebarMark).toHaveAttribute("data-theme-variant", "dark");
  const darkSource = await titlebarMark.getAttribute("src");
  const favicon = page.locator('link[data-note-favicon="app"]');
  expect(darkSource).toContain("note-mark-dark-32");
  await expect(favicon).toHaveAttribute("href", /note-mark-dark-32/);
  await expect(activeRailButton).toHaveCSS("box-shadow", "none");
  await expect(selectedFile).toHaveCSS("box-shadow", "none");

  await themeToggle.click();

  await expect(themeToggle).toHaveAttribute("aria-pressed", "false");
  await expect(titlebarMark).toHaveAttribute("data-theme-variant", "light");
  const lightSource = await titlebarMark.getAttribute("src");
  expect(lightSource).toContain("note-mark-32");
  expect(lightSource).not.toBe(darkSource);
  await expect(favicon).toHaveAttribute("href", /note-mark-32/);
  await expect(activeRailButton).toHaveCSS("box-shadow", "none");
  await expect(selectedFile).toHaveCSS("box-shadow", "none");
});

test("file row actions stay hidden until hover or keyboard focus", async ({ page }) => {
  await createWorkspace(page);

  const pageRow = page.locator(".nav-item-page").first();
  const bookmarkButton = pageRow.getByRole("button", { name: /^Bookmark / });
  const pageActions = pageRow.locator(".nav-actions");

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator(".canvas").hover({ position: { x: 20, y: 20 } });
  await expect(bookmarkButton).toHaveCSS("opacity", "0");
  await expect(bookmarkButton).toHaveCSS("pointer-events", "none");
  await expect(pageActions).toHaveCSS("opacity", "0");
  await expect(pageActions).toHaveCSS("pointer-events", "none");

  await pageRow.hover();
  await expect(bookmarkButton).toHaveCSS("opacity", "1");
  await expect(bookmarkButton).toHaveCSS("pointer-events", "auto");
  await expect(pageActions).toHaveCSS("opacity", "1");
  await expect(pageActions).toHaveCSS("pointer-events", "auto");

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator(".canvas").hover({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Tab");
  for (let index = 0; index < 50; index += 1) {
    const activeLabel = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );

    if (activeLabel === "Bookmark New page") break;
    await page.keyboard.press("Tab");
  }
  await expect(bookmarkButton).toBeFocused();
  await expect(bookmarkButton).toHaveCSS("opacity", "1");
  await expect(pageActions).toHaveCSS("opacity", "1");

  await page.getByRole("button", { name: "Create folder" }).click();
  const folderName = page.getByRole("textbox", { name: "Folder name" });
  await folderName.fill("Private notes");
  await folderName.press("Enter");

  const folderRow = page.locator(".nav-item-folder").filter({
    hasText: "Private notes",
  });
  const folderActions = folderRow.locator(".nav-actions");

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator(".canvas").hover({ position: { x: 20, y: 20 } });
  await expect(folderRow).toHaveClass(/is-active/);
  await expect(folderActions).toHaveCSS("opacity", "0");
  await folderRow.focus();
  await expect(folderActions).toHaveCSS("opacity", "1");
  await expect(
    folderRow.getByRole("button", { name: "More actions for Private notes" }),
  ).toBeVisible();
});
