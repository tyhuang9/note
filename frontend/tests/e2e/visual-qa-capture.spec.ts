import { expect, test } from "@playwright/test";

const evidenceRoot = "../design-qa-evidence";

test("captures drawing editor visual QA states", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.setViewportSize({ width: 1662, height: 839 });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();

  const shell = page.locator(".app-shell");
  if (await shell.evaluate((element) => element.classList.contains("is-dark"))) {
    await page.getByRole("button", { name: "Dark mode" }).click();
  }
  await page.getByRole("button", { name: "Rectangle (R / 2)" }).click();
  const properties = page.getByRole("complementary", { name: "Drawing properties" });
  await expect(properties).toBeVisible();

  await page.screenshot({ path: `${evidenceRoot}/implementation-light-1662x839.png` });
  await page.getByRole("toolbar", { name: "Drawing tools" }).screenshot({
    path: `${evidenceRoot}/implementation-toolbar-light.png`,
  });
  await properties.screenshot({ path: `${evidenceRoot}/implementation-properties-light.png` });

  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas bounds were not available for visual QA.");
  await page.mouse.click(canvasBounds.x + 620, canvasBounds.y + 360);
  await expect(page.getByLabel("rectangle shape")).toHaveCount(1);
  await page.screenshot({ path: `${evidenceRoot}/implementation-selected-light-1662x839.png` });
  await properties.screenshot({ path: `${evidenceRoot}/implementation-properties-selected-light.png` });

  await page.getByRole("button", { name: "Dark mode" }).click();
  await expect(shell).toHaveClass(/is-dark/);
  await page.screenshot({ path: `${evidenceRoot}/implementation-dark-1662x839.png` });

  await page.setViewportSize({ width: 320, height: 640 });
  if (!(await properties.isVisible())) {
    await page.getByRole("button", { name: "Drawing properties" }).click();
  }
  await expect(properties).toBeVisible();
  const compactPropertiesBounds = await properties.boundingBox();
  const compactToolbarBounds = await page.getByRole("toolbar", { name: "Drawing tools" }).boundingBox();
  expect(compactPropertiesBounds).not.toBeNull();
  expect(compactToolbarBounds).not.toBeNull();
  expect(compactPropertiesBounds!.x).toBeGreaterThanOrEqual(0);
  expect(compactPropertiesBounds!.x + compactPropertiesBounds!.width).toBeLessThanOrEqual(320);
  expect(compactToolbarBounds!.x).toBeGreaterThanOrEqual(0);
  expect(compactToolbarBounds!.x + compactToolbarBounds!.width).toBeLessThanOrEqual(320);
  expect(await canvas.evaluate((element) => element.scrollLeft)).toBe(0);
  await page.screenshot({ path: `${evidenceRoot}/implementation-compact-dark-320x640.png` });

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("captures the official Excalidraw reference at the target viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1662, height: 839 });
  await page.goto("https://excalidraw.com", { waitUntil: "networkidle" });
  await expect(page.locator("body")).toBeVisible();
  await page.screenshot({ path: `${evidenceRoot}/reference-excalidraw-live-1662x839.png` });

  await page.keyboard.press("2");
  await page.mouse.move(560, 310);
  await page.mouse.down();
  await page.mouse.move(790, 520, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${evidenceRoot}/reference-excalidraw-selected-1662x839.png` });
});
