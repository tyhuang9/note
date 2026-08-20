import { expect, test, type Page } from "@playwright/test";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function createInitialNote(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
}

test("desktop workbench docks its explorer and assistant", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createInitialNote(page);

  const shell = page.locator(".workbench-shell");
  await expect(
    page.getByRole("navigation", { name: "Primary workspace tools" }),
  ).toBeVisible();
  await expect(shell).toHaveCSS("grid-template-columns", /328px/);

  await page.getByRole("button", { name: "AI assistant" }).click();
  const assistant = page.getByRole("complementary", { name: "AI assistant" });
  await expect(assistant).toBeVisible();
  await expect(assistant).toHaveCSS("width", "360px");
  await expect
    .poll(() =>
      assistant.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Close assistant", exact: true })).toHaveCount(1);
  await expect(shell).toHaveCSS("grid-template-columns", /328px.*360px/);

  await page.screenshot({
    path: testInfo.outputPath("workbench-1440.png"),
    fullPage: true,
  });
});

test("canvas subsystem keeps world content and interaction overlay in separate layers", async ({ page }) => {
  await createInitialNote(page);
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(bounds.x + 280, bounds.y + 240);
  await page.keyboard.type("Layered element");

  await expect(canvas.locator(":scope > .canvas-content")).toHaveCount(1);
  await expect(canvas.locator(":scope > .canvas-interaction-overlay")).toHaveCount(1);
  await expect(canvas.getByTestId("canvas-live-draft-layer")).toHaveCount(1);
  await expect(canvas.locator('[data-canvas-element-type="text"]')).toHaveAttribute(
    "data-canvas-element-id",
    /.+/,
  );
});

test("canvas caret follows the rendered canvas transform", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createInitialNote(page);

  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();

  if (!canvasBounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.locator(".canvas-content").evaluate((element) => {
    (element as HTMLElement).style.transform =
      "translate3d(83px, 47px, 0) scale(1.25)";
  });

  const clickPoint = {
    x: canvasBounds.x + canvasBounds.width * 0.62,
    y: canvasBounds.y + canvasBounds.height * 0.54,
  };

  await page.mouse.click(clickPoint.x, clickPoint.y);

  const caretBounds = await page.locator(".canvas-caret").boundingBox();

  expect(caretBounds).not.toBeNull();
  expect(Math.abs((caretBounds?.x ?? 0) - clickPoint.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((caretBounds?.y ?? 0) - clickPoint.y)).toBeLessThanOrEqual(1);
});

test("canvas zoom stays anchored to the cursor", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createInitialNote(page);

  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();

  if (!canvasBounds) {
    throw new Error("Canvas bounds were not available.");
  }

  const cursorPoint = {
    x: canvasBounds.x + canvasBounds.width * 0.73,
    y: canvasBounds.y + canvasBounds.height * 0.36,
  };
  const caret = page.locator(".canvas-caret");

  await page.mouse.click(cursorPoint.x, cursorPoint.y);
  const caretBeforeZoom = await caret.boundingBox();

  if (!caretBeforeZoom) {
    throw new Error("Canvas caret bounds were not available before zooming.");
  }

  await page.mouse.move(cursorPoint.x, cursorPoint.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");

  await expect(page.locator(".zoom-indicator")).toHaveText("110%");

  const caretAfterZoomIn = await caret.boundingBox();

  expect(caretAfterZoomIn).not.toBeNull();
  expect(Math.abs((caretAfterZoomIn?.x ?? 0) - caretBeforeZoom.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((caretAfterZoomIn?.y ?? 0) - caretBeforeZoom.y)).toBeLessThanOrEqual(1);

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");

  await expect(page.locator(".zoom-indicator")).toHaveText("100%");

  const caretAfterZoomOut = await caret.boundingBox();

  expect(caretAfterZoomOut).not.toBeNull();
  expect(Math.abs((caretAfterZoomOut?.x ?? 0) - caretBeforeZoom.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((caretAfterZoomOut?.y ?? 0) - caretBeforeZoom.y)).toBeLessThanOrEqual(1);

  await page.keyboard.down("Control");
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.wheel(0, -100);
  }
  await page.keyboard.up("Control");

  await expect(page.locator(".zoom-indicator")).toHaveText("200%");
  const caretAtMaximumZoom = await caret.boundingBox();

  if (!caretAtMaximumZoom) {
    throw new Error("Canvas caret bounds were not available at maximum zoom.");
  }

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");

  await expect(page.locator(".zoom-indicator")).toHaveText("200%");
  const caretAfterClampedZoom = await caret.boundingBox();

  expect(caretAfterClampedZoom).not.toBeNull();
  expect(
    Math.abs((caretAfterClampedZoom?.x ?? 0) - caretAtMaximumZoom.x),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs((caretAfterClampedZoom?.y ?? 0) - caretAtMaximumZoom.y),
  ).toBeLessThanOrEqual(1);
});

test("canvas search and assistant controls share a raised viewport-safe dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createInitialNote(page);

  const controls = page.getByRole("toolbar", { name: "Canvas controls" });
  const assistantToggle = page.getByRole("button", { name: "AI assistant" });

  await expect(assistantToggle).toHaveCount(1);
  await expect(controls.getByRole("button", { name: "AI assistant" })).toBeVisible();
  await controls.getByRole("button", { name: "Find in canvas" }).click();

  const search = page.locator(".search-panel");
  await expect(search).toBeVisible();

  const controlsBounds = await controls.boundingBox();
  const searchBounds = await search.boundingBox();

  if (!controlsBounds || !searchBounds) {
    throw new Error("Expected the canvas controls and search panel to be visible");
  }

  const controlsBottom = controlsBounds.y + controlsBounds.height;
  const searchBottom = searchBounds.y + searchBounds.height;
  expect(900 - controlsBottom).toBeGreaterThanOrEqual(48);
  expect(controlsBounds.y - searchBottom).toBeGreaterThanOrEqual(10);

  const findButton = controls.getByRole("button", { name: "Find in canvas" });
  await findButton.hover();
  await expect
    .poll(() =>
      findButton.evaluate((element) =>
        getComputedStyle(element, "::after").content.replaceAll('"', ""),
      ),
    )
    .toBe("Find in canvas (Ctrl+F)");
  await expect
    .poll(() =>
      findButton.evaluate((element) =>
        Number(getComputedStyle(element, "::after").opacity),
      ),
    )
    .toBe(1);
});

test("compact assistant behaves as a focus-managed overlay", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await createInitialNote(page);

  const assistantToggle = page.getByRole("button", { name: "AI assistant" });
  await assistantToggle.click();

  const assistant = page.getByRole("complementary", { name: "AI assistant" });
  await expect(assistant).toBeVisible();
  await expect(assistant).toBeFocused();
  await expect(page.locator(".is-assistant-backdrop")).toBeVisible();
  await expect(page.locator(".workspace")).toHaveAttribute("inert", "");

  await page.keyboard.press("Escape");
  await expect(assistant).toHaveCount(0);
  await expect(assistantToggle).toBeFocused();
});

