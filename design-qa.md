# Design QA — Codex-style folder actions

- Source visual truth:
  - `C:\Users\huang\AppData\Local\Temp\codex-clipboard-96a0d368-e597-4954-98be-0ea27056d672.png`
  - `C:\Users\huang\AppData\Local\Temp\codex-clipboard-0b14c64c-66a5-4e75-be79-6292312b754d.png`
- Implementation screenshots:
  - `C:\Users\huang\Documents\Projects\Note\worktrees\notion-style-header\design-qa-folder-row.png`
  - `C:\Users\huang\Documents\Projects\Note\worktrees\notion-style-header\design-qa-folder-menu.png`
- Combined focused comparison: `C:\Users\huang\Documents\Projects\Note\worktrees\notion-style-header\design-qa-folder-menu-comparison.png`
- Viewport: 1042 × 986 CSS pixels, device pixel ratio 1.25, in-app Browser. Browser captures were returned at 1042 × 986 pixels, so source and focused implementation crops were compared at their returned native size without density resampling.
- Source pixels: 310 × 132 for the folder-row reference and 295 × 285 for the menu reference. Focused implementation crops: 280 × 80 for the row and 224 × 145 for the menu.
- State: dark theme, Favorites view, one expanded bookmarked folder with one child page; both closed-row and right-click menu states captured.

## Full-view comparison evidence

The implementation preserves Note's header, rail, 280px explorer, canvas, dark palette, 30px row rhythm, and existing folder hierarchy. The change is contained to the folder action area and its menu.

## Focused region comparison evidence

The combined comparison pairs Codex's selected project row and context menu with Note's updated folder row and shared menu. Note now shows only Add page and More at the right edge, keeps those controls visible on the selected folder, and moves Bookmark, Rename, and Delete into a compact dark menu. The ellipsis and right-click routes render the same menu instance and ordered actions.

## Required fidelity surfaces

- Fonts and typography: Note keeps its existing 13px explorer type and compact truncation. Menu labels use a 13px medium weight that matches the density of the Codex reference without changing the app-wide type system.
- Spacing and layout rhythm: folder rows retain their 30px height and compact 4px grid gap. The two 24px actions occupy one 48px group. The menu uses 34px items, 6px padding, an 8px radius, and separators before the destructive action.
- Colors and visual tokens: existing dark surfaces remain, while selected states use golden, contrast-safe inset or outline markers rather than the former accent. The menu uses Note's neutral dark tokens; Delete receives a restrained destructive color while retaining sufficient contrast.
- Image quality and asset fidelity: no raster substitutes or new generated artwork were introduced. Folder, add-page, bookmark, rename, delete, and ellipsis symbols use the existing Hero-style icon system.
- Copy and content: Codex-specific project actions were adapted to Note rather than copied. The shared options are `Bookmark`/`Remove bookmark`, `Rename`, and `Delete`; the direct row action remains `Create page in {folder}`.

## Interaction and runtime checks

- More button: passed; opens the shared menu, reports `aria-haspopup="menu"`, updates `aria-expanded`, and focuses the first item.
- Right-click: passed in Files and Favorites; opens the identical three ordered actions.
- Keyboard: Arrow Down and End move focus; Escape returns to More; Shift+Tab returns to Add page; Tab advances past More without dropping focus to the document body.
- Focus recovery: deleting a folder or removing it from Favorites focuses the nearest surviving folder action, Create folder, or the active labelled rail control.
- Reflow and contrast: the rendered menu is measured and clamped at an 8px viewport margin, including a 1024 × 220 edge case. Current light-theme focus treatments use contrast-safe tokens: `#765400` for docs and `#005FCC` for app search/light contexts, with solid outlines that exceed the 3:1 non-text contrast requirement.
- Menu dismissal: outside pointer, Escape, Tab, scroll, resize, and window blur are handled.
- Console errors: none. The web preview reports only the expected Tauri/SQLite-unavailable warning and uses session storage.

## Findings

No actionable P0, P1, or P2 visual or interaction mismatch remains for the requested folder action pattern.

## Comparison history

- Initial issue: folder rows exposed Bookmark and Delete directly, diverging from the simple Codex project-row pattern. Fix: retain Add page, replace the second visible action with More, and move Bookmark, Rename, and Delete into one shared menu used by More and right-click. Post-fix evidence: `design-qa-folder-menu-comparison.png`.
- Accessibility review issue: the initial light focus ring was too faint, the estimated menu height could clip near the viewport edge, and destructive/removal actions could leave focus on a generic container. Fix: use a solid focus outline, clamp from measured bounds, and restore focus to a meaningful surviving action. Post-fix focused browser test: passed.

## Follow-up polish

- P3: Note's menu is wider than the supplied Codex crop to keep labels and focus outlines comfortable inside the narrower explorer; this is an intentional usability adaptation.

