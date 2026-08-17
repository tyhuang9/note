import { expect, test, type Page } from "@playwright/test";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR42mP8z8AARAwMAAAdAQEEhTgNAAAAAElFTkSuQmCC",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("creates primitives, applies tool lock, supports temporary hand, and erases shape geometry", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  const select = page.getByRole("button", { name: "Select (V / 1)" });
  const rectangleTool = page.getByRole("button", { name: "Rectangle (R / 2)" });
  const lock = page.getByRole("button", { name: "Keep drawing tool active" });

  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await rectangleTool.click();
  await page.mouse.click(bounds.x + 300, bounds.y + 320);
  const rectangle = page.getByLabel("rectangle shape");
  await expect(rectangle).toHaveCount(1);
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Move selected elements")).toBeVisible();
  await expect(page.getByRole("button", { name: /Resize selected elements from/ })).toHaveCount(4);

  const firstRectangleBounds = await rectangle.boundingBox();
  const southeastHandle = page.getByRole("button", { name: "Resize selected elements from se" });
  const southeastBounds = await southeastHandle.boundingBox();
  if (!firstRectangleBounds || !southeastBounds) throw new Error("Shape resize controls were not available.");
  await page.mouse.move(southeastBounds.x + southeastBounds.width / 2, southeastBounds.y + southeastBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(southeastBounds.x + southeastBounds.width / 2 + 60, southeastBounds.y + southeastBounds.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await rectangle.boundingBox())?.width ?? 0).toBeGreaterThan(firstRectangleBounds.width + 40);

  await lock.click();
  await rectangleTool.click();
  await page.mouse.move(bounds.x + 520, bounds.y + 330);
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(bounds.x + 570, bounds.y + 365, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.up("Shift");
  await expect(rectangle).toHaveCount(2);
  await expect(rectangleTool).toHaveAttribute("aria-pressed", "true");

  await lock.click();
  await select.click();
  const beforePan = await page.locator(".canvas-content").evaluate((element) =>
    (element as HTMLElement).style.transform,
  );
  await canvas.focus();
  await page.keyboard.down("Space");
  await page.mouse.move(bounds.x + 760, bounds.y + 500);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 810, bounds.y + 545, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect.poll(async () => page.locator(".canvas-content").evaluate((element) =>
    (element as HTMLElement).style.transform,
  )).not.toBe(beforePan);
  await expect(select).toHaveAttribute("aria-pressed", "true");

  const targetBounds = await rectangle.first().boundingBox();
  if (!targetBounds) throw new Error("Rectangle bounds were not available.");
  await page.getByRole("button", { name: "Eraser (E / 0)" }).click();
  await page.mouse.click(targetBounds.x + targetBounds.width / 2, targetBounds.y + 1);
  await expect(rectangle).toHaveCount(1);
});

test("keeps live primitive previews solid and fully opaque", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Ellipse (O / 4)" }).click();
  await page.mouse.move(bounds.x + 360, bounds.y + 310);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 490, bounds.y + 400, { steps: 3 });

  const preview = canvas.getByTestId("canvas-live-draft-layer").locator("g");
  await expect(preview).toHaveAttribute("opacity", "1");
  await expect(preview).not.toHaveAttribute("stroke-dasharray", /./);
  await page.mouse.up();

  const ellipse = page.getByLabel("ellipse shape");
  await expect(ellipse).toBeVisible();
  await expect(ellipse).toHaveCSS("overflow", "visible");
});

