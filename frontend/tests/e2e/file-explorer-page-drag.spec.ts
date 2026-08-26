import { expect, test, type Locator, type Page } from "@playwright/test";

type WorkspacePage = {
  folderId: string;
  id: string;
  isBookmarked: boolean;
  revision: number;
  title: string;
};

async function installExplorerWorkspace(page: Page) {
  await page.addInitScript(() => {
    type Workspace = {
      elements: unknown[];
      folders: Array<{ id: string; isBookmarked: boolean; name: string }>;
      isDarkMode: boolean;
      pages: WorkspacePage[];
      sessionState: {
        openPageTabIds: string[];
        selectedFolderId: string;
        selectedPageId: string;
      };
      warnings: string[];
    };

    const workspace: Workspace = {
      elements: [],
      folders: [
        { id: "source", isBookmarked: false, name: "Source" },
        { id: "target", isBookmarked: false, name: "Target" },
      ],
      isDarkMode: false,
      pages: [
        { folderId: "", id: "root", isBookmarked: false, revision: 0, title: "Root anchor" },
        { folderId: "source", id: "source-first", isBookmarked: false, revision: 0, title: "Source first" },
        { folderId: "source", id: "source-second", isBookmarked: false, revision: 0, title: "Source second" },
        { folderId: "target", id: "target-existing", isBookmarked: false, revision: 0, title: "Target existing" },
      ],
      sessionState: {
        openPageTabIds: ["root"],
        selectedFolderId: "",
        selectedPageId: "root",
      },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      __explorerWorkspace: Workspace;
      isTauri: boolean;
    };

    runtime.isTauri = true;
    runtime.__explorerWorkspace = workspace;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "initialize_storage") {
          return { databasePath: "explorer-drag.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        }
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") {
          const structure = args.structure as {
            folders: Workspace["folders"];
            isDarkMode: boolean;
            pages: Array<Omit<WorkspacePage, "revision">>;
          };
          const revisions = new Map(workspace.pages.map((item) => [item.id, item.revision]));
          workspace.folders = structure.folders;
          workspace.isDarkMode = structure.isDarkMode;
          workspace.pages = structure.pages.map((item) => ({
            ...item,
            revision: revisions.get(item.id) ?? 0,
          }));
          return { pages: workspace.pages };
        }
        if (command === "save_session_state") {
          workspace.sessionState = args.state as Workspace["sessionState"];
          return;
        }
        if (command === "apply_scene_changes") {
          return { newRevision: 0, pageId: "root" };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
}

async function dragWithPointer(
  page: Page,
  source: Locator,
  target: Locator,
  expectDropTarget = true,
) {
  const sourceBox = await source.boundingBox();

  if (!sourceBox) {
    throw new Error("The Explorer drag source was not visible.");
  }

  const sourcePoint = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };

  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x + 8, sourcePoint.y + 2);
  await expect(source).toHaveClass(/is-dragging/);
  const targetBox = await target.boundingBox();

  if (!targetBox) {
    throw new Error("The Explorer drag target was not visible.");
  }

  const targetPoint = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  };

  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
  if (expectDropTarget) {
    await expect(target).toHaveClass(/is-drop-target/);
  }
  await page.mouse.up();
}

async function ensureFolderExpanded(folder: Locator) {
  const folderRow = folder.locator(".nav-item-folder").first();

  await expect(folderRow).toBeVisible();
  if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
    await folderRow.click({ position: { x: 96, y: 12 } });
  }
  await expect(folderRow).toHaveAttribute("aria-expanded", "true");
}

async function workspacePages(page: Page) {
  return page.evaluate(() => {
    const runtime = window as unknown as {
      __explorerWorkspace: { pages: WorkspacePage[] };
    };

    return runtime.__explorerWorkspace.pages.map(({ folderId, id }) => ({ folderId, id }));
  });
}

test("Explorer pointer drags move selected pages to folders and back to the root", async ({ page }) => {
  await installExplorerWorkspace(page);
  await page.goto("/");

  const sourceFolder = page.locator('[data-page-drop-folder-id="source"]');
  const targetFolder = page.locator('[data-page-drop-folder-id="target"]');
  await ensureFolderExpanded(sourceFolder);

  const firstSourcePage = sourceFolder.locator(".nav-item-page").filter({ hasText: "Source first" });
  const secondSourcePage = sourceFolder.locator(".nav-item-page").filter({ hasText: "Source second" });
  await firstSourcePage.click();
  await secondSourcePage.click({ modifiers: ["Control"] });

  await dragWithPointer(page, firstSourcePage, targetFolder.locator(".nav-item-folder"));
  await expect(sourceFolder.locator(".nav-item-page")).toHaveCount(0);
  await expect(targetFolder.locator(".item-count")).toHaveText("3");
  await expect.poll(() => workspacePages(page)).toEqual([
    { folderId: "", id: "root" },
    { folderId: "target", id: "target-existing" },
    { folderId: "target", id: "source-first" },
    { folderId: "target", id: "source-second" },
  ]);

  await ensureFolderExpanded(targetFolder);
  const movedFirstPage = targetFolder.locator(".nav-item-page").filter({ hasText: "Source first" });
  await movedFirstPage.click();
  await dragWithPointer(
    page,
    movedFirstPage,
    page.locator('[data-page-drop-folder-id=""]'),
  );

  await expect.poll(() => workspacePages(page)).toEqual([
    { folderId: "", id: "root" },
    { folderId: "", id: "source-first" },
    { folderId: "target", id: "target-existing" },
    { folderId: "target", id: "source-second" },
  ]);
});

test("Explorer pointer drags leave pages unchanged without a new target", async ({ page }) => {
  await installExplorerWorkspace(page);
  await page.goto("/");

  const rootPage = page
    .locator('[data-page-drop-folder-id=""] .nav-item-page')
    .filter({ hasText: "Root anchor" });

  await dragWithPointer(page, rootPage, page.locator(".workspace"), false);
  await expect.poll(() => workspacePages(page)).toEqual([
    { folderId: "", id: "root" },
    { folderId: "source", id: "source-first" },
    { folderId: "source", id: "source-second" },
    { folderId: "target", id: "target-existing" },
  ]);
  await expect(rootPage).toHaveCount(1);
});
