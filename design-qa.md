# Drawing Editor Design QA

## Result

`final result: passed`

No unresolved P0, P1, or P2 visual findings remain.

## Source of Truth

- Primary reference: conversation attachment Image 1, Excalidraw at 1662x839 CSS pixels. The client did not expose a filesystem path for this attachment.
- Supplemental repeatable capture: `design-qa-evidence/reference-excalidraw-live-1662x839.png`.
- Supplemental selected-state capture: `design-qa-evidence/reference-excalidraw-selected-1662x839.png`.
- Approved product-specific differences: the editor retains Note's application chrome and light/dark theme tokens, uses the planned 44px tool targets, and uses the planned 252px contextual panel rather than cloning unrelated Excalidraw chrome.

## Connector-binding regression review

- Issue reference 1: `C:\Users\huang\.codex\attachments\adac0fee-cfc9-455b-9564-b4dc6db3ae8a\image-1.png`, 1659x830 CSS pixels. It showed authoring controls in an empty dark workspace; the approved state omits all canvas authoring chrome until a non-template page and viewport are available.
- Issue reference 2: `C:\Users\huang\.codex\attachments\adac0fee-cfc9-455b-9564-b4dc6db3ae8a\image-2.png`, 1069x598 CSS pixels. It highlighted rough-shape edge clipping and provided the target composition for rough ellipses and connectors.
- Same-state implementation evidence: `implementation-empty-dark-1659x830.png`, `implementation-arrow-anchors-dark-1069x598.png`, `implementation-arrow-preview-dark-1069x598.png`, `implementation-bound-arrow-dark-1069x598.png`, `implementation-group-selection-light-1069x598.png`, and `implementation-group-selection-dark-1069x598.png`.

## Verification Environment

- Desktop viewport: 1662x839 CSS pixels, device pixel ratio 1.
- Compact viewport: 320x640 CSS pixels, device pixel ratio 1. The 320px reflow state also covers the effective CSS width produced by 200% browser zoom on a 640px-wide viewport.
- Connector-binding viewport: 1069x598 CSS pixels, device pixel ratio 1.
- Empty-workspace viewport: 1659x830 CSS pixels, device pixel ratio 1.
- Browser: Playwright Chromium.
- States: light defaults, light selected rectangle, dark selected rectangle, compact dark panel open, dark empty workspace, dark rough ellipses with arrow anchors, solid live arrow preview, bound arrow, and light/dark group selection.
- Console and page errors: none in either capture flow.

## Evidence

- Full light editor: `design-qa-evidence/implementation-light-1662x839.png`.
- Selected rectangle in light theme: `design-qa-evidence/implementation-selected-light-1662x839.png`.
- Full dark editor: `design-qa-evidence/implementation-dark-1662x839.png`.
- Compact dark editor: `design-qa-evidence/implementation-compact-dark-320x640.png`.
- Focused toolbar: `design-qa-evidence/implementation-toolbar-light.png`.
- Default properties panel: `design-qa-evidence/implementation-properties-light.png`.
- Selected-object properties panel: `design-qa-evidence/implementation-properties-selected-light.png`.
- Empty dark workspace without authoring controls: `design-qa-evidence/implementation-empty-dark-1659x830.png`.
- Dark rough-ellipse anchors while Arrow is active: `design-qa-evidence/implementation-arrow-anchors-dark-1069x598.png`.
- Solid, full-opacity arrow creation preview: `design-qa-evidence/implementation-arrow-preview-dark-1069x598.png`.
- Bound arrow between cardinal shape anchors: `design-qa-evidence/implementation-bound-arrow-dark-1069x598.png`.
- Group selection hover state in light and dark: `design-qa-evidence/implementation-group-selection-light-1069x598.png` and `design-qa-evidence/implementation-group-selection-dark-1069x598.png`.

## Findings and Resolutions

