import { expect, test, type Page } from "@playwright/test";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_DATA_URL.split(",")[1], "base64");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("dropping an image file places it at the canvas pointer", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Image (I / 9)" })).toBeVisible();
  await expect(page.locator('input[type="file"][accept="image/*"]')).toHaveCount(1);

  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were unavailable.");

  const dropX = 360;
  const dropY = 260;
  await dispatchFileDrop(page, [{ dataUrl: PNG_DATA_URL, name: "dropped-image.png", type: "image/png" }], {
    x: bounds.x + dropX,
    y: bounds.y + dropY,
  });

  const image = page.locator('.text-block-image[alt="dropped-image.png"]');
  await expect(image).toBeVisible();
  const position = await image.locator("xpath=ancestor::*[contains(@class, 'text-block')][1]").evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
  expect(position.x).toBeCloseTo(dropX, 0);
  expect(position.y).toBeCloseTo(dropY, 0);
  await expect(imageImportStatus(page)).toHaveText("Imported 1 image: dropped-image.png.");
});

test("dropping an unsupported file leaves the canvas unchanged", async ({ page }) => {
  await dispatchFileDrop(page, [{ dataUrl: "data:text/plain;base64,bm90ZXM=", name: "notes.txt", type: "text/plain" }]);

  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("Only image files can be imported.");
  await expectNoSaveFailure(page);
});

test("dropping an oversized image leaves the canvas unchanged", async ({ page }) => {
  await dispatchFileDrop(page, [{ name: "large.png", size: 16 * 1024 * 1024 + 1, type: "image/png" }]);

  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("Image exceeds the 16 MiB size limit.");
  await expectNoSaveFailure(page);
});

test("dropping multiple images cascades them from the pointer", async ({ page }) => {
  await dispatchFileDrop(page, [
    { dataUrl: PNG_DATA_URL, name: "first-drop.png", type: "image/png" },
    { dataUrl: PNG_DATA_URL, name: "second-drop.png", type: "image/png" },
  ]);

  const positions = await Promise.all(["first-drop.png", "second-drop.png"].map(async (name) => {
    const image = page.locator(`.text-block-image[alt="${name}"]`);
    await expect(image).toBeVisible();
    return image.locator("xpath=ancestor::*[contains(@class, 'text-block')][1]").evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
    }));
  }));
  expect(positions[1]).toEqual({ x: positions[0].x + 24, y: positions[0].y + 24 });
  await expect(imageImportStatus(page)).toHaveText("Imported 2 images.");
});

test("a partial image drop reports imported and skipped counts", async ({ page }) => {
  await dispatchFileDrop(page, [
    { dataUrl: PNG_DATA_URL, name: "accepted.png", type: "image/png" },
    { dataUrl: "data:text/plain;base64,bm90ZXM=", name: "notes.txt", type: "text/plain" },
  ]);

  await expect(page.locator('.text-block-image[alt="accepted.png"]')).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Only image files can be imported.");
  await expect(imageImportStatus(page)).toHaveText("Imported 1 image: accepted.png. Skipped 1 file.");
});

test("a newer drop keeps its status and error after an older delayed drop resolves", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeReadAsDataUrl = FileReader.prototype.readAsDataURL;
    let shouldDelayFirstRead = true;
    FileReader.prototype.readAsDataURL = function delayOnlyTheFirstDrop(blob) {
      if (!shouldDelayFirstRead) {
        nativeReadAsDataUrl.call(this, blob);
        return;
      }
      shouldDelayFirstRead = false;
      (window as unknown as { releaseFirstDropRead?: () => void }).releaseFirstDropRead = () => {
        nativeReadAsDataUrl.call(this, blob);
      };
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  await dispatchFileDrop(page, [{ dataUrl: PNG_DATA_URL, name: "older.png", type: "image/png" }]);
  await dispatchFileDrop(page, [
    { dataUrl: PNG_DATA_URL, name: "current.png", type: "image/png" },
    { dataUrl: "data:text/plain;base64,bm90ZXM=", name: "ignored.txt", type: "text/plain" },
  ]);

  await expect(page.getByRole("alert")).toHaveText("Only image files can be imported.");
  await expect(imageImportStatus(page)).toHaveText("Imported 1 image: current.png. Skipped 1 file.");

  await page.evaluate(() => {
    (window as unknown as { releaseFirstDropRead?: () => void }).releaseFirstDropRead?.();
  });
  await page.waitForTimeout(100);

  await expect(page.locator('.text-block-image[alt="older.png"]')).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("Only image files can be imported.");
  await expect(imageImportStatus(page)).toHaveText("Imported 1 image: current.png. Skipped 1 file.");
});