test("narrow workbench keeps explorer and assistant overlays exclusive", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await createInitialNote(page);

  const explorerToggle = page.getByRole("button", { name: "Expand sidebar" });
  await explorerToggle.click();
  const explorer = page.locator("#workspace-explorer-panel");
  await expect(explorer).toBeVisible();
  await expect(explorer).toBeFocused();
  await expect(page.locator(".is-explorer-backdrop")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(explorer).toBeHidden();
  await expect(explorerToggle).toBeFocused();

  const assistantToggle = page.getByRole("button", { name: "AI assistant" });
  await assistantToggle.click();
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toBeVisible();
  await expect(page.locator(".is-assistant-backdrop")).toBeVisible();
  await expect(page.locator(".is-explorer-backdrop")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(assistantToggle).toBeFocused();
});

test("narrow page search shortcut focuses the search field", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await createInitialNote(page);

  await page.keyboard.press("Control+O");
  const searchInput = page.getByRole("searchbox", {
    name: "Search files and notes",
  });
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toBeFocused();
  await expect(page.locator(".is-explorer-backdrop")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(searchInput).toBeHidden();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeFocused();
});

test("page tabs support roving keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createInitialNote(page);

  const createPageButton = page.getByRole("button", { name: "Create root page" });
  await createPageButton.click();
  await createPageButton.click();

  const tabs = page.getByRole("tablist", { name: "Open pages" }).getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await tabs.nth(2).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Home");
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
});