test("renders every geometric primitive and moves connectors with a composite selection", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Diamond (D / 3)" }).click();
  await page.mouse.click(bounds.x + 330, bounds.y + 300);
  await page.getByRole("button", { name: "Ellipse (O / 4)" }).click();
  await page.mouse.click(bounds.x + 620, bounds.y + 300);

  await page.getByRole("button", { name: "Line (L / 6)" }).click();
  await page.mouse.move(bounds.x + 330, bounds.y + 520);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 500, bounds.y + 590, { steps: 4 });
  await page.mouse.up();

  await page.getByRole("button", { name: "Arrow (A / 5)" }).click();
  await page.mouse.move(bounds.x + 620, bounds.y + 520);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 790, bounds.y + 590, { steps: 4 });
  await page.mouse.up();

  await expect(page.getByLabel("diamond shape")).toHaveCount(1);
  await expect(page.getByLabel("ellipse shape")).toHaveCount(1);
  const connectors = page.locator("svg.primitive-connector");
  await expect(connectors).toHaveCount(2);
  await expect(page.locator(".primitive-connector > g")).toHaveCount(3);
  await expect(page.locator(".primitive-connector > line")).toHaveCount(0);

  const arrowConnector = connectors.last();
  const arrowBeforeEndpointMove = await arrowConnector.boundingBox();
  const endEndpoint = page.getByRole("button", { name: "Move connector end endpoint" });
  const endEndpointBounds = await endEndpoint.boundingBox();
  if (!arrowBeforeEndpointMove || !endEndpointBounds) throw new Error("Connector endpoint controls were not available.");
  await page.mouse.move(endEndpointBounds.x + endEndpointBounds.width / 2, endEndpointBounds.y + endEndpointBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(endEndpointBounds.x + endEndpointBounds.width / 2 + 50, endEndpointBounds.y + endEndpointBounds.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await arrowConnector.boundingBox())?.width ?? 0).toBeGreaterThan(arrowBeforeEndpointMove.width + 40);
  await endEndpoint.press("Shift+ArrowRight");
  await expect.poll(async () => (await arrowConnector.boundingBox())?.width ?? 0).toBeGreaterThan(arrowBeforeEndpointMove.width + 50);

  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await page.mouse.move(bounds.x + 285, bounds.y + 230);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 920, bounds.y + 680, { steps: 6 });
  await page.mouse.up();

  const moveSurface = page.getByRole("button", { name: "Move selected elements" });
  await expect(moveSurface).toBeVisible();
  const diamondBefore = await page.getByLabel("diamond shape").boundingBox();
  const connectorBefore = await connectors.first().boundingBox();
  const moveBounds = await moveSurface.boundingBox();
  if (!diamondBefore || !connectorBefore || !moveBounds) throw new Error("Composite primitive selection was not available.");

  await page.mouse.move(moveBounds.x + moveBounds.width / 2, moveBounds.y + moveBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBounds.x + moveBounds.width / 2 + 72, moveBounds.y + moveBounds.height / 2 + 48, { steps: 5 });
  await page.mouse.up();

  const diamondAfter = await page.getByLabel("diamond shape").boundingBox();
  const connectorAfter = await connectors.first().boundingBox();
  if (!diamondAfter || !connectorAfter) throw new Error("Moved primitive bounds were not available.");
  expect(diamondAfter.x - diamondBefore.x).toBeCloseTo(72, 0);
  expect(diamondAfter.y - diamondBefore.y).toBeCloseTo(48, 0);
  expect(connectorAfter.x - connectorBefore.x).toBeCloseTo(72, 0);
  expect(connectorAfter.y - connectorBefore.y).toBeCloseTo(48, 0);
});

test("selects, moves, and deletes shapes and connectors from the keyboard", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  await page.mouse.click(bounds.x + 420, bounds.y + 320);
  const shape = page.getByRole("button", { name: "Select and move rectangle element" });
  await page.mouse.click(bounds.x + 850, bounds.y + 650);
  await shape.focus();
  await page.keyboard.press("Enter");
  await expect(shape).toHaveAttribute("aria-pressed", "true");
  const shapeBefore = await shape.boundingBox();
  await page.keyboard.press("Shift+ArrowRight");
  const shapeAfter = await shape.boundingBox();
  expect((shapeAfter?.x ?? 0) - (shapeBefore?.x ?? 0)).toBeCloseTo(10, 0);
  await page.keyboard.press("Delete");
  await expect(shape).toHaveCount(0);

  await page.getByRole("button", { name: "Line (L / 6)" }).click();
  await page.mouse.move(bounds.x + 420, bounds.y + 480);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 600, bounds.y + 540, { steps: 4 });
  await page.mouse.up();
  const connector = page.getByRole("button", { name: "Select and move line connector" });
  await page.mouse.click(bounds.x + 850, bounds.y + 650);
  await connector.focus();
  await page.keyboard.press(" ");
  await expect(connector).toHaveAttribute("aria-pressed", "true");
  const connectorBefore = await connector.boundingBox();
  await page.keyboard.press("ArrowDown");
  const connectorAfter = await connector.boundingBox();
  expect((connectorAfter?.y ?? 0) - (connectorBefore?.y ?? 0)).toBeCloseTo(1, 0);
  await page.keyboard.press("Backspace");
  await expect(connector).toHaveCount(0);
});

