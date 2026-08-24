import { expect, test, type Locator, type Page } from "@playwright/test";

type SlashCommandCase = {
  label: string;
  optionName: RegExp;
  query: string;
  topLevelTags: string[];
};

const SLASH_COMMANDS: SlashCommandCase[] = [
  {
    label: "Text",
    optionName: /^Text\b/i,
    query: "text",
    topLevelTags: ["P"],
  },
  {
    label: "Heading 1",
    optionName: /^Heading 1\b/i,
    query: "h1",
    topLevelTags: ["H1", "P"],
  },
  {
    label: "Heading 2",
    optionName: /^Heading 2\b/i,
    query: "h2",
    topLevelTags: ["H2", "P"],
  },
  {
    label: "Heading 3",
    optionName: /^Heading 3\b/i,
    query: "h3",
    topLevelTags: ["H3", "P"],
  },
  {
    label: "Bulleted list",
    optionName: /^Bulleted list\b/i,
    query: "bullet",
    topLevelTags: ["UL", "P"],
  },
  {
    label: "Numbered list",
    optionName: /^(?:Numbered|Ordered) list\b/i,
    query: "number",
    topLevelTags: ["OL", "P"],
  },
  {
    label: "Quote",
    optionName: /^Quote\b/i,
    query: "quote",
    topLevelTags: ["BLOCKQUOTE", "P"],
  },
  {
    label: "Code block",
    optionName: /^Code block\b/i,
    query: "code",
    topLevelTags: ["PRE", "P"],
  },
  {
    label: "Divider",
    optionName: /^Divider\b/i,
    query: "divider",
    topLevelTags: ["HR", "P"],
  },
];

test("slash triggers only at supported boundaries", async ({ page }) => {
  await openInitialNote(page);

  await clickCanvas(page, 280, 150);
  await page.keyboard.type("/");
  await expect(slashMenu(page)).toBeVisible();
  await expect(slashMenu(page).getByRole("option")).toHaveCount(9);
  await page.keyboard.press("Escape");

  const ordinaryCharacterEditor = await createEditorAt(
    page,
    280,
    300,
    "ordinary/",
  );
  await expect(ordinaryCharacterEditor).toHaveText("ordinary/");
  await expect(slashMenu(page)).toHaveCount(0);

  const whitespaceEditor = await createEditorAt(
    page,
    600,
    150,
    "ordinary /",
  );
  await expect(whitespaceEditor).toHaveText("ordinary /");
  await expect(slashMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");

  const lineStartEditor = await createEditorAt(page, 600, 300, "first line");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(lineStartEditor.locator(":scope > p")).toHaveCount(2);
  await expect(slashMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");

  const headingEditor = await createEditorAt(page, 280, 460, "");
  await page.keyboard.type("# Heading /");
  await expect(headingEditor.locator(":scope > h1")).toHaveCount(1);
  await expect(slashMenu(page)).toBeVisible();
});

test("canvas find does not steal focus from text editing or close slash commands", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInitialNote(page);
  await clickCanvas(page, 280, 150);
  await page.keyboard.type("/");

  const editor = page.locator(".text-block-editor-content").last();
  await expect(editor).toBeFocused();
  await expect(slashMenu(page)).toBeVisible();
  await page.keyboard.press("Control+f");
  await expect(editor).toBeFocused();
  await expect(slashMenu(page)).toBeVisible();
  await expect(page.locator(".search-panel")).toHaveCount(0);
});

test("canvas find shortcut remains available from non-text canvas controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInitialNote(page);
  await page.getByRole("textbox", { name: "Page title" }).press("Escape");
  const selectTool = page.getByRole("button", { name: /Select \(V/ });
  await selectTool.focus();
  await expect(selectTool).toBeFocused();
  await page.keyboard.press("Control+f");
  await expect(page.getByRole("textbox", { name: "Find in canvas" })).toBeFocused();
});

test("canvas find does not steal focus from a text input", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInitialNote(page);
  await page.getByRole("button", { name: "Search files" }).click();
  const fileSearch = page.getByRole("searchbox", { name: "Search files and notes" });
  await fileSearch.fill("draft");
  await fileSearch.press("Control+f");
  await expect(fileSearch).toBeFocused();
  await expect(fileSearch).toHaveValue("draft");
  await expect(page.locator(".search-panel")).toHaveCount(0);
});

