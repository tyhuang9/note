import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1662, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("all-text selections render a four-corner composite frame and move as one group", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const blocks = await createTwoTextBlocks(page, bounds);

  await marqueeSelect(page, bounds, [blocks.first, blocks.second]);
  await expect(page.locator(".selection-frame")).toHaveCount(1);
  await expect(page.locator(".selection-rectangle")).toBeHidden();
  await expect(blocks.first).toHaveClass(/is-selected/);
  await expect(blocks.first).toHaveClass(/is-multi-selected/);
  await expect(blocks.second).toHaveClass(/is-selected/);
  await expect(blocks.second).toHaveClass(/is-multi-selected/);
  await expect(blocks.first.locator(".text-block-header")).toHaveCSS("opacity", "1");
  await expect(blocks.second.locator(".text-block-header")).toHaveCSS("opacity", "1");
  await expect(blocks.first.locator(".resize-e")).toHaveCount(0);
  await expect(blocks.second.locator(".resize-e")).toHaveCount(0);
  await expect(page.locator(".selection-frame-handle")).toHaveCount(8);

  const before = await Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]);
  const moveSurface = page.getByRole("button", { name: "Move selected elements" });
  const moveBounds = await requiredBounds(moveSurface, "all-text selection move surface");
  await page.mouse.move(moveBounds.x + moveBounds.width / 2, moveBounds.y + moveBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBounds.x + moveBounds.width / 2 + 84, moveBounds.y + moveBounds.height / 2 + 56, { steps: 7 });
  await page.mouse.up();
  await expect.poll(() => Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)])).toEqual([
    { x: before[0].x + 84, y: before[0].y + 56 },
    { x: before[1].x + 84, y: before[1].y + 56 },
  ]);

  const beforeWidth = await readWorldWidth(blocks.first);
  const beforeSecondWidth = await readWorldWidth(blocks.second);
  const header = blocks.first.locator(".text-block-header");
  await header.focus();
  await expect(header).toHaveAttribute("aria-keyshortcuts", "F2 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight");
  await header.press("Alt+Shift+ArrowRight");
  await expect.poll(() => readWorldWidth(blocks.first)).toBeCloseTo(beforeWidth + 10, 1);
  await expect.poll(() => readWorldWidth(blocks.second)).toBeCloseTo(beforeSecondWidth, 1);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => readWorldWidth(blocks.first)).toBeCloseTo(beforeWidth, 2);
});

for (const zoom of [50, 100, 200]) {
  test(`all-text header Arrow movement translates the complete selection once at ${zoom}%`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    const bounds = await requiredBounds(canvas, "canvas");
    const blocks = await createTwoTextBlocks(page, bounds);
    await marqueeSelect(page, bounds, [blocks.first, blocks.second]);
    await setZoom(page, canvas, zoom);

    const before = await Promise.all([
      readWorldPosition(blocks.first),
      readWorldPosition(blocks.second),
    ]);
    const header = blocks.first.locator(".text-block-header");
    await header.focus();
    await header.press("ArrowRight");
    const worldDelta = 1 / (zoom / 100);
    const moved = before.map((position) => ({ ...position, x: position.x + worldDelta }));
    await expect.poll(() => Promise.all([
      readWorldPosition(blocks.first),
      readWorldPosition(blocks.second),
    ])).toEqual(moved);

    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => Promise.all([
      readWorldPosition(blocks.first),
      readWorldPosition(blocks.second),
    ])).toEqual(before);

    const beforeSizes = await Promise.all([readWorldSize(blocks.first), readWorldSize(blocks.second)]);
    const beforeResizePositions = await Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]);
    const { bounds: handleBounds, corner } = await interactiveResizeHandle(page);
    const start = {
      x: handleBounds.x + handleBounds.width / 2,
      y: handleBounds.y + handleBounds.height / 2,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(
      start.x + (corner.includes("e") ? 60 : -60),
      start.y + (corner.includes("s") ? 48 : -48),
      { steps: 6 },
    );
    const textClones = page.locator('.resize-layer-clone[data-canvas-element-type="text"]');
    await expect(textClones).toHaveCount(2);
    const previewSizes = await Promise.all([readWorldSize(textClones.nth(0)), readWorldSize(textClones.nth(1))]);
    const previewBounds = await Promise.all([
      requiredBounds(textClones.nth(0), "first text resize preview"),
      requiredBounds(textClones.nth(1), "second text resize preview"),
    ]);
    expect(previewSizes[0].width).toBeGreaterThan(beforeSizes[0].width);
    expect(previewSizes[1].width).toBeGreaterThan(beforeSizes[1].width);
    expect(Math.hypot(
      previewBounds[1].x - previewBounds[0].x,
      previewBounds[1].y - previewBounds[0].y,
    )).toBeGreaterThan(50 * zoom / 100);
    await expect.poll(() => Promise.all([readWorldSize(blocks.first), readWorldSize(blocks.second)])).toEqual(beforeSizes);
    await expect.poll(() => Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]))
      .toEqual(beforeResizePositions);
    await page.mouse.up();
    await expect.poll(() => Promise.all([readWorldWidth(blocks.first), readWorldWidth(blocks.second)]))
      .toEqual(previewSizes.map((size) => size.width));
    const committedPositions = await Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]);
    expect(committedPositions[0]).not.toEqual(committedPositions[1]);
    const committedBounds = await Promise.all([
      requiredBounds(blocks.first, "first committed resized text"),
      requiredBounds(blocks.second, "second committed resized text"),
    ]);
    for (let index = 0; index < committedBounds.length; index += 1) {
      expect(committedBounds[index].x).toBeCloseTo(previewBounds[index].x, 0);
      expect(committedBounds[index].y).toBeCloseTo(previewBounds[index].y, 0);
      expect(committedBounds[index].width).toBeCloseTo(previewBounds[index].width, 0);
    }

    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => Promise.all([readWorldSize(blocks.first), readWorldSize(blocks.second)])).toEqual(beforeSizes);
    await expect.poll(() => Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]))
      .toEqual(beforeResizePositions);
    await page.keyboard.press("Control+y");
    await expect.poll(() => Promise.all([readWorldWidth(blocks.first), readWorldWidth(blocks.second)]))
      .toEqual(previewSizes.map((size) => size.width));
    await expect.poll(() => Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]))
      .toEqual(committedPositions);
  });
}

