import { expect, test, type Locator, type Page } from "@playwright/test";

const STORAGE_KEY = "shape-drag-only-workspace";
const TOOL_NAMES = {
  rectangle: "Rectangle (R / 2)",
  ellipse: "Ellipse (O / 4)",
  diamond: "Diamond (D / 3)",
} as const;

type ShapeName = keyof typeof TOOL_NAMES;

test.beforeEach(async ({ page }) => {
  await installWorkspace(page);
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible();
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
      const pointerId = await beginCapturedDrag(page, start, { x: start.x + 3, y: start.y });
      await expect(page.locator(".primitive-authoring-preview")).toHaveCount(1);
      await dispatchCapturedTermination(page, pointerId, "pointercancel", { x: start.x + 3, y: start.y });
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

async function drag(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 3 });
  await page.mouse.up();
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
      __shapeDragWorkspace: Workspace;
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.__shapeDragCounts = { apply: 0, persistence: 0, session: 0 };
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