test("slash stays literal in links, inline code, code blocks, lists, and quotes", async ({
  page,
}) => {
  await openInitialNote(page);

  const urlEditor = await createEditorAt(
    page,
    260,
    120,
    "https://example.com/",
  );
  await expect(urlEditor).toHaveText("https://example.com/");
  await expect(slashMenu(page)).toHaveCount(0);

  const inlineCodeEditor = await createEditorAt(page, 590, 120, "");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.keyboard.type("/");
  await expect(inlineCodeEditor).toHaveText("/");
  await expect(inlineCodeEditor.locator("code")).toHaveCount(1);
  await expect(slashMenu(page)).toHaveCount(0);

  const codeBlockEditor = await createEditorAt(page, 260, 280, "");
  await page.keyboard.type("``` ");
  await expect(codeBlockEditor.locator(":scope > pre")).toHaveCount(1);
  await page.keyboard.type("/");
  await expect(slashMenu(page)).toHaveCount(0);

  const listEditor = await createEditorAt(page, 590, 280, "");
  await page.keyboard.type("- ");
  await expect(listEditor.locator(":scope > ul")).toHaveCount(1);
  await page.keyboard.type("/");
  await expect(slashMenu(page)).toHaveCount(0);

  const quoteEditor = await createEditorAt(page, 260, 440, "");
  await page.keyboard.type("> ");
  await expect(quoteEditor.locator(":scope > blockquote")).toHaveCount(1);
  await page.keyboard.type("/");
  await expect(slashMenu(page)).toHaveCount(0);
});

test("menu exposes grouped listbox semantics and filters by aliases", async ({
  page,
}) => {
  await openInitialNote(page);
  const editor = await openSlashMenu(page, 320, 220);
  const menu = slashMenu(page);
  const options = menu.getByRole("option");

  await expect(menu).toHaveAccessibleName(/slash commands/i);
  await expect(options).toHaveCount(9);
  await expect(menu).toHaveAttribute("data-has-more-below", "true");
  const selectedOption = menu.locator('[role="option"][aria-selected="true"]');
  await expect(selectedOption).toHaveCount(1);

  const menuId = await menu.getAttribute("id");
  const selectedOptionId = await selectedOption.getAttribute("id");

  expect(menuId).toBeTruthy();
  expect(selectedOptionId).toBeTruthy();
  await expect(editor).toHaveAttribute("aria-controls", menuId ?? "");
  await expect(editor).toHaveAttribute("aria-expanded", "true");
  await expect(editor).toHaveAttribute("aria-autocomplete", "list");
  await expect(editor).toHaveAttribute("aria-haspopup", "listbox");
  await expect(editor).toHaveAttribute("role", "combobox");
  await expect(editor).not.toHaveAttribute("aria-multiline", "true");
  await expect(page.getByRole("combobox", { name: "Text block" })).toBeFocused();
  await expect(editor).toHaveAttribute(
    "aria-activedescendant",
    selectedOptionId ?? "",
  );

  const groups = menu.getByRole("group");
  const groupCount = await groups.count();
  expect(groupCount).toBe(3);

  for (const groupName of ["Text", "Lists", "Blocks"]) {
    await expect(menu.getByRole("group", { name: groupName })).toBeVisible();
  }

  for (let index = 0; index < groupCount; index += 1) {
    await expect(groups.nth(index)).toHaveAccessibleName(/\S/);
  }

  const optionIds = await options.evaluateAll((elements) =>
    elements.map((element) => element.id),
  );
  expect(optionIds).toHaveLength(9);
  expect(optionIds.every(Boolean)).toBe(true);
  expect(new Set(optionIds).size).toBe(9);

  await menu.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(menu).not.toHaveAttribute("data-has-more-below", "true");
  await menu.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });

  await page.keyboard.type("hr");
  await expect(editor).toHaveText("/hr");
  await expect(menu.getByRole("option").first()).toHaveAccessibleName(
    /^Divider\b/i,
  );
  await expect(
    menu.getByRole("option", { name: /^Divider\b/i }),
  ).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/heading one");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option").first()).toHaveAccessibleName(
    /^Heading 1\b/i,
  );

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/ol");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(
    menu.getByRole("option", { name: /^(?:Numbered|Ordered) list\b/i }),
  ).toBeVisible();
  await expect(editor).toBeFocused();

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/ippet");
  await expect(menu.getByRole("option").first()).toHaveAccessibleName(
    /^Code block\b/i,
  );
});

