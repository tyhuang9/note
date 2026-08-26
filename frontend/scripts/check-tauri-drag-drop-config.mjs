import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tauriConfigRoot = resolve(frontendRoot, "..", "backend", "src-tauri");
const configFiles = [
  "tauri.conf.json",
  "tauri.windows.conf.json",
  "tauri.macos.conf.json",
  "tauri.linux.conf.json",
];

for (const fileName of configFiles) {
  const configPath = resolve(tauriConfigRoot, fileName);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const windows = config.app?.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error(`${fileName} must define at least one app window.`);
  }
  if (windows.some((window) => window.dragDropEnabled !== false)) {
    throw new Error(`${fileName} must explicitly set dragDropEnabled: false for every app window.`);
  }
}

console.log("Verified dragDropEnabled: false in all Tauri window configs.");
