import { expect, test, type Locator, type Page } from "@playwright/test";

test("rich standalone and shape search is presentation-only across navigation and close", async ({ page }) => {
  await installSearchWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator('[data-canvas-element-id="text-rich"]')).toBeVisible();
  await page.waitForTimeout(700);

  const text = page.locator('[data-canvas-element-id="text-rich"]');
  const textControl = text.getByRole("button", { name: /Select and move text block/ });
  await textControl.focus();
  await textControl.press("Enter");
  await textControl.press("Shift+ArrowRight");
  await expect.poll(() => elementX(page, "text-rich")).toBe(330);
  await page.waitForTimeout(700);
  await resetPersistenceCounts(page);

  const baseline = await invariantSnapshot(page);
  const baselineTransform = await page.locator(".canvas-content").getAttribute("style");
  await page.getByRole("button", { name: "Find in canvas" }).click();
  const search = page.getByRole("textbox", { name: "Find in canvas" });
  await search.fill("needle");
  await expect(page.locator('[data-canvas-element-id] .canvas-search-match')).toHaveCount(8);
  await expect(page.locator(".page-title-search-match.is-active-search-match")).toHaveCount(1);
  await expect(page.locator(".search-status-announcement")).toHaveText("Result 1 of 5, Page title");
  await expect(page.locator(".ProseMirror")).toHaveCount(0);
  await assertRichTreesRemainFormatted(page);
  expect(await formattingSnapshot(page)).toEqual(baseline.formatting);
  expect(await workspaceJson(page)).toBe(baseline.workspaceJson);

  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator('[data-canvas-element-id="text-rich"] .canvas-search-match.is-active-search-match')).toHaveCount(2);
  await expect(page.locator(".page-title-search-match:not(.is-active-search-match)")).toHaveCount(1);
  await expect(page.locator(".search-status-announcement")).toHaveText("Result 2 of 5, Text");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator('[data-canvas-element-id="shape-rectangle"] .canvas-search-match.is-active-search-match')).toHaveCount(2);
  await expect(page.getByRole("tabpanel")).toHaveAttribute("data-search-navigation-active", "true");
  const navigatedTransform = await page.locator(".canvas-content").getAttribute("style");
  expect(navigatedTransform).not.toBe(baselineTransform);
  const interactionBaseline = await workspaceJson(page);
  const rectangleBounds = await page.locator('[data-canvas-element-id="shape-rectangle"]').boundingBox();
  if (!rectangleBounds) throw new Error("Navigated rectangle was unavailable");
  await page.mouse.move(rectangleBounds.x + rectangleBounds.width / 2, rectangleBounds.y + rectangleBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(rectangleBounds.x + rectangleBounds.width / 2 + 40, rectangleBounds.y + rectangleBounds.height / 2 + 30);
  await page.mouse.up();
  await textControl.focus();
  await textControl.press("Shift+ArrowRight");
  expect(await workspaceJson(page)).toBe(interactionBaseline);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator('[data-canvas-element-id="shape-ellipse"] .canvas-search-match.is-active-search-match')).toHaveCount(2);
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator('[data-canvas-element-id="shape-diamond"] .canvas-search-match.is-active-search-match')).toHaveCount(2);
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".page-title-search-match.is-active-search-match")).toHaveCount(1);
  await expect(page.locator(".search-status-announcement")).toHaveText("Result 1 of 5, Page title");
  await expect(page.locator(".canvas-content")).toHaveAttribute("style", baselineTransform ?? "");
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(page.locator('[data-canvas-element-id="shape-diamond"] .canvas-search-match.is-active-search-match')).toHaveCount(2);
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(page.locator('[data-canvas-element-id="shape-ellipse"] .canvas-search-match.is-active-search-match')).toHaveCount(2);

  await page.waitForTimeout(700);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });
  expect(await workspaceJson(page)).toBe(baseline.workspaceJson);
  expect(await formattingSnapshot(page)).toEqual(baseline.formatting);

  await page.getByRole("button", { name: "Close search", exact: true }).click();
  await expect(page.locator(".canvas-search-match")).toHaveCount(0);
  await expect(page.locator(".canvas-content")).toHaveAttribute("style", baselineTransform ?? "");
  expect(await invariantSnapshot(page)).toEqual(baseline);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });

  await page.getByRole("tabpanel").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => elementX(page, "text-rich")).toBe(320);
  await expect.poll(async () => (await persistenceCounts(page)).apply).toBe(1);
  expect((await workspaceElements(page)).find((element) => element.id === "text-rich")?.updatedAt).toBe(1);
});

