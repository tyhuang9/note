import { expect, test, type Page } from "@playwright/test";

test("locked shape edits contained text as one stable connector target and one history commit", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const shape = page.locator('[data-canvas-element-id="shape"]');
  await expect(shape).toContainText("Original label");
  await expect(shape).toHaveAttribute("aria-label", /Original label/);
  await shape.focus();
  await shape.press("Enter");
  await expect(shape).toHaveAttribute("aria-pressed", "true");

  const baselineWrites = await writeCount(page);
  await shape.press("F2");
  const editor = shape.locator('.shape-contained-text-editor-content[role="textbox"]');
  await expect(editor).toBeFocused();
  await expect(page.locator(".canvas-accessibility-status")).toContainText("Editing text inside rectangle shape");
  await expect(shape).toHaveAttribute("aria-label", "Editing text inside rectangle shape. Escape cancels. Control+Enter saves.");
  await expect(shape).not.toHaveAttribute("aria-label", /Select|F2/);
  await editor.fill("Discarded");
  await editor.press("Escape");
  await expect(shape).toContainText("Original label");
  await expect.poll(() => writeCount(page)).toBe(baselineWrites);
  await expect(shape).toBeFocused();
  await expect(page.locator(".canvas-accessibility-status")).toContainText("Shape text editing canceled");

  await shape.press("F2");
  await expect(editor).toBeFocused();
  await editor.fill("Committed label");
  await editor.press("Control+Enter");
  await expect(shape).toContainText("Committed label");
  await expect(shape).toBeFocused();
  await expect.poll(() => writeCount(page)).toBe(baselineWrites + 1);
  await expect(page.locator(".canvas-accessibility-status")).toContainText("Shape text saved");

  const persisted = await page.evaluate(() => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements);
  const persistedShape = persisted.find((element) => element.id === "shape");
  const connector = persisted.find((element) => element.id === "connector");
  expect(persistedShape).toMatchObject({
    id: "shape",
    locked: true,
    text: { content: "Committed label" },
    type: "shape",
  });
  expect(connector).toMatchObject({
    start: { kind: "element", targetElementId: "shape" },
  });

  await page.getByRole("tabpanel").focus();
  await page.keyboard.press("Control+z");
  await expect(shape).toContainText("Original label");
  await page.keyboard.press("Control+y");
  await expect(shape).toContainText("Committed label");
});

test("double-click and blur preserve empty omission, then rich text survives reload and copy", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const shape = page.locator('[data-canvas-element-id="blank-shape"]');
  await shape.focus();
  await shape.press("Enter");
  const baselineWrites = await writeCount(page);
  await page.locator(".selection-frame-move-surface").dblclick();
  const editor = shape.locator('.shape-contained-text-editor-content[role="textbox"]');
  await expect(editor).toBeFocused();
  await page.getByRole("tabpanel").click({ position: { x: 40, y: 80 } });
  await expect.poll(() => writeCount(page)).toBe(baselineWrites);
  await expect(page.locator(".canvas-accessibility-status")).toContainText("Shape text unchanged");
  expect(await shapeRecord(page, "blank-shape")).not.toHaveProperty("text");

  await shape.focus();
  await shape.press("Enter");
  await page.locator(".selection-frame-move-surface").dblclick();
  await editor.fill("Rich label");
  await editor.press("Control+a");
  await editor.press("Control+b");
  await editor.press("Control+Enter");
  await expect(shape.locator("strong")).toHaveText("Rich label");
  await expect.poll(() => writeCount(page)).toBe(baselineWrites + 1);

  await page.reload();
  const reloaded = page.locator('[data-canvas-element-id="blank-shape"]');
  await expect(reloaded.locator("strong")).toHaveText("Rich label");
  await reloaded.focus();
  await reloaded.press("Enter");
  await reloaded.press("Control+c");
  await expect(page.locator(".canvas-accessibility-status")).toContainText("Copied one shape with contained text");
  await reloaded.press("Control+v");
  await expect.poll(async () => page.locator('[data-canvas-element-type="shape"]', { hasText: "Rich label" }).count()).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements.filter((element) => element.type === "shape" && (element.text as { content?: string } | undefined)?.content === "Rich label").length)).toBe(2);
  const copies = await page.evaluate(() => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements.filter((element) => element.type === "shape" && (element.text as { content?: string } | undefined)?.content === "Rich label"));
  expect(copies).toHaveLength(2);
  expect(new Set(copies.map((element) => element.id)).size).toBe(2);
});

