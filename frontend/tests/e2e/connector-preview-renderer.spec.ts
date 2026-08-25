import { expect, test, type Locator, type Page } from "@playwright/test";

for (const scenario of [
  { darkMode: false, deviceScaleFactor: 1, zoom: 50 },
  { darkMode: true, deviceScaleFactor: 1, zoom: 100 },
  { darkMode: false, deviceScaleFactor: 2, zoom: 200 },
]) {
  test(`two-worker and fallback previews are perceptually equal at ${scenario.zoom}% DPR${scenario.deviceScaleFactor} ${scenario.darkMode ? "dark" : "light"}`, async ({ browser }) => {
    const context = await browser.newContext({
      deviceScaleFactor: scenario.deviceScaleFactor,
      viewport: { height: 900, width: 1500 },
    });
    const page = await context.newPage();
    await installComparisonWorkspace(page, scenario.darkMode);
    await page.goto("/");
    const canvas = page.getByRole("tabpanel");
    await selectBothTargets(page);
    await setZoom(page, canvas, scenario.zoom);
    const committedLabel = page.locator('[data-canvas-element-id="solid-crossing"] .connector-label');
    const committedLabelBounds = await requiredBounds(committedLabel, "committed connector label");

    await beginGroupDrag(page);
    let preview = page.locator(".connector-transform-preview");
    await expect(preview).toHaveAttribute("data-preview-renderer", "two-worker");
    await expect(preview).toHaveAttribute("data-presented-frame", /[1-9]\d*/);
    await expect(preview).toHaveAttribute("data-retained-bitmaps", "0");
    const transientLabel = page.locator(".connector-transform-preview-labels .connector-label", { hasText: "Compact gap" });
    await expect(transientLabel).toBeVisible();
    const transientLabelBounds = await requiredBounds(transientLabel, "transient connector label");
    expect(transientLabelBounds.height).toBeCloseTo(committedLabelBounds.height, 0);
    expect(await transientLabel.evaluate((element) => getComputedStyle(element).fontSize))
      .toBe(`${14 * scenario.zoom / 100}px`);
    await page.waitForTimeout(50);
    await preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Worker preview canvas context was unavailable.");
      (window as unknown as { __workerPreviewPixels: Uint8ClampedArray }).__workerPreviewPixels =
        context.getImageData(0, 0, canvas.width, canvas.height).data;
    });
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);

    await page.evaluate(() => {
      Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
    });
    await beginGroupDrag(page);
    preview = page.locator(".connector-transform-preview");
    await expect(preview).toHaveAttribute("data-preview-renderer", "main-thread");
    const comparison = await preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Fallback preview canvas context was unavailable.");
      const expected = (window as unknown as { __workerPreviewPixels: Uint8ClampedArray }).__workerPreviewPixels;
      const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
      if (expected.length !== actual.length) return { changedPixels: actual.length, maxDelta: 255, meanDelta: 255, paintedPixels: 0 };
      let changedPixels = 0;
      let maxDelta = 0;
      let paintedPixels = 0;
      let totalDelta = 0;
      for (let index = 0; index < actual.length; index += 4) {
        let pixelChanged = false;
        if (actual[index + 3] !== 0 || expected[index + 3] !== 0) paintedPixels += 1;
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs(actual[index + channel] - expected[index + channel]);
          if (delta !== 0) pixelChanged = true;
          if (delta > maxDelta) maxDelta = delta;
          totalDelta += delta;
        }
        if (pixelChanged) changedPixels += 1;
      }
      return {
        changedPixels,
        maxDelta,
        meanDelta: totalDelta / actual.length,
        paintedPixels,
      };
    });
    expect(comparison.paintedPixels).toBeGreaterThan(100);
    expect(comparison.maxDelta).toBeLessThanOrEqual(2);
    expect(comparison.meanDelta).toBeLessThanOrEqual(0.01);
    expect(comparison.changedPixels).toBeLessThanOrEqual(Math.ceil(comparison.paintedPixels * 0.01));

    const stack = await page.evaluate(() => ({
      chrome: Number.parseInt(getComputedStyle(document.querySelector(".canvas-tool-palette")!).zIndex, 10),
      clones: Number.parseInt(getComputedStyle(document.querySelector(".drag-layer")!).zIndex, 10),
      preview: Number.parseInt(getComputedStyle(document.querySelector(".connector-transform-preview")!).zIndex, 10),
      world: getComputedStyle(document.querySelector(".canvas-content")!).zIndex,
    }));
    expect(stack.world).toBe("auto");
    expect(stack.preview).toBeLessThan(stack.clones);
    expect(stack.clones).toBeLessThan(stack.chrome);

    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await context.close();
  });
}

