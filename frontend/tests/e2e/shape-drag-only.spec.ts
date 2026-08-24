import { expect, test, type Locator, type Page } from "@playwright/test";

const STORAGE_KEY = "shape-drag-only-workspace";
const TOOL_NAMES = {
  rectangle: "Rectangle (R / 2)",
  ellipse: "Ellipse (O / 4)",
  diamond: "Diamond (D / 3)",
} as const;
const DEFAULT_SHAPE_SIZES = {
  rectangle: { height: 100, width: 160 },
  ellipse: { height: 100, width: 140 },
  diamond: { height: 100, width: 140 },
} as const;

type ShapeName = keyof typeof TOOL_NAMES;

test.beforeEach(async ({ page }) => {
  await installWorkspace(page);
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(700);
  await resetCounts(page);
});

test("click and subthreshold shape gestures are inert at 50%, 100%, and 200%", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const existing = page.locator('[data-canvas-element-id="existing-shape"]');

  for (const zoom of [50, 100, 200]) {
    await setZoom(page, canvas, zoom);
    const canvasBounds = await requiredBounds(canvas, "canvas");

    for (const shape of Object.keys(TOOL_NAMES) as ShapeName[]) {
      await page.getByRole("button", { name: "Select (V / 1)" }).click();
      await existing.focus();
      await existing.press("Enter");
      await expect(existing).toHaveAttribute("aria-pressed", "true");
      const tool = page.getByRole("button", { name: TOOL_NAMES[shape] });
      await tool.click();
      await settleAndResetCounts(page);

      const start = { x: canvasBounds.x + canvasBounds.width - 260, y: canvasBounds.y + 180 };
      await page.mouse.click(start.x, start.y);
      await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
      for (const distance of [1, 2]) {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
        await page.mouse.move(start.x + distance, start.y);
        await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
        await page.mouse.up();
      }
      for (const delta of [
        { x: 12, y: 0 },
        { x: -12, y: 0 },
        { x: 0, y: 12 },
        { x: 0, y: -12 },
      ]) {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + delta.x, start.y + delta.y);
        await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
        await page.mouse.up();
      }
      const pointerId = await beginCapturedDrag(page, start, { x: start.x + 2.2, y: start.y + 2.2 });
      await expect(page.locator(".primitive-authoring-preview")).toHaveCount(1);
      await dispatchCapturedTermination(page, pointerId, "pointercancel", { x: start.x + 2.2, y: start.y + 2.2 });
      await page.mouse.up();

      await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
      await expect(existing).toHaveAttribute("aria-pressed", "true");
      await expect(tool).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
      await page.keyboard.press("Control+z");
      await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
    }
  }
});

test("meaningful shape drags commit once with zoom-invariant screen intent", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  let expectedShapeCount = 1;

  for (const zoom of [50, 100, 200]) {
    await setZoom(page, canvas, zoom);
    const canvasBounds = await requiredBounds(canvas, "canvas");
    for (const [shapeIndex, shape] of (Object.keys(TOOL_NAMES) as ShapeName[]).entries()) {
      const tool = page.getByRole("button", { name: TOOL_NAMES[shape] });
      await tool.click();
      await settleAndResetCounts(page);
      const start = {
        x: canvasBounds.x + 360 + shapeIndex * 90,
        y: canvasBounds.y + 210 + (zoom / 50 - 1) * 90,
      };
      await drag(page, start, { x: start.x + 24, y: start.y + 18 });
      expectedShapeCount += 1;

      await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(expectedShapeCount);
      await expect(page.getByRole("button", { name: "Select (V / 1)" })).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
      const created = await newestShape(page);
      expect(created?.shape).toBe(shape);
      expect(Number(created?.width)).toBeCloseTo(24 / (zoom / 100), 4);
      expect(Number(created?.height)).toBeCloseTo(18 / (zoom / 100), 4);
    }
  }

  const beforeUndo = await newestShape(page);
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(expectedShapeCount - 1);
  await page.keyboard.press("Control+y");
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(expectedShapeCount);
  await expect.poll(async () => (await workspaceElements(page)).some((element) => element.id === beforeUndo?.id)).toBe(true);
  await page.reload();
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(expectedShapeCount);
});

