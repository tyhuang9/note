import { expect, test, type Locator, type Page } from "@playwright/test";

const evidenceRoot = "../design-qa-evidence";

test("captures supplied 505x345 dark mixed-selection live drag state", async ({ page }) => {
  test.setTimeout(30_000);
  const errors = captureErrors(page);
  await installWorkspace(page, true, [
    shape("capture-shape", 96, 108, 92, 76),
    text("capture-text", 236, 146, "Mixed text"),
  ]);
  await page.setViewportSize({ width: 505, height: 345 });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveClass(/is-dark/);

  const shapeElement = page.locator('[data-canvas-element-id="capture-shape"]');
  const textElement = page.locator('[data-canvas-element-id="capture-text"]');
  await page.getByRole("button", { name: /Select \(V/ }).click();
  await shapeElement.focus();
  await shapeElement.press("Enter");
  await textElement.locator(".text-block-header").click({ modifiers: ["Control"] });

  const frame = page.locator(".selection-frame");
  await expect(frame).toBeVisible();
  const original = await bounds(frame, "initial frame");
  const moveSurface = page.getByRole("button", { name: "Move selected elements" });
  const start = center(await bounds(moveSurface, "move surface"));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 44, start.y + 26, { steps: 5 });
  await expect(page.locator(".drag-layer-clone")).toHaveCount(2);
  const live = await bounds(frame, "live composite frame");
  expect(live.x).toBeCloseTo(original.x + 44, 0);
  expect(live.y).toBeCloseTo(original.y + 26, 0);
  await page.screenshot({ path: `${evidenceRoot}/implementation-mixed-live-drag-dark-505x345.png` });
  await page.mouse.up();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("captures supplied 280x224 dark properties overflow state and token variants", async ({ page }) => {
  test.setTimeout(30_000);
  const errors = captureErrors(page);
  await installWorkspace(page, true, []);
  await page.setViewportSize({ width: 280, height: 224 });
  await page.goto("/");
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const adjustments = page.getByRole("button", { name: "Drawing properties" });
  await expect(adjustments).toBeVisible();
  await adjustments.click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(properties).toBeVisible();
  expect(await properties.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(properties).toHaveCSS("scrollbar-width", "thin");
  await expect(properties).toHaveCSS("scrollbar-color", /rgb\(153, 153, 163\)/);
  await properties.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: `${evidenceRoot}/implementation-properties-overflow-dark-280x224.png` });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("captures 280x224 light and effective 200 percent properties overflow", async ({ page }) => {
  test.setTimeout(30_000);
  const errors = captureErrors(page);
  await installWorkspace(page, false, []);
  await page.setViewportSize({ width: 280, height: 224 });
  await page.goto("/");
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.getByRole("button", { name: "Drawing properties" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(properties).toBeVisible();
  await expect(properties).toHaveCSS("scrollbar-color", /rgb\(107, 109, 120\)/);
  await page.screenshot({ path: `${evidenceRoot}/implementation-properties-overflow-light-280x224.png` });
  await page.addStyleTag({ content: ".drawing-properties-panel { font-size: 200% !important; }" });
  expect(await properties.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.screenshot({ path: `${evidenceRoot}/implementation-properties-overflow-200pct-280x224.png` });
  const overflow = await properties.evaluate((element) => {
    const panel = element as HTMLElement;
    return {
      panel: { clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth },
      children: Array.from(panel.querySelectorAll<HTMLElement>("*")).map((child) => ({
        clientWidth: child.clientWidth,
        scrollWidth: child.scrollWidth,
        selector: `.${Array.from(child.classList).join(".")}`,
      })).filter((child) => child.scrollWidth > panel.clientWidth),
    };
  });
  expect(overflow.panel.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.panel.clientWidth);
  expect(errors, errors.join("\n")).toEqual([]);
});

function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function installWorkspace(page: Page, isDarkMode: boolean, elements: Record<string, unknown>[]) {
  await page.addInitScript(({ isDarkMode, elements }) => {
    const workspace = {
      elements,
      folders: [],
      isDarkMode,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "QA canvas" }],
      sessionState: { openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "initialize_storage") return { databasePath: "visual-qa.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
        if (command === "save_session_state" || command === "apply_scene_changes") return { newRevision: 1, pageId: "page" };
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, { isDarkMode, elements });
}

function shape(id: string, x: number, y: number, width: number, height: number) {
  return {
    createdAt: 1, height, id, locked: false, opacity: 1, pageId: "page", rotation: 0,
    shape: "rectangle", style: { fillColor: null, roughness: 1, roundness: 8, seed: 1, strokeColor: { kind: "fixed", value: "#e6e6eb" }, strokeStyle: "solid", strokeWidth: 2 },
    type: "shape", updatedAt: 1, width, x, y, zIndex: 1,
  };
}

function text(id: string, x: number, y: number, content: string) {
  return { content, createdAt: 1, height: 92, id, locked: false, opacity: 1, pageId: "page", rotation: 0, type: "text", updatedAt: 1, width: 180, x, y, zIndex: 2 };
}

async function bounds(locator: Locator, label: string) {
  const result = await locator.boundingBox();
  if (!result) throw new Error(`${label} bounds were unavailable.`);
  return result;
}

function center(rect: { x: number; y: number; width: number; height: number }) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
