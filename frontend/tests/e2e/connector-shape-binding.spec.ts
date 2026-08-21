import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("arrow binding exposes a whole-object highlight, follows target transforms, and detaches before target deletion", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  const rectangle = await createRectangle(page, canvasBounds.x + 360, canvasBounds.y + 300);
  const rectangleControl = page.getByRole("button", { name: "Select and move rectangle shape. Press F2 to edit contained text." });
  const targetId = await rectangleControl.getAttribute("data-canvas-element-id");
  if (!targetId) throw new Error("Rectangle target id was unavailable.");

  await page.getByRole("button", { name: "Arrow (A / 5)" }).click();
  const rectangleBounds = await requiredBounds(rectangleControl, "rectangle target");
  await page.mouse.click(rectangleBounds.x + rectangleBounds.width - 1, rectangleBounds.y + rectangleBounds.height / 2);
  const highlight = page.locator(`[data-connector-target-id="${targetId}"]`);
  await expect(highlight).toHaveCount(1);
  await expect(highlight).not.toHaveAttribute("tabindex");
  await expect(highlight).toHaveAttribute("aria-hidden", "true");
  await expect(highlight).toHaveAttribute("data-connector-binding-state", "snapped");
  const targetHighlight = await requiredBounds(highlight, "whole-object target highlight");

  await page.mouse.move(canvasBounds.x + 800, targetHighlight.y + targetHighlight.height / 2, { steps: 5 });
  await page.mouse.click(canvasBounds.x + 800, targetHighlight.y + targetHighlight.height / 2);
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await expect(arrow).toBeVisible();
  await selectTool(page, "select");
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

test("lines stay free while arrows remain bound through keyboard movement and rebind through endpoint controls at every supported zoom", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");

  for (const zoom of [50, 100, 200]) {
    await setZoom(page, canvas, zoom);
    const rectangle = await createRectangle(page, canvasBounds.x + 300, canvasBounds.y + 240);
    const rectangleControl = page.getByRole("button", { name: "Select and move rectangle shape. Press F2 to edit contained text." }).last();
    const targetId = await rectangleControl.getAttribute("data-canvas-element-id");
    if (!targetId) throw new Error("Rectangle target id was unavailable.");

    await page.getByRole("button", { name: "Arrow (A / 5)" }).click();
    const rectangleBounds = await requiredBounds(rectangleControl, "rectangle target");
    await page.mouse.click(rectangleBounds.x + rectangleBounds.width - 1, rectangleBounds.y + rectangleBounds.height / 2);
    const targetHighlight = await requiredBounds(page.locator(`[data-connector-target-id="${targetId}"]`), "whole-object target highlight");
    await page.mouse.move(canvasBounds.x + 900, targetHighlight.y + targetHighlight.height / 2, { steps: 5 });
    await page.mouse.click(canvasBounds.x + 900, targetHighlight.y + targetHighlight.height / 2);
    const arrow = page.getByRole("button", { name: "Select and move arrow connector" }).last();
    await selectTool(page, "select");
    const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
    await expect(startHandle).toBeVisible();

    await startHandle.focus();
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".canvas-accessibility-status[role='status']")).toHaveText(
      "Detached and moved start endpoint. It is now free.",
    );

    const boundHandle = await requiredBounds(startHandle, "bound start endpoint after keyboard movement");
    await page.mouse.move(boundHandle.x + boundHandle.width / 2, boundHandle.y + boundHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(boundHandle.x + boundHandle.width / 2, boundHandle.y + boundHandle.height / 2 + 36, { steps: 3 });
    await page.mouse.move(rectangleBounds.x + rectangleBounds.width / 2, rectangleBounds.y + rectangleBounds.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator("#connector-start-endpoint-description")).toContainText(`Currently bound to Rectangle`);

    await page.getByRole("button", { name: "Line (L / 6)" }).click();
    await draw(page, rectangleBounds.x + rectangleBounds.width / 2, rectangleBounds.y + rectangleBounds.height + 45, canvasBounds.x + 900, rectangleBounds.y + rectangleBounds.height + 45);
    const line = page.getByRole("button", { name: "Select and move line connector" }).last();
    const lineBeforeTargetMove = await requiredBounds(line, "line");
    await rectangleControl.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(async () => roundedBounds(line)).toEqual(round(lineBeforeTargetMove));
    await expect(arrow).toBeVisible();
    await expect(rectangle).toBeVisible();
  }
});

