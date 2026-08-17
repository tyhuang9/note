import { expect, test, type Page } from "@playwright/test";

test("a mixed locked selection moves only unlocked elements and preserves the full selection", async ({ page }) => {
  await installLockedSelectionWorkspace(page);
  await page.setViewportSize({ width: 1662, height: 900 });
  await page.goto("/");

  const canvas = page.getByRole("tabpanel");
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: /Select \(V/ }).click();
  const unlocked = page.locator('[data-block-id="unlocked"]');
  const locked = page.locator('[data-block-id="locked"]');
  await unlocked.locator(".text-block-header").click();
  await locked.locator(".text-block-header").click({ modifiers: ["Control"] });

  await expect(unlocked).toHaveClass(/is-multi-selected/);
  await expect(locked).toHaveClass(/is-multi-selected/);
  const frame = page.locator(".selection-frame");
  await expect(frame).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Resize selected elements/ })).toHaveCount(0);

  const beforeUnlocked = await readWorldPosition(unlocked);
  const beforeLocked = await readWorldPosition(locked);
  const frameBounds = await requiredBounds(frame, "selection frame");
  const dragPoint = {
    x: frameBounds.x + frameBounds.width / 2,
    y: frameBounds.y + frameBounds.height / 2,
  };
  await page.mouse.move(dragPoint.x, dragPoint.y);
  await page.mouse.down();
  await page.mouse.move(dragPoint.x + 72, dragPoint.y + 48, { steps: 6 });
  await page.mouse.up();

  await expect.poll(() => readWorldPosition(unlocked)).toEqual({
    x: beforeUnlocked.x + 72,
    y: beforeUnlocked.y + 48,
  });
  await expect.poll(() => readWorldPosition(locked)).toEqual(beforeLocked);
  await expect(unlocked).toHaveClass(/is-multi-selected/);
  await expect(locked).toHaveClass(/is-multi-selected/);
  await expect(frame).toHaveCount(1);
});

async function installLockedSelectionWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const workspace = {
      elements: [
        {
          content: "Unlocked",
          createdAt: 1,
          height: 92,
          id: "unlocked",
          locked: false,
          opacity: 1,
          pageId: "page",
          rotation: 0,
          type: "text",
          updatedAt: 1,
          width: 220,
          x: 180,
          y: 220,
          zIndex: 1,
        },
        {
          content: "Locked",
          createdAt: 1,
          height: 92,
          id: "locked",
          locked: true,
          opacity: 1,
          pageId: "page",
          rotation: 0,
          type: "text",
          updatedAt: 1,
          width: 220,
          x: 560,
          y: 300,
          zIndex: 2,
        },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Locked selection" }],
      sessionState: { openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "initialize_storage") {
          return { databasePath: "locked-selection.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        }
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
        if (command === "apply_scene_changes") {
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
          return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
        }
        if (command === "save_session_state") return;
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
}

async function requiredBounds(locator: ReturnType<Page["locator"]>, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function readWorldPosition(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
}
