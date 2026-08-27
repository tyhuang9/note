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
const pageLeaveReinstall = template.match(/Function PageLeaveReinstall([\s\S]*?)FunctionEnd/)?.[1];

assert.ok(pageLeaveReinstall, "the vendored template must define PageLeaveReinstall");

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
assert.match(template, /!insertmacro MUI_UNPAGE_CONFIRM/, "the standard uninstall confirmation must remain");
assert.doesNotMatch(template, /DeleteAppData|deleteAppData|RmDir \/r "\$(?:APPDATA|LOCALAPPDATA)/, "uninstall must preserve application data and avoid recursive app-data deletion");
assert.doesNotMatch(template, /WixMode|EnumRegKey .*CurrentVersion\\Uninstall|msiexec|HKLM .*"UninstallString"/, "unsupported legacy WiX discovery and raw MSI execution must remain disabled");

assert.match(template, /StrCpy \$R2 "Repair \$\{PRODUCTNAME\}"/);
assert.match(template, /StrCpy \$R2 "Update \$\{PRODUCTNAME\}"/);
assert.match(template, /StrCpy \$R2 "Remove \$\{PRODUCTNAME\}"[\s\S]*StrCpy \$R3 "Cancel setup"/);
assert.match(template, /StrCpy \$UpdateMode 1\s+Goto reinst_uninstall/, "an older install must use the safe update route");
assert.match(template, /\$\{If\} \$0 <> 0\s+\$\{OrIf\} \$\{FileExists\}[\s\S]*?StrCpy \$UpdateMode 0/, "a cancelled or failed update must not bypass maintenance selection");
assert.match(pageLeaveReinstall, /\$\{If\} \$R0 = 0 ; Same version[\s\S]*?Goto reinst_done/, "a same-version install must offer repair without uninstalling first");
assert.match(pageLeaveReinstall, /StrCpy \$RemoveOnlyMode 1\s+Goto reinst_uninstall/, "remove must invoke the existing uninstaller");
assert.match(pageLeaveReinstall, /\$\{If\} \$RemoveOnlyMode = 1\s+Quit\s+\$\{EndIf\}\s+reinst_done:/, "remove-only must exit setup instead of reinstalling");
assert.match(pageLeaveReinstall, /\$\{Else\}\s+Quit\s+; User chose to cancel setup/, "newer installed versions must block an implicit downgrade");
assert.match(template, /Function \.onInit[\s\S]*?Call DetectExistingInstall[\s\S]*?FunctionEnd/, "detection must initialize outside maintenance page callbacks");
assert.match(template, /Function DetectExistingInstall[\s\S]*?ReadRegStr \$0 SHCTX "\$\{UNINSTKEY\}" "UninstallString"[\s\S]*?ReadRegStr \$MaintenanceInstalledVersion SHCTX "\$\{UNINSTKEY\}" "DisplayVersion"[\s\S]*?SemverCompare/, "shared detection must use the current NSIS identity and compare versions");
assert.match(template, /Section EarlyChecks[\s\S]*?\$\{If\} \$\{Silent\}[\s\S]*?Call DetectExistingInstall[\s\S]*?\$MaintenanceVersionComparison = -1[\s\S]*?Abort/, "silent newer-version downgrades must abort before payload sections");
assert.match(template, /Section EarlyChecks[\s\S]*?\$MaintenanceVersionComparison = 0[\s\S]*?StrCpy \$UpdateMode 0[\s\S]*?\$MaintenanceVersionComparison = 1[\s\S]*?StrCpy \$UpdateMode 1/, "silent same-version repairs and older-version updates must be deterministic");
assert.match(pageLeaveReinstall, /\$\{If\} \$UpdateMode = 1[\s\S]*?\$\{If\} \$MaintenanceDetected = 1[\s\S]*?\$MaintenanceVersionComparison = 0[\s\S]*?\$MaintenanceVersionComparison = 1[\s\S]*?Goto reinst_done[\s\S]*?Abort/, "the /UPDATE bypass must apply only to detected compatible NSIS installs");
assert.match(pageLeaveReinstall, /\$\{If\} \$PassiveMode = 1[\s\S]*?\$\{If\} \$R0 = 0\s+StrCpy \$R1 1[\s\S]*?\$\{ElseIf\} \$R0 = 1\s+StrCpy \$R1 1[\s\S]*?\$\{ElseIf\} \$R0 = -1\s+StrCpy \$R1 0[\s\S]*?\$\{Else\}\s+\$\{NSD_GetState\} \$R2 \$R1/, "passive mode must default to Repair, Update, or Cancel before reading dialog controls");
assert.match(
  releaseWorkflow,
  /- name: Verify Windows NSIS installer contract[\s\S]*?run: npm run test:installer-contract[\s\S]*?- name: Build Windows installer/s,
  "release CI must verify the contract before packaging a Windows installer",
);

console.log("Verified the Tauri 2.11.2 NSIS maintenance installer contract.");
