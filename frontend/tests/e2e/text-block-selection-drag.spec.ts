import { expect, test, type Locator, type Page } from "@playwright/test";

test("text blocks can be selected and dragged on the canvas", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();

  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();

  if (!canvasBounds) {
    throw new Error("Canvas bounds were not available.");
  }

  const toolLock = page.locator("[data-tool-lock]");
  await expect(toolLock).toHaveAccessibleName("Turn on drawing tool lock");
  await expect(toolLock).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(canvasBounds.x + 280, canvasBounds.y + 240);
  await page.keyboard.type("Drag me");

  const block = page.locator(".text-block").last();
  await expect(block.locator(".text-block-editor-content")).toBeVisible();
  await page.mouse.click(canvasBounds.x + 720, canvasBounds.y + 520);
  await expect(block.locator(".text-block-display")).toBeVisible();

  const display = block.locator(".text-block-display");
  await display.click();
  await expect(block).toHaveClass(/is-selected/);
  await expect(block.locator(".text-block-editor-content")).toHaveCount(0);
  await display.dblclick();
  await expect(block.locator(".text-block-editor-content")).toBeVisible();
  await page.mouse.click(canvasBounds.x + 720, canvasBounds.y + 520);
  await expect(block.locator(".text-block-display")).toBeVisible();

  const header = block.locator(".text-block-header");
  await header.click();
  await expect(block).toHaveClass(/is-selected/);
  await expect(block.locator(".text-block-editor-content")).toHaveCount(0);

  const before = await readBlockPosition(block);
  const displayBounds = await display.boundingBox();

  if (!displayBounds) {
    throw new Error("Text block display bounds were not available.");
  }

  const startX = displayBounds.x + displayBounds.width / 2;
  const startY = displayBounds.y + displayBounds.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 96, startY + 64, { steps: 6 });
  await page.mouse.up();

  await expect.poll(() => readBlockPosition(block)).toEqual({
    x: before.x + 96,
    y: before.y + 64,
  });
  await expect(block).toHaveClass(/is-selected/);
  await expect(block.locator(".text-block-editor-content")).toHaveCount(0);

  await header.dblclick();
  await expect(block.locator(".text-block-editor-content")).toBeVisible();
});

test("a cancelled modifier body pointer does not suppress the next additive click", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  const first = await createTextBlock(page, bounds.x + 280, bounds.y + 240, "First");
  const second = await createTextBlock(page, bounds.x + 620, bounds.y + 300, "Second");
  const firstDisplay = first.locator(".text-block-display");
  const secondDisplay = second.locator(".text-block-display");

  await firstDisplay.click();
  await expect(first).toHaveClass(/is-selected/);
  await secondDisplay.dispatchEvent("pointerdown", {
    button: 0,
    clientX: bounds.x + 620,
    clientY: bounds.y + 320,
    ctrlKey: true,
    pointerId: 91,
  });
  await secondDisplay.dispatchEvent("pointercancel", { bubbles: true, pointerId: 91 });
  await expect(second).toHaveClass(/is-selected/);

  await firstDisplay.click({ modifiers: ["Control"] });
  await expect(first).not.toHaveClass(/is-selected/);
  await expect(second).toHaveClass(/is-selected/);
});

async function createTextBlock(page: Page, x: number, y: number, text: string) {
  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(x, y);
  const editor = page.locator(".text-block-editor-content").last();
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.mouse.click(x + 220, y + 160);
  const blocks = page.locator(".text-block");
  const block = blocks.nth((await blocks.count()) - 1);
  await expect(block.locator(".text-block-display")).toContainText(text);
  return block;
}

async function readBlockPosition(block: Locator) {
  return block.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
}
