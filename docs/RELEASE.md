# Release Builds

This project builds installable desktop packages with GitHub Actions in
`.github/workflows/release.yml`.

## Triggering the Workflow

The workflow runs in these cases:

- Manually from the GitHub Actions tab with `workflow_dispatch`.
- On pull requests targeting `main`.
- On pushes to `main`.
- On version tag pushes that match `v*`, such as `v0.1.0`.

For feature-branch validation, open a pull request against `main` and use the
workflow run attached to the PR.

## Build Steps

Each platform job uses the existing project commands:

```bash
npm install
npm run build
npm run tauri:build
```

In CI, `npm install` runs from `frontend/` because the root package delegates
frontend and Tauri commands to that package.

## Produced Installers

GitHub Actions uploads installers as workflow artifacts:

- `note-windows-installers`: Windows `.msi` and `.exe` bundles when produced.
- `note-macos-installers`: macOS `.dmg` bundles and `.app` bundles when produced.
- `note-linux-installers`: Linux `.deb` bundles and AppImage bundles when produced.

The Linux build uses the existing Tauri bundle target configuration. Because the
current Tauri config uses `bundle.targets: "all"`, the Linux artifact may also
include an `.rpm` bundle when Tauri produces one.

Generated files are created under:

```text
backend/src-tauri/target/release/bundle/
```

Common subdirectories are `msi/`, `nsis/`, `dmg/`, `macos/`, `deb/`,
`appimage/`, and `rpm/`.

## Downloading Artifacts

1. Open the repository on GitHub.
2. Go to the Actions tab.
3. Select the `Build Desktop Installers` workflow run.
4. Download the artifact for the target operating system from the run summary.
5. Extract the artifact archive locally before installing or testing the package.

Artifacts are unsigned development builds unless signing secrets and notarization
are added later.

## Known Platform Issues

- Windows installers are unsigned, so Windows SmartScreen may warn on first run.
- MSI creation depends on the Windows runner support for MSI tooling and the
  VBSCRIPT optional feature.
- macOS builds are unsigned and not notarized. Gatekeeper may block or warn when
  opening downloaded builds.
- The architecture of macOS artifacts follows the `macos-latest` runner used by
  GitHub Actions.
- Linux AppImage packaging depends on `linuxdeploy` and FUSE/AppImage runtime
  behavior. The workflow sets `APPIMAGE_EXTRACT_AND_RUN=1` and installs common
  compatibility packages, but AppImage can still fail on hosted runners.
- If Linux full bundling fails during AppImage creation, the workflow runs a
  Debian-only fallback with `npm run tauri:build -- --bundles deb` so a `.deb`
  artifact can still be uploaded.

## Local Smoke Test

From the repo root, run:

```bash
cd frontend
npm install
cd ..
npm run build
npm run tauri:build
```

On Linux, if AppImage packaging fails but `.deb` is enough for validation, run:

```bash
npm run tauri:build -- --bundles deb
```