test("rapid cancellation terminates both workers and removes every preview canvas", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    (window as unknown as { __activePreviewWorkers: number }).__activePreviewWorkers = 0;
    class TrackingWorker extends NativeWorker {
      private counted = true;
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        (window as unknown as { __activePreviewWorkers: number }).__activePreviewWorkers += 1;
      }
      override terminate() {
        if (this.counted) {
          this.counted = false;
          (window as unknown as { __activePreviewWorkers: number }).__activePreviewWorkers -= 1;
        }
        super.terminate();
      }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: TrackingWorker });
  });
  await installComparisonWorkspace(page, false);
  await page.setViewportSize({ height: 900, width: 1500 });
  await page.goto("/");
  await selectBothTargets(page);
  for (let cycle = 0; cycle < 12; cycle += 1) {
    await beginGroupDrag(page, cycle);
    const preview = page.locator(".connector-transform-preview");
    await expect(preview).toHaveAttribute("data-preview-renderer", "two-worker");
    expect(await preview.getAttribute("data-retained-bitmaps")).toMatch(/^[01]$/);
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __activePreviewWorkers: number }).__activePreviewWorkers)).toBe(0);
  }
});

test("worker runtime failure presents only the newest pending valid frame once on fallback", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    type WorkerHandler = ((event: Event) => void) | null;
    class HangingWorker {
      static instances: HangingWorker[] = [];
      onerror: WorkerHandler = null;
      onmessageerror: WorkerHandler = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      terminated = false;
      constructor() { HangingWorker.instances.push(this); }
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: HangingWorker });
    const module = await import("/src/canvas/rendering/connectorPreviewCanvas.ts");
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const renderer = new module.ConnectorPreviewCanvas(canvas);
    const baseCommand = {
      end: { x: 160, y: 90 }, endArrowhead: "arrow" as const, opacity: 1, roughness: 1,
      sceneIndex: 1, seed: 501, start: { x: 20, y: 20 }, stroke: "#111827",
      strokeStyle: "solid" as const, strokeWidth: 2, visualScale: 1, zIndex: 1,
    };
    const first = { commands: [baseCommand], devicePixelRatio: 1, height: 140, width: 220 };
    const latest = {
      ...first,
      commands: [{ ...baseCommand, end: { x: 200, y: 115 }, seed: 777, stroke: "#7c3aed" }],
    };
    let presentations = 0;
    canvas.addEventListener("connector-preview-presented", () => { presentations += 1; });
    renderer.render(first);
    renderer.render(latest);
    const workers = [...HangingWorker.instances];
    workers[0].onerror?.(new Event("error"));
    workers[1].onmessageerror?.(new Event("messageerror"));
    const actual = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;

    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
    const expectedCanvas = document.createElement("canvas");
    document.body.append(expectedCanvas);
    const expectedRenderer = new module.ConnectorPreviewCanvas(expectedCanvas);
    expectedRenderer.render(latest);
    const expected = expectedCanvas.getContext("2d")!.getImageData(0, 0, expectedCanvas.width, expectedCanvas.height).data;
    let differentChannels = 0;
    for (let index = 0; index < actual.length; index += 1) {
      if (actual[index] !== expected[index]) differentChannels += 1;
    }
    const diagnostics = {
      differentChannels,
      pendingDepth: canvas.dataset.pendingDepth,
      presentations,
      renderer: canvas.dataset.previewRenderer,
      retainedBitmaps: canvas.dataset.retainedBitmaps,
      terminatedWorkers: workers.filter((worker) => worker.terminated).length,
    };
    renderer.dispose();
    expectedRenderer.dispose();
    return diagnostics;
  });

  expect(result).toEqual({
    differentChannels: 0,
    pendingDepth: "0",
    presentations: 1,
    renderer: "main-thread",
    retainedBitmaps: "0",
    terminatedWorkers: 2,
  });
  await expect(page.locator("canvas[data-preview-renderer]")).toHaveCount(0);
});