test("all-text corner resize commits once and reloads without collapsing", async ({ page }) => {
  await installAllTextResizeWorkspace(page);
  await page.reload();
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const blocks = {
    first: page.locator('[data-canvas-element-id="resize-text-first"]'),
    second: page.locator('[data-canvas-element-id="resize-text-second"]'),
  };
  await expect(blocks.first).toBeVisible();
  await expect(blocks.second).toBeVisible();
  await marqueeSelect(page, bounds, [blocks.first, blocks.second]);
  await resetSelectionFramePersistenceCounts(page);

  const { bounds: handleBounds, corner } = await interactiveResizeHandle(page);
  const start = { x: handleBounds.x + handleBounds.width / 2, y: handleBounds.y + handleBounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + (corner.includes("e") ? 120 : -120),
    start.y + (corner.includes("s") ? 70 : -70),
    { steps: 8 },
  );
  await expect.poll(() => selectionFramePersistenceCounts(page)).toEqual({ apply: 0, session: 0 });
  await page.mouse.up();
  await expect.poll(async () => (await selectionFramePersistenceCounts(page)).apply).toBe(1);

  const committedPositions = await Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]);
  const committedSizes = await Promise.all([readWorldSize(blocks.first), readWorldSize(blocks.second)]);
  expect(Math.hypot(
    committedPositions[1].x - committedPositions[0].x,
    committedPositions[1].y - committedPositions[0].y,
  )).toBeGreaterThan(100);

  await page.reload();
  await expect.poll(() => Promise.all([readWorldPosition(blocks.first), readWorldPosition(blocks.second)]))
    .toEqual(committedPositions);
  await expect.poll(() => Promise.all([readWorldSize(blocks.first), readWorldSize(blocks.second)]))
    .toEqual(committedSizes);

  await blocks.first.locator(".text-block-display").dblclick();
  const editor = blocks.first.locator(".text-block-editor-content");
  await expect(editor).toBeFocused();
  await editor.fill(Array.from({ length: 14 }, (_, index) => `Growing line ${index + 1}`).join("\n"));
  await expect.poll(async () => (await readWorldSize(blocks.first)).height)
    .toBeGreaterThan(committedSizes[0].height);
});

test("single text uses its native border with eight invisible resize hit zones", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const block = await createTextBlock(page, bounds.x + 440, bounds.y + 260, "Native text border");
  await block.locator(".text-block-display").click();

  const frame = page.locator(".selection-frame.is-native-text-frame");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveCSS("box-shadow", "none");
  await expect(page.locator(".selection-frame-move-surface")).toHaveCount(0);

  const handles = frame.locator(".selection-frame-handle");
  await expect(handles).toHaveCount(8);
  const expectedCursors = {
    n: "ns-resize",
    ne: "nesw-resize",
    e: "ew-resize",
    se: "nwse-resize",
    s: "ns-resize",
    sw: "nesw-resize",
    w: "ew-resize",
    nw: "nwse-resize",
  } as const;
  for (const [handle, cursor] of Object.entries(expectedCursors)) {
    const control = frame.locator(`[data-selection-resize-handle="${handle}"]`);
    await expect(control).toHaveCSS("cursor", cursor);
    expect(await control.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");
  }

  const east = frame.locator('[data-selection-resize-handle="e"]');
  const eastBounds = await requiredBounds(east, "east resize zone");
  expect(eastBounds.width).toBeCloseTo(12, 0);
  const eastHit = await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.getAttribute("data-selection-resize-handle"), {
      x: eastBounds.x + eastBounds.width / 2,
      y: eastBounds.y + eastBounds.height / 2,
    });
  expect(eastHit).toBe("e");

  const northwest = frame.locator('[data-selection-resize-handle="nw"]');
  const northwestBounds = await requiredBounds(northwest, "northwest resize zone");
  const northwestHit = await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.getAttribute("data-selection-resize-handle"), {
      x: northwestBounds.x + northwestBounds.width / 2,
      y: northwestBounds.y + northwestBounds.height / 2,
    });
  expect(northwestHit).toBe("nw");
});

test("east text resize preserves manual height until content outgrows it", async ({ page }) => {
  await installAllTextResizeWorkspace(page);
  await page.reload();
  const block = page.locator('[data-canvas-element-id="resize-text-first"]');
  const header = block.locator(".text-block-header");
  await expect(block).toBeVisible();
  await header.click();
  const initialHeight = (await readWorldSize(block)).height;
  expect(initialHeight).toBe(180);

  const eastHandle = page.getByRole("button", { name: "Resize selected elements from e", exact: true });
  const handleBounds = await requiredBounds(eastHandle, "east text resize handle");
  const start = { x: handleBounds.x + handleBounds.width / 2, y: handleBounds.y + handleBounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 120, start.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await readWorldSize(block)).height).toBe(initialHeight);

  await header.focus();
  await header.press("F2");
  const editor = block.locator(".text-block-editor-content");
  await expect(editor).toBeFocused();
  await editor.fill(Array.from({ length: 14 }, (_, index) => `Overflow line ${index + 1}`).join("\n"));
  await expect.poll(async () => (await readWorldSize(block)).height).toBeGreaterThan(initialHeight);
});

