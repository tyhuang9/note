import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1662, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("marquee cleanup leaves one composite frame whose whitespace moves and resizes the selection", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const blocks = await createTwoTextBlocks(page, bounds);

  await marqueeSelect(page, bounds, blocks);
  const frame = page.locator(".selection-frame");
  await expect(frame).toHaveCount(1);
  await expect(page.locator(".selection-rectangle")).toBeHidden();
  await expect(blocks.first).toHaveClass(/is-multi-selected/);
  await expect(blocks.second).toHaveClass(/is-multi-selected/);

  const firstBounds = await requiredBounds(blocks.first, "first text block");
  const secondBounds = await requiredBounds(blocks.second, "second text block");
  const whitespace = {
    x: (firstBounds.x + firstBounds.width + secondBounds.x) / 2,
    y: (Math.max(firstBounds.y, secondBounds.y) + Math.min(firstBounds.y + firstBounds.height, secondBounds.y + secondBounds.height)) / 2,
  };
  const before = await Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]);
  const frameBounds = await requiredBounds(frame, "selection frame");
  expect(whitespace.x).toBeGreaterThan(frameBounds.x);
  expect(whitespace.x).toBeLessThan(frameBounds.x + frameBounds.width);
  expect(whitespace.y).toBeGreaterThan(frameBounds.y);
  expect(whitespace.y).toBeLessThan(frameBounds.y + frameBounds.height);
  const hitInfo = await page.evaluate(({ x, y }) => {
    const moveSurface = document.querySelector<HTMLElement>(".selection-frame-move-surface");
    const frameElement = document.querySelector<HTMLElement>(".selection-frame");
    const overlay = document.querySelector<HTMLElement>(".canvas-interaction-overlay");
    return {
      framePointerEvents: frameElement ? getComputedStyle(frameElement).pointerEvents : null,
      frameRect: frameElement?.getBoundingClientRect().toJSON(),
      hitClass: (document.elementFromPoint(x, y) as HTMLElement | null)?.className ?? "",
      moveClass: moveSurface?.className,
      movePointerEvents: moveSurface ? getComputedStyle(moveSurface).pointerEvents : null,
      moveRect: moveSurface?.getBoundingClientRect().toJSON(),
      overlayPointerEvents: overlay ? getComputedStyle(overlay).pointerEvents : null,
    };
  }, whitespace);
  expect(hitInfo.hitClass, JSON.stringify(hitInfo)).toContain("selection-frame-move-surface");

  await page.mouse.click(whitespace.x, whitespace.y);
  await expect(frame).toHaveCount(1);
  await page.mouse.move(whitespace.x, whitespace.y);
  await page.mouse.down();
  await page.mouse.move(whitespace.x + 84, whitespace.y + 56, { steps: 7 });
  await page.mouse.up();
  await expect.poll(() => Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)])).toEqual([
    { x: before[0].x + 84, y: before[0].y + 56 },
    { x: before[1].x + 84, y: before[1].y + 56 },
  ]);

  const moveSurface = page.getByRole("button", { name: "Move selected elements" });
  await moveSurface.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => readWorldPosition(blocks.first)).toEqual({ x: before[0].x + 94, y: before[0].y + 56 });

  const southeast = page.getByRole("button", { name: "Resize selected elements from se" });
  await expect(southeast).toHaveCSS("width", "24px");
  const beforeWidth = await readWorldWidth(blocks.first);
  await southeast.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => readWorldWidth(blocks.first)).toBeGreaterThan(beforeWidth);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => readWorldWidth(blocks.first)).toBeCloseTo(beforeWidth, 2);
  await page.keyboard.press("Control+y");
  await expect.poll(() => readWorldWidth(blocks.first)).toBeGreaterThan(beforeWidth);
});