test("rich structure clips and transforms with its composite shape through resize and delete undo", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const shape = page.locator('[data-canvas-element-id="rich-shape"]');
  const text = shape.locator(".shape-contained-text-display");
  await expect(shape).toHaveAttribute("aria-label", /Heading\s+Item\s+Pixel\s+Link/);
  await expect(text.locator("h2")).toHaveText("Heading");
  await expect(text.locator("ul li")).toHaveText("Item");
  await expect(text.locator("img")).toHaveAttribute("alt", "Pixel");
  await expect(text.locator(".shape-text-link")).toHaveText("Link");
  await expect(text.locator("a")).toHaveCount(0);
  await expect(shape).toHaveCSS("transform", /matrix/);
  await expect(text).toHaveCSS("overflow", "hidden");

  const beforeWidth = await shape.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width));
  await shape.focus();
  await shape.press("Enter");
  const resize = page.getByRole("button", { name: "Resize selected elements from se" });
  await resize.press("Shift+ArrowRight");
  await expect.poll(() => shape.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width))).toBeGreaterThan(beforeWidth);
  await expect(text.locator("h2")).toHaveText("Heading");
  const connector = await page.evaluate(() => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements.find((element) => element.id === "rich-connector"));
  expect(connector).toMatchObject({ start: { kind: "element", targetElementId: "rich-shape" } });

  await page.keyboard.press("Delete");
  await expect(shape).toHaveCount(0);
  await expect(page.locator(".canvas-accessibility-status")).toContainText("Deleted one shape with contained text");
  await page.getByRole("tabpanel").focus();
  await page.keyboard.press("Control+z");
  const restored = page.locator('[data-canvas-element-id="rich-shape"]');
  await expect(restored.locator("h2")).toHaveText("Heading");
  await expect(restored).toHaveAttribute("data-canvas-element-id", "rich-shape");
  await expect(page.locator(".canvas-accessibility-status")).toContainText("Undid a shape-contained text change");
  await page.keyboard.press("Control+y");
  await expect(restored).toHaveCount(0);
  await expect(page.locator(".canvas-accessibility-status")).toContainText("Redid a shape-contained text change");
});

test("native canvas double-click edits locked and unlocked shapes but ignores click-drag", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const lockedShape = page.locator('[data-canvas-element-id="shape"]');
  await doubleClickCanvasElement(page, lockedShape);
  const lockedEditor = lockedShape.locator('[role="textbox"]');
  await expect(lockedEditor).toBeFocused();
  await lockedEditor.press("Escape");

  const blankShape = page.locator('[data-canvas-element-id="blank-shape"]');
  await clickCanvasElement(page, blankShape);
  const moveSurface = page.locator(".selection-frame-move-surface");
  const moveBounds = await moveSurface.boundingBox();
  if (!moveBounds) throw new Error("Selected shape move surface is unavailable");
  await page.mouse.move(moveBounds.x + moveBounds.width / 2, moveBounds.y + moveBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBounds.x + moveBounds.width / 2 + 18, moveBounds.y + moveBounds.height / 2 + 12, { steps: 3 });
  await page.mouse.up();
  await expect(blankShape.locator('[role="textbox"]')).toHaveCount(0);

  await doubleClickCanvasElement(page, blankShape);
  await expect(blankShape.locator('[role="textbox"]')).toBeFocused();
  await blankShape.locator('[role="textbox"]').press("Escape");
});

test("shape toolbar Escape cancels and Control+Enter commits from native controls", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const shape = page.locator('[data-canvas-element-id="blank-shape"]');
  await shape.focus();
  await shape.press("F2");
  const editor = shape.locator('[role="textbox"]');
  const hint = shape.locator(".shape-contained-text-editor-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveAttribute("aria-hidden", "true");
  await expect(hint).toHaveText("Esc cancels · Ctrl/⌘+Enter saves");
  await editor.fill("Canceled from toolbar");
  const baselineWrites = await writeCount(page);
  await editor.press("Tab");
  const fontFamily = page.getByRole("combobox", { name: "Font family" });
  await expect(fontFamily).toBeFocused();
  await fontFamily.press("Escape");
  await expect(shape).toBeFocused();
  await expect(page.locator(".canvas-accessibility-status")).toHaveText("Shape text editing canceled.");
  await expect.poll(() => writeCount(page)).toBe(baselineWrites);
  expect(await shapeRecord(page, "blank-shape")).not.toHaveProperty("text");

  await shape.press("F2");
  await editor.fill("Saved from toolbar");
  await editor.press("Tab");
  const bold = page.getByRole("button", { name: "Bold" });
  await bold.focus();
  await bold.press("Control+Enter");
  await expect(shape).toBeFocused();
  await expect(page.locator(".canvas-accessibility-status")).toHaveText("Shape text saved.");
  await expect(shape).toContainText("Saved from toolbar");
  await expect.poll(() => writeCount(page)).toBe(baselineWrites + 1);
});

