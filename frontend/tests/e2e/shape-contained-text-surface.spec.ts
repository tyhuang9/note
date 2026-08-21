import { expect, test, type Locator, type Page } from "@playwright/test";

const surfaceBackgrounds: Record<string, string> = {
  "labeled-diamond": "rgb(232, 226, 255)",
  "labeled-ellipse": "rgb(15, 76, 92)",
  "labeled-rectangle": "rgb(232, 226, 255)",
};

const defaultFillCases = [
  { fillColor: { kind: "fixed", value: "#e8e2ff" }, id: "rectangle", shape: "rectangle" },
  { fillColor: { kind: "fixed", value: "#0f4c5c" }, id: "ellipse", shape: "ellipse" },
  { fillColor: { kind: "fixed", value: "#e8e2ff" }, id: "diamond", shape: "diamond" },
] as const;

const edgeFillCases = [
  { fillColor: { kind: "fixed", value: "#ff000080" }, id: "alpha", shape: "rectangle" },
  { fillColor: { kind: "theme", token: "foreground" }, id: "theme-foreground", shape: "ellipse" },
  { fillColor: { kind: "theme", token: "muted" }, id: "theme-muted", shape: "diamond" },
] as const;

for (const dark of [false, true]) {
  for (const zoom of [1, 2]) {
    test(`keeps ${dark ? "dark" : "light"} contained rich text quiet and readable at ${zoom * 100}%`, async ({ page }, testInfo) => {
      await installWorkspace(page, dark);
      await page.setViewportSize({ width: 3_000, height: 1_600 });
      await page.goto("/");
      if (zoom === 2) {
        await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      }

      const ids = ["labeled-rectangle", "labeled-ellipse", "labeled-diamond"];
      const initialSvg = new Map<string, Awaited<ReturnType<typeof svgSnapshot>>>();
      for (const id of ids) {
        const shape = page.locator(`[data-canvas-element-id="${id}"]`);
        await expect(shape).toBeVisible();
        await assertReadableQuietSurface(shape, surfaceBackgrounds[id]);
        initialSvg.set(id, await svgSnapshot(shape.locator("svg.primitive-shape")));
      }

      for (const shape of ["rectangle", "ellipse", "diamond"]) {
        const unlabeled = page.locator(`[data-canvas-element-id="unlabeled-${shape}"]`);
        await expect(unlabeled).not.toHaveClass(/has-contained-text-surface/);
        await expect(unlabeled.locator(".shape-contained-text")).toHaveCount(0);
        expect(await unlabeled.locator("svg.primitive-shape path").count()).toBeGreaterThan(1);
      }

      await page.getByRole("button", { name: "Find in canvas" }).click();
      await page.getByRole("textbox", { name: "Find in canvas" }).fill("Quiet");
      for (const [index, id] of ids.entries()) {
        if (index > 0) await page.getByRole("button", { name: "Next match" }).click();
        const shape = page.locator(`[data-canvas-element-id="${id}"]`);
        const activeMatch = shape.locator(".canvas-search-match.is-active-search-match");
        await expect(activeMatch).toHaveCount(1);
        await assertReadableQuietSurface(shape, surfaceBackgrounds[id]);
        for (const candidateId of ids) {
          const match = page.locator(`[data-canvas-element-id="${candidateId}"] .canvas-search-match`);
          await expect(match).toHaveCount(1);
          expect(await contrastRatio(match, match)).toBeGreaterThanOrEqual(4.5);
        }
        expect(await svgSnapshot(shape.locator("svg.primitive-shape"))).toEqual(initialSvg.get(id));
        if (id === "labeled-ellipse") {
          const ellipseScreenshotName = `contained-ellipse-find-active-${dark ? "dark" : "light"}-${zoom * 100}.png`;
          const ellipseScreenshotPath = testInfo.outputPath(ellipseScreenshotName);
          await shape.screenshot({ path: ellipseScreenshotPath });
          await testInfo.attach(ellipseScreenshotName, { path: ellipseScreenshotPath, contentType: "image/png" });
        }
      }
      const screenshotName = `contained-diamond-${dark ? "dark" : "light"}-${zoom * 100}.png`;
      const screenshotPath = testInfo.outputPath(screenshotName);
      await page.locator('[data-canvas-element-id="labeled-diamond"]').screenshot({ path: screenshotPath });
      await testInfo.attach(screenshotName, { path: screenshotPath, contentType: "image/png" });
      await page.getByRole("button", { name: "Close search", exact: true }).click();

      for (const id of ids) {
        const shape = page.locator(`[data-canvas-element-id="${id}"]`);
        await shape.focus();
        await shape.press("F2");
        const editor = shape.locator(".shape-contained-text-editor-surface");
        await expect(editor).toBeVisible();
        await expect(editor).toHaveCSS("background-color", surfaceBackgrounds[id]);
        expect(await opaqueBackground(editor)).toBe(true);
        expect(await svgSnapshot(shape.locator("svg.primitive-shape"))).toEqual(initialSvg.get(id));
        await shape.getByRole("textbox", { name: /Edit text inside/ }).press("Escape");
        await expect(shape.locator(".shape-contained-text-display")).toBeVisible();
        await assertReadableQuietSurface(shape, surfaceBackgrounds[id]);
        expect(await svgSnapshot(shape.locator("svg.primitive-shape"))).toEqual(initialSvg.get(id));
      }
    });
  }
}

