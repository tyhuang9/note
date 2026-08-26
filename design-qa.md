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
- Colors and visual tokens: existing dark surfaces and purple selection remain. The menu uses Note's neutral dark tokens; Delete receives a restrained destructive color while retaining sufficient contrast.
- Image quality and asset fidelity: no raster substitutes or new generated artwork were introduced. Folder, add-page, bookmark, rename, delete, and ellipsis symbols use the existing Hero-style icon system.
- Copy and content: Codex-specific project actions were adapted to Note rather than copied. The shared options are `Bookmark`/`Remove bookmark`, `Rename`, and `Delete`; the direct row action remains `Create page in {folder}`.

## Interaction and runtime checks

- More button: passed; opens the shared menu, reports `aria-haspopup="menu"`, updates `aria-expanded`, and focuses the first item.
- Right-click: passed in Files and Favorites; opens the identical three ordered actions.
- Keyboard: Arrow Down and End move focus; Escape returns to More; Shift+Tab returns to Add page; Tab advances past More without dropping focus to the document body.
- Focus recovery: deleting a folder or removing it from Favorites focuses the nearest surviving folder action, Create folder, or the active labelled rail control.
- Reflow and contrast: the rendered menu is measured and clamped at an 8px viewport margin, including a 1024 × 220 edge case. The light-theme focus outline uses solid `#6d28d9`, exceeding the 3:1 non-text contrast requirement.
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
