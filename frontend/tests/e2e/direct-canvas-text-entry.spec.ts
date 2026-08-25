import { expect, test, type Locator, type Page } from "@playwright/test";

const STORAGE_KEY = "direct-canvas-text-entry-workspace";

test.beforeEach(async ({ page }) => {
  await installWorkspace(page);
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(700);
  await resetCounts(page);
});

test("single canvas clicks never arm typing and the Text tool waits for a double click", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const firstPoint = await blankPoint(canvas, 100);

  await page.mouse.click(firstPoint.x, firstPoint.y);
  await expect(page.locator(".canvas-caret")).toHaveCount(0);
  await page.keyboard.press("q");
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);
  await expect(page.locator(".text-block-editor-content")).toHaveCount(0);

  await page.getByRole("button", { name: /Text \(T \/ 8\)/ }).click();
  const secondPoint = { x: firstPoint.x - 90, y: firstPoint.y + 70 };
  await page.mouse.click(secondPoint.x, secondPoint.y);
  await expect(page.locator(".canvas-caret")).toHaveCount(0);
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);
  await page.waitForTimeout(600);

  await page.mouse.dblclick(secondPoint.x, secondPoint.y);
  await expect(page.locator(".text-block-editor-content")).toBeFocused();
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);
});

test("blank double click stays transient until one non-empty rich commit", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const selectedHeader = page.locator('[data-canvas-element-id="text-one"] .text-block-header');
  await selectedHeader.focus();
  await selectedHeader.press("Enter");

  for (const zoom of [50, 100, 200]) {
    await setZoom(page, canvas, zoom);
    const point = await blankPoint(canvas, zoom);
    await page.mouse.dblclick(point.x, point.y);
    const editor = page.locator(".text-block-editor-content");
    await expect(editor).toBeFocused();
    await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(2);
    await expect.poll(() => workspaceElements(page)).toHaveLength(4);
    await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

    const draftBounds = await requiredBounds(page.locator(".text-block").last(), "draft");
    expect(Math.abs(draftBounds.x - (point.x - 11 * (zoom / 100)))).toBeLessThanOrEqual(1);
    expect(Math.abs(draftBounds.y - (point.y - 20 * (zoom / 100)))).toBeLessThanOrEqual(1);

    await page.keyboard.press("Escape");
    await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);
    await expect(selectedHeader).toHaveAttribute("aria-pressed", "true");
    await expect(canvas).toBeFocused();
    await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  }

  await setZoom(page, canvas, 100);
  const emptyBlurPoint = await blankPoint(canvas, 100);
  await page.mouse.dblclick(emptyBlurPoint.x, emptyBlurPoint.y);
  await expect(page.locator(".text-block-editor-content")).toBeFocused();
  await selectedHeader.click();
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);
  await expect(selectedHeader).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toBeFocused();
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await panCanvas(page, canvas, { x: 80, y: 45 });
  const point = await blankPoint(canvas, 100);
  await page.mouse.dblclick(point.x, point.y);
  const editor = page.locator(".text-block-editor-content");
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("Direct rich text");
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const created = (await workspaceElements(page)).find((element) => element.id !== "text-one" && element.type === "text");
  if (!created) throw new Error("Committed direct text was unavailable");
  const createdBlock = page.locator(`[data-canvas-element-id="${created.id}"]`);
  await expect(createdBlock.locator(".text-block-display")).toHaveText("Direct rich text");
  await expect(createdBlock.locator(".text-block-header")).toBeFocused();
  expect(created?.content).toBe("Direct rich text");
  expect(JSON.stringify(created?.richContent)).toContain("Direct rich text");

  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);
  await page.keyboard.press("Control+y");
  await expect(page.locator(".text-block-display").last()).toHaveText("Direct rich text");
  await page.reload();
  await expect(page.locator(".text-block-display").last()).toHaveText("Direct rich text");
});

