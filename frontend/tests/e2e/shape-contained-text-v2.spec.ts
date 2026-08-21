import { expect, test, type Page } from "@playwright/test";

test("locked shape edits contained text as one stable connector target and one history commit", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const shape = page.locator('[data-canvas-element-id="shape"]');
  await expect(shape).toContainText("Original label");
  await expect(shape).toHaveAttribute("aria-label", /Original label/);
  await shape.focus();
  await shape.press("Enter");
  await expect(shape).toHaveAttribute("aria-pressed", "true");

  const baselineWrites = await writeCount(page);
  await shape.press("F2");
  const editor = shape.locator('.shape-contained-text-editor-content[role="textbox"]');
  await expect(editor).toBeFocused();
  await editor.fill("Discarded");
  await editor.press("Escape");
  await expect(shape).toContainText("Original label");
  await expect.poll(() => writeCount(page)).toBe(baselineWrites);
  await expect(shape).toBeFocused();

  await shape.press("F2");
  await expect(editor).toBeFocused();
  await editor.fill("Committed label");
  await editor.press("Control+Enter");
  await expect(shape).toContainText("Committed label");
  await expect(shape).toBeFocused();
  await expect.poll(() => writeCount(page)).toBe(baselineWrites + 1);

  const persisted = await page.evaluate(() => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements);
  const persistedShape = persisted.find((element) => element.id === "shape");
  const connector = persisted.find((element) => element.id === "connector");
  expect(persistedShape).toMatchObject({
    id: "shape",
    locked: true,
    text: { content: "Committed label" },
    type: "shape",
  });
  expect(connector).toMatchObject({
    start: { kind: "element", targetElementId: "shape" },
  });

  await page.getByRole("tabpanel").focus();
  await page.keyboard.press("Control+z");
  await expect(shape).toContainText("Original label");
  await page.keyboard.press("Control+y");
  await expect(shape).toContainText("Committed label");
});

test("double-click and blur preserve empty omission, then rich text survives reload and copy", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const shape = page.locator('[data-canvas-element-id="blank-shape"]');
  await shape.focus();
  await shape.press("Enter");
  const baselineWrites = await writeCount(page);
  await page.locator(".selection-frame-move-surface").dblclick();
  const editor = shape.locator('.shape-contained-text-editor-content[role="textbox"]');
  await expect(editor).toBeFocused();
  await page.getByRole("tabpanel").click({ position: { x: 40, y: 80 } });
  await expect.poll(() => writeCount(page)).toBe(baselineWrites);
  expect(await shapeRecord(page, "blank-shape")).not.toHaveProperty("text");

  await shape.focus();
  await shape.press("Enter");
  await page.locator(".selection-frame-move-surface").dblclick();
  await editor.fill("Rich label");
  await editor.press("Control+a");
  await editor.press("Control+b");
  await editor.press("Control+Enter");
  await expect(shape.locator("strong")).toHaveText("Rich label");
  await expect.poll(() => writeCount(page)).toBe(baselineWrites + 1);

  await page.reload();
  const reloaded = page.locator('[data-canvas-element-id="blank-shape"]');
  await expect(reloaded.locator("strong")).toHaveText("Rich label");
  await reloaded.focus();
  await reloaded.press("Enter");
  await reloaded.press("Control+c");
  await reloaded.press("Control+v");
  await expect.poll(async () => page.locator('[data-canvas-element-type="shape"]', { hasText: "Rich label" }).count()).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements.filter((element) => element.type === "shape" && (element.text as { content?: string } | undefined)?.content === "Rich label").length)).toBe(2);
  const copies = await page.evaluate(() => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements.filter((element) => element.type === "shape" && (element.text as { content?: string } | undefined)?.content === "Rich label"));
  expect(copies).toHaveLength(2);
  expect(new Set(copies.map((element) => element.id)).size).toBe(2);
});

test("rich structure clips and transforms with its composite shape through resize and delete undo", async ({ page }) => {
  await installShapeTextWorkspace(page);
  await page.goto("/");

  const shape = page.locator('[data-canvas-element-id="rich-shape"]');
  const text = shape.locator(".shape-contained-text-display");
  await expect(shape).toHaveAttribute("aria-label", /Heading\s+Item\s+Link/);
  await expect(text.locator("h2")).toHaveText("Heading");
  await expect(text.locator("ul li")).toHaveText("Item");
  await expect(text.locator("img")).toHaveAttribute("alt", "Pixel");
  await expect(text.locator(".shape-text-link")).toHaveText("Link");
  await expect(text.locator("a")).toHaveCount(0);
  await expect(shape).toHaveCSS("transform", /matrix/);
  await expect(text).toHaveCSS("overflow", "hidden");

  const beforeWidth = await shape.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width));
  await shape.focus();
  await shape.press("Enter");
  const resize = page.getByRole("button", { name: "Resize selected elements from se" });
  await resize.press("Shift+ArrowRight");
  await expect.poll(() => shape.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width))).toBeGreaterThan(beforeWidth);
  await expect(text.locator("h2")).toHaveText("Heading");
  const connector = await page.evaluate(() => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements.find((element) => element.id === "rich-connector"));
  expect(connector).toMatchObject({ start: { kind: "element", targetElementId: "rich-shape" } });

  await page.keyboard.press("Delete");
  await expect(shape).toHaveCount(0);
  await page.getByRole("tabpanel").focus();
  await page.keyboard.press("Control+z");
  const restored = page.locator('[data-canvas-element-id="rich-shape"]');
  await expect(restored.locator("h2")).toHaveText("Heading");
  await expect(restored).toHaveAttribute("data-canvas-element-id", "rich-shape");
});

