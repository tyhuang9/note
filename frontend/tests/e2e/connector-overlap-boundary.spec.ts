import { expect, test, type Locator, type Page } from "@playwright/test";

type FixtureMode = "detachable" | "blocked" | "binding" | "preview-recovery";

test("two-click creation and chooser binding reject post-clearance maximum-envelope overshoot atomically", async ({ page }) => {
  await installExtremeOverlapWorkspace(page, "binding");
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");

  const canvas = page.getByRole("tabpanel");
  const status = page.locator('.canvas-accessibility-status[role="status"]');
  const targetBounds = await requiredBounds(
    page.locator('[data-canvas-element-id="edge-first"]'),
    "maximum-envelope target",
  );
  const targetCenter = {
    x: targetBounds.x + targetBounds.width / 2,
    y: targetBounds.y + targetBounds.height * 0.3,
  };
  const outsideTarget = { x: targetBounds.x + targetBounds.width + 40, y: targetCenter.y };
  await page.locator('.canvas-tool-palette [data-tool="arrow"]').click();
  await page.waitForTimeout(650);
  await resetCounts(page);
  await page.mouse.click(outsideTarget.x, outsideTarget.y);
  await page.mouse.move(targetCenter.x, targetCenter.y, { steps: 4 });
  await expect(page.locator('[data-connector-target-id="edge-first"]')).toHaveAttribute(
    "data-connector-binding-state",
    "snapped",
  );
  await page.mouse.click(targetCenter.x, targetCenter.y);

  await expect(status).toHaveText(
    "Arrow could not be created because its resolved endpoints exceed the safe canvas boundary.",
  );
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await expect.poll(() => currentIds(page)).toEqual(["edge-connector", "edge-first"]);

  await page.locator('.canvas-tool-palette [data-tool="select"]').click();
  const connector = page.locator('[data-canvas-element-id="edge-connector"]');
  await connector.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await startHandle.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await dialog.getByRole("button", { name: /^Rectangle 1 / }).click();
  const before = await currentConnector(page);
  await page.waitForTimeout(650);
  await resetCounts(page);
  await dialog.getByRole("button", { name: "Bind start endpoint" }).click();

  const chooserStatus = dialog.getByRole("status");
  await expect(chooserStatus).toHaveText(
    "Could not bind start endpoint because the connector's visible stroke would exceed the safe canvas boundary.",
  );
  expect(await chooserStatus.evaluate((element) => !element.closest("[inert]"))).toBe(true);
  await expect(dialog).toBeVisible();
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await expect.poll(() => currentConnector(page)).toEqual(before);
  await dialog.press("Escape");
  await expect(startHandle).toBeFocused();

  const startHandleBounds = await requiredBounds(startHandle, "free start endpoint");
  await page.waitForTimeout(650);
  await resetCounts(page);
  await page.mouse.move(startHandleBounds.x + startHandleBounds.width / 2, startHandleBounds.y + startHandleBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetCenter.x, targetCenter.y, { steps: 4 });
  await expect(status).toHaveText(
    "Could not bind start endpoint because the connector's visible stroke would exceed the safe canvas boundary.",
  );
  await page.mouse.up();

  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await expect.poll(() => currentConnector(page)).toEqual(before);
  await expect(status).toHaveText(
    "Could not bind start endpoint because the connector's visible stroke would exceed the safe canvas boundary.",
  );
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => currentConnector(page)).toEqual(before);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
});

