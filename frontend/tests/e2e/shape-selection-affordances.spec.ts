import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await installWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("Select mode uses each shape's logical interior for hollow and filled shapes", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const hollow = page.locator('[data-canvas-element-id="hollow-rounded"]');
  const filled = page.locator('[data-canvas-element-id="filled-ellipse"]');
  const diamond = page.locator('[data-canvas-element-id="rotated-diamond"]');
  const editable = page.locator('[data-canvas-element-id="editable-shape"]');
  const hollowBounds = await requiredBounds(hollow, "hollow rounded rectangle");
  const filledBounds = await requiredBounds(filled, "filled ellipse");

  const hollowCorner = { x: hollowBounds.x + 2, y: hollowBounds.y + 2 };
  await page.mouse.move(hollowCorner.x, hollowCorner.y);
  await expect(canvas).not.toHaveAttribute("data-select-hover-cursor");
  await selectScreenPoint(page, hollowCorner);
  await expect(page.locator(".selection-frame")).toHaveCount(0);

  const hollowCenter = { x: hollowBounds.x + hollowBounds.width / 2, y: hollowBounds.y + hollowBounds.height / 2 };
  await page.mouse.move(hollowCenter.x, hollowCenter.y);
  await expect(canvas).toHaveAttribute("data-select-hover-cursor", "grab");
  await selectScreenPoint(page, hollowCenter);
  await expect(page.locator(".selection-frame:not(.is-native-text-frame)")).toHaveCount(1);

  await selectScreenPoint(page, { x: hollowCenter.x, y: hollowBounds.y });
  await expect(page.locator(".selection-frame:not(.is-native-text-frame)")).toHaveCount(1);

  await selectScreenPoint(page, { x: filledBounds.x + 5, y: filledBounds.y + 5 });
  await expect(page.locator(".selection-frame")).toHaveCount(0);
  await selectScreenPoint(page, { x: filledBounds.x + filledBounds.width / 2, y: filledBounds.y + filledBounds.height / 2 });
  await expect(page.locator(".selection-frame:not(.is-native-text-frame)")).toHaveCount(1);
  await selectScreenPoint(page, { x: filledBounds.x + filledBounds.width / 2, y: filledBounds.y });
  await expect(page.locator(".selection-frame:not(.is-native-text-frame)")).toHaveCount(1);

  await diamond.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-frame:not(.is-native-text-frame)")).toHaveCount(1);
  const editableBounds = await requiredBounds(editable, "editable shape");
  await page.mouse.dblclick(editableBounds.x + editableBounds.width / 2, editableBounds.y + editableBounds.height / 2);
  await expect(editable).toHaveClass(/is-editing/);
  await expect(hollow).toBeVisible();
  await expect(filled).toBeVisible();
});