for (const exit of ["canvas", "tool", "page", "selection"] as const) {
  test(`live shape draft commits once after keyboard focus moves through toolbar to ${exit}`, async ({ page }) => {
    await installShapeTextWorkspace(page);
    await page.goto("/");
    await observeShapeTextAnnouncements(page);

    const shape = page.locator('[data-canvas-element-id="blank-shape"]');
    await shape.focus();
    await shape.press("F2");
    const editor = shape.locator('[role="textbox"]');
    await editor.fill(`Draft for ${exit}`);
    const baselineWrites = await writeCount(page);
    await editor.press("Tab");
    await expect(page.getByRole("combobox", { name: "Font family" })).toBeFocused();
    await expect.poll(() => writeCount(page)).toBe(baselineWrites);

    if (exit === "canvas") {
      await page.getByRole("tabpanel").focus();
    } else if (exit === "tool") {
      await page.locator('.canvas-tool-palette [data-tool="rectangle"]').focus();
      await page.keyboard.press("Enter");
    } else if (exit === "page") {
      await page.getByRole("tab", { name: "Second page" }).focus();
      await page.keyboard.press("Enter");
    } else {
      await page.locator('[data-canvas-element-id="shape"]').focus();
      await page.keyboard.press("Enter");
    }

    await expect.poll(() => writeCount(page)).toBe(baselineWrites + 1);
    await expect.poll(async () => (await shapeRecord(page, "blank-shape") as { text?: { content?: string } })?.text?.content).toBe(`Draft for ${exit}`);
    expect((await shapeTextAnnouncements(page)).filter((message) => message === "Shape text saved.")).toHaveLength(1);
  });
}

test("pointer exit commits the current shape draft once", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");
  await observeShapeTextAnnouncements(page);

  const shape = page.locator('[data-canvas-element-id="blank-shape"]');
  await shape.focus();
  await shape.press("F2");
  await shape.locator('[role="textbox"]').fill("Pointer exit draft");
  const baselineWrites = await writeCount(page);
  await page.getByRole("tabpanel").click({ position: { x: 24, y: 190 } });
  await expect.poll(() => writeCount(page)).toBe(baselineWrites + 1);
  await expect.poll(async () => (await shapeRecord(page, "blank-shape") as { text?: { content?: string } })?.text?.content).toBe("Pointer exit draft");
  expect((await shapeTextAnnouncements(page)).filter((message) => message === "Shape text saved.")).toHaveLength(1);
});

