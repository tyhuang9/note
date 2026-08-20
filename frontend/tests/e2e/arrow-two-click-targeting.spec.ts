import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await installArrowWorkspace(page);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("Arrow stays pending after the first click and commits once on the second click with lock semantics", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  await resetCounts(page);
  await selectTool(page, "arrow");

  await page.mouse.click(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.72);
  await expect(page.locator(".arrow-authoring-preview")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Select and move arrow connector" })).toHaveCount(0);
  expect((await counts(page)).apply).toBe(0);

  await page.mouse.move(bounds.x + bounds.width * 0.82, bounds.y + bounds.height * 0.82);
  const preview = page.locator(".arrow-authoring-preview");
  await expect(preview).toHaveAttribute("opacity", "1");
  const previewSeed = Number(await preview.getAttribute("data-seed"));
  expect(previewSeed).toBeGreaterThan(0);
  await page.mouse.click(bounds.x + bounds.width * 0.82, bounds.y + bounds.height * 0.82);
  await expect(page.getByRole("button", { name: "Select and move arrow connector" })).toHaveCount(1);
  await expect(page.locator(".arrow-authoring-preview")).toHaveCount(0);
  await expect.poll(async () => (await counts(page)).apply).toBe(1);
  await expect.poll(async () => {
    const style = (await newestConnector(page))?.style as { seed?: number } | undefined;
    return style?.seed;
  }).toBe(previewSeed);
  await expect(page.locator('[data-tool="arrow"]')).toHaveAttribute("aria-pressed", "true");

  await page.locator("[data-tool-lock]").click();
  await page.mouse.click(bounds.x + bounds.width * 0.68, bounds.y + bounds.height * 0.62);
  await page.mouse.click(bounds.x + bounds.width * 0.84, bounds.y + bounds.height * 0.7);
  await expect(page.getByRole("button", { name: "Select and move arrow connector" })).toHaveCount(2);
  await expect(page.locator('[data-tool="select"]')).toHaveAttribute("aria-pressed", "true");
});

test("invalid authored coordinates do not write and finite extremes clamp to the persistence boundary", async ({ page }) => {
  await resetCounts(page);
  await selectTool(page, "arrow");

  await dispatchArrowPointerWithCanvasLeft(page, "nan");
  await expect(page.locator(".arrow-authoring-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select and move arrow connector" })).toHaveCount(0);
  await expect(page.locator(".canvas-accessibility-status")).toHaveText("Arrow endpoint is unavailable.");
  expect((await counts(page)).apply).toBe(0);

  await dispatchArrowPointerWithCanvasLeft(page, -2_000_000);
  const preview = page.locator(".arrow-authoring-preview");
  await expect(preview).toHaveAttribute("data-start-x", "1000000");
  await dispatchArrowPointerWithCanvasLeft(page, 2_000_000);
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await counts(page)).apply).toBe(1);
  await expect.poll(async () => newestConnector(page)).toMatchObject({
    end: { kind: "free", x: -1_000_000 },
    start: { kind: "free", x: 1_000_000 },
  });
});