test("keyboard navigation selects commands and supports Enter, Escape, and Tab", async ({
  page,
}) => {
  await openInitialNote(page);
  const editor = await openSlashMenu(page, 280, 160);
  const menu = slashMenu(page);
  const options = menu.getByRole("option");

  await expectSelectedOption(options, 0);
  await page.keyboard.press("ArrowUp");
  await expectSelectedOption(options, 8);
  await page.keyboard.press("ArrowDown");
  await expectSelectedOption(options, 0);
  await page.keyboard.press("ArrowDown");
  await expectSelectedOption(options, 1);
  await page.keyboard.press("ArrowUp");
  await expectSelectedOption(options, 0);
  await page.keyboard.press("End");
  await expectSelectedOption(options, 8);
  await page.keyboard.press("Home");
  await expectSelectedOption(options, 0);
  await page.keyboard.press("Enter");

  await expect(menu).toHaveCount(0);
  expect(await topLevelTags(editor)).toEqual(["P"]);
  await expect(editor).toHaveText("");

  const escapedEditor = await openSlashMenu(page, 280, 330);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(escapedEditor).toHaveText("/");
  await expect(escapedEditor).toBeFocused();
  await expect(escapedEditor).toHaveAttribute("role", "textbox");
  await expect(escapedEditor).toHaveAttribute("aria-multiline", "true");
  for (const attribute of [
    "aria-activedescendant",
    "aria-autocomplete",
    "aria-controls",
    "aria-expanded",
    "aria-haspopup",
  ]) {
    await expect(escapedEditor).not.toHaveAttribute(attribute, /.+/);
  }

  const tabEditor = await openSlashMenu(page, 600, 160, "h2");
  const tabBlock = page.locator(".text-block").last();
  await expect(menu.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(tabEditor).toHaveCount(0);
  await expect(tabBlock.locator(".text-block-display")).toHaveText("/h2");
  await expect(tabBlock.locator("h2")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      document.activeElement?.classList.contains("text-block-editor-content"),
    ),
  ).toBe(false);
});

test("keyboard navigation scrolls only the menu and ignores a stationary pointer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await openInitialNote(page);
  await page.addStyleTag({
    content: `
      html, body, #root { min-height: 1800px; }
      .slash-command-popup { max-height: 160px !important; }
    `,
  });
  const editor = await openSlashMenu(page, 280, 160);
  const menu = slashMenu(page);
  const options = menu.getByRole("option");

  await options.first().hover();
  await expectSelectedOption(options, 0);
  await page.evaluate(() => window.scrollTo(0, 240));
  const outerScrollTop = await page.evaluate(() => window.scrollY);
  expect(outerScrollTop).toBeGreaterThan(0);

  await page.keyboard.press("ArrowUp");
  await expectSelectedOption(options, 8);
  await expect
    .poll(() => menu.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(outerScrollTop);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute(
    "aria-activedescendant",
    (await options.nth(8).getAttribute("id")) ?? "",
  );

  await menu.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(menu).not.toHaveAttribute("data-has-more-below", "true");
  await page.keyboard.press("ArrowDown");
  await expectSelectedOption(options, 0);
  await expect(menu).toHaveAttribute("data-has-more-below", "true");
  expect(await page.evaluate(() => window.scrollY)).toBe(outerScrollTop);
  await page.keyboard.press("ArrowDown");
  await expectSelectedOption(options, 1);
  await page.keyboard.press("ArrowUp");
  await expectSelectedOption(options, 0);

  await options.nth(2).hover();
  await expectSelectedOption(options, 2);
  await expect(editor).toBeFocused();
});