test("selection marquee is permanently hidden after Escape, blur, pointer cancel, and a successful selection", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  await createTextBlock(page, bounds.x + 360, bounds.y + 300, "Cleanup target");
  await page.getByRole("button", { name: /Select \(V/ }).click();
  const marquee = page.locator(".selection-rectangle");

  await beginMarquee(page, bounds);
  await expect(marquee).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(marquee).toBeHidden();
  await expect(page.locator(".selection-frame")).toHaveCount(0);

  await beginMarquee(page, bounds);
  await expect(marquee).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect(marquee).toBeHidden();
  await expect(page.locator(".selection-frame")).toHaveCount(0);

  await beginMarquee(page, bounds);
  await expect(marquee).toBeVisible();
  await canvas.dispatchEvent("pointercancel", { button: 0, clientX: bounds.x + 600, clientY: bounds.y + 500, pointerId: 1 });
  await page.mouse.up();
  await expect(marquee).toBeHidden();
  await expect(page.locator(".selection-frame")).toHaveCount(0);

  await beginMarquee(page, bounds);
  await expect(marquee).toBeVisible();
  await canvas.dispatchEvent("lostpointercapture", { pointerId: 1 });
  await page.mouse.up();
  await expect(marquee).toBeHidden();
  await expect(page.locator(".selection-frame")).toHaveCount(0);

  await beginMarquee(page, bounds);
  await expect(marquee).toBeVisible();
  await page.getByRole("button", { name: /Pen \(P/ }).dispatchEvent("click");
  await page.mouse.up();
  await expect(marquee).toBeHidden();
  await page.getByRole("button", { name: /Select \(V/ }).click();
  await expect(page.locator(".selection-frame")).toHaveCount(0);

  await beginMarquee(page, bounds);
  await expect(marquee).toBeVisible();
  await page.keyboard.press("Control+n");
  await page.mouse.up();
  await expect(marquee).toBeHidden();
  await expect(page.locator(".selection-frame")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab").first().click();

  await page.mouse.move(bounds.x + 240, bounds.y + 220);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 760, bounds.y + 520, { steps: 5 });
  await page.mouse.up();
  await expect(marquee).toBeHidden();
  await expect(page.locator(".selection-frame")).toHaveCount(1);

  await beginMarquee(page, bounds);
  await expect(marquee).toBeVisible();
  await page.reload();
  await page.mouse.up();
  await expect(page.locator(".selection-rectangle")).toBeHidden();
  await expect(page.locator(".selection-frame")).toHaveCount(0);
});

test("double-clicking a single selected text block enters editing", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const block = await createTextBlock(page, bounds.x + 360, bounds.y + 300, "Edit through bounds");
  await page.getByRole("button", { name: /Select \(V/ }).click();
  await block.locator(".text-block-header").click();
  await block.locator(".text-block-display").dblclick();
  await expect(block.locator(".text-block-editor-content")).toBeVisible();
});

test("a selected loop-shaped ink stroke moves from its empty bounded center only after painted-path selection", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const center = { x: bounds.x + 560, y: bounds.y + 390 };

  await page.getByRole("button", { name: /Pen \(P/ }).click();
  const points = Array.from({ length: 25 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * 92, y: center.y + Math.sin(angle) * 72 };
  });
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y);
  await page.mouse.up();

  const ink = page.locator('[data-canvas-element-type="ink"]');
  await expect(ink).toHaveCount(1);
  await page.getByRole("button", { name: /Select \(V/ }).click();
  await page.mouse.click(bounds.x + 860, bounds.y + 640);
  await expect(page.locator(".selection-frame")).toHaveCount(0);

  await page.mouse.click(center.x, center.y);
  await expect(page.locator(".selection-frame")).toHaveCount(0);
  await page.mouse.click(points[0].x, points[0].y);
  await expect(page.locator(".selection-frame")).toHaveCount(1);

  const frameBounds = await requiredBounds(page.locator(".selection-frame"), "ink selection frame");
  const nativeHandleBounds = await requiredBounds(page.getByRole("slider", { name: "Resize ink stroke" }), "ink resize handle");
  const moveSurfacePoint = { x: frameBounds.x + frameBounds.width - 18, y: frameBounds.y + frameBounds.height - 18 };
  const nativeHandlePoint = { x: nativeHandleBounds.x + nativeHandleBounds.width / 2, y: nativeHandleBounds.y + nativeHandleBounds.height / 2 };
  await expect.poll(() => page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.className ?? "", moveSurfacePoint)).toContain("selection-frame-move-surface");
  const nativeHandleHit = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.className ?? "", nativeHandlePoint);
  expect(nativeHandleHit, JSON.stringify({ frameBounds, nativeHandleBounds, nativeHandlePoint })).toContain("ink-resize-handle");

  const before = await readWorldPosition(ink);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 70, center.y + 45, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => readWorldPosition(ink)).toEqual({ x: before.x + 70, y: before.y + 45 });
});