for (const cancelPath of ["Escape", "tool change", "page change", "window blur", "pointer cancel", "lost pointer capture"] as const) {
  test(`all-text header drag releases capture without committing on ${cancelPath}`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    const canvasBounds = await requiredBounds(canvas, "canvas");
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

    const blocks = await createTwoTextBlocks(page, canvasBounds);
    await marqueeSelect(page, canvasBounds, [blocks.first, blocks.second]);
    await expect(page.locator(".selection-frame")).toHaveCount(1);
    const firstBlockId = await blocks.first.getAttribute("data-block-id");
    if (!firstBlockId) throw new Error("Selected text block id was unavailable.");
    const sourceText = page.locator(`.text-block[data-block-id="${firstBlockId}"]:not(.drag-layer-clone)`);
    const header = sourceText.locator(".text-block-header");

    const historyBaseline = await Promise.all([
      readWorldPosition(blocks.first),
      readWorldPosition(blocks.second),
    ]);
    await header.focus();
    await header.press("ArrowRight");
    const positionsBeforeCancel = await Promise.all([
      readWorldPosition(blocks.first),
      readWorldPosition(blocks.second),
    ]);

    const headerBounds = await requiredBounds(header, "selected text header");
    const start = {
      x: headerBounds.x + headerBounds.width / 2,
      y: headerBounds.y + headerBounds.height / 2,
    };
    await page.evaluate(() => {
      document.addEventListener("pointerdown", (event) => {
        document.body.dataset.testPointerId = String(event.pointerId);
      }, { capture: true, once: true });
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 54, start.y + 38, { steps: 5 });
    await expect(page.locator(".drag-layer-clone")).toHaveCount(2);
    await expect(page.locator("body")).toHaveClass(/is-interacting/);
    const capturedPointerId = Number(await page.locator("body").getAttribute("data-test-pointer-id"));
    await page.locator("body").evaluate((element) => delete (element as HTMLElement).dataset.testPointerId);
    expect(Number.isFinite(capturedPointerId)).toBe(true);
    expect(await page.evaluate((pointerId) =>
      Array.from(document.querySelectorAll<HTMLElement>("*"))
        .some((element) => element.hasPointerCapture(pointerId)), capturedPointerId)).toBe(true);

    if (cancelPath === "Escape") {
      await page.keyboard.press("Escape");
    } else if (cancelPath === "tool change") {
      await page.getByRole("button", { name: /Pen \(P/ }).dispatchEvent("click");
    } else if (cancelPath === "page change") {
      await alternateTab!.dispatchEvent("click");
    } else if (cancelPath === "window blur") {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    } else if (cancelPath === "pointer cancel") {
      await page.evaluate(({ pointerId, x, y }) => {
        const captureTarget = Array.from(document.querySelectorAll<HTMLElement>("*"))
          .find((element) => element.hasPointerCapture(pointerId));
        if (!captureTarget) throw new Error("Captured text drag target was unavailable.");
        captureTarget.dispatchEvent(new PointerEvent("pointercancel", {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
          pointerId,
        }));
      }, { pointerId: capturedPointerId, x: start.x + 54, y: start.y + 38 });
    } else {
      await page.evaluate((pointerId) => {
        const captureTarget = Array.from(document.querySelectorAll<HTMLElement>("*"))
          .find((element) => element.hasPointerCapture(pointerId));
        if (!captureTarget) throw new Error("Captured text drag target was unavailable.");
        captureTarget.releasePointerCapture(pointerId);
        captureTarget.dispatchEvent(new PointerEvent("lostpointercapture", {
          bubbles: true,
          pointerId,
        }));
      }, capturedPointerId);
    }

    await expect(page.locator(".drag-layer-clone")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
    await expect.poll(() => page.evaluate((pointerId) =>
      Array.from(document.querySelectorAll<HTMLElement>("*"))
        .some((element) => element.hasPointerCapture(pointerId)), capturedPointerId)).toBe(false);
    const transformAfterCancel = await page.locator(".canvas-content").evaluate((element) =>
      (element as HTMLElement).style.transform);
    await page.mouse.move(
      canvasBounds.x + canvasBounds.width - 4,
      canvasBounds.y + canvasBounds.height / 2,
      { steps: 3 },
    );
    await page.waitForTimeout(100);
    await expect(page.locator(".drag-layer-clone")).toHaveCount(0);
    await expect.poll(() => page.locator(".canvas-content").evaluate((element) =>
      (element as HTMLElement).style.transform)).toBe(transformAfterCancel);
    await page.mouse.up();

    if (cancelPath === "tool change") {
      await page.getByRole("button", { name: /Select \(V/ }).click();
    } else if (cancelPath === "page change") {
      await originalTab!.click();
    }
    await expect.poll(() => Promise.all([
      readWorldPosition(blocks.first),
      readWorldPosition(blocks.second),
    ])).toEqual(positionsBeforeCancel);

    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => Promise.all([
      readWorldPosition(blocks.first),
      readWorldPosition(blocks.second),
    ])).toEqual(historyBaseline);
  });
}

test("mixed resize handles describe and keyboard-apply text reflow with shape scaling", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const elements = await createMixedSelection(page, bounds);
  await marqueeSelect(page, bounds, [elements.shape, elements.text]);

  const handles = page.getByRole("button", {
    name: /Resize selected elements from (nw|ne|se|sw)/,
  });
  await expect(handles).toHaveCount(4);
  const southeast = page.getByRole("button", {
    name: "Resize selected elements from se",
  });
  const beforeShapeWidth = await readWorldWidth(elements.shape);
  const beforeTextWidth = await readWorldWidth(elements.text);
  const beforeTextPosition = await readWorldPosition(elements.text);
  await southeast.focus();
  await southeast.press("Shift+ArrowRight");
  await expect.poll(() => readWorldWidth(elements.shape)).toBeGreaterThan(beforeShapeWidth);
  await expect.poll(() => readWorldWidth(elements.text)).toBeGreaterThan(beforeTextWidth);
  await expect.poll(() => readWorldPosition(elements.text)).not.toEqual(beforeTextPosition);
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

  await page.mouse.move(bounds.x + 300, bounds.y + 220);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 760, bounds.y + 520, { steps: 5 });
  await page.mouse.up();
  await expect(marquee).toBeHidden();
  await expect(page.locator(".selection-frame")).toHaveCount(0);
  await expect(page.locator(".text-block.is-selected")).toHaveCount(1);

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

test("connector endpoint previews revert on Escape and window blur", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  await page.getByRole("button", { name: "Line (L / 6)" }).click();
  await page.mouse.move(bounds.x + 360, bounds.y + 300);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 560, bounds.y + 380, { steps: 4 });
  await page.mouse.up();

  const connector = page.getByRole("button", { name: "Select and move line connector" });
  const frame = page.locator(".selection-frame");
  const originalConnectorBounds = await roundedBounds(connector);
  const originalFrameBounds = await roundedBounds(frame);

  for (const cancel of ["escape", "blur"] as const) {
    const endpoint = page.getByRole("button", { name: "Move connector end endpoint" });
    const endpointBounds = await requiredBounds(endpoint, "connector endpoint");
    await page.mouse.move(endpointBounds.x + endpointBounds.width / 2, endpointBounds.y + endpointBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(endpointBounds.x + endpointBounds.width / 2 + 80, endpointBounds.y + endpointBounds.height / 2 + 55, { steps: 5 });
    await expect.poll(() => roundedBounds(connector)).not.toEqual(originalConnectorBounds);
    if (cancel === "escape") await page.keyboard.press("Escape");
    else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
    await expect.poll(() => roundedBounds(connector)).toEqual(originalConnectorBounds);
    await expect.poll(() => roundedBounds(frame)).toEqual(originalFrameBounds);
  }
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
  test(`mixed selection frame follows its live drag and commits once at ${zoom}%`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    const bounds = await requiredBounds(canvas, "canvas");
    const elements = await createMixedSelection(page, bounds);
    await marqueeSelect(page, bounds, [elements.shape, elements.text]);
    await setZoom(page, canvas, zoom);

    const frame = page.locator(".selection-frame");
    const beforeFrame = await requiredBounds(frame, "selection frame");
    const beforePositions = await Promise.all([
      readWorldPosition(elements.shape),
      readWorldPosition(elements.text),
    ]);
    const moveSurface = page.getByRole("button", { name: "Move selected elements" });
    const moveBounds = await requiredBounds(moveSurface, "selection move surface");
    const start = {
      x: moveBounds.x + moveBounds.width / 2,
      y: moveBounds.y + moveBounds.height / 2,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 48, start.y + 36, { steps: 6 });

    await expect(page.locator(".drag-layer-clone")).toHaveCount(2);
    expect(await Promise.all([
      readWorldPosition(elements.shape),
      readWorldPosition(elements.text),
    ])).toEqual(beforePositions);
    const liveFrame = await requiredBounds(frame, "live selection frame");
    expect(liveFrame.x - beforeFrame.x).toBeCloseTo(48, 0);
    expect(liveFrame.y - beforeFrame.y).toBeCloseTo(36, 0);

    await page.mouse.up();
    const worldDelta = { x: 48 / (zoom / 100), y: 36 / (zoom / 100) };
    await expect.poll(() => Promise.all([
      readWorldPosition(elements.shape),
      readWorldPosition(elements.text),
    ])).toEqual(beforePositions.map((position) => ({
      x: position.x + worldDelta.x,
      y: position.y + worldDelta.y,
    })));

    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => Promise.all([
      readWorldPosition(elements.shape),
      readWorldPosition(elements.text),
    ])).toEqual(beforePositions);
    await page.keyboard.press("Control+y");
    await expect.poll(() => Promise.all([
      readWorldPosition(elements.shape),
      readWorldPosition(elements.text),
    ])).toEqual(beforePositions.map((position) => ({
      x: position.x + worldDelta.x,
      y: position.y + worldDelta.y,
    })));
  });

  test(`mixed resize reflows text in preview, commit, and undo at ${zoom}%`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    const bounds = await requiredBounds(canvas, "canvas");
    const elements = await createMixedSelection(page, bounds);
    await marqueeSelect(page, bounds, [elements.shape, elements.text]);
    await setZoom(page, canvas, zoom);

    const { bounds: handleBounds, corner, handle } = await interactiveResizeHandle(page);
    const beforeTextSize = await readWorldSize(elements.text);
    const beforeTextPosition = await readWorldPosition(elements.text);
    const beforeShapeWidth = await readWorldWidth(elements.shape);
    const beforeTextScreen = await requiredBounds(elements.text, "text block");
    const start = {
      x: handleBounds.x + handleBounds.width / 2,
      y: handleBounds.y + handleBounds.height / 2,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(
      start.x + (corner.includes("e") ? 60 : -60),
      start.y + (corner.includes("s") ? 48 : -48),
      { steps: 6 },
    );

    const textClone = page.locator('.resize-layer-clone[data-canvas-element-type="text"]');
    const shapeClone = page.locator('.resize-layer-clone[data-canvas-element-type="shape"]');
    await expect(textClone).toHaveCount(1);
    await expect(shapeClone).toHaveCount(1);
    const textCloneBounds = await requiredBounds(textClone, "text resize preview");
    const shapeCloneBounds = await requiredBounds(shapeClone, "shape resize preview");
    const previewFrame = await requiredBounds(page.locator(".selection-frame"), "resize preview frame");
    expect(textCloneBounds.width).toBeGreaterThan(beforeTextScreen.width);
    expect(shapeCloneBounds.width).toBeGreaterThan(beforeShapeWidth * (zoom / 100));
    expect(previewFrame.x).toBeLessThanOrEqual(Math.min(textCloneBounds.x, shapeCloneBounds.x));
    expect(previewFrame.x + previewFrame.width).toBeGreaterThanOrEqual(
      Math.max(textCloneBounds.x + textCloneBounds.width, shapeCloneBounds.x + shapeCloneBounds.width),
    );
    expect(await readWorldSize(elements.text)).toEqual(beforeTextSize);
    expect(await readWorldWidth(elements.shape)).toBe(beforeShapeWidth);
    const previewTextSize = await readWorldSize(textClone);
    expect(previewTextSize.width).toBeGreaterThan(beforeTextSize.width);

    await page.mouse.up();
    await expect.poll(() => readWorldSize(elements.text)).toEqual(previewTextSize);
    await expect.poll(() => readWorldWidth(elements.shape)).toBeGreaterThan(beforeShapeWidth);
    await expect.poll(() => readWorldPosition(elements.text)).not.toEqual(beforeTextPosition);

    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => readWorldSize(elements.text)).toEqual(beforeTextSize);
    await expect.poll(() => readWorldWidth(elements.shape)).toBeCloseTo(beforeShapeWidth, 1);
    await expect.poll(() => readWorldPosition(elements.text)).toEqual(beforeTextPosition);
  });
}

