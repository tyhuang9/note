import { expect, test, type Page } from "@playwright/test";

const STORAGE_KEY = "note-playwright-sqlite-contract";

test("SQLite bridge reconciles structure before scene changes and reloads text", async ({ page }) => {
  await installTauriStorageMock(page);
  await page.goto("/");

  await page.getByRole("button", { name: /create new note/i }).click();
  await expect.poll(() => persistenceCommands(page)).toContain("reconcile_workspace_structure");
  await page.evaluate(() => {
    (window as unknown as { __notePersistenceCalls: string[] }).__notePersistenceCalls = [];
  });

  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  await page.mouse.click(bounds.x + 260, bounds.y + 220);
  await page.keyboard.press("x");
  await expect(page.locator(".text-block-editor-content")).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("Persisted text");
  await page.mouse.click(bounds.x + 680, bounds.y + 480);

  await expect.poll(() => persistenceCommands(page)).toContain("apply_scene_changes");
  await expect(page.locator(".persistence-status")).toHaveText("Saved");
  const commands = await persistenceCommands(page);
  expect(commands.lastIndexOf("reconcile_workspace_structure")).toBeLessThan(
    commands.lastIndexOf("apply_scene_changes"),
  );

  await page.getByRole("button", { name: "Pen (P / 7)" }).click();
  await page.mouse.move(bounds.x + 320, bounds.y + 360);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 470, bounds.y + 400, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-canvas-element-type="ink"]')).toHaveCount(1);
  await expect(page.locator(".persistence-status")).toHaveText("Saved");

  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await page.mouse.click(bounds.x + 760, bounds.y + 520);
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await properties.getByRole("button", { name: "Stroke color #e03131" }).click();
  const toolLock = page.locator("[data-tool-lock]");
  await expect(toolLock).toHaveAccessibleName("Turn off drawing tool lock");
  await expect(toolLock).toHaveAttribute("aria-pressed", "true");
  await toolLock.click();
  await expect(toolLock).toHaveAccessibleName("Turn on drawing tool lock");
  await expect(toolLock).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".persistence-status")).toHaveText("Saved");

  await page.reload();
  await expect(page.locator(".text-block-display")).toContainText("Persisted text");
  await expect(page.locator('[data-canvas-element-type="ink"]')).toHaveCount(1);
  await expect(page.locator("[data-tool-lock]")).toHaveAccessibleName("Turn on drawing tool lock");
  await expect(page.locator("[data-tool-lock]")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const restoredProperties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(restoredProperties.getByRole("button", { name: "Stroke color #e03131" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".persistence-status")).toHaveText("Saved");

  await page.evaluate(() => {
    (window as unknown as { __notePersistenceCalls: string[] }).__notePersistenceCalls = [];
  });
  await page.mouse.click(bounds.x + 620, bounds.y + 280);
  await expect.poll(async () => (await persistenceCommands(page)).filter((command) => command === "apply_scene_changes").length).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { __notePersistenceCalls: string[] }).__notePersistenceCalls = [];
  });

  const opacity = restoredProperties.getByRole("slider", { name: "Opacity" });
  await opacity.scrollIntoViewIfNeeded();
  const opacityBounds = await opacity.boundingBox();
  if (!opacityBounds) throw new Error("Opacity slider was not visible.");
  await page.mouse.move(opacityBounds.x + opacityBounds.width - 2, opacityBounds.y + opacityBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(opacityBounds.x + opacityBounds.width * 0.45, opacityBounds.y + opacityBounds.height / 2, { steps: 10 });
  await page.waitForTimeout(650);
  expect((await persistenceCommands(page)).filter((command) => command === "apply_scene_changes")).toHaveLength(0);
  await page.mouse.up();
  await expect.poll(async () => (await persistenceCommands(page)).filter((command) => command === "apply_scene_changes").length).toBe(1);
});

