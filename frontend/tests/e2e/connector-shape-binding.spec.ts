import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("arrow binding exposes visual-only anchors, follows target transforms, and detaches before target deletion", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  const rectangle = await createRectangle(page, canvasBounds.x + 360, canvasBounds.y + 300);
  const rectangleControl = page.getByRole("button", { name: "Select and move rectangle element" });
  const targetId = await rectangleControl.getAttribute("data-canvas-element-id");
  if (!targetId) throw new Error("Rectangle target id was unavailable.");

  await page.getByRole("button", { name: "Arrow (A / 5)" }).click();
  const anchors = page.locator(`[data-connector-target-id="${targetId}"]`);
  await expect(anchors).toHaveCount(4);
  await expect(anchors.first()).not.toHaveAttribute("tabindex");
  await expect(page.locator(".connector-binding-anchors")).toHaveAttribute("aria-hidden", "true");
  const rightAnchor = await requiredBounds(
    page.locator(`[data-connector-target-id="${targetId}"][data-connector-anchor="right"]`),
    "right anchor",
  );

  await draw(page, rightAnchor.x + rightAnchor.width / 2, rightAnchor.y + rightAnchor.height / 2, canvasBounds.x + 800, rightAnchor.y + rightAnchor.height / 2);
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await expect(arrow).toBeVisible();
  await expect(page.getByRole("button", { name: "Move connector start endpoint" })).toBeVisible();

  await rectangleControl.focus();
  await page.keyboard.press("Enter");
  const southeast = page.getByRole("button", { name: "Resize selected elements from se" });
  const southeastBounds = await requiredBounds(southeast, "rectangle resize handle");
  const arrowBeforeResize = await requiredBounds(arrow, "arrow");
  await page.mouse.move(southeastBounds.x + southeastBounds.width / 2, southeastBounds.y + southeastBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(southeastBounds.x + southeastBounds.width / 2 + 24, southeastBounds.y + southeastBounds.height / 2 + 16, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await requiredBounds(arrow, "arrow")).width).toBeLessThan(arrowBeforeResize.width - 16);

  const arrowBeforeTargetMove = await requiredBounds(arrow, "arrow");
  await rectangleControl.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await requiredBounds(arrow, "arrow")).width).toBeLessThan(arrowBeforeTargetMove.width - 8);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await requiredBounds(arrow, "arrow")).width).toBeCloseTo(arrowBeforeTargetMove.width, 0);
  await page.keyboard.press("Control+y");
  await expect.poll(async () => (await requiredBounds(arrow, "arrow")).width).toBeLessThan(arrowBeforeTargetMove.width - 8);

  await rectangleControl.focus();
  await page.keyboard.press("Delete");
  await expect(rectangle).toHaveCount(0);
  await expect(arrow).toBeVisible();
  await arrow.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Move connector start endpoint" })).toBeVisible();
});

test("lines stay free while arrows detach and rebind through real endpoint controls at every supported zoom", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");

  for (const zoom of [50, 100, 200]) {
    await setZoom(page, canvas, zoom);
    const rectangle = await createRectangle(page, canvasBounds.x + 300, canvasBounds.y + 240);
    const rectangleControl = page.getByRole("button", { name: "Select and move rectangle element" }).last();
    const targetId = await rectangleControl.getAttribute("data-canvas-element-id");
    if (!targetId) throw new Error("Rectangle target id was unavailable.");

    await page.getByRole("button", { name: "Arrow (A / 5)" }).click();
    const rightAnchor = await requiredBounds(page.locator(`[data-connector-target-id="${targetId}"][data-connector-anchor="right"]`), "right anchor");
    await draw(page, rightAnchor.x + 5, rightAnchor.y + 5, canvasBounds.x + 900, rightAnchor.y + 5);
    const arrow = page.getByRole("button", { name: "Select and move arrow connector" }).last();
    const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
    await expect(startHandle).toBeVisible();

    const startBeforeDetach = await requiredBounds(startHandle, "bound start endpoint");
    await startHandle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await requiredBounds(startHandle, "detached start endpoint")).x).toBeCloseTo(startBeforeDetach.x - 1, 0);

    const detachedHandle = await requiredBounds(startHandle, "detached start endpoint");
    await page.mouse.move(detachedHandle.x + detachedHandle.width / 2, detachedHandle.y + detachedHandle.height / 2);
    await page.mouse.down();
    await expect(page.locator(`[data-connector-target-id="${targetId}"]`)).toHaveCount(4);
    await page.mouse.move(detachedHandle.x + detachedHandle.width / 2, detachedHandle.y + detachedHandle.height / 2 + 36, { steps: 3 });
    await page.mouse.move(rightAnchor.x + rightAnchor.width / 2, rightAnchor.y + rightAnchor.height / 2, { steps: 4 });
    await page.mouse.up();
    const reboundHandle = await requiredBounds(startHandle, "rebound start endpoint");
    expect(Math.abs(
      reboundHandle.x + reboundHandle.width / 2 - (rightAnchor.x + rightAnchor.width / 2),
    )).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: "Line (L / 6)" }).click();
    await draw(page, rightAnchor.x + rightAnchor.width / 2, rightAnchor.y + rightAnchor.height / 2 + 45, canvasBounds.x + 900, rightAnchor.y + rightAnchor.height / 2 + 45);
    const line = page.getByRole("button", { name: "Select and move line connector" }).last();
    const lineBeforeTargetMove = await requiredBounds(line, "line");
    await rectangleControl.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(async () => roundedBounds(line)).toEqual(round(lineBeforeTargetMove));
    await expect(arrow).toBeVisible();
    await expect(rectangle).toBeVisible();
  }
});

async function createRectangle(page: Page, x: number, y: number): Promise<Locator> {
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.mouse.click(x, y);
  const rectangle = page.getByLabel("rectangle shape").last();
  await expect(rectangle).toBeVisible();
  return rectangle;
}

async function draw(page: Page, startX: number, startY: number, endX: number, endY: number) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  for (let index = 0; index < Math.abs(percent - 100) / 10; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

function round(bounds: { x: number; y: number; width: number; height: number }) {
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value)]));
}

async function roundedBounds(locator: Locator) {
  return round(await requiredBounds(locator, "element"));
}