test("unrelated React commits cannot reset a transient mixed-selection frame", async ({ page }) => {
  await installSelectionFrameWorkspace(page);
  await page.reload();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const elements = {
    shape: page.locator('[data-canvas-element-id="frame-shape"]:not(.drag-layer-clone)'),
    text: page.locator('[data-canvas-element-id="frame-text"]:not(.drag-layer-clone)'),
  };
  await expect(elements.shape).toBeVisible();
  await expect(elements.text).toBeVisible();
  await marqueeSelect(page, bounds, [elements.shape, elements.text]);

  const frame = page.locator(".selection-frame");
  const moveSurface = page.getByRole("button", { name: "Move selected elements" });
  const historyBaseline = await Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ]);
  await moveSurface.focus();
  await moveSurface.press("ArrowRight");
  const originalPositions = historyBaseline.map((position) => ({
    ...position,
    x: position.x + 1,
  }));
  await expect.poll(() => Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ])).toEqual(originalPositions);
  await expect.poll(() => selectionFramePersistenceCounts(page)).toEqual({ apply: 1, session: 1 });
  await resetSelectionFramePersistenceCounts(page);
  const originalFrame = await roundedBounds(frame);
  const moveBounds = await requiredBounds(moveSurface, "selection move surface");
  const moveStart = {
    x: moveBounds.x + moveBounds.width / 2,
    y: moveBounds.y + moveBounds.height / 2,
  };
  await page.mouse.move(moveStart.x, moveStart.y);
  await page.mouse.down();
  await page.mouse.move(moveStart.x + 64, moveStart.y + 42, { steps: 6 });
  await expect(page.locator(".drag-layer-clone")).toHaveCount(2);
  const dragPreviewFrame = await roundedBounds(frame);
  expect(dragPreviewFrame).not.toEqual(originalFrame);
  expect(await Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ])).toEqual(originalPositions);
  expect(await selectionFramePersistenceCounts(page)).toEqual({ apply: 0, session: 0 });

  await page.getByRole("button", { name: "Grid", exact: true }).dispatchEvent("click");
  await expect.poll(() => roundedBounds(frame)).toEqual(dragPreviewFrame);
  expect(await Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ])).toEqual(originalPositions);

  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".drag-layer-clone")).toHaveCount(0);
  await expect.poll(() => roundedBounds(frame)).toEqual(originalFrame);
  expect(await Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ])).toEqual(originalPositions);
  expect(await selectionFramePersistenceCounts(page)).toEqual({ apply: 0, session: 0 });

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ])).toEqual(historyBaseline);
  await expect.poll(async () => (await selectionFramePersistenceCounts(page)).apply).toBe(1);
  await page.keyboard.press("Control+y");
  await expect.poll(() => Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ])).toEqual(originalPositions);
  await expect.poll(async () => (await selectionFramePersistenceCounts(page)).apply).toBe(2);
  await resetSelectionFramePersistenceCounts(page);

  const originalSizes = await Promise.all([
    readWorldSize(elements.shape),
    readWorldSize(elements.text),
  ]);
  const { bounds: handleBounds, corner } = await interactiveResizeHandle(page);
  const resizeStart = {
    x: handleBounds.x + handleBounds.width / 2,
    y: handleBounds.y + handleBounds.height / 2,
  };
  const resizeEnd = {
    x: resizeStart.x + (corner.includes("e") ? 72 : -72),
    y: resizeStart.y + (corner.includes("s") ? 48 : -48),
  };
  await page.mouse.move(resizeStart.x, resizeStart.y);
  await page.mouse.down();
  await page.mouse.move(resizeEnd.x, resizeEnd.y, { steps: 6 });
  await expect(page.locator(".resize-layer-clone")).toHaveCount(2);
  const resizePreviewFrame = await roundedBounds(frame);
  expect(resizePreviewFrame).not.toEqual(originalFrame);
  expect(await Promise.all([
    readWorldSize(elements.shape),
    readWorldSize(elements.text),
  ])).toEqual(originalSizes);
  expect(await selectionFramePersistenceCounts(page)).toEqual({ apply: 0, session: 0 });

  await page.getByRole("button", { name: "Grid", exact: true }).dispatchEvent("click");
  await expect.poll(() => roundedBounds(frame)).toEqual(resizePreviewFrame);
  expect(await Promise.all([
    readWorldSize(elements.shape),
    readWorldSize(elements.text),
  ])).toEqual(originalSizes);

  await page.mouse.up();
  await expect(page.locator(".resize-layer-clone")).toHaveCount(0);
  await expect.poll(() => roundedBounds(frame)).toEqual(resizePreviewFrame);
  const committedSizes = await Promise.all([
    readWorldSize(elements.shape),
    readWorldSize(elements.text),
  ]);
  expect(committedSizes).not.toEqual(originalSizes);
  await expect.poll(async () => (await selectionFramePersistenceCounts(page)).apply).toBe(1);

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => Promise.all([
    readWorldSize(elements.shape),
    readWorldSize(elements.text),
  ])).toEqual(originalSizes);
  await expect.poll(async () => (await selectionFramePersistenceCounts(page)).apply).toBe(2);
  await page.keyboard.press("Control+y");
  await expect.poll(() => Promise.all([
    readWorldSize(elements.shape),
    readWorldSize(elements.text),
  ])).toEqual(committedSizes);
  await expect.poll(async () => (await selectionFramePersistenceCounts(page)).apply).toBe(3);
});

