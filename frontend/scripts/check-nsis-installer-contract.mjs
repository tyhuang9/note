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
const existingInstallDetection = template.match(/Function DetectExistingInstall([\s\S]*?)FunctionEnd/)?.[1];
const earlyChecks = template.match(/Section EarlyChecks([\s\S]*?)SectionEnd/)?.[1];

assert.ok(pageLeaveReinstall, "the vendored template must define PageLeaveReinstall");
assert.ok(existingInstallDetection, "the vendored template must define shared existing-install detection");
assert.ok(earlyChecks, "the vendored template must define payload preflight checks");

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
assert.match(template, /ReadRegStr \$0 SHCTX "\$\{UNINSTKEY\}" "DisplayName"[\s\S]*?\$0 != "\$\{PRODUCTNAME\}"[\s\S]*?ReadRegStr \$0 SHCTX "\$\{UNINSTKEY\}" "Publisher"[\s\S]*?\$0 != "\$\{MANUFACTURER\}"[\s\S]*?ReadRegStr \$MaintenanceInstallPath SHCTX "\$\{MANUPRODUCTKEY\}" ""[\s\S]*?ReadRegStr \$MaintenanceArpInstallPath SHCTX "\$\{UNINSTKEY\}" "InstallLocation"[\s\S]*?StrCmp \$MaintenanceInstallPath \$MaintenanceArpInstallPath/, "existing-install detection must require matching manufacturer and ARP location records");
assert.match(existingInstallDetection, /StrCmp \$MaintenanceInstallPath \$MaintenanceArpInstallPath maintenance_install_paths_valid\s+Return/, "mismatched registered install locations must not be treated as a fresh install");
assert.doesNotMatch(existingInstallDetection, /\$LOCALAPPDATA\\/, "existing-install detection must not restrict valid custom paths to LocalAppData");
assert.match(template, /Function NormalizeMaintenanceInstallPath[\s\S]*?Accepts canonical fixed-drive paths such as D:\\Apps\\Note[\s\S]*?GetFullPathName \$0 "\$0"[\s\S]*?GetDriveType\(t "\$1"\) i \.r2[\s\S]*?\$2 != 3/, "custom fixed-drive paths must be canonicalized while network drives are rejected");
assert.match(template, /GetFullPathName \$0 "\$0"[\s\S]*?remainder is empty for C:\\ and paths that canonicalize to a drive root[\s\S]*?StrCpy \$1 \$0 "" 3[\s\S]*?\$1 == ""[\s\S]*?drive root is never an application directory/, "literal and canonicalized drive-root install locations must be rejected");
assert.match(template, /Only an explicit local-drive path is accepted before canonicalization[\s\S]*?relative paths, UNC paths, and Win32 device namespaces/, "relative, UNC, and device install locations must be rejected");
assert.match(template, /\$\{StrLoc\} \$1 \$0 "\$\\\"" ">"[\s\S]*?StrCpy \$1 \$0 "" 3[\s\S]*?\$\{StrLoc\} \$2 \$1 ":" ">"/, "malformed locations containing embedded quotes or alternate-stream colons must be rejected");
assert.match(template, /StrCpy \$MaintenanceRegistrationInvalid 1[\s\S]*?maintenance_install_paths_valid:[\s\S]*?StrCpy \$MaintenanceRegistrationInvalid 0/, "a stable registration must remain invalid until both location records validate and agree");
assert.match(template, /StrCpy \$MaintenanceDetected 1[\s\S]*?ReadRegStr \$MaintenanceInstalledVersion SHCTX "\$\{UNINSTKEY\}" "DisplayVersion"[\s\S]*?StrCpy \$MaintenanceUninstallerPath "\$MaintenanceInstallPath\\uninstall\.exe"[\s\S]*?ReadRegStr \$0 SHCTX "\$\{UNINSTKEY\}" "UninstallString"/, "existing-install detection must remain independent of uninstaller availability");
assert.match(template, /\$\{If\} \$0 == "\$\\\"\$MaintenanceUninstallerPath\$\\\""[\s\S]*?\$\{AndIf\} \$\{FileExists\} "\$MaintenanceUninstallerPath"[\s\S]*?StrCpy \$MaintenanceUninstallerTrusted 1/, "Remove requires a matching registered uninstaller at the expected path");
assert.match(template, /\$\{If\} \$0 <> 0\s+\$\{OrIf\} \$\{FileExists\}[\s\S]*?StrCpy \$UpdateMode 0/, "a cancelled or failed update must not bypass maintenance selection");
assert.match(pageLeaveReinstall, /\$\{If\} \$R0 = 0 ; Same version[\s\S]*?Goto reinst_done/, "a same-version install must offer repair without uninstalling first");
assert.match(pageLeaveReinstall, /\$\{ElseIf\} \$R0 = 1 ; Upgrading[\s\S]*?StrCpy \$UpdateMode 1[\s\S]*?\$\{If\} \$MaintenanceUninstallerTrusted = 1[\s\S]*?Goto reinst_uninstall[\s\S]*?\$\{Else\}\s+Goto reinst_done/, "an older install must update in place when its uninstaller is missing or corrupt");
assert.match(template, /\$\{NSD_SetText\} \$(?:R2|R3) "Remove unavailable — repair Note first"[\s\S]*?EnableWindow \$(?:R2|R3) 0/, "Remove must be relabeled and disabled without overwriting its radio-control handle");
assert.match(pageLeaveReinstall, /request_remove:[\s\S]*?\$\{If\} \$MaintenanceUninstallerTrusted <> 1[\s\S]*?Call RefuseRemove[\s\S]*?Abort/, "Remove must be safely refused when its uninstaller is untrusted");
assert.match(template, /Function RefuseRemove[\s\S]*?cannot safely remove this installation[\s\S]*?Repair or Update to recreate it/, "Remove refusal must provide recovery guidance");
assert.match(pageLeaveReinstall, /StrCpy \$R1 "\$\\\"\$MaintenanceUninstallerPath\$\\\""[\s\S]*?ExecWait '\$R1' \$0/, "Remove must execute only a constructed trusted uninstaller command");
assert.doesNotMatch(pageLeaveReinstall, /ReadRegStr \$R1 SHCTX "\$\{UNINSTKEY\}" "UninstallString"/, "maintenance actions must not execute a raw registered uninstaller command");
assert.match(pageLeaveReinstall, /\$\{If\} \$RemoveOnlyMode = 1\s+Quit\s+\$\{EndIf\}\s+reinst_done:/, "remove-only must exit setup instead of reinstalling");
assert.match(pageLeaveReinstall, /\$\{Else\}\s+Quit\s+; User chose to cancel setup/, "newer installed versions must block an implicit downgrade");
assert.match(template, /Function \.onInit[\s\S]*?Call DetectExistingInstall[\s\S]*?FunctionEnd/, "detection must initialize outside maintenance page callbacks");
assert.match(existingInstallDetection, /ReadRegStr \$MaintenanceInstalledVersion SHCTX "\$\{UNINSTKEY\}" "DisplayVersion"[\s\S]*?SemverCompare "0\.0\.0-0" \$MaintenanceInstalledVersion[\s\S]*?\$0 <> 1[\s\S]*?StrCpy \$MaintenanceVersionValid 1[\s\S]*?SemverCompare "\$\{VERSION\}" \$MaintenanceInstalledVersion/, "shared detection must validate DisplayVersion before comparing it");
assert.match(earlyChecks, /Call DetectExistingInstall[\s\S]*?\$\{If\} \$\{Silent\}[\s\S]*?\$MaintenanceVersionComparison = -1[\s\S]*?Abort/, "silent newer-version downgrades must abort before payload sections");
assert.match(template, /Section EarlyChecks[\s\S]*?\$MaintenanceRegistrationInvalid = 1[\s\S]*?conflicting or unsafe install locations[\s\S]*?Abort/, "invalid registered install locations must block a second installation before payload sections");
assert.match(earlyChecks, /\$MaintenanceDetected = 1[\s\S]*?\$MaintenanceVersionValid <> 1[\s\S]*?Goto maintenance_version_invalid[\s\S]*?maintenance_version_invalid:[\s\S]*?missing or invalid version[\s\S]*?Abort/, "interactive, silent, passive, and updater launches must fail closed for missing or malformed registered versions before payload sections");
assert.match(earlyChecks, /\$\{If\} \$MaintenanceDetected = 1[\s\S]*?\$\{EndIf\}\s+Goto maintenance_version_valid[\s\S]*?maintenance_version_valid:\s+\$\{If\} \$\{Silent\}/, "an absent registration must bypass version preflight and remain eligible for a fresh install");
assert.ok(template.indexOf("Section EarlyChecks") < template.indexOf("Section WebView2"), "version preflight must execute before WebView2 and application payload sections");
assert.match(earlyChecks, /\$MaintenanceVersionComparison = 0[\s\S]*?StrCpy \$UpdateMode 0[\s\S]*?\$MaintenanceVersionComparison = 1[\s\S]*?StrCpy \$UpdateMode 1/, "silent same-version repairs and older-version updates must be deterministic");
assert.match(pageLeaveReinstall, /\$\{If\} \$UpdateMode = 1[\s\S]*?\$\{If\} \$MaintenanceDetected = 1[\s\S]*?\$MaintenanceVersionComparison = 0[\s\S]*?\$MaintenanceVersionComparison = 1[\s\S]*?Goto reinst_done[\s\S]*?Abort/, "the /UPDATE bypass must apply only to detected compatible NSIS installs");
assert.match(pageLeaveReinstall, /\$\{If\} \$PassiveMode = 1[\s\S]*?\$\{If\} \$R0 = 0\s+StrCpy \$R1 1[\s\S]*?\$\{ElseIf\} \$R0 = 1\s+StrCpy \$R1 1[\s\S]*?\$\{ElseIf\} \$R0 = -1\s+StrCpy \$R1 0[\s\S]*?\$\{Else\}\s+\$\{NSD_GetState\} \$R2 \$R1/, "passive mode must default to Repair, Update, or Cancel before reading dialog controls");
assert.match(
  releaseWorkflow,
  /- name: Verify Windows NSIS installer contract[\s\S]*?run: npm run test:installer-contract[\s\S]*?- name: Build Windows installer/s,
  "release CI must verify the contract before packaging a Windows installer",
);

console.log("Verified the Tauri 2.11.2 NSIS maintenance installer contract.");
