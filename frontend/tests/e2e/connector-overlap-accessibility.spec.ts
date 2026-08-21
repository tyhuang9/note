import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await installOverlapWorkspace(page);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("an overlap-suppressed connector stays visibly keyboard-manageable for rebind, detach, delete, and undo", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const connectorBody = page.locator('[data-canvas-element-id="overlap-connector"]');
  const marker = page.getByRole("button", {
    name: "Arrow connector 1 hidden because its bound objects overlap. Manage connector.",
  });
  const status = page.locator('.canvas-accessibility-status[role="status"]');

  await expect(connectorBody).toHaveCount(0);
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute("aria-expanded", "false");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await expect(status).toHaveText(
    "Arrow connector 1 hidden because its bound objects overlap. Use its visible marker to manage endpoints.",
  );
  const markerBounds = await requiredBounds(marker, "suppressed connector marker");
  expect(markerBounds.width).toBeGreaterThanOrEqual(44);
  expect(markerBounds.height).toBeGreaterThanOrEqual(44);
  const targets = await Promise.all([
    requiredBounds(page.locator('[data-canvas-element-id="overlap-source"]'), "overlap source"),
    requiredBounds(page.locator('[data-canvas-element-id="overlap-destination"]'), "overlap destination"),
  ]);
  expect(targets.every((target) => !rectanglesIntersect(markerBounds, target))).toBe(true);

  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(marker).toHaveAttribute("aria-expanded", "true");
  const start = page.getByRole("button", { name: "Manage Arrow connector 1 start endpoint" });
  const end = page.getByRole("button", { name: "Manage Arrow connector 1 end endpoint" });
  const remove = page.getByRole("button", { name: "Delete Arrow connector 1" });
  await expect(start).toBeVisible();
  await expect(end).toBeVisible();
  await expect(remove).toBeVisible();
  for (const control of [start, end, remove]) {
    const bounds = await requiredBounds(control, "suppressed connector management control");
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }

  // Escape is dispatched synchronously after opening, before the chooser's
  // requestAnimationFrame focus move can run.
  await start.focus();
  await start.evaluate((button) => {
    button.click();
    document.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    }));
  });
  await expect(page.getByRole("dialog", { name: "Choose start endpoint target" })).toHaveCount(0);
  await expect(start).toBeFocused();

  await page.keyboard.press("Enter");
  const rebindDialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await expect(rebindDialog).toBeVisible();
  await rebindDialog.getByRole("button", { name: /^Diamond 1 / }).click();
  await rebindDialog.getByRole("button", { name: "Bind start endpoint" }).click();
  await expect(marker).toHaveCount(0);
  await expect(connectorBody).toBeVisible();
  await expect(status).toHaveText("Arrow connector 1 restored. Its route is visible again.");
  await expect(page.getByRole("button", { name: "Move connector start endpoint" })).toBeFocused();

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(marker).toBeVisible();
  await expect(connectorBody).toHaveCount(0);
  await expect(status).toHaveText(
    "Arrow connector 1 hidden because its bound objects overlap. Use its visible marker to manage endpoints.",
  );

  await marker.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Manage Arrow connector 1 start endpoint" }).focus();
  await page.keyboard.press("Enter");
  const detachDialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await detachDialog.getByRole("button", { name: "Detach start endpoint" }).focus();
  await page.keyboard.press("Enter");
  await expect(marker).toHaveCount(0);
  await expect(connectorBody).toBeVisible();
  await expect(status).toHaveText("Arrow connector 1 restored. Its route is visible again.");

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(marker).toBeVisible();
  await page.setViewportSize({ width: 760, height: 700 });
  const compactCanvasBounds = await requiredBounds(canvas, "compact canvas");
  const compactMarkerBounds = await requiredBounds(marker, "compact suppressed connector marker");
  expect(compactMarkerBounds.x).toBeGreaterThanOrEqual(compactCanvasBounds.x);
  expect(compactMarkerBounds.y).toBeGreaterThanOrEqual(compactCanvasBounds.y);
  expect(compactMarkerBounds.x + compactMarkerBounds.width).toBeLessThanOrEqual(compactCanvasBounds.x + compactCanvasBounds.width);
  expect(compactMarkerBounds.y + compactMarkerBounds.height).toBeLessThanOrEqual(compactCanvasBounds.y + compactCanvasBounds.height);
  await marker.focus();
  await page.keyboard.press("Enter");
  const compactManagement = page.getByRole("group", { name: "Arrow connector 1 endpoint management" });
  const compactManagementBounds = await requiredBounds(compactManagement, "compact connector management");
  expect(compactManagementBounds.x).toBeGreaterThanOrEqual(compactCanvasBounds.x);
  expect(compactManagementBounds.x + compactManagementBounds.width).toBeLessThanOrEqual(compactCanvasBounds.x + compactCanvasBounds.width);
  const deleteButton = page.getByRole("button", { name: "Delete Arrow connector 1" });
  await deleteButton.focus();
  await resetCounts(page);
  await page.keyboard.press("Enter");
  await expect(marker).toHaveCount(0);
  await expect(connectorBody).toHaveCount(0);
  await expect(status).toHaveText("Deleted Arrow connector 1. Undo is available.");
  await expect.poll(async () => (await counts(page)).apply).toBe(1);

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(marker).toBeVisible();
  await expect.poll(() => currentConnector(page)).toMatchObject({
    end: { kind: "element", targetElementId: "overlap-destination" },
    start: { kind: "element", targetElementId: "overlap-source" },
  });
});