test("find entry paths cannot steal an editor or slash-command draft", async ({ page }) => {
  await installSearchWorkspace(page);
  await page.goto("/");
  await page.waitForTimeout(700);
  await resetPersistenceCounts(page);

  const text = page.locator('[data-canvas-element-id="editor-guard"]');
  const shape = page.locator('[data-canvas-element-id="shape-rectangle"]');
  const findButton = page.getByRole("button", { name: "Find in canvas" });
  await findButton.click();
  const searchInput = page.getByRole("textbox", { name: "Find in canvas" });
  await searchInput.fill("needle");
  const inertWorkspaceJson = await workspaceJson(page);
  const inertTextGeometry = await text.boundingBox();
  const inertShapeGeometry = await shape.boundingBox();

  // The whole canvas is inert while Find is open, including nested editor entry handlers.
  await text.dblclick();
  await expect(text.locator(".text-block-editor-content")).toHaveCount(0);
  await shape.focus();
  await shape.press("F2");
  await expect(shape.locator(".shape-contained-text-editor-content")).toHaveCount(0);
  await expect(page.locator(".search-panel")).toBeVisible();
  expect(await workspaceJson(page)).toBe(inertWorkspaceJson);
  expect(await text.boundingBox()).toEqual(inertTextGeometry);
  expect(await shape.boundingBox()).toEqual(inertShapeGeometry);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });
  await searchInput.focus();
  await searchInput.press("Escape");
  await expect(findButton).toBeFocused();

  await text.dblclick();
  const editor = text.locator(".text-block-editor-content");
  await expect(editor).toBeFocused();
  await page.keyboard.type("/");
  await expect(page.locator(".slash-command-menu")).toBeVisible();
  const draftBefore = await editor.innerText();
  const geometryBefore = await text.boundingBox();

  await expect(findButton).toBeDisabled();
  await page.keyboard.press("Control+f");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText(draftBefore);
  await expect(page.locator(".slash-command-menu")).toBeVisible();
  await expect(page.locator(".search-panel")).toHaveCount(0);
  expect(await text.boundingBox()).toEqual(geometryBefore);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });

  await editor.press("Escape");
  await expect(page.locator(".slash-command-menu")).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText(draftBefore);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });

  await page.reload();
  await page.waitForTimeout(700);
  await resetPersistenceCounts(page);
  await shape.focus();
  await shape.press("F2");
  const shapeEditor = shape.locator(".shape-contained-text-editor-content");
  await expect(shapeEditor).toBeFocused();
  await shapeEditor.fill("Dirty shape draft");
  const shapeDraft = await shapeEditor.innerText();
  const shapeGeometry = await shape.boundingBox();
  const shapeJson = await workspaceJson(page);
  await expect(findButton).toBeDisabled();
  await findButton.click({ force: true });
  await page.keyboard.press("Control+f");
  await expect(shapeEditor).toBeFocused();
  await expect(shapeEditor).toHaveText(shapeDraft);
  expect(await shape.boundingBox()).toEqual(shapeGeometry);
  expect(await workspaceJson(page)).toBe(shapeJson);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });
  await shapeEditor.press("Escape");
  await expect(shape.locator(".shape-contained-text-editor-content")).toHaveCount(0);
  expect(await workspaceJson(page)).toBe(shapeJson);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });

  await findButton.click();
  await page.getByRole("textbox", { name: "Find in canvas" }).fill("needle");
  await page.getByRole("tab", { name: "Needle Search invariants" }).dblclick();
  const titleInput = page.getByRole("textbox", { name: "Page title" });
  await expect(titleInput).toBeFocused();
  await expect(page.locator(".search-panel")).toHaveCount(0);
  await expect(findButton).not.toBeFocused();
  await titleInput.fill("Dirty page title draft");
  const titleWorkspaceJson = await workspaceJson(page);
  await expect(findButton).toBeDisabled();
  await page.keyboard.press("Control+f");
  await expect(titleInput).toBeFocused();
  await expect(titleInput).toHaveValue("Dirty page title draft");
  await expect(page.locator(".search-panel")).toHaveCount(0);
  expect(await workspaceJson(page)).toBe(titleWorkspaceJson);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });
  await titleInput.press("Escape");

  const connector = page.getByRole("button", { name: "Select and move arrow connector" });
  await connector.focus();
  await connector.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await startHandle.focus();
  await startHandle.press("Space");
  const chooser = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await expect(chooser).toBeVisible();
  const chooserWorkspaceJson = await workspaceJson(page);
  await expect(findButton).toBeDisabled();
  await findButton.click({ force: true });
  await page.keyboard.press("Control+f");
  await expect(chooser).toBeVisible();
  await expect(page.locator(".search-panel")).toHaveCount(0);
  expect(await workspaceJson(page)).toBe(chooserWorkspaceJson);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });
  await page.keyboard.press("Escape");
});