for (const zoom of [50, 100, 200]) {
  test(`a free-bound arrow follows the transient target drag and restores on cancellation at ${zoom}%`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    const canvasBounds = await requiredBounds(canvas, "canvas");
    await setZoom(page, canvas, zoom);
    const rectangle = await createRectangle(page, canvasBounds.x + 360, canvasBounds.y + 300);
    const rectangleControl = page.getByRole("button", { name: "Select and move rectangle shape. Press F2 to edit contained text." }).last();
    const targetId = await rectangleControl.getAttribute("data-canvas-element-id");
    if (!targetId) throw new Error("Rectangle target id was unavailable.");
    await selectTool(page, "arrow");
    const rectangleBounds = await requiredBounds(rectangleControl, "rectangle target");
    await page.mouse.click(rectangleBounds.x + rectangleBounds.width - 1, rectangleBounds.y + rectangleBounds.height / 2);
    const targetHighlight = await requiredBounds(page.locator(`[data-connector-target-id="${targetId}"]`), "whole-object target highlight");
    await page.mouse.move(canvasBounds.x + 820, targetHighlight.y + targetHighlight.height / 2, { steps: 5 });
    await page.mouse.click(canvasBounds.x + 820, targetHighlight.y + targetHighlight.height / 2);
    const arrow = page.getByRole("button", { name: "Select and move arrow connector" }).last();
    const originalArrow = await roundedBounds(arrow);

    await selectTool(page, "select");
    await rectangleControl.focus();
    await page.keyboard.press("Enter");
    const moveSurface = page.getByRole("button", { name: "Move selected elements" });
    const moveBounds = await requiredBounds(moveSurface, "selection move surface");
    await page.mouse.move(moveBounds.x + moveBounds.width / 2, moveBounds.y + moveBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(moveBounds.x + moveBounds.width / 2 + 48, moveBounds.y + moveBounds.height / 2 + 24, { steps: 4 });

    const preview = page.locator(".connector-transform-preview");
    await expect(preview).toHaveCount(1);
    await expect.poll(() => roundedBounds(preview)).not.toEqual(originalArrow);
    await expect(arrow).not.toBeVisible();
    await moveSurface.dispatchEvent("pointercancel", { button: 0, pointerId: 1 });
    await page.mouse.up();
    await expect(preview).toHaveCount(0);
    await expect(arrow).toBeVisible();
    await expect.poll(() => roundedBounds(arrow)).toEqual(originalArrow);
    await expect.poll(() => canvasContentScale(canvas)).toBeCloseTo(zoom / 100, 4);

    if (zoom === 100) {
      await page.mouse.move(moveBounds.x + moveBounds.width / 2, moveBounds.y + moveBounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(moveBounds.x + moveBounds.width / 2 + 36, moveBounds.y + moveBounds.height / 2 + 18, { steps: 4 });
      await expect(preview).toHaveCount(1);
      const committedPreviewBounds = await roundedBounds(preview);
      await page.mouse.up();
      await expect(preview).toHaveCount(0);
      await expect.poll(() => roundedBounds(arrow)).toEqual(committedPreviewBounds);
    }
  });
}

test("desktop dark endpoint chooser traps focus, stays below the toolbar, and binds with Space", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await createRectangleWithTool(page, canvasBounds.x + 340, canvasBounds.y + 180);
  await createRectangleWithTool(page, canvasBounds.x + 500, canvasBounds.y + 300);
  await selectTool(page, "text");
  await page.mouse.click(canvasBounds.x + 720, canvasBounds.y + 220);
  await expect(page.locator(".text-block-editor-content")).toBeFocused();
  await page.keyboard.type("Text binding target");
  await page.keyboard.press("Escape");

  await selectTool(page, "arrow");
  await authorArrow(
    page,
    canvasBounds.x + canvasBounds.width * 0.62,
    canvasBounds.y + canvasBounds.height * 0.72,
    canvasBounds.x + canvasBounds.width * 0.84,
    canvasBounds.y + canvasBounds.height * 0.82,
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
  expect(dialogBounds.x).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.y).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(1500);
  expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(900);
  const firstTarget = dialog.locator('[data-connector-target="true"]').filter({
    hasText: /^Rectangle 1 \(center \d+, \d+\)$/,
  });
  await expect(dialog.getByRole("button", { name: /Text 1 \(Text binding target\)/ })).toBeVisible();
  await expect(firstTarget).toHaveAttribute("aria-pressed", "true");
  await expect(firstTarget).toBeFocused();
  await expect(dialog.getByRole("slider")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /anchor/i })).toHaveCount(0);
  const desktopTargetMetrics = await firstTarget.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      height: bounds.height,
      lineHeightRatio: Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize),
      minHeight: style.minHeight,
      minWidth: style.minWidth,
      whiteSpace: style.whiteSpace,
      width: bounds.width,
    };
  });
  expect(desktopTargetMetrics.width).toBeGreaterThan(44);
  expect(desktopTargetMetrics.height).toBeGreaterThanOrEqual(44);
  expect(desktopTargetMetrics.minWidth).toBe("44px");
  expect(desktopTargetMetrics.minHeight).toBe("44px");
  expect(desktopTargetMetrics.lineHeightRatio).toBeCloseTo(1.25, 2);
  expect(desktopTargetMetrics.whiteSpace).toBe("normal");

  const close = dialog.getByRole("button", { name: "Close endpoint chooser" });
  const closeBounds = await requiredBounds(close, "close endpoint chooser");
  expect(closeBounds.width).toBeGreaterThanOrEqual(44);
  expect(closeBounds.height).toBeGreaterThanOrEqual(44);
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Bind start endpoint" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  expect(await close.evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(221, 214, 254)");
  await page.keyboard.press("Tab");
  await expect(firstTarget).toBeFocused();

  await firstTarget.focus();
  await page.keyboard.press("Space");
  await dialog.getByRole("button", { name: "Bind start endpoint" }).focus();
  await page.keyboard.press("Space");
  await expect(status).toHaveText(/Bound start endpoint to Rectangle 1 \(center \d+, \d+\)\. The connector will follow the nearest facing visible boundaries automatically\./);
  await expect(startHandle).toBeFocused();
  await expect(description).toContainText("Currently bound to Rectangle 1 (center");

  await startHandle.focus();
  await page.keyboard.press("Enter");
  const secondTarget = page.getByRole("button", { name: /Rectangle 2 \(center \d+, \d+\)/ });
  await secondTarget.focus();
  await page.keyboard.press("Space");
  await page.getByRole("dialog", { name: "Choose start endpoint target" }).getByRole("button", { name: "Bind start endpoint" }).focus();
  await page.keyboard.press("Space");
  await expect(status).toHaveText(/Rebound start endpoint to Rectangle 2 \(center \d+, \d+\)\. The connector will follow the nearest facing visible boundaries automatically\./);
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