test("mixed resize preview and frame return to their original geometry on pointer cancel", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const elements = await createMixedSelection(page, bounds);
  await marqueeSelect(page, bounds, [elements.shape, elements.text]);
  const frame = page.locator(".selection-frame");
  const originalFrame = await roundedBounds(frame);
  const originalWidths = await Promise.all([readWorldWidth(elements.shape), readWorldWidth(elements.text)]);
  const handle = page.getByRole("button", {
    name: "Resize selected elements from se",
  });
  const handleBounds = await requiredBounds(handle, "selection resize handle");
  const start = { x: handleBounds.x + handleBounds.width / 2, y: handleBounds.y + handleBounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 72, start.y + 48, { steps: 5 });
  await expect.poll(() => roundedBounds(frame)).not.toEqual(originalFrame);
  await handle.dispatchEvent("pointercancel", { button: 0, clientX: start.x + 72, clientY: start.y + 48, pointerId: 1 });
  await page.mouse.up();
  await expect(page.locator(".resize-layer-clone")).toHaveCount(0);
  await expect.poll(() => roundedBounds(frame)).toEqual(originalFrame);
  await expect.poll(() => Promise.all([readWorldWidth(elements.shape), readWorldWidth(elements.text)])).toEqual(originalWidths);
});

test("opening Find cancels mixed selection resize without stale geometry and allows a later resize", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const elements = await createMixedSelection(page, bounds);
  await marqueeSelect(page, bounds, [elements.shape, elements.text]);
  const frame = page.locator(".selection-frame");
  const originalFrame = await roundedBounds(frame);
  const originalWidths = await Promise.all([readWorldWidth(elements.shape), readWorldWidth(elements.text)]);
  let interactive = await interactiveResizeHandle(page);
  let start = {
    x: interactive.bounds.x + interactive.bounds.width / 2,
    y: interactive.bounds.y + interactive.bounds.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + (interactive.corner.includes("e") ? 72 : -72),
    start.y + (interactive.corner.includes("s") ? 48 : -48),
    { steps: 5 },
  );
  await expect(page.locator(".resize-layer-clone")).not.toHaveCount(0);

  await page.getByRole("button", { name: "Find in canvas" }).dispatchEvent("click");
  await expect(page.getByRole("textbox", { name: "Find in canvas" })).toBeFocused();
  await expect(page.locator(".resize-layer-clone")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
  await page.mouse.move(start.x + 140, start.y + 100, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => roundedBounds(frame)).toEqual(originalFrame);
  await expect.poll(() => Promise.all([readWorldWidth(elements.shape), readWorldWidth(elements.text)])).toEqual(originalWidths);

  await page.getByRole("button", { name: "Close search", exact: true }).click();
  interactive = await interactiveResizeHandle(page);
  start = {
    x: interactive.bounds.x + interactive.bounds.width / 2,
    y: interactive.bounds.y + interactive.bounds.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + (interactive.corner.includes("e") ? 60 : -60),
    start.y + (interactive.corner.includes("s") ? 40 : -40),
    { steps: 4 },
  );
  await page.mouse.up();
  await expect.poll(() => Promise.all([readWorldWidth(elements.shape), readWorldWidth(elements.text)])).not.toEqual(originalWidths);
});