test("double click places a caret in formatted standalone and rotated locked shape text without writes", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const display = page.locator('[data-canvas-element-id="text-one"] .text-block-display');
  const standaloneText = "alpha beta gamma";

  for (const offset of [0, 7, standaloneText.length - 1]) {
    const point = await pointForTextOffset(display, offset);
    await page.mouse.dblclick(point.x, point.y);
    const editor = page.locator('[data-canvas-element-id="text-one"] .text-block-editor-content');
    await expect(editor).toBeFocused();
    expect(await selectionTextOffset(editor)).toBeGreaterThanOrEqual(Math.max(0, offset - 1));
    expect(await selectionTextOffset(editor)).toBeLessThanOrEqual(offset + 1);
    const canvasBounds = await requiredBounds(canvas, "canvas");
    await page.mouse.click(canvasBounds.x + canvasBounds.width - 70, canvasBounds.y + canvasBounds.height - 70);
    await expect(display).toBeVisible();
  }
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  const shape = page.locator('[data-canvas-element-id="shape-one"]');
  const shapeDisplay = shape.locator(".shape-contained-text-content");
  const shapePoint = await pointForTextOffset(shapeDisplay, 8);
  await page.mouse.dblclick(shapePoint.x, shapePoint.y);
  const shapeEditor = shape.locator(".shape-contained-text-editor-content");
  await expect(shapeEditor).toBeFocused();
  await expect(shapeEditor).toHaveAccessibleDescription(/Escape cancels this shape text edit.*Control\+Enter.*Command\+Enter saves/i);
  await expect(shapeEditor).toHaveAttribute("aria-keyshortcuts", "Escape Control+Enter Meta+Enter");
  expect(await selectionTextOffset(shapeEditor)).toBeGreaterThanOrEqual(7);
  expect(await selectionTextOffset(shapeEditor)).toBeLessThanOrEqual(9);
  await dispatchEditorKey(shapeEditor, { isComposing: true, key: "Escape" });
  await dispatchEditorKey(shapeEditor, { key: "Escape", repeat: true });
  await dispatchEditorKey(shapeEditor, { ctrlKey: true, key: "Enter", repeat: true });
  await dispatchEditorKey(shapeEditor, { altKey: true, ctrlKey: true, key: "Enter" });
  await dispatchEditorKey(shapeEditor, { ctrlKey: true, key: "Enter", shiftKey: true });
  await dispatchLegacyCompositionKey(shapeEditor);
  await expect(shapeEditor).toBeFocused();
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await page.keyboard.press("Escape");
  await expect(shape).toHaveAttribute("aria-label", /Select locked rectangle shape/);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await shape.focus();
  await shape.press("F2");
  await expect(shapeEditor).toBeFocused();
  expect(await selectionTextOffset(shapeEditor)).toBe("rotated shape text".length);
  await page.keyboard.press("Escape");

  const frontShape = page.locator('[data-canvas-element-id="shape-front"]');
  const frontBounds = await requiredBounds(frontShape, "front overlap shape");
  await page.mouse.dblclick(
    frontBounds.x + frontBounds.width / 2,
    frontBounds.y + frontBounds.height / 2,
  );
  await expect(frontShape.locator(".shape-contained-text-editor-content")).toBeFocused();
  await expect(page.locator('[data-canvas-element-id="shape-back"] .shape-contained-text-editor-content')).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("keyboard text authoring is discoverable, guarded, and honors tool lock", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const textTool = page.getByRole("button", { name: /Text \(T \/ 8\)/ });
  const status = page.locator('.canvas-accessibility-status[role="status"]');

  for (const zoom of [50, 100, 200]) {
    await setZoom(page, canvas, zoom);
    if (zoom === 100) await panCanvas(page, canvas, { x: 65, y: 35 });
    await textTool.click();
    await expect(canvas).toHaveAttribute("aria-keyshortcuts", "Enter");
    await expect(canvas).toHaveAccessibleDescription(/Text tool selected.*press Enter/i);
    await canvas.focus();
    await page.keyboard.press("Enter");
    const editor = page.locator(".text-block-editor-content");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveAccessibleName("New text block");
    await expect(editor).toHaveAccessibleDescription(/Escape cancels.*Control\+Enter.*Command\+Enter saves/i);
    await expect(editor).toHaveAttribute("aria-keyshortcuts", "Escape Control+Enter Meta+Enter");
    await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
    if (zoom === 50) {
      await page.keyboard.insertText("IME-safe draft");
      await dispatchEditorKey(editor, { isComposing: true, key: "Escape" });
      await dispatchEditorKey(editor, { key: "Escape", repeat: true });
      await dispatchEditorKey(editor, { ctrlKey: true, key: "Enter", repeat: true });
      await dispatchEditorKey(editor, { altKey: true, ctrlKey: true, key: "Enter" });
      await dispatchEditorKey(editor, { ctrlKey: true, key: "Enter", shiftKey: true });
      await dispatchLegacyCompositionKey(editor);
      await expect(editor).toBeFocused();
      await expect(editor).toHaveText("IME-safe draft");
      await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(2);
      await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
    }
    await page.keyboard.press("Escape");
    await expect(textTool).toHaveAttribute("aria-pressed", "true");
    await expect(canvas).toBeFocused();
  }

  await canvas.focus();
  await dispatchCanvasEnter(canvas, { ctrlKey: true });
  await dispatchCanvasEnter(canvas, { repeat: true });
  await dispatchCanvasEnter(canvas, { isComposing: true });
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);

  await page.keyboard.press("Control+f");
  await expect(page.getByRole("textbox", { name: "Find in canvas" })).toBeFocused();
  await expect(canvas).not.toHaveAttribute("aria-keyshortcuts");
  await page.keyboard.press("Escape");

  await page.locator("[data-tool-lock]").click();
  await textTool.click();
  await canvas.focus();
  await page.waitForTimeout(600);
  await resetCounts(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(".text-block-editor-content")).toBeFocused();
  await page.keyboard.insertText("Locked keyboard text");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  await expect(textTool).toHaveAttribute("aria-pressed", "true");
  await expect(status).toContainText("Text block created");
});

