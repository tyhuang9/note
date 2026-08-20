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

  const blocks = page.locator(".text-block");
  const block = blocks.nth((await blocks.count()) - 1);
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

  await firstDisplay.dispatchEvent("pointerdown", {
    button: 0,
    clientX: bounds.x + 280,
    clientY: bounds.y + 260,
    ctrlKey: true,
    pointerId: 92,
  });
  await firstDisplay.dispatchEvent("click", { bubbles: true, ctrlKey: true });
  await expect(first).not.toHaveClass(/is-selected/);
  await expect(second).toHaveClass(/is-selected/);
});

test("F2 edits an existing unlocked text selection", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  const block = await createTextBlock(page, bounds.x + 300, bounds.y + 240, "Keyboard edit target");
  await block.locator(".text-block-display").click();
  const header = block.locator(".text-block-header");
  await header.focus();
  await expect(header).toHaveAttribute("aria-keyshortcuts", "F2 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight");
  await header.press("F2");
  await expect(block.locator(".text-block-editor-content")).toBeVisible();
  await expect(block.locator(".ProseMirror")).toBeFocused();
});

test("single selected text narrows with reflow and commits its last preview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  const block = await createTextBlock(
    page,
    bounds.x + 320,
    bounds.y + 260,
    "One two three four five six seven eight nine ten\nOne two three four five six seven eight nine ten\nOne two three four five six seven eight nine ten",
  );
  const display = block.locator(".text-block-display");
  await display.click();
  const handle = page.getByRole("button", { name: "Resize text width" });
  await expect(handle).toBeVisible();
  const handleBounds = await handle.boundingBox();
  if (!handleBounds) throw new Error("Text resize handle was not available.");
  expect(handleBounds.width).toBeGreaterThanOrEqual(44);
  expect(handleBounds.height).toBeGreaterThanOrEqual(44);

  const before = await readBlockSize(block);
  const start = {
    x: handleBounds.x + handleBounds.width / 2,
    y: handleBounds.y + handleBounds.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 100, start.y, { steps: 5 });
  const preview = await readBlockSize(block);
  expect(preview.width).toBeCloseTo(before.width - 100, 1);
  expect(preview.height).toBeGreaterThan(before.height);
  await page.mouse.up();
  await expect.poll(() => readBlockSize(block)).toEqual(preview);

  const afterPointer = await readBlockSize(block);
  await handle.focus();
  await handle.press("ArrowRight");
  await expect.poll(() => readBlockSize(block)).toMatchObject({ width: afterPointer.width + 10 });
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => readBlockSize(block)).toMatchObject(afterPointer);
});

for (const cancelPath of ["Escape", "tool change", "page change", "window blur", "pointer cancel", "lost pointer capture"] as const) {
  test(`east text resize restores DOM and capture on ${cancelPath}`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create new note/i }).click();
    const canvas = page.getByRole("tabpanel");
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error("Canvas bounds were not available.");

    let originalTab: Locator | null = null;
    let alternateTab: Locator | null = null;
    if (cancelPath === "page change") {
      await page.getByRole("button", { name: "Create root page" }).click();
      const tabs = page.getByRole("tablist", { name: "Open pages" }).getByRole("tab");
      await expect(tabs).toHaveCount(2);
      originalTab = tabs.first();
      alternateTab = tabs.nth(1);
      await originalTab.click();
    }

    const block = await createTextBlock(
      page,
      canvasBounds.x + 300,
      canvasBounds.y + 240,
      "One two three four five six\nOne two three four five six\nOne two three four five six",
    );
    await block.locator(".text-block-display").click();
    const handle = page.getByRole("button", { name: "Resize text width" });
    const handleBounds = await handle.boundingBox();
    if (!handleBounds) throw new Error("Text resize handle was not available.");
    const before = await readBlockGeometry(block);
    const start = {
      x: handleBounds.x + handleBounds.width / 2,
      y: handleBounds.y + handleBounds.height / 2,
    };

    await page.evaluate(() => {
      document.addEventListener("pointerdown", (event) => {
        document.body.dataset.textResizePointerId = String(event.pointerId);
      }, { capture: true, once: true });
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 72, start.y, { steps: 5 });
    const pointerId = Number(await page.locator("body").getAttribute("data-text-resize-pointer-id"));
    await page.locator("body").evaluate((element) => delete (element as HTMLElement).dataset.textResizePointerId);
    expect(Number.isFinite(pointerId)).toBe(true);
    await expect(block).toHaveClass(/is-resizing/);
    await expect(page.locator("body")).toHaveClass(/is-interacting/);
    expect(await hasPointerCapture(page, pointerId)).toBe(true);

    if (cancelPath === "Escape") {
      await page.keyboard.press("Escape");
    } else if (cancelPath === "tool change") {
      await page.getByRole("button", { name: /Pen \(P/ }).dispatchEvent("click");
    } else if (cancelPath === "page change") {
      await alternateTab!.dispatchEvent("click");
      await originalTab!.dispatchEvent("click");
    } else if (cancelPath === "window blur") {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    } else if (cancelPath === "pointer cancel") {
      await dispatchCapturedPointerCancel(page, pointerId, start.x - 72, start.y);
    } else {
      await releaseCapturedPointer(page, pointerId);
    }

    await expect(block).not.toHaveClass(/is-resizing/);
    await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
    await expect.poll(() => readBlockGeometry(block)).toEqual(before);
    await expect.poll(() => hasPointerCapture(page, pointerId)).toBe(false);
    await page.mouse.up();
  });
}

async function createTextBlock(page: Page, x: number, y: number, text: string) {
  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(x, y);
  const editor = page.locator(".text-block-editor-content").last();
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.mouse.click(x + 220, y + 160);
  const blocks = page.locator(".text-block");
  const block = blocks.nth((await blocks.count()) - 1);
  await expect(block.locator(".text-block-display")).toContainText(text.replaceAll("\n", ""));
  return block;
}

async function readBlockPosition(block: Locator) {
  return block.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
}

async function readBlockSize(block: Locator) {
  return block.evaluate((element) => ({
    height: Number.parseFloat((element as HTMLElement).style.height),
    width: Number.parseFloat((element as HTMLElement).style.width),
  }));
}

async function readBlockGeometry(block: Locator) {
  return block.evaluate((element) => {
    const style = element as HTMLElement;
    return {
      height: Number.parseFloat(style.style.height),
      width: Number.parseFloat(style.style.width),
      x: Number.parseFloat(style.style.left),
      y: Number.parseFloat(style.style.top),
    };
  });
}

async function hasPointerCapture(page: Page, pointerId: number) {
  return page.evaluate((id) => Array.from(document.querySelectorAll<HTMLElement>("*"))
    .some((element) => element.hasPointerCapture(id)), pointerId);
}

async function dispatchCapturedPointerCancel(page: Page, pointerId: number, clientX: number, clientY: number) {
  await page.evaluate(({ id, x, y }) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .find((element) => element.hasPointerCapture(id));
    if (!target) throw new Error("Text resize capture target was unavailable.");
    target.dispatchEvent(new PointerEvent("pointercancel", {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
      pointerId: id,
    }));
  }, { id: pointerId, x: clientX, y: clientY });
}

async function releaseCapturedPointer(page: Page, pointerId: number) {
  await page.evaluate((id) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .find((element) => element.hasPointerCapture(id));
    if (!target) throw new Error("Text resize capture target was unavailable.");
    target.releasePointerCapture(id);
    target.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: id }));
  }, pointerId);
}