test("endpoint chooser blocks rapid canvas shortcuts and preserves an immediate target choice", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await createRectangleWithTool(page, canvasBounds.x + 340, canvasBounds.y + 180);
  await createRectangleWithTool(page, canvasBounds.x + 500, canvasBounds.y + 300);
  await selectTool(page, "arrow");
  await authorArrow(
    page,
    canvasBounds.x + canvasBounds.width * 0.62,
    canvasBounds.y + canvasBounds.height * 0.72,
    canvasBounds.x + canvasBounds.width * 0.84,
    canvasBounds.y + canvasBounds.height * 0.82,
  );
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await selectTool(page, "select");
  await arrow.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await expect(startHandle).toBeVisible();

  for (let iteration = 0; iteration < 6; iteration += 1) {
    await startHandle.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("r");
    const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Select (V / 1)" })).toHaveAttribute("aria-pressed", "true");
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(startHandle).toBeFocused();
  }

  await startHandle.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  const firstTarget = dialog.locator('[data-connector-target="true"]').filter({
    hasText: /^Rectangle 1 \(center \d+, \d+\)$/,
  });
  const secondTarget = dialog.locator('[data-connector-target="true"]').filter({
    hasText: /^Rectangle 2 \(center \d+, \d+\)$/,
  });
  await secondTarget.focus();
  await page.keyboard.press("Space");
  await expect(secondTarget).toHaveAttribute("aria-pressed", "true");
  await expect(secondTarget).toBeFocused();
  await expect(firstTarget).toHaveAttribute("aria-pressed", "false");
});

