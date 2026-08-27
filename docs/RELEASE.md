# Releasing Note

The [Build and Release Desktop Installers](../.github/workflows/release.yml)
workflow validates and packages Note on native GitHub-hosted runners.

## What the workflow does

- Pull requests, pushes to `main`, and manual runs build and test Windows,
  macOS, and Linux packages, then keep normalized outputs as Actions artifacts.
- A pushed `v*` tag first checks that the semantic tag version matches
  `backend/src-tauri/tauri.conf.json`, `backend/src-tauri/Cargo.toml`, and
  `frontend/package.json`.
- Only a successful, matching tag publishes a GitHub Release. The release job
  downloads the completed build artifacts, verifies the required assets, adds
  `SHA256SUMS`, and creates (or updates on a rerun) the release.

Each build uses `npm ci` from `frontend/`, frontend unit tests, Rust tests, and
the existing frontend/Tauri build commands.

## Release assets

Published filenames are deliberately version-independent:

| Platform | Asset | Notes |
| --- | --- | --- |
| Windows | `Note-Setup.exe` | NSIS installer for the current user; no administrator installation is required. Existing installs offer Update, Repair, or Remove as appropriate; Remove exits setup after uninstalling. |
| macOS | `Note.dmg` | Disk image from the macOS runner. |
| Debian/Ubuntu | `Note.deb` | Required Linux release asset. |
| Linux, when available | `Note.AppImage` | Optional: AppImage packaging can fail on hosted runners. |
| All | `SHA256SUMS` | SHA-256 checksums for the assets in that release. |

Windows, macOS, and Linux packages are currently unsigned. macOS builds are
not notarized. Do not describe any release as signed or notarized until a
signing and notarization process has been configured.

## Prepare and publish a version

1. Update the three manifest versions to the exact same semantic version:
   `backend/src-tauri/tauri.conf.json`, `backend/src-tauri/Cargo.toml`, and
   `frontend/package.json`.
2. Update `frontend/package-lock.json` to match the frontend manifest.
3. Merge the version change to `main` after the usual review and checks.
4. From the current `main`, create and push the matching tag. For `0.2.0`:

   ```bash
   git checkout main
   git pull --ff-only origin main
   git tag v0.2.0
   git push origin v0.2.0
   ```

5. Watch the tag workflow. When all platform jobs and **Publish GitHub Release**
   succeed, verify the assets and checksums on the [release page](https://github.com/tyhuang9/note/releases).

The workflow rejects tags such as `v0.2` and rejects version mismatches before
any installer build starts.

## GitHub Pages documentation

The [documentation site](https://tyhuang9.github.io/note/) is published from
`docs/` by `.github/workflows/pages.yml`. Pull requests validate its local HTML
links but do not deploy it; pushes to `main` and manual runs deploy it.

Before the first deployment, a repository administrator must enable GitHub
Pages in **Settings → Pages** and select **GitHub Actions** as the source.

## Linux fallback

The Linux build attempts Tauri's normal bundle set with
`APPIMAGE_EXTRACT_AND_RUN=1` and installs common WebKit/FUSE dependencies. If
that fails, it retries a Debian-only bundle. The release always requires a
successful `Note.deb`; it includes `Note.AppImage` only when AppImage packaging
actually succeeds. No RPM asset is published by this workflow.

## Local smoke test

```bash
npm --prefix frontend ci
npm run build
npm run tauri:build
```

To validate the Debian fallback specifically on Linux:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri:build -- --bundles deb
```

Generated local bundles are under `backend/src-tauri/target/release/bundle/`.
Do not commit them.

### Windows maintenance lifecycle (manual)

On a disposable Windows user profile, install Note to a fixed custom directory
such as `D:\Apps\Note`. Run the same installer to verify detection and Repair,
then a newer installer to verify Update, and finally choose Remove to verify it
uninstalls and exits setup without reinstalling. Confirm notes and preferences
are preserved throughout.

## Common failures

- **Version validation failed:** Make the tag without its `v` exactly equal to
  all three manifest versions, then create a corrected tag.
- **An expected asset is missing:** Inspect the platform job's Tauri output.
  The workflow intentionally fails rather than publishing ambiguous or missing
  Windows, macOS, or Debian assets.
- **AppImage is absent:** This is an expected fallback outcome; publish and
  document the successful Debian package instead.
- **SmartScreen or Gatekeeper warning:** Expected until code signing and macOS
  notarization are added. Verify the release source and checksum before use.
