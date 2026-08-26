import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

const [appCss, appHtml, docsCss, docsHome, docsInstall, readme, titleBar, mark] = await Promise.all([
  readFile(new URL("../src/App.css", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../../docs/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../../docs/index.html", import.meta.url), "utf8"),
  readFile(new URL("../../docs/install.html", import.meta.url), "utf8"),
  readFile(new URL("../../README.md", import.meta.url), "utf8"),
  readFile(new URL("../src/components/workbench/EmbeddedTitleBar.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../docs/assets/note-mark.png", import.meta.url)),
]);

for (const [name, content] of [["app CSS", appCss], ["docs CSS", docsCss]]) {
  assert.match(content, /#FAF8F4/i, `${name} must use warm white`);
  assert.match(content, /#1F1F1F/i, `${name} must use charcoal`);
  assert.match(content, /#D4A128/i, `${name} must use golden`);
}

for (const [name, content] of [["README", readme], ["docs home", docsHome], ["docs install", docsInstall]]) {
  assert.match(content, /Think\. Capture\. Connect\./, `${name} must include the Note tagline`);
  assert.match(content, /A freeform canvas for notes, ideas, and everything in between\./i, `${name} must include the product description`);
}

assert.ok(mark.byteLength > 100_000, "canonical raster mark must contain the approved full-resolution asset");
assert.deepEqual([...mark.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "brand mark must be a PNG");
assert.match(appHtml, /note-mark\.png/);
assert.match(appHtml, /theme-color/);
assert.match(titleBar, /note-mark\.png/);
assert.ok(frontendRoot.endsWith("frontend\\") || frontendRoot.endsWith("frontend/"));

console.log("Branding assets, palette, metadata, and messaging are connected.");