for (const dark of [false, true]) {
  for (const zoom of [1, 2]) {
    test(`matches alpha and theme contained-text surfaces to the ${dark ? "dark" : "light"} canvas at ${zoom * 100}%`, async ({ page }) => {
      await installWorkspace(page, dark, edgeFillCases);
      await page.setViewportSize({ width: 3_000, height: 1_600 });
      await page.goto("/");
      if (zoom === 2) await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      const expectedBackgrounds = dark
        ? ["rgb(139, 11, 11)", "rgb(245, 245, 245)", "rgb(155, 155, 155)"]
        : ["rgb(250, 123, 125)", "rgb(32, 41, 54)", "rgb(155, 155, 155)"];

      for (const [index, fillCase] of edgeFillCases.entries()) {
        await assertReadableQuietSurface(
          page.locator(`[data-canvas-element-id="labeled-${fillCase.id}"]`),
          expectedBackgrounds[index],
        );
      }

      await page.getByRole("button", { name: "Find in canvas" }).click();
      await page.getByRole("textbox", { name: "Find in canvas" }).fill("Quiet");
      for (const [index, fillCase] of edgeFillCases.entries()) {
        if (index > 0) await page.getByRole("button", { name: "Next match" }).click();
        const shape = page.locator(`[data-canvas-element-id="labeled-${fillCase.id}"]`);
        await assertReadableQuietSurface(shape, expectedBackgrounds[index]);
        const match = shape.locator(".canvas-search-match.is-active-search-match");
        await expect(match).toHaveCount(1);
        expect(await contrastRatio(match, match)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

async function assertReadableQuietSurface(shape: Locator, expectedBackground: string) {
  await expect(shape).toHaveClass(/has-contained-text-surface/);
  const textRegion = shape.locator(".shape-contained-text-display");
  const surface = shape.locator(".shape-contained-text-content");
  await expect(surface).toHaveCSS("background-color", expectedBackground);
  expect(await opaqueBackground(surface)).toBe(true);
  for (const text of [surface.locator("h2"), surface.locator("em"), surface.locator("li"), surface.locator("p").last()]) {
    expect(await contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
  }
  await expect(textRegion).toHaveCSS("font-size", "14px");
  await expect(surface.locator("h2")).toHaveText("Quiet heading");
  await expect(surface.locator("em")).toHaveText("calm");
  await expect(surface.locator("em")).toHaveCSS("font-size", "14px");
  await expect(surface.locator("li")).toContainText("List detail");
  await expect(surface.locator("li")).toHaveCSS("font-size", "14px");
  await expect(surface.locator("p").last()).toContainText("Readable body");
  await expect(surface.locator("p").last()).toHaveCSS("font-size", "14px");

  const layering = await shape.evaluate((root) => {
    const svg = root.querySelector<SVGSVGElement>("svg.primitive-shape");
    const region = root.querySelector<HTMLElement>(".shape-contained-text-display");
    const surface = root.querySelector<HTMLElement>(".shape-contained-text-content");
    if (!svg || !region || !surface) throw new Error("Shape surface layers were unavailable.");
    const rootRect = root.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    return {
      fillPathCount: svg.querySelectorAll("path").length,
      fillStroke: svg.querySelector("path")?.getAttribute("stroke"),
      regionZIndex: getComputedStyle(region).zIndex,
      surfaceIsInset: surfaceRect.width < rootRect.width && surfaceRect.height < rootRect.height,
    };
  });
  expect(layering.fillPathCount).toBeGreaterThan(1);
  expect(layering.fillStroke).not.toBeNull();
  expect(layering.regionZIndex).toBe("1");
  expect(layering.surfaceIsInset).toBe(true);
}

async function opaqueBackground(locator: Locator) {
  return locator.evaluate((element) => {
    const background = getComputedStyle(element).backgroundColor;
    const channels = background.match(/[\d.]+/g)?.map(Number) ?? [];
    return channels.length === 3 || channels[3] === 1;
  });
}

async function contrastRatio(foregroundLocator: Locator, backgroundLocator: Locator) {
  const [foreground, background] = await Promise.all([
    foregroundLocator.evaluate((element) => getComputedStyle(element).color),
    backgroundLocator.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  return foregroundLocator.evaluate((_, { foreground, background }) => {
    const toLuminance = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Could not parse color: ${value}`);
      const linear = channels.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const foregroundLuminance = toLuminance(foreground);
    const backgroundLuminance = toLuminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  }, { foreground, background });
}

async function svgSnapshot(svg: Locator) {
  return svg.evaluate((node) => ({
    paths: Array.from(node.querySelectorAll("path"), (path) => path.getAttribute("d")),
    seed: node.getAttribute("data-seed"),
    transforms: Array.from(node.children, (child) => child.getAttribute("transform")),
  }));
}

async function installWorkspace(
  page: Page,
  isDarkMode: boolean,
  fillCases: readonly {
    fillColor: { kind: string; token?: string; value?: string };
    id: string;
    shape: string;
  }[] = defaultFillCases,
) {
  await page.addInitScript(({ fillCases, isDarkMode }) => {
    const richContent = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Quiet heading" }] },
        { type: "paragraph", content: [{ type: "text", text: "Keep it " }, { type: "text", text: "calm", marks: [{ type: "italic" }] }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "List detail" }] }] }] },
        { type: "paragraph", content: [{ type: "text", text: "Readable body" }] },
      ],
    };
    const style = (seed: number, fillColor: { kind: string; token?: string; value?: string }) => ({
      fillColor,
      roughness: 1,
      roundness: 0.45,
      seed,
      strokeColor: { kind: "fixed", value: isDarkMode ? "#f5f5f5" : "#262626" },
      strokeStyle: "solid",
      strokeWidth: 2,
    });
    const shapes = fillCases.flatMap(({ fillColor, id, shape }, index) => [
      {
        createdAt: 1, height: 300, id: `labeled-${id}`, locked: false, opacity: 1, pageId: "page",
        rotation: [-8, 7, 12][index], shape, style: style(71 + index, fillColor),
        text: { content: "Quiet heading\nKeep it calm\nList detail\nReadable body", richContent: structuredClone(richContent) },
        type: "shape", updatedAt: 1, width: 360, x: 50 + index * 390, y: 110, zIndex: 1 + index,
      },
      {
        createdAt: 1, height: 170, id: `unlabeled-${id}`, locked: false, opacity: 1, pageId: "page",
        rotation: [-8, 7, 12][index], shape, style: style(81 + index, fillColor), type: "shape",
        updatedAt: 1, width: 300, x: 80 + index * 390, y: 510, zIndex: 5 + index,
      },
    ]);
    const workspace = {
      elements: shapes,
      folders: [],
      isDarkMode,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Contained text surface" }],
      sessionState: { openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" },
      warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command) => {
      if (command === "initialize_storage") return { databasePath: "shape-surface.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "save_session_state" || command === "apply_scene_changes") return { newRevision: 1, pageId: "page" };
      throw new Error(`Unexpected command ${command}`);
    } };
  }, { fillCases, isDarkMode });
}
