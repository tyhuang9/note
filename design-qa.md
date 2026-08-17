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

---

## Canvas Text and Compact-Properties Follow-up QA — 2026-08-17

### Source and Same-state Evidence

- Source visual truth 1: `C:\Users\huang\.codex\attachments\ff03dfbf-6956-4879-a530-5ec7860362c5\image-1.png`, 505x345 pixels; dark mixed primitive/text selection held mid-drag before pointer-up.
- Implementation 1: `design-qa-evidence/implementation-mixed-live-drag-dark-505x345.png`, 505x345 pixels; CSS viewport 505x345, DPR 1.
- Full-view comparison 1 (source left, implementation right): `design-qa-evidence/comparison-reference1-live-drag-505x345.png`, 1010x345 pixels.
- Source visual truth 2: `C:\Users\huang\.codex\attachments\ff03dfbf-6956-4879-a530-5ec7860362c5\image-2.png`, 280x224 pixels; dark overflowed properties panel.
- Implementation 2: `design-qa-evidence/implementation-properties-overflow-dark-280x224.png`, 280x224 pixels; CSS viewport 280x224, DPR 1.
- Full-view comparison 2 (source left, implementation right): `design-qa-evidence/comparison-reference2-properties-dark-280x224.png`, 560x224 pixels.
- Supplemental responsive states: `design-qa-evidence/implementation-properties-overflow-light-280x224.png` and `design-qa-evidence/implementation-properties-overflow-200pct-280x224.png`, each 280x224 pixels at DPR 1.
- Density normalization: none required; every source and implementation pair was captured at identical CSS and pixel dimensions.

### Environment and State

- Fresh isolated Vite preview: `127.0.0.1:4175`; port 4173 was not started or used.
- Browser: Playwright Chromium. Console and page-error listeners reported no errors in the 505x345 dark live-drag and 280x224 dark/light/200% capture flows.
- Product chrome is intentionally retained. The comparisons assess the requested selection-frame and inset-scrollbar behavior rather than cloning Excalidraw's unrelated navigation/toolbar composition.

### Findings and Iteration History

| Pass | Severity | Finding | Resolution and post-fix evidence |
| --- | --- | --- | --- |
| 1 | P2 | At 280x224 with effective 200% text sizing, the compact properties panel had horizontal overflow: panel client width 214px vs scroll width 244px. Visible contributors were `.drawing-property-section` and `.drawing-color-picker`. | Resolved in product commit `aec68ec` by allowing the color-picker controls to wrap. Pass 2 confirms `scrollWidth <= clientWidth`; `implementation-properties-overflow-200pct-280x224.png`. |
| 2 | None | No actionable P0/P1/P2 differences remain in the same-state reference comparisons. The live composite frame follows the moving clones with no stale origin frame; the compact dark panel uses the thin, themed, inset scrollbar contract. | `comparison-reference1-live-drag-505x345.png`; `comparison-reference2-properties-dark-280x224.png`. |

### Required Fidelity Surfaces

- Fonts and typography: Note's existing compact system UI and text controls remain internally consistent; no new font or hierarchy drift appeared in the reference-sized states.
- Spacing and layout rhythm: the live frame encloses the moved mixed selection and tracks its pointer delta; the compact panel stays within the 280px viewport after the 200% reflow correction.
- Colors and visual tokens: dark scrollbar is thin with the dark themed thumb/track; light mode receives its distinct themed token. Selection and active controls retain the existing purple state token.
- Image quality and asset fidelity: these behavior references contain no application image asset that needs recreation. No image, icon, or placeholder substitution was introduced.
- Copy and content: `Properties`, section labels, controls, and text-selection labels remain readable at the captured compact state.

### Interaction and Supplemental Checks

- Held the mixed-selection pointer gesture before pointer-up; asserted two live drag clones, one composite frame, and a 44px/26px frame delta matching the gesture.
- Verified native all-text selection outlines without a composite frame and keyboard focus on a text header: `canvas-selection-bounds.spec.ts`.
- Verified mixed resize scales non-text geometry while preserving text dimensions: `canvas-selection-bounds.spec.ts`.
- Verified the default rounded rectangle preference and explicit sharp override persistence: `sqlite-persistence-contract.spec.ts`.
- Verified an edited textbox activates the slash-command menu only at supported boundaries: `slash-command-menu.spec.ts`.
- Verified compact dark, light, and effective-200% property-panel states for overflow, clipping, and themed scrollbars.

### Result

`final result: passed`
