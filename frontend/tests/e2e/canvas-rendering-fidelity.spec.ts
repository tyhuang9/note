import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("keeps seeded RoughJS preview and committed geometry identical across zoom, theme, and modifiers", async ({ page }, testInfo) => {
  const canvas = page.getByRole("tabpanel");
  const properties = page.getByRole("complementary", { name: "Drawing properties" });

  const cases = [
    { alt: false, dark: false, selector: ".primitive-shape", shift: true, tool: "rectangle", zoom: 50 },
    { alt: true, dark: true, selector: ".primitive-shape", shift: false, tool: "ellipse", zoom: 100 },
    { alt: true, dark: false, selector: ".primitive-shape", shift: true, tool: "diamond", zoom: 200 },
    { alt: false, dark: true, selector: ".primitive-connector", shift: true, tool: "line", zoom: 100 },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    await setDarkMode(page, scenario.dark);
    await setZoom(page, canvas, scenario.zoom);
    await page.locator(`[data-tool="${scenario.tool}"]`).click();
    await properties.getByRole("button", { name: "Thick stroke" }).click();
    await properties.getByRole("button", { name: "Dashed stroke" }).click();
    await properties.getByRole("button", { name: "Cartoonist" }).click();
    const bounds = await requiredBounds(canvas, "canvas");
    const start = { x: bounds.x + 280 + index * 80, y: bounds.y + 260 + index * 70 };
    await page.mouse.move(start.x, start.y);
    if (scenario.shift) await page.keyboard.down("Shift");
    if (scenario.alt) await page.keyboard.down("Alt");
    await page.mouse.down();
    await page.mouse.move(start.x + 120, start.y + 80, { steps: 3 });

    const preview = page.locator(".primitive-authoring-preview");
    await expect(preview).toBeVisible();
    const before = await svgSnapshot(preview);
    const beforePixels = await preview.screenshot();
    await testInfo.attach(`preview-${scenario.zoom}-${scenario.dark ? "dark" : "light"}.png`, { body: beforePixels, contentType: "image/png" });
    await page.mouse.up();
    if (scenario.alt) await page.keyboard.up("Alt");
    if (scenario.shift) await page.keyboard.up("Shift");

    const committed = page.locator(`[data-canvas-element-id="${before.elementId}"] ${scenario.selector}`);
    await expect(committed).toBeVisible();
    const after = await svgSnapshot(committed);
    expect(after.seed).toBe(before.seed);
    expect(after.paths).toEqual(before.paths);
    expect(after.transforms).toEqual(before.transforms);
    expect(after.linecaps).toEqual(before.linecaps);
    expect(after.rect.x).toBeCloseTo(before.rect.x, 0);
    expect(after.rect.y).toBeCloseTo(before.rect.y, 0);
    expect(after.rect.width).toBeCloseTo(before.rect.width, 0);
    expect(after.rect.height).toBeCloseTo(before.rect.height, 0);
    await testInfo.attach(`committed-${scenario.zoom}-${scenario.dark ? "dark" : "light"}.png`, {
      body: await committed.screenshot(),
      contentType: "image/png",
    });
  }
});

