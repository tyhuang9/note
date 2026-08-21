import { expect, test, type Locator, type Page } from "@playwright/test";

type Bounds = { x: number; y: number; width: number; height: number };

test("a 30 degree text east resize keeps its west midpoint fixed through preview, connector follow, and commit", async ({ page }) => {
  await installLiveFollowWorkspace(page, 30);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");

  const text = page.locator('[data-block-id="target-text"]');
  const arrow = page.getByRole("button", { name: "Select locked arrow connector" });
  await text.locator(".text-block-display").click();
  const handle = page.getByRole("button", { name: "Resize text width" });
  const handleBounds = await requiredBounds(handle, "rotated text resize handle");
  const originalWest = await rotatedWestMidpoint(text);
  await page.waitForTimeout(650);
  await resetPersistenceCounts(page);
  const callsBefore = await persistenceCounts(page);
  const originalArrow = await roundedBounds(arrow, "original rotated connector");
  const start = {
    x: handleBounds.x + handleBounds.width / 2,
    y: handleBounds.y + handleBounds.height / 2,
  };
  const localAxis = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80 * localAxis.x, start.y + 80 * localAxis.y, { steps: 6 });

  const previewBounds = await roundedBounds(text, "rotated text resize preview");
  await expectTextResizeGripAligned(handle, text);
  const previewWest = await rotatedWestMidpoint(text);
  expect(previewWest.x).toBeCloseTo(originalWest.x, 1);
  expect(previewWest.y).toBeCloseTo(originalWest.y, 1);
  const connectorPreviews = page.locator(".connector-transform-preview");
  await expect(connectorPreviews).toHaveCount(1);
  await expect(arrow).not.toBeVisible();
  await expect.poll(() => roundedBounds(connectorPreviews, "rotated connector preview")).not.toEqual(originalArrow);
  expect(await persistenceCounts(page)).toEqual(callsBefore);

  await page.mouse.up();
  await expect(connectorPreviews).toHaveCount(0);
  await expect(arrow).toBeVisible();
  await expect.poll(() => roundedBounds(text, "committed rotated text")).toEqual(previewBounds);
  await expectTextResizeGripAligned(handle, text);
  const committedWest = await rotatedWestMidpoint(text);
  expect(committedWest.x).toBeCloseTo(originalWest.x, 1);
  expect(committedWest.y).toBeCloseTo(originalWest.y, 1);
  await expect.poll(async () => (await persistenceCounts(page)).apply).toBe(callsBefore.apply + 1);
  expect((await persistenceCounts(page)).session).toBe(callsBefore.session + 1);
});

for (const { rotation, darkMode, cursor } of [
  { rotation: 0, darkMode: false, cursor: "ew-resize" },
  { rotation: 30, darkMode: false, cursor: "nwse-resize" },
  { rotation: 90, darkMode: true, cursor: "ns-resize" },
]) {
  test(`text east resize grip aligns and exposes its ${rotation} degree cursor`, async ({ page }) => {
    await installLiveFollowWorkspace(page, rotation);
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto("/");
    if (darkMode) {
      await page.getByRole("button", { name: "Dark mode" }).click();
      await expect(page.locator(".app-shell")).toHaveClass(/is-dark/);
    } else {
      await expect(page.locator(".app-shell")).not.toHaveClass(/is-dark/);
    }

    const text = page.locator('[data-block-id="target-text"]');
    await text.locator(".text-block-display").click();
    const handle = page.getByRole("button", { name: "Resize text width" });
    await expect(handle).toHaveCSS("cursor", cursor);
    expect(await handle.evaluate((element) => (element as HTMLElement).style.transform)).toBe(`rotate(${rotation}deg)`);
    await expectTextResizeGripAligned(handle, text);
  });
}

test("a no-motion text east grip interaction cleans the preview without writes", async ({ page }) => {
  await installLiveFollowWorkspace(page, 30);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");

  const text = page.locator('[data-block-id="target-text"]');
  const arrow = page.getByRole("button", { name: "Select locked arrow connector" });
  await text.locator(".text-block-display").click();
  const handle = page.getByRole("button", { name: "Resize text width" });
  const handleBounds = await requiredBounds(handle, "text resize handle");
  await page.waitForTimeout(650);
  await resetPersistenceCounts(page);
  const callsBefore = await persistenceCounts(page);

  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  await expect(text).not.toHaveClass(/is-resizing/);
  await expect(page.locator("body")).not.toHaveClass(/is-interacting/);
  await expect(page.locator(".connector-transform-preview")).toHaveCount(0);
  await expect(arrow).toBeVisible();
  await expect.poll(() => persistenceCounts(page)).toEqual(callsBefore);
});

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