test("text cursor is limited to text surfaces and active editing blocks other canvas entry", async ({ page }) => {
  const text = page.locator('[data-canvas-element-id="text-one"]');
  const display = text.locator(".text-block-display");
  const header = text.locator(".text-block-header");
  const shape = page.locator('[data-canvas-element-id="shape-one"]');
  await expect(display).toHaveCSS("cursor", "text");
  await expect(header).toHaveCSS("cursor", "move");
  await expect(shape.locator(".shape-contained-text-display")).toHaveCSS("cursor", "text");
  await expect(shape).not.toHaveCSS("cursor", "text");

  await display.click();
  await expect(header).toHaveAttribute("aria-pressed", "true");
  await expect(text.locator(".text-block-editor-content")).toHaveCount(0);

  const canvas = page.getByRole("tabpanel");
  const point = await blankPoint(canvas, 100);
  await page.mouse.dblclick(point.x, point.y);
  await expect(page.locator(".text-block-editor-content")).toBeFocused();
  await page.keyboard.insertText("/");
  await expect(page.locator(".slash-command-menu")).toBeVisible();
  await canvas.dispatchEvent("dblclick", { button: 0, clientX: point.x + 180, clientY: point.y + 120 });
  await expect(page.locator(".text-block-editor-content")).toHaveCount(1);
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(2);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
});

async function blankPoint(canvas: Locator, zoom: number) {
  const bounds = await requiredBounds(canvas, "canvas");
  return {
    x: bounds.x + bounds.width - 300 - zoom / 10,
    y: bounds.y + 145 + zoom / 20,
  };
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  for (let index = 0; index < Math.abs(percent - 100) / 10; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
  await page.waitForTimeout(500);
  await resetCounts(page);
}

async function panCanvas(page: Page, canvas: Locator, delta: { x: number; y: number }) {
  const bounds = await requiredBounds(canvas, "canvas");
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await canvas.focus();
  await page.keyboard.down("Space");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta.x, start.y + delta.y);
  await page.mouse.up();
  await page.keyboard.up("Space");
  await page.waitForTimeout(500);
  await resetCounts(page);
}

async function dispatchCanvasEnter(canvas: Locator, init: Record<string, boolean>) {
  await canvas.evaluate((element, eventInit) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", ...eventInit }));
  }, init);
}

async function dispatchEditorKey(
  editor: Locator,
  init: Readonly<Partial<KeyboardEventInit> & { key: string }>,
) {
  await editor.evaluate((element, eventInit) => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...eventInit,
    }));
  }, init);
}

async function dispatchLegacyCompositionKey(editor: Locator) {
  await editor.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    Object.defineProperty(event, "keyCode", { value: 229 });
    element.dispatchEvent(event);
  });
}

function pointForTextOffset(content: Locator, targetOffset: number) {
  return content.evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (remaining < length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, Math.min(length, remaining + 1));
        const rect = range.getBoundingClientRect();
        for (const yRatio of [0.5, 0.35, 0.65, 0.2, 0.8]) {
          for (const xRatio of [0.5, 0.35, 0.65, 0.2, 0.8]) {
            const point = { x: rect.left + rect.width * xRatio, y: rect.top + rect.height * yRatio };
            const hit = document.elementFromPoint(point.x, point.y);
            if (hit && element.contains(hit)) return point;
          }
        }
        throw new Error("The requested rendered character is covered or offscreen");
      }
      remaining -= length;
      node = walker.nextNode();
    }
    const rect = element.getBoundingClientRect();
    return { x: rect.right - 2, y: rect.top + rect.height / 2 };
  }, targetOffset);
}