for (const rendererMode of ["worker", "fallback"] as const) {
  test(`${rendererMode} renderer clips mixed-opacity extreme spans and drops oversized frames without stale pixels`, async ({ page }) => {
    await installComparisonWorkspace(page, false);
    await page.goto("/");
    const result = await page.evaluate(async (mode) => {
      if (mode === "fallback") {
        Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
      }
      const module = await import("/src/canvas/rendering/connectorPreviewCanvas.ts");
      const canvas = document.createElement("canvas");
      canvas.style.height = "200px";
      canvas.style.width = "300px";
      document.body.append(canvas);
      const renderer = new module.ConnectorPreviewCanvas(canvas);
      const commands = Array.from({ length: 2_000 }, (_, index) => ({
        end: {
          x: index < 20 ? 1_000_000_000 : 1_000_000,
          y: index < 20 ? 100 + index % 3 : 1_000_000 + index,
        },
        endArrowhead: index % 2 === 0 ? "arrow" as const : "none" as const,
        opacity: index % 3 === 0 ? 0.42 : 1,
        roughness: 1.2,
        sceneIndex: index,
        seed: index + 1,
        start: {
          x: index < 20 ? -1_000_000_000 : 999_000,
          y: index < 20 ? 100 + index % 3 : 1_000_000 + index,
        },
        stroke: "rgba(32, 41, 54, 1)",
        strokeStyle: index % 2 === 0 ? "dashed" as const : "solid" as const,
        strokeWidth: 2,
        visualScale: 1,
        zIndex: index,
      }));
      const frame = { commands, devicePixelRatio: 4, height: 200, width: 300 };
      const scheduling: number[] = [];
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const presented = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error("Preview frame timed out.")), 10_000);
          canvas.addEventListener("connector-preview-presented", () => {
            window.clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
        const started = performance.now();
        renderer.render(frame);
        scheduling.push(performance.now() - started);
        await presented;
      }
      scheduling.sort((left, right) => left - right);
      const rendererBeforeDrop = canvas.dataset.previewRenderer;
      const presentedBeforeDrop = canvas.dataset.presentedFrame;
      renderer.render({ ...frame, width: 1_000_000_000 });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Preview canvas context was unavailable.");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let paintedAfterDrop = false;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] !== 0) {
          paintedAfterDrop = true;
          break;
        }
      }
      const presentedAfterDrop = canvas.dataset.presentedFrame;
      const nextValidPresented = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Next valid preview frame timed out.")), 10_000);
        canvas.addEventListener("connector-preview-presented", () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      renderer.render(frame);
      await nextValidPresented;
      const diagnostics = {
        contextLost: context.isContextLost(),
        droppedFrames: canvas.dataset.droppedFrames,
        paintedAfterDrop,
        pendingDepth: canvas.dataset.pendingDepth,
        presentedAfterDrop,
        presentedAfterNextValid: canvas.dataset.presentedFrame,
        presentedBeforeDrop,
        rendererAfterDrop: canvas.dataset.previewRenderer,
        rendererBeforeDrop,
        retainedBitmaps: canvas.dataset.retainedBitmaps,
        scheduleP95: scheduling[4],
      };
      renderer.dispose();
      return diagnostics;
    }, rendererMode);

    expect(result.rendererBeforeDrop).toBe(rendererMode === "worker" ? "two-worker" : "main-thread");
    expect(result.rendererAfterDrop).toBe(result.rendererBeforeDrop);
    expect(result.scheduleP95).toBeLessThanOrEqual(33.5);
    expect(result.droppedFrames).toBe("1");
    expect(result.presentedAfterDrop).toBe(result.presentedBeforeDrop);
    expect(result.presentedAfterNextValid).not.toBe(result.presentedAfterDrop);
    expect(result.pendingDepth).toBe("0");
    expect(result.retainedBitmaps).toBe("0");
    expect(result.paintedAfterDrop).toBe(false);
    expect(result.contextLost).toBe(false);
    await expect(page.locator("canvas[style*='200px']")).toHaveCount(0);
  });
}

