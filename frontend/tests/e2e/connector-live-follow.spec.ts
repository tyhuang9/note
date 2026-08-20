import { expect, test, type Locator, type Page } from "@playwright/test";

type Bounds = { x: number; y: number; width: number; height: number };

for (const zoom of [50, 100, 200]) {
  test(`locked bound arrows live-follow a group resize at ${zoom}% and persist exactly once`, async ({ page }) => {
    await installLiveFollowWorkspace(page);
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto("/");
    const canvas = page.getByRole("tabpanel");
    await selectBothTargets(page);
    await setZoom(page, canvas, zoom);

    const arrow = page.getByRole("button", { name: "Select locked arrow connector" });
    const text = page.locator('[data-block-id="target-text"]');
    const originalArrow = await roundedBounds(arrow, "original locked arrow");
    const originalText = await worldBox(text);
    const callsBefore = await persistenceCounts(page);

    const corner = zoom === 100 ? "se" : "nw";
    const handle = page.getByRole("button", { name: new RegExp(`Resize .* from ${corner}`) });
    await expect(handle).toBeInViewport();
    const handleBounds = await requiredBounds(handle, "selection resize handle");
    await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
    await page.mouse.down();
    const resizeDelta = corner === "se" ? { x: 70, y: 45 } : { x: -70, y: -45 };
    await page.mouse.move(handleBounds.x + handleBounds.width / 2 + resizeDelta.x, handleBounds.y + handleBounds.height / 2 + resizeDelta.y, { steps: 5 });

    const previews = page.locator(".connector-transform-preview");
    await expect(previews).toHaveCount(2);
    await expect(page.locator(".drag-layer-group .primitive-connector")).toHaveCount(0);
    await expect(arrow).not.toBeVisible();
    await expect.poll(() => roundedBounds(previews.first(), "locked connector resize preview")).not.toEqual(originalArrow);
    // Text reflows rather than scaling its own model geometry during group resize.
    await expect.poll(() => worldBox(text)).toEqual(originalText);

    await page.mouse.up();
    await expect(previews).toHaveCount(0);
    await expect(arrow).toBeVisible();
    await expect.poll(async () => (await persistenceCounts(page)).apply).toBe(callsBefore.apply + 1);
    expect((await persistenceCounts(page)).session).toBeLessThanOrEqual(callsBefore.session + 1);
    const resizedArrow = await roundedBounds(arrow, "resized arrow");
    expect(resizedArrow).not.toEqual(originalArrow);

    if (zoom !== 100) return;
    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => roundedBounds(arrow, "undone arrow")).toEqual(originalArrow);
    await expect.poll(async () => (await persistenceCounts(page)).apply).toBe(callsBefore.apply + 2);
    await page.keyboard.press("Control+y");
    await expect.poll(() => roundedBounds(arrow, "redone arrow")).toEqual(resizedArrow);
    await expect.poll(async () => (await persistenceCounts(page)).apply).toBe(callsBefore.apply + 3);
    const persistedBeforeReload = await persistedLiveScene(page);

    await page.reload();
    await expect(page.getByRole("button", { name: "Select locked arrow connector" })).toBeVisible();
    await setZoom(page, canvas, zoom);
    const persistedAfterReload = await persistedLiveScene(page);
    expect(persistedAfterReload).toEqual(persistedBeforeReload);
    const reloadedArrow = await roundedBounds(page.getByRole("button", { name: "Select locked arrow connector" }), "reloaded arrow");
    expect(reloadedArrow, `persisted scene: ${JSON.stringify(persistedAfterReload)}`).toEqual(resizedArrow);
    await expect.poll(() => persistedConnector(page)).toMatchObject(connectorRecord("locked-bound-bound"));
  });
}