test("whole-object near and snapped halos retain dual contrast in light, dark, matching-fill, and forced-colors modes", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const target = page.locator('[data-canvas-element-id="remote-target"]');

  await openHighlight(page, canvas);
  const highlight = page.locator('[data-connector-target-id="remote-target"]');
  await expect(highlight).toHaveAttribute("data-connector-binding-state", "near");
  await assertDualContrast(highlight, target, canvas);
  const nearDash = await highlight.locator(".connector-binding-target-halo-inner").evaluate(
    (element) => getComputedStyle(element).strokeDasharray,
  );
  expect(nearDash).not.toBe("none");

  const boundary = await remoteTargetBoundary(page);
  await page.mouse.move(boundary.x, boundary.y, { steps: 3 });
  await expect(highlight).toHaveAttribute("data-connector-binding-state", "snapped");
  await expect(highlight).toHaveClass(/is-snapped/);
  await assertDualContrast(highlight, target, canvas);
  await expect(highlight.locator(".connector-binding-target-halo-inner")).toHaveCSS("stroke-dasharray", "none");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Dark mode" }).click();
  await openHighlight(page, canvas);
  await assertDualContrast(highlight, target, canvas);

  await page.emulateMedia({ forcedColors: "active" });
  await expect.poll(() => page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
  const forcedColors = await highlight.evaluate((element) => {
    const outer = getComputedStyle(element.querySelector(".connector-binding-target-halo-outer")!);
    const inner = getComputedStyle(element.querySelector(".connector-binding-target-halo-inner")!);
    return {
      innerAdjust: inner.forcedColorAdjust,
      innerStroke: inner.stroke,
      outerAdjust: outer.forcedColorAdjust,
      outerStroke: outer.stroke,
    };
  });
  expect(forcedColors.innerAdjust).toBe("auto");
  expect(forcedColors.outerAdjust).toBe("auto");
  expect(forcedColors.innerStroke).not.toBe("none");
  expect(forcedColors.outerStroke).not.toBe("none");
  expect(forcedColors.innerStroke).not.toBe(forcedColors.outerStroke);
});

async function openHighlight(page: Page, canvas: Locator) {
  await page.locator('.canvas-tool-palette [data-tool="arrow"]').click();
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await page.mouse.click(canvasBounds.x + 120, canvasBounds.y + canvasBounds.height - 170);
  const boundary = await remoteTargetBoundary(page);
  const angle = 16 * Math.PI / 180;
  await page.mouse.move(
    boundary.x + Math.cos(angle) * 23,
    boundary.y + Math.sin(angle) * 23,
    { steps: 4 },
  );
}

async function remoteTargetBoundary(page: Page) {
  const modelPoint = {
    x: 780 + 90 + 90 * Math.cos(16 * Math.PI / 180),
    y: 300 + 70 + 90 * Math.sin(16 * Math.PI / 180),
  };
  return page.evaluate((point) => {
    const content = document.querySelector<HTMLElement>(".canvas-content");
    if (!content) throw new Error("Canvas world layer was unavailable.");
    const bounds = content.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(content).transform);
    return { x: bounds.x + point.x * matrix.a, y: bounds.y + point.y * matrix.d };
  }, modelPoint);
}

