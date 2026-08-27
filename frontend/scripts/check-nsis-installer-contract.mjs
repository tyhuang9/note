import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(frontendRoot, "..");
const tauriRoot = resolve(repositoryRoot, "backend", "src-tauri");
const templateRelativePath = "installer/nsis/tauri-2.11.2-installer.nsi";
const upstreamTag = "tauri-cli-v2.11.2";
const upstreamCommit = "499df79be65ef8c0670abc0207cd9e37b55d8491";
const upstreamSha256 = "ee84148e405adc4d736a46456dd8345a644751bd1f28a335dd7fd833a32d7c3e";

const [configText, packageLockText, template, releaseWorkflow] = await Promise.all([
  readFile(resolve(tauriRoot, "tauri.conf.json"), "utf8"),
  readFile(resolve(frontendRoot, "package-lock.json"), "utf8"),
  readFile(resolve(tauriRoot, templateRelativePath), "utf8"),
  readFile(resolve(repositoryRoot, ".github", "workflows", "release.yml"), "utf8"),
]);

const config = JSON.parse(configText);
const nsis = config.bundle?.windows?.nsis;

assert.equal(config.productName, "Note", "installer product identity must remain stable");
assert.equal(config.identifier, "com.tyhuang.note", "installer bundle identity must remain stable");
assert.equal(nsis?.installMode, "currentUser", "Windows installs must remain current-user installs");
assert.equal(nsis?.template, templateRelativePath, "Tauri must use the maintained NSIS template");
assert.match(packageLockText, /"node_modules\/@tauri-apps\/cli":\s*\{\s*"version": "2\.11\.2"/s, "the vendored template requires the locked Tauri CLI 2.11.2");

assert.match(template, new RegExp(`Vendored from tauri-apps/tauri tag ${upstreamTag} \\(commit ${upstreamCommit}\\)`));
assert.match(template, new RegExp(`Upstream SHA-256: ${upstreamSha256}`));
assert.match(template, /NOTE MAINTENANCE PATCH BEGIN/);
assert.match(template, /NOTE MAINTENANCE PATCH END/);
assert.match(template, /!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\$\{PRODUCTNAME\}"/);
assert.match(template, /!define MANUKEY "Software\\\$\{MANUFACTURER\}"/);
assert.match(template, /WriteRegStr SHCTX "\$\{UNINSTKEY\}" "UninstallString"/);
assert.match(template, /Function un\.ConfirmShow ; Add add a `Delete app data` check box/);
assert.match(template, /\$\{If\} \$DeleteAppDataCheckboxState = 1[\s\S]*RmDir \/r "\$APPDATA\\\$\{BUNDLEID\}"/);
assert.doesNotMatch(template, /DeleteAppDataCheckbox[^\n]*\$\{BM_SETCHECK\}/, "the data-deletion checkbox must never be selected automatically");

assert.match(template, /StrCpy \$R2 "Repair \$\{PRODUCTNAME\}"/);
assert.match(template, /StrCpy \$R2 "Update \$\{PRODUCTNAME\}"/);
assert.match(template, /StrCpy \$R2 "Remove \$\{PRODUCTNAME\}"[\s\S]*StrCpy \$R3 "Cancel setup"/);
assert.match(template, /StrCpy \$UpdateMode 1\s+Goto reinst_uninstall/, "an older install must use the safe update route");
assert.match(template, /\$\{If\} \$0 <> 0\s+\$\{OrIf\} \$\{FileExists\}[\s\S]*?StrCpy \$UpdateMode 0/, "a cancelled or failed update must not bypass maintenance selection");
assert.match(template, /\$\{If\} \$R0 = 0 ; Same version[\s\S]*?Goto reinst_done/, "a same-version install must offer repair without uninstalling first");
assert.match(template, /StrCpy \$RemoveOnlyMode 1\s+Goto reinst_uninstall/, "remove must invoke the existing uninstaller");
assert.match(template, /\$\{If\} \$RemoveOnlyMode = 1\s+Quit\s+\$\{EndIf\}\s+reinst_done:/, "remove-only must exit setup instead of reinstalling");
assert.match(template, /\$\{Else\}\s+Quit\s+; User chose to cancel setup/, "newer installed versions must block an implicit downgrade");
assert.doesNotMatch(template, /\$\{If\} \$WixMode = 1\s+Goto reinst_uninstall/, "legacy WiX detection must not bypass Remove or Cancel");
assert.match(
  releaseWorkflow,
  /- name: Verify Windows NSIS installer contract[\s\S]*?run: npm run test:installer-contract[\s\S]*?- name: Build Windows installer/s,
  "release CI must verify the contract before packaging a Windows installer",
);

console.log("Verified the Tauri 2.11.2 NSIS maintenance installer contract.");
