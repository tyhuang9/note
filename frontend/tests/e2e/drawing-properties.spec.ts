import { expect, test } from "@playwright/test";

test("renders authoring chrome only after a live page canvas is available", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toHaveCount(0);
  await expect(page.locator('input[type="file"][accept="image/*"]')).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Drawing properties" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
  await expect(page.locator('input[type="file"][accept="image/*"]')).toHaveCount(1);
});

test("returns toolbar focus to the canvas when the last page closes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  const canvas = page.getByRole("tabpanel");
  const select = page.getByRole("button", { name: "Select (V / 1)" });
  await select.focus();
  await expect(select).toBeFocused();
  await page.getByRole("button", { name: "Close New page" }).click();

  await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toHaveCount(0);
  await expect(canvas).toHaveAccessibleName("Canvas workspace");
  await expect(canvas).toBeFocused();
});

test("returns focus to the canvas when keyboard activation closes the last page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  const canvas = page.getByRole("tabpanel");
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const opacity = page.getByRole("slider", { name: "Opacity" });
  await opacity.focus();
  await expect(opacity).toBeFocused();
  const closePage = page.getByRole("button", { name: "Close New page" });
  await closePage.focus();
  await expect(closePage).toBeFocused();
  await closePage.press("Enter");

  await expect(page.getByRole("complementary", { name: "Drawing properties" })).toHaveCount(0);
  await expect(canvas).toHaveAccessibleName("Canvas workspace");
  await expect(canvas).toBeFocused();
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("applies tool defaults, edits compatible selections, and commits opacity once", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Turn off drawing tool lock" }).click();
  await expect(page.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(properties).toBeVisible();
  await expect(properties).toContainText("rectangle defaults");
  await expect(properties.getByRole("button", { name: "Rounded corners" })).toHaveAttribute("aria-pressed", "true");
  await properties.getByRole("button", { name: "Stroke color #e03131" }).click();
  await properties.getByRole("button", { name: "Thick stroke" }).click();
  await page.mouse.click(canvasBounds.x + 390, canvasBounds.y + 310);

  const rectangleShape = page.getByLabel("rectangle shape");
  const rectangle = page.locator(".primitive-element").filter({ has: rectangleShape });
  await expect(rectangle).toHaveCount(1);
  await expect(properties).toContainText("shape");
  await expect(rectangleShape.locator('path[stroke="#e03131"]')).not.toHaveCount(0);
  await expect(rectangleShape.locator('path[stroke="#e03131"]').first()).toHaveAttribute("stroke-width", "4");

  const opacity = properties.getByRole("slider", { name: "Opacity" });
  await opacity.scrollIntoViewIfNeeded();
  const opacityBounds = await opacity.boundingBox();
  if (!opacityBounds) throw new Error("Opacity slider was not visible.");
  await page.mouse.move(opacityBounds.x + opacityBounds.width - 2, opacityBounds.y + opacityBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(opacityBounds.x + opacityBounds.width * 0.38, opacityBounds.y + opacityBounds.height / 2, { steps: 12 });
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBeLessThan(0.6);
  await page.mouse.up();
  const committedOpacity = Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity));
  expect(committedOpacity).toBeGreaterThan(0.25);
  expect(committedOpacity).toBeLessThan(0.6);

  await opacity.focus();
  await page.keyboard.press("Tab");
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBe(1);
  await page.keyboard.press("Control+y");
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBeCloseTo(committedOpacity, 2);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBe(1);
  await page.keyboard.press("Control+z");
  await expect(rectangle).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(rectangle).toHaveCount(1);
  await page.keyboard.press("Control+y");
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBeCloseTo(committedOpacity, 2);
});

