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

test("desktop dark endpoint chooser traps focus, stays below the toolbar, and binds with Space", async ({ page }) => {
  await page.setViewportSize({ width: 1069, height: 598 });
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await createRectangleWithTool(page, canvasBounds.x + 340, canvasBounds.y + 180);
  await createRectangleWithTool(page, canvasBounds.x + 500, canvasBounds.y + 300);

  await selectTool(page, "arrow");
  await draw(
    page,
    canvasBounds.x + 300,
    canvasBounds.y + 100,
    canvasBounds.x + 630,
    canvasBounds.y + 140,
  );
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await selectTool(page, "select");
  await arrow.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  const description = page.locator("#connector-start-endpoint-description");
  const status = page.locator(".canvas-accessibility-status[role='status']");
  await expect(startHandle).toHaveAttribute("aria-describedby", "connector-start-endpoint-description");
  await expect(description).toContainText("Currently free");

  await startHandle.focus();
  await page.keyboard.press("Space");
  const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(page.locator(".connector-endpoint-chooser-layer")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("r");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Select (V / 1)" })).toHaveAttribute("aria-pressed", "true");
  const toolbarBounds = await requiredBounds(page.locator(".canvas-tool-palette"), "drawing toolbar");
  const dialogBounds = await requiredBounds(dialog, "endpoint chooser");
  expect(dialogBounds.y).toBeGreaterThanOrEqual(toolbarBounds.y + toolbarBounds.height);
  expect(dialogBounds.x + dialogBounds.width / 2).toBeCloseTo(toolbarBounds.x + toolbarBounds.width / 2, 0);
  const firstTarget = dialog.getByRole("button", { name: /Rectangle 1 \(center \d+, \d+\)/ });
  await expect(firstTarget).toHaveAttribute("aria-pressed", "true");
  await expect(firstTarget).toBeFocused();

  const close = dialog.getByRole("button", { name: "Close endpoint chooser" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Left anchor" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  expect(await close.evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(221, 214, 254)");
  await page.keyboard.press("Tab");
  await expect(firstTarget).toBeFocused();

  await firstTarget.focus();
  await page.keyboard.press("Space");
  const rightAnchor = page.getByRole("button", { name: "Right anchor" });
  await rightAnchor.focus();
  await page.keyboard.press("Space");
  await expect(status).toHaveText(/Bound start endpoint to Rectangle 1 \(center \d+, \d+\) at the right anchor\./);
  await expect(startHandle).toBeFocused();
  await expect(description).toContainText("Currently bound to Rectangle 1 (center");

  await startHandle.focus();
  await page.keyboard.press("Enter");
  const secondTarget = page.getByRole("button", { name: /Rectangle 2 \(center \d+, \d+\)/ });
  await secondTarget.focus();
  await page.keyboard.press("Space");
  const topAnchor = page.getByRole("button", { name: "Top anchor" });
  await topAnchor.focus();
  await page.keyboard.press("Space");
  await expect(status).toHaveText(/Rebound start endpoint to Rectangle 2 \(center \d+, \d+\) at the top anchor\./);
  await expect(startHandle).toBeFocused();
  await expect(description).toContainText("Currently bound to Rectangle 2 (center");

  await startHandle.focus();
  await page.keyboard.press("Enter");
  const detach = page.getByRole("button", { name: "Detach start endpoint" });
  await detach.focus();
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Detached start endpoint. It is now free.");
  await expect(startHandle).toBeFocused();
  await expect(description).toContainText("Currently free");
});

test("compact light endpoint chooser is an in-viewport sheet and Escape restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 598 });
  await page.getByRole("button", { name: "Dark mode" }).click();
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await createRectangleWithTool(page, canvasBounds.x + 36, canvasBounds.y + 150);
  await selectTool(page, "arrow");
  await draw(page, canvasBounds.x + 32, canvasBounds.y + 280, canvasBounds.x + 220, canvasBounds.y + 280);
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await arrow.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await startHandle.focus();
  await page.keyboard.press("Space");
  const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".connector-endpoint-chooser-layer")).toHaveAttribute("data-theme", "light");
  const dialogBounds = await requiredBounds(dialog, "compact endpoint chooser");
  expect(dialogBounds.x).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.y).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(320);
  expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(598);
  expect(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(startHandle).toBeFocused();
});

test("free arrow with no shapes announces that binding targets are unavailable", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await selectTool(page, "arrow");
  await draw(page, canvasBounds.x + 280, canvasBounds.y + 260, canvasBounds.x + 720, canvasBounds.y + 260);
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await arrow.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await startHandle.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".canvas-accessibility-status[role='status']")).toHaveText(
    "No compatible shapes are available to bind the start endpoint.",
  );
  await expect(startHandle).toBeFocused();
});

async function createRectangle(page: Page, x: number, y: number): Promise<Locator> {
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.mouse.click(x, y);
  const rectangle = page.getByLabel("rectangle shape").last();
  await expect(rectangle).toBeVisible();
  return rectangle;
}

async function createRectangleWithTool(page: Page, x: number, y: number): Promise<Locator> {
  await selectTool(page, "rectangle");
  await page.mouse.click(x, y);
  const rectangle = page.getByLabel("rectangle shape").last();
  await expect(rectangle).toBeVisible();
  return rectangle;
}

async function selectTool(page: Page, tool: string) {
  const button = page.locator(`.canvas-tool-palette [data-tool="${tool}"]`);
  await button.scrollIntoViewIfNeeded();
  await button.click();
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
