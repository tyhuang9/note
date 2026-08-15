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

  await page.mouse.click(canvasBounds.x + 280, canvasBounds.y + 240);
  await page.keyboard.type("Drag me");

  const block = page.locator(".text-block").last();
  await expect(block.locator(".text-block-editor-content")).toBeVisible();
  await page.mouse.click(canvasBounds.x + 720, canvasBounds.y + 520);
  await expect(block.locator(".text-block-display")).toBeVisible();

  const header = block.locator(".text-block-header");
  await header.click();
  await expect(block).toHaveClass(/is-selected/);

  const before = await readBlockPosition(block);
  const headerBounds = await header.boundingBox();

  if (!headerBounds) {
    throw new Error("Text block header bounds were not available.");
  }

  const startX = headerBounds.x + headerBounds.width / 2;
  const startY = headerBounds.y + headerBounds.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 96, startY + 64, { steps: 6 });
  await page.mouse.up();

  await expect.poll(() => readBlockPosition(block)).toEqual({
    x: before.x + 96,
    y: before.y + 64,
  });
  await expect(block).toHaveClass(/is-selected/);
});

async function readBlockPosition(block: Locator) {
  return block.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
}
