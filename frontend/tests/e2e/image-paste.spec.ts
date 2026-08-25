import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("pasting a clipboard image on the canvas creates an image block", async ({ page }) => {
  await clickCanvas(page, 360, 260);
  await pastePngFile(page);

  await expect(page.locator(".text-block-image")).toHaveCount(1);
  await expect(page.locator('.text-block-image[alt="clipboard-image.png"]')).toBeVisible();
});

test("pressing Ctrl+V with a clipboard image creates an image block", async ({
  context,
  page,
}) => {
  await clickCanvas(page, 360, 260);
  await writePngToClipboard(context, page);
  await page.keyboard.press("Control+V");

  await expect(page.locator(".text-block-image")).toHaveCount(1);
  await expect(page.getByRole("img", { name: "image.png" })).toBeVisible();
});

test("a selected standalone image can be resized with its corner handle", async ({ page }) => {
  await clickCanvas(page, 360, 260);
  await pastePngFile(page);

  const imageBlock = page.locator(".text-block", { has: page.locator(".text-block-image") });
  const handle = page.getByRole("slider", { name: "Resize image" });
  await expect(handle).toBeVisible();
  const before = await imageBlock.boundingBox();
  const handleBounds = await handle.boundingBox();
  if (!before || !handleBounds) throw new Error("Image resize geometry was unavailable.");

  await page.mouse.move(handleBounds.x + 5, handleBounds.y + 5);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x + 85, handleBounds.y + 5);
  await page.mouse.up();

  await expect.poll(async () => (await imageBlock.boundingBox())?.width).toBeGreaterThan(before.width + 60);
});

test("standalone images support keyboard selection, movement, and proportional resizing", async ({ page }) => {
  await clickCanvas(page, 360, 260);
  await pastePngFile(page);

  const imageControl = page.getByRole("button", { name: /select and move image clipboard-image\.png/i });
  await expect(imageControl).toHaveAttribute("aria-pressed", "true");
  const beforePosition = await imageControl.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));

  await imageControl.press("ArrowRight");
  await imageControl.press("Shift+ArrowDown");
  await expect.poll(async () => imageControl.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }))).toEqual({ x: beforePosition.x + 1, y: beforePosition.y + 10 });

  const handle = page.getByRole("slider", { name: "Resize image" });
  const beforeWidth = Number(await handle.getAttribute("aria-valuenow"));
  await handle.press("ArrowRight");
  await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(beforeWidth);
  await expect(handle).toBeFocused();
});

test("image resizing uses world-space deltas when zoomed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await clickCanvas(page, 360, 260);
  await pastePngFile(page);

  const canvas = page.getByRole("tabpanel");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas geometry was unavailable.");
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.8, canvasBounds.y + canvasBounds.height * 0.2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(page.locator(".zoom-indicator")).toHaveText("110%");
  const zoom = await page.locator(".canvas-content").evaluate((element) => {
    const match = (element as HTMLElement).style.transform.match(/scale\(([^)]+)\)/);
    return match ? Number(match[1]) : 1;
  });
  expect(zoom).toBeGreaterThan(1);

  const imageBlock = page.locator(".text-block", { has: page.locator(".text-block-image") });
  const handle = page.getByRole("slider", { name: "Resize image" });
  const beforeWidth = Number.parseFloat(await imageBlock.evaluate((element) => (element as HTMLElement).style.width));
  const handleBounds = await handle.boundingBox();
  if (!handleBounds) throw new Error("Image resize geometry was unavailable.");

  await page.mouse.move(handleBounds.x + 8, handleBounds.y + 8);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x + 88, handleBounds.y + 8);
  await page.mouse.up();

  await expect.poll(async () => Number.parseFloat(await imageBlock.evaluate((element) => (element as HTMLElement).style.width))).toBeCloseTo(beforeWidth + 80 / zoom, 0);
});

test("pasting a clipboard image while editing a textbox inserts a rich image", async ({ page }) => {
  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await doubleClickCanvas(page, 360, 260);
  await page.keyboard.type("hello");
  await expect(page.locator(".text-block-editor-content")).toBeVisible();

  await pastePngFile(page, true);

  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await expect(
    page.locator('.text-block-editor .ProseMirror img[alt="clipboard-image.png"]'),
  ).toBeVisible();
});

test("pressing Ctrl+V with a clipboard image while editing a textbox inserts a rich image", async ({
  context,
  page,
}) => {
  await page.getByRole("button", { name: "Text (T / 8)" }).click();
  await doubleClickCanvas(page, 360, 260);
  await page.keyboard.type("hello");
  await expect(page.locator(".text-block-editor-content")).toBeVisible();

  await writePngToClipboard(context, page);
  await page.keyboard.press("Control+V");

  await expect(page.locator(".text-block-image")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "image.png" })).toBeVisible();
});

async function clickCanvas(page: Page, x: number, y: number) {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.click(bounds.x + x, bounds.y + y);
}

async function doubleClickCanvas(page: Page, x: number, y: number) {
  const canvas = page.getByRole("tabpanel");
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Canvas bounds were not available.");
  }

  await page.mouse.dblclick(bounds.x + x, bounds.y + y);
}

async function pastePngFile(page: Page, dispatchFromActiveElement = false) {
  await page.evaluate(
    ({ dataUrl, dispatchFromActiveElement }) => {
      const base64 = dataUrl.split(",")[1];
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      const file = new File([bytes], "clipboard-image.png", {
        type: "image/png",
      });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      });
      const target =
        dispatchFromActiveElement && document.activeElement
          ? document.activeElement
          : document;

      target.dispatchEvent(pasteEvent);
    },
    { dataUrl: PNG_DATA_URL, dispatchFromActiveElement },
  );
}

async function writePngToClipboard(context: BrowserContext, page: Page) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Canvas context was not available.");
    }

    context.fillStyle = "#ff0066";
    context.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
          return;
        }

        reject(new Error("Failed to create PNG blob."));
      }, "image/png");
    });

    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": blob,
      }),
    ]);
  });
}