test("creates editable text and places a picked image only on the next canvas click", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");
  const select = page.getByRole("button", { name: "Select (V / 1)" });

  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(bounds.x + 300, bounds.y + 300);
  await expect(page.locator(".text-block-editor-content")).toBeVisible();
  await expect(select).toHaveAttribute("aria-pressed", "true");

  await chooseImage(page, "placed-image.png");
  await page.mouse.move(bounds.x + 560, bounds.y + 390);
  await expect(page.locator(".canvas-image-placement-preview")).toBeVisible();
  await page.mouse.click(bounds.x + 560, bounds.y + 390);
  await expect(page.locator(".text-block-image")).toHaveCount(1);
  await expect(page.locator(".canvas-image-placement-preview")).toHaveCount(0);
  await expect(select).toHaveAttribute("aria-pressed", "true");
});

test("moves and resizes a selected text block with semantic keyboard controls", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await page.mouse.click(bounds.x + 360, bounds.y + 300);
  const editor = page.locator(".text-block-editor-content");
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.pressSequentially("Keyboard text");
  await expect(editor).toContainText("Keyboard text");
  await page.keyboard.press("Escape");
  const textBlock = page.locator(".text-block").filter({ hasText: "Keyboard text" });
  const moveControl = textBlock.getByRole("button", { name: "Select and move text block" });
  await moveControl.focus();
  await expect(moveControl).toHaveAttribute("aria-pressed", "true");
  const beforeMove = await textBlock.boundingBox();
  await moveControl.press("Shift+ArrowDown");
  await expect.poll(async () => (await textBlock.boundingBox())?.y ?? 0).toBeCloseTo((beforeMove?.y ?? 0) + 10, 0);

  const widthControl = textBlock.getByRole("slider", { name: "Resize text block width" });
  const beforeWidth = await textBlock.boundingBox();
  await widthControl.focus();
  await widthControl.press("Shift+ArrowRight");
  await expect.poll(async () => (await textBlock.boundingBox())?.width ?? 0).toBeCloseTo((beforeWidth?.width ?? 0) + 10, 0);
  await expect(widthControl).toHaveAttribute("aria-valuetext", /pixels wide/);
});

test("Escape cancels a pending picked image without creating an element", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds were not available.");

  await chooseImage(page, "cancelled-image.png");
  await page.mouse.move(bounds.x + 520, bounds.y + 360);
  await expect(page.locator(".canvas-image-placement-preview")).toBeVisible();
  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".canvas-image-placement-preview")).toHaveCount(0);
  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select (V / 1)" })).toHaveAttribute("aria-pressed", "true");
});

test("rejects an oversized picked image before creating a preview", async ({ page }) => {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Image (I / 9)" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    buffer: Buffer.alloc(16 * 1024 * 1024 + 1),
    mimeType: "image/png",
    name: "too-large.png",
  });

  await expect(page.getByRole("alert")).toContainText("Image exceeds the 16 MiB size limit");
  await expect(page.locator(".canvas-image-placement-preview")).toHaveCount(0);
  await expect(page.locator(".text-block-image")).toHaveCount(0);
});

async function chooseImage(page: Page, name: string) {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Image (I / 9)" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ buffer: PNG, mimeType: "image/png", name });
}
