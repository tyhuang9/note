import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("automatic textboxes expand to the intrinsic width of rich text", async ({
  page,
}) => {
  const text = "MMMMMMMMMMMMMMMMMMMMMMMM";
  const { block, editor } = await createTextbox(page, text);

  await expect(editor).toHaveText(text);

  const regularWidth = await waitForBlockWidth(block, (width) => width > 220);

  await page.keyboard.press("Control+A");
  await page.getByRole("combobox", { name: "Font size" }).selectOption("32px");

  const richWidth = await waitForBlockWidth(
    block,
    (width) => width > regularWidth + 100,
  );

  expect(richWidth).toBeGreaterThan(regularWidth + 100);
  await expect.poll(() => getRenderedLineCount(editor)).toBe(1);
});

test("manually resized textboxes keep their width, wrap, and retain click-to-caret", async ({
  page,
}) => {
  const { block, editor } = await createTextbox(page, "seed");
  await resizeBlockEast(page, block, -70);

  const manualWidth = await getBlockWidth(block);
  const text =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";

  await block.locator(".text-block-display").click();
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);

  await expect(editor).toHaveText(text);
  await page.waitForTimeout(350);
  expect(await getBlockWidth(block)).toBeCloseTo(manualWidth, 0);
  await expect.poll(() => getRenderedLineCount(editor)).toBeGreaterThan(1);

  await clickCanvas(page, 720, 520);

  const display = block.locator(".text-block-display");
  await expect(display).toBeVisible();
  const caretPoint = await getPointForTextOffset(
    display,
    text.indexOf("epsilon"),
  );

  await page.mouse.click(caretPoint.x, caretPoint.y);
  await expect(editor).toBeFocused();
  await page.keyboard.type("|");

  const editedText = await editor.textContent();

  expect(editedText).toContain("|");
  expect(editedText?.endsWith("|")).toBe(false);
  expect(await getBlockWidth(block)).toBeCloseTo(manualWidth, 0);
});

async function clickCanvas(page: Page, x: number, y: number) {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.click(bounds.x + x, bounds.y + y);
}

async function createTextbox(page: Page, text: string) {
  await clickCanvas(page, 280, 240);
  await page.keyboard.press("x");

  const block = page.locator(".text-block").last();
  const editor = block.locator(".text-block-editor-content");

  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);

  return { block, editor };
}

async function resizeBlockEast(page: Page, block: Locator, deltaX: number) {
  const header = block.locator(".text-block-header");
  await expect(block.locator(".resize-e")).toHaveCount(0);
  await header.focus();
  const shortcut = deltaX < 0 ? "Alt+Shift+ArrowLeft" : "Alt+Shift+ArrowRight";
  for (let offset = 0; offset < Math.abs(deltaX); offset += 10) await header.press(shortcut);
}

async function waitForBlockWidth(
  block: Locator,
  predicate: (width: number) => boolean,
) {
  let measuredWidth = 0;

  await expect
    .poll(async () => {
      measuredWidth = await getBlockWidth(block);
      return predicate(measuredWidth);
    })
    .toBe(true);

  return measuredWidth;
}

function getBlockWidth(block: Locator) {
  return block.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.width),
  );
}

function getRenderedLineCount(content: Locator) {
  return content.evaluate((element) => {
    const textNode = document
      .createTreeWalker(element, NodeFilter.SHOW_TEXT)
      .nextNode();

    if (!textNode) {
      return 0;
    }

    const range = document.createRange();

    range.selectNodeContents(textNode);

    return new Set(
      Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => Math.round(rect.top)),
    ).size;
  });
}

function getPointForTextOffset(content: Locator, targetOffset: number) {
  return content.evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remainingOffset = offset;
    let textNode = walker.nextNode();

    while (textNode) {
      const textLength = textNode.textContent?.length ?? 0;

      if (remainingOffset < textLength) {
        const range = document.createRange();

        range.setStart(textNode, remainingOffset);
        range.setEnd(textNode, Math.min(textLength, remainingOffset + 1));
        const bounds = range.getBoundingClientRect();

        return {
          x: bounds.left + 1,
          y: bounds.top + bounds.height / 2,
        };
      }

      remainingOffset -= textLength;
      textNode = walker.nextNode();
    }

    throw new Error("The requested text offset was not rendered.");
  }, targetOffset);
}