async function beginGroupDrag(page: Page, offset = 0) {
  const surface = page.getByRole("button", { name: "Move selected elements" });
  const bounds = await requiredBounds(surface, "selection move surface");
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60 + offset, start.y + 40);
}

async function selectBothTargets(page: Page) {
  const rectangle = page.getByRole("button", { name: "Select and move rectangle shape. Press F2 to edit contained text." });
  await rectangle.focus();
  await page.keyboard.press("Enter");
  await page.locator('[data-block-id="target-text"] .text-block-header').click({ modifiers: ["Control"] });
  await expect(page.getByRole("button", { name: "Move selected elements" })).toBeVisible();
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  const current = Number.parseInt((await page.locator(".zoom-indicator").innerText()).replace("%", ""), 10);
  const steps = Math.round(Math.abs(percent - current) / 10);
  const key = percent < current ? "Control+-" : "Control+=";
  for (let index = 0; index < steps; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function installComparisonWorkspace(page: Page, darkMode: boolean) {
  await page.addInitScript((isDarkMode) => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const strokeColor = { kind: "fixed", value: "#4c6ef5" };
    const baseStyle = { fillColor: null, roughness: 1.25, roundness: 0, strokeColor };
    const shapeStyle = { ...baseStyle, seed: 17, strokeStyle: "solid", strokeWidth: 2 };
    const workspace = {
      elements: [
        {
          ...shapeStyle, createdAt: 1, height: 100, id: "target-shape", locked: false, opacity: 1,
          pageId: "page", rotation: 18, shape: "rectangle", style: shapeStyle, type: "shape", updatedAt: 1,
          width: 160, x: 180, y: 120, zIndex: 1,
        },
        {
          backgroundMode: "surface", content: "Preview target", createdAt: 1, height: 90,
          id: "target-text", locked: false, opacity: 1, pageId: "page", rotation: -12, type: "text",
          updatedAt: 1, width: 180, x: 500, y: 130, zIndex: 2,
        },
        connector("solid-crossing", "target-shape", { x: 720, y: 390 }, 3, 101, "solid", 1, 1),
        connector("dashed-crossing", "target-text", { x: 120, y: 390 }, 4, 202, "dashed", 3, 0.55),
        {
          createdAt: 1,
          end: { gap: 4, kind: "element", targetElementId: "target-text" },
          id: "dotted-bound", locked: true, opacity: 0.75, pageId: "page", routing: "straight",
          start: { gap: 2, kind: "element", targetElementId: "target-shape" },
          style: { ...baseStyle, endArrowhead: "arrow", seed: 303, startArrowhead: "none", strokeStyle: "dotted", strokeWidth: 5 },
          type: "connector", updatedAt: 1, zIndex: 5,
        },
      ] as ElementRecord[],
      folders: [], isDarkMode,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Connector renderer comparison" }],
      sessionState: { openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" }, warnings: [],
    };
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "comparison.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
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
      if (command === "load_asset" || command === "save_asset") throw new Error(`Unexpected ${command}`);
      throw new Error(`Unexpected command ${command}`);
    } };

    function connector(
      id: string,
      targetElementId: string,
      end: { x: number; y: number },
      zIndex: number,
      seed: number,
      strokeStyle: "dashed" | "dotted" | "solid",
      strokeWidth: number,
      opacity: number,
    ) {
      return {
        createdAt: 1, end: { kind: "free", ...end }, id, locked: true, opacity, pageId: "page", routing: "straight",
        ...(id === "solid-crossing" ? {
          labelStyle: { color: { kind: "theme", token: "foreground" }, fontFamily: "system-ui", fontSize: "14px", orientation: "upright" },
          semantic: { label: "Compact gap" },
        } : {}),
        start: { gap: 0, kind: "element", targetElementId },
        style: { ...baseStyle, endArrowhead: "arrow", seed, startArrowhead: "none", strokeStyle, strokeWidth },
        type: "connector", updatedAt: 1, zIndex,
      };
    }
  }, darkMode);
}