for (const zoom of [50, 100, 200]) {
  test(`shape resize hit zones are markerless and functional at ${zoom}% while text remains markerless`, async ({ page }) => {
    const canvas = page.getByRole("tabpanel");
    const hollowBounds = await requiredBounds(page.locator('[data-canvas-element-id="hollow-rounded"]'), "hollow rounded rectangle");
    const hollowCenter = { x: hollowBounds.x + hollowBounds.width / 2, y: hollowBounds.y + hollowBounds.height / 2 };
    await selectScreenPoint(page, hollowCenter);
    await setZoom(page, canvas, zoom);

    const scaledHollowBounds = await requiredBounds(page.locator('[data-canvas-element-id="hollow-rounded"]'), "scaled hollow rounded rectangle");
    const scaledCenter = { x: scaledHollowBounds.x + scaledHollowBounds.width / 2, y: scaledHollowBounds.y + scaledHollowBounds.height / 2 };
    await selectScreenPoint(page, scaledCenter);
    await expect(page.locator(".selection-frame:not(.is-native-text-frame)")).toHaveCount(1);
    await selectScreenPoint(page, { x: scaledCenter.x, y: scaledHollowBounds.y });
    await expect(page.locator(".selection-frame:not(.is-native-text-frame)")).toHaveCount(1);

    const frame = page.locator(".selection-frame:not(.is-native-text-frame)");
    await expect(frame).toHaveCount(1);
    await expect(frame.locator(".selection-frame-handle")).toHaveCount(8);
    const expectedCursors = {
      n: "ns-resize",
      ne: "nesw-resize",
      e: "ew-resize",
      se: "nwse-resize",
      s: "ns-resize",
      sw: "nesw-resize",
      w: "ew-resize",
      nw: "nwse-resize",
    } as const;
    for (const [handle, cursor] of Object.entries(expectedCursors)) {
      const control = frame.locator(`[data-selection-resize-handle="${handle}"]`);
      await expect(control).toHaveCount(1);
      await expect(control).toHaveCSS("cursor", cursor);
      expect(await control.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");
      const controlBounds = await requiredBounds(control, `${handle} shape resize zone`);
      expect(controlBounds.width).toBeGreaterThan(0);
      expect(controlBounds.height).toBeGreaterThan(0);
    }

    const shapeWidth = (shape: Locator) => shape.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width));
    const southeast = frame.locator('[data-selection-resize-handle="se"]');
    const beforeCornerResize = await shapeWidth(page.locator('[data-canvas-element-id="hollow-rounded"]'));
    await southeast.focus();
    await southeast.press("Shift+ArrowRight");
    await expect.poll(() => shapeWidth(page.locator('[data-canvas-element-id="hollow-rounded"]')))
      .toBeGreaterThan(beforeCornerResize);
    const east = frame.locator('[data-selection-resize-handle="e"]');
    const beforeEdgeResize = await shapeWidth(page.locator('[data-canvas-element-id="hollow-rounded"]'));
    await east.focus();
    await east.press("Shift+ArrowRight");
    await expect.poll(() => shapeWidth(page.locator('[data-canvas-element-id="hollow-rounded"]')))
      .toBeGreaterThan(beforeEdgeResize);

    await setZoom(page, canvas, 100);
    const textTarget = page.locator('[data-canvas-element-id="text-target"]');
    await textTarget.click();
    const textFrame = page.locator(".selection-frame.is-native-text-frame");
    await expect(textFrame).toHaveCount(1);
    expect(await textFrame.locator('[data-selection-resize-handle="nw"]').evaluate((element) =>
      getComputedStyle(element, "::after").content)).toBe("none");
  });
}

test("bound connector endpoint controls stay accessible but markerless after reload and retain retarget anchors", async ({ page }) => {
  const selectTool = page.locator('.canvas-tool-palette [data-tool="select"]');
  await selectTool.click();
  await page.getByRole("button", { name: "Select and move arrow connector" }).click();
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  await expect(endHandle).toBeVisible();
  await expect(endHandle).toHaveAttribute("aria-describedby", "connector-end-endpoint-description");
  expect(await endHandle.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");

  await page.reload();
  await page.locator('.canvas-tool-palette [data-tool="arrow"]').click();
  const authoringTarget = await modelToScreen(page, { x: 1060, y: 430 });
  await page.mouse.move(authoringTarget.x, authoringTarget.y, { steps: 4 });
  const authoringHighlight = page.locator('[data-connector-target-id="retarget-shape"].is-snapped');
  await expect(authoringHighlight).toHaveCount(1);
  await expect(authoringHighlight.locator(".connector-binding-target-anchor")).toBeVisible();
  await selectTool.click();
  await page.getByRole("button", { name: "Select and move arrow connector" }).click();
  const reloadedEndHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  await expect(reloadedEndHandle).toBeVisible();
  await reloadedEndHandle.focus();
  await expect(reloadedEndHandle).toBeFocused();
  expect(await reloadedEndHandle.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");

  const handleBounds = await requiredBounds(reloadedEndHandle, "connector endpoint control");
  const targetPoint = await modelToScreen(page, { x: 1060, y: 430 });
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 5 });
  const highlight = page.locator('[data-connector-target-id="retarget-shape"].is-snapped');
  await expect(highlight).toHaveCount(1);
  await expect(highlight.locator(".connector-binding-target-anchor")).toBeVisible();
  await page.mouse.up();
});