async function writeCount(page: Page) {
  return page.evaluate(() => (window as unknown as { __shapeTextWrites: number }).__shapeTextWrites);
}

async function shapeRecord(page: Page, id: string) {
  return page.evaluate((shapeId) => (window as unknown as {
    __shapeTextWorkspace: { elements: Array<Record<string, unknown>> };
  }).__shapeTextWorkspace.elements.find((element) => element.id === shapeId), id);
}

async function installShapeTextWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const style = {
      fillColor: { kind: "fixed", value: "#fff4cc" },
      roughness: 1,
      roundness: 0.4,
      seed: 42,
      strokeColor: { kind: "theme", token: "foreground" },
      strokeStyle: "solid",
      strokeWidth: 2,
    };
    const workspace = {
      elements: [
        {
          createdAt: 1,
          height: 180,
          id: "shape",
          locked: true,
          opacity: 1,
          pageId: "page",
          rotation: 12,
          shape: "rectangle",
          style,
          text: {
            content: "Original label",
            richContent: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Original label", marks: [{ type: "bold" }] }] }] },
          },
          type: "shape",
          updatedAt: 1,
          width: 280,
          x: 360,
          y: 240,
          zIndex: 1,
        },
        {
          createdAt: 1,
          height: 180,
          id: "blank-shape",
          locked: false,
          opacity: 1,
          pageId: "page",
          rotation: -8,
          shape: "ellipse",
          style: { ...style, fillColor: { kind: "fixed", value: "#dff7ed" }, seed: 43 },
          type: "shape",
          updatedAt: 1,
          width: 280,
          x: 760,
          y: 240,
          zIndex: 2,
        },
        {
          createdAt: 1,
          height: 220,
          id: "rich-shape",
          locked: false,
          opacity: 1,
          pageId: "page",
          rotation: 18,
          shape: "diamond",
          style: { ...style, fillColor: { kind: "fixed", value: "#e8e2ff" }, seed: 44 },
          text: {
            content: "Heading\nItem\nLink",
            richContent: {
              type: "doc",
              content: [
                { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
                { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item", marks: [{ type: "italic" }] }] }] }] },
                { type: "image", attrs: { src: "data:image/png;base64,AA==", alt: "Pixel", title: null, width: 24, height: 24 } },
                { type: "paragraph", content: [{ type: "text", text: "Link", marks: [{ type: "link", attrs: { href: "https://example.com", target: null, rel: null, class: null, title: null } }] }] },
              ],
            },
          },
          type: "shape",
          updatedAt: 1,
          width: 320,
          x: 520,
          y: 520,
          zIndex: 3,
        },
        {
          createdAt: 1,
          end: { kind: "free", x: 760, y: 330 },
          id: "connector",
          locked: false,
          opacity: 1,
          pageId: "page",
          routing: "straight",
          start: { kind: "element", targetElementId: "shape", anchor: { t: 0.25 }, gap: 6 },
          style: { ...style, endArrowhead: "arrow", fillColor: null, startArrowhead: "none" },
          type: "connector",
          updatedAt: 1,
          zIndex: 4,
        },
        {
          createdAt: 1,
          end: { kind: "free", x: 940, y: 630 },
          id: "rich-connector",
          locked: false,
          opacity: 1,
          pageId: "page",
          routing: "straight",
          start: { kind: "element", targetElementId: "rich-shape", anchor: { t: 0.25 }, gap: 6 },
          style: { ...style, endArrowhead: "arrow", fillColor: null, startArrowhead: "none", seed: 45 },
          type: "connector",
          updatedAt: 1,
          zIndex: 5,
        },
      ] as ElementRecord[],
      folders: [],
      isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Shape text" }],
      sessionState: { openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" },
      warnings: [],
    };
    const savedElements = window.localStorage.getItem("shape-text-elements");
    if (savedElements) workspace.elements = JSON.parse(savedElements) as ElementRecord[];
    const runtime = window as unknown as {
      __shapeTextWorkspace: typeof workspace;
      __shapeTextWrites: number;
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.__shapeTextWorkspace = workspace;
    runtime.__shapeTextWrites = 0;
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "initialize_storage") return { databasePath: "shape-text.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
        if (command === "load_workspace_data") return workspace;
        if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
        if (command === "apply_scene_changes") {
          runtime.__shapeTextWrites += 1;
          const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
          const deleted = new Set(batch.deletedElementIds);
          const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
          workspace.elements = workspace.elements
            .filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id))
            .map((element) => upserts.get(element.id) ?? element);
          for (const element of batch.upserts) {
            if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
          }
          window.localStorage.setItem("shape-text-elements", JSON.stringify(workspace.elements));
          workspace.pages[0].revision += 1;
          return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
        }
        return undefined;
      },
    };
  });
}