test("a newer picker selection invalidates a delayed external drop", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeReadAsDataUrl = FileReader.prototype.readAsDataURL;
    let shouldDelayFirstRead = true;
    FileReader.prototype.readAsDataURL = function delayOnlyTheFirstDrop(blob) {
      if (!shouldDelayFirstRead) {
        nativeReadAsDataUrl.call(this, blob);
        return;
      }
      shouldDelayFirstRead = false;
      (window as unknown as { releaseFirstDropRead?: () => void }).releaseFirstDropRead = () => {
        nativeReadAsDataUrl.call(this, blob);
      };
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were unavailable.");

  await dispatchFileDrop(page, [{ dataUrl: PNG_DATA_URL, name: "older-drop.png", type: "image/png" }]);
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Image (I / 9)" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ buffer: PNG, mimeType: "image/png", name: "picker-current.png" });
  await page.mouse.move(bounds.x + 180, bounds.y + 180);
  await expect(page.locator(".canvas-image-placement-preview")).toBeVisible();
  await page.mouse.click(bounds.x + 180, bounds.y + 180);
  await expect(page.locator('.text-block-image[alt="picker-current.png"]')).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { releaseFirstDropRead?: () => void }).releaseFirstDropRead?.();
  });
  await page.waitForTimeout(100);

  await expect(page.locator('.text-block-image[alt="older-drop.png"]')).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(imageImportStatus(page)).toHaveCount(0);
});

test("a stale drop cannot commit after its managed asset save resolves", async ({ page }) => {
  await installDelayedAssetStorageMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  await dispatchFileDrop(page, [{ dataUrl: PNG_DATA_URL, name: "older-saved.png", type: "image/png" }]);
  await expect.poll(() => assetSaveCalls(page)).toBe(1);

  await dispatchFileDrop(page, [
    { dataUrl: PNG_DATA_URL, name: "current-saved.png", type: "image/png" },
    { dataUrl: "data:text/plain;base64,bm90ZXM=", name: "ignored.txt", type: "text/plain" },
  ]);
  await expect.poll(() => assetSaveCalls(page)).toBe(2);
  await expect(page.locator('.text-block-image[alt="current-saved.png"]')).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Only image files can be imported.");
  await expect(imageImportStatus(page)).toHaveText("Imported 1 image: current-saved.png. Skipped 1 file.");

  await page.evaluate(() => {
    (window as unknown as { releaseFirstAssetSave?: () => void }).releaseFirstAssetSave?.();
  });
  await page.waitForTimeout(100);

  await expect(page.locator('.text-block-image[alt="older-saved.png"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Select and move image older-saved\.png/i })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("Only image files can be imported.");
  await expect(imageImportStatus(page)).toHaveText("Imported 1 image: current-saved.png. Skipped 1 file.");
});

test("a Files transfer without readable files reports an import error without saving", async ({ page }) => {
  const wasPrevented = await dispatchUnreadableFileDrop(page);

  expect(wasPrevented).toBe(true);
  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("No readable image files were found in this drop.");
  await expectNoSaveFailure(page);
});

test("custom page and text data transfers are not prevented", async ({ page }) => {
  const results = await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('[role="tabpanel"]');
    if (!target) throw new Error("Canvas target was unavailable.");
    return ["text/plain", "application/x-note-page-drag"].map((type) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(type, "internal data");
      const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
  });

  expect(results).toEqual([false, false]);
});

test("a page switch while image data is being read does not create a block on the new page", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeReadAsDataUrl = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function readAsDataUrlAfterDelay(blob) {
      window.setTimeout(() => nativeReadAsDataUrl.call(this, blob), 250);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  await dispatchFileDrop(page, [{ dataUrl: PNG_DATA_URL, name: "slow-drop.png", type: "image/png" }]);
  await page.getByRole("button", { name: "Create page" }).click();

  await page.waitForTimeout(350);
  await expect(page.locator(".text-block-image")).toHaveCount(0);
});

type DroppedFile = Readonly<{
  dataUrl?: string;
  name: string;
  size?: number;
  type: string;
}>;

async function dispatchFileDrop(
  page: Page,
  files: readonly DroppedFile[],
  point?: Readonly<{ x: number; y: number }>,
) {
  await page.evaluate(({ files, point }) => {
    const target = document.querySelector<HTMLElement>('[role="tabpanel"]');
    if (!target) throw new Error("Canvas target was unavailable.");

    const dataTransfer = new DataTransfer();
    for (const file of files) {
      const bytes = file.dataUrl
        ? Uint8Array.from(atob(file.dataUrl.split(",")[1]), (character) => character.charCodeAt(0))
        : new Uint8Array(file.size ?? 0);
      dataTransfer.items.add(new File([bytes], file.name, { type: file.type }));
    }

    const options = {
      bubbles: true,
      cancelable: true,
      clientX: point?.x ?? target.getBoundingClientRect().left + 120,
      clientY: point?.y ?? target.getBoundingClientRect().top + 120,
      dataTransfer,
    };
    target.dispatchEvent(new DragEvent("dragover", options));
    target.dispatchEvent(new DragEvent("drop", options));
  }, { files, point });
}

async function dispatchUnreadableFileDrop(page: Page) {
  return page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('[role="tabpanel"]');
    if (!target) throw new Error("Canvas target was unavailable.");

    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: target.getBoundingClientRect().left + 120 },
      clientY: { value: target.getBoundingClientRect().top + 120 },
      dataTransfer: { value: { files: [], items: [], types: ["Files"] } },
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function expectNoSaveFailure(page: Page) {
  await expect(page.locator(".persistence-status-failed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry save" })).toHaveCount(0);
}