async function selectScreenPoint(page: Page, point: { x: number; y: number }) {
  await page.mouse.click(point.x, point.y);
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  for (let index = 0; index < Math.abs(percent - 100) / 10; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function modelToScreen(page: Page, point: { x: number; y: number }) {
  return page.evaluate((worldPoint) => {
    const content = document.querySelector<HTMLElement>(".canvas-content");
    if (!content) throw new Error("Canvas content was unavailable.");
    const bounds = content.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(content).transform);
    return { x: bounds.x + worldPoint.x * matrix.a, y: bounds.y + worldPoint.y * matrix.d };
  }, point);
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function installWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const storageKey = "note-shape-selection-affordances";
    const style = {
      fillColor: null,
      roughness: 1,
      roundness: 1,
      seed: 17,
      strokeColor: { kind: "fixed", value: "#4c6ef5" },
      strokeStyle: "solid",
      strokeWidth: 2,
    };
    const workspace = {
      elements: [
        { ...baseElement("hollow-rounded", 220, 150, 200, 180, 1), shape: "rectangle", style, type: "shape" },
        { ...baseElement("filled-ellipse", 570, 150, 200, 180, 2), shape: "ellipse", style: { ...style, fillColor: { kind: "fixed", value: "#dbeafe" }, roundness: 0 }, type: "shape" },
        { ...baseElement("rotated-diamond", 920, 150, 180, 180, 3), rotation: 29, shape: "diamond", style: { ...style, roundness: 0 }, type: "shape" },
        { ...baseElement("source-shape", 220, 430, 160, 100, 4), shape: "rectangle", style: { ...style, roundness: 0.2 }, type: "shape" },
        { ...baseElement("target-shape", 690, 430, 160, 100, 5), shape: "ellipse", style: { ...style, roundness: 0 }, type: "shape" },
        { ...baseElement("retarget-shape", 980, 380, 160, 100, 6), shape: "rectangle", style: { ...style, roundness: 0.2 }, type: "shape" },
        { backgroundMode: "surface", content: "Native text", createdAt: 1, height: 70, id: "text-target", locked: false, opacity: 1, pageId: "page", rotation: 0, type: "text", updatedAt: 1, width: 200, x: 540, y: 650, zIndex: 7 },
        { ...baseElement("editable-shape", 900, 650, 200, 120, 8), shape: "rectangle", style: { ...style, roundness: 0.2 }, text: { content: "Editable interior" }, type: "shape" },
        {
          createdAt: 1,
          end: { kind: "element", targetElementId: "target-shape", gap: 0 },
          id: "bound-connector",
          locked: false,
          opacity: 1,
          pageId: "page",
          routing: "straight",
          start: { kind: "element", targetElementId: "source-shape", gap: 0 },
          style: { ...style, endArrowhead: "arrow", startArrowhead: "none", roundness: 0 },
          type: "connector",
          updatedAt: 1,
          zIndex: 9,
        },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Selection affordances" }],
      sessionState: { isToolLocked: true, openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "selection-affordances.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const deleted = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements
          .filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id))
          .map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        return { newRevision: ++workspace.pages[0].revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") return;
      throw new Error(`Unexpected ${command}`);
    } };

    function baseElement(id: string, x: number, y: number, width: number, height: number, zIndex: number) {
      return { createdAt: 1, height, id, locked: false, opacity: 1, pageId: "page", rotation: 0, updatedAt: 1, width, x, y, zIndex };
    }
  });
}
