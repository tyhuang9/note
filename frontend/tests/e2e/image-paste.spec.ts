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

test("pasting a clipboard image while editing a textbox inserts a rich image", async ({ page }) => {
  await clickCanvas(page, 360, 260);
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
  await clickCanvas(page, 360, 260);
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