function imageImportStatus(page: Page) {
  return page.getByRole("status").filter({ hasText: "Imported" });
}

async function assetSaveCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { __noteAssetSaveCalls: number }).__noteAssetSaveCalls);
}

async function installDelayedAssetStorageMock(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = { id: string; pageId: string } & Record<string, unknown>;
    type PageRecord = { id: string; folderId: string; revision: number; title: string };
    type Storage = {
      elements: ElementRecord[];
      folders: Array<{ id: string; name: string }>;
      isDarkMode?: boolean;
      pages: PageRecord[];
      warnings: string[];
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __noteAssetSaveCalls: number;
      isTauri: boolean;
      releaseFirstAssetSave?: () => void;
    };
    const data: Storage = { elements: [], folders: [], pages: [], warnings: [] };
    runtime.isTauri = true;
    runtime.__noteAssetSaveCalls = 0;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
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
          const revisions = new Map(data.pages.map((page) => [page.id, page.revision]));
          data.folders = structure.folders;
          data.isDarkMode = structure.isDarkMode;
          data.pages = structure.pages.map((page) => ({ ...page, revision: revisions.get(page.id) ?? 0 }));
          return { pages: data.pages };
        }
        if (command === "save_asset") {
          runtime.__noteAssetSaveCalls += 1;
          const request = args.request as { fileName?: string; mediaType: string };
          const asset = {
            byteSize: 1,
            fileName: request.fileName ?? "Canvas image",
            id: `asset-${runtime.__noteAssetSaveCalls}`,
            mediaType: request.mediaType,
            naturalHeight: 1,
            naturalWidth: 1,
          };
          if (runtime.__noteAssetSaveCalls === 1) {
            return await new Promise((resolve) => {
              runtime.releaseFirstAssetSave = () => resolve(asset);
            });
          }
          return asset;
        }
        if (command === "apply_scene_changes") {
          const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
          const deleted = new Set(batch.deletedElementIds);
          data.elements = data.elements.filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id));
          const byId = new Map(data.elements.map((element) => [element.id, element]));
          for (const element of batch.upserts) byId.set(element.id, element);
          data.elements = [...byId.values()];
          const page = data.pages.find((candidate) => candidate.id === batch.pageId);
          if (!page) throw new Error("missing page");
          page.revision += 1;
          return { newRevision: page.revision, pageId: batch.pageId };
        }
        if (command === "save_session_state") return;
        if (command === "load_asset") throw new Error("unexpected asset load");
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
}
