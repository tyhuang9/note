import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pages = ["index.html", "install.html"];
const externalReference = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const failures = [];

function fail(message) {
  failures.push(message);
}

function parseIds(content) {
  return [...content.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

function localReferences(content) {
  const references = [];
  for (const match of content.matchAll(/\b(href|src|srcset)="([^"]+)"/g)) {
    const [, attribute, value] = match;
    if (attribute === "srcset") {
      for (const candidate of value.split(",")) {
        references.push(candidate.trim().split(/\s+/, 1)[0]);
      }
    } else {
      references.push(value);
    }
  }
  return references;
}

for (const page of pages) {
  const pagePath = resolve(docsRoot, page);
  if (!existsSync(pagePath)) {
    fail(`Missing documentation page: ${page}`);
    continue;
  }

  const content = readFileSync(pagePath, "utf8");
  const ids = parseIds(content);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);

  if (!/<html\s[^>]*\blang="[^"]+"/i.test(content)) fail(`${page} must declare a document language.`);
  if ((content.match(/<h1\b/gi) ?? []).length !== 1) fail(`${page} must contain exactly one h1.`);
  if (!/<a\b[^>]*class="[^"]*skip-link[^"]*"[^>]*href="#main"/i.test(content)) {
    fail(`${page} must link its skip control to #main.`);
  }
  if (!/<main\b[^>]*id="main"[^>]*tabindex="-1"/i.test(content)) {
    fail(`${page} must provide a focusable #main skip-link target.`);
  }
  if (duplicateIds.length > 0) fail(`${page} contains duplicate ids: ${[...new Set(duplicateIds)].join(", ")}`);

  for (const image of content.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt="[^"]*"/i.test(image[0])) fail(`${page} contains an image without alt text.`);
  }

  for (const rawReference of localReferences(content)) {
    if (!rawReference || externalReference.test(rawReference)) continue;

    const [pathAndQuery, fragment = ""] = rawReference.split("#", 2);
    const localPath = pathAndQuery.split("?", 1)[0];
    const targetPath = localPath ? resolve(dirname(pagePath), localPath) : pagePath;
    const pathFromRoot = relative(docsRoot, targetPath);

    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || resolve(targetPath) === docsRoot) {
      fail(`${page} references a path outside the documentation site: ${rawReference}`);
      continue;
    }
    if (!existsSync(targetPath)) {
      fail(`${page} references a missing local file: ${rawReference}`);
      continue;
    }
    if (fragment && extname(targetPath).toLowerCase() === ".html") {
      const targetContent = readFileSync(targetPath, "utf8");
      if (!parseIds(targetContent).includes(fragment)) {
        fail(`${page} references a missing fragment: ${rawReference}`);
      }
    }
  }
}

const home = readFileSync(resolve(docsRoot, "index.html"), "utf8");
const styles = readFileSync(resolve(docsRoot, "styles.css"), "utf8");
if (!/<source\b[^>]*media="\(prefers-reduced-motion: reduce\)"[^>]*srcset="assets\/note-demo-static\.png"/i.test(home)) {
  fail("index.html must provide the static demo image for reduced-motion visitors.");
}
if (/border-(?:left|top)\s*:[^;]*(?:var\(--golden|#D4A128|#E6B84A|#7A5700)/i.test(styles)) {
  fail("styles.css must not use brand-colored left or top borders.");
}
if (/box-shadow\s*:\s*inset\s+(?:0\s+[1-9]|[1-9][\d.]*\S*\s+0)[^;]*(?:var\(--golden|#D4A128|#E6B84A|#7A5700)/i.test(styles)) {
  fail("styles.css must not simulate brand-colored left or top borders with inset shadows.");
}
for (const page of pages) {
  const content = readFileSync(resolve(docsRoot, page), "utf8");
  if (!/assets\/note-mark-dark-48\.png/.test(content) || !/assets\/note-mark-48\.png/.test(content)) {
    fail(`${page} must provide both light and dark brand marks.`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${pages.length} documentation pages, their local assets, and accessibility invariants.`);
}