test("retarget clears an invalid preview, recovers in the same capture, and releases atomically", async ({ page }) => {
  await installExtremeOverlapWorkspace(page, "preview-recovery");
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");

  const canvas = page.getByRole("tabpanel");
  const connector = page.locator('[data-canvas-element-id="edge-connector"]');
  await connector.focus();
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  const status = page.locator('.canvas-accessibility-status[role="status"]');
  const selectionFrame = page.locator(".selection-frame");
  const [startHandleBounds, safeTargetBounds, invalidTargetBounds, originalConnector, originalFrame] = await Promise.all([
    requiredBounds(startHandle, "free start endpoint"),
    requiredBounds(page.locator('[data-canvas-element-id="safe-target"]'), "safe target"),
    requiredBounds(page.locator('[data-canvas-element-id="edge-first"]'), "maximum-envelope target"),
    roundedBounds(connector),
    roundedBounds(selectionFrame),
  ]);
  const safePoint = {
    x: safeTargetBounds.x + safeTargetBounds.width / 2,
    y: safeTargetBounds.y + safeTargetBounds.height / 2,
  };
  const invalidPoint = {
    x: invalidTargetBounds.x + invalidTargetBounds.width / 2,
    y: invalidTargetBounds.y + invalidTargetBounds.height * 0.3,
  };
  const before = await currentConnector(page);
  await page.waitForTimeout(650);
  await resetCounts(page);

  await page.mouse.move(
    startHandleBounds.x + startHandleBounds.width / 2,
    startHandleBounds.y + startHandleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(safePoint.x, safePoint.y, { steps: 4 });
  await expect.poll(() => roundedBounds(connector)).not.toEqual(originalConnector);
  await expect.poll(() => roundedBounds(selectionFrame)).not.toEqual(originalFrame);

  await page.mouse.move(invalidPoint.x, invalidPoint.y, { steps: 4 });
  await expect.poll(() => roundedBounds(connector)).toEqual(originalConnector);
  await expect.poll(() => roundedBounds(selectionFrame)).toEqual(originalFrame);
  await expect(status).toHaveText(
    "Could not bind start endpoint because the connector's visible stroke would exceed the safe canvas boundary.",
  );

  await page.mouse.move(safePoint.x, safePoint.y, { steps: 4 });
  await expect.poll(() => roundedBounds(connector)).not.toEqual(originalConnector);
  await expect.poll(() => roundedBounds(selectionFrame)).not.toEqual(originalFrame);
  await expect(status).toHaveText(/Snapped to Rectangle 2 .*nearest facing visible boundary/);

  await page.mouse.move(invalidPoint.x, invalidPoint.y, { steps: 4 });
  await expect.poll(() => roundedBounds(connector)).toEqual(originalConnector);
  await expect.poll(() => roundedBounds(selectionFrame)).toEqual(originalFrame);
  await page.mouse.up();

  await expect(status).toHaveText(
    "Could not bind start endpoint because the connector's visible stroke would exceed the safe canvas boundary.",
  );
  await expect.poll(() => currentConnector(page)).toEqual(before);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => currentConnector(page)).toEqual(before);
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  const recoveredHandleBounds = await requiredBounds(startHandle, "recovered start endpoint");
  await page.mouse.move(
    recoveredHandleBounds.x + recoveredHandleBounds.width / 2,
    recoveredHandleBounds.y + recoveredHandleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(safePoint.x, safePoint.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => currentConnector(page)).toMatchObject({
    start: { gap: 0, kind: "element", targetElementId: "safe-target" },
  });
  await page.waitForTimeout(650);
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
});

test("a suppressed connector detaches safely at the positive canvas boundary and undo restores it", async ({ page }) => {
  await installExtremeOverlapWorkspace(page, "detachable");
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");

  const canvas = page.getByRole("tabpanel");
  const marker = page.getByRole("button", {
    name: "Arrow connector 1 hidden because its bound objects overlap. Manage connector.",
  });
  const connector = page.locator('[data-canvas-element-id="edge-connector"]');
  await expect(canvas).toBeVisible();
  await expect(marker).toBeVisible();
  await expect(connector).toHaveCount(0);

  // Pointer-select the marker, then detach through the keyboard chooser path.
  await marker.click();
  const start = page.getByRole("button", { name: "Manage Arrow connector 1 start endpoint" });
  const management = page.getByRole("group", { name: "Arrow connector 1 endpoint management" });
  const [canvasBounds, markerBounds, managementBounds] = await Promise.all([
    requiredBounds(canvas, "canvas"),
    requiredBounds(marker, "maximum-edge marker"),
    requiredBounds(management, "maximum-edge management"),
  ]);
  assertContained(managementBounds, canvasBounds);
  expect(rectangleDistance(markerBounds, managementBounds)).toBeLessThanOrEqual(12);
  await start.click();
  const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(650);
  await resetCounts(page);
  const detach = dialog.getByRole("button", { name: "Detach start endpoint" });
  await detach.focus();
  await page.keyboard.press("Space");

  await expect(marker).toHaveCount(0);
  await expect(connector).toBeVisible();
  await expect.poll(() => counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
  const detached = await currentConnector(page);
  expect(detached?.start).toMatchObject({ kind: "free" });
  const point = detached?.start as { kind: string; x?: number; y?: number } | undefined;
  expect(Number.isFinite(point?.x)).toBe(true);
  expect(Number.isFinite(point?.y)).toBe(true);
  expect(Math.abs(point?.x ?? Infinity)).toBeLessThanOrEqual(1_000_000);
  expect(Math.abs(point?.y ?? Infinity)).toBeLessThanOrEqual(1_000_000);

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(marker).toBeVisible();
  await expect.poll(() => currentConnector(page)).toMatchObject({
    start: { kind: "element", targetElementId: "edge-first" },
  });
});

test("an impossible maximum-envelope detach refuses delete and eraser atomically", async ({ page }) => {
  await installExtremeOverlapWorkspace(page, "blocked");
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");

  const canvas = page.getByRole("tabpanel");
  const marker = page.getByRole("button", {
    name: "Arrow connector 1 hidden because its bound objects overlap. Manage connector.",
  });
  const first = page.locator('[data-canvas-element-id="edge-first"]');
  const status = page.locator('.canvas-accessibility-status[role="status"]');
  await expect(canvas).toBeVisible();
  await expect(marker).toBeVisible();

  await first.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(650);
  await resetCounts(page);
  await page.keyboard.press("Delete");
  await expect(status).toHaveText(
    "Could not delete because a connector endpoint has no safe in-canvas detach position.",
  );
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await expect.poll(() => currentIds(page)).toEqual(["edge-connector", "edge-first", "edge-second"]);
  await page.keyboard.press("Control+z");
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await page.getByRole("button", { name: "Eraser (E / 0)" }).click();
  await page.waitForTimeout(650);
  await resetCounts(page);
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas bounds were unavailable.");
  await page.mouse.click(
    canvasBounds.x + canvasBounds.width / 2,
    canvasBounds.y + canvasBounds.height / 2,
  );
  await expect(status).toHaveText(
    "Could not erase because a connector endpoint has no safe in-canvas detach position.",
  );
  await expect.poll(() => counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  await expect.poll(() => currentIds(page)).toEqual(["edge-connector", "edge-first", "edge-second"]);
  await expect(marker).toBeVisible();
});

async function counts(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __edgeCounts: { apply: number; persistence: number; session: number };
  }).__edgeCounts);
}