test("templates can be saved, instantiated, and deleted without changing created pages", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createInitialNote(page);

  await expect(page.locator(".page-actions")).toHaveCount(0);

  const templateBody = "Content retained after template deletion";
  await clickCanvas(page, 320, 240);
  await page.keyboard.press("x");
  const editor = page.locator(".text-block-editor-content");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(templateBody);
  await expect(editor).toHaveText(templateBody);

  await page.getByRole("button", { name: "0 templates" }).click();
  const templatesSection = page.getByRole("region", { name: "Templates" });
  const saveTemplateButton = templatesSection.getByRole("button", {
    name: "Save current page as template",
  });
  await expect(saveTemplateButton).toBeVisible();
  await expect(saveTemplateButton).toBeEnabled();
  await saveTemplateButton.click();

  await expect(page.getByRole("button", { name: "1 templates" })).toBeVisible();
  const createFromTemplateButton = templatesSection.getByRole("button", {
    name: /^Create page from /,
  });
  const deleteTemplateButton = templatesSection.getByRole("button", {
    name: /^Delete template /,
  });
  await expect(createFromTemplateButton).toBeVisible();
  await expect(deleteTemplateButton).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("templates-sidebar-populated.png"),
    fullPage: true,
  });

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain(
      "Pages already created from this template will not be affected.",
    );
    await dialog.dismiss();
  });
  await deleteTemplateButton.click();
  await expect(createFromTemplateButton).toBeVisible();
  await expect(page.getByRole("button", { name: "1 templates" })).toBeVisible();

  await createFromTemplateButton.click();
  const retainedContent = page
    .locator(".text-block-display")
    .filter({ hasText: templateBody });
  await expect(retainedContent).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain(
      "Pages already created from this template will not be affected.",
    );
    await dialog.accept();
  });
  await deleteTemplateButton.click();

  await expect(page.getByRole("button", { name: "0 templates" })).toBeVisible();
  await expect(templatesSection.getByText("No templates")).toBeVisible();
  await expect(retainedContent).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("templates-sidebar.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 800, height: 800 });
  await page.getByRole("button", { name: "0 templates" }).click();
  await expect(templatesSection).toBeVisible();
  await expect(saveTemplateButton).toBeVisible();

  const compactTemplatesBounds = await templatesSection.boundingBox();
  expect(compactTemplatesBounds).not.toBeNull();
  expect(
    (compactTemplatesBounds?.x ?? 0) + (compactTemplatesBounds?.width ?? 0),
  ).toBeLessThanOrEqual(800);

  await page.screenshot({
    path: testInfo.outputPath("templates-sidebar-compact.png"),
    fullPage: true,
  });
});

test("assistant text actions reject a selected image block", async ({ page }) => {
  await mockLlamaHarness(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await createInitialNote(page);
  await pasteImage(page);
  await expect(page.locator(".text-block-image")).toBeVisible();

  await page.getByRole("button", { name: "AI assistant" }).click();
  const prompt = page.getByRole("textbox", { name: "Assistant prompt" });
  await prompt.fill("Draft a concise caption");
  const sendButton = page.getByRole("button", { name: "Send prompt" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  const actions = page.getByRole("region", { name: "Assistant output actions" });
  await expect(actions).toBeVisible();
  await expect(actions.getByRole("button", { name: "Insert" })).toBeEnabled();
  await expect(actions.getByRole("button", { name: "Append" })).toBeDisabled();
  await expect(actions.getByRole("button", { name: "Replace" })).toBeDisabled();
  await expect(
    page.getByText("Selected block: Image block (text actions unavailable)"),
  ).toBeVisible();
});

async function clickCanvas(page: Page, x: number, y: number) {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.click(bounds.x + x, bounds.y + y);
}

async function pasteImage(page: Page) {
  await page.evaluate((dataUrl) => {
    const binary = atob(dataUrl.split(",")[1]);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([bytes], "clipboard-image.png", { type: "image/png" }),
    );
    document.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  }, PNG_DATA_URL);
}

async function mockLlamaHarness(page: Page) {
  await page.route("http://127.0.0.1:8787/**", async (route) => {
    const request = route.request();
    const corsHeaders = {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-origin": "*",
    };

    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders, status: 204 });
      return;
    }

    const path = new URL(request.url()).pathname;
    let body: object;

    if (path === "/api/setup/status") {
      body = {
        active_agent_count: 1,
        litellm_enabled: true,
        litellm_ready: true,
        missing_steps: [],
        next_step: "ready",
        ready: true,
        usable_model_count: 1,
        usable_provider_count: 1,
      };
    } else if (path === "/api/apps/note/capabilities") {
      const agent = {
        description: "Playwright assistant",
        id: "test-agent",
        name: "Test agent",
      };
      body = {
        allowedAgents: [agent],
        appId: "note",
        appName: "Note",
        defaultAgent: agent,
        model: {
          id: "test-model",
          modelName: "test-model",
          name: "Test model",
          provider: "mock",
          status: "ready",
        },
        tools: [],
      };
    } else {
      body = {
        agentId: "test-agent",
        appId: "note",
        durationMs: 1,
        modelId: "test-model",
        output: "A concise assistant response.",
        runId: "test-run",
        status: "completed",
        toolRequests: [],
      };
    }

    await route.fulfill({
      body: JSON.stringify(body),
      contentType: "application/json",
      headers: corsHeaders,
      status: 200,
    });
  });
}
