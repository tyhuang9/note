# Slash Menu Design QA

**Source visual truth path**

- Four Notion slash-menu screenshots attached to the user's implementation request. The attachments are conversation-scoped and the client did not expose a local filesystem path.
- The approved product plan intentionally uses those screenshots as an interaction-density reference while retaining Note's own colors, icons, typography, and 340px/360px popup constraints.

**Implementation evidence**

- Full dark state: `docs/qa/note-slash-menu-dark-full.png`
- Focused dark popup: `docs/qa/note-slash-menu-dark-popup.png`
- Focused light filtered popup: `docs/qa/note-slash-menu-light-filtered.png`

**Viewport and normalization**

- Full implementation viewport: 1280 × 800 CSS px, Chromium, device scale factor 1.
- Focused implementation popup: 340 × 360 CSS px and 340 × 360 output pixels.
- Source screenshots are narrow desktop popup crops at their supplied display density. They were compared as interaction and hierarchy references, not as a pixel-identical clone target; the approved Note dimensions supersede the larger Notion popup dimensions.
- State compared: empty-query dark menu, filtered light menu, selected first option, grouped results, hints, and close footer.

**Full-view comparison evidence**

- The popup sits below the active canvas caret, remains visually unscaled at 100% canvas zoom, and has sufficient separation from Note's floating text toolbar and canvas controls.
- Note's purple focus and selected-row treatment stays consistent with the selected textbox and existing workbench accent.
- The body-mounted surface is not clipped by the canvas or side panels and reads as an editor command surface rather than a canvas object.

**Focused-region comparison evidence**

- Typography: labels, secondary descriptions, category headers, hints, and footer have a clear five-level hierarchy. The shared system font and compact weights match Note's workbench, and command copy wraps without information loss at 200% text size.
- Spacing and layout rhythm: 34px icon tiles, 52px minimum rows, 6px menu inset, 10px row gaps, 10px radius, and a fixed footer produce a compact but scannable menu. Overflow is contained in the list, not the footer.
- Colors and tokens: dark and light surfaces preserve readable foreground/secondary contrast; the selected state uses Note purple in both themes without losing the label or description.
- Image and icon quality: no raster imagery is required. All visible icons use the shared Note HeroIcon renderer and remain crisp at 1x capture density.
- Copy and content: command labels, descriptions, markdown hints, category names, `No commands found`, and `Close menu / Esc` are concise and consistent with the approved catalog.
- Interaction states: Playwright verified hover, selected, filtered, empty, dark/light, narrow viewport, 50%/100%/200% canvas zoom, keyboard navigation, and dismissal behavior.
- Browser diagnostics: the rendered slash-menu flow was exercised with `console.error` and uncaught page-error listeners; no browser errors were emitted.

**Findings**

- No actionable P0, P1, or P2 visual differences were found against the approved Note-specific target.
- Resolved after independent review: the results pane now reserves a stable scrollbar gutter and shows a bottom-edge overflow cue only while more commands remain below. Hover and active rows use distinct treatments, command hints have stronger contrast, and the active option has a non-color inset indicator.

**Open questions**

- NVDA announcement cadence, native IME behavior, and non-US slash-key layouts require manual testing on the target Windows/Tauri environment.

**Comparison history**

- Pass 1: compared the supplied reference screenshots with the dark full view, focused dark popup, and focused light filtered popup. No P0/P1/P2 findings required a visual-fix iteration.
- Pass 2: independent review identified missing scroll affordance and ambiguous simultaneous hover/active styling. The menu added a stateful overflow cue, stable scrollbar gutter, neutral non-active hover, stronger hints, keycap styling, and a high-contrast active indicator. Post-fix evidence: `docs/qa/note-slash-menu-dark-popup.png`. No P0/P1/P2 visual findings remain.
- Pass 3: accessibility review identified ellipsized copy at enlarged text sizes. Labels and descriptions now wrap, and a 320px viewport test verifies full copy and horizontal containment at 200% text size.

**Implementation checklist**

- [x] Note-native light and dark surfaces
- [x] Clear selected, hover, grouped, filtered, and empty states
- [x] 340px viewport-clamped width and 360px maximum height
- [x] Fixed footer and independently scrollable options
- [x] Stable screen scale under canvas zoom
- [x] Shared icon language and purple accent
- [x] Reduced-motion treatment

final result: passed
