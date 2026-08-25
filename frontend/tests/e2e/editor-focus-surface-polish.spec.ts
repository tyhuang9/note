import { expect, test, type Locator, type Page } from "@playwright/test";

for (const scenario of [
  { background: "surface", dark: false, zoom: 50 },
  { background: "transparent", dark: true, zoom: 100 },
  { background: "surface", dark: false, zoom: 200 },
] as const) {
  test(`textbox editing uses only its caret at ${scenario.zoom}% ${scenario.dark ? "dark" : "light"}`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create new note/i }).click();
    const canvas = page.getByRole("tabpanel");
    const themeToggle = page.getByRole("button", { name: "Dark mode" });
    if ((await themeToggle.getAttribute("aria-pressed")) !== String(scenario.dark)) await themeToggle.click();
    await setZoom(page, canvas, scenario.zoom);
    const canvasBounds = await requiredBounds(canvas, "canvas");

    await page.getByRole("button", { name: "Text (T / 8)" }).click();
    if (scenario.background === "transparent") {
      await page.getByRole("complementary", { name: "Drawing properties" })
        .getByRole("radio", { name: "Transparent text background" })
        .click();
    }
    await page.mouse.dblclick(
      canvasBounds.x + canvasBounds.width * 0.52,
      canvasBounds.y + canvasBounds.height * 0.45,
    );
    let editor = page.locator(".text-block-editor-content").last();
    await expect(editor).toBeFocused();
    await editor.fill("Caret focus target");
    await editor.press("Control+Enter");
    const block = page.locator(".text-block").last();
    const display = block.locator(".text-block-display");
    await expect(display).toContainText("Caret focus target");
    await page.getByRole("button", { name: /Select \(V/ }).click();
    await display.click();
    const textBounds = await requiredBounds(display, "text display");
    await page.mouse.dblclick(
      textBounds.x + textBounds.width / 2,
      textBounds.y + textBounds.height / 2,
    );
    editor = block.locator(".text-block-editor-content");
    await expect(editor).toBeFocused();
    await expect(page.locator(".selection-frame")).toHaveCount(0);
    await expect(block).toHaveCSS("border-left-color", "rgba(0, 0, 0, 0)");
    await expect(block).toHaveCSS("box-shadow", "none");
    const header = block.locator(".text-block-header");
    await expect(header).toHaveCSS("opacity", "0");
    await expect(header).toHaveCSS("pointer-events", "none");
    await expect(header).toHaveAttribute("aria-hidden", "true");
    await expect(header).toHaveAttribute("tabindex", "-1");
    await expect(header).not.toHaveAttribute("role", "button");
    expect(await header.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    expect(await header.evaluate((element) =>
      getComputedStyle(element, "::after").opacity)).toBe("0");
    const background = await block.evaluate((element) => getComputedStyle(element).backgroundColor);
    if (scenario.background === "transparent") expect(background).toBe("rgba(0, 0, 0, 0)");
    else expect(background).not.toBe("rgba(0, 0, 0, 0)");
    const caretOffset = await page.evaluate(() => window.getSelection()?.focusOffset ?? -1);
    expect(caretOffset).toBeGreaterThan(0);
    expect(caretOffset).toBeLessThan("Caret focus target".length);

    await page.keyboard.press("Shift+Tab");
    await expect(header).not.toBeFocused();
    await expect(editor).toBeFocused();
    await expect(block).toHaveClass(/is-editing/);
    const editorCaretOffset = await page.evaluate(() => window.getSelection()?.focusOffset ?? -1);
    const headerBounds = await requiredBounds(header, "text header spacer");
    await page.mouse.click(headerBounds.x + headerBounds.width / 2, headerBounds.y + headerBounds.height / 2);
    await expect(editor).toBeFocused();
    await expect(block).toHaveClass(/is-editing/);
    expect(await page.evaluate(() => window.getSelection()?.focusOffset ?? -1)).toBe(editorCaretOffset);

    await editor.type("!");
    await expect(header).toHaveCSS("opacity", "0");
  });
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  const steps = Math.abs(percent - 100) / 10;
  for (let index = 0; index < steps; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}