test("mixed resize previews a selected free connector with the exact committed transform once", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const elements = await createMixedSelection(page, bounds);
  await page.getByRole("button", { name: "Line (L / 6)" }).click();
  await page.mouse.move(bounds.x + 500, bounds.y + 240);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 720, bounds.y + 420, { steps: 4 });
  await page.mouse.up();
  const connector = page.locator('[data-canvas-element-type="connector"]:not(.connector-transform-preview)').last();
  await expect(connector).toBeVisible();
  const connectorId = await connector.getAttribute("data-canvas-element-id");
  if (!connectorId) throw new Error("Free connector id was unavailable.");
  const original = await readConnectorEndpoints(connector);

  await marqueeSelect(page, bounds, [elements.shape, elements.text, connector]);
  let interactive = await interactiveResizeHandle(page);
  let start = {
    x: interactive.bounds.x + interactive.bounds.width / 2,
    y: interactive.bounds.y + interactive.bounds.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + (interactive.corner.includes("e") ? 84 : -84),
    start.y + (interactive.corner.includes("s") ? 64 : -64),
    { steps: 5 },
  );
  let preview = page.locator(".connector-transform-preview");
  await expect(preview).toHaveCount(1);
  expect(await readConnectorEndpoints(preview, connectorId)).not.toEqual(original);
  await interactive.handle.dispatchEvent("pointercancel", {
    bubbles: true,
    button: 0,
    clientX: start.x,
    clientY: start.y,
    pointerId: 1,
  });
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  expect(await readConnectorEndpoints(connector)).toEqual(original);

  interactive = await interactiveResizeHandle(page);
  start = {
    x: interactive.bounds.x + interactive.bounds.width / 2,
    y: interactive.bounds.y + interactive.bounds.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + (interactive.corner.includes("e") ? 84 : -84),
    start.y + (interactive.corner.includes("s") ? 64 : -64),
    { steps: 5 },
  );
  preview = page.locator(".connector-transform-preview");
  await expect(preview).toHaveCount(1);
  const previewEndpoints = await readConnectorEndpoints(preview, connectorId);
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect.poll(() => readConnectorEndpoints(connector)).toEqual(previewEndpoints);
});

for (const cancelPath of ["Escape", "tool change", "page change", "window blur", "pointer cancel", "lost pointer capture"] as const) {
  test(`header mixed drag cleanup restores the frame on ${cancelPath}`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    const canvasBounds = await requiredBounds(canvas, "canvas");
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

    const elements = await createMixedSelection(page, canvasBounds);
    await marqueeSelect(page, canvasBounds, [elements.shape, elements.text]);
    const textBlockId = await elements.text.getAttribute("data-block-id");
    if (!textBlockId) throw new Error("Mixed text block id was unavailable.");
    const sourceText = page.locator(`[data-block-id="${textBlockId}"]`);
    const header = sourceText.locator(".text-block-header");
    const historyBaseline = await Promise.all([
      readWorldPosition(elements.shape),
      readWorldPosition(elements.text),
    ]);
    if (cancelPath === "Escape") {
      await header.focus();
      await header.press("ArrowRight");
    }
    const positionsBeforeCancel = await Promise.all([
      readWorldPosition(elements.shape),
      readWorldPosition(elements.text),
    ]);
    const frame = page.locator(".selection-frame");
    const originalFrame = await roundedBounds(frame);
    const headerBounds = await requiredBounds(header, "mixed text header");
    const start = {
      x: headerBounds.x + headerBounds.width / 2,
      y: headerBounds.y + headerBounds.height / 2,
    };
    await page.evaluate(() => {
      document.addEventListener("pointerdown", (event) => {
        document.body.dataset.testPointerId = String(event.pointerId);
      }, { capture: true, once: true });
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 2, start.y + 2);
    await expect(page.locator(".drag-layer-clone")).toHaveCount(0);
    await expect.poll(() => roundedBounds(frame)).toEqual(originalFrame);
    await page.mouse.move(start.x + 54, start.y + 38, { steps: 5 });
    await expect(page.locator(".drag-layer-clone")).toHaveCount(2);
    await expect(page.locator("body")).toHaveClass(/is-interacting/);
    await expect.poll(() => roundedBounds(frame)).not.toEqual(originalFrame);
    const capturedPointerId = Number(await page.locator("body").getAttribute("data-test-pointer-id"));
    await page.locator("body").evaluate((element) => delete (element as HTMLElement).dataset.testPointerId);
    expect(Number.isFinite(capturedPointerId)).toBe(true);
    expect(await page.evaluate((pointerId) =>
      Array.from(document.querySelectorAll<HTMLElement>("*"))
        .some((element) => element.hasPointerCapture(pointerId)), capturedPointerId)).toBe(true);

    if (cancelPath === "Escape") {
      await page.keyboard.press("Escape");
    } else if (cancelPath === "tool change") {
      await page.getByRole("button", { name: /Pen \(P/ }).dispatchEvent("click");
    } else if (cancelPath === "page change") {
      await alternateTab!.dispatchEvent("click");
    } else if (cancelPath === "window blur") {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    } else if (cancelPath === "pointer cancel") {
      await page.evaluate((point) => {
        const captureTarget = Array.from(document.querySelectorAll<HTMLElement>("*"))
          .find((element) => element.hasPointerCapture(point.pointerId));
        if (!captureTarget) throw new Error("Captured drag target was unavailable.");
        captureTarget.dispatchEvent(new PointerEvent("pointercancel", {
          bubbles: true,
          button: 0,
          clientX: point.x,
          clientY: point.y,
          pointerId: point.pointerId,
        }));
      }, {
        x: start.x + 54,
        y: start.y + 38,
        pointerId: capturedPointerId,
      });
    } else {
      await page.evaluate((pointerId) => {
        const captureTarget = Array.from(document.querySelectorAll<HTMLElement>("*"))
          .find((element) => element.hasPointerCapture(pointerId));
        if (!captureTarget) throw new Error("Captured drag target was unavailable.");
        captureTarget.releasePointerCapture(pointerId);
        captureTarget.dispatchEvent(new PointerEvent("lostpointercapture", {
          bubbles: true,
          pointerId,
        }));
      }, capturedPointerId);
    }

    await expect(page.locator(".drag-layer-clone")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
    const transformAfterCancel = await page.locator(".canvas-content").evaluate((element) =>
      (element as HTMLElement).style.transform);
    await page.mouse.move(
      canvasBounds.x + canvasBounds.width - 4,
      canvasBounds.y + canvasBounds.height / 2,
      { steps: 3 },
    );
    await page.waitForTimeout(100);
    await expect(page.locator(".drag-layer-clone")).toHaveCount(0);
    await expect.poll(() => page.locator(".canvas-content").evaluate((element) =>
      (element as HTMLElement).style.transform)).toBe(transformAfterCancel);
    await page.mouse.up();

    if (cancelPath === "tool change") {
      await page.getByRole("button", { name: /Select \(V/ }).click();
    } else if (cancelPath === "page change") {
      await originalTab!.click();
      await expect(frame).toHaveCount(0);
      await marqueeSelect(page, canvasBounds, [elements.shape, elements.text]);
    }
    await expect.poll(() => Promise.all([
      readWorldPosition(elements.shape),
      readWorldPosition(elements.text),
    ])).toEqual(positionsBeforeCancel);
    await expect.poll(() => roundedBounds(frame)).toEqual(originalFrame);

    if (cancelPath === "Escape") {
      await canvas.focus();
      await page.keyboard.press("Control+z");
      await expect.poll(() => Promise.all([
        readWorldPosition(elements.shape),
        readWorldPosition(elements.text),
      ])).toEqual(historyBaseline);
    }
  });
}

test("auto-pan keeps the live drag frame aligned and pointer cancel restores the selection", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const elements = await createMixedSelection(page, bounds);
  await marqueeSelect(page, bounds, [elements.shape, elements.text]);
  const frame = page.locator(".selection-frame");
  const originalFrame = await roundedBounds(frame);
  const originalPositions = await Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ]);
  const originalTransform = await page.locator(".canvas-content").evaluate((element) =>
    (element as HTMLElement).style.transform);
  const moveSurface = page.getByRole("button", { name: "Move selected elements" });
  const moveBounds = await requiredBounds(moveSurface, "selection move surface");
  const start = { x: moveBounds.x + moveBounds.width / 2, y: moveBounds.y + moveBounds.height / 2 };
  const edge = { x: bounds.x + bounds.width - 6, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(edge.x, edge.y, { steps: 6 });
  await expect.poll(async () => page.locator(".canvas-content").evaluate((element) =>
    (element as HTMLElement).style.transform)).not.toBe(originalTransform);
  await expect.poll(() => roundedBounds(frame)).not.toEqual(originalFrame);
  expect(await Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ])).toEqual(originalPositions);
  await moveSurface.dispatchEvent("pointercancel", {
    button: 0,
    clientX: edge.x,
    clientY: edge.y,
    pointerId: 1,
  });
  await page.mouse.up();
  await expect(page.locator(".drag-layer-clone")).toHaveCount(0);
  await expect.poll(async () => page.locator(".canvas-content").evaluate((element) =>
    (element as HTMLElement).style.transform)).toBe(originalTransform);
  await expect.poll(() => Promise.all([
    readWorldPosition(elements.shape),
    readWorldPosition(elements.text),
  ])).toEqual(originalPositions);
  const restoredElementBounds = await Promise.all([
    requiredBounds(elements.shape, "restored shape"),
    requiredBounds(elements.text, "restored text"),
  ]);
  const restoredFrame = await requiredBounds(frame, "restored selection frame");
  expect(restoredFrame.x).toBeLessThanOrEqual(Math.min(...restoredElementBounds.map((item) => item.x)));
  expect(restoredFrame.y).toBeLessThanOrEqual(Math.min(...restoredElementBounds.map((item) => item.y)));
  expect(restoredFrame.x + restoredFrame.width).toBeGreaterThanOrEqual(
    Math.max(...restoredElementBounds.map((item) => item.x + item.width)),
  );
  expect(restoredFrame.y + restoredFrame.height).toBeGreaterThanOrEqual(
    Math.max(...restoredElementBounds.map((item) => item.y + item.height)),
  );
});