test("dense one-character query is visibly capped without writes", async ({ page }) => {
  await installSearchWorkspace(page);
  await page.goto("/");
  await page.waitForTimeout(700);
  await resetPersistenceCounts(page);
  await page.getByRole("button", { name: "Find in canvas" }).click();
  await page.getByRole("textbox", { name: "Find in canvas" }).fill("a");
  await expect(page.locator(".search-panel-count")).toContainText(/1 \/ 500\+/);
  await expect(page.locator(".search-status-announcement")).toHaveText("Result 1 of 500 or more, Page title");
  await expect(page.locator(".ProseMirror")).toHaveCount(0);
  const renderedMatches = await page.locator(".canvas-search-match, .canvas-search-image-match").count();
  expect(renderedMatches).toBeLessThanOrEqual(500);
  expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });
});

test("search exposes keyboard focus, live status, contrast, and deterministic focus return", async ({ page }) => {
  await installSearchWorkspace(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await expect(page.locator('[data-canvas-element-id="text-rich"]')).toBeVisible();

  const findButton = page.getByRole("button", { name: "Find in canvas" });
  await findButton.click();
  const panel = page.locator(".search-panel");
  const search = page.getByRole("textbox", { name: "Find in canvas" });
  const status = page.locator("#canvas-search-status");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("aria-describedby", "canvas-search-status");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(page.getByText("Canvas interactions paused while Find is open.")).toBeVisible();
  const focusStyle = await search.evaluate((element) => {
    const inputStyle = getComputedStyle(element);
    const queryStyle = getComputedStyle(element.closest(".search-panel-query")!);
    return {
      outlineStyle: inputStyle.outlineStyle,
      outlineWidth: Number.parseFloat(inputStyle.outlineWidth),
      queryBoxShadow: queryStyle.boxShadow,
    };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(focusStyle.queryBoxShadow).not.toBe("none");
  const inputBounds = await search.boundingBox();
  expect(inputBounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  for (const button of await panel.getByRole("button").all()) {
    const bounds = await button.boundingBox();
    expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const panelBounds = await panel.boundingBox();
  const canvasBounds = await page.getByRole("tabpanel").boundingBox();
  if (!panelBounds || !canvasBounds) throw new Error("Compact search bounds were unavailable");
  expect(panelBounds.x).toBeGreaterThanOrEqual(canvasBounds.x);
  expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(canvasBounds.x + canvasBounds.width);

  await search.fill("needle");
  await expect(status.locator(".search-status-announcement")).toHaveText("Result 1 of 5, Page title");
  const source = status.locator("small");
  await expect(source).toBeVisible();
  expect(await contrastRatio(source, panel)).toBeGreaterThanOrEqual(4.5);
  const activeTitle = page.locator(".page-title-search-match.is-active-search-match");
  await expect(activeTitle).toHaveCount(1);
  expect(await contrastRatio(activeTitle, activeTitle)).toBeGreaterThanOrEqual(4.5);
  await search.press("Tab");
  const previous = page.getByRole("button", { name: "Previous match" });
  await expect(previous).toBeFocused();
  await page.keyboard.press("Tab");
  const next = page.getByRole("button", { name: "Next match" });
  await expect(next).toBeFocused();
  await next.press("Enter");
  await expect(status.locator(".search-status-announcement")).toHaveText("Result 2 of 5, Text");
  const inactiveTitle = page.locator(".page-title-search-match:not(.is-active-search-match)");
  await expect(inactiveTitle).toHaveCount(1);
  expect(await contrastRatio(inactiveTitle, inactiveTitle)).toBeGreaterThanOrEqual(4.5);
  await search.fill("not-present-anywhere");
  await expect(status.locator(".search-status-announcement")).toHaveText("No results.");
  await page.getByRole("button", { name: "Close search", exact: true }).click();
  await expect(findButton).toBeFocused();

  await page.getByRole("button", { name: "Dark mode" }).click();
  await findButton.click();
  await search.fill("needle");
  await expect(status.locator(".search-status-announcement")).toHaveText("Result 1 of 5, Page title");
  expect(await contrastRatio(status.locator("small"), panel)).toBeGreaterThanOrEqual(4.5);
  expect(await contrastRatio(page.locator(".page-title-search-match.is-active-search-match"), page.locator(".page-title-search-match.is-active-search-match"))).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: "Next match" }).click();
  expect(await contrastRatio(page.locator(".page-title-search-match:not(.is-active-search-match)"), page.locator(".page-title-search-match:not(.is-active-search-match)"))).toBeGreaterThanOrEqual(4.5);
  await search.click();
  await search.press("Escape");
  await expect(findButton).toBeFocused();

  const selectTool = page.getByRole("button", { name: "Select (V / 1)" });
  await selectTool.focus();
  await page.keyboard.press("Control+f");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(selectTool).toBeFocused();
});

for (const tool of [
  { label: "Pen (P / 7)", name: "pen" },
  { label: "Highlighter (H)", name: "highlighter" },
  { label: "Eraser (E / 0)", name: "eraser" },
  { label: "Rectangle (R / 2)", name: "rectangle" },
  { label: "Line (L / 6)", name: "line" },
  { label: "Arrow (A / 5)", name: "arrow" },
  { label: "Hand (Space)", name: "hand" },
  { label: "Select (V / 1)", name: "select" },
] as const) {
  test(`search controls never author with the ${tool.name} tool`, async ({ page }) => {
    await installSearchWorkspace(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator('[data-canvas-element-id="text-rich"]')).toBeVisible();

    const textControl = page
      .locator('[data-canvas-element-id="text-rich"]')
      .getByRole("button", { name: /Select and move text block/ });
    await textControl.focus();
    await textControl.press("Enter");
    await textControl.press("Shift+ArrowRight");
    await expect.poll(() => elementX(page, "text-rich")).toBe(330);
    await page.waitForTimeout(700);

    const toolButton = page.getByRole("button", { name: tool.label });
    await toolButton.click();
    await expect(toolButton).toHaveAttribute("aria-pressed", "true");
    await resetPersistenceCounts(page);
    const baselineJson = await workspaceJson(page);
    const baselineTransform = await page.locator(".canvas-content").getAttribute("style");

    await page.getByRole("button", { name: "Find in canvas" }).click();
    const canvas = page.getByRole("tabpanel");
    await expect(canvas).toHaveAttribute("data-search-navigation-active", "true");
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error("Canvas bounds were unavailable");
    await page.mouse.click(canvasBounds.x + 24, canvasBounds.y + 80);
    await canvas.focus();
    await canvas.press("Enter");
    await canvas.press("ArrowRight");
    expect(await workspaceJson(page)).toBe(baselineJson);
    expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });
    const search = page.getByRole("textbox", { name: "Find in canvas" });
    await search.click();
    await search.pressSequentially("needle");
    await expect(search).toHaveValue("needle");
    await page.getByRole("button", { name: "Next match" }).click();
    await expect(page.locator('[data-canvas-element-id="text-rich"] .canvas-search-match.is-active-search-match')).toHaveCount(2);
    await page.getByRole("button", { name: "Previous match" }).click();
    await expect(page.locator('[data-canvas-element-id] .canvas-search-match.is-active-search-match')).toHaveCount(0);
    await expect(page.locator(".page-title-search-match.is-active-search-match")).toHaveCount(1);
    await expect(page.locator(".canvas-content")).toHaveAttribute("style", baselineTransform ?? "");
    await page.getByRole("button", { name: "Close search", exact: true }).click();

    await page.waitForTimeout(700);
    await expect(toolButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="canvas-live-draft-layer"] > *')).toHaveCount(0);
    await expect(page.locator(".text-block-editor-content, .shape-contained-text-editor-content")).toHaveCount(0);
    expect(await workspaceJson(page)).toBe(baselineJson);
    expect(await persistenceCounts(page)).toEqual({ apply: 0, session: 0 });

    await page.getByRole("tabpanel").focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => elementX(page, "text-rich")).toBe(320);
    await expect.poll(async () => (await persistenceCounts(page)).apply).toBe(1);
    expect((await workspaceElements(page)).find((element) => element.id === "text-rich")?.updatedAt).toBe(1);
  });
}

