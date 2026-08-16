import { expect, test, type Page } from "@playwright/test";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR42mP8z8AARAwMAAAdAQEEhTgNAAAAAElFTkSuQmCC",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("creates primitives, applies tool lock, supports temporary hand, and erases shape geometry", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  const select = page.getByRole("button", { name: "Select (V / 1)" });
  const rectangleTool = page.getByRole("button", { name: "Rectangle (R / 2)" });
  const lock = page.getByRole("button", { name: "Keep drawing tool active" });

  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await rectangleTool.click();
  await page.mouse.click(bounds.x + 300, bounds.y + 320);
  const rectangle = page.getByLabel("rectangle shape");
  await expect(rectangle).toHaveCount(1);
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Move selected elements")).toBeVisible();

  await lock.click();
  await rectangleTool.click();
  await page.mouse.move(bounds.x + 520, bounds.y + 330);
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(bounds.x + 570, bounds.y + 365, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.up("Shift");
  await expect(rectangle).toHaveCount(2);
  await expect(rectangleTool).toHaveAttribute("aria-pressed", "true");

  await lock.click();
  await select.click();
  const beforePan = await page.locator(".canvas-content").evaluate((element) =>
    (element as HTMLElement).style.transform,
  );
  await canvas.focus();
  await page.keyboard.down("Space");
  await page.mouse.move(bounds.x + 760, bounds.y + 500);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 810, bounds.y + 545, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect.poll(async () => page.locator(".canvas-content").evaluate((element) =>
    (element as HTMLElement).style.transform,
  )).not.toBe(beforePan);
  await expect(select).toHaveAttribute("aria-pressed", "true");

  const targetBounds = await rectangle.first().boundingBox();
  if (!targetBounds) throw new Error("Rectangle bounds were not available.");
  await page.getByRole("button", { name: "Eraser (E / 0)" }).click();
  await page.mouse.click(targetBounds.x + targetBounds.width / 2, targetBounds.y + 1);
  await expect(rectangle).toHaveCount(1);
});

test("creates editable text and places a picked image only on the next canvas click", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  const select = page.getByRole("button", { name: "Select (V / 1)" });

  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(bounds.x + 300, bounds.y + 300);
  await expect(page.locator(".text-block-editor-content")).toBeVisible();
  await expect(select).toHaveAttribute("aria-pressed", "true");

  await chooseImage(page, "placed-image.png");
  await page.mouse.move(bounds.x + 560, bounds.y + 390);
  await expect(page.locator(".canvas-image-placement-preview")).toBeVisible();
  await page.mouse.click(bounds.x + 560, bounds.y + 390);
  await expect(page.locator(".text-block-image")).toHaveCount(1);
  await expect(page.locator(".canvas-image-placement-preview")).toHaveCount(0);
  await expect(select).toHaveAttribute("aria-pressed", "true");
});

test("Escape cancels a pending picked image without creating an element", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  await chooseImage(page, "cancelled-image.png");
  await page.mouse.move(bounds.x + 520, bounds.y + 360);
  await expect(page.locator(".canvas-image-placement-preview")).toBeVisible();
  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".canvas-image-placement-preview")).toHaveCount(0);
  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select (V / 1)" })).toHaveAttribute("aria-pressed", "true");
});

async function chooseImage(page: Page, name: string) {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Image (I / 9)" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ buffer: PNG, mimeType: "image/png", name });
}
