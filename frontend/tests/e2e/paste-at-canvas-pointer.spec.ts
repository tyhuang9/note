import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await installPasteWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

for (const zoom of [50, 100, 200]) {
  test(`pastes copied groups around the live canvas pointer at ${zoom}%`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    await copyFixtureGroup(page);
    await setZoom(page, canvas, zoom);

    const pointer = await findCanvasPointOutsideChrome(page);
    await page.mouse.move(pointer.x, pointer.y);
    const transformBeforePan = await canvasTransform(page);
    await page.mouse.wheel(90, 70);
    await expect.poll(() => canvasTransform(page)).not.toBe(transformBeforePan);
    const expectedCenter = await clientToWorld(page, pointer);

    await resetApplyCount(page);
    await dispatchPaste(page);
    await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(4);
    const pasted = await pastedShapeGeometry(page);
    expect(pasted).toHaveLength(2);
    expect(pasted[1].x - pasted[0].x).toBeCloseTo(200, 5);
    expect(pasted[1].y - pasted[0].y).toBeCloseTo(140, 5);
    expect(groupCenter(pasted).x).toBeCloseTo(expectedCenter.x, 4);
    expect(groupCenter(pasted).y).toBeCloseTo(expectedCenter.y, 4);
    await expect.poll(() => applyCount(page)).toBe(1);

    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(2);
    await expect.poll(() => applyCount(page)).toBe(2);
    await page.keyboard.press("Control+y");
    await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(4);
    await expect.poll(() => applyCount(page)).toBe(3);

    const committed = await pastedShapeGeometry(page);
    await page.reload();
    await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(4);
    expect(await pastedShapeGeometry(page)).toEqual(committed);
  });
}

test("pointer leave and canvas chrome fall back to the current viewport center", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  await copyFixtureGroup(page);
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await page.mouse.move(canvasBounds.x + 120, canvasBounds.y + 140);
  const frameBounds = await requiredBounds(page.locator(".selection-frame"), "selection frame");
  await page.mouse.move(frameBounds.x + frameBounds.width / 2, frameBounds.y + frameBounds.height / 2);
  const expectedCenter = await clientToWorld(page, {
    x: canvasBounds.x + canvasBounds.width / 2,
    y: canvasBounds.y + canvasBounds.height / 2,
  });

  await resetApplyCount(page);
  await dispatchPaste(page);
  const pasted = await pastedShapeGeometry(page);
  expect(groupCenter(pasted).x).toBeCloseTo(expectedCenter.x, 4);
  expect(groupCenter(pasted).y).toBeCloseTo(expectedCenter.y, 4);
  await expect.poll(() => applyCount(page)).toBe(1);
});

test("a canvas pointerdown establishes the paste origin without a preceding move", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  await copyFixtureGroup(page);
  await page.mouse.move(4, 4);
  const canvasBounds = await requiredBounds(canvas, "canvas");
  const pointer = {
    x: canvasBounds.x + canvasBounds.width * 0.72,
    y: canvasBounds.y + canvasBounds.height * 0.7,
  };
  await canvas.dispatchEvent("pointerdown", {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX: pointer.x,
    clientY: pointer.y,
    isPrimary: true,
    pointerId: 41,
    pointerType: "mouse",
  });
  await canvas.dispatchEvent("pointerup", {
    bubbles: true,
    button: 0,
    buttons: 0,
    clientX: pointer.x,
    clientY: pointer.y,
    isPrimary: true,
    pointerId: 41,
    pointerType: "mouse",
  });
  const expectedCenter = await clientToWorld(page, pointer);

  await dispatchPaste(page);
  const pasted = await pastedShapeGeometry(page);
  expect(groupCenter(pasted).x).toBeCloseTo(expectedCenter.x, 4);
  expect(groupCenter(pasted).y).toBeCloseTo(expectedCenter.y, 4);
});

