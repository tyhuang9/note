import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("textbox select-all is immediate, repeatable, and stays editor-local", async ({
  page,
}) => {
  await createTextbox(page, "first block", 260, 220);
  await clickCanvas(page, 760, 520);
  const { editor } = await createTextbox(page, "second block", 460, 320);

  await page.keyboard.press("Control+A");
  await expect.poll(() => getDocumentSelection(editor)).toBe("second block");
  await expect(editor).toBeFocused();
  await expect(page.locator(".text-block.is-multi-selected")).toHaveCount(0);

  await page.keyboard.press("Control+A");
  await expect.poll(() => getDocumentSelection(editor)).toBe("second block");
  await expect(editor).toBeFocused();
  await expect(page.locator(".text-block.is-multi-selected")).toHaveCount(0);

  const altGrWasPrevented = await editor.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      altKey: true,
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "a",
    });

    element.dispatchEvent(event);
    return event.defaultPrevented;
  });

  expect(altGrWasPrevented).toBe(false);

  await page.keyboard.press("Backspace");
  await expect(editor).toHaveText("");
  await expect(page.getByRole("button", { name: "Underline" })).toBeEnabled();
  await page.keyboard.insertText("replacement");

  await clickCanvas(page, 760, 520);
  const canvasAltGrWasPrevented = await page.getByRole("tabpanel").evaluate(
    (element) => {
      const event = new KeyboardEvent("keydown", {
        altKey: true,
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "a",
      });

      element.dispatchEvent(event);
      return event.defaultPrevented;
    },
  );

  expect(canvasAltGrWasPrevented).toBe(false);
  await expect(page.locator(".text-block.is-multi-selected")).toHaveCount(0);
  await page.keyboard.press("Control+A");
  await expect(page.locator(".text-block.is-multi-selected")).toHaveCount(2);
});

test("local underline does not change the global toolbar fallback", async ({
  page,
}) => {
  const { block, editor } = await createTextbox(page, "local underline", 300, 240);
  const underlineButton = page.getByRole("button", { name: "Underline" });

  await page.keyboard.press("Control+A");
  await underlineButton.click();

  await expect(editor.locator("u")).toHaveText("local underline");
  await expect(underlineButton).toHaveAttribute("aria-pressed", "true");

  await clickCanvas(page, 760, 520);

  await expect(block.locator(".text-block-display u")).toHaveText(
    "local underline",
  );
  await expect(underlineButton).toHaveAttribute("aria-pressed", "false");
});

test("local font commands preserve the sibling text style attribute", async ({
  page,
}) => {
  const { editor } = await createTextbox(page, "styled text", 300, 240);

  await page.keyboard.press("Control+A");
  await page
    .getByRole("combobox", { name: "Font family" })
    .selectOption("Georgia");
  await page
    .getByRole("combobox", { name: "Font size" })
    .selectOption("24px");

  await expect.poll(() => getInlineTextStyle(editor)).toEqual({
    fontFamily: "Georgia",
    fontSize: "24px",
  });

  await page
    .getByRole("combobox", { name: "Font family" })
    .selectOption("system-ui");

  await expect.poll(() => getInlineTextStyle(editor)).toEqual({
    fontFamily: "",
    fontSize: "24px",
  });
});

test("toolbar focus transfer cannot leak ownership between textboxes", async ({
  page,
}) => {
  const first = await createTextbox(page, "first editor", 280, 220);
  await clickCanvas(page, 760, 520);
  const second = await createTextbox(page, "second editor", 520, 320);

  await page.keyboard.press("Control+A");
  await page
    .getByRole("combobox", { name: "Font family" })
    .selectOption("Georgia");
  await first.block.locator(".text-block-display").click();
  await expect(first.editor).toBeFocused();

  await page.keyboard.press("Control+A");
  await page.getByRole("button", { name: "Underline" }).click();

  await expect(first.editor.locator("u")).toHaveText("first editor");
  await expect(second.block.locator(".text-block-display u")).toHaveCount(0);
  await expect.poll(() => getInlineTextStyle(first.editor)).toEqual({
    fontFamily: "",
    fontSize: "",
  });
  await expect.poll(() => getInlineTextStyle(second.block.locator(".text-block-display"))).toEqual({
    fontFamily: "Georgia",
    fontSize: "",
  });
});