for (const variant of [
  { isDarkMode: false, rotation: 0, shape: "rectangle" },
  { isDarkMode: true, rotation: -17, shape: "ellipse" },
  { isDarkMode: false, rotation: 23, shape: "diamond" },
] as const) {
  test(`rich blocks flow vertically and stay centered in a clipped ${variant.shape} label`, async ({ page }) => {
    await installShapeTextWorkspace(page, variant);
    await page.goto("/");

    await expect(page.locator(".app-shell")).toHaveClass(variant.isDarkMode ? /is-dark/ : /^(?!.*\bis-dark\b)/);
    const shape = page.locator('[data-canvas-element-id="rich-shape"]');
    const metrics = await shape.evaluate((root) => {
      const container = root.querySelector<HTMLElement>(".shape-contained-text-display");
      const content = root.querySelector<HTMLElement>(".shape-contained-text-content");
      const heading = content?.querySelector<HTMLElement>("h2");
      const list = content?.querySelector<HTMLElement>("ul");
      const image = content?.querySelector<HTMLElement>("img");
      if (!container || !content || !heading || !list || !image) throw new Error("Rich layout nodes are missing");
      const bounds = (element: HTMLElement) => {
        const rectangle = element.getBoundingClientRect();
        return { bottom: rectangle.bottom, left: rectangle.left, right: rectangle.right, top: rectangle.top };
      };
      return {
        containerBounds: bounds(container),
        containerHeight: container.clientHeight,
        contentHeight: content.offsetHeight,
        contentTop: content.offsetTop,
        contentWidth: content.offsetWidth,
        containerWidth: container.clientWidth,
        heading: { bottom: heading.offsetTop + heading.offsetHeight, top: heading.offsetTop },
        image: { bottom: image.offsetTop + image.offsetHeight, top: image.offsetTop },
        imageBounds: bounds(image),
        list: { bottom: list.offsetTop + list.offsetHeight, top: list.offsetTop },
        listBounds: bounds(list),
        headingBounds: bounds(heading),
        overflow: getComputedStyle(container).overflow,
        transform: getComputedStyle(root).transform,
      };
    });

    expect(metrics.heading.bottom).toBeLessThanOrEqual(metrics.list.top);
    expect(metrics.list.bottom).toBeLessThanOrEqual(metrics.image.top);
    expect(Math.abs(metrics.contentTop + metrics.contentHeight / 2 - metrics.containerHeight / 2)).toBeLessThanOrEqual(0.5);
    expect(metrics.contentWidth).toBe(metrics.containerWidth);
    expect(metrics.overflow).toBe("hidden");
    expect(metrics.transform).toMatch(/^matrix\(/);
    for (const child of [metrics.headingBounds, metrics.listBounds, metrics.imageBounds]) {
      expect(child.top).toBeGreaterThanOrEqual(metrics.containerBounds.top - 1);
      expect(child.bottom).toBeLessThanOrEqual(metrics.containerBounds.bottom + 1);
      expect(child.left).toBeGreaterThanOrEqual(metrics.containerBounds.left - 1);
      expect(child.right).toBeLessThanOrEqual(metrics.containerBounds.right + 1);
    }
  });
}

test("shape accessible names use a bounded text excerpt", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const shape = page.locator('[data-canvas-element-id="a11y-shape"]');
  const label = await shape.getAttribute("aria-label");
  expect(label).not.toBeNull();
  expect(label?.length).toBeLessThanOrEqual(210);
  expect(label).toContain("Canonical accessible label Diagram description");
  expect(label).not.toContain("Stale fallback");
  expect(label).toContain("Press F2 to edit contained text");
  await shape.focus();
  await shape.press("F2");
  await expect(shape.locator('[role="textbox"]')).toHaveText(/Canonical accessible label.*Canonical detail/);
  await expect(shape.locator('[role="textbox"] img')).toHaveAttribute("alt", "Diagram description");
});

const toolbarGeometryVariants = ([
  { label: "desktop", viewport: { height: 720, width: 1280 } },
  { label: "compact", viewport: { height: 700, width: 320 } },
] as const).flatMap(({ label, viewport }) => ([false, true] as const).flatMap((isDarkMode) => ([0.5, 1, 2] as const).map((zoomLevel) => ({
  isDarkMode,
  label: `${label} ${isDarkMode ? "dark" : "light"} ${Math.round(zoomLevel * 100)}%`,
  viewport,
  zoomLevel,
}))));

for (const variant of toolbarGeometryVariants) {
  test(`shape toolbar remains separate, contained, and touch sized at ${variant.label}`, async ({ page }) => {
    await page.setViewportSize(variant.viewport);
    await installShapeTextWorkspace(page, { isDarkMode: variant.isDarkMode, rotation: 0, shape: "rectangle", zoomLevel: variant.zoomLevel });
    await page.goto("/");

    const shape = page.locator('[data-canvas-element-id="shape"]');
    await shape.focus();
    if (variant.viewport.width === 320) {
      await shape.press("Enter");
      await page.getByRole("button", { name: "Drawing properties", exact: true }).click();
      await shape.focus();
    }
    await shape.press("F2");
    const textToolbar = page.getByRole("toolbar", { name: "Text formatting" });
    const drawingToolbar = page.getByRole("toolbar", { name: "Drawing tools" });
    await expect(textToolbar).toBeVisible();
    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        const rectangle = element.getBoundingClientRect();
        return { bottom: rectangle.bottom, height: rectangle.height, left: rectangle.left, right: rectangle.right, top: rectangle.top, width: rectangle.width };
      };
      const controls = [...document.querySelectorAll<HTMLElement>(".global-text-toolbar button, .global-text-toolbar select")]
        .map((element) => {
          const rectangle = element.getBoundingClientRect();
          return { height: rectangle.height, width: rectangle.width };
        });
      return {
        drawingToolbar: bounds(".canvas-tool-palette"),
        propertiesPanel: bounds(".drawing-properties-panel"),
        textToolbar: bounds(".global-text-toolbar"),
        controls,
        viewportHeight: document.documentElement.clientHeight,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(geometry.textToolbar.top).toBeGreaterThanOrEqual(geometry.drawingToolbar.bottom);
    expect(geometry.textToolbar.left).toBeGreaterThanOrEqual(0);
    expect(geometry.textToolbar.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.propertiesPanel.top).toBeGreaterThanOrEqual(geometry.textToolbar.bottom);
    expect(geometry.propertiesPanel.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    for (const control of geometry.controls) {
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.width).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator(".zoom-indicator")).toHaveText(`${Math.round(variant.zoomLevel * 100)}%`);
  });
}