async function resetCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as {
      __edgeCounts: { apply: number; persistence: number; session: number };
    }).__edgeCounts = { apply: 0, persistence: 0, session: 0 };
  });
}

async function currentConnector(page: Page) {
  return page.evaluate(() => (
    (window as unknown as { __edgeWorkspace: { elements: Array<Record<string, unknown> & { id: string }> } })
      .__edgeWorkspace.elements.find((element) => element.id === "edge-connector")
  ));
}

async function currentIds(page: Page) {
  return page.evaluate(() => (
    (window as unknown as { __edgeWorkspace: { elements: Array<{ id: string }> } })
      .__edgeWorkspace.elements.map((element) => element.id).sort()
  ));
}

function rectangleDistance(first: { height: number; width: number; x: number; y: number }, second: { height: number; width: number; x: number; y: number }) {
  const horizontal = Math.max(first.x - (second.x + second.width), second.x - (first.x + first.width), 0);
  const vertical = Math.max(first.y - (second.y + second.height), second.y - (first.y + first.height), 0);
  return Math.hypot(horizontal, vertical);
}

function assertContained(inner: { height: number; width: number; x: number; y: number }, outer: { height: number; width: number; x: number; y: number }) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function roundedBounds(locator: Locator) {
  const bounds = await requiredBounds(locator, "element");
  return {
    height: Math.round(bounds.height),
    width: Math.round(bounds.width),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  };
}

