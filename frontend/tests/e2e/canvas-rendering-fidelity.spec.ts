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
  const focusIndicator = canvas.locator("[data-canvas-focus-indicator]");
  expect(await focusIndicator.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
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
  await expect(focusIndicator).toBeVisible();
  await expect(focusIndicator).toHaveCSS("opacity", "1");
  await expect(focusIndicator).toHaveText("Canvas focused");
  expect(await focusIndicator.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    pointerEvents: getComputedStyle(node).pointerEvents,
    tabIndex: (node as HTMLElement).tabIndex,
  }))).toEqual({ height: expect.any(Number), pointerEvents: "none", tabIndex: -1 });
  expect(await focusIndicator.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(24);
  expect(await activeTool.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("none");

  await page.keyboard.press("Tab");
  await expect(activeTool).toBeFocused();
  await expect(focusIndicator).toHaveCSS("opacity", "0");
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();
  await expect(focusIndicator).toHaveCSS("opacity", "1");

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

test("keeps the canvas focus badge contained and separate from offscreen navigation in light/dark compact zoomed workspaces", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await appendOffscreenNavigationFixture(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });

  const canvas = page.getByRole("tabpanel");
  const badge = canvas.locator("[data-canvas-focus-indicator]");
  const activeTool = page.locator('.canvas-tool-palette [data-tool="select"]');
  const navigation = canvas.locator(".offscreen-arrow");
  await expect(navigation).toHaveCount(8);

  for (const dark of [false, true]) {
    await setDarkMode(page, dark);
    await activeTool.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(canvas).toBeFocused();
    await expect(badge).toHaveText("Canvas focused");
    await expect(badge).toHaveCSS("opacity", "1");
    await expect(activeTool).not.toBeFocused();

    const layout = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('[role="tabpanel"]');
      const badge = canvas?.querySelector<HTMLElement>("[data-canvas-focus-indicator]");
      if (!canvas || !badge) throw new Error("Canvas focus badge was unavailable.");
      const canvasRect = canvas.getBoundingClientRect();
      const badgeRect = badge.getBoundingClientRect();
      const relatedSelectors = [
        ".offscreen-arrow",
        ".drawing-properties-panel",
        ".zoom-indicator",
        ".canvas-tool-palette",
        ".canvas-controls",
        ".global-text-toolbar",
      ];
      const rectangles = relatedSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).map((node) => ({
          selector,
          rect: node.getBoundingClientRect(),
        })),
      );
      const intersects = (a: DOMRect, b: DOMRect) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        badge: {
          bottom: badgeRect.bottom,
          height: badgeRect.height,
          left: badgeRect.left,
          right: badgeRect.right,
          top: badgeRect.top,
        },
        canvas: {
          bottom: canvasRect.bottom,
          left: canvasRect.left,
          right: canvasRect.right,
          top: canvasRect.top,
        },
        collisions: rectangles.filter(({ rect }) => intersects(badgeRect, rect)).map(({ selector }) => selector),
        controls: rectangles.filter(({ selector }) => selector === ".offscreen-arrow").length,
      };
    });

    expect(layout.controls).toBe(8);
    expect(layout.badge.height).toBeGreaterThanOrEqual(24);
    expect(layout.badge.left).toBeGreaterThanOrEqual(layout.canvas.left);
    expect(layout.badge.right).toBeLessThanOrEqual(layout.canvas.right);
    expect(layout.badge.top).toBeGreaterThanOrEqual(layout.canvas.top);
    expect(layout.badge.bottom).toBeLessThanOrEqual(layout.canvas.bottom);
    expect(layout.collisions).toEqual([]);

    await page.keyboard.press("Tab");
    await expect(activeTool).toBeFocused();
    await expect(badge).toHaveCSS("opacity", "0");
    await page.keyboard.press("Shift+Tab");
    await expect(canvas).toBeFocused();
    await expect(badge).toHaveCSS("opacity", "1");
  }
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

async function appendOffscreenNavigationFixture(page: Page) {
  await page.getByRole("tabpanel").evaluate((canvas) => {
    const existing = canvas.querySelector("[data-e2e-offscreen-navigation]");
    existing?.remove();
    const indicators = document.createElement("div");
    indicators.className = "offscreen-indicators";
    indicators.dataset.e2eOffscreenNavigation = "true";
    for (const direction of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
      const button = document.createElement("button");
      button.className = `offscreen-arrow offscreen-${direction}`;
      button.type = "button";
      button.setAttribute("aria-label", `1 textbox offscreen ${direction}`);
      button.textContent = "1";
      indicators.append(button);
    }
    canvas.append(indicators);
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