test("uses tool-specific native cursors and localized canvas keyboard focus", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const cursors = {
    select: "default",
    hand: "grab",
    text: "text",
    rectangle: "crosshair",
    ellipse: "crosshair",
    diamond: "crosshair",
    line: "crosshair",
    arrow: "crosshair",
    pen: "crosshair",
    highlighter: "crosshair",
    eraser: "cell",
  } as const;

  for (const [tool, cursor] of Object.entries(cursors)) {
    await page.locator(`[data-tool="${tool}"]`).click();
    await expect(canvas).toHaveAttribute("data-active-tool", tool);
    expect(await canvas.evaluate((node) => getComputedStyle(node).cursor)).toBe(cursor);
  }

  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-tool="image"]').click();
  await chooser;
  await expect(canvas).toHaveAttribute("data-active-tool", "image");
  expect(await canvas.evaluate((node) => getComputedStyle(node).cursor)).toBe("copy");

  await page.locator('[data-tool="select"]').click();
  await canvas.focus();
  const canvasFocus = await canvas.evaluate((node) => ({
    borderWidth: getComputedStyle(node).borderTopWidth,
    outlineStyle: getComputedStyle(node).outlineStyle,
    outlineWidth: getComputedStyle(node).outlineWidth,
  }));
  expect(canvasFocus.borderWidth).toBe("0px");
  expect(canvasFocus.outlineStyle).toBe("none");
  const activeTool = page.locator('.canvas-tool-palette [data-tool="select"]');
  await activeTool.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(activeTool).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();

  await page.keyboard.down("Space");
  expect(await canvas.evaluate((node) => getComputedStyle(node).cursor)).toBe("grab");
  const bounds = await requiredBounds(canvas, "canvas");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(canvas).toHaveClass(/is-panning/);
  expect(await canvas.evaluate((node) => getComputedStyle(node).cursor)).toBe("grabbing");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(canvas).not.toHaveAttribute("data-temporary-hand");
  await expect(canvas).not.toHaveClass(/is-panning/);
  expect(await canvas.evaluate((node) => getComputedStyle(node).cursor)).toBe("default");
  await page.mouse.up();
  await page.keyboard.up("Space");

  await page.locator('[data-tool="diamond"]').click();
  const diamondStart = { x: bounds.x + 320, y: bounds.y + 320 };
  await page.mouse.move(diamondStart.x, diamondStart.y);
  await page.mouse.down();
  await page.mouse.move(diamondStart.x + 140, diamondStart.y + 100, { steps: 4 });
  await page.mouse.up();
  const diamond = page.getByRole("button", {
    name: "Select and move diamond shape. Press F2 to edit contained text.",
  });
  await expect(diamond).toBeVisible();
  const diamondId = await diamond.getAttribute("data-canvas-element-id");
  if (!diamondId) throw new Error("Diamond id was unavailable.");
  const diamondBounds = await requiredBounds(diamond, "diamond");

  await page.locator('[data-tool="arrow"]').click();
  await page.mouse.click(diamondBounds.x + diamondBounds.width - 1, diamondBounds.y + diamondBounds.height / 2);
  const targetHighlight = page.locator(`[data-connector-target-id="${diamondId}"]`);
  await expect(targetHighlight).toBeVisible();
  await expect(targetHighlight).toHaveAttribute("aria-hidden", "true");
  await expect(targetHighlight).toHaveAttribute("data-connector-binding-state", "snapped");
  await expect(page.locator('[role="status"].canvas-accessibility-status')).toHaveText(
    "Arrow start bound. Choose an end point.",
  );
  const targetHighlightBounds = await requiredBounds(targetHighlight, "whole-object diamond target highlight");
  await page.mouse.click(
    Math.min(bounds.x + bounds.width - 40, targetHighlightBounds.x + targetHighlightBounds.width + 220),
    targetHighlightBounds.y + targetHighlightBounds.height / 2,
  );
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await expect(arrow).toBeVisible();
  await page.locator('[data-tool="select"]').click();
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  const startHandleBounds = await requiredBounds(startHandle, "diamond-bound connector start");
  const resolvedStart = await resolvedConnectorEndpointScreen(page, arrow, "start");
  expect(Math.hypot(
    startHandleBounds.x + startHandleBounds.width / 2 - resolvedStart.x,
    startHandleBounds.y + startHandleBounds.height / 2 - resolvedStart.y,
  )).toBeLessThanOrEqual(2);
});

test("keeps Canvas focus visually neutral while preserving keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });

  const canvas = page.getByRole("tabpanel");
  const activeTool = page.locator('.canvas-tool-palette [data-tool="select"]');
  await expect(canvas).toHaveAttribute("role", "tabpanel");
  const canvasId = await canvas.getAttribute("id");
  const labelledBy = await canvas.getAttribute("aria-labelledby");
  if (!canvasId || !labelledBy) throw new Error("Canvas tab ownership attributes were unavailable.");
  const tab = page.locator(`[id="${labelledBy}"]`);
  await expect(canvas).toHaveAttribute("aria-labelledby", labelledBy);
  await expect(canvas).toHaveAccessibleName(/\S+/);
  await expect(canvas).toHaveAttribute("tabindex", "0");
  await expect(tab).toHaveAttribute("role", "tab");
  await expect(tab).toHaveAttribute("aria-controls", canvasId);

  for (const dark of [false, true]) {
    await setDarkMode(page, dark);
    for (const zoom of [50, 100, 200]) {
      await setZoom(page, canvas, zoom);
      await activeTool.focus();
      const unfocused = await canvasPresentation(canvas);
      await page.keyboard.press("Shift+Tab");
      await expect(canvas).toBeFocused();
      await expect(page.locator("[data-canvas-focus-indicator]")).toHaveCount(0);
      await expect(page.getByText("Canvas focused", { exact: true })).toHaveCount(0);
      expect(await canvasPresentation(canvas)).toEqual(unfocused);

      await page.keyboard.press("Tab");
      await expect(activeTool).toBeFocused();
      const selectFocus = await activeTool.evaluate((node) => ({
        outlineStyle: getComputedStyle(node).outlineStyle,
        outlineWidth: getComputedStyle(node).outlineWidth,
      }));
      expect(selectFocus.outlineStyle).toBe("solid");
      expect(Number.parseFloat(selectFocus.outlineWidth)).toBeGreaterThan(0);
    }
  }
});