test("dark shape code blocks retain readable contrast", async ({ page }) => {
  await installShapeTextWorkspace(page, { isDarkMode: true, rotation: 0, shape: "rectangle", zoomLevel: 1 });
  await page.goto("/");

  const code = page.locator('[data-canvas-element-id="code-shape"] pre code');
  await expect(code).toHaveText("const answer = 42;");
  const ratio = await code.evaluate((element) => {
    const parse = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (value: string) => {
      const channels = parse(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = luminance(getComputedStyle(element).color);
    const background = luminance(getComputedStyle(element.parentElement!).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

async function writeCount(page: Page) {
  return page.evaluate(() => (window as unknown as { __shapeTextWrites: number }).__shapeTextWrites);
}

async function shapeRecord(page: Page, id: string) {
  return page.evaluate((shapeId) => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements.find((element) => element.id === shapeId), id);
}

async function observeShapeTextAnnouncements(page: Page) {
  await page.evaluate(() => {
    const runtime = window as unknown as { __shapeTextAnnouncements: string[] };
    runtime.__shapeTextAnnouncements = [];
    const status = document.querySelector<HTMLElement>(".canvas-accessibility-status");
    if (!status) throw new Error("Shape text status region is missing");
    const record = () => {
      const message = status.textContent?.trim();
      if (message) runtime.__shapeTextAnnouncements.push(message);
    };
    new MutationObserver(record).observe(status, { childList: true, characterData: true, subtree: true });
  });
}

async function shapeTextAnnouncements(page: Page) {
  return page.evaluate(() => (window as unknown as { __shapeTextAnnouncements: string[] }).__shapeTextAnnouncements);
}

async function clickCanvasElement(page: Page, element: ReturnType<Page["locator"]>) {
  const bounds = await element.boundingBox();
  if (!bounds) throw new Error("Canvas element is unavailable");
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function doubleClickCanvasElement(page: Page, element: ReturnType<Page["locator"]>) {
  const bounds = await element.boundingBox();
  if (!bounds) throw new Error("Canvas element is unavailable");
  await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function installShapeTextWorkspace(
  page: Page,
  richShapeLayout: { isDarkMode: boolean; rotation: number; shape: "rectangle" | "ellipse" | "diamond"; zoomLevel?: number } | null = null,
) {
  await page.addInitScript((layout) => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const style = {
      fillColor: { kind: "fixed", value: "#fff4cc" },
      roughness: 1,
      roundness: 0.4,
      seed: 42,
      strokeColor: { kind: "theme", token: "foreground" },
      strokeStyle: "solid",
      strokeWidth: 2,
    };
    const workspace = {
      elements: [
        {
          createdAt: 1,
          height: 180,
          id: "shape",
          locked: true,
          opacity: 1,
          pageId: "page",
          rotation: 12,
          shape: "rectangle",
          style,
          text: {
            content: "Original label",
            richContent: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Original label", marks: [{ type: "bold" }] }] }] },
          },
          type: "shape",
          updatedAt: 1,
          width: 280,
          x: 360,
          y: 240,
          zIndex: 1,
        },
        {
          createdAt: 1,
          height: 180,
          id: "blank-shape",
          locked: false,
          opacity: 1,
          pageId: "page",
          rotation: -8,
          shape: "ellipse",
          style: { ...style, fillColor: { kind: "fixed", value: "#dff7ed" }, seed: 43 },
          type: "shape",
          updatedAt: 1,
          width: 280,
          x: 760,
          y: 240,
          zIndex: 2,
        },
        {
          createdAt: 1,
          height: layout ? 360 : 220,
          id: "rich-shape",
          locked: false,
          opacity: 1,
          pageId: "page",
          rotation: layout?.rotation ?? 18,
          shape: layout?.shape ?? "diamond",
          style: { ...style, fillColor: { kind: "fixed", value: "#e8e2ff" }, seed: 44 },
          text: {
            content: "Heading\nItem\nLink",
            richContent: {
              type: "doc",
              content: [
                { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
                { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item", marks: [{ type: "italic" }] }] }] }] },
                { type: "image", attrs: { src: "data:image/png;base64,AA==", alt: "Pixel", title: null, width: 24, height: 24 } },
                { type: "paragraph", content: [{ type: "text", text: "Link", marks: [{ type: "link", attrs: { href: "https://example.com", target: null, rel: null, class: null, title: null } }] }] },
              ],
            },
          },
          type: "shape",
          updatedAt: 1,
          width: layout ? 420 : 320,
          x: layout ? 420 : 520,
          y: layout ? 280 : 520,
          zIndex: 3,
        },
        {
          createdAt: 1,
          height: 140,
          id: "code-shape",
          locked: false,
          opacity: 1,
          pageId: "page",
          rotation: 0,
          shape: "rectangle",
          style: { ...style, seed: 47 },
          text: {
            content: "const answer = 42;",
            richContent: { type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "const answer = 42;" }] }] },
          },
          type: "shape",
          updatedAt: 1,
          width: 300,
          x: 920,
          y: 1020,
          zIndex: 3,
        },
        {
          createdAt: 1,
          height: 120,
          id: "a11y-shape",
          locked: false,
          opacity: 1,
          pageId: "page",
          rotation: 0,
          shape: "rectangle",
          style: { ...style, seed: 46 },
          text: {
            content: `Stale fallback ${"label ".repeat(100)}`.trim(),
            richContent: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Canonical accessible label" }] },
                { type: "image", attrs: { src: "data:image/png;base64,AA==", alt: "Diagram description", title: null, width: 24, height: 24 } },
                { type: "paragraph", content: [{ type: "text", text: `Canonical ${"detail ".repeat(100)}`.trim() }] },
              ],
            },
          },
          type: "shape",
          updatedAt: 1,
          width: 240,
          x: 1200,
          y: 800,
          zIndex: 3,
        },
        {
          createdAt: 1,
          end: { kind: "free", x: 760, y: 330 },
          id: "connector",
          locked: false,
          opacity: 1,
          pageId: "page",
          routing: "straight",
          start: { kind: "element", targetElementId: "shape", anchor: { t: 0.25 }, gap: 6 },
          style: { ...style, endArrowhead: "arrow", fillColor: null, startArrowhead: "none" },
          type: "connector",
          updatedAt: 1,
          zIndex: 4,
        },
        {
          createdAt: 1,
          end: { kind: "free", x: 940, y: 630 },
          id: "rich-connector",
          locked: false,
          opacity: 1,
          pageId: "page",
          routing: "straight",
          start: { kind: "element", targetElementId: "rich-shape", anchor: { t: 0.25 }, gap: 6 },
          style: { ...style, endArrowhead: "arrow", fillColor: null, startArrowhead: "none", seed: 45 },
          type: "connector",
          updatedAt: 1,
          zIndex: 5,
        },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: layout?.isDarkMode ?? false,
      pages: [
        { folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Shape text" },
        { folderId: "", id: "page-2", isBookmarked: false, revision: 0, title: "Second page" },
      ],
      sessionState: {
        openPageTabIds: ["page", "page-2"],
        pageViewports: { page: { panOffset: { x: 0, y: 0 }, zoomLevel: layout?.zoomLevel ?? 1 } },
        selectedFolderId: "",
        selectedPageId: "page",
      },
      warnings: [],
    };
    const savedElements = window.localStorage.getItem("shape-text-elements");
    if (savedElements) workspace.elements = JSON.parse(savedElements) as ElementRecord[];
    const runtime = window as unknown as {
      __shapeTextWorkspace: typeof workspace;
      __shapeTextWrites: number;
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.__shapeTextWorkspace = workspace;
    runtime.__shapeTextWrites = 0;
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "initialize_storage") return { databasePath: "shape-text.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
        if (command === "apply_scene_changes") {
          runtime.__shapeTextWrites += 1;
          const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
          const deleted = new Set(batch.deletedElementIds);
          const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
          workspace.elements = workspace.elements
            .filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id))
            .map((element) => upserts.get(element.id) ?? element);
          for (const element of batch.upserts) {
            if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
          }
          window.localStorage.setItem("shape-text-elements", JSON.stringify(workspace.elements));
          workspace.pages[0].revision += 1;
          return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
        }
        return undefined;
      },
    };
  }, richShapeLayout);
}