test("page changes clear the remembered pointer before returning to paste", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  await copyFixtureGroup(page);
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await page.mouse.move(canvasBounds.x + 120, canvasBounds.y + 140);
  const tabs = page.getByRole("tablist", { name: "Open pages" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).focus();
  await tabs.nth(1).press("Enter");
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(0);
  await tabs.first().focus();
  await tabs.first().press("Enter");
  await expect(page.locator('[data-canvas-element-type="shape"]')).toHaveCount(2);
  const returnedBounds = await requiredBounds(canvas, "returned canvas");
  const expectedCenter = await clientToWorld(page, {
    x: returnedBounds.x + returnedBounds.width / 2,
    y: returnedBounds.y + returnedBounds.height / 2,
  });

  await dispatchPaste(page);
  const pasted = await pastedShapeGeometry(page);
  expect(groupCenter(pasted).x).toBeCloseTo(expectedCenter.x, 4);
  expect(groupCenter(pasted).y).toBeCloseTo(expectedCenter.y, 4);
});

test("plain canvas text paste uses the current pointer without intercepting editor paste", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  const pointer = {
    x: canvasBounds.x + canvasBounds.width * 0.6,
    y: canvasBounds.y + canvasBounds.height * 0.55,
  };
  await page.mouse.move(pointer.x, pointer.y);
  const expectedCaret = await clientToWorld(page, pointer);
  await dispatchPaste(page, "Pointer text");

  const textBlock = page.locator('[data-canvas-element-type="text"]').last();
  const editor = textBlock.locator(".text-block-editor-content");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Pointer text");
  const position = await worldGeometry(textBlock);
  expect(position.x).toBeLessThan(expectedCaret.x);
  expect(position.y).toBeLessThan(expectedCaret.y);
  expect(expectedCaret.x - position.x).toBeLessThan(32);
  expect(expectedCaret.y - position.y).toBeLessThan(32);

  await editor.press("End");
  await dispatchPaste(page, " editor", ".text-block-editor-content");
  await expect(editor).toContainText("Pointer text");
  await expect(page.locator('[data-canvas-element-type="text"]')).toHaveCount(1);
});

async function copyFixtureGroup(page: Page) {
  const first = page.locator('[data-canvas-element-id="paste-shape-first"]');
  const second = page.locator('[data-canvas-element-id="paste-shape-second"]');
  await first.focus();
  await first.press("Enter");
  await second.focus();
  await page.keyboard.down("Control");
  await second.press("Enter");
  await page.keyboard.up("Control");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+c");
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  const steps = Math.abs(percent - 100) / 10;
  for (let index = 0; index < steps; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function dispatchPaste(page: Page, text = "", targetSelector?: string) {
  await page.evaluate(({ pastedText, selector }) => {
    const clipboardData = new DataTransfer();
    if (pastedText) clipboardData.setData("text/plain", pastedText);
    const target = selector ? document.querySelector(selector) : document;
    if (!target) throw new Error(`Paste target ${selector} was unavailable.`);
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }));
  }, { pastedText: text, selector: targetSelector });
}

async function findCanvasPointOutsideChrome(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('[role="tabpanel"]');
    if (!canvas) throw new Error("Canvas was unavailable.");
    const bounds = canvas.getBoundingClientRect();
    const chromeSelector = [
      ".canvas-tool-palette",
      ".drawing-properties-panel",
      ".offscreen-indicators",
      ".search-panel",
      ".selection-frame",
      ".connector-endpoint-chooser",
      ".global-text-toolbar",
      '[role="dialog"]',
      '[aria-modal="true"]',
    ].join(", ");
    for (const yRatio of [0.82, 0.7, 0.55, 0.35, 0.18]) {
      for (const xRatio of [0.82, 0.68, 0.5, 0.32, 0.18]) {
        const point = {
          x: bounds.left + bounds.width * xRatio,
          y: bounds.top + bounds.height * yRatio,
        };
        const target = document.elementFromPoint(point.x, point.y);
        if (target && !target.closest(chromeSelector)) return point;
      }
    }
    throw new Error("No canvas point outside chrome was available.");
  });
}

async function clientToWorld(page: Page, point: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector<HTMLElement>('[role="tabpanel"]');
    const content = document.querySelector<HTMLElement>(".canvas-content");
    if (!canvas || !content) throw new Error("Canvas transform was unavailable.");
    const canvasBounds = canvas.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(getComputedStyle(content).transform);
    return {
      x: (x - canvasBounds.left - transform.e) / transform.a,
      y: (y - canvasBounds.top - transform.f) / transform.d,
    };
  }, point);
}

async function canvasTransform(page: Page) {
  return page.locator(".canvas-content").evaluate((element) => getComputedStyle(element).transform);
}

