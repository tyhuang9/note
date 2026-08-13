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

## Phase 9: Local Performance Evidence and Privacy

When Note can install its global tracing subscriber, the application records bounded local Rust
tracing spans to a nonblocking stderr sink. If a global subscriber already exists, these sink
diagnostics are not installed, exported, or recorded. Browser User Timing entries are transient
developer diagnostics: the application neither observes nor retains them. Both use fixed operation
names and elapsed time only. Covered paths include main activation, calendar initialization,
agenda paging/search/mutations, assistant context, provider start, and tool work, model
status/install, voice capture/transcription, and widget creation/agenda refresh. These are local
diagnostics: no telemetry endpoint, network export, request payload, or content logging is added.

Measured locally by the deterministic synthetic calendar test (1,000 synthetic all-day records):

```bash
cd backend/src-tauri
cargo test synthetic_calendar_operations_record_local_duration_samples -- --nocapture
```

The test creates a temporary SQLite calendar with 1,000 generic synthetic records, then reports
raw p50/p95 samples for list, search, and a create/delete CRUD cycle without enforcing
hardware-dependent thresholds. On the Phase 9 Windows host (debug test profile), the recorded
samples were list p50/p95 22/23 ms, search 5/6 ms, and CRUD 0/0 ms. These are local reference
samples, not release targets or cross-platform claims.
For release validation, run:

```bash
cd backend/src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-targets --all-features --locked
cd ../../frontend
npm run build
```

Unverified: packaged-app startup or first-ready timing, microphone/device capture behavior, external
model provider latency (including provider start), and browser Performance API availability on each
target OS. The GitHub Actions
matrix runs Windows, macOS, and Linux native formatting, clippy, tests, frontend builds, and Tauri
packaging; local measurements still depend on host hardware and OS services.

Privacy rule: operation identifiers are compile-time fixed labels. Never add note text, event
titles, transcripts, prompts, credentials, identifiers, URLs, file paths, or error bodies to spans,
marks, measurements, tests, or release evidence.

The latest full `npm run test:e2e` run hit the 240-second host cap and was terminated; its reporter
then returned EPIPE without a test-level result. That run is unverified and is neither a pass nor a
fail result. Separately, the serial Chromium E2E baseline before this focused helper test was 146
of 152 passing. The six known failures are date-pinned calendar fixture checks; they remain
unverified until their fixed calendar dates are refreshed. This workflow does not represent that
suite as fully green.