async function createTwoTextBlocks(page: Page, bounds: { x: number; y: number }) {
  const first = await createTextBlock(page, bounds.x + 320, bounds.y + 220, "First selection");
  const second = await createTextBlock(page, bounds.x + 680, bounds.y + 280, "Second selection");
  return { first, second };
}

async function selectionFramePersistenceCounts(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __selectionFrameCounts: { apply: number; session: number };
  }).__selectionFrameCounts);
}

async function resetSelectionFramePersistenceCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as {
      __selectionFrameCounts: { apply: number; session: number };
    }).__selectionFrameCounts = { apply: 0, session: 0 };
  });
}

async function installSelectionFrameWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const storageKey = "note-selection-frame-playwright-workspace";
    const workspace = {
      elements: [
        {
          createdAt: 1,
          height: 110,
          id: "frame-shape",
          locked: false,
          opacity: 1,
          pageId: "frame-page",
          rotation: 0,
          shape: "rectangle",
          style: {
            fillColor: null,
            roughness: 1,
            roundness: 0,
            seed: 17,
            strokeColor: { kind: "fixed", value: "#4c6ef5" },
            strokeStyle: "solid",
            strokeWidth: 2,
          },
          type: "shape",
          updatedAt: 1,
          width: 150,
          x: 330,
          y: 220,
          zIndex: 1,
        },
        {
          backgroundMode: "surface",
          content: "One two three four five six\nOne two three four five six",
          createdAt: 1,
          height: 92,
          id: "frame-text",
          locked: false,
          opacity: 1,
          pageId: "frame-page",
          rotation: 0,
          type: "text",
          updatedAt: 1,
          width: 240,
          x: 560,
          y: 300,
          zIndex: 2,
        },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: true,
      pages: [{
        folderId: "",
        id: "frame-page",
        isBookmarked: false,
        revision: 0,
        title: "Selection frame",
      }],
      sessionState: {
        openPageTabIds: ["frame-page"],
        selectedFolderId: "",
        selectedPageId: "frame-page",
      },
      warnings: [],
    };
    const runtime = window as unknown as {
      __selectionFrameCounts: { apply: number; session: number };
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__selectionFrameCounts = { apply: 0, session: 0 };
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "initialize_storage") {
          return {
            databasePath: "selection-frame.db",
            importedLegacyData: false,
            schemaVersion: 1,
            warnings: [],
          };
        }
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
        if (command === "apply_scene_changes") {
          runtime.__selectionFrameCounts.apply += 1;
          const batch = args.batch as {
            deletedElementIds: string[];
            pageId: string;
            upserts: ElementRecord[];
          };
          const deletedIds = new Set(batch.deletedElementIds);
          const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
          workspace.elements = workspace.elements
            .filter((element) => element.pageId !== batch.pageId || !deletedIds.has(element.id))
            .map((element) => upserts.get(element.id) ?? element);
          for (const element of batch.upserts) {
            if (!workspace.elements.some((candidate) => candidate.id === element.id)) {
              workspace.elements.push(element);
            }
          }
          workspace.pages[0].revision += 1;
          localStorage.setItem(storageKey, JSON.stringify(workspace));
          return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
        }
        if (command === "save_session_state") {
          runtime.__selectionFrameCounts.session += 1;
          workspace.sessionState = args.state as typeof workspace.sessionState;
          localStorage.setItem(storageKey, JSON.stringify(workspace));
          return;
        }
        if (command === "load_asset") throw new Error("Unexpected asset load");
        if (command === "save_asset") throw new Error("Unexpected asset save");
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
}