test("composition, pointer hover, backspace, and outside clicks dismiss safely", async ({
  page,
}) => {
  await openInitialNote(page);
  const editor = await openSlashMenu(page, 320, 220);
  const menu = slashMenu(page);
  const options = menu.getByRole("option");

  for (const key of ["ArrowDown", "Enter", "Escape"]) {
    await editor.dispatchEvent("keydown", {
      bubbles: true,
      isComposing: true,
      key,
    });
    await expect(menu).toBeVisible();
    await expectSelectedOption(options, 0);
  }

  const quoteOption = menu.getByRole("option", { name: /^Quote\b/i });
  await quoteOption.hover();
  await expect(quoteOption).toHaveAttribute("aria-selected", "true");
  await expect(editor).toHaveAttribute(
    "aria-activedescendant",
    (await quoteOption.getAttribute("id")) ?? "",
  );
  await expect(editor).toBeFocused();

  await page.keyboard.press("ArrowDown");
  const codeOption = menu.getByRole("option", { name: /^Code block\b/i });

  await expect(quoteOption).toHaveAttribute("aria-selected", "false");
  await expect(codeOption).toHaveAttribute("aria-selected", "true");
  await expect(quoteOption).toHaveCSS("box-shadow", "none");
  await expect(codeOption).not.toHaveCSS("box-shadow", "none");
  await page.keyboard.press("ArrowUp");
  await expect(quoteOption).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Backspace");
  await expect(menu).toHaveCount(0);
  await expect(editor).toHaveText("");
  await expect(editor).not.toHaveAttribute("aria-controls", /slash-command/);
  await expect(editor).not.toHaveAttribute("aria-expanded", "true");

  await page.keyboard.type("/");
  await expect(menu).toBeVisible();
  await clickCanvas(page, 800, 500);
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".slash-command-popup")).toHaveCount(0);
});

test("destroying one editor cleans its popup before another editor opens", async ({
  page,
}) => {
  await openInitialNote(page);
  await openSlashMenu(page, 300, 180);
  const firstBlockId = await page
    .locator(".text-block")
    .last()
    .getAttribute("data-block-id");
  const firstMenuId = await slashMenu(page).getAttribute("id");

  expect(firstBlockId).toBeTruthy();
  expect(firstMenuId).toBeTruthy();
  await openSlashMenu(page, 650, 320);

  const secondMenu = slashMenu(page);
  const secondMenuId = await secondMenu.getAttribute("id");
  const firstBlock = page.locator(
    `.text-block[data-block-id="${firstBlockId ?? ""}"]`,
  );

  await expect(secondMenu).toHaveCount(1);
  expect(secondMenuId).toBeTruthy();
  expect(secondMenuId).not.toBe(firstMenuId);
  await expect(firstBlock.locator(".text-block-display")).toHaveText("/");
  await expect(firstBlock.locator("[aria-controls]")).toHaveCount(0);
});

test("pointer selection executes all nine commands and removes the query", async ({
  browser,
}) => {
  for (const command of SLASH_COMMANDS) {
    await test.step(command.label, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await openInitialNote(page);
        const editor = await openSlashMenu(page, 320, 220, command.query);
        const menu = slashMenu(page);
        const option = menu.getByRole("option", { name: command.optionName });

        await expect(option).toBeVisible();
        await option.click();

        await expect(menu).toHaveCount(0);
        expect(await topLevelTags(editor)).toEqual(command.topLevelTags);
        await expect(editor).not.toContainText(`/${command.query}`);
        await expect(editor).not.toContainText("/");
      } finally {
        await context.close();
      }
    });
  }
});

