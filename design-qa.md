# Canvas Geometry Polish — Product Design QA

## Result

`final result: passed`

No unresolved P0, P1, or P2 visual findings remain for the six-item canvas geometry scope.

## Final State

- Product runtime: `9d0a804` on `agent/final-geometry-integration-fixes-v6`.
- Browser: Playwright Chromium, device pixel ratio 1.
- Isolated capture server: `http://127.0.0.1:4327`.
- Capture test: `frontend/tests/e2e/geometry-polish-design-qa.spec.ts`, 1/1 passed.
- Runtime diagnostics during the capture flow: 0 console errors and 0 page errors.
- Unrelated toolbar and property chrome was hidden only in the comparison captures so the supplied canvas states and implementation states use the same visual framing. Product behavior was not altered.

## Source and Implementation Comparisons

Each source and implementation image in a pair has identical pixel dimensions. The combined images place the supplied source on the left and the final implementation on the right without scaling.

| State | Supplied source | Final implementation | Combined evidence |
| --- | --- | --- | --- |
| Selected textbox, connector-label gap, and embedded shape text | `C:\Users\huang\.codex\attachments\feea1257-32a4-4660-8533-292e9ab80b2f\image-1.png` — 1017×685 | `design-qa-evidence/implementation-native-text-compact-label-dark-1017x685.png` — 1017×685 | `design-qa-evidence/comparison-1-native-text-compact-label.png` — 2034×685 |
| Markerless selected diamond | `C:\Users\huang\.codex\attachments\feea1257-32a4-4660-8533-292e9ab80b2f\image-2.png` — 406×408 | `design-qa-evidence/implementation-markerless-diamond-dark-406x408.png` — 406×408 | `design-qa-evidence/comparison-2-markerless-diamond.png` — 812×408 |
| Shape text editing without an outer selection box | `C:\Users\huang\.codex\attachments\feea1257-32a4-4660-8533-292e9ab80b2f\image-3.png` — 371×425 | `design-qa-evidence/implementation-centered-shape-edit-dark-371x425.png` — 371×425 | `design-qa-evidence/comparison-3-centered-shape-edit.png` — 742×425 |

Aggregate comparison board: `design-qa-evidence/board-geometry-polish-source-implementation.png` — 2034×1566.

Supplemental final states:

- Live arrow-label editing with the real shaft gap already present: `design-qa-evidence/implementation-arrow-label-edit-dark-1017x685.png`.
- Single transparent textbox using only its native seamless selected border/header: `design-qa-evidence/implementation-seamless-text-selection-dark-560x300.png`.

## Findings and Resolution History

| Severity | Supplied-state finding | Final resolution and evidence |
| --- | --- | --- |
| P1 | Connector labels could occupy a gap much wider than the rendered text and could appear detached from the actual shaft center. | Upright gaps now use the exact centered line/label-rectangle intersection plus four world units. The label remains centered on the visible shaft. The implementation comparison and live-edit supplemental capture show the compact real gap before commit. |
| P1 | Selected textboxes and shapes displayed persistent cardinal/corner dots, adding visual noise. | All eight resize zones remain accessible and cursor-driven but visually transparent. The textbox comparison uses only the existing native border/header; the diamond comparison shows its selection outline without dots. |
| P1 | Shape editing retained an unrelated outer selection rectangle, and entering edit mode could move short text vertically. | Editing suppresses selection/root outlines. The measured editor content center stays within two pixels of the display center at 50%, 100%, and 200%; the final comparison shows the centered, outline-free editing state. |
| P1 | The first aggregate review found that post-transform size clamps could move the fixed opposite resize edge and that shared image resize ignored media minimums. | Clamp dimensions are now resolved before position from the fixed opposite local point. Shapes/ink use an 8-unit minimum; images use 80×60 minimum and 4000 maximum width. All eight rotated handles have invariant unit coverage. |
| P1 | The visually hidden textbox header remained focusable and clickable while editing. | The editing header is now an inert, aria-hidden, role-less, untabbable, pointer-inert layout spacer. Shift+Tab and header-region pointer tests retain the active editor and caret. |

## Fidelity Review

- Geometry: connector gaps match the rendered label footprint; markerless hit zones do not change selected-object bounds; shape text is geometrically centered; the fixed opposite edge survives minimum/maximum clamps.
- Typography: connector and embedded-shape labels use the existing system font and theme foreground with no mask or pill. Text remains readable against the canvas/shape fill.
- Color and hierarchy: existing purple selection/focus tokens remain, while redundant resize dots and editing outlines are removed. The object itself, caret, and active border carry the hierarchy.
- Spacing: the textbox border stays continuous at its right edge; the connector gap has only the specified breathing room; no new panel or canvas spacing was introduced.
- Responsive and zoom behavior: focused browser coverage passed at 50%, 100%, and 200% for textbox editing, shape centering, resize geometry, connector following, and pointer-relative paste.
- Accessibility-adjacent UX: invisible resize zones retain accessible labels, keyboard resizing, focus rings, and 44px interaction targets. Editing does not expose an invisible header control.

## Interaction Verification

- Selected a single transparent textbox and verified there is no redundant external border, visible resize marker, or move surface; its own top grip remains the drag affordance.
- Opened an arrow label editor and verified the compact line break is present before commit and remains centered on the shaft.
- Selected a diamond and verified eight invisible resize zones with correct cursors and no visible dots.
- Entered shape text editing from the selected overlay and verified the selection frame disappears while the editor retains focus and centered content.
- Verified empty/short shape text centers and long multiline content top-aligns without clipping.
- Verified all-text group resize, pointer-position paste, image limits, cancel, undo/redo, and reload through focused automated suites.

## Remaining P3 Notes

- Chromium was the visual comparison browser. Firefox, WebKit/Safari, physical high-DPI devices, and manual screen-reader sessions were not run.
- The production build retains its pre-existing JavaScript chunk-size warning; this visual geometry stack did not materially change that condition.
- The full inherited Chromium inventory contains obsolete tests for superseded single-click typing, visible east-only handles, and shape text card surfaces. Current acceptance suites for the requested behavior pass; legacy cleanup is tracked separately from this visual approval.

`final result: passed`