function selectionTextOffset(editor: Locator) {
  return editor.evaluate((element) => {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !element.contains(selection.anchorNode)) return -1;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString().length;
  });
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds unavailable`);
  return bounds;
}

async function counts(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __directTextCounts: { apply: number; persistence: number; session: number };
  }).__directTextCounts);
}

async function resetCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as {
      __directTextCounts: { apply: number; persistence: number; session: number };
    }).__directTextCounts = { apply: 0, persistence: 0, session: 0 };
  });
}

async function workspaceElements(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __directTextWorkspace: { elements: Array<Record<string, unknown> & { id: string; type: string }> };
  }).__directTextWorkspace.elements);
}

async function installWorkspace(page: Page) {
  await page.addInitScript((storageKey) => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    type Workspace = {
      elements: ElementRecord[];
      folders: unknown[];
      isDarkMode: boolean;
      pages: Array<{ folderId: string; id: string; isBookmarked: boolean; revision: number; title: string }>;
      sessionState: Record<string, unknown>;
      warnings: unknown[];
    };
    const workspace: Workspace = JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? {
      elements: [
        {
          backgroundMode: "solid", content: "alpha beta gamma", createdAt: 1, height: 80,
          id: "text-one", isWidthManuallyResized: true, locked: false, opacity: 1,
          pageId: "page-one", richContent: { type: "doc", content: [{ type: "paragraph", content: [
            { type: "text", text: "alpha " }, { type: "text", marks: [{ type: "bold" }], text: "beta" }, { type: "text", text: " gamma" },
          ] }] }, rotation: 0, type: "text", updatedAt: 1, width: 300, x: 360, y: 390, zIndex: 0,
        },
        {
          createdAt: 1, height: 170, id: "shape-one", locked: true, opacity: 1, pageId: "page-one",
          rotation: 32, shape: "rectangle", style: { fillColor: null, roughness: 0.5, roundness: 0.6, seed: 41,
            strokeColor: { kind: "theme", token: "foreground" }, strokeStyle: "solid", strokeWidth: 2 },
          text: { content: "rotated shape text", richContent: { type: "doc", content: [{ type: "paragraph", content: [
            { type: "text", text: "rotated " }, { type: "text", marks: [{ type: "italic" }], text: "shape" }, { type: "text", text: " text" },
          ] }] } }, type: "shape", updatedAt: 1, width: 280, x: 600, y: 330, zIndex: 1,
        },
        {
          createdAt: 1, height: 140, id: "shape-front", locked: false, opacity: 1, pageId: "page-one",
          rotation: 0, shape: "rectangle", style: { fillColor: null, roughness: 0.5, roundness: 0.4, seed: 42,
            strokeColor: { kind: "theme", token: "foreground" }, strokeStyle: "solid", strokeWidth: 2 },
          text: { content: "front overlay" }, type: "shape", updatedAt: 1, width: 240, x: 600, y: 520, zIndex: 30,
        },
        {
          createdAt: 1, height: 140, id: "shape-back", locked: false, opacity: 1, pageId: "page-one",
          rotation: 0, shape: "rectangle", style: { fillColor: null, roughness: 0.5, roundness: 0.4, seed: 43,
            strokeColor: { kind: "theme", token: "foreground" }, strokeStyle: "solid", strokeWidth: 2 },
          text: { content: "back overlay" }, type: "shape", updatedAt: 1, width: 240, x: 600, y: 520, zIndex: 20,
        },
      ],
      folders: [], isDarkMode: false,
      pages: [{ folderId: "", id: "page-one", isBookmarked: false, revision: 0, title: "Direct text" }],
      sessionState: { openPageTabIds: ["page-one"], pageViewports: { "page-one": { panOffset: { x: 0, y: 0 }, zoomLevel: 1 } }, selectedFolderId: "", selectedPageId: "page-one" },
      warnings: [],
    };
    const runtime = window as unknown as {
      __directTextCounts: { apply: number; persistence: number; session: number };
      __directTextWorkspace: Workspace;
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    const persist = () => localStorage.setItem(storageKey, JSON.stringify(workspace));
    runtime.__directTextCounts = { apply: 0, persistence: 0, session: 0 };
    runtime.__directTextWorkspace = workspace;
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "direct-text.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__directTextCounts.apply += 1;
        runtime.__directTextCounts.persistence += 1;
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const deleted = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements
          .filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id))
          .map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        const pageRecord = workspace.pages.find((candidate) => candidate.id === batch.pageId);
        if (pageRecord) pageRecord.revision += 1;
        persist();
        return { newRevision: pageRecord?.revision ?? 0, pageId: batch.pageId };
      }
      if (command === "save_session_state") {
        runtime.__directTextCounts.session += 1;
        runtime.__directTextCounts.persistence += 1;
        workspace.sessionState = args.state as Record<string, unknown>;
        persist();
        return undefined;
      }
      if (command === "load_asset" || command === "save_asset") throw new Error(`Unexpected ${command}`);
      return undefined;
    } };
  }, STORAGE_KEY);
}