async function assertDualContrast(highlight: Locator, target: Locator, canvas: Locator) {
  const colors = await highlight.evaluate((element) => ({
    inner: getComputedStyle(element.querySelector(".connector-binding-target-halo-inner")!).stroke,
    outer: getComputedStyle(element.querySelector(".connector-binding-target-halo-outer")!).stroke,
  }));
  const targetFill = await target.locator(".primitive-shape > *").first().evaluate((element) => getComputedStyle(element).fill);
  const canvasFill = await canvas.evaluate((element) => getComputedStyle(element).backgroundColor);
  for (const background of [targetFill, canvasFill]) {
    expect(Math.max(
      contrastRatio(parseColor(colors.inner), parseColor(background)),
      contrastRatio(parseColor(colors.outer), parseColor(background)),
    )).toBeGreaterThanOrEqual(3);
  }
}

function parseColor(color: string): [number, number, number] {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Could not parse color: ${color}`);
  return channels as [number, number, number];
}

function contrastRatio(first: [number, number, number], second: [number, number, number]) {
  const luminance = ([red, green, blue]: [number, number, number]) => {
    const channels = [red, green, blue].map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const brighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (brighter + 0.05) / (darker + 0.05);
}

function rectanglesIntersect(first: { height: number; width: number; x: number; y: number }, second: { height: number; width: number; x: number; y: number }) {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function counts(page: Page) {
  return page.evaluate(() => (window as unknown as { __overlapCounts: { apply: number; session: number } }).__overlapCounts);
}

async function resetCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __overlapCounts: { apply: number; session: number } }).__overlapCounts = { apply: 0, session: 0 };
  });
}

async function currentConnector(page: Page) {
  return page.evaluate(() => (
    (window as unknown as { __overlapWorkspace: { elements: Array<Record<string, unknown> & { id: string }> } })
      .__overlapWorkspace.elements.find((element) => element.id === "overlap-connector")
  ));
}

async function installOverlapWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string; type: string };
    const storageKey = "note-connector-overlap-accessibility";
    if (!sessionStorage.getItem(`${storageKey}:initialized`)) {
      localStorage.removeItem(storageKey);
      sessionStorage.setItem(`${storageKey}:initialized`, "true");
    }
    const style = {
      fillColor: { kind: "fixed", value: "#111827" },
      roughness: 1,
      roundness: 0.18,
      seed: 23,
      strokeColor: { kind: "fixed", value: "#4c6ef5" },
      strokeStyle: "solid",
      strokeWidth: 2,
    };
    const initial = {
      elements: [
        { createdAt: 1, height: 160, id: "overlap-source", locked: false, opacity: 1, pageId: "page", rotation: 18, shape: "rectangle", style, type: "shape", updatedAt: 1, width: 240, x: 340, y: 250, zIndex: 2 },
        { createdAt: 1, height: 150, id: "overlap-destination", locked: false, opacity: 1, pageId: "page", rotation: -21, shape: "ellipse", style: { ...style, seed: 24 }, type: "shape", updatedAt: 1, width: 220, x: 420, y: 290, zIndex: 3 },
        { createdAt: 1, height: 140, id: "remote-target", locked: false, opacity: 1, pageId: "page", rotation: 16, shape: "diamond", style: { ...style, seed: 25 }, type: "shape", updatedAt: 1, width: 180, x: 780, y: 300, zIndex: 4 },
        { createdAt: 1, end: { gap: 0, kind: "element", targetElementId: "overlap-destination" }, id: "overlap-connector", locked: false, opacity: 1, pageId: "page", routing: "straight", start: { gap: 0, kind: "element", targetElementId: "overlap-source" }, style: { ...style, endArrowhead: "arrow", fillColor: null, seed: 31, startArrowhead: "none" }, type: "connector", updatedAt: 1, zIndex: 8 },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Overlap accessibility" }],
      sessionState: { isToolLocked: true, openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" },
      warnings: [],
    };
    const workspace = (localStorage.getItem(storageKey) ? JSON.parse(localStorage.getItem(storageKey)!) : initial) as typeof initial;
    const persist = () => localStorage.setItem(storageKey, JSON.stringify(workspace));
    if (!localStorage.getItem(storageKey)) persist();
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __overlapCounts: { apply: number; session: number };
      __overlapWorkspace: typeof workspace;
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__overlapCounts = { apply: 0, session: 0 };
    runtime.__overlapWorkspace = workspace;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "overlap.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__overlapCounts.apply += 1;
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
        runtime.__overlapCounts.session += 1;
        workspace.sessionState = args.state as typeof workspace.sessionState;
        persist();
        return;
      }
      throw new Error(`Unexpected ${command}`);
    } };
  });
}
