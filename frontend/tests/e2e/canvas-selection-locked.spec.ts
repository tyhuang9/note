import { expect, test, type Page } from "@playwright/test";

test("a mixed text and locked-image selection moves only the unlocked element and keeps the full frame", async ({ page }) => {
  await installLockedSelectionWorkspace(page);
  await page.setViewportSize({ width: 1662, height: 900 });
  await page.goto("/");

  const canvas = page.getByRole("tabpanel");
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: /Select \(V/ }).click();
  const unlocked = page.locator('[data-block-id="unlocked"]');
  const locked = page.locator('[data-block-id="locked-image"]');
  const lockedControl = page.getByRole("button", { name: "Select locked image Locked image" });
  await unlocked.locator(".text-block-header").click();
  await lockedControl.click({ modifiers: ["Control"] });

  await expect(unlocked).toHaveClass(/is-multi-selected/);
  await expect(locked).toHaveClass(/is-multi-selected/);
  const frame = page.locator(".selection-frame");
  await expect(frame).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Move unlocked selected elements" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resize unlocked selected elements from (nw|ne|se|sw)/ })).toHaveCount(4);
  await expect(unlocked.locator(".resize-e")).toHaveCount(0);

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
  const liveFrameBounds = await requiredBounds(frame, "live selection frame");
  const lockedBounds = await requiredBounds(locked, "locked image");
  expect(liveFrameBounds.x + liveFrameBounds.width).toBeGreaterThanOrEqual(
    lockedBounds.x + lockedBounds.width,
  );
  expect(await readWorldPosition(unlocked)).toEqual(beforeUnlocked);
  expect(await readWorldPosition(locked)).toEqual(beforeLocked);
  await page.mouse.up();

  await expect.poll(() => readWorldPosition(unlocked)).toEqual({
    x: beforeUnlocked.x + 72,
    y: beforeUnlocked.y + 48,
  });
  await expect.poll(() => readWorldPosition(locked)).toEqual(beforeLocked);
  await expect(unlocked).toHaveClass(/is-multi-selected/);
  await expect(locked).toHaveClass(/is-multi-selected/);
  await expect(frame).toHaveCount(1);

  const beforeResizeUnlocked = await readWorldGeometry(unlocked);
  const beforeResizeLocked = await readWorldGeometry(locked);
  const resizeHandle = page.getByRole("button", { name: "Resize unlocked selected elements from se" });
  const resizeBounds = await requiredBounds(resizeHandle, "mixed locked selection resize handle");
  const resizeStart = {
    x: resizeBounds.x + resizeBounds.width / 2,
    y: resizeBounds.y + resizeBounds.height / 2,
  };
  await page.mouse.move(resizeStart.x, resizeStart.y);
  await page.mouse.down();
  await page.mouse.move(resizeStart.x + 60, resizeStart.y + 40, { steps: 5 });
  await expect(unlocked).toHaveClass(/is-drag-source-hidden/);
  await expect.poll(() => readWorldGeometry(unlocked)).toEqual(beforeResizeUnlocked);
  await expect.poll(() => readWorldGeometry(locked)).toEqual(beforeResizeLocked);
  await page.mouse.up();
  await expect.poll(() => readWorldGeometry(unlocked)).not.toEqual(beforeResizeUnlocked);
  await expect.poll(() => readWorldGeometry(locked)).toEqual(beforeResizeLocked);

  const unlockedControl = unlocked.getByRole("button", { name: "Select and move text block" });
  await unlockedControl.focus();
  await unlockedControl.press("Control+Enter");
  await expect(lockedControl).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Move .*selected elements/ })).toHaveCount(0);
  const lockedOnlyPosition = await readWorldPosition(locked);
  await lockedControl.press("Shift+ArrowRight");
  await expect.poll(() => readWorldPosition(locked)).toEqual(lockedOnlyPosition);
  await lockedControl.press("Delete");
  await expect(locked).toHaveCount(1);
});

test("locked images remain selectable but expose no move or resize mutation", async ({ page }) => {
  await installLockedSelectionWorkspace(page);
  await page.setViewportSize({ width: 1662, height: 900 });
  await page.goto("/");

  const image = page.locator('[data-block-id="locked-image"]');
  const imageControl = page.getByRole("button", { name: "Select locked image Locked image" });
  await imageControl.focus();
  await imageControl.press("Enter");
  await expect(imageControl).toHaveAttribute("aria-pressed", "true");
  await expect(image.getByRole("slider", { name: "Resize image" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Move .*selected elements/ })).toHaveCount(0);
  const before = await readWorldPosition(image);
  await imageControl.press("Shift+ArrowDown");
  await expect.poll(() => readWorldPosition(image)).toEqual(before);
  const bounds = await requiredBounds(image, "locked image");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => readWorldPosition(image)).toEqual(before);
});

test("all-text header Arrow movement moves unlocked selected text and preserves locked text", async ({ page }) => {
  await installLockedSelectionWorkspace(page);
  await page.setViewportSize({ width: 1662, height: 900 });
  await page.goto("/");

  const canvas = page.getByRole("tabpanel");
  const unlocked = page.locator('[data-block-id="unlocked"]');
  const locked = page.locator('[data-block-id="locked"]');
  const unlockedHeader = unlocked.locator(".text-block-header");
  const lockedHeader = locked.locator(".text-block-header");
  await unlockedHeader.click();
  await lockedHeader.click({ modifiers: ["Control"] });
  await expect(page.locator(".selection-frame")).toHaveCount(1);

  const beforeUnlocked = await readWorldPosition(unlocked);
  const beforeLocked = await readWorldPosition(locked);
  await unlockedHeader.focus();
  await unlockedHeader.press("Shift+ArrowDown");
  await expect.poll(() => readWorldPosition(unlocked)).toEqual({
    x: beforeUnlocked.x,
    y: beforeUnlocked.y + 10,
  });
  await expect.poll(() => readWorldPosition(locked)).toEqual(beforeLocked);
  await expect(lockedHeader).toHaveAttribute("aria-pressed", "true");

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => readWorldPosition(unlocked)).toEqual(beforeUnlocked);
  await expect.poll(() => readWorldPosition(locked)).toEqual(beforeLocked);
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
          assetId: "locked-image-asset",
          createdAt: 1,
          fileName: "Locked image",
          fit: "contain",
          height: 120,
          id: "locked-image",
          locked: true,
          naturalHeight: 120,
          naturalWidth: 180,
          opacity: 1,
          pageId: "page",
          rotation: 0,
          type: "image",
          updatedAt: 1,
          width: 180,
          x: 860,
          y: 260,
          zIndex: 3,
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
        if (command === "load_asset") return {
          byteSize: 0,
          dataBase64: "",
          fileName: "Locked image",
          id: "locked-image-asset",
          mediaType: "image/png",
          naturalHeight: 120,
          naturalWidth: 180,
        };
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

async function readWorldGeometry(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((element) => {
    const style = element as HTMLElement;
    return {
      height: Number.parseFloat(style.style.height),
      width: Number.parseFloat(style.style.width),
      x: Number.parseFloat(style.style.left),
      y: Number.parseFloat(style.style.top),
    };
  });
}
