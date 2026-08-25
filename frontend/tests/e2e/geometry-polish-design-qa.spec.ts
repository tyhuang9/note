import { expect, test, type Locator, type Page } from "@playwright/test";

const evidenceRoot = "../design-qa-evidence";

test("captures final geometry-polish states comparable to the supplied references", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await installDesignQaWorkspace(page);
  await page.setViewportSize({ width: 1_500, height: 900 });
  await page.goto(process.env.DESIGN_QA_BASE_URL ?? "/");
  const canvas = page.getByRole("tabpanel");
  await expect(canvas).toBeVisible();
  await page.addStyleTag({ content: `
    .canvas-tool-palette,
    .drawing-properties-panel,
    .global-text-toolbar,
    .canvas-controls { visibility: hidden !important; }
  ` });

  const connector = page.locator('[data-canvas-element-id="qa-arrow"]');
  await expect(connector.locator(".primitive-connector")).toHaveAttribute(
    "data-label-gap-half-length",
    /[1-9]\d*(?:\.\d+)?/,
  );
  const text = page.locator('[data-canvas-element-id="qa-text"]');
  await text.locator(".text-block-display").click();
  await expect(page.locator(".selection-frame.is-native-text-frame")).toBeVisible();
  await expect(page.locator(".selection-frame.is-native-text-frame")).toHaveCSS("border-left-color", "rgba(0, 0, 0, 0)");
  const canvasBounds = await requiredBounds(canvas, "canvas");
  await page.screenshot({
    path: `${evidenceRoot}/implementation-native-text-compact-label-dark-1017x685.png`,
    clip: {
      x: canvasBounds.x,
      y: canvasBounds.y,
      width: 1_017,
      height: 685,
    },
  });

  await connector.locator(".connector-label").dblclick();
  await expect(connector.getByRole("textbox", { name: "Arrow label" })).toBeFocused();
  await page.screenshot({
    path: `${evidenceRoot}/implementation-arrow-label-edit-dark-1017x685.png`,
    clip: { x: canvasBounds.x, y: canvasBounds.y, width: 1_017, height: 685 },
  });
  await connector.getByRole("textbox", { name: "Arrow label" }).press("Escape");
  await connector.evaluate((element) => { (element as HTMLElement).style.visibility = "hidden"; });

  const diamond = page.locator('[data-canvas-element-id="qa-diamond"]');
  await diamond.click();
  const selectedFrame = page.locator(".selection-frame");
  await expect(selectedFrame).toBeVisible();
  await expect(selectedFrame.locator(".selection-frame-handle")).toHaveCount(8);
  for (const handle of await selectedFrame.locator(".selection-frame-handle").all()) {
    await expect(handle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
  await captureCentered(page, diamond, 406, 408, `${evidenceRoot}/implementation-markerless-diamond-dark-406x408.png`);

  await page.getByRole("button", { name: "Move selected elements" }).dblclick({ position: { x: 120, y: 110 } });
  const shapeEditor = diamond.locator('.shape-contained-text-editor-content[role="textbox"]');
  await expect(shapeEditor).toBeFocused();
  await expect(page.locator(".selection-frame")).toHaveCount(0);
  await expect(diamond).toHaveCSS("outline-style", "none");
  expect(await verticalCenterDelta(
    diamond.locator(".shape-contained-text-editor"),
    shapeEditor.locator("p"),
  )).toBeLessThanOrEqual(2);
  await captureCentered(page, diamond, 371, 425, `${evidenceRoot}/implementation-centered-shape-edit-dark-371x425.png`);
  await shapeEditor.press("Escape");

  await connector.evaluate((element) => { (element as HTMLElement).style.visibility = "visible"; });
  await text.locator(".text-block-display").click();
  await expect(page.locator(".selection-frame.is-native-text-frame")).toBeVisible();
  await expect(page.locator(".selection-frame.is-native-text-frame")).toHaveCSS("border-left-color", "rgba(0, 0, 0, 0)");
  await captureCentered(page, text, 560, 300, `${evidenceRoot}/implementation-seamless-text-selection-dark-560x300.png`);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

async function captureCentered(page: Page, subject: Locator, width: number, height: number, path: string) {
  const bounds = await requiredBounds(subject, "capture subject");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Viewport size was unavailable.");
  const x = Math.max(0, Math.min(viewport.width - width, bounds.x + bounds.width / 2 - width / 2));
  const y = Math.max(0, Math.min(viewport.height - height, bounds.y + bounds.height / 2 - height / 2));
  await page.screenshot({ path, clip: { x, y, width, height } });
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function verticalCenterDelta(container: Locator, content: Locator) {
  const [containerBounds, contentBounds] = await Promise.all([
    requiredBounds(container, "shape editor"),
    requiredBounds(content, "shape paragraph"),
  ]);
  return Math.abs(
    contentBounds.y + contentBounds.height / 2
      - (containerBounds.y + containerBounds.height / 2),
  );
}

async function installDesignQaWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const shapeStyle = (seed: number, fill: string) => ({
      fillColor: { kind: "fixed", value: fill },
      roughness: 0.6,
      roundness: 0.55,
      seed,
      strokeColor: { kind: "fixed", value: "#f5f5f5" },
      strokeStyle: "solid",
      strokeWidth: 2,
    });
    const workspace = {
      elements: [
        {
          createdAt: 1, height: 220, id: "qa-diamond", locked: false, opacity: 1,
          pageId: "qa-page", rotation: 0, shape: "diamond", style: shapeStyle(202, "#171717"),
          text: {
            content: "Centered shape text",
            richContent: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Centered shape text" }] }],
            },
          },
          type: "shape", updatedAt: 1, width: 240, x: 700, y: 340, zIndex: 2,
        },
        {
          createdAt: 1,
          end: { kind: "free", x: 700, y: 450 },
          id: "qa-arrow",
          labelStyle: {
            color: { kind: "theme", token: "foreground" },
            fontFamily: "system-ui",
            fontSize: "14px",
            orientation: "upright",
          },
          locked: false,
          opacity: 1,
          pageId: "qa-page",
          routing: "straight",
          semantic: { label: "text here not breaking" },
          start: { kind: "free", x: 325, y: 115 },
          style: {
            endArrowhead: "arrow", fillColor: null, roughness: 0.5, roundness: 0,
            seed: 203, startArrowhead: "none", strokeColor: { kind: "fixed", value: "#f5f5f5" },
            strokeStyle: "solid", strokeWidth: 2,
          },
          type: "connector", updatedAt: 1, zIndex: 3,
        },
        {
          backgroundMode: "transparent", content: "Seamless textbox", createdAt: 1,
          height: 72, id: "qa-text", isWidthManuallyResized: true, locked: false, opacity: 1,
          pageId: "qa-page", rotation: 0, type: "text", updatedAt: 1, width: 280,
          x: 45, y: 35, zIndex: 4,
        },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: true,
      pages: [{ folderId: "", id: "qa-page", isBookmarked: false, revision: 0, title: "Geometry polish QA" }],
      sessionState: {
        openPageTabIds: ["qa-page"],
        pageViewports: { "qa-page": { panOffset: { x: 35, y: 45 }, zoomLevel: 1 } },
        selectedFolderId: "",
        selectedPageId: "qa-page",
      },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command) => {
      if (command === "initialize_storage") return { databasePath: "geometry-polish-qa.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "save_session_state") return;
      if (command === "apply_scene_changes") return { newRevision: ++workspace.pages[0].revision, pageId: "qa-page" };
      return undefined;
    } };
  });
}