for (const zoom of [50, 100, 200]) {
  test(`group resize is zoom-correct and undoable at ${zoom}%`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    const bounds = await requiredBounds(canvas, "canvas");
    const blocks = await createTwoTextBlocks(page, bounds);
    await marqueeSelect(page, bounds, blocks);
    await setZoom(page, canvas, zoom);

    const handle = page.getByRole("button", { name: "Resize selected elements from se" });
    const handleBounds = await requiredBounds(handle, "selection resize handle");
    const beforeWidth = await readWorldWidth(blocks.first);
    await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBounds.x + handleBounds.width / 2 + 60, handleBounds.y + handleBounds.height / 2 + 48, { steps: 6 });
    await page.mouse.up();
    const resizedWidth = await readWorldWidth(blocks.first);
    expect(resizedWidth).toBeGreaterThan(beforeWidth);

    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => readWorldWidth(blocks.first)).toBeCloseTo(beforeWidth, 1);
    await page.keyboard.press("Control+y");
    await expect.poll(() => readWorldWidth(blocks.first)).toBeCloseTo(resizedWidth, 1);
  });
}

test("group resize previews cloned elements without mutating scene state and discards cancellation", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const blocks = await createTwoTextBlocks(page, bounds);
  await marqueeSelect(page, bounds, blocks);

  const handle = page.getByRole("button", { name: "Resize selected elements from se" });
  const handleBounds = await requiredBounds(handle, "selection resize handle");
  const start = {
    x: handleBounds.x + handleBounds.width / 2,
    y: handleBounds.y + handleBounds.height / 2,
  };
  const beforeWidths = await Promise.all([readWorldWidth(blocks.first), readWorldWidth(blocks.second)]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 72, start.y + 48, { steps: 5 });

  await expect(page.locator(".resize-layer-clone")).toHaveCount(2);
  await expect(blocks.first).toHaveClass(/is-drag-source-hidden/);
  expect(await Promise.all([readWorldWidth(blocks.first), readWorldWidth(blocks.second)])).toEqual(beforeWidths);

  await handle.dispatchEvent("pointercancel", { button: 0, clientX: start.x + 72, clientY: start.y + 48, pointerId: 1 });
  await page.mouse.up();
  await expect(page.locator(".resize-layer-clone")).toHaveCount(0);
  await expect(blocks.first).not.toHaveClass(/is-drag-source-hidden/);
  await expect.poll(() => Promise.all([readWorldWidth(blocks.first), readWorldWidth(blocks.second)])).toEqual(beforeWidths);
});

async function createTwoTextBlocks(page: Page, bounds: { x: number; y: number }) {
  const first = await createTextBlock(page, bounds.x + 100, bounds.y + 220, "First selection");
  const second = await createTextBlock(page, bounds.x + 420, bounds.y + 280, "Second selection");
  return { first, second };
}

async function createTextBlock(page: Page, x: number, y: number, text: string) {
  await page.mouse.click(x, y);
  await page.keyboard.press(text[0]);
  const editor = page.locator(".text-block-editor-content").last();
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.mouse.click(x + 380, y + 180);
  const allBlocks = page.locator(".text-block");
  const block = allBlocks.nth((await allBlocks.count()) - 1);
  await expect(block.locator(".text-block-display")).toContainText(text);
  return block;
}

async function marqueeSelect(page: Page, canvasBounds: { x: number; y: number }, blocks: { first: Locator; second: Locator }) {
  await page.getByRole("button", { name: /Select \(V/ }).click();
  const first = await requiredBounds(blocks.first, "first text block");
  const second = await requiredBounds(blocks.second, "second text block");
  await page.mouse.move(Math.min(first.x, second.x) - 24, Math.min(first.y, second.y) - 24);
  await page.mouse.down();
  await page.mouse.move(
    Math.max(first.x + first.width, second.x + second.width) + 24,
    Math.max(first.y + first.height, second.y + second.height) + 24,
    { steps: 7 },
  );
  await page.mouse.up();
  await expect(page.locator(".selection-frame")).toHaveCount(1);
  await expect(page.locator(".selection-rectangle")).toBeHidden();
  expect(canvasBounds.x).toBeGreaterThanOrEqual(0);
}

async function beginMarquee(page: Page, bounds: { x: number; y: number }) {
  await page.mouse.move(bounds.x + 220, bounds.y + 200);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 640, bounds.y + 500, { steps: 4 });
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  const steps = Math.abs(percent - 100) / 10;
  for (let index = 0; index < steps; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function readWorldPosition(locator: Locator) {
  return locator.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
}

async function readWorldWidth(locator: Locator) {
  return locator.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width));
}