test("endpoint chooser ignores an immediate endpoint Arrow without a history or persistence write", async ({ page }) => {
  await installEndpointChooserWorkspace(page);
  await page.goto("/");
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await arrow.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await expect(startHandle).toBeVisible();
  const beforeArrow = await roundedBounds(arrow);
  await resetEndpointCounts(page);

  await startHandle.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => roundedBounds(arrow)).toEqual(beforeArrow);
  await expect.poll(() => endpointCounts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect.poll(() => roundedBounds(arrow)).toEqual(beforeArrow);
  await expect.poll(() => endpointCounts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
});

test("target-only chooser bind, rebind, and detach each persist exactly one scene change", async ({ page }) => {
  await installEndpointChooserWorkspace(page);
  await page.goto("/");
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await arrow.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });

  for (const action of ["bind", "rebind", "detach"] as const) {
    await page.waitForTimeout(650);
    await resetEndpointCounts(page);
    await startHandle.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
    if (action === "detach") {
      await dialog.getByRole("button", { name: "Detach start endpoint" }).click();
    } else {
      await dialog.getByRole("button", { name: /^Rectangle 1 / }).click();
      await dialog.getByRole("button", { name: "Bind start endpoint" }).click();
    }
    await expect.poll(() => endpointCounts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  }
});

test("compact light endpoint chooser is an in-viewport sheet and Escape restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 598 });
  await page.getByRole("button", { name: "Dark mode" }).click();
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await createRectangleWithTool(page, canvasBounds.x + 36, canvasBounds.y + 150);
  await selectTool(page, "text");
  await page.mouse.click(canvasBounds.x + 48, canvasBounds.y + 210);
  await expect(page.locator(".text-block-editor-content")).toBeFocused();
  await page.keyboard.type("Long compact binding target label that needs to wrap");
  await page.keyboard.press("Escape");
  await selectTool(page, "arrow");
  await authorArrow(page, canvasBounds.x + 32, canvasBounds.y + 280, canvasBounds.x + 220, canvasBounds.y + 280);
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await selectTool(page, "select");
  await arrow.focus();
  await page.keyboard.press("Enter");
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  await endHandle.focus();
  await page.keyboard.press("Space");
  const dialog = page.getByRole("dialog", { name: "Choose end endpoint target" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".connector-endpoint-chooser-layer")).toHaveAttribute("data-theme", "light");
  const dialogBounds = await requiredBounds(dialog, "compact endpoint chooser");
  expect(dialogBounds.x).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.y).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(320);
  expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(598);
  expect(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
  const longTarget = dialog.getByRole("button", { name: /Text 1 \(Long compact binding target lab/ });
  await expect(longTarget).toBeVisible();
  const compactTargetMetrics = await longTarget.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      height: bounds.height,
      left: bounds.left,
      lineHeightRatio: Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize),
      minHeight: style.minHeight,
      minWidth: style.minWidth,
      right: bounds.right,
      scrollWidth: element.scrollWidth,
      whiteSpace: style.whiteSpace,
      width: bounds.width,
    };
  });
  expect(compactTargetMetrics.width).toBeGreaterThanOrEqual(44);
  expect(compactTargetMetrics.height).toBeGreaterThan(44);
  expect(compactTargetMetrics.minWidth).toBe("44px");
  expect(compactTargetMetrics.minHeight).toBe("44px");
  expect(compactTargetMetrics.lineHeightRatio).toBeCloseTo(1.25, 2);
  expect(compactTargetMetrics.whiteSpace).toBe("normal");
  expect(compactTargetMetrics.left).toBeGreaterThanOrEqual(dialogBounds.x);
  expect(compactTargetMetrics.right).toBeLessThanOrEqual(dialogBounds.x + dialogBounds.width);
  expect(compactTargetMetrics.scrollWidth).toBeLessThanOrEqual(Math.ceil(compactTargetMetrics.width));

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(endHandle).toBeFocused();
});

