import { expect, test, type Locator, type Page } from "@playwright/test";

const evidenceRoot = "../design-qa-evidence";
const baseUrl = process.env.VISUAL_QA_BASE_URL ?? "/";

test("captures drawing editor visual QA states", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  // Matches supplied Image 1: a dark empty workspace must not expose canvas authoring.
  await page.setViewportSize({ width: 1659, height: 830 });
  await page.goto(baseUrl);
  await ensureDarkMode(page);
  await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Drawing properties" })).toHaveCount(0);
  await expect(page.locator('input[type="file"][accept="image/*"]')).toHaveCount(0);
  await page.screenshot({ path: `${evidenceRoot}/implementation-empty-dark-1659x830.png` });

  // Matches supplied Image 2's viewport and exercises unclipped rough geometry plus arrow binding.
  await page.setViewportSize({ width: 1069, height: 598 });
  await page.getByRole("button", { name: /create new note/i }).click();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  const canvas = page.getByRole("tabpanel");
  await expect(canvas).toBeVisible();
  await requiredBounds(canvas, "canvas");

  await page.getByRole("button", { name: "Ellipse (O / 4)" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(properties).toBeVisible();
  await properties.getByRole("button", { name: "Thick stroke (4px)" }).click();
  await properties.getByRole("button", { name: "Cartoonist" }).click();
  await draw(page, 420, 190, 560, 300);

  await page.getByRole("button", { name: "Ellipse (O / 4)" }).click();
  await draw(page, 730, 245, 930, 375);
  const ellipses = page.getByRole("button", {
    name: "Select and move ellipse shape. Press F2 to edit contained text.",
  });
  await expect(ellipses).toHaveCount(2);
  const firstEllipse = ellipses.first();
  const secondEllipse = ellipses.last();
  const firstId = await firstEllipse.getAttribute("data-canvas-element-id");
  const secondId = await secondEllipse.getAttribute("data-canvas-element-id");
  if (!firstId || !secondId) throw new Error("Ellipse identifiers were unavailable for visual QA.");

  await page.getByRole("button", { name: "Arrow (A / 5)" }).click();
  const firstEllipseBounds = await requiredBounds(firstEllipse, "first ellipse");
  await page.mouse.click(
    firstEllipseBounds.x + firstEllipseBounds.width - 1,
    firstEllipseBounds.y + firstEllipseBounds.height / 2,
  );
  const firstHighlight = page.locator(`[data-connector-target-id="${firstId}"]`);
  const secondHighlight = page.locator(`[data-connector-target-id="${secondId}"]`);
  await expect(firstHighlight).toHaveCount(1);
  await expect(secondHighlight).toHaveCount(0);
  await expect(firstHighlight).toHaveAttribute("data-connector-binding-state", "snapped");
  await expect(page.locator('[role="status"].canvas-accessibility-status')).toHaveText(
    "Arrow start bound. Choose an end point.",
  );
  await page.screenshot({ path: `${evidenceRoot}/implementation-arrow-anchors-dark-1069x598.png` });

  const secondEllipseBounds = await requiredBounds(secondEllipse, "second ellipse");
  await page.mouse.move(
    secondEllipseBounds.x + 1,
    secondEllipseBounds.y + secondEllipseBounds.height / 2,
    { steps: 6 },
  );
  await expect(firstHighlight).toHaveCount(0);
  await expect(secondHighlight).toHaveCount(1);
  await expect(secondHighlight).toHaveAttribute("data-connector-binding-state", "snapped");
  const secondTargetBounds = await requiredBounds(secondHighlight, "second ellipse whole-object target highlight");
  const end = center(secondTargetBounds);
  await page.mouse.move(end.x, end.y, { steps: 6 });
  const preview = canvas.getByTestId("canvas-live-draft-layer").locator(".arrow-authoring-preview");
  await expect(preview).toHaveAttribute("opacity", "1");
  await expect(preview).not.toHaveAttribute("stroke-dasharray", /./);
  await page.screenshot({ path: `${evidenceRoot}/implementation-arrow-preview-dark-1069x598.png` });
  await page.mouse.click(end.x, end.y);

  const arrow = page.getByRole("button", { name: "Select and move arrow connector" });
  await expect(arrow).toBeVisible();
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  await expect(startHandle).toBeVisible();
  await expect(endHandle).toBeVisible();
  const resolvedStart = await resolvedConnectorEndpointScreen(page, arrow, "start");
  const resolvedEnd = await resolvedConnectorEndpointScreen(page, arrow, "end");
  expect(resolvedStart.x).toBeGreaterThan(center(firstEllipseBounds).x);
  expect(resolvedEnd.x).toBeLessThan(center(secondEllipseBounds).x);
  expect(distance(center(await requiredBounds(startHandle, "arrow start handle")), resolvedStart)).toBeLessThanOrEqual(2);
  expect(distance(center(await requiredBounds(endHandle, "arrow end handle")), resolvedEnd)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: `${evidenceRoot}/implementation-bound-arrow-dark-1069x598.png` });

  // A bound arrow follows its source shape instead of retaining stale coordinates.
  const arrowBeforeTargetMove = await requiredBounds(arrow, "bound arrow");
  await firstEllipse.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => {
    const bounds = await requiredBounds(arrow, "bound arrow after target move");
    return bounds.x > arrowBeforeTargetMove.x + 8 && bounds.width < arrowBeforeTargetMove.width - 8;
  }).toBe(true);

  await captureGroupSelection(page, canvas, [firstEllipse, secondEllipse], "light");
  await ensureDarkMode(page);
  await captureGroupSelection(page, canvas, [firstEllipse, secondEllipse], "dark");

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

async function captureGroupSelection(
  page: Page,
  canvas: Locator,
  ellipses: readonly Locator[],
  theme: "light" | "dark",
) {
  if (theme === "light") await ensureLightMode(page);
  const firstBounds = await requiredBounds(ellipses[0], "first ellipse");
  const secondBounds = await requiredBounds(ellipses[1], "second ellipse");
  await page.getByRole("button", { name: "Select (V / 1)" }).click();
  await page.mouse.move(Math.min(firstBounds.x, secondBounds.x) - 28, Math.min(firstBounds.y, secondBounds.y) - 28);
  await page.mouse.down();
  await page.mouse.move(
    Math.max(firstBounds.x + firstBounds.width, secondBounds.x + secondBounds.width) + 28,
    Math.max(firstBounds.y + firstBounds.height, secondBounds.y + secondBounds.height) + 28,
    { steps: 6 },
  );
  await page.mouse.up();
  const moveSurface = page.getByRole("button", { name: "Move selected elements" });
  await expect(moveSurface).toBeVisible();
  const moveBounds = await requiredBounds(moveSurface, "selection group drag surface");
  await page.mouse.move(moveBounds.x + moveBounds.width / 2, moveBounds.y + moveBounds.height / 2);
  await expect(moveSurface).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: `${evidenceRoot}/implementation-group-selection-${theme}-1069x598.png` });
  expect(await canvas.evaluate((element) => element.scrollLeft)).toBe(0);
}