test("edge auto-pan keeps locked bound arrows in a transient preview and cancel restores without writes", async ({ page }) => {
  await installLiveFollowWorkspace(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/");
  const canvas = page.getByRole("tabpanel");
  await selectBothTargets(page);
  const arrow = page.getByRole("button", { name: "Select locked arrow connector" });
  await page.waitForTimeout(650);
  await resetPersistenceCounts(page);
  const sceneBeforeDrag = await persistedLiveScene(page);
  const callsBefore = await persistenceCounts(page);
  const moveSurface = page.getByRole("button", { name: "Move selected elements" });
  const moveBounds = await requiredBounds(moveSurface, "selection move surface");
  const canvasBounds = await requiredBounds(canvas, "canvas");

  await page.mouse.move(moveBounds.x + moveBounds.width / 2, moveBounds.y + moveBounds.height / 2);
  await page.mouse.down();
  const canvasTransform = await page.locator(".canvas-content").getAttribute("style");
  await page.mouse.move(canvasBounds.x + canvasBounds.width - 2, canvasBounds.y + canvasBounds.height / 2, { steps: 8 });
  const preview = page.locator(".connector-transform-preview");
  await expect(preview).toHaveCount(2);
  await expect(page.locator(".drag-layer-group .primitive-connector")).toHaveCount(0);
  const freeBoundPath = await connectorPreviewPathSignature(preview.nth(1));
  await expect(arrow).not.toBeVisible();
  await page.waitForTimeout(400);
  await expect.poll(() => page.locator(".canvas-content").getAttribute("style")).not.toEqual(canvasTransform);
  await expect.poll(() => connectorPreviewPathSignature(preview.nth(1))).not.toEqual(freeBoundPath);

  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(arrow).toBeVisible();
  await expect.poll(() => persistedLiveScene(page)).toEqual(sceneBeforeDrag);
  await expect.poll(() => persistenceCounts(page)).toEqual(callsBefore);
});

async function selectBothTargets(page: Page) {
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  const rectangle = page.getByRole("button", { name: "Select and move rectangle element" });
  const textHeader = page.locator('[data-block-id="target-text"] .text-block-header');
  // Primitive selection is exposed through its keyboard semantic control;
  // text preserves its regular additive-header interaction.
  await rectangle.focus();
  await page.keyboard.press("Enter");
  await textHeader.click({ modifiers: ["Control"] });
  await expect(page.getByRole("button", { name: "Move selected elements" })).toBeVisible();
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  const current = Number.parseInt((await page.locator(".zoom-indicator").innerText()).replace("%", ""), 10);
  if (!Number.isFinite(current)) throw new Error("Current canvas zoom was unavailable.");
  const steps = Math.max(0, Math.round(Math.abs(percent - current) / 10));
  const key = percent < current ? "Control+-" : "Control+=";
  for (let index = 0; index < steps; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function requiredBounds(locator: Locator, label: string): Promise<Bounds> {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

function round(bounds: Bounds) {
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value)]));
}

async function roundedBounds(locator: Locator, label: string) {
  return round(await requiredBounds(locator, label));
}

async function connectorPreviewPathSignature(locator: Locator) {
  return locator.locator("path").evaluateAll((paths) => paths.map((path) => path.getAttribute("d") ?? "").join("|"));
}

async function worldBox(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: Number.parseFloat(style.height),
      width: Number.parseFloat(style.width),
    };
  });
}

async function persistenceCounts(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __noteLiveFollowCounts: { apply: number; session: number };
  }).__noteLiveFollowCounts);
}

async function resetPersistenceCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __noteLiveFollowCounts: { apply: number; session: number } }).__noteLiveFollowCounts = {
      apply: 0,
      session: 0,
    };
  });
}

async function persistedConnector(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __noteLiveFollowWorkspace: { elements: Array<{ id: string }> };
  }).__noteLiveFollowWorkspace.elements.find((element) => element.id === "locked-bound-bound"));
}

async function persistedLiveScene(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __noteLiveFollowWorkspace: { elements: Array<Record<string, unknown> & { id: string }> };
  }).__noteLiveFollowWorkspace.elements
    .filter((element) => ["target-shape", "target-text", "locked-bound-bound"].includes(element.id))
    .map(({ id, ...element }) => ({ id, ...element })));
}