test("keeps the toolbar keyboard navigable and reveals compact adjustments without shrinking targets", async ({ page }) => {
  const toolbar = page.getByRole("toolbar", { name: "Drawing tools" });
  const rectangle = page.getByRole("button", { name: "Rectangle (R / 2)" });
  const diamond = page.getByRole("button", { name: "Diamond (D / 3)" });
  await rectangle.focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Rectangle · R / 2");
  expect(await tooltip.evaluate((element) => element.parentElement === document.body)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(diamond).toBeFocused();
  await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);

  await page.setViewportSize({ width: 320, height: 640 });
  const adjustments = page.getByRole("button", { name: "Drawing properties" });
  await expect(adjustments).toHaveCount(0);
  const targetSizes = await toolbar.locator("button").evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { height: bounds.height, width: bounds.width };
  }));
  expect(targetSizes.every(({ height, width }) => height === 44 && width === 44)).toBe(true);
  expect(await toolbar.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await page.getByRole("button", { name: "Pen (P / 7)" }).click();
  await expect(adjustments).toBeVisible();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(properties).toBeHidden();
  await adjustments.click();
  await expect(properties).toBeVisible();
  await expect(properties).toHaveCSS("width", "252px");
  const compactPropertiesBounds = await properties.boundingBox();
  const compactToolbarBounds = await toolbar.boundingBox();
  expect(compactPropertiesBounds).not.toBeNull();
  expect(compactToolbarBounds).not.toBeNull();
  expect(compactPropertiesBounds!.x).toBeGreaterThanOrEqual(0);
  expect(compactPropertiesBounds!.x + compactPropertiesBounds!.width).toBeLessThanOrEqual(320);
  expect(compactToolbarBounds!.x).toBeGreaterThanOrEqual(0);
  expect(compactToolbarBounds!.x + compactToolbarBounds!.width).toBeLessThanOrEqual(320);
  expect(await page.getByRole("tabpanel").evaluate((element) => element.scrollLeft)).toBe(0);
  const darkBackground = await properties.evaluate((element) => getComputedStyle(element).backgroundColor);
  await adjustments.click();
  await expect(properties).toBeHidden();
  await expect(adjustments).toBeFocused();
  await page.getByRole("button", { name: "Dark mode" }).click();
  await adjustments.click();
  await expect(properties).toBeVisible();
  await expect.poll(async () => properties.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(darkBackground);

  await expect(toolbar.locator("button").first()).toHaveCSS("width", "44px");
  expect(await toolbar.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(toolbar).toBeInViewport({ ratio: 1 });
  await expect(properties).toBeInViewport({ ratio: 1 });

  const pen = page.getByRole("button", { name: "Pen (P / 7)" });
  await adjustments.click();
  await adjustments.focus();
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(adjustments).toHaveCount(0);
  await expect(pen).toBeFocused();

  await page.setViewportSize({ width: 320, height: 640 });
  await expect(adjustments).toBeVisible();
  await adjustments.click();
  await properties.getByRole("slider", { name: "Opacity" }).focus();
  const select = page.getByRole("button", { name: "Select (V / 1)" });
  await select.dispatchEvent("click");
  await expect(adjustments).toHaveCount(0);
  await expect(properties).toHaveCount(0);
  await expect(select).toBeFocused();
});

test("uses context-specific width presets and five curated stroke swatches", async ({ page }) => {
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await expect(properties.getByRole("group", { name: "Stroke color" }).locator("button.drawing-color-swatch")).toHaveCount(5);
  await expect(properties.getByRole("button", { name: "Thin stroke (1px)" })).toBeVisible();
  await expect(properties.getByRole("button", { name: "Thick stroke (4px)" })).toBeVisible();

  await page.getByRole("button", { name: "Pen (P / 7)" }).click();
  await expect(properties.getByRole("button", { name: "Thin stroke (2px)" })).toBeVisible();
  await expect(properties.getByRole("button", { name: "Thick stroke (8px)" })).toBeVisible();

  await page.getByRole("button", { name: "Highlighter (H)" }).click();
  await expect(properties.getByRole("button", { name: "Medium stroke (18px)" })).toBeVisible();
  await expect(properties.getByRole("button", { name: "Thick stroke (32px)" })).toBeVisible();
});

test("remembers text background choices, supports radio keys, and keeps selection history atomic", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  const surface = properties.getByRole("radio", { name: "Surface text background" });
  const transparent = properties.getByRole("radio", { name: "Transparent text background" });
  const themeToggle = page.getByRole("button", { name: "Dark mode" });
  if (await themeToggle.getAttribute("aria-pressed") === "true") await themeToggle.click();
  await expect(surface).toHaveAttribute("aria-checked", "true");
  const readRadioStyles = () => surface.evaluate((element) => {
    const style = getComputedStyle(element);
    const groupStyle = getComputedStyle(element.parentElement!);
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      groupBackground: groupStyle.backgroundColor,
    };
  });
  const lightSelected = await readRadioStyles();
  expect(contrastRatio(lightSelected.border, lightSelected.background)).toBeGreaterThanOrEqual(3);
  await surface.focus();
  await page.keyboard.press("ArrowRight");
  await expect(transparent).toBeFocused();
  await expect(transparent).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowUp");
  await expect(surface).toBeFocused();
  await expect(surface).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowDown");
  await expect(transparent).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(surface).toBeFocused();
  await page.keyboard.press("Space");
  await expect(surface).toHaveAttribute("aria-checked", "true");
  await themeToggle.click();
  const darkSelected = await readRadioStyles();
  expect(contrastRatio(darkSelected.border, darkSelected.background)).toBeGreaterThanOrEqual(3);
  expect(darkSelected.background).not.toBe(lightSelected.background);
  await themeToggle.click();
  await surface.focus();
  await page.keyboard.press("ArrowRight");
  await expect(transparent).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(transparent).toHaveAttribute("aria-checked", "true");

  await page.mouse.click(canvasBounds.x + 260, canvasBounds.y + 220);
  const firstText = page.locator(".text-block").last();
  await expect(firstText).toHaveClass(/is-transparent-background/);
  await page.keyboard.type("Transparent default");
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await firstText.locator(".text-block-header").click();
  await expect(surface).toBeVisible();
  await surface.click();
  await expect(firstText).not.toHaveClass(/is-transparent-background/);

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(firstText).toHaveClass(/is-transparent-background/);
  await page.keyboard.press("Control+y");
  await expect(firstText).not.toHaveClass(/is-transparent-background/);

  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(canvasBounds.x + 500, canvasBounds.y + 300);
  await expect(page.locator(".text-block").last()).not.toHaveClass(/is-transparent-background/);
});

