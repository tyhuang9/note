import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("keeps rough rectangle and diamond joins closed in previews and committed light/dark shapes", async ({ page }, testInfo) => {
  const canvas = page.getByRole("tabpanel");
  const bounds = await requiredBounds(canvas, "canvas");
  const cases = [
    { moves: 8, shape: "rectangle", size: { height: 140, width: 220 } },
    { moves: 12, shape: "diamond", size: { height: 110, width: 140 } },
  ] as const;

  for (const [themeIndex, theme] of (["light", "dark"] as const).entries()) {
    await setDarkMode(page, theme === "dark");
    for (const [shapeIndex, scenario] of cases.entries()) {
      await page.locator(`[data-tool="${scenario.shape}"]`).click();
      const start = {
        x: bounds.x + 360 + shapeIndex * 300,
        y: bounds.y + 190 + themeIndex * 230,
      };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + scenario.size.width, start.y + scenario.size.height, { steps: 8 });

      const preview = page.locator(".primitive-authoring-preview");
      await expect(preview).toBeVisible();
      const previewSnapshot = await roughOutlineSnapshot(preview);
      expect(previewSnapshot.moves).toBe(scenario.moves);
      expect(previewSnapshot.maxJoinGap).toBe(0);
      expect(previewSnapshot.closeGap).toBe(0);
      expect(previewSnapshot.minSegmentSpan).toBeGreaterThan(0);
      await testInfo.attach(`${scenario.shape}-${theme}-preview.png`, {
        body: await preview.screenshot(),
        contentType: "image/png",
      });

      await page.mouse.up();
      const committed = page.locator(`[data-canvas-element-id="${previewSnapshot.elementId}"] svg.primitive-shape`);
      await expect(committed).toBeVisible();
      const committedSnapshot = await roughOutlineSnapshot(committed);
      expect(committedSnapshot).toEqual(previewSnapshot);
      await testInfo.attach(`${scenario.shape}-${theme}-committed.png`, {
        body: await committed.screenshot(),
        contentType: "image/png",
      });
    }
  }
});

async function setDarkMode(page: Page, dark: boolean) {
  const toggle = page.getByRole("button", { name: "Dark mode" });
  const isDark = await toggle.getAttribute("aria-pressed") === "true";
  if (isDark !== dark) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(dark));
}

async function roughOutlineSnapshot(svg: Locator) {
  return svg.evaluate((node) => {
    const path = node.querySelector("path")?.getAttribute("d") ?? "";
    const tokens = path.match(/[MCL]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? [];
    let index = 0;
    let first: { x: number; y: number } | null = null;
    let previous: { x: number; y: number } | null = null;
    let segmentStart: { x: number; y: number } | null = null;
    let maxJoinGap = 0;
    let minSegmentSpan = Number.POSITIVE_INFINITY;
    let moves = 0;
    const number = () => Number(tokens[index++]);
    while (index < tokens.length) {
      const command = tokens[index++];
      if (command === "M") {
        const next = { x: number(), y: number() };
        if (!first) first = next;
        if (previous) maxJoinGap = Math.max(maxJoinGap, Math.hypot(next.x - previous.x, next.y - previous.y));
        previous = next;
        segmentStart = next;
        moves += 1;
        continue;
      }
      if (command === "L") {
        previous = { x: number(), y: number() };
      } else if (command === "C") {
        number();
        number();
        number();
        number();
        previous = { x: number(), y: number() };
      } else {
        throw new Error(`Unexpected generated path command ${command}`);
      }
      if (segmentStart && previous) {
        minSegmentSpan = Math.min(minSegmentSpan, Math.hypot(previous.x - segmentStart.x, previous.y - segmentStart.y));
      }
    }
    return {
      closeGap: first && previous ? Math.hypot(first.x - previous.x, first.y - previous.y) : Number.POSITIVE_INFINITY,
      elementId: node.getAttribute("data-element-id") ?? node.closest<HTMLElement>("[data-canvas-element-id]")?.dataset.canvasElementId ?? "",
      maxJoinGap,
      minSegmentSpan,
      moves,
      path,
      seed: node.getAttribute("data-seed"),
    };
  });
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}
