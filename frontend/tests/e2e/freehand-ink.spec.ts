import { expect, test } from "@playwright/test";

test("draws, selects, resizes, erases, and restores native ink", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  const drawStart = { x: bounds.x + 210, y: bounds.y + 220 };
  const drawEnd = { x: bounds.x + 350, y: bounds.y + 250 };

  await page.getByRole("button", { name: "Pen (P / 7)" }).click();
  await page.mouse.move(drawStart.x, drawStart.y);
  await page.mouse.down();
  await page.mouse.move(drawEnd.x, drawEnd.y, { steps: 8 });
  await page.mouse.up();

  const ink = page.locator('[data-canvas-element-type="ink"]');
  await expect(ink).toHaveCount(1);
  const beforeMove = await ink.boundingBox();
  if (!beforeMove) throw new Error("Ink stroke was not rendered.");

  await page.getByRole("button", { name: "Highlighter (H)" }).click();
  await page.mouse.move(bounds.x + 420, bounds.y + 300);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 540, bounds.y + 300, { steps: 6 });
  await page.mouse.up();
  await expect(ink).toHaveCount(2);
  await expect(ink.nth(1)).toHaveCSS("color", "rgb(244, 197, 66)");

  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await page.mouse.move(drawStart.x + 45, drawStart.y + 10);
  await page.mouse.down();
  await page.mouse.move(drawStart.x + 85, drawStart.y + 45, { steps: 3 });
  await page.mouse.up();
  const afterMove = await ink.nth(0).boundingBox();
  expect(afterMove?.x).toBeGreaterThan(beforeMove.x + 15);

  const resize = page.getByRole("slider", { name: "Resize ink stroke" });
  await expect(resize).toBeVisible();
  const beforeResize = await ink.nth(0).boundingBox();
  const resizeBounds = await resize.boundingBox();
  if (!beforeResize || !resizeBounds) throw new Error("Ink resize handle was not visible.");
  await page.mouse.move(resizeBounds.x + resizeBounds.width / 2, resizeBounds.y + resizeBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBounds.x + 50, resizeBounds.y + 50);
  await page.mouse.up();
  const afterResize = await ink.nth(0).boundingBox();
  expect(afterResize?.width).toBeGreaterThan(beforeResize.width);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await ink.nth(0).boundingBox())?.width).toBeLessThan(afterResize!.width);
  await page.keyboard.press("Control+y");
  await expect.poll(async () => (await ink.nth(0).boundingBox())?.width).toBeGreaterThan(beforeResize.width);

  await page.getByRole("button", { name: "Eraser (E / 0)" }).click();
  const eraseTarget = await ink.nth(0).boundingBox();
  if (!eraseTarget) throw new Error("Ink eraser target was not rendered.");
  await page.mouse.move(eraseTarget.x + eraseTarget.width / 2, eraseTarget.y + eraseTarget.height / 2);
  await page.mouse.down();
  await page.mouse.move(eraseTarget.x + eraseTarget.width / 2 + 18, eraseTarget.y + eraseTarget.height / 2, { steps: 2 });
  await page.mouse.up();
  await expect(ink).toHaveCount(1);
});

test("samples pen points in world space after pan and cursor-anchored zoom", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  const anchor = { x: bounds.x + 440, y: bounds.y + 330 };
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(80, 55);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await expect(page.getByLabel(/Zoom \d+%/)).not.toHaveText("Zoom 100%");

  await page.getByRole("button", { name: "Pen (P / 7)" }).click();
  const start = { x: bounds.x + 250, y: bounds.y + 360 };
  const end = { x: bounds.x + 410, y: bounds.y + 420 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();

  const inkBounds = await page.locator('[data-canvas-element-type="ink"]').boundingBox();
  if (!inkBounds) throw new Error("Zoomed ink stroke was not rendered.");
  expect(inkBounds.x).toBeLessThanOrEqual(start.x + 12);
  expect(inkBounds.y).toBeLessThanOrEqual(start.y + 12);
  expect(inkBounds.x + inkBounds.width).toBeGreaterThanOrEqual(end.x - 12);
  expect(inkBounds.y + inkBounds.height).toBeGreaterThanOrEqual(end.y - 12);
});

test("scopes drawing shortcuts to canvas and tool focus without stealing typed text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  const select = page.getByRole("button", { name: "Select (V / 1)" });
  const pen = page.getByRole("button", { name: "Pen (P / 7)" });
  const highlighter = page.getByRole("button", { name: "Highlighter (H)" });
  const unrelatedControl = page.getByRole("button", { name: "Dark mode" });
  const canvas = page.getByRole("tabpanel");

  await unrelatedControl.focus();
  await page.keyboard.press("p");
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(pen).toHaveAttribute("aria-pressed", "false");

  await canvas.focus();
  await page.keyboard.press("p");
  await expect(pen).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(select).toHaveAttribute("aria-pressed", "true");

  await pen.focus();
  await page.keyboard.press("h");
  await expect(highlighter).toHaveAttribute("aria-pressed", "true");
  await select.click();

  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  await page.mouse.click(bounds.x + 280, bounds.y + 230);
  await page.keyboard.press("p");
  await expect(page.locator(".text-block-editor-content").last()).toContainText("p");
  await expect(select).toHaveAttribute("aria-pressed", "true");
});