function connectorRecord(id: string) {
  return {
    end: { anchor: { t: 0.75 }, gap: 0, kind: "element", targetElementId: "target-text" },
    id,
    start: { anchor: { t: 0.25 }, gap: 0, kind: "element", targetElementId: "target-shape" },
  };
}

async function installLiveFollowWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const storageKey = "note-live-follow-playwright-workspace";
    const initializationKey = `${storageKey}:initialized`;
    if (!sessionStorage.getItem(initializationKey)) {
      localStorage.removeItem(storageKey);
      sessionStorage.setItem(initializationKey, "true");
    }
    const stroke = {
      fillColor: null, roughness: 1, roundness: 0, seed: 17,
      strokeColor: { kind: "fixed", value: "#4c6ef5" }, strokeStyle: "solid", strokeWidth: 2,
    };
    const initialWorkspace = {
      elements: [
        {
          ...stroke, createdAt: 1, height: 120, id: "target-shape", locked: false, opacity: 1,
          pageId: "page", rotation: 0, shape: "rectangle", type: "shape", updatedAt: 1,
          width: 180, x: 210, y: 210, zIndex: 1, style: stroke,
        },
        {
          backgroundMode: "surface", content: "Resizable text target", createdAt: 1, height: 92,
          id: "target-text", locked: false, opacity: 1, pageId: "page", rotation: 0, type: "text",
          updatedAt: 1, width: 240, x: 560, y: 300, zIndex: 2,
        },
        {
          createdAt: 1, end: { anchor: { t: 0.75 }, gap: 0, kind: "element", targetElementId: "target-text" },
          id: "locked-bound-bound", locked: true, opacity: 1, pageId: "page", routing: "straight",
          start: { anchor: { t: 0.25 }, gap: 0, kind: "element", targetElementId: "target-shape" },
          style: { ...stroke, endArrowhead: "arrow", startArrowhead: "none" }, type: "connector", updatedAt: 1, zIndex: 3,
        },
        {
          createdAt: 1, end: { kind: "free", x: 920, y: 250 }, id: "free-bound", locked: false,
          opacity: 1, pageId: "page", routing: "straight",
          start: { anchor: { t: 0.5 }, gap: 0, kind: "element", targetElementId: "target-shape" },
          style: { ...stroke, endArrowhead: "arrow", startArrowhead: "none" }, type: "connector", updatedAt: 1, zIndex: 4,
        },
      ] as ElementRecord[],
      folders: [], isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Live connector follow" }],
      sessionState: { openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" }, warnings: [],
    };
    const storedWorkspace = localStorage.getItem(storageKey);
    const workspace = storedWorkspace
      ? JSON.parse(storedWorkspace) as typeof initialWorkspace
      : initialWorkspace;
    const persistWorkspace = () => localStorage.setItem(storageKey, JSON.stringify(workspace));
    if (!storedWorkspace) persistWorkspace();
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __noteLiveFollowCounts: { apply: number; session: number };
      __noteLiveFollowWorkspace: typeof workspace;
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__noteLiveFollowCounts = { apply: 0, session: 0 };
    runtime.__noteLiveFollowWorkspace = workspace;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "initialize_storage") return { databasePath: "live-follow.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
        if (command === "apply_scene_changes") {
          runtime.__noteLiveFollowCounts.apply += 1;
          const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
          const deleted = new Set(batch.deletedElementIds);
          const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
          workspace.elements = workspace.elements
            .filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id))
            .map((element) => upserts.get(element.id) ?? element);
          for (const element of batch.upserts) if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
          workspace.pages[0].revision += 1;
          persistWorkspace();
          return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
        }
        if (command === "save_session_state") {
          runtime.__noteLiveFollowCounts.session += 1;
          workspace.sessionState = args.state as typeof workspace.sessionState;
          persistWorkspace();
          return;
        }
        if (command === "load_asset") throw new Error("Unexpected asset load");
        if (command === "save_asset") throw new Error("Unexpected asset save");
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
}