test("empty filtering keeps the query intact and reports no results", async ({
  page,
}) => {
  await openInitialNote(page);
  const editor = await openSlashMenu(page, 320, 220, "zzzz-not-a-command");
  const menu = slashMenu(page);

  await expect(menu).toBeVisible();
  const emptyOption = menu.getByRole("option", { name: /no commands found/i });

  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(emptyOption).toHaveAttribute("aria-disabled", "true");
  await expect(emptyOption).toBeVisible();
  await expect(editor).toHaveText("/zzzz-not-a-command");
});

test("commands insert after existing text, replace slash-only blocks, and preserve suffixes", async ({
  page,
}) => {
  await openInitialNote(page);
  const existingTextEditor = await createEditorAt(
    page,
    300,
    180,
    "Existing text ",
  );

  await page.keyboard.type("/h2");
  await slashMenu(page).getByRole("option", { name: /^Heading 2\b/i }).click();

  expect(await topLevelTags(existingTextEditor)).toEqual(["P", "H2", "P"]);
  await expect(existingTextEditor.locator(":scope > p").first()).toHaveText(
    "Existing text",
  );
  await expect(existingTextEditor).not.toContainText("/h2");
  await expect(page.locator(".text-block")).toHaveCount(1);

  const suffixEditor = await createEditorAt(page, 650, 180, "suffix stays");
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("/h2");
  await slashMenu(page).getByRole("option", { name: /^Heading 2\b/i }).click();

  expect(await topLevelTags(suffixEditor)).toEqual(["H2", "P"]);
  await expect(suffixEditor.locator(":scope > h2")).toHaveText("");
  await expect(suffixEditor.locator(":scope > p")).toHaveText("suffix stays");
  await expect(suffixEditor).not.toContainText("/h2");
});

test("command execution is a single TipTap undo step", async ({ page }) => {
  await openInitialNote(page);
  const editor = await createEditorAt(page, 320, 220, "Existing text ");

  await page.keyboard.type("/h2");
  await slashMenu(page).getByRole("option", { name: /^Heading 2\b/i }).click();
  expect(await topLevelTags(editor)).toEqual(["P", "H2", "P"]);

  await page.keyboard.press("Control+z");
  expect(await topLevelTags(editor)).toEqual(["P"]);
  await expect(editor).toHaveText("Existing text /h2");
});

test("divider places the caret in a following paragraph and persists after blur", async ({
  page,
}) => {
  await openInitialNote(page);
  const editor = await openSlashMenu(page, 320, 220, "hr");
  const block = page.locator(".text-block").last();

  await slashMenu(page).getByRole("option", { name: /^Divider\b/i }).click();
  expect(await topLevelTags(editor)).toEqual(["HR", "P"]);
  await expect(editor).toBeFocused();

  await clickCanvas(page, 800, 520);
  const display = block.locator(".text-block-display");
  await expect(display).toBeVisible();
  await expect(display.locator("hr")).toHaveCount(1);

  await display.locator("p").dblclick();
  const reopenedDividerOnlyEditor = block.locator(".text-block-editor-content");
  await expect(reopenedDividerOnlyEditor).toBeVisible();
  await expect(reopenedDividerOnlyEditor).toBeFocused();
  await expect(reopenedDividerOnlyEditor.locator("hr")).toHaveCount(1);
  await page.keyboard.type("After divider");
  await expect(reopenedDividerOnlyEditor.locator(":scope > p")).toHaveText(
    "After divider",
  );

  await clickCanvas(page, 800, 520);
  await expect(display.locator("hr")).toHaveCount(1);
  await expect(display.locator("p")).toHaveText("After divider");

  await display.locator("p").dblclick();
  const reopenedEditor = block.locator(".text-block-editor-content");
  await expect(reopenedEditor).toBeVisible();
  await expect(reopenedEditor.locator("hr")).toHaveCount(1);
  await expect(reopenedEditor.locator("p")).toHaveText("After divider");
});