async function assertRichTreesRemainFormatted(page: Page) {
  for (const id of ["text-rich", "shape-rectangle", "shape-ellipse", "shape-diamond"]) {
    const element = page.locator(`[data-canvas-element-id="${id}"]`);
    const display = element.locator(id === "text-rich" ? ".text-block-display" : ".shape-contained-text-display");
    await expect(display.locator("h2 strong")).toContainText("Need");
    await expect(display.locator("h2 em")).toContainText("le");
    await expect(display.locator("ul li")).toHaveText("Item");
    await expect(display.locator('img[alt="Diagram"]')).toHaveCount(1);
  }
}

async function invariantSnapshot(page: Page) {
  return {
    formatting: await formattingSnapshot(page),
    workspaceJson: await workspaceJson(page),
  };
}

async function formattingSnapshot(page: Page) {
  return page.locator('[data-canvas-element-id="text-rich"], [data-canvas-element-type="shape"]').evaluateAll((elements) => elements.map((element) => {
    const content = element.querySelector(".text-block-rich-content")?.cloneNode(true) as HTMLElement | undefined;
    content?.querySelectorAll("mark.canvas-search-match").forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent ?? "")));
    return {
      id: element.getAttribute("data-canvas-element-id"),
      html: content?.innerHTML ?? "",
      transform: (element as HTMLElement).style.transform,
    };
  }));
}

