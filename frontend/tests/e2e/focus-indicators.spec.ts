import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("selected rows use full perimeter states in dark and light themes", async ({
  page,
}) => {
  const shell = page.locator(".app-shell");
  const railButton = page.getByRole("button", { name: "File explorer" });
  const tree = page.getByRole("tree", { name: "Folders and pages" });
  const selectedPage = tree.locator('.nav-item-page[aria-selected="true"]');

  await expect(shell).toHaveClass(/is-dark/);
  await expect(railButton).toHaveAttribute("aria-pressed", "true");
  await expect(tree).toHaveAttribute("aria-multiselectable", "true");
  await expect(selectedPage).toHaveCount(1);
  await expectFullSelectedState(
    railButton,
    "rgba(196, 181, 253, 0.12)",
    "rgba(196, 181, 253, 0.55)",
  );
  await expectFullSelectedState(
    selectedPage,
    "rgba(196, 181, 253, 0.12)",
    "rgba(196, 181, 253, 0.55)",
  );

  await page.getByRole("button", { name: "Dark mode" }).click();
  await expect(shell).not.toHaveClass(/is-dark/);
  await expectFullSelectedState(
    railButton,
    "rgba(109, 40, 217, 0.1)",
    "rgba(109, 40, 217, 0.45)",
  );
  await expectFullSelectedState(
    selectedPage,
    "rgba(109, 40, 217, 0.1)",
    "rgba(109, 40, 217, 0.45)",
  );
});

test("keyboard focus and textbox editing use complete focus rings", async ({
  page,
}) => {
  const sidebarToggle = page.locator(
    '.rail-button[aria-controls="workspace-explorer-panel"]',
  ).first();

  await sidebarToggle.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(sidebarToggle).toBeFocused();
  await expectFocusRing(sidebarToggle, "rgb(196, 181, 253)");

  await clickCanvas(page, 300, 240);
  await page.keyboard.press("x");

  const block = page.locator(".text-block").last();
  const editor = block.locator(".text-block-editor-content");

  await expect(editor).toBeFocused();
  await expectFocusRing(block, "rgb(196, 181, 253)");

  const fontFamily = page.getByRole("combobox", { name: "Font family" });

  await fontFamily.focus();
  await expectFocusRing(fontFamily, "rgb(196, 181, 253)");

  await clickCanvas(page, 760, 520);
  await expect(block.locator(".text-block-display")).toBeVisible();
  await expect
    .poll(() => block.evaluate((element) => element.matches(":focus-within")))
    .toBe(false);
});

test("slash selection uses a full inner border in both themes", async ({
  page,
}) => {
  await openSlashMenu(page, 300, 240);

  let selectedOption = page.locator(
    '.slash-command-item[aria-selected="true"]',
  );

  await expectFullSelectedState(
    selectedOption,
    "rgba(196, 181, 253, 0.12)",
    "rgba(196, 181, 253, 0.55)",
  );
  await page.keyboard.press("Escape");
  await clickCanvas(page, 760, 520);
  await page.getByRole("button", { name: "Dark mode" }).click();
  await openSlashMenu(page, 520, 320);

  selectedOption = page.locator(
    '.slash-command-item[aria-selected="true"]',
  );
  await expectFullSelectedState(
    selectedOption,
    "rgba(109, 40, 217, 0.1)",
    "rgba(109, 40, 217, 0.45)",
  );
});

test("forced colors and narrow viewports keep focus visible and contained", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.emulateMedia({ forcedColors: "active" });

  const sidebarToggle = page.locator(
    '.rail-button[aria-controls="workspace-explorer-panel"]',
  ).first();

  await sidebarToggle.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(sidebarToggle).toBeFocused();
  await expect.poll(() => getOutlineWidth(sidebarToggle)).toBe("2px");
  await expect
    .poll(() =>
      sidebarToggle.evaluate(
        (element) => window.getComputedStyle(element).outlineStyle,
      ),
    )
    .toBe("solid");

  const bounds = await sidebarToggle.boundingBox();

  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? 0) - 4).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0) + 4).toBeLessThanOrEqual(360);
  await expect(page.getByRole("button", { name: "File explorer" })).toHaveCSS(
    "forced-color-adjust",
    "none",
  );
});

async function clickCanvas(page: Page, x: number, y: number) {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.click(bounds.x + x, bounds.y + y);
}

async function openSlashMenu(page: Page, x: number, y: number) {
  await clickCanvas(page, x, y);
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox", { name: /slash commands/i })).toBeVisible();
}

async function expectFullSelectedState(
  locator: Locator,
  expectedBackground: string,
  expectedBorderColor: string,
) {
  await expect(locator).toHaveCSS("background-color", expectedBackground);
  await expect(locator).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
  const shadow = await locator.evaluate(
    (element) => window.getComputedStyle(element).boxShadow,
  );

  expect(shadow).toContain("0px 0px 0px 1px");
  expect(shadow).toContain(expectedBorderColor);
  expect(shadow).not.toMatch(/\b(?:2|3)px 0px 0px/);
}

async function expectFocusRing(locator: Locator, expectedColor: string) {
  await expect.poll(() => getOutlineWidth(locator)).toBe("2px");
  await expect(locator).toHaveCSS("outline-color", expectedColor);
  await expect(locator).toHaveCSS("outline-offset", "2px");
}

function getOutlineWidth(locator: Locator) {
  return locator.evaluate(
    (element) => window.getComputedStyle(element).outlineWidth,
  );
}