async function pastedShapeGeometry(page: Page) {
  return page.locator('[data-canvas-element-type="shape"]').evaluateAll((elements) =>
    elements
      .filter((element) => !["paste-shape-first", "paste-shape-second"].includes(
        element.getAttribute("data-canvas-element-id") ?? "",
      ))
      .map((element) => {
        const htmlElement = element as HTMLElement;
        return {
          height: Number.parseFloat(htmlElement.style.height),
          width: Number.parseFloat(htmlElement.style.width),
          x: Number.parseFloat(htmlElement.style.left),
          y: Number.parseFloat(htmlElement.style.top),
        };
      }),
  );
}

function groupCenter(elements: readonly { height: number; width: number; x: number; y: number }[]) {
  const minX = Math.min(...elements.map((element) => element.x));
  const minY = Math.min(...elements.map((element) => element.y));
  const maxX = Math.max(...elements.map((element) => element.x + element.width));
  const maxY = Math.max(...elements.map((element) => element.y + element.height));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

async function worldGeometry(locator: Locator) {
  return locator.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    return {
      height: Number.parseFloat(htmlElement.style.height),
      width: Number.parseFloat(htmlElement.style.width),
      x: Number.parseFloat(htmlElement.style.left),
      y: Number.parseFloat(htmlElement.style.top),
    };
  });
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function applyCount(page: Page) {
  return page.evaluate(() => (window as unknown as { __pasteApplyCount: number }).__pasteApplyCount);
}

async function resetApplyCount(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __pasteApplyCount: number }).__pasteApplyCount = 0;
  });
}

async function installPasteWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const storageKey = "note-paste-pointer-playwright-workspace";
    const initialWorkspace = {
      elements: [
        {
          createdAt: 1,
          height: 80,
          id: "paste-shape-first",
          locked: false,
          opacity: 1,
          pageId: "paste-page",
          rotation: 0,
          shape: "rectangle",
          style: {
            fillColor: null,
            roughness: 1,
            roundness: 0,
            seed: 11,
            strokeColor: { kind: "fixed", value: "#4c6ef5" },
            strokeStyle: "solid",
            strokeWidth: 2,
          },
          type: "shape",
          updatedAt: 1,
          width: 120,
          x: 300,
          y: 220,
          zIndex: 1,
        },
        {
          createdAt: 1,
          height: 100,
          id: "paste-shape-second",
          locked: false,
          opacity: 1,
          pageId: "paste-page",
          rotation: 0,
          shape: "ellipse",
          style: {
            fillColor: null,
            roughness: 1,
            roundness: 0,
            seed: 12,
            strokeColor: { kind: "fixed", value: "#e8590c" },
            strokeStyle: "solid",
            strokeWidth: 2,
          },
          type: "shape",
          updatedAt: 1,
          width: 160,
          x: 500,
          y: 360,
          zIndex: 2,
        },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: true,
      pages: [
        { folderId: "", id: "paste-page", isBookmarked: false, revision: 0, title: "Paste pointer" },
        { folderId: "", id: "paste-page-second", isBookmarked: false, revision: 0, title: "Paste pointer second" },
      ],
      sessionState: { openPageTabIds: ["paste-page", "paste-page-second"], selectedFolderId: "", selectedPageId: "paste-page" },
      warnings: [],
    };
    const stored = localStorage.getItem(storageKey);
    const workspace = stored ? JSON.parse(stored) as typeof initialWorkspace : initialWorkspace;
    const runtime = window as unknown as {
      __pasteApplyCount: number;
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__pasteApplyCount = 0;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "paste-pointer.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__pasteApplyCount += 1;
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const deletedIds = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements
          .filter((element) => !deletedIds.has(element.id))
          .map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) {
          if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        }
        const page = workspace.pages.find((candidate) => candidate.id === batch.pageId);
        if (!page) throw new Error(`Unknown paste page ${batch.pageId}`);
        page.revision += 1;
        localStorage.setItem(storageKey, JSON.stringify(workspace));
        return { newRevision: page.revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") {
        workspace.sessionState = args.state as typeof workspace.sessionState;
        localStorage.setItem(storageKey, JSON.stringify(workspace));
        return;
      }
      return undefined;
    } };
  });
}