async function workspaceJson(page: Page) {
  return page.evaluate(() => JSON.stringify((window as unknown as { __searchWorkspace: unknown }).__searchWorkspace));
}

async function workspaceElements(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __searchWorkspace: { elements: Array<Record<string, unknown>> };
  }).__searchWorkspace.elements);
}

async function elementX(page: Page, id: string) {
  const element = (await workspaceElements(page)).find((candidate) => candidate.id === id);
  return Number(element?.x);
}

async function persistenceCounts(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __searchPersistenceCounts: { apply: number; session: number };
  }).__searchPersistenceCounts);
}

async function resetPersistenceCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as {
      __searchPersistenceCounts: { apply: number; session: number };
    }).__searchPersistenceCounts = { apply: 0, session: 0 };
  });
}

async function contrastRatio(foreground: Locator, background: Locator) {
  const [foregroundColor, backgroundColor] = await Promise.all([
    foreground.evaluate((element) => getComputedStyle(element).color),
    background.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  const parseRgb = (value: string) => {
    const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Could not parse color: ${value}`);
    return channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
  };
  const luminance = (channels: number[]) => 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const first = luminance(parseRgb(foregroundColor));
  const second = luminance(parseRgb(backgroundColor));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function installSearchWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string };
    const style = {
      fillColor: { kind: "fixed", value: "#fff4cc" },
      roughness: 0.5,
      roundness: 0.6,
      seed: 51,
      strokeColor: { kind: "theme", token: "foreground" },
      strokeStyle: "solid",
      strokeWidth: 2,
    };
    const richContent = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [
          { type: "text", text: "Need", marks: [{ type: "bold" }] },
          { type: "text", text: "le", marks: [{ type: "italic" }] },
          { type: "text", text: " label" },
        ] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }] }] },
        { type: "image", attrs: { src: "data:image/png;base64,AA==", alt: "Diagram", title: null, width: 20, height: 20 } },
      ],
    };
    const richText = () => ({ content: "Needle label\nItem", richContent: structuredClone(richContent) });
    const elements = [
      {
        backgroundMode: "surface", content: richText().content, richContent: richText().richContent,
        createdAt: 1, height: 180, id: "text-rich", isWidthManuallyResized: true, locked: false,
        opacity: 1, pageId: "page", rotation: 0, type: "text", updatedAt: 1, width: 300, x: 320, y: 180, zIndex: 1,
      },
      {
        backgroundMode: "surface", content: "", createdAt: 1, height: 96, id: "editor-guard",
        locked: false, opacity: 1, pageId: "page", rotation: 0, type: "text", updatedAt: 1,
        width: 240, x: 720, y: 180, zIndex: 2,
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        backgroundMode: "surface", content: "a".repeat(1_000), createdAt: 1, height: 100,
        id: `dense-${index}`, locked: false, opacity: 1, pageId: "page", rotation: 0,
        type: "text", updatedAt: 1, width: 300, x: 100 + index * 40, y: 2_400 + index * 160, zIndex: 10 + index,
      })),
      ...(["rectangle", "ellipse", "diamond"] as const).map((shape, index) => ({
        createdAt: 1, height: 280, id: `shape-${shape}`, locked: false, opacity: 1, pageId: "page",
        rotation: [17, -23, 31][index], shape, style: { ...style, seed: 52 + index }, text: richText(), type: "shape",
        updatedAt: 1, width: 420, x: 560 + index * 70, y: 760 + index * 500, zIndex: 2 + index,
      })),
      {
        createdAt: 1, end: { kind: "free", x: 1_080, y: 560 }, id: "search-connector",
        locked: false, opacity: 1, pageId: "page", start: { kind: "free", x: 860, y: 560 },
        style: { ...style, endArrowhead: "arrow", startArrowhead: "none" }, type: "connector",
        updatedAt: 1, zIndex: 9,
      },
    ] as ElementRecord[];
    const workspace = {
      elements,
      folders: [],
      isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Needle Search invariants" }],
      sessionState: {
        openPageTabIds: ["page"],
        pageViewports: { page: { panOffset: { x: 12, y: 34 }, zoomLevel: 1 } },
        selectedFolderId: "",
        selectedPageId: "page",
      },
      warnings: [],
    };
    const runtime = window as unknown as {
      __searchWorkspace: typeof workspace;
      __searchPersistenceCounts: { apply: number; session: number };
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      isTauri: boolean;
    };
    runtime.__searchWorkspace = workspace;
    runtime.__searchPersistenceCounts = { apply: 0, session: 0 };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "search.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__searchPersistenceCounts.apply += 1;
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        const deleted = new Set(batch.deletedElementIds);
        workspace.elements = workspace.elements
          .filter((element) => !deleted.has(element.id))
          .map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        workspace.pages[0].revision += 1;
        return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") {
        runtime.__searchPersistenceCounts.session += 1;
        workspace.sessionState = args.state as typeof workspace.sessionState;
        return undefined;
      }
      return undefined;
    } };
  });
}
