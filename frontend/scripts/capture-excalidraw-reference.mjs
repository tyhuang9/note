import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const evidenceRoot = fileURLToPath(new URL("../../design-qa-evidence/", import.meta.url));
await mkdir(evidenceRoot, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { height: 839, width: 1662 } });
  await page.goto("https://excalidraw.com", { waitUntil: "networkidle" });
  await page.screenshot({ path: `${evidenceRoot}/reference-excalidraw-live-1662x839.png` });

  await page.keyboard.press("2");
  await page.mouse.move(560, 310);
  await page.mouse.down();
  await page.mouse.move(790, 520, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${evidenceRoot}/reference-excalidraw-selected-1662x839.png` });
} finally {
  await browser.close();
}
