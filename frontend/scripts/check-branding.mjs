import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

const [appCss, appHtml, docsCss, docsHome, docsInstall, readme, titleBar, aiProviders, mark, mark32, mark48] = await Promise.all([
  readFile(new URL("../src/App.css", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../../docs/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../../docs/index.html", import.meta.url), "utf8"),
  readFile(new URL("../../docs/install.html", import.meta.url), "utf8"),
  readFile(new URL("../../README.md", import.meta.url), "utf8"),
  readFile(new URL("../src/components/workbench/EmbeddedTitleBar.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/AIProvidersSettings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../docs/assets/note-mark.png", import.meta.url)),
  readFile(new URL("../../docs/assets/note-mark-32.png", import.meta.url)),
  readFile(new URL("../../docs/assets/note-mark-48.png", import.meta.url)),
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
for (const [name, derivative, expectedSize] of [["32px mark", mark32, 32], ["48px mark", mark48, 48]]) {
  assert.deepEqual([...derivative.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${name} must be a PNG`);
  assert.equal(derivative.readUInt32BE(16), expectedSize, `${name} must have the expected width`);
  assert.equal(derivative.readUInt32BE(20), expectedSize, `${name} must have the expected height`);
  assert.ok(derivative.byteLength < 20_000, `${name} must stay size optimized`);
}
assert.match(appHtml, /note-mark-32\.png/);
assert.match(appHtml, /theme-color/);
assert.match(titleBar, /note-mark-32\.png/);
assert.match(docsHome, /note-mark-48\.png/);
assert.match(docsInstall, /note-mark-48\.png/);
assert.match(docsCss, /--focus:\s*#765400/i, "docs light focus must meet non-text contrast");
assert.match(docsCss, /a:focus-visible\s*{[^}]*var\(--focus\)/s, "docs links must use the focus token");
assert.match(docsCss, /@media \(forced-colors: active\)[\s\S]*outline-color:\s*Highlight/, "docs focus must support forced colors");
assert.match(appCss, /\.file-search-control\.is-active\s*{[^}]*outline:\s*2px solid var\(--canvas-focus\)/s, "search focus must use the accessible app focus token");
assert.match(appCss, /\.file-tree-root-drop-zone\.is-drop-target\s*{[^}]*border-color:\s*#7A5700/i, "drop targets must use a 3:1 state border");
assert.match(appCss, /@media \(forced-colors: active\)[\s\S]*\.ai-provider-item\[aria-pressed="true"\]/, "selected controls must support forced colors");
assert.match(aiProviders, /aria-pressed={provider\.id === selectedProvider\?\.id}/, "provider selection must be programmatically exposed");
assert.match(appCss, /--brand-control:\s*#7A5700/i, "light controls must use the brand control token");
assert.doesNotMatch(appCss, /#7950f2/i, "legacy purple control accents must not remain");
assert.match(appCss, /\.rail-button\[aria-pressed="true"\][\s\S]*box-shadow:\s*inset 3px 0 0 var\(--brand-control\)/, "light selected controls must retain a contrast-safe shape marker");
assert.match(docsCss, /nav a\s*{[^}]*min-height:\s*44px/s, "mobile docs navigation must keep accessible touch targets");
assert.ok(frontendRoot.endsWith("frontend\\") || frontendRoot.endsWith("frontend/"));

console.log("Branding assets, palette, metadata, and messaging are connected.");