test("keyboard endpoint chooser describes rotated text targets and binds a target-relative anchor", async ({ page }) => {
  await installLiveFollowWorkspace(page, 37.6);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");

  const arrow = page.getByRole("button", { name: "Select and move arrow connector" }).last();
  await arrow.focus();
  await page.keyboard.press("Enter");
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  const description = page.locator("#connector-end-endpoint-description");
  await expect(endHandle).toBeVisible();
  await expect(description).toContainText("Currently free. Press Enter to choose a target shape or text block and a target-relative boundary position.");

  await endHandle.focus();
  await page.keyboard.press("Space");
  const dialog = page.getByRole("dialog", { name: "Choose end endpoint target" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Cardinal presets and the one-degree range rotate with the target.")).toBeVisible();

  const textTarget = dialog.getByRole("button", { name: /Text 1 \(Resizable text target\)/ });
  await textTarget.focus();
  await page.keyboard.press("Space");
  const rightAnchor = dialog.getByRole("button", { name: /Right anchor on Text 1 \(Resizable text target\).*target rotated 38 degrees/ });
  await rightAnchor.focus();
  await expect(rightAnchor).toBeFocused();
  await page.keyboard.press("Space");
  await dialog.getByRole("button", { name: "Bind end endpoint" }).focus();
  await page.keyboard.press("Space");

  await expect(description).toContainText("Currently bound to Text 1 (Resizable text target)");
  await expect(description).toContainText("target-relative right anchor, target rotated 38 degrees.");
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

async function rotatedWestMidpoint(locator: Locator) {
  return locator.evaluate((element) => {
    const block = element as HTMLElement;
    const bounds = block.getBoundingClientRect();
    const rotation = Number.parseFloat(block.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] ?? "0");
    const width = Number.parseFloat(block.style.width);
    const angle = rotation * Math.PI / 180;
    return {
      x: bounds.x + bounds.width / 2 - width / 2 * Math.cos(angle),
      y: bounds.y + bounds.height / 2 - width / 2 * Math.sin(angle),
    };
  });
}

async function rotatedEastMidpoint(locator: Locator) {
  return locator.evaluate((element) => {
    const block = element as HTMLElement;
    const canvas = block.closest<HTMLElement>(".canvas");
    const worldLayer = canvas?.querySelector<HTMLElement>(".canvas-content");
    if (!canvas || !worldLayer) throw new Error("Text east midpoint was missing its canvas geometry.");
    const canvasBounds = canvas.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(getComputedStyle(worldLayer).transform);
    const rotation = Number.parseFloat(block.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] ?? "0");
    const width = Number.parseFloat(block.style.width);
    const height = Number.parseFloat(block.style.height);
    const left = Number.parseFloat(block.style.left);
    const top = Number.parseFloat(block.style.top);
    const angle = rotation * Math.PI / 180;
    return {
      x: canvasBounds.x + transform.e + transform.a * (left + width / 2 + width / 2 * Math.cos(angle)),
      y: canvasBounds.y + transform.f + transform.d * (top + height / 2 + width / 2 * Math.sin(angle)),
    };
  });
}

async function expectTextResizeGripAligned(handle: Locator, text: Locator) {
  const handleBounds = await requiredBounds(handle, "text resize grip");
  const east = await rotatedEastMidpoint(text);
  expect(handleBounds.x + handleBounds.width / 2).toBeCloseTo(east.x, 1);
  expect(handleBounds.y + handleBounds.height / 2).toBeCloseTo(east.y, 1);
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

async function installLiveFollowWorkspace(page: Page, targetTextRotation = 0) {
  await page.addInitScript((rotation) => {
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
          id: "target-text", locked: false, opacity: 1, pageId: "page", rotation, type: "text",
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
  }, targetTextRotation);
}