final result: passed

## Branding QA — 2026-08-26

### Verification plan

- Expected behavior/success path: the approved Note raster mark, `#FAF8F4` warm white, `#1F1F1F` charcoal, `#D4A128` gold, tagline, and product description are consistently connected across the app, README, and GitHub Pages docs; app and docs remain usable in light/dark themes at 375, 390, and 1440 CSS px.
- Failure/risk paths: missing or wrongly sized assets, unresolved favicon/build imports, stale SVG branding, broken local docs links, horizontal overflow, hidden titlebar branding, color-only selection/focus, and forced-colors loss.
- Automated/manual gates: branding/config scripts, production build, unit suite, focused responsive Playwright, local rendered docs/app inspection, local-link resolution, raster dimension checks, and `git diff --check`.

### Coverage report and test results

- PASS — `npm --prefix frontend run test:branding`: palette, messaging, metadata, raster signatures/dimensions, accessible focus/selection source rules, and forced-colors selectors connected.
- PASS — `npm --prefix frontend run test:tauri-config`: `dragDropEnabled: false` in every Tauri window config.
- PASS — `npm --prefix frontend run build`: TypeScript and Vite production build completed; compiled `dist/index.html` resolves the fingerprinted 32px PNG favicon. Vite emitted only the existing >500 kB chunk-size advisory.
- PASS — `npm --prefix frontend run test:unit`: 33 files, 287 tests passed.
- PASS — focused Playwright `embedded titlebar keeps canvas controls docked and operable`: 1/1 passed.
- PASS for branding/responsive scope — the full `workbench-responsive.spec.ts` reported the desktop docking, embedded titlebar, viewport-safe dock, compact/narrow overlay, narrow search, tab keyboard, and assistant selection cases as passing. Two unrelated canvas creation/template cases failed because their expected text element/editor was never created. Both failures reproduced at untouched base `1fe27ac` with the same assertions, so they are pre-existing and are not branding regressions.
- PASS — GitHub Pages local-link validator equivalent: all relative `href`/`src` references in rendered `docs/index.html` and `docs/install.html` resolve locally; no console/page errors.
- PASS — `git diff --check 1fe27ac..HEAD`.
- Tests written: none; this pass executed and documented existing automated coverage only.

### Rendered and source evidence

- Docs home and install pages were rendered in Chromium at 375, 390, and 1440 CSS px in both light and dark schemes. Every case matched viewport width with no horizontal overflow, loaded the 48×48 brand mark, applied the expected theme colors, and exposed a solid 3px focus outline. Mobile primary-navigation links measured 44px high. Visual inspection confirmed coherent logo, typography, hierarchy, cards, actions, and responsive stacking.
- The web app was rendered at 375, 390, and 1440 CSS px in both themes. The shell and embedded titlebar matched the viewport without horizontal overflow; the 32×32 raster loaded and rendered crisply at 22×22 CSS px; brand text/icon, toolbar, rail, and canvas remained visible. Selected rail controls retained a 3px inset shape marker. Chromium forced-colors emulation was active and produced a 2px selected-control outline.
- Asset inspection: canonical mark is 1254×1254; derivatives are exactly 32×32 and 48×48; Tauri 32px source is 32×32. No SVG branding files or SVG references remain in the docs/Tauri branding surfaces.
- Temporary screenshots were inspected from `%TEMP%\note-brand-qa`; no screenshots or generated evidence were added to the branch.

### Accessibility/UX gate

GO. The branding is legible and consistent across light/dark and compact/desktop layouts. Keyboard focus and selected states are not color-only, mobile docs targets meet the 44px target used by this branch, decorative marks are excluded from accessible naming, and forced-colors source/rendered behavior is present.

### Gaps remaining and branch readiness

- Unverified: final native packaged icon appearance in installed Windows/macOS/Linux shells, macOS `.icns` rendering, Windows `.ico`/tile rendering, Firefox/Safari behavior, screen-reader/AT announcements, the deployed GitHub Pages origin, and release/download availability. These require packaged builds, additional browsers/AT, or the deployed environment.
- Known pre-existing risk: two broader canvas/template Playwright cases fail on both base and branch; track separately from this branding change.
- Branch readiness: **GO for branding review/PR**. No P0–P2 branding, responsive, link, build, or accessibility regression was found in the verified scope.

## Theme-aware identity and explorer polish — 2026-08-26

This follow-up supersedes the earlier statements that selected controls retain left-edge inset markers and that selected folder actions remain persistently visible.

### Source and implementation evidence