test("StarterKit markdown shortcuts remain active for writing blocks", async ({
  browser,
}) => {
  const shortcuts = [
    { input: "# ", tag: "H1", text: "Heading" },
    { input: "- ", tag: "UL", text: "Bullet" },
    { input: "1. ", tag: "OL", text: "Numbered" },
    { input: "> ", tag: "BLOCKQUOTE", text: "Quote" },
    { input: "``` ", tag: "PRE", text: "Code" },
    { input: "---", tag: "HR", text: "After divider" },
  ];

  for (const shortcut of shortcuts) {
    await test.step(shortcut.tag, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await openInitialNote(page);
        const editor = await createEditorAt(page, 320, 220, "");
        await page.keyboard.type(shortcut.input);
        await expect(editor.locator(`:scope > ${shortcut.tag.toLowerCase()}`)).toHaveCount(1);
        await page.keyboard.type(shortcut.text);
        await expect(editor).toContainText(shortcut.text);
      } finally {
        await context.close();
      }
    });
  }
});

test("heading hierarchy is exact in editors, renderers, and autosize measurers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInitialNote(page);
  const expectedMetrics = [
    { fontSize: "30px", lineHeight: "36px" },
    { fontSize: "24px", lineHeight: "30px" },
    { fontSize: "20px", lineHeight: "26px" },
  ];
  const headingBlocks: Locator[] = [];

  for (const level of [1, 2, 3]) {
    const editor = await createEditorAt(page, 300, 100 + level * 170, "");
    const block = page.locator(".text-block").last();
    const headingText = `Markdown heading ${level}`;

    await page.keyboard.type(`${"#".repeat(level)} `);
    await page.keyboard.type(headingText);

    const heading = editor.locator(`:scope > h${level}`);
    await expect(heading).toHaveText(headingText);
    await expect(heading).toHaveCSS(
      "font-size",
      expectedMetrics[level - 1].fontSize,
    );
    await expect(heading).toHaveCSS(
      "line-height",
      expectedMetrics[level - 1].lineHeight,
    );
    await expect(block.locator(`.text-block-height-measurer h${level}`)).toHaveCSS(
      "font-size",
      expectedMetrics[level - 1].fontSize,
    );
    await expect
      .poll(() =>
        block.evaluate((element) =>
          Number.parseFloat((element as HTMLElement).style.height),
        ),
      )
      .toBeGreaterThanOrEqual(
        Number.parseFloat(expectedMetrics[level - 1].lineHeight),
      );
    const blockId = await block.getAttribute("data-block-id");

    expect(blockId).toBeTruthy();
    headingBlocks.push(
      page.locator(`.text-block[data-block-id="${blockId ?? ""}"]`),
    );
  }

  await clickCanvas(page, 850, 650);

  for (const [index, block] of headingBlocks.entries()) {
    await expect(block.locator(`.text-block-display h${index + 1}`)).toHaveCSS(
      "font-size",
      expectedMetrics[index].fontSize,
    );
  }
});

test("slash-created headings clear inherited inline font sizes", async ({
  page,
}) => {
  await openInitialNote(page);
  const editor = await createEditorAt(page, 320, 220, "");
  const block = page.locator(".text-block").last();

  await page.getByRole("combobox", { name: "Font size" }).selectOption("32px");
  await page.keyboard.type("/h1");
  await slashMenu(page).getByRole("option", { name: /^Heading 1\b/i }).click();
  await page.keyboard.type("Slash heading");

  const heading = editor.locator(":scope > h1");
  await expect(heading).toHaveCSS("font-size", "30px");
  await expect(heading).toHaveCSS("line-height", "36px");
  await expect(block.locator(".text-block-height-measurer h1")).toHaveCSS(
    "font-size",
    "30px",
  );

  await clickCanvas(page, 800, 520);
  await expect(block.locator(".text-block-display h1")).toHaveCSS(
    "font-size",
    "30px",
  );
});

