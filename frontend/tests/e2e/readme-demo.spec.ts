import { expect, test, type Locator, type Page } from "@playwright/test";

const framesDirectory = "../docs/assets/demo-frames";
const frame = (number: number, label: string) =>
  `${framesDirectory}/${String(number).padStart(2, "0")}-${label}.png`;

type Point = readonly [number, number];

// Coordinates are expressed within the visible canvas so the sketch stays
// centered in the README capture regardless of the surrounding application UI.
const FACE_STROKES: readonly (readonly Point[])[] = [
  [
    [0.33, 0.77], [0.30, 0.66], [0.30, 0.52], [0.32, 0.39], [0.38, 0.30],
    [0.45, 0.22], [0.52, 0.19], [0.61, 0.18], [0.69, 0.22], [0.75, 0.29],
    [0.79, 0.39], [0.82, 0.51], [0.82, 0.64], [0.80, 0.74], [0.76, 0.81],
  ],
  [
    [0.37, 0.43], [0.39, 0.38], [0.43, 0.35], [0.48, 0.34], [0.52, 0.36],
    [0.54, 0.39], [0.53, 0.44], [0.50, 0.48], [0.46, 0.52], [0.42, 0.54],
    [0.39, 0.51], [0.37, 0.46], [0.37, 0.43],
  ],
  [
    [0.57, 0.41], [0.59, 0.35], [0.64, 0.29], [0.69, 0.27], [0.74, 0.29],
    [0.78, 0.34], [0.80, 0.40], [0.80, 0.47], [0.78, 0.52], [0.74, 0.55],
    [0.68, 0.55], [0.63, 0.53], [0.59, 0.49], [0.57, 0.45], [0.57, 0.41],
  ],
  [
    [0.426, 0.378], [0.441, 0.377], [0.444, 0.384], [0.431, 0.387], [0.444, 0.392],
    [0.427, 0.396], [0.438, 0.401], [0.424, 0.391], [0.442, 0.385], [0.431, 0.377],
    [0.427, 0.401], [0.445, 0.397], [0.437, 0.383], [0.425, 0.385], [0.441, 0.401],
  ],
  [
    [0.706, 0.318], [0.721, 0.317], [0.724, 0.324], [0.711, 0.327], [0.724, 0.332],
    [0.707, 0.336], [0.718, 0.341], [0.704, 0.331], [0.722, 0.325], [0.711, 0.317],
    [0.707, 0.341], [0.725, 0.337], [0.717, 0.323], [0.705, 0.325], [0.721, 0.341],
  ],
  [
    [0.56, 0.67], [0.57, 0.71], [0.60, 0.74], [0.64, 0.76], [0.69, 0.77],
    [0.74, 0.76],
  ],
];

test("captures the README Pen-tool face sketch walkthrough", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();

  const canvas = page.getByRole("tabpanel");
  await expect(canvas).toBeVisible();
  const title = page.getByRole("textbox", { name: "Page title" });
  await title.fill("A face takes shape");
  await title.press("Enter");
  const themeToggle = page.getByRole("button", { name: "Dark mode" });
  await themeToggle.click();
  await expect(themeToggle).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Pen (P / 7)" }).click();
  const toolLock = page.locator("[data-tool-lock]");
  await expect(toolLock).toHaveAccessibleName("Turn on drawing tool lock");
  await toolLock.click();
  await expect(toolLock).toHaveAccessibleName("Turn off drawing tool lock");
  await page.screenshot({ path: frame(1, "ready-to-draw") });

  const canvasBounds = await requiredBounds(canvas, "canvas");
  const ink = page.locator('[data-canvas-element-type="ink"]');

  await setPenStrokeWidth(page, "Thick");
  await drawStroke(page, canvasBounds, FACE_STROKES[0], [
    frame(2, "head-01"), frame(3, "head-02"), frame(4, "head-03"),
    frame(5, "head-04"), frame(6, "head-05"), frame(7, "head-06"),
    frame(8, "head-07"),
  ]);
  await expect(ink).toHaveCount(1);
  await clearSelectionAndRestorePen(page);

  await setPenStrokeWidth(page, "Medium");
  await drawStroke(page, canvasBounds, FACE_STROKES[1], [
    frame(9, "left-eye-01"), frame(10, "left-eye-02"), frame(11, "left-eye-03"),
  ]);
  await drawStroke(page, canvasBounds, FACE_STROKES[2], [
    frame(12, "right-eye-01"), frame(13, "right-eye-02"), frame(14, "right-eye-03"),
  ]);
  await expect(ink).toHaveCount(3);
  await clearSelectionAndRestorePen(page);

  await setPenStrokeWidth(page, "Thick");
  await drawStroke(page, canvasBounds, FACE_STROKES[3], [frame(15, "left-pupil")]);
  await drawStroke(page, canvasBounds, FACE_STROKES[4], [frame(16, "right-pupil")]);
  await expect(ink).toHaveCount(5);
  await clearSelectionAndRestorePen(page);

  await setPenStrokeWidth(page, "Medium");
  await drawStroke(page, canvasBounds, FACE_STROKES[5], [
    frame(17, "mouth-01"), frame(18, "mouth-02"),
  ]);
  await expect(ink).toHaveCount(FACE_STROKES.length);
  await clearSelectionAndRestorePen(page);
  await page.screenshot({ path: frame(19, "finished-face") });
});

async function drawStroke(
  page: Page,
  bounds: { x: number; y: number; width: number; height: number },
  points: readonly Point[],
  inProgressCaptures: readonly string[],
) {
  const [start, ...rest] = points.map(([x, y]) => ({
    x: bounds.x + bounds.width * x,
    y: bounds.y + bounds.height * y,
  }));

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const captureSteps = new Set(inProgressCaptures.map((_, index) =>
    Math.max(0, Math.round(((index + 1) * rest.length) / (inProgressCaptures.length + 1)) - 1),
  ));
  let captureIndex = 0;
  for (const [index, point] of rest.entries()) {
    await page.mouse.move(point.x, point.y, { steps: 8 });
    if (captureSteps.has(index)) {
      await page.screenshot({ path: inProgressCaptures[captureIndex++] });
    }
  }
  await page.mouse.up();
}

async function clearSelectionAndRestorePen(page: Page) {
  await page.getByRole("treeitem", { name: "A face takes shape" }).click();
  const pen = page.getByRole("button", { name: "Pen (P / 7)" });
  await pen.click();
  await expect(pen).toHaveAttribute("aria-pressed", "true");
}

async function setPenStrokeWidth(page: Page, width: "Medium" | "Thick") {
  await page.getByRole("button", { name: new RegExp(`${width} stroke`) }).click();
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}