test("explains locked mixed text background choices without exposing radio tab stops", async ({ page }) => {
  await page.addInitScript(() => {
    const workspace = {
      elements: [
        {
          backgroundMode: "surface", content: "Locked surface", createdAt: 1, height: 92, id: "locked-surface",
          locked: true, opacity: 1, pageId: "page", rotation: 0, type: "text", updatedAt: 1,
          width: 220, x: 180, y: 220, zIndex: 1,
        },
        {
          backgroundMode: "transparent", content: "Locked transparent", createdAt: 1, height: 92, id: "locked-transparent",
          locked: true, opacity: 1, pageId: "page", rotation: 0, type: "text", updatedAt: 1,
          width: 220, x: 520, y: 220, zIndex: 2,
        },
      ],
      folders: [],
      isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Locked text" }],
      sessionState: {
        openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page",
        textPreferences: { backgroundMode: "surface" },
      },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "initialize_storage") {
          return { databasePath: "locked-background.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        }
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
        if (command === "save_session_state" || command === "apply_scene_changes") return { newRevision: 1, pageId: "page" };
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.reload();

  const surfaceText = page.locator('[data-block-id="locked-surface"]');
  const transparentText = page.locator('[data-block-id="locked-transparent"]');
  await expect(surfaceText).toBeVisible();
  await surfaceText.locator(".text-block-header").click();
  await transparentText.locator(".text-block-header").click({ modifiers: ["Control"] });

  const group = page.getByRole("radiogroup", { name: "Text background" });
  await expect(group).toHaveAttribute("aria-disabled", "true");
  const descriptionIds = (await group.getAttribute("aria-describedby"))?.split(" ") ?? [];
  expect(descriptionIds).toHaveLength(2);
  await expect(group.locator(".drawing-mixed-label")).toHaveAttribute("id", descriptionIds[0]);
  await expect(page.getByText("All selected text boxes are locked.")).toHaveAttribute("id", descriptionIds[1]);
  for (const radio of [
    group.getByRole("radio", { name: "Surface text background" }),
    group.getByRole("radio", { name: "Transparent text background" }),
  ]) {
    await expect(radio).toBeDisabled();
    await expect(radio).toHaveAttribute("tabindex", "-1");
  }
});

test("keeps the properties scrollbar compact and themed in light and dark modes", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 320 });
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });

  const readScrollbarStyles = () => properties.evaluate((element) => {
    const style = getComputedStyle(element);
    const authoredWebkitRule = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules);
        } catch {
          return [];
        }
      })
      .map((rule) => rule as CSSStyleRule)
      .find((rule) => rule.selectorText === ".drawing-properties-panel::-webkit-scrollbar");
    const fallbackThumb = getComputedStyle(element, "::-webkit-scrollbar-thumb");
    const fallbackTrack = getComputedStyle(element, "::-webkit-scrollbar-track");
    return {
      authoredWebkitWidth: authoredWebkitRule?.style.width ?? "",
      panelBackground: style.backgroundColor,
      scrollbarColor: style.scrollbarColor,
      scrollbarWidth: style.scrollbarWidth,
      fallbackThumbBackground: fallbackThumb.backgroundColor,
      fallbackThumbClip: fallbackThumb.backgroundClip,
      fallbackTrackBackground: fallbackTrack.backgroundColor,
    };
  });

  const themeToggle = page.getByRole("button", { name: "Dark mode" });
  if (await themeToggle.getAttribute("aria-pressed") !== "true") {
    await themeToggle.click();
  }
  const dark = await readScrollbarStyles();
  expect(dark.scrollbarWidth).toBe("thin");
  expect(dark.scrollbarColor).toContain("rgb(153, 153, 163)");
  // Standardized scrollbar-width/color are the cross-browser contract.
  // The authored WebKit rule is only fallback evidence; it does not claim
  // that every browser renders an exact physical scrollbar width.
  expect(dark.authoredWebkitWidth).toBe("8px");
  expect(dark.fallbackThumbClip).toBe("padding-box");
  expect(contrastRatio(dark.fallbackThumbBackground, dark.fallbackTrackBackground)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(dark.fallbackThumbBackground, dark.panelBackground)).toBeGreaterThanOrEqual(3);

  await themeToggle.click();
  const light = await readScrollbarStyles();
  expect(light.scrollbarColor).toContain("rgb(107, 109, 120)");
  expect(light.authoredWebkitWidth).toBe("8px");
  expect(light.fallbackThumbClip).toBe("padding-box");
  expect(contrastRatio(light.fallbackThumbBackground, light.fallbackTrackBackground)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(light.fallbackThumbBackground, light.panelBackground)).toBeGreaterThanOrEqual(3);
  expect(light.fallbackThumbBackground).not.toBe(dark.fallbackThumbBackground);
});

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function relativeLuminance(color: string) {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Unsupported computed color: ${color}`);
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

test("keeps compact properties reachable at narrow width and effective 200% zoom", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas bounds were not available.");
  await page.mouse.click(canvasBounds.x + 160, canvasBounds.y + 260);
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  const adjustments = page.getByRole("button", { name: "Drawing properties" });
  await expect(adjustments).toBeVisible();
  await adjustments.click();
  await expect(properties).toBeVisible();

  const compactLayout = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".drawing-properties-panel");
    const rect = panel?.getBoundingClientRect();
    return {
      clientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      panelRight: rect?.right ?? 0,
      panelWidth: rect?.width ?? 0,
    };
  });
  expect(compactLayout.documentScrollWidth).toBeLessThanOrEqual(compactLayout.clientWidth);
  expect(compactLayout.panelRight).toBeLessThanOrEqual(compactLayout.clientWidth);
  expect(compactLayout.panelWidth).toBe(252);

  const layers = properties.getByRole("button", { name: "Bring to front" });
  const beforeScrollTop = await properties.evaluate((element) => element.scrollTop);
  await layers.focus();
  await expect.poll(() => properties.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeScrollTop);
  await expect(layers).toBeFocused();
  const layerBounds = await layers.boundingBox();
  const propertiesBounds = await properties.boundingBox();
  expect(layerBounds).not.toBeNull();
  expect(propertiesBounds).not.toBeNull();
  expect(layerBounds!.y).toBeGreaterThanOrEqual(propertiesBounds!.y);
  expect(layerBounds!.y + layerBounds!.height).toBeLessThanOrEqual(propertiesBounds!.y + propertiesBounds!.height);

  const browser = page.context().browser();
  if (!browser) throw new Error("Browser context was unavailable for the 200% display-scale check.");
  const appOrigin = new URL(page.url()).origin;
  const zoomContext = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 320, height: 640 },
  });
  const zoomedPage = await zoomContext.newPage();
  try {
    await zoomedPage.goto(appOrigin);
    await zoomedPage.getByRole("button", { name: /create new note/i }).click();
    await zoomedPage.getByRole("button", { name: "Rectangle (R / 2)" }).click();
    const zoomedCanvas = zoomedPage.getByRole("tabpanel");
    const zoomedCanvasBounds = await zoomedCanvas.boundingBox();
    if (!zoomedCanvasBounds) throw new Error("Zoomed canvas bounds were not available.");
    await zoomedPage.mouse.click(zoomedCanvasBounds.x + 160, zoomedCanvasBounds.y + 260);
    const zoomedProperties = zoomedPage.getByRole("complementary", { name: "Drawing properties" });
    await zoomedPage.getByRole("button", { name: "Drawing properties" }).click();
    await expect(zoomedProperties).toBeVisible();
    const zoomLayout = await zoomedPage.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".drawing-properties-panel");
      const rect = panel?.getBoundingClientRect();
      return {
        clientWidth: document.documentElement.clientWidth,
        devicePixelRatio: window.devicePixelRatio,
        documentScrollWidth: document.documentElement.scrollWidth,
        panelRight: rect?.right ?? 0,
      };
    });
    expect(zoomLayout.devicePixelRatio).toBe(2);
    expect(zoomLayout.documentScrollWidth).toBeLessThanOrEqual(zoomLayout.clientWidth);
    expect(zoomLayout.panelRight).toBeLessThanOrEqual(zoomLayout.clientWidth);
    const zoomedLayers = zoomedProperties.getByRole("button", { name: "Bring to front" });
    const zoomedBeforeScrollTop = await zoomedProperties.evaluate((element) => element.scrollTop);
    await zoomedLayers.focus();
    await expect.poll(() => zoomedProperties.evaluate((element) => element.scrollTop)).toBeGreaterThan(zoomedBeforeScrollTop);
    await expect(zoomedLayers).toBeFocused();
  } finally {
    await zoomContext.close();
  }
});

test("reflows compact properties without horizontal overflow at 200% text size", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 224 });
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.getByRole("button", { name: "Drawing properties" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(properties).toBeVisible();
  await page.addStyleTag({ content: ".drawing-properties-panel { font-size: 200% !important; }" });

  const layout = await properties.evaluate((element) => {
    const panel = element as HTMLElement;
    return {
      clientWidth: panel.clientWidth,
      hasVerticalOverflow: panel.scrollHeight > panel.clientHeight,
      overflowX: getComputedStyle(panel).overflowX,
      scrollWidth: panel.scrollWidth,
      visibleOverflow: Array.from(panel.querySelectorAll<HTMLElement>("*"))
        .filter((child) => !child.classList.contains("sr-only") && child.offsetParent !== null)
        .map((child) => ({
          className: child.className,
          clientWidth: child.clientWidth,
          section: child.closest(".drawing-property-section")?.querySelector("h3")?.textContent ?? null,
          scrollWidth: child.scrollWidth,
        }))
        .filter((child) => child.scrollWidth > panel.clientWidth),
    };
  });
  expect(layout.hasVerticalOverflow).toBe(true);
  expect(layout.overflowX).toBe("hidden");
  expect(layout.scrollWidth, JSON.stringify(layout.visibleOverflow)).toBeLessThanOrEqual(layout.clientWidth);
});

test("cancels interrupted opacity previews and commits lost pointer capture once", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.mouse.click(bounds.x + 420, bounds.y + 320);
  const rectangle = page.getByRole("button", { name: "Select and move rectangle shape. Press F2 to edit contained text." });
  const opacity = page.getByRole("slider", { name: "Opacity" });

  await opacity.dispatchEvent("pointerdown", { pointerId: 41 });
  await opacity.fill("35");
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBeCloseTo(0.35, 2);
  await opacity.dispatchEvent("pointercancel", { pointerId: 41 });
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBe(1);

  await opacity.dispatchEvent("pointerdown", { pointerId: 42 });
  await opacity.fill("45");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBe(1);

  await opacity.dispatchEvent("pointerdown", { pointerId: 43 });
  await opacity.fill("55");
  await opacity.dispatchEvent("lostpointercapture", { pointerId: 43 });
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBeCloseTo(0.55, 2);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => Number(await rectangle.evaluate((element) => (element as HTMLElement).style.opacity))).toBe(1);
});

test("shows text formatting only for selected or edited text", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.mouse.click(canvasBounds.x + 380, canvasBounds.y + 300);
  await expect(page.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);

  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(canvasBounds.x + 560, canvasBounds.y + 330);
  await expect(page.getByRole("toolbar", { name: "Text formatting" })).toBeVisible();
  await page.keyboard.type("Contextual text");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("toolbar", { name: "Text formatting" })).toBeVisible();
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await page.mouse.click(canvasBounds.x + 760, canvasBounds.y + 520);
  await expect(page.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);
});