test("menu stays viewport-bound and screen-sized across canvas zoom", async ({
  page,
}) => {
  const viewport = { width: 720, height: 520 };
  await page.setViewportSize(viewport);
  await openInitialNote(page);

  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();

  if (!canvasBounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.click(
    canvasBounds.x + canvasBounds.width - 60,
    canvasBounds.y + canvasBounds.height - 80,
  );
  await page.keyboard.type("/");
  await expect(slashMenu(page)).toBeVisible();
  const popup = page.locator(".slash-command-popup");
  const widthAt100 = (await popup.boundingBox())?.width ?? 0;

  expect(widthAt100).toBeGreaterThan(300);
  expect(await popup.evaluate((element) => element.parentElement === document.body)).toBe(true);
  await expect.poll(() => getCaretPopupGap(page)).toBeGreaterThanOrEqual(7);
  await expect.poll(() => getCaretPopupGap(page)).toBeLessThanOrEqual(9);
  await page.keyboard.press("Backspace");

  await page.mouse.move(
    canvasBounds.x + canvasBounds.width / 2,
    canvasBounds.y + canvasBounds.height / 2,
  );
  await page.keyboard.down("Control");
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.wheel(0, 100);
  }
  await page.keyboard.up("Control");
  await expect(page.locator(".zoom-indicator")).toHaveText("50%");
  await page.keyboard.type("/");
  await expect(slashMenu(page)).toBeVisible();
  const widthAt50 = (await popup.boundingBox())?.width ?? 0;

  expect(Math.abs(widthAt50 - widthAt100)).toBeLessThanOrEqual(1);
  await expect.poll(() => getCaretPopupGap(page)).toBeGreaterThanOrEqual(7);
  await expect.poll(() => getCaretPopupGap(page)).toBeLessThanOrEqual(9);
  await page.keyboard.press("Backspace");

  await page.keyboard.down("Control");
  for (let step = 0; step < 16; step += 1) {
    await page.mouse.wheel(0, -100);
  }
  await page.keyboard.up("Control");
  await expect(page.locator(".zoom-indicator")).toHaveText("200%");
  await page.keyboard.type("/");

  await expect(slashMenu(page)).toBeVisible();
  await expect(popup).toBeVisible();
  const widthAt200 = (await popup.boundingBox())?.width ?? 0;

  expect(Math.abs(widthAt200 - widthAt100)).toBeLessThanOrEqual(1);
  await expect
    .poll(() => isContainedInViewport(popup, viewport))
    .toBe(true);
  const menuBounds = await popup.boundingBox();

  expect(menuBounds).not.toBeNull();
  expect(menuBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(menuBounds?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((menuBounds?.x ?? 0) + (menuBounds?.width ?? 0)).toBeLessThanOrEqual(
    viewport.width + 1,
  );
  expect((menuBounds?.y ?? 0) + (menuBounds?.height ?? 0)).toBeLessThanOrEqual(
    viewport.height + 1,
  );
});

test("menu clamps to a phone-width viewport without clipping its footer", async ({
  page,
}) => {
  const viewport = { width: 320, height: 480 };
  await page.setViewportSize(viewport);
  await openInitialNote(page);
  await clickCanvas(page, 150, 190);
  await page.keyboard.type("/");

  const popup = page.locator(".slash-command-popup");
  const footer = popup.locator(".slash-command-footer");

  await expect(popup).toBeVisible();
  await expect(popup).toHaveCSS("width", "304px");
  await expect(footer).toBeVisible();
  await expect
    .poll(() => isContainedInViewport(popup, viewport))
    .toBe(true);
  await expect
    .poll(() =>
      popup.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
});

test("menu copy reflows without truncation at 200% text size", async ({
  page,
}) => {
  const viewport = { width: 320, height: 480 };
  await page.setViewportSize(viewport);
  await openInitialNote(page);
  await page.addStyleTag({
    content: `
      .slash-command-label { font-size: 28px !important; line-height: 38px !important; }
      .slash-command-description { font-size: 24px !important; line-height: 34px !important; }
    `,
  });
  await clickCanvas(page, 150, 190);
  await page.keyboard.type("/");

  const popup = page.locator(".slash-command-popup");
  const firstOption = popup.getByRole("option").first();

  await expect(popup).toBeVisible();
  await expect(firstOption.locator(".slash-command-label")).toHaveCSS(
    "white-space",
    "normal",
  );
  await expect(firstOption.locator(".slash-command-description")).toHaveText(
    "Continue with plain text",
  );
  await expect
    .poll(() =>
      popup.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await expect
    .poll(() =>
      firstOption.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await expect
    .poll(() => isContainedInViewport(popup, viewport))
    .toBe(true);
});

test("menu follows light and dark themes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openInitialNote(page);
  const themeToggle = page.getByRole("button", { name: "Dark mode" });
  const initiallyDark = (await themeToggle.getAttribute("aria-pressed")) === "true";

  await openSlashMenu(page, 320, 220);
  const popup = page.locator(".slash-command-popup");
  const initialBackground = await popup.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  await expect(popup.getByRole("option").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  if (initiallyDark) {
    await expect(popup).toHaveClass(/is-dark/);
  } else {
    await expect(popup).not.toHaveClass(/is-dark/);
    expect(initialBackground).toBe("rgb(255, 255, 255)");
  }
  await page.keyboard.press("Backspace");

  await themeToggle.click();
  await openSlashMenu(page, 620, 220);
  const toggledBackground = await popup.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  if (initiallyDark) {
    await expect(popup).not.toHaveClass(/is-dark/);
    expect(toggledBackground).toBe("rgb(255, 255, 255)");
  } else {
    await expect(popup).toHaveClass(/is-dark/);
  }
  expect(toggledBackground).not.toBe(initialBackground);
});

async function openInitialNote(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
}

async function clickCanvas(page: Page, x: number, y: number) {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.click(bounds.x + x, bounds.y + y);
}

async function createEditorAt(
  page: Page,
  x: number,
  y: number,
  initialText: string,
) {
  await clickCanvas(page, x, y);
  await page.keyboard.press("x");

  const editor = page.locator(".text-block-editor-content").last();
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+A");

  if (initialText) {
    await page.keyboard.insertText(initialText);
  } else {
    await page.keyboard.press("Backspace");
  }

  return editor;
}

async function openSlashMenu(
  page: Page,
  x: number,
  y: number,
  query = "",
) {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.dblclick(bounds.x + x, bounds.y + y);
  const editor = page.locator(".text-block-editor-content").last();
  await expect(editor).toBeFocused();
  await page.keyboard.type("/");
  await expect(slashMenu(page)).toBeVisible();

  if (query) {
    await page.keyboard.insertText(query);
  }

  return editor;
}

function slashMenu(page: Page) {
  return page.getByRole("listbox");
}

async function expectSelectedOption(options: Locator, index: number) {
  await expect(options.nth(index)).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      options.evaluateAll(
        (elements) =>
          elements.filter(
            (element) => element.getAttribute("aria-selected") === "true",
          ).length,
      ),
    )
    .toBe(1);
}

function topLevelTags(editor: Locator) {
  return editor.evaluate((element) =>
    Array.from(element.children, (child) => child.tagName),
  );
}

async function isContainedInViewport(
  locator: Locator,
  viewport: { height: number; width: number },
) {
  const bounds = await locator.boundingBox();

  return Boolean(
    bounds &&
      bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= viewport.width + 1 &&
      bounds.y + bounds.height <= viewport.height + 1,
  );
}

async function getCaretPopupGap(page: Page) {
  const triggerBounds = await page
    .locator(".text-block-editor-content .slash-command-trigger")
    .boundingBox();
  const popupBounds = await page.locator(".slash-command-popup").boundingBox();

  if (!triggerBounds || !popupBounds) {
    return -1;
  }

  const triggerBottom = triggerBounds.y + triggerBounds.height;
  const popupBottom = popupBounds.y + popupBounds.height;

  if (popupBottom <= triggerBounds.y) {
    return triggerBounds.y - popupBottom;
  }

  if (popupBounds.y >= triggerBottom) {
    return popupBounds.y - triggerBottom;
  }

  return -1;
}
