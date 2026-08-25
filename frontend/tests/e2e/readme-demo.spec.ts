import { expect, test, type Locator, type Page } from "@playwright/test";

const framesDirectory = "../docs/assets/demo-frames";

test("captures the README note-to-diagram walkthrough", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: /create new note/i }).click();
  const canvas = page.getByRole("tabpanel");
  await expect(canvas).toBeVisible();

  const title = page.getByRole("textbox", { name: "Page title" });
  await title.fill("Project launch map");
  await title.press("Enter");
  await page.screenshot({ path: `${framesDirectory}/01-note-page.png` });

  const canvasBounds = await requiredBounds(canvas, "canvas");
  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await canvas.focus();
  await page.keyboard.press("Enter");
  const textbox = page.locator(".text-block-editor-content");
  await expect(textbox).toBeFocused();
  await textbox.fill("Decide what ships first");
  await textbox.press("Control+Enter");
  await expect(page.locator(".text-block-display")).toContainText("Decide what ships first");
  await page.screenshot({ path: `${framesDirectory}/02-textbox.png` });

  const idea = await createRectangle(page, canvasBounds.x + 360, canvasBounds.y + 370);
  const plan = await createRectangle(page, canvasBounds.x + 620, canvasBounds.y + 500);
  await page.screenshot({ path: `${framesDirectory}/03-drawn-shapes.png` });

});

async function createRectangle(page: Page, x: number, y: number): Promise<Locator> {
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 220, y + 130, { steps: 6 });
  await page.mouse.up();
  const shape = page.getByRole("button", {
    name: "Select and move rectangle shape. Press F2 to edit contained text.",
  }).last();
  await expect(shape).toBeVisible();
  return shape;
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}