test("free arrow with no shapes announces that binding targets are unavailable", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await selectTool(page, "arrow");
  await authorArrow(page, canvasBounds.x + 280, canvasBounds.y + 260, canvasBounds.x + 720, canvasBounds.y + 260);
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await selectTool(page, "select");
  await arrow.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await startHandle.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".canvas-accessibility-status[role='status']")).toHaveText(
    "No compatible shapes or text blocks are available to bind the start endpoint.",
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

async function authorArrow(page: Page, startX: number, startY: number, endX: number, endY: number) {
  await page.mouse.click(startX, startY);
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.click(endX, endY);
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

async function canvasContentScale(canvas: Locator) {
  return canvas.locator(".canvas-content").evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    if (transform === "none") return 1;
    const values = transform.match(/^matrix\(([^)]+)\)$/)?.[1]
      .split(",")
      .map(Number);
    if (!values || values.length !== 6 || !Number.isFinite(values[0])) {
      throw new Error(`Canvas transform was not a 2D matrix: ${transform}`);
    }
    return values[0];
  });
}

function round(bounds: { x: number; y: number; width: number; height: number }) {
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value)]));
}

async function roundedBounds(locator: Locator) {
  return round(await requiredBounds(locator, "element"));
}

async function endpointCounts(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __endpointCounts: { apply: number; persistence: number; session: number };
  }).__endpointCounts);
}

async function resetEndpointCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as {
      __endpointCounts: { apply: number; persistence: number; session: number };
    }).__endpointCounts = { apply: 0, persistence: 0, session: 0 };
  });
}

async function installEndpointChooserWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string; type: string };
    const storageKey = "note-endpoint-chooser-modal-invariant";
    if (!sessionStorage.getItem(`${storageKey}:initialized`)) {
      localStorage.removeItem(storageKey);
      sessionStorage.setItem(`${storageKey}:initialized`, "true");
    }
    const style = { fillColor: null, roughness: 1, roundness: 0.18, seed: 17, strokeColor: { kind: "fixed", value: "#4c6ef5" }, strokeStyle: "solid", strokeWidth: 2 };
    const initial = {
      elements: [
        { createdAt: 1, height: 140, id: "target-shape", locked: false, opacity: 1, pageId: "page", rotation: 0, shape: "rectangle", style, type: "shape", updatedAt: 1, width: 240, x: 420, y: 240, zIndex: 1 },
        { createdAt: 1, end: { kind: "free", x: 980, y: 420 }, id: "endpoint-connector", locked: false, opacity: 1, pageId: "page", routing: "straight", start: { kind: "free", x: 300, y: 420 }, style: { ...style, endArrowhead: "arrow", startArrowhead: "none" }, type: "connector", updatedAt: 1, zIndex: 2 },
      ] as ElementRecord[],
      folders: [], isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Endpoint chooser modal invariant" }],
      sessionState: { openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" }, warnings: [],
    };
    const workspace = (localStorage.getItem(storageKey) ? JSON.parse(localStorage.getItem(storageKey)!) : initial) as typeof initial;
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __endpointCounts: { apply: number; persistence: number; session: number };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__endpointCounts = { apply: 0, persistence: 0, session: 0 };
    const persist = () => {
      runtime.__endpointCounts.persistence += 1;
      localStorage.setItem(storageKey, JSON.stringify(workspace));
    };
    if (!localStorage.getItem(storageKey)) persist();
    runtime.__endpointCounts.persistence = 0;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "endpoint-chooser.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__endpointCounts.apply += 1;
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const deleted = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements.filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id)).map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        workspace.pages[0].revision += 1;
        persist();
        return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") {
        runtime.__endpointCounts.session += 1;
        workspace.sessionState = args.state as typeof workspace.sessionState;
        persist();
        return;
      }
      throw new Error(`Unexpected ${command}`);
    }};
  });
}
