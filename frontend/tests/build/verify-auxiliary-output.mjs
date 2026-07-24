import { readFile } from "node:fs/promises";

const dist = new URL("../../dist/", import.meta.url);
const auxiliaryDocuments = [
  "widget.html",
  "quick-command.html",
  "event-editor.html",
  "unsupported.html",
];
const requiredCsp =
  "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; media-src 'none'; worker-src 'none'";
const manifest = JSON.parse(
  await readFile(new URL(".vite/manifest.json", dist), "utf8"),
);
const manifestByFile = new Map(
  Object.entries(manifest).map(([key, value]) => [value.file, { key, value }]),
);

for (const documentName of auxiliaryDocuments) {
  const html = await readFile(new URL(documentName, dist), "utf8");
  const csp = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i,
  )?.[1];

  if (csp !== requiredCsp) {
    throw new Error(`${documentName} does not contain the required auxiliary CSP.`);
  }

  const entryFile = html.match(/<script[^>]+src="\/?([^"]+)"/i)?.[1];
  const entry = entryFile ? manifestByFile.get(entryFile) : undefined;

  if (!entry) {
    throw new Error(`${documentName} does not reference a manifest entry.`);
  }

  const reachableKeys = collectReachableManifestKeys(entry.key);

  for (const key of reachableKeys) {
    const chunk = manifest[key];

    if (/MainSurface|(^|\/)App\.tsx$/.test(key)) {
      throw new Error(`${documentName} reaches the main application chunk ${key}.`);
    }

    const source = await readFile(new URL(chunk.file, dist), "utf8");

    if (source.includes("Freeform note canvas") || source.includes("load_app_data")) {
      throw new Error(`${documentName} includes main-only code in ${chunk.file}.`);
    }
  }
}

console.log("Auxiliary CSP and chunk-isolation checks passed.");

function collectReachableManifestKeys(entryKey) {
  const reachable = new Set();
  const pending = [entryKey];

  while (pending.length > 0) {
    const key = pending.pop();

    if (!key || reachable.has(key)) {
      continue;
    }

    const chunk = manifest[key];

    if (!chunk) {
      throw new Error(`Manifest dependency ${key} is missing.`);
    }

    reachable.add(key);
    pending.push(...(chunk.imports ?? []), ...(chunk.dynamicImports ?? []));
  }

  return reachable;
}