test("pointerup applies the final screen-space threshold without an intervening move", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const start = { x: bounds.x + 540, y: bounds.y + 240 };

  await page.getByRole("button", { name: TOOL_NAMES.rectangle }).click();
  await settleAndResetCounts(page);
  await releaseCapturedWithoutMove(page, start, { x: start.x + 1.2, y: start.y + 1.6 });
  await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await releaseCapturedWithoutMove(page, start, { x: start.x + 3, y: start.y });
  await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await page.getByRole("button", { name: TOOL_NAMES.diamond }).click();
  await settleAndResetCounts(page);
  const finalStart = { x: start.x + 40, y: start.y + 40 };
  await releaseCapturedWithoutMove(page, finalStart, { x: finalStart.x + 2.4, y: finalStart.y + 3.2 });
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(2);
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const greaterThanThresholdShape = await newestShape(page);
  if (!greaterThanThresholdShape) throw new Error("Final-pointer shape was unavailable.");
  expect(Number(greaterThanThresholdShape.x)).toBeCloseTo(finalStart.x - bounds.x, 4);
  expect(Number(greaterThanThresholdShape.y)).toBeCloseTo(finalStart.y - bounds.y, 4);
  expect(Number(greaterThanThresholdShape.width)).toBeCloseTo(2.4, 4);
  expect(Number(greaterThanThresholdShape.height)).toBeCloseTo(3.2, 4);

  await page.getByRole("button", { name: TOOL_NAMES.rectangle }).click();
  await settleAndResetCounts(page);
  const retreatStart = { x: start.x + 80, y: start.y + 60 };
  const pointerId = await beginCapturedDrag(page, retreatStart, { x: retreatStart.x + 8, y: retreatStart.y + 6 });
  await expect(page.locator(".primitive-authoring-preview")).toHaveCount(1);
  await expect(page.locator(`[data-canvas-element-id="${greaterThanThresholdShape.id}"]`)).not.toHaveAttribute("aria-pressed", "true");
  await dispatchCapturedPointerUp(page, pointerId, { x: retreatStart.x + 1.2, y: retreatStart.y + 1.6 });
  await page.mouse.up();
  await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(2);
  await expect(page.locator(`[data-canvas-element-id="${greaterThanThresholdShape.id}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
});

test("focused canvas Enter creates accessible viewport-centered shapes", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const status = page.locator('.canvas-accessibility-status[role="status"]');
  let expectedShapeCount = 1;
  let expectedKeyboardSequence = 0;
  let lastCreatedId = "";

  for (const zoom of [50, 100, 200]) {
    await setZoom(page, canvas, zoom);
    if (zoom === 100) await panCanvas(page, canvas, { x: 90, y: 55 });
    for (const shape of Object.keys(TOOL_NAMES) as ShapeName[]) {
      await page.getByRole("button", { name: TOOL_NAMES[shape] }).click();
      await expect(canvas).toHaveAttribute("aria-keyshortcuts", "Enter");
      await expect(canvas).toHaveAccessibleDescription(
        `${shapeLabel(shape)} tool selected. Drag to draw, or press Enter to add a default ${shape} in the current viewport.`,
      );
      await canvas.focus();
      await settleAndResetCounts(page);
      await page.keyboard.press("Enter");
      expectedKeyboardSequence += 1;
      expectedShapeCount += 1;

      await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(expectedShapeCount);
      await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
      const created = await newestShape(page);
      if (!created) throw new Error("Keyboard-created shape was unavailable.");
      lastCreatedId = created.id;
      expect(created.shape).toBe(shape);
      expect({ height: created.height, width: created.width }).toEqual(DEFAULT_SHAPE_SIZES[shape]);
      const createdLocator = page.locator(`[data-canvas-element-id="${created.id}"]`);
      await expect(createdLocator).toHaveAttribute("aria-pressed", "true");
      await expect(canvas).toBeFocused();
      await expect(page.getByRole("button", { name: "Select (V / 1)" })).toHaveAttribute("aria-pressed", "true");
      await expect(canvas).not.toHaveAttribute("aria-keyshortcuts");
      await expect(status).toHaveText(`Keyboard shape ${expectedKeyboardSequence} created. ${shapeLabel(shape)} was placed in the current viewport. Switched to Select.`);
      const canvasBounds = await requiredBounds(canvas, "canvas");
      const createdBounds = await requiredBounds(createdLocator, "keyboard-created shape");
      expect(createdBounds.x + createdBounds.width / 2).toBeCloseTo(canvasBounds.x + canvasBounds.width / 2, 0);
      expect(createdBounds.y + createdBounds.height / 2).toBeCloseTo(canvasBounds.y + canvasBounds.height / 2, 0);
    }
  }

  const lock = page.locator("[data-tool-lock]");
  await lock.click();
  await page.getByRole("button", { name: TOOL_NAMES.diamond }).click();
  await canvas.focus();
  await settleAndResetCounts(page);
  await page.keyboard.press("Enter");
  expectedKeyboardSequence += 1;
  expectedShapeCount += 1;
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  lastCreatedId = (await newestShape(page))?.id ?? "";
  await expect(page.getByRole("button", { name: TOOL_NAMES.diamond })).toHaveAttribute("aria-pressed", "true");
  await expect(status).toHaveText(`Keyboard shape ${expectedKeyboardSequence} created. Diamond was placed in the current viewport. Tool lock kept Diamond active.`);

  await settleAndResetCounts(page);
  await page.evaluate(() => {
    const statusNode = document.querySelector('.canvas-accessibility-status[role="status"]');
    if (!statusNode) throw new Error("Canvas status was unavailable.");
    (window as unknown as { __shapeKeyboardStatusMutations: number }).__shapeKeyboardStatusMutations = 0;
    new MutationObserver(() => {
      (window as unknown as { __shapeKeyboardStatusMutations: number }).__shapeKeyboardStatusMutations += 1;
    }).observe(statusNode, { characterData: true, childList: true, subtree: true });
  });
  await page.keyboard.press("Enter");
  expectedKeyboardSequence += 1;
  expectedShapeCount += 1;
  lastCreatedId = (await newestShape(page))?.id ?? "";
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  await expect(status).toHaveText(`Keyboard shape ${expectedKeyboardSequence} created. Diamond was placed in the current viewport. Tool lock kept Diamond active.`);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __shapeKeyboardStatusMutations: number }
  ).__shapeKeyboardStatusMutations)).toBeGreaterThan(0);

  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(expectedShapeCount - 1);
  await page.keyboard.press("Control+y");
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(expectedShapeCount);
  await expect.poll(async () => (await workspaceElements(page)).some((element) => element.id === lastCreatedId)).toBe(true);
  await page.reload();
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(expectedShapeCount);
});

test("keyboard shape creation guards text, modal, modified, repeated, and unsafe contexts", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const status = page.locator('.canvas-accessibility-status[role="status"]');
  await page.getByRole("button", { name: TOOL_NAMES.rectangle }).click();
  await canvas.focus();
  await settleAndResetCounts(page);

  await expect(canvas).toHaveAttribute("aria-keyshortcuts", "Enter");
  await expect(canvas).toHaveAccessibleDescription(
    "Rectangle tool selected. Drag to draw, or press Enter to add a default rectangle in the current viewport.",
  );
  await page.keyboard.press("Control+f");
  await expect(page.getByRole("button", { name: "Close search", exact: true })).toBeVisible();
  await expect(canvas).not.toHaveAttribute("aria-keyshortcuts");
  await expect(canvas).not.toHaveAttribute("aria-describedby");
  await page.getByRole("button", { name: "Close search", exact: true }).click();
  await expect(canvas).toHaveAttribute("aria-keyshortcuts", "Enter");
  await expect(canvas).toHaveAccessibleDescription(
    "Rectangle tool selected. Drag to draw, or press Enter to add a default rectangle in the current viewport.",
  );
  await canvas.focus();

  for (const init of [
    { isComposing: true },
    { repeat: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
  ]) await dispatchCanvasEnter(canvas, init);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "shape-keyboard-guard-input";
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    input.remove();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.id = "shape-keyboard-guard-editor";
    document.body.append(editor);
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    editor.remove();
  });
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await page.setViewportSize({ width: 760, height: 700 });
  await page.getByRole("button", { name: "AI assistant" }).click();
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toBeVisible();
  await dispatchCanvasEnter(canvas, {});
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await page.locator(".assistant-close-button").click();
  await page.setViewportSize({ width: 1440, height: 900 });

  const canvasBounds = await requiredBounds(canvas, "canvas");
  await persistViewportCenter(page, canvasBounds, { x: 1_000_000 - 20, y: 1_000_000 - 20 });
  await page.reload();
  const reloadedCanvas = page.getByRole("tabpanel");
  await page.getByRole("button", { name: TOOL_NAMES.rectangle }).click();
  await reloadedCanvas.focus();
  await settleAndResetCounts(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const edgeShape = await newestShape(page);
  expect(Number(edgeShape?.x) + Number(edgeShape?.width)).toBeLessThanOrEqual(1_000_000);
  expect(Number(edgeShape?.y) + Number(edgeShape?.height)).toBeLessThanOrEqual(1_000_000);
  await expect(status).toHaveText("Keyboard shape 1 created. Rectangle was placed in the current viewport. Switched to Select.");

  await persistViewportCenter(page, await requiredBounds(reloadedCanvas, "canvas"), { x: 1_000_500, y: 0 });
  await page.reload();
  const unsafeCanvas = page.getByRole("tabpanel");
  await page.getByRole("button", { name: TOOL_NAMES.ellipse }).click();
  await unsafeCanvas.focus();
  await settleAndResetCounts(page);
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("Keyboard shape 1 was not created. Ellipse is unavailable at the current canvas position.");
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  const unsafeBounds = await requiredBounds(unsafeCanvas, "unsafe canvas");
  await page.getByRole("button", { name: TOOL_NAMES.ellipse }).click();
  await settleAndResetCounts(page);
  await drag(
    page,
    { x: unsafeBounds.x + unsafeBounds.width / 2 - 20, y: unsafeBounds.y + unsafeBounds.height / 2 - 20 },
    { x: unsafeBounds.x + unsafeBounds.width / 2, y: unsafeBounds.y + unsafeBounds.height / 2 },
  );
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(2);
  await expect(status).toHaveText(
    "Shape gesture 1 was not created. Ellipse needs horizontal and vertical size within the available canvas area.",
  );
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(2);

  await persistViewportCenter(page, await requiredBounds(unsafeCanvas, "unsafe canvas"), { x: 0, y: 0 });
  await page.reload();
  const recoveredCanvas = page.getByRole("tabpanel");
  const recoveredBounds = await requiredBounds(recoveredCanvas, "recovered canvas");
  await page.getByRole("button", { name: TOOL_NAMES.rectangle }).click();
  await settleAndResetCounts(page);
  await drag(
    page,
    { x: recoveredBounds.x + 400, y: recoveredBounds.y + 240 },
    { x: recoveredBounds.x + 440, y: recoveredBounds.y + 270 },
  );
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(3);
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const recoveredShapeId = (await newestShape(page))?.id;
  if (!recoveredShapeId) throw new Error("Recovered pointer shape was unavailable.");
  await page.reload();
  await expect(page.locator(`[data-canvas-element-id="${recoveredShapeId}"]`)).toBeVisible();
});

test("reverse, Shift, and Alt drags preserve geometry while tool lock remains explicit", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");

  await page.getByRole("button", { name: TOOL_NAMES.rectangle }).click();
  await settleAndResetCounts(page);
  await drag(
    page,
    { x: canvasBounds.x + 500, y: canvasBounds.y + 320 },
    { x: canvasBounds.x + 430, y: canvasBounds.y + 270 },
  );
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const rectangle = await newestShape(page);
  expect({ height: rectangle?.height, width: rectangle?.width }).toEqual({ height: 50, width: 70 });

  await page.getByRole("button", { name: TOOL_NAMES.ellipse }).click();
  await settleAndResetCounts(page);
  await page.keyboard.down("Shift");
  await drag(
    page,
    { x: canvasBounds.x + 610, y: canvasBounds.y + 280 },
    { x: canvasBounds.x + 670, y: canvasBounds.y + 315 },
  );
  await page.keyboard.up("Shift");
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const ellipse = await newestShape(page);
  expect({ height: ellipse?.height, width: ellipse?.width }).toEqual({ height: 60, width: 60 });

  const lock = page.locator("[data-tool-lock]");
  await lock.click();
  await page.getByRole("button", { name: TOOL_NAMES.diamond }).click();
  await settleAndResetCounts(page);
  await page.keyboard.down("Alt");
  await drag(
    page,
    { x: canvasBounds.x + 780, y: canvasBounds.y + 300 },
    { x: canvasBounds.x + 820, y: canvasBounds.y + 330 },
  );
  await page.keyboard.up("Alt");
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const diamond = await newestShape(page);
  expect({ height: diamond?.height, width: diamond?.width }).toEqual({ height: 60, width: 80 });
  await expect(page.getByRole("button", { name: TOOL_NAMES.diamond })).toHaveAttribute("aria-pressed", "true");
});

test("cancellation paths restore selection without writes and Line and Arrow keep their contracts", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  const existing = page.locator('[data-canvas-element-id="existing-shape"]');
  const start = { x: canvasBounds.x + 520, y: canvasBounds.y + 430 };
  const end = { x: start.x + 90, y: start.y + 60 };

  for (const cancellation of ["Escape", "pointercancel", "lostpointercapture", "blur"] as const) {
    await page.getByRole("button", { name: "Select (V / 1)" }).click();
    await existing.focus();
    await existing.press("Enter");
    const tool = page.getByRole("button", { name: TOOL_NAMES.rectangle });
    await tool.click();
    await settleAndResetCounts(page);
    const pointerId = await beginCapturedDrag(page, start, end);
    await expect(page.locator(".primitive-authoring-preview")).toHaveCount(1);
    if (cancellation === "Escape") await page.keyboard.press("Escape");
    else if (cancellation === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else await dispatchCapturedTermination(page, pointerId, cancellation, end);
    await page.mouse.up();

    await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
    await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
    await expect(existing).toHaveAttribute("aria-pressed", "true");
    if (cancellation === "Escape") {
      await expect(page.getByRole("button", { name: "Select (V / 1)" })).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => (await counts(page)).apply).toBe(0);
    } else {
      await expect(tool).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
    }
  }

  await page.getByRole("button", { name: TOOL_NAMES.ellipse }).click();
  await settleAndResetCounts(page);
  await beginCapturedDrag(page, start, end);
  await page.getByRole("button", { name: "Line (L / 6)" }).evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
  await expect.poll(async () => (await counts(page)).apply).toBe(0);

  await page.getByRole("button", { name: TOOL_NAMES.diamond }).click();
  await settleAndResetCounts(page);
  await beginCapturedDrag(page, start, end);
  const tabs = page.getByRole("tablist", { name: "Open pages" }).getByRole("tab");
  await tabs.nth(1).evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(async () => (await counts(page)).apply).toBe(0);
  await tabs.nth(0).click();

  await page.getByRole("button", { name: TOOL_NAMES.rectangle }).click();
  await settleAndResetCounts(page);
  const chrome = page.getByRole("complementary", { name: "Drawing properties" }).getByRole("button").first();
  const chromeBounds = await requiredBounds(chrome, "drawing property control");
  await drag(
    page,
    { x: chromeBounds.x + chromeBounds.width / 2, y: chromeBounds.y + chromeBounds.height / 2 },
    end,
  );
  await expect(page.locator(".primitive-authoring-preview")).toHaveCount(0);
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(1);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await page.getByRole("button", { name: "Line (L / 6)" }).click();
  await settleAndResetCounts(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(page.locator(".primitive-authoring-preview")).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const line = await newestConnector(page);
  expect(line?.style).toMatchObject({ endArrowhead: "none", startArrowhead: "none" });
  expect(Number((line?.end as { x?: number } | undefined)?.x) - Number((line?.start as { x?: number } | undefined)?.x)).toBe(160);

  await page.getByRole("button", { name: "Arrow (A / 5)" }).click();
  await settleAndResetCounts(page);
  await page.mouse.click(start.x, start.y);
  await expect(page.locator(".arrow-authoring-preview")).toHaveCount(1);
  await page.mouse.click(end.x, end.y);
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const arrow = await newestConnector(page);
  expect(arrow?.style).toMatchObject({ endArrowhead: "arrow", startArrowhead: "none" });
});

test("a canceled pending object drag leaves its scene record and persistence untouched", async ({ page }) => {
  await installPendingDragObjects(page);
  const movable = page.locator('[data-canvas-element-id="drag-source"]');
  const beforeBounds = await requiredBounds(movable, "movable shape before cancellation");
  const start = shapeHitPoint(beforeBounds);
  const beforeScene = await workspaceElement(page, "drag-source");
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await settleAndResetCounts(page);

  const pointerId = await beginCapturedDrag(
    page,
    start,
    { x: start.x + 36, y: start.y + 24 },
  );
  await expect(page.locator("body")).toHaveClass(/is-interacting/);
  await dispatchCapturedTermination(page, pointerId, "pointercancel", {
    x: start.x + 36,
    y: start.y + 24,
  });
  await page.mouse.up();

  await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
  await expect.poll(() => workspaceElement(page, "drag-source")).toEqual(beforeScene);
  await expect.poll(() => counts(page)).toMatchObject({ apply: 0 });
  await expect(movable).toHaveAttribute("aria-pressed", "true");
});

test("pointerup starts a pending object drag only after the screen threshold", async ({ page }) => {
  await installPendingDragObjects(page);
  const movable = page.locator('[data-canvas-element-id="drag-source"]');
  const before = await workspaceElement(page, "drag-source");
  const start = shapeHitPoint(await requiredBounds(movable, "movable shape"));
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await settleAndResetCounts(page);

  await releasePendingObjectDragWithoutMove(page, start, { x: start.x + 2, y: start.y + 1 });
  await expect.poll(() => workspaceElement(page, "drag-source")).toEqual(before);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  const canvasBounds = await requiredBounds(page.getByRole("tabpanel"), "canvas");
  await page.mouse.click(canvasBounds.x + canvasBounds.width - 40, canvasBounds.y + canvasBounds.height - 40);
  await settleAndResetCounts(page);

  await releasePendingObjectDragWithoutMove(page, start, { x: start.x + 28, y: start.y + 18 });
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const moved = await workspaceElement(page, "drag-source");
  expect(Number(moved.x)).toBeCloseTo(Number(before.x) + 28, 4);
  expect(Number(moved.y)).toBeCloseTo(Number(before.y) + 18, 4);
  await page.keyboard.press("Control+z");
  await expect.poll(() => workspaceElement(page, "drag-source")).toEqual(before);
});

test("locked objects select but never create a pending drag, movement, or scene write", async ({ page }) => {
  await installPendingDragObjects(page);
  const locked = page.locator('[data-canvas-element-id="locked-shape"]');
  const beforeScene = await workspaceElement(page, "locked-shape");
  const bounds = await requiredBounds(locked, "locked shape before drag");
  const start = shapeHitPoint(bounds);
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await settleAndResetCounts(page);

  await drag(page, start, { x: start.x + 48, y: start.y + 32 });

  await expect(locked).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
  await expect.poll(() => workspaceElement(page, "locked-shape")).toEqual(beforeScene);
  await expect.poll(() => counts(page)).toMatchObject({ apply: 0 });
});

test("additive object clicks add to selection without beginning a drag or scene write", async ({ page }) => {
  await installPendingDragObjects(page);
  const first = page.locator('[data-canvas-element-id="drag-source"]');
  const second = page.locator('[data-canvas-element-id="additive-shape"]');
  const beforeFirst = await workspaceElement(page, "drag-source");
  const beforeSecond = await workspaceElement(page, "additive-shape");
  const firstBounds = await requiredBounds(first, "first additive shape");
  const secondBounds = await requiredBounds(second, "second additive shape");
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await page.mouse.click(...pointValues(shapeHitPoint(firstBounds)));
  await settleAndResetCounts(page);

  await page.keyboard.down("Shift");
  await page.mouse.click(...pointValues(shapeHitPoint(secondBounds)));
  await page.keyboard.up("Shift");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".selection-frame")).toHaveCount(1);

  await expect.poll(() => workspaceElement(page, "drag-source")).toEqual(beforeFirst);
  await expect.poll(() => workspaceElement(page, "additive-shape")).toEqual(beforeSecond);
  await expect.poll(() => counts(page)).toMatchObject({ apply: 0 });
});

test("object click and double-click edit paths stay drag- and scene-write-free", async ({ page }) => {
  await installPendingDragObjects(page);
  const editable = page.locator('[data-canvas-element-id="editable-shape"]');
  const bounds = await requiredBounds(editable, "editable shape");
  const clickPoint = shapeHitPoint(bounds);
  const editPoint = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const beforeScene = await workspaceElement(page, "editable-shape");
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await settleAndResetCounts(page);

  await page.mouse.click(...pointValues(clickPoint));
  await expect(editable).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
  await expect.poll(() => counts(page)).toMatchObject({ apply: 0 });

  await page.mouse.dblclick(...pointValues(editPoint));
  await expect(page.getByRole("textbox", { name: "Edit text inside rectangle" })).toBeFocused();
  await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
  await expect.poll(() => workspaceElement(page, "editable-shape")).toEqual(beforeScene);
  await expect.poll(() => counts(page)).toMatchObject({ apply: 0 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Edit text inside rectangle" })).toHaveCount(0);
  await expect.poll(() => counts(page)).toMatchObject({ apply: 0 });
});

async function drag(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 3 });
  await page.mouse.up();
}

async function dispatchCanvasEnter(
  canvas: Locator,
  init: Readonly<Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "isComposing" | "metaKey" | "repeat" | "shiftKey">>>,
) {
  await canvas.evaluate((element, eventInit) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", ...eventInit }));
  }, init);
}

async function panCanvas(page: Page, canvas: Locator, delta: { x: number; y: number }) {
  const bounds = await requiredBounds(canvas, "canvas");
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await canvas.focus();
  await page.keyboard.down("Space");
  await drag(page, start, { x: start.x + delta.x, y: start.y + delta.y });
  await page.keyboard.up("Space");
  await page.waitForTimeout(600);
  await resetCounts(page);
}

async function persistViewportCenter(
  page: Page,
  canvasBounds: Readonly<{ height: number; width: number }>,
  center: Readonly<{ x: number; y: number }>,
) {
  await page.evaluate(({ canvasBounds, center, storageKey }) => {
    const runtime = window as unknown as {
      __shapeDragIgnoreSessionWrites?: number;
      __shapeDragWorkspace?: {
        sessionState?: { pageViewports?: Record<string, unknown> };
      };
    };
    const workspace = runtime.__shapeDragWorkspace ?? JSON.parse(localStorage.getItem(storageKey) ?? "{}") as {
      sessionState?: { pageViewports?: Record<string, unknown> };
    };
    workspace.sessionState ??= {};
    workspace.sessionState.pageViewports ??= {};
    workspace.sessionState.pageViewports["page-one"] = {
      panOffset: {
        x: canvasBounds.width / 2 - center.x,
        y: canvasBounds.height / 2 - center.y,
      },
      zoomLevel: 1,
    };
    runtime.__shapeDragWorkspace = workspace;
    runtime.__shapeDragIgnoreSessionWrites = 10;
    localStorage.setItem(storageKey, JSON.stringify(workspace));
  }, { canvasBounds, center, storageKey: STORAGE_KEY });
}

function shapeLabel(shape: ShapeName) {
  return shape === "rectangle" ? "Rectangle" : shape === "ellipse" ? "Ellipse" : "Diamond";
}

async function beginCapturedDrag(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.evaluate(() => {
    document.addEventListener("pointerdown", (event) => {
      document.body.dataset.shapeDragPointerId = String(event.pointerId);
    }, { capture: true, once: true });
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 3 });
  const pointerId = Number(await page.locator("body").getAttribute("data-shape-drag-pointer-id"));
  if (!Number.isFinite(pointerId)) throw new Error("Shape drag pointer id was unavailable.");
  return pointerId;
}

async function releaseCapturedWithoutMove(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  await page.evaluate(() => {
    document.addEventListener("pointerdown", (event) => {
      document.body.dataset.shapeDragPointerId = String(event.pointerId);
    }, { capture: true, once: true });
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const pointerId = Number(await page.locator("body").getAttribute("data-shape-drag-pointer-id"));
  if (!Number.isFinite(pointerId)) throw new Error("Shape drag pointer id was unavailable.");
  await dispatchCapturedPointerUp(page, pointerId, end);
  await page.mouse.up();
}

async function releasePendingObjectDragWithoutMove(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  await page.evaluate(() => {
    document.addEventListener("pointerdown", (event) => {
      document.body.dataset.shapeDragPointerId = String(event.pointerId);
    }, { capture: true, once: true });
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const pointerId = Number(await page.locator("body").getAttribute("data-shape-drag-pointer-id"));
  if (!Number.isFinite(pointerId)) throw new Error("Shape drag pointer id was unavailable.");
  await page.getByRole("tabpanel").evaluate((target, { end, pointerId }) => {
    target.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      clientX: end.x,
      clientY: end.y,
      pointerId,
    }));
  }, { end, pointerId });
  await page.mouse.up();
}

async function dispatchCapturedPointerUp(
  page: Page,
  pointerId: number,
  end: { x: number; y: number },
) {
  await page.evaluate(({ end, pointerId }) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .find((element) => element.hasPointerCapture(pointerId));
    if (!target) throw new Error("Captured shape target was unavailable.");
    target.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      clientX: end.x,
      clientY: end.y,
      pointerId,
    }));
  }, { end, pointerId });
}

async function dispatchCapturedTermination(
  page: Page,
  pointerId: number,
  type: "lostpointercapture" | "pointercancel",
  point: { x: number; y: number },
) {
  await page.evaluate(({ pointerId, type, point }) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .find((element) => element.hasPointerCapture(pointerId));
    if (!target) throw new Error("Captured shape target was unavailable.");
    if (type === "lostpointercapture") target.releasePointerCapture(pointerId);
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      button: 0,
      clientX: point.x,
      clientY: point.y,
      pointerId,
    }));
  }, { pointerId, type, point });
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  for (let index = 0; index < Math.abs(percent - 100) / 10; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
  await page.waitForTimeout(600);
  await resetCounts(page);
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function settleAndResetCounts(page: Page) {
  await page.waitForTimeout(600);
  await resetCounts(page);
}

async function counts(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __shapeDragCounts: { apply: number; persistence: number; session: number };
  }).__shapeDragCounts);
}

async function resetCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as {
      __shapeDragCounts: { apply: number; persistence: number; session: number };
    }).__shapeDragCounts = { apply: 0, persistence: 0, session: 0 };
  });
}

async function workspaceElements(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __shapeDragWorkspace: { elements: Array<Record<string, unknown> & { id: string; type: string }> };
  }).__shapeDragWorkspace.elements);
}

async function newestShape(page: Page) {
  return [...await workspaceElements(page)].reverse().find((element) => element.type === "shape");
}

async function newestConnector(page: Page) {
  return [...await workspaceElements(page)].reverse().find((element) => element.type === "connector");
}

function shapeHitPoint(bounds: Readonly<{ x: number; y: number; height: number }>) {
  return { x: bounds.x + 4, y: bounds.y + bounds.height / 2 };
}

function pointValues(point: Readonly<{ x: number; y: number }>): [number, number] {
  return [point.x, point.y];
}

async function workspaceElement(page: Page, id: string) {
  const element = (await workspaceElements(page)).find((candidate) => candidate.id === id);
  if (!element) throw new Error(`Workspace element ${id} was unavailable.`);
  return element;
}

async function installPendingDragObjects(page: Page) {
  await page.evaluate((storageKey) => {
    type Shape = Record<string, unknown> & { id: string };
    const runtime = window as unknown as { __shapeDragWorkspace: { elements: Shape[] } };
    const workspace = runtime.__shapeDragWorkspace;
    const template = workspace.elements.find((element) => element.id === "existing-shape");
    if (!template) throw new Error("Pending-drag shape template was unavailable.");
    workspace.elements = [
      { ...template, id: "drag-source", x: 180, y: 160, zIndex: 1 },
      { ...template, id: "additive-shape", x: 470, y: 160, zIndex: 2 },
      { ...template, id: "locked-shape", locked: true, x: 760, y: 160, zIndex: 3 },
      { ...template, id: "editable-shape", text: { content: "Editable" }, x: 240, y: 400, zIndex: 4 },
    ];
    runtime.__shapeDragWorkspace = workspace;
    localStorage.setItem(storageKey, JSON.stringify(workspace));
  }, STORAGE_KEY);
  await page.reload();
  await expect(page.getByRole("tabpanel")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-canvas-element-id="editable-shape"]')).toBeVisible();
}

async function installWorkspace(page: Page) {
  await page.addInitScript((storageKey) => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    type Workspace = {
      elements: ElementRecord[];
      folders: Array<{ id: string; name: string }>;
      isDarkMode: boolean;
      pages: Array<{ folderId: string; id: string; isBookmarked: boolean; revision: number; title: string }>;
      sessionState: Record<string, unknown>;
      warnings: string[];
    };
    const initialWorkspace = (): Workspace => ({
      elements: [{
        createdAt: 1,
        height: 80,
        id: "existing-shape",
        locked: false,
        opacity: 1,
        pageId: "page-one",
        rotation: 0,
        shape: "rectangle",
        style: {
          fillColor: null,
          roughness: 0.5,
          roundness: 0.6,
          seed: 31,
          strokeColor: { kind: "theme", token: "foreground" },
          strokeStyle: "solid",
          strokeWidth: 2,
        },
        type: "shape",
        updatedAt: 1,
        width: 120,
        x: 120,
        y: 120,
        zIndex: 0,
      }],
      folders: [],
      isDarkMode: false,
      pages: [
        { folderId: "", id: "page-one", isBookmarked: false, revision: 0, title: "Shape drag" },
        { folderId: "", id: "page-two", isBookmarked: false, revision: 0, title: "Cancellation page" },
      ],
      sessionState: {
        openPageTabIds: ["page-one", "page-two"],
        pageViewports: {
          "page-one": { panOffset: { x: 0, y: 0 }, zoomLevel: 1 },
          "page-two": { panOffset: { x: 0, y: 0 }, zoomLevel: 1 },
        },
        selectedFolderId: "",
        selectedPageId: "page-one",
      },
      warnings: [],
    });
    const read = () => {
      const stored = localStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) as Workspace : initialWorkspace();
    };
    let workspace = read();
    localStorage.setItem(storageKey, JSON.stringify(workspace));
    const persist = () => localStorage.setItem(storageKey, JSON.stringify(workspace));
    const runtime = window as unknown as {
      __shapeDragCounts: { apply: number; persistence: number; session: number };
      __shapeDragIgnoreSessionWrites: number;
      __shapeDragWorkspace: Workspace;
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.__shapeDragCounts = { apply: 0, persistence: 0, session: 0 };
    runtime.__shapeDragIgnoreSessionWrites = 0;
    runtime.__shapeDragWorkspace = workspace;
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") {
        return { databasePath: "shape-drag.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      }
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__shapeDragCounts.apply += 1;
        runtime.__shapeDragCounts.persistence += 1;
        const batch = args.batch as {
          deletedElementIds: string[];
          pageId: string;
          upserts: ElementRecord[];
        };
        for (const element of batch.upserts) {
          if (element.type !== "shape") continue;
          const x = Number(element.x);
          const y = Number(element.y);
          const width = Number(element.width);
          const height = Number(element.height);
          if (
            !Number.isFinite(x)
            || !Number.isFinite(y)
            || !Number.isFinite(width)
            || !Number.isFinite(height)
            || Math.abs(x) > 1_000_000
            || Math.abs(y) > 1_000_000
            || width <= 0
            || width > 1_000_000
            || height <= 0
            || height > 1_000_000
            || Math.abs(x + width) > 1_000_000
            || Math.abs(y + height) > 1_000_000
          ) throw new Error("shape geometry exceeds the persistence envelope");
        }
        const deleted = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements
          .filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id))
          .map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) {
          if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        }
        const storedPage = workspace.pages.find((candidate) => candidate.id === batch.pageId);
        if (storedPage) storedPage.revision += 1;
        persist();
        return { newRevision: storedPage?.revision ?? 0, pageId: batch.pageId };
      }
      if (command === "save_session_state") {
        if (runtime.__shapeDragIgnoreSessionWrites > 0) {
          runtime.__shapeDragIgnoreSessionWrites -= 1;
          return undefined;
        }
        runtime.__shapeDragCounts.session += 1;
        runtime.__shapeDragCounts.persistence += 1;
        workspace.sessionState = args.state as Record<string, unknown>;
        persist();
        return undefined;
      }
      if (command === "load_asset" || command === "save_asset") throw new Error(`Unexpected ${command}`);
      return undefined;
    } };
  }, STORAGE_KEY);
}