test("global formatting updates selected textboxes and seeds future text", async ({
  page,
}) => {
  const { block } = await createTextbox(page, "existing text", 300, 240);
  const underlineButton = page.getByRole("button", { name: "Underline" });

  await block.getByRole("button", { name: "Select and move text block" }).click();
  await expect(block.locator(".text-block-display")).toBeVisible();
  await underlineButton.click();

  await expect(underlineButton).toHaveAttribute("aria-pressed", "true");
  await expect(block.locator(".text-block-display u")).toHaveText("existing text");

  await page.keyboard.press("Control+Z");
  await expect(block.locator(".text-block-display u")).toHaveCount(0);
  await expect(underlineButton).toHaveAttribute("aria-pressed", "true");

  await clickCanvas(page, 700, 460);
  await page.keyboard.press("n");

  const newBlock = page.locator(".text-block").last();
  await expect(newBlock.locator(".text-block-editor-content u")).toHaveText("n");
});

test("global formatting defaults persist and malformed values normalize", async ({
  page,
}) => {
  await installPersistentTauriMock(page);
  await page.reload();
  await expect(page.getByRole("tabpanel")).toBeVisible();

  const underlineButton = page.getByRole("button", { name: "Underline" });

  await expect(underlineButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("combobox", { name: "Font family" })).toHaveValue(
    "system-ui",
  );
  await expect(page.getByRole("combobox", { name: "Font size" })).toHaveValue(
    "18px",
  );

  await underlineButton.click();
  await expect(underlineButton).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => getSavedTextFormatDefault(page, "underline"))
    .toBe(true);

  await page.reload();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expect(underlineButton).toHaveAttribute("aria-pressed", "true");

  await page.evaluate(() => {
    const savedData = JSON.parse(
      window.localStorage.getItem("note-formatting-test-data") ?? "{}",
    );

    savedData.sessionState = {
      ...savedData.sessionState,
      textFormatDefaults: {
        underline: "invalid",
        bulletList: true,
        orderedList: true,
        fontFamily: "Comic Sans",
        fontSize: "100px",
      },
    };
    window.localStorage.setItem(
      "note-formatting-test-data",
      JSON.stringify(savedData),
    );
  });

  await page.reload();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expect(underlineButton).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Bullet list" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Ordered list" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("combobox", { name: "Font family" })).toHaveValue(
    "system-ui",
  );
  await expect(page.getByRole("combobox", { name: "Font size" })).toHaveValue(
    "18px",
  );
});

async function clickCanvas(page: Page, x: number, y: number) {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.click(bounds.x + x, bounds.y + y);
}

async function createTextbox(page: Page, text: string, x: number, y: number) {
  const blockIndex = await page.locator(".text-block").count();

  await clickCanvas(page, x, y);
  await page.keyboard.press("x");

  const block = page.locator(".text-block").nth(blockIndex);
  const editor = block.locator(".text-block-editor-content");

  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text);

  return { block, editor };
}

function getDocumentSelection(editor: Locator) {
  return editor.evaluate(() => window.getSelection()?.toString() ?? "");
}

function getInlineTextStyle(editor: Locator) {
  return editor.evaluate((element) => {
    const styledText = element.querySelector<HTMLElement>("span[style]");

    return {
      fontFamily: styledText?.style.fontFamily ?? "",
      fontSize: styledText?.style.fontSize ?? "",
    };
  });
}

async function installPersistentTauriMock(page: Page) {
  await page.addInitScript(() => {
    const storageKey = "note-formatting-test-data";
    const initialData = {
      folders: [{ id: "folder-1", name: "Notes" }],
      pages: [
        {
          id: "page-1",
          folderId: "folder-1",
          title: "Persisted formatting",
        },
      ],
      blocks: [],
      isDarkMode: true,
      sessionState: {
        selectedFolderId: "folder-1",
        selectedPageId: "page-1",
        openPageTabIds: ["page-1"],
      },
    };
    const tauriWindow = window as typeof window & {
      __TAURI_INTERNALS__?: {
        invoke?: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };

    tauriWindow.__TAURI_INTERNALS__ = {
      ...tauriWindow.__TAURI_INTERNALS__,
      invoke: async (command, args) => {
        if (command === "load_app_data") {
          return JSON.parse(
            window.localStorage.getItem(storageKey) ??
              JSON.stringify(initialData),
          );
        }

        if (command === "save_app_data") {
          window.localStorage.setItem(storageKey, JSON.stringify(args?.data));
        }

        return undefined;
      },
    };
  });
}

function getSavedTextFormatDefault(page: Page, key: string) {
  return page.evaluate((formatKey) => {
    const savedData = JSON.parse(
      window.localStorage.getItem("note-formatting-test-data") ?? "{}",
    );

    return savedData.sessionState?.textFormatDefaults?.[formatKey];
  }, key);
}