test("one direct or nearby target exposes screen-constant anchors and binding wins over Shift", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const shape = page.locator('[data-canvas-element-id="target-shape"]');
  const lockedText = page.locator('[data-canvas-element-id="locked-text"]');
  const bounds = await requiredBounds(canvas, "canvas");

  for (const zoom of [50, 100, 200]) {
    await setZoom(page, canvas, zoom);
    await selectTool(page, "arrow");
    await page.mouse.click(bounds.x + bounds.width * 0.82, bounds.y + bounds.height * 0.82);
    const shapeBounds = await requiredBounds(shape, "shape");
    await page.mouse.move(shapeBounds.x + shapeBounds.width + 24, shapeBounds.y + shapeBounds.height / 2);
    const anchors = page.locator('[data-connector-target-id="target-shape"]');
    await expect(anchors).toHaveCount(4);
    const active = page.locator('[data-connector-target-id="target-shape"].is-active');
    await expect(active).toHaveCount(1);
    expect(Math.round((await requiredBounds(active, "active anchor")).width)).toBe(14);
    await page.mouse.move(shapeBounds.x + shapeBounds.width + 16, shapeBounds.y + shapeBounds.height / 2);
    await expect(active).toHaveClass(/is-snapped/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".connector-binding-anchor")).toHaveCount(0);
  }

  await setZoom(page, canvas, 100);
  await selectTool(page, "arrow");
  await page.mouse.click(bounds.x + bounds.width * 0.82, bounds.y + bounds.height * 0.82);
  const textBounds = await requiredBounds(lockedText, "locked text");
  await page.mouse.move(textBounds.x + textBounds.width / 2, textBounds.y + textBounds.height / 2);
  expect(await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-canvas-element-id]")?.dataset.canvasElementId ?? null,
  { x: textBounds.x + textBounds.width / 2, y: textBounds.y + textBounds.height / 2 })).toBe("locked-text");
  await expect(page.locator('[data-connector-target-id="locked-text"]')).toHaveCount(4);
  await expect(page.locator('[data-connector-target-id="overlap-low"]')).toHaveCount(0);
  const textLeftAnchor = page.locator('[data-connector-target-id="locked-text"][data-connector-anchor="left"]');
  const textLeftBounds = await requiredBounds(textLeftAnchor, "locked text left anchor");
  const textLeftPoint = { x: textLeftBounds.x + textLeftBounds.width / 2, y: textLeftBounds.y + textLeftBounds.height / 2 };
  await page.mouse.move(textLeftPoint.x, textLeftPoint.y);
  await expect(textLeftAnchor).toHaveClass(/is-snapped/);
  await page.keyboard.down("Shift");
  await page.mouse.click(textLeftPoint.x, textLeftPoint.y);
  await page.keyboard.up("Shift");
  await expect.poll(async () => newestConnector(page)).toMatchObject({
    end: { kind: "element", targetElementId: "locked-text" },
  });
});

test("zero length, cancellation paths, Space pan, and Line regression do not create partial arrows", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const rectangle = page.locator('[data-canvas-element-id="target-shape"]');
  await rectangle.focus();
  await page.keyboard.press("Enter");
  await resetCounts(page);

  await selectTool(page, "arrow");
  const point = { x: bounds.x + bounds.width * 0.75, y: bounds.y + bounds.height * 0.75 };
  await page.mouse.click(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".arrow-authoring-preview")).toHaveCount(1);
  await expect(page.locator(".canvas-accessibility-status")).toHaveText("Arrow needs two different endpoints.");
  expect((await counts(page)).apply).toBe(0);

  await page.keyboard.press("Escape");
  await expect(rectangle).toHaveAttribute("aria-pressed", "true");
  await expectNoDraftOrWrite(page);

  for (const cancel of ["pointercancel", "lostpointercapture", "blur", "tool", "page"] as const) {
    await selectTool(page, "arrow");
    await page.mouse.click(point.x, point.y);
    if (cancel === "pointercancel" || cancel === "lostpointercapture") {
      await canvas.dispatchEvent(cancel, { pointerId: 77 });
    } else if (cancel === "blur") {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    } else if (cancel === "tool") {
      await selectTool(page, "select");
    } else {
      await page.getByRole("tab", { name: "Second page" }).click();
      await page.getByRole("tab", { name: "Arrow authoring" }).click();
    }
    await expectNoDraftOrWrite(page);
  }

  await selectTool(page, "arrow");
  await page.mouse.click(point.x, point.y);
  await canvas.focus();
  await page.keyboard.down("Space");
  await page.mouse.move(bounds.x + 700, bounds.y + 500);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 730, bounds.y + 530);
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(page.locator(".arrow-authoring-preview")).toHaveCount(1);
  await page.mouse.click(bounds.x + 650, bounds.y + 650);
  await expect.poll(async () => (await counts(page)).apply).toBe(1);

  await selectTool(page, "line");
  await page.mouse.move(bounds.x + bounds.width * 0.66, bounds.y + bounds.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.82, bounds.y + bounds.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Select and move line connector" })).toHaveCount(1);
});

