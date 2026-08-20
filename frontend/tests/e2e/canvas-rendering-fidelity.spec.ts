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
  expect(await activeTool.evaluate((node) => getComputedStyle(node).outlineWidth)).toBe("3px");

  await page.keyboard.down("Space");
  expect(await canvas.evaluate((node) => getComputedStyle(node).cursor)).toBe("grab");
  const bounds = await requiredBounds(canvas, "canvas");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(canvas).toHaveClass(/is-panning/);
  expect(await canvas.evaluate((node) => getComputedStyle(node).cursor)).toBe("grabbing");
  await page.mouse.up();
  await page.keyboard.up("Space");
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

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}