test("persists the rounded rectangle default and an explicit subtle preference", async ({ page }) => {
  await installTauriStorageMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(properties).toBeVisible();
  await expect(properties.getByRole("button", { name: "Rounded corners" })).toHaveAttribute("aria-pressed", "true");

  await properties.getByRole("button", { name: "Subtle corners" }).click();
  await expect(properties.getByRole("button", { name: "Subtle corners" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => persistenceCommands(page)).toContain("save_session_state");

  await page.reload();
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const restoredProperties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(restoredProperties.getByRole("button", { name: "Subtle corners" })).toHaveAttribute("aria-pressed", "true");
  await expect(restoredProperties.getByRole("button", { name: "Rounded corners" })).toHaveAttribute("aria-pressed", "false");
});

test("persists a bound arrow endpoint and resolves it from the current target after reload", async ({ page }) => {
  await installTauriStorageMock(page);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.mouse.click(canvasBounds.x + 360, canvasBounds.y + 300);
  const rectangleControl = page.getByRole("button", { name: "Select and move rectangle element" });
  const targetId = await rectangleControl.getAttribute("data-canvas-element-id");
  if (!targetId) throw new Error("Rectangle target id was unavailable.");

  await page.getByRole("button", { name: "Arrow (A / 5)" }).click();
  const rectangleBounds = await rectangleControl.boundingBox();
  if (!rectangleBounds) throw new Error("Rectangle target bounds were unavailable.");
  await page.mouse.click(
    rectangleBounds.x + rectangleBounds.width - 1,
    rectangleBounds.y + rectangleBounds.height / 2,
  );
  const rightAnchor = page.locator(`[data-connector-target-id="${targetId}"][data-connector-anchor="right"]`);
  const anchorBounds = await rightAnchor.boundingBox();
  if (!anchorBounds) throw new Error("Connector anchor was not available.");
  await page.mouse.move(canvasBounds.x + 800, anchorBounds.y + anchorBounds.height / 2, { steps: 5 });
  await page.mouse.click(canvasBounds.x + 800, anchorBounds.y + anchorBounds.height / 2);
  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await expect(arrow).toBeVisible();
  await expect(page.locator(".persistence-status")).toHaveText("Saved");

  await page.reload();
  await expect(rectangleControl).toBeVisible();
  await expect(arrow).toBeVisible();
  const beforeTargetMove = await arrow.boundingBox();
  if (!beforeTargetMove) throw new Error("Arrow bounds were not available.");
  await rectangleControl.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await arrow.boundingBox())?.width ?? 0).toBeLessThan(beforeTargetMove.width - 8);
});

async function persistenceCommands(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __notePersistenceCalls: string[] }).__notePersistenceCalls,
  );
}

async function installTauriStorageMock(page: Page) {
  await page.addInitScript((storageKey) => {
    type ElementRecord = { id: string; pageId: string } & Record<string, unknown>;
    type PageRecord = {
      id: string;
      folderId: string;
      title: string;
      isBookmarked?: boolean;
      revision: number;
    };
    type Storage = {
      elements: ElementRecord[];
      folders: Array<{ id: string; name: string }>;
      isDarkMode?: boolean;
      pages: PageRecord[];
      sessionState?: Record<string, unknown>;
      warnings: string[];
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      __notePersistenceCalls: string[];
      isTauri: boolean;
    };
    const empty = (): Storage => ({ elements: [], folders: [], pages: [], warnings: [] });
    const read = (): Storage => {
      const value = localStorage.getItem(storageKey);
      return value ? JSON.parse(value) as Storage : empty();
    };
    const write = (value: Storage) => localStorage.setItem(storageKey, JSON.stringify(value));
    runtime.isTauri = true;
    runtime.__notePersistenceCalls = [];
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        runtime.__notePersistenceCalls.push(command);
        const data = read();
        if (command === "initialize_storage") {
          return { databasePath: "mock.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        }
        if (command === "load_workspace_data") return data;
        if (command === "reconcile_workspace_structure") {
          const structure = args.structure as {
            folders: Storage["folders"];
            isDarkMode?: boolean;
            pages: Array<Omit<PageRecord, "revision">>;
          };
          const revisions = new Map(data.pages.map((storedPage) => [storedPage.id, storedPage.revision]));
          data.folders = structure.folders;
          data.isDarkMode = structure.isDarkMode;
          data.pages = structure.pages.map((storedPage) => ({
            ...storedPage,
            revision: revisions.get(storedPage.id) ?? 0,
          }));
          write(data);
          return { pages: data.pages };
        }
        if (command === "apply_scene_changes") {
          const batch = args.batch as {
            baseRevision: number;
            deletedElementIds: string[];
            pageId: string;
            upserts: ElementRecord[];
          };
          const storedPage = data.pages.find((candidate) => candidate.id === batch.pageId);
          if (!storedPage || storedPage.revision !== batch.baseRevision) {
            throw new Error("revision conflict");
          }
          const deleted = new Set(batch.deletedElementIds);
          const retained = data.elements.filter(
            (element) => element.pageId !== batch.pageId || !deleted.has(element.id),
          );
          const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
          data.elements = retained.map((element) => upserts.get(element.id) ?? element);
          for (const element of batch.upserts) {
            if (!retained.some((candidate) => candidate.id === element.id)) {
              data.elements.push(element);
            }
          }
          storedPage.revision += 1;
          write(data);
          return { newRevision: storedPage.revision, pageId: batch.pageId };
        }
        if (command === "save_session_state") {
          data.sessionState = args.state as Record<string, unknown>;
          write(data);
          return;
        }
        if (command === "load_asset") throw new Error("unexpected asset load");
        if (command === "save_asset") throw new Error("unexpected asset save");
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, STORAGE_KEY);
}