async function ensureDarkMode(page: Page) {
  const shell = page.locator(".app-shell");
  if (!(await shell.evaluate((element) => element.classList.contains("is-dark")))) {
    await page.getByRole("button", { name: "Dark mode" }).click();
  }
  await expect(shell).toHaveClass(/is-dark/);
}

async function ensureLightMode(page: Page) {
  const shell = page.locator(".app-shell");
  if (await shell.evaluate((element) => element.classList.contains("is-dark"))) {
    await page.getByRole("button", { name: "Dark mode" }).click();
  }
  await expect(shell).not.toHaveClass(/is-dark/);
}

async function draw(page: Page, startX: number, startY: number, endX: number, endY: number) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function resolvedConnectorEndpointScreen(page: Page, connector: Locator, endpoint: "start" | "end") {
  const point = await connector.evaluate((node, endpointName) => {
    const x = Number(node.getAttribute(`data-connector-${endpointName}-x`));
    const y = Number(node.getAttribute(`data-connector-${endpointName}-y`));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Resolved connector ${endpointName} point was unavailable.`);
    }
    return { x, y };
  }, endpoint);
  return modelToScreen(page, point);
}

async function modelToScreen(page: Page, point: { x: number; y: number }) {
  return page.evaluate((worldPoint) => {
    const content = document.querySelector<HTMLElement>(".canvas-content");
    if (!content) throw new Error("Canvas content was unavailable.");
    const bounds = content.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(content).transform);
    return {
      x: bounds.x + worldPoint.x * matrix.a,
      y: bounds.y + worldPoint.y * matrix.d,
    };
  }, point);
}

function center(bounds: { x: number; y: number; width: number; height: number }) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function distance(first: { x: number; y: number }, second: { x: number; y: number }) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}
