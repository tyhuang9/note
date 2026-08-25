import { expect, test, type Locator, type Page } from "@playwright/test";

const orientations = [
  { end: { x: 400, y: 100 }, id: "horizontal", start: { x: 100, y: 100 } },
  { end: { x: 400, y: 360 }, id: "diagonal", start: { x: 100, y: 180 } },
  { end: { x: 520, y: 440 }, id: "steep", start: { x: 470, y: 140 } },
  { end: { x: 650, y: 440 }, id: "vertical", start: { x: 650, y: 140 } },
  { end: { x: 780, y: 360 }, id: "reversed", start: { x: 1_080, y: 180 } },
  { end: { x: 960, y: 470 }, id: "short", start: { x: 930, y: 455 } },
] as const;

test("upright arrow labels reserve only their centered rectangle intersection", async ({ page }) => {
  await installLabelWorkspace(page);
  await page.setViewportSize({ height: 800, width: 1_300 });
  await page.goto("/");

  for (const orientation of orientations) {
    const arrow = page.locator(`[data-canvas-element-id="${orientation.id}"]`);
    const label = arrow.locator(".connector-label");
    await expect(label).toHaveText("Compact upright label");
    await expectGapToMatchFootprint(arrow.locator(".primitive-connector"), label, orientation.start, orientation.end, 1);
  }

  const diagonal = page.locator('[data-canvas-element-id="diagonal"]');
  await diagonal.locator(".connector-label").dblclick();
  const editor = diagonal.getByRole("textbox", { name: "Arrow label" });
  await expect(editor).toBeFocused();
  await editor.fill("A much longer live label");
  await expectGapToMatchFootprint(
    diagonal.locator(".primitive-connector"),
    editor,
    orientations[1].start,
    orientations[1].end,
    1,
  );
  const editingGap = Number(await diagonal.locator(".primitive-connector").getAttribute("data-label-gap-half-length"));
  await editor.press("Enter");
  await expect(diagonal.locator(".connector-label")).toHaveText("A much longer live label");
  expect(Number(await diagonal.locator(".primitive-connector").getAttribute("data-label-gap-half-length")))
    .toBeCloseTo(editingGap, 3);
});

async function expectGapToMatchFootprint(
  shaft: Locator,
  label: Locator,
  start: Readonly<{ x: number; y: number }>,
  end: Readonly<{ x: number; y: number }>,
  zoom: number,
) {
  const bounds = await label.boundingBox();
  if (!bounds) throw new Error("Connector label bounds were unavailable.");
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const unitX = Math.abs(end.x - start.x) / distance;
  const unitY = Math.abs(end.y - start.y) / distance;
  const horizontalExit = unitX > Number.EPSILON
    ? bounds.width / zoom / 2 / unitX
    : Number.POSITIVE_INFINITY;
  const verticalExit = unitY > Number.EPSILON
    ? bounds.height / zoom / 2 / unitY
    : Number.POSITIVE_INFINITY;
  const expected = Math.min(horizontalExit, verticalExit) + 4;
  expect(Number(await shaft.getAttribute("data-label-gap-half-length"))).toBeCloseTo(expected, 0);
}

async function installLabelWorkspace(page: Page) {
  await page.addInitScript((connectorOrientations) => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const style = {
      endArrowhead: "arrow",
      fillColor: null,
      roughness: 0.5,
      roundness: 0,
      seed: 71,
      startArrowhead: "none",
      strokeColor: { kind: "theme", token: "foreground" },
      strokeStyle: "solid",
      strokeWidth: 2,
    };
    const labelStyle = {
      color: { kind: "theme", token: "foreground" },
      fontFamily: "system-ui",
      fontSize: "14px",
      orientation: "upright",
    };
    const workspace = {
      elements: connectorOrientations.map((orientation, index) => ({
        createdAt: 1,
        end: { kind: "free", ...orientation.end },
        id: orientation.id,
        labelStyle,
        locked: false,
        opacity: 1,
        pageId: "page",
        routing: "straight",
        semantic: { label: "Compact upright label" },
        start: { kind: "free", ...orientation.start },
        style: { ...style, seed: style.seed + index },
        type: "connector",
        updatedAt: 1,
        zIndex: index + 1,
      })) as ElementRecord[],
      folders: [],
      isDarkMode: true,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Connector label gaps" }],
      sessionState: {
        openPageTabIds: ["page"],
        pageViewports: { page: { panOffset: { x: 24, y: 44 }, zoomLevel: 1 } },
        selectedFolderId: "",
        selectedPageId: "page",
      },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "label-gap.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "save_session_state") return;
      if (command === "apply_scene_changes") {
        const batch = args.batch as { upserts: ElementRecord[] };
        for (const upsert of batch.upserts) {
          const index = workspace.elements.findIndex((element) => element.id === upsert.id);
          if (index >= 0) workspace.elements[index] = upsert;
        }
        workspace.pages[0].revision += 1;
        return { newRevision: workspace.pages[0].revision, pageId: "page" };
      }
      return undefined;
    } };
  }, orientations);
}