- Source visual truth: `C:\Users\huang\AppData\Local\Temp\codex-clipboard-e605e238-37e0-4abe-8622-cfd6f025bb26.png` (1442 × 1092 pixels), including the approved Light and Dark Note icon variants.
- Browser-rendered implementations:
  - `C:\Users\huang\AppData\Local\Temp\note-theme-icon-qa\implementation-dark-hover.png`
  - `C:\Users\huang\AppData\Local\Temp\note-theme-icon-qa\implementation-light.png`
- Combined comparison evidence: `C:\Users\huang\AppData\Local\Temp\note-theme-icon-qa\source-implementation-comparison.png` (1600 × 1440 pixels).
- Viewport/state: 1280 × 720 CSS pixels at device pixel ratio 1.25 in the Codex in-app Browser. Returned screenshots are 1280 × 720 pixels, so they were compared at their returned density without resampling. Dark capture shows a selected page with its row hovered; light capture shows the same workspace after the in-app theme toggle.
- Focused-region rationale: the titlebar mark and explorer row are clearly readable in the full-view screenshots at their actual 22px/32px UI scale, so no separate enlarged implementation crop was needed.

### Required fidelity surfaces

- Fonts and typography: no type styles changed. The Note wordmark, explorer labels, toolbar labels, and titlebar hierarchy retain the existing system-font sizing and weights.
- Spacing and layout rhythm: the 22px titlebar logo slot, 32px explorer rows, 24px row-action targets, workbench grid, and toolbar placement are unchanged. Hiding actions does not collapse their grid tracks, so labels do not shift when controls appear.
- Colors and visual tokens: the light titlebar uses the approved warm-white mark and the dark titlebar uses a charcoal derivative with warm-white glyphs and the approved gold stroke. Selected states keep their filled surfaces and focus outlines but no longer use colored left-edge bars.
- Image quality and asset fidelity: the implementation uses real PNG derivatives of the supplied Note mark. The dark mark preserves the supplied geometry, transparent outer corners, gold signature, and source aspect ratio. No CSS, inline-SVG, emoji, or text-glyph approximation was introduced.
- Copy and content: no product copy changed. Existing accessible names for Bookmark, Delete, Create page, More actions, theme toggle, and tree disclosure remain intact.

### Interaction, accessibility, and runtime checks

- PASS — titlebar mark switches from `data-theme-variant="dark"` to `light` with the app theme and loads distinct fingerprinted PNG assets.
- PASS — row Bookmark/Delete/Add page/More actions are hidden at rest, appear on pointer hover, and remain visible when their row or a descendant has keyboard focus. Open menus keep their trigger visible.
- PASS — `@media (hover: none), (pointer: coarse)` keeps row actions visible on touch, hybrid-pointer, and no-hover devices; the folder disclosure button remains visible as the tree item's primary control.
- PASS — selected rail, file, provider, and slash-command states no longer use colored left-edge inset markers. Forced-colors mode retains a 2px `Highlight` outline rather than recreating a left bar.
- PASS — the Windows primary window explicitly sets `skipTaskbar: false`; the Tauri bundle references Linux PNG, macOS ICNS, and Windows ICO assets. File signatures were verified by the branding test.
- PASS — `tauri build --debug --no-bundle` compiled the native Windows application. The embedded executable resource was extracted as `C:\Users\huang\AppData\Local\Temp\note-theme-icon-qa\windows-exe-icon.png` (32 × 32 pixels) and visually matches the approved Note mark.
- PASS — primary app interactions tested: create a note, finish rename, hover the file row, toggle light/dark mode, and inspect both logo states. Browser console errors: none.
- PASS — docs home rendered in dark mode with the dark 48px mark. Docs favicons follow the system color scheme, while the app favicon follows the in-app theme state.

### Findings and comparison history

No actionable P0, P1, or P2 visual, responsive, interaction, or accessibility mismatch remains.

- Initial mismatch: the warm-white mark remained in the dark titlebar. Fix: add a faithful dark raster derivative and select the correct asset from app state. Post-fix evidence: both titlebar variants visibly match the corresponding supplied brand variant.
- Initial mismatch: selected rows and controls used gold left-edge bars. Fix: remove left-edge inset markers while preserving filled selection surfaces and focus/forced-color outlines.
- Initial mismatch: bookmarked and selected explorer items could expose secondary actions without hover. Fix: centralize hidden-at-rest behavior for `.nav-actions` and `.bookmark-toggle`, with hover, focus-within, open-menu, and touch fallbacks. Automated hover/focus checks pass.

### Remaining gaps

- P3/unverified: installed taskbar, Dock, Start-menu, and Linux desktop-shell rendering requires packaged builds on each target OS. Configuration, referenced assets, and Windows/macOS/Linux file signatures are verified locally.
- P3/unverified: manual screen-reader announcements, Safari/Firefox favicon media selection, and physical touch hardware remain outside this local Chromium pass.

final result: passed
