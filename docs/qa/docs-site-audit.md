# Note documentation site audit — 2026-08-27

## Audit scope

- Surfaces: `docs/index.html`, `docs/install.html`, `docs/styles.css`, and the GitHub Pages validation/deployment workflow.
- User goal: understand Note, choose the correct installer, and follow safe first-use and update guidance.
- Accessibility target: WCAG 2.1/2.2 AA-oriented review without claiming full conformance.
- Capture tool: Codex in-app Browser against the local `docs/` server.
- Viewports: 1440×1000, 390×844, and 320×720 CSS pixels. Captures use the browser's dark color scheme.

## Evidence and numbered flow

1. **Home, desktop — healthy.** The hero, real product demo, download call to action, and desktop navigation are clear and balanced.
   - Before: `docs/qa/docs-site-audit/01-home-desktop-before.png`
   - After: `docs/qa/docs-site-audit/06-home-desktop-after.png`
2. **Home, mobile — healthy after fix.** At 320px the navigation now uses a deliberate two-row grid, keeps 44px targets, and has no horizontal overflow.
   - Before at 390px: `docs/qa/docs-site-audit/02-home-mobile-before.png`
   - After at 390px: `docs/qa/docs-site-audit/10-home-390-after.png`
   - After at 320px: `docs/qa/docs-site-audit/07-home-320-after.png`
3. **Install guide, mobile — healthy after fix.** The current page is visually and semantically identified, installer guidance remains readable, and the source-build commands match `docs/INSTALLATION.md`.
   - Before at 390px: `docs/qa/docs-site-audit/03-install-mobile-before.png`
   - After at 390px: `docs/qa/docs-site-audit/11-install-390-after.png`
   - Before at 320px: `docs/qa/docs-site-audit/04-install-320-before.png`
   - After at 320px: `docs/qa/docs-site-audit/08-install-320-after.png`
4. **Unsigned-build notice — healthy after fix.** The notice remains prominent without the deprecated colored left-edge accent.
   - Before: `docs/qa/docs-site-audit/05-warning-left-border-before.png`
   - After: `docs/qa/docs-site-audit/09-warning-card-after.png`

The full-page browser capture was rejected because the animated GIF caused a stitched duplicate of the First Use section. DOM inspection confirmed one section; stable viewport captures above are the accepted evidence.

## Findings resolved

- **Responsive navigation:** the 320px header previously orphaned “All releases” on a left-aligned second row. Navigation is now consistent between pages, uses explicit current-page styling, and changes to a centered two-row grid at the narrowest supported width.
- **Visual consistency:** the callout and unsigned-build notice no longer use colored left borders. They use complete neutral borders and rounded corners while keeping their warning surfaces.
- **Navigation clarity:** Overview, Install guide, and All releases now appear in the same order on both pages. The active page uses `aria-current="page"` and a stronger underline.
- **Skip-link robustness:** both `main` landmarks are programmatically focusable with `tabindex="-1"`.
- **Copy quality:** “GitHub release” now uses consistent sentence-case wording.
- **Regression coverage:** `docs/scripts/validate-site.mjs` replaces the workflow's inline link check. It checks `href`, `src`, and `srcset` assets, fragments, duplicate IDs, language, one `h1`, image alternatives, focusable skip targets, reduced-motion media, and light/dark brand marks.

## Accessibility and visual checks

- Browser DOM snapshots confirm header, navigation, main, section, complementary, and footer landmarks with one `h1` per page.
- The 320px rendered pages have no horizontal overflow. Narrow navigation targets are at least 44px high.
- Source and local assets provide light and dark 48px brand marks; the current dark browser state rendered the dark mark.
- The animated demo has a static PNG `picture` source for `prefers-reduced-motion: reduce`; smooth scrolling and button transitions are also disabled under reduced motion.
- Measured text contrast: light links 6.52:1, light muted text 6.47:1, light warning text 7.36:1, dark links 10.15:1, dark muted text 9.22:1, and dark warning text 9.72:1.
- All official repository, release, installer, and source-build links returned HTTP 200 during this audit. Release `v0.1.0` contains `Note-Setup.exe`, `Note.dmg`, `Note.deb`, `Note.AppImage`, and `SHA256SUMS`.

## Verification

- `node docs/scripts/validate-site.mjs` — passed.
- `npm --prefix frontend run test:branding` — passed.
- `npm run build` — passed; Vite retains its pre-existing large-chunk advisory.
- `git diff --check` — passed.
- Accessibility specialist — GO; no Must Fix or Should Fix findings.
- UI/UX reviewer — GO after the narrowest navigation was made text-scaling resilient.

## Evidence limits and deployment blocker

- Not verified: Safari/Firefox media selection, a physical screen reader, 200% browser text zoom, or platform-specific installer execution.
- The deployed URL `https://tyhuang9.github.io/note/` currently returns 404. GitHub reports `has_pages: false`, and the latest main-branch Pages run failed while `actions/configure-pages@v6` tried to create the Pages site with `Resource not accessible by integration`.
- The checked-in workflow already grants `pages: write` and `id-token: write`; enabling GitHub Pages with **GitHub Actions** as the source requires repository-admin configuration outside this branch. After that setting is enabled, rerun **Publish Documentation** and verify both deployed pages.

## Final result

**Passed for local implementation and PR review.** The checked-in site is responsive, semantically sound, link-valid, and visually consistent. Public availability remains blocked by the repository-level GitHub Pages setting described above.