async function installAllTextResizeWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const storageKey = "note-all-text-resize-playwright-workspace";
    const initialWorkspace = {
      elements: [
        {
          backgroundMode: "surface", content: "First resize target", createdAt: 1, height: 180,
          id: "resize-text-first", isWidthManuallyResized: true, locked: false, opacity: 1,
          manualHeight: 180, pageId: "resize-page", rotation: 0, type: "text", updatedAt: 1, width: 200,
          x: 300, y: 220, zIndex: 1,
        },
        {
          backgroundMode: "surface", content: "Second resize target with wrapped content", createdAt: 1, height: 100,
          id: "resize-text-second", isWidthManuallyResized: true, locked: false, opacity: 1,
          pageId: "resize-page", rotation: 0, type: "text", updatedAt: 1, width: 240,
          x: 650, y: 310, zIndex: 2,
        },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: true,
      pages: [{ folderId: "", id: "resize-page", isBookmarked: false, revision: 0, title: "All-text resize" }],
      sessionState: { openPageTabIds: ["resize-page"], selectedFolderId: "", selectedPageId: "resize-page" },
      warnings: [],
    };
    const stored = localStorage.getItem(storageKey);
    const workspace = stored ? JSON.parse(stored) as typeof initialWorkspace : initialWorkspace;
    const runtime = window as unknown as {
      __selectionFrameCounts: { apply: number; session: number };
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__selectionFrameCounts = { apply: 0, session: 0 };
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "all-text-resize.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__selectionFrameCounts.apply += 1;
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const deletedIds = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements
          .filter((element) => !deletedIds.has(element.id))
          .map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) {
          if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        }
        workspace.pages[0].revision += 1;
        localStorage.setItem(storageKey, JSON.stringify(workspace));
        return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") {
        runtime.__selectionFrameCounts.session += 1;
        workspace.sessionState = args.state as typeof workspace.sessionState;
        localStorage.setItem(storageKey, JSON.stringify(workspace));
        return;
      }
      return undefined;
    } };
  });
}

async function createMixedSelection(page: Page, bounds: { x: number; y: number }) {
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.mouse.move(bounds.x + 330, bounds.y + 220);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 480, bounds.y + 330, { steps: 4 });
  await page.mouse.up();
  const shape = page.locator('[data-canvas-element-type="shape"]:not(.drag-layer-clone)').last();
  await expect(shape).toBeVisible();
  const text = await createTextBlock(
    page,
    bounds.x + 560,
    bounds.y + 300,
    "One two three four five six\nOne two three four five six\nOne two three four five six\nOne two three four five six",
  );
  return { shape, text };
}

async function createTextBlock(page: Page, x: number, y: number, text: string) {
  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.dblclick(x, y);
  const editor = page.locator(".text-block-editor-content").last();
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.mouse.click(x + 380, y + 180);
  const allBlocks = page.locator(".text-block");
  const block = allBlocks.nth((await allBlocks.count()) - 1);
  await expect(block.locator(".text-block-display")).toContainText(text.replaceAll("\n", ""));
  return block;
}

async function marqueeSelect(page: Page, canvasBounds: { x: number; y: number }, elements: readonly Locator[]) {
  await page.getByRole("button", { name: /Select \(V/ }).click();
  const elementBounds = await Promise.all(elements.map((element, index) => requiredBounds(element, `selection element ${index + 1}`)));
  await page.mouse.move(
    Math.min(...elementBounds.map((bounds) => bounds.x)) - 24,
    Math.min(...elementBounds.map((bounds) => bounds.y)) - 24,
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.max(...elementBounds.map((bounds) => bounds.x + bounds.width)) + 24,
    Math.max(...elementBounds.map((bounds) => bounds.y + bounds.height)) + 24,
    { steps: 7 },
  );
  await page.mouse.up();
  await expect(page.locator(".selection-rectangle")).toBeHidden();
  expect(canvasBounds.x).toBeGreaterThanOrEqual(0);
}

async function beginMarquee(page: Page, bounds: { x: number; y: number }) {
  await page.mouse.move(bounds.x + 300, bounds.y + 200);
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

async function interactiveResizeHandle(page: Page) {
  const handles = page.locator(".selection-frame-handle");
  for (let index = 0; index < await handles.count(); index += 1) {
    const handle = handles.nth(index);
    const bounds = await requiredBounds(handle, `selection resize handle ${index + 1}`);
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const hitClass = await page.evaluate(({ x, y }) =>
      (document.elementFromPoint(x, y) as HTMLElement | null)?.className ?? "", point);
    if (!hitClass.includes("selection-frame-handle")) continue;
    const corner = (await handle.getAttribute("class"))?.match(/selection-frame-handle-(nw|ne|se|sw)/)?.[1];
    if (corner === "nw" || corner === "ne" || corner === "se" || corner === "sw") {
      return { bounds, corner, handle };
    }
  }
  throw new Error("No selection resize handle was available at an interactive viewport point.");
}

async function roundedBounds(locator: Locator) {
  const bounds = await requiredBounds(locator, "element");
  return {
    height: Math.round(bounds.height),
    width: Math.round(bounds.width),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  };
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

async function readWorldSize(locator: Locator) {
  return locator.evaluate((element) => ({
    height: Number.parseFloat((element as HTMLElement).style.height),
    width: Number.parseFloat((element as HTMLElement).style.width),
  }));
}

async function readConnectorEndpoints(locator: Locator, connectorId?: string | null) {
  return locator.evaluate((element, id) => {
    const records = (element as HTMLCanvasElement & {
      __connectorPreviewRecords?: Map<string, { end: { x: number; y: number }; start: { x: number; y: number } }>;
    }).__connectorPreviewRecords;
    const record = id ? records?.get(id) : undefined;
    if (record) return { end: record.end, start: record.start };
    return {
      end: {
        x: Number((element as HTMLElement).dataset.connectorEndX),
        y: Number((element as HTMLElement).dataset.connectorEndY),
      },
      start: {
        x: Number((element as HTMLElement).dataset.connectorStartX),
        y: Number((element as HTMLElement).dataset.connectorStartY),
      },
    };
  }, connectorId);
}