test("uses genuine offscreen navigation without replacing Canvas keyboard focus", async ({ page }) => {
  await installOffscreenNavigationWorkspace(page);
  await page.goto("/");

  const canvas = page.getByRole("tabpanel");
  const activeTool = page.locator('.canvas-tool-palette [data-tool="select"]');
  const offscreenButton = page.getByRole("button", { name: "1 textbox offscreen east" });
  const textbox = page.locator('[data-canvas-element-id="offscreen-text"]');
  const textboxHeader = textbox.locator(".text-block-header");

  await expect(canvas).toBeVisible();
  await expect(offscreenButton).toBeVisible();
  await expect(offscreenButton).toHaveJSProperty("tabIndex", 0);
  await activeTool.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();

  await offscreenButton.focus();
  await expect(offscreenButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(textbox).toBeVisible();
  await expect(offscreenButton).toHaveCount(0);
  expect(await isOnscreen(textbox, canvas)).toBe(true);
  await expect(textboxHeader).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Send to back" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(textboxHeader).toBeFocused();
  await expect(page.locator("[data-canvas-focus-indicator]")).toHaveCount(0);
  await expect(page.getByText("Canvas focused", { exact: true })).toHaveCount(0);

  await activeTool.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();
  await canvas.focus();
  const focusedCanvas = await canvasPresentation(canvas);
  await activeTool.focus();
  expect(focusedCanvas).toEqual(await canvasPresentation(canvas));
});

async function svgSnapshot(locator: Locator) {
  return locator.evaluate((svg) => {
    const rect = (svg.querySelector("g") ?? svg).getBoundingClientRect();
    return {
      elementId: svg.getAttribute("data-element-id") ?? svg.closest<HTMLElement>("[data-canvas-element-id]")?.dataset.canvasElementId ?? "",
      linecaps: Array.from(svg.querySelectorAll("g")).map((node) => node.getAttribute("stroke-linecap")),
      paths: Array.from(svg.querySelectorAll("path")).map((node) => node.getAttribute("d")),
      rect: { height: rect.height, width: rect.width, x: rect.x, y: rect.y },
      seed: svg.getAttribute("data-seed"),
      transforms: Array.from(svg.querySelectorAll("g")).map((node) => node.getAttribute("transform")),
    };
  });
}

async function setDarkMode(page: Page, dark: boolean) {
  const toggle = page.getByRole("button", { name: "Dark mode" });
  if ((await toggle.getAttribute("aria-pressed")) !== String(dark)) await toggle.click();
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  for (let index = 0; index < Math.abs(percent - 100) / 10; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function canvasPresentation(canvas: Locator) {
  return canvas.evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      boxShadow: style.boxShadow,
      filter: style.filter,
      height: rect.height,
      opacity: style.opacity,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };
  });
}

async function isOnscreen(locator: Locator, canvas: Locator) {
  return locator.evaluate((node, canvasElement) => {
    const rect = node.getBoundingClientRect();
    const canvasRect = canvasElement.getBoundingClientRect();
    return rect.left < canvasRect.right
      && rect.right > canvasRect.left
      && rect.top < canvasRect.bottom
      && rect.bottom > canvasRect.top;
  }, await canvas.elementHandle());
}

async function installOffscreenNavigationWorkspace(page: Page) {
  await page.addInitScript(() => {
    const workspace = {
      elements: [{
        backgroundMode: "surface",
        content: "Offscreen destination",
        createdAt: 1,
        height: 96,
        id: "offscreen-text",
        locked: false,
        opacity: 1,
        pageId: "offscreen-page",
        rotation: 0,
        type: "text",
        updatedAt: 1,
        width: 220,
        x: 10_000,
        y: 160,
        zIndex: 1,
      }],
      folders: [],
      isDarkMode: false,
      pages: [{ folderId: "", id: "offscreen-page", isBookmarked: false, revision: 0, title: "Offscreen navigation" }],
      sessionState: {
        isToolLocked: true,
        openPageTabIds: ["offscreen-page"],
        selectedFolderId: "",
        selectedPageId: "offscreen-page",
      },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "initialize_storage") {
          return { databasePath: "canvas-focus-offscreen.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        }
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
        if (command === "save_session_state") {
          workspace.sessionState = args.state as typeof workspace.sessionState;
          return;
        }
        if (command === "apply_scene_changes") return { newRevision: 1, pageId: "offscreen-page" };
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function resolvedConnectorEndpointScreen(page: Page, connector: Locator, endpoint: "start" | "end") {
  const point = await connector.evaluate((node, endpointName) => {
    const x = Number(node.getAttribute(`data-connector-${endpointName}-x`));
    const y = Number(node.getAttribute(`data-connector-${endpointName}-y`));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Resolved connector ${endpointName} point was unavailable.`);
    }
    return { x, y };
  }, endpoint);
  return modelToScreen(page, point);
}

async function modelToScreen(page: Page, point: { x: number; y: number }) {
  return page.evaluate((worldPoint) => {
    const content = document.querySelector<HTMLElement>(".canvas-content");
    if (!content) throw new Error("Canvas content was unavailable.");
    const bounds = content.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(content).transform);
    return {
      x: bounds.x + worldPoint.x * matrix.a,
      y: bounds.y + worldPoint.y * matrix.d,
    };
  }, point);
}