async function selectTool(page: Page, tool: string) {
  const button = page.locator(`.canvas-tool-palette [data-tool="${tool}"]`);
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

async function dispatchArrowPointerWithCanvasLeft(page: Page, canvasLeft: number | "nan") {
  await page.evaluate((leftValue) => {
    const canvas = document.querySelector<HTMLElement>('[role="tabpanel"]');
    const content = document.querySelector<HTMLElement>(".canvas-content");
    if (!canvas || !content) throw new Error("Canvas DOM was unavailable.");
    const originalRect = content.getBoundingClientRect();
    const left = leftValue === "nan" ? Number.NaN : leftValue;
    Object.defineProperty(content, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: originalRect.bottom,
        height: originalRect.height,
        left,
        right: left + originalRect.width,
        toJSON: () => ({}),
        top: originalRect.top,
        width: originalRect.width,
        x: left,
        y: originalRect.y,
      }),
    });
    canvas.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 100,
      clientY: originalRect.top + 100,
      composed: true,
      pointerId: 91,
    }));
    delete (content as HTMLElement & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
  }, canvasLeft);
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

async function counts(page: Page) {
  return page.evaluate(() => (window as unknown as { __arrowCounts: { apply: number; session: number } }).__arrowCounts);
}

async function resetCounts(page: Page) {
  await page.evaluate(() => { (window as unknown as { __arrowCounts: { apply: number; session: number } }).__arrowCounts = { apply: 0, session: 0 }; });
}

async function newestConnector(page: Page) {
  return page.evaluate(() => {
    const elements = (window as unknown as { __arrowWorkspace: { elements: Array<Record<string, unknown> & { type: string }> } }).__arrowWorkspace.elements;
    return [...elements].reverse().find((element) => element.type === "connector");
  });
}

async function expectNoDraftOrWrite(page: Page) {
  await expect(page.locator(".arrow-authoring-preview")).toHaveCount(0);
  expect((await counts(page)).apply).toBe(0);
}

async function installArrowWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string; type: string };
    const storageKey = "note-arrow-two-click-workspace";
    if (!sessionStorage.getItem(`${storageKey}:initialized`)) {
      localStorage.removeItem(storageKey);
      sessionStorage.setItem(`${storageKey}:initialized`, "true");
    }
    const style = { fillColor: null, roughness: 1, roundness: 0, seed: 17, strokeColor: { kind: "fixed", value: "#4c6ef5" }, strokeStyle: "solid", strokeWidth: 2 };
    const initial = {
      elements: [
        { createdAt: 1, height: 120, id: "target-shape", locked: false, opacity: 1, pageId: "page", rotation: 0, shape: "rectangle", style, type: "shape", updatedAt: 1, width: 180, x: 220, y: 220, zIndex: 1 },
        { createdAt: 1, height: 140, id: "overlap-low", locked: false, opacity: 1, pageId: "page", rotation: 0, shape: "rectangle", style, type: "shape", updatedAt: 1, width: 220, x: 520, y: 220, zIndex: 2 },
        { backgroundMode: "surface", content: "Locked text target", createdAt: 1, height: 100, id: "locked-text", locked: true, opacity: 1, pageId: "page", rotation: 0, type: "text", updatedAt: 1, width: 180, x: 540, y: 240, zIndex: 3 },
      ] as ElementRecord[],
      folders: [], isDarkMode: false,
      pages: [
        { folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Arrow authoring" },
        { folderId: "", id: "page-2", isBookmarked: false, revision: 0, title: "Second page" },
      ],
      sessionState: { isToolLocked: true, openPageTabIds: ["page", "page-2"], selectedFolderId: "", selectedPageId: "page" }, warnings: [],
    };
    const stored = localStorage.getItem(storageKey);
    const workspace = stored ? JSON.parse(stored) as typeof initial : initial;
    const persist = () => localStorage.setItem(storageKey, JSON.stringify(workspace));
    if (!stored) persist();
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __arrowCounts: { apply: number; session: number };
      __arrowWorkspace: typeof workspace;
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__arrowCounts = { apply: 0, session: 0 };
    runtime.__arrowWorkspace = workspace;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "arrow.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__arrowCounts.apply += 1;
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const deleted = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements.filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id)).map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        const pageRecord = workspace.pages.find((candidate) => candidate.id === batch.pageId)!;
        pageRecord.revision += 1;
        persist();
        return { newRevision: pageRecord.revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") { runtime.__arrowCounts.session += 1; workspace.sessionState = args.state as typeof workspace.sessionState; persist(); return; }
      if (command === "load_asset" || command === "save_asset") throw new Error(`Unexpected ${command}`);
      throw new Error(`Unexpected command ${command}`);
    } };
  });
}