| Severity | Finding | Resolution | Post-fix evidence |
| --- | --- | --- | --- |
| P1 | The visually hidden custom-color labels were not hidden, crowding and clipping the swatches. | Added the standard one-pixel visually-hidden treatment within the custom color control. | `implementation-properties-light.png` |
| P1 | Theme-derived strokes used the workbench text token, which remained light in the light canvas theme and made default shapes and ink nearly invisible. | Switched theme-derived ink and primitive strokes to the canvas foreground token. | `implementation-selected-light-1662x839.png` |
| P1 | At 320px, the legacy workspace minimum width allowed focus scrolling to carry the toolbar and properties panel outside the viewport. | Corrected the collapsed-shell grid override, fixed compact overlays to viewport edges, and prevented canvas focus scrolling. Added viewport-bound assertions. | `implementation-compact-dark-320x640.png` |
| P2 | The bottom canvas controls could overlap the open compact properties sheet. | Hide the canvas controls while the compact sheet is open; the sheet retains internal vertical scrolling. | `implementation-compact-dark-320x640.png` |
| P2 | The selection frame sat directly on top of the selected object's rough stroke. | Added four screen-space pixels of selection-frame padding so both the object and selection affordance remain legible. | `implementation-selected-light-1662x839.png` |
| P2 | The shared southeast resize class could leave the ink resize control at its static origin, beneath the selection move surface. | Anchored the ink control explicitly to the element's southeast corner and added a browser assertion that the resize target wins hit testing. | `implementation-selected-light-1662x839.png` |

## Comparison Review

- Typography: compact system sans-serif labels match the reference control density and remain consistent with Note's existing interface.
- Spacing and geometry: the toolbar uses fixed 44px targets and horizontal overflow; the 252px panel preserves section rhythm without the original squashing.
- Color and hierarchy: neutral surfaces, subtle borders, and purple active/selection states match the reference hierarchy in both themes.
- Icons: visible controls use the Lucide icon library; no placeholder glyphs, emoji, custom SVG approximations, or CSS-drawn assets were introduced.
- Copy: tooltips expose the requested names and shortcuts; properties context labels distinguish defaults from selected-element editing.
- Responsive behavior: toolbar and panel remain fully within the 320px viewport, targets do not shrink, the toolbar scrolls, and the panel scrolls vertically.

## Interaction Checks

- Activated Rectangle from the toolbar and created a visible default object.
- Verified selection styling and contextual properties.
- Toggled light/dark theme and observed panel/token updates.
- Opened compact properties through Adjustments at 320px.
- Verified toolbar roving focus, 44x44 targets, horizontal scrolling, in-viewport bounds, and zero canvas horizontal focus scroll.
- Verified single-shape corner controls, connector endpoint controls, and one enclosing frame for mixed primitive selections.
- Verified the selected-ink resize target wins pointer hit testing while the remaining bounded interior stays draggable.
- Captured both implementation and official Excalidraw at the same 1662x839 viewport and compared the selected-object state together.
- At 1659x830 with no live canvas page, asserted the drawing toolbar, properties panel, and image-file control are absent.
- At 1069x598, created two thick Cartoonist ellipses fully inside the viewport, confirmed four visual-only cardinal anchors per ellipse while Arrow is active, and captured the result.
- Held an arrow creation gesture to assert a solid, `opacity="1"` live preview, then released it onto both cardinal anchors; both selected endpoint handles resolve within two CSS pixels of their source anchors.
- Moved a source ellipse by 10 world pixels through keyboard interaction and confirmed the bound arrow follows instead of retaining a stale free endpoint.
- Marquee-selected the bound group in light and dark, hovered its drag surface, and asserted computed `background-color: rgba(0, 0, 0, 0)` in both themes; screenshots confirm there is no grey selection fill.

## Remaining P3 Notes

- Native color-picker presentation can vary by operating system; the trigger is stable and accessible.
- The properties sheet intentionally scrolls internally on short compact viewports so all controls remain reachable without reducing touch targets.