async function installExtremeOverlapWorkspace(page: Page, mode: FixtureMode) {
  await page.addInitScript((fixtureMode: FixtureMode) => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string; type: string };
    const storageKey = `note-connector-overlap-boundary-${fixtureMode}`;
    localStorage.removeItem(storageKey);
    const style = {
      fillColor: { kind: "fixed", value: "#111827" },
      roughness: 1,
      roundness: 0.18,
      seed: 73,
      strokeColor: { kind: "fixed", value: "#4c6ef5" },
      strokeStyle: "solid",
      strokeWidth: 2,
    };
    const blocked = fixtureMode === "blocked";
    const binding = fixtureMode === "binding" || fixtureMode === "preview-recovery";
    const previewRecovery = fixtureMode === "preview-recovery";
    const shapeGeometry = blocked
      ? { height: 1_000_000, width: 1_000_000, x: -500_000, y: -500_000 }
      : { height: 100, width: 100, x: binding ? 999_899 : 999_900, y: 300 };
    const gap = blocked ? 1_000_000 : 0;
    const initial = {
      elements: (binding ? [
        { createdAt: 1, id: "edge-first", locked: false, opacity: 1, pageId: "page", rotation: 0, shape: "rectangle", style, type: "shape", updatedAt: 1, ...shapeGeometry, zIndex: 2 },
        ...(previewRecovery ? [
          { createdAt: 1, height: 100, id: "safe-target", locked: false, opacity: 1, pageId: "page", rotation: 0, shape: "rectangle", style: { ...style, seed: 74 }, type: "shape", updatedAt: 1, width: 100, x: 999_400, y: 450, zIndex: 3 },
        ] : []),
        { createdAt: 1, end: { kind: "free", x: 1_000_000, y: 350 }, id: "edge-connector", locked: false, opacity: 1, pageId: "page", routing: "straight", start: { kind: "free", x: 999_700, y: 350 }, style: { ...style, endArrowhead: "arrow", fillColor: null, seed: 75, startArrowhead: "none" }, type: "connector", updatedAt: 1, zIndex: 8 },
      ] : [
        { createdAt: 1, id: "edge-first", locked: false, opacity: 1, pageId: "page", rotation: 0, shape: "rectangle", style, type: "shape", updatedAt: 1, ...shapeGeometry, zIndex: 2 },
        { createdAt: 1, id: "edge-second", locked: false, opacity: 1, pageId: "page", rotation: 0, shape: "ellipse", style: { ...style, seed: 74 }, type: "shape", updatedAt: 1, ...shapeGeometry, zIndex: 3 },
        { createdAt: 1, end: { gap: 0, kind: "element", targetElementId: "edge-second" }, id: "edge-connector", locked: false, opacity: 1, pageId: "page", routing: "straight", start: { gap, kind: "element", targetElementId: "edge-first" }, style: { ...style, endArrowhead: "arrow", fillColor: null, seed: 75, startArrowhead: "none" }, type: "connector", updatedAt: 1, zIndex: 8 },
      ]) as ElementRecord[],
      folders: [],
      isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Boundary overlap" }],
      sessionState: {
        openPageTabIds: ["page"],
        pageViewports: { page: { panOffset: blocked ? { x: 0, y: 0 } : { x: -999_300, y: 0 }, zoomLevel: 1 } },
        selectedFolderId: "",
        selectedPageId: "page",
      },
      warnings: [],
    };
    const workspace = initial;
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __edgeCounts: { apply: number; persistence: number; session: number };
      __edgeWorkspace: typeof workspace;
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__edgeCounts = { apply: 0, persistence: 0, session: 0 };
    runtime.__edgeWorkspace = workspace;
    const persist = () => {
      runtime.__edgeCounts.persistence += 1;
      localStorage.setItem(storageKey, JSON.stringify(workspace));
    };
    persist();
    runtime.__edgeCounts.persistence = 0;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "boundary-overlap.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__edgeCounts.apply += 1;
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const deleted = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements
          .filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id))
          .map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) {
          if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        }
        workspace.pages[0].revision += 1;
        persist();
        return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") {
        runtime.__edgeCounts.session += 1;
        workspace.sessionState = args.state as typeof workspace.sessionState;
        persist();
        return;
      }
      throw new Error(`Unexpected ${command}`);
    } };
  }, mode);
}
