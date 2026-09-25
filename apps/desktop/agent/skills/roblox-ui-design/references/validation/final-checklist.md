# UI Final Checklist

Use after implementation.

## Structure
- [ ] Creation vs edit was correctly identified.
- [ ] Exactly one semantic layout selected for new UI.
- [ ] With SIM/STUDS, the recovered theme body and matching recovered selected layout body were loaded and followed.
- [ ] Ordinary builder starts with the layout marker; canonical templates preserve their managed prefix before it.
- [ ] Specialized layout used exact template deployment, not hand-authored geometry.
- [ ] Existing UI edit did not create a second builder or ScreenGui.

## Geometry
- [ ] Active selected body's Measurements/Rules were checked against the rendered result.
- [ ] Correct skeleton and intended panel/card aspect ratios.
- [ ] No overlap or clipped half-row/card.
- [ ] No unintended dead bottom/side band.
- [ ] Main action hierarchy is visible by size/position.
- [ ] Ultrawide/narrow viewport does not independently stretch the composition; pixel-authored/reference compositions scale uniformly.
- [ ] Core gameplay center remains open for HUD/sidebar/clicker/toast where required.
- [ ] Top-left 350×70 Core UI keep-out respected unless existing project intentionally owns it.

## Reference image
- [ ] If a mockup/screenshot was supplied, its outer footprint/aspect, header proportions, grid geometry, card aspect, relative typography/art/button scale, and negative-space distribution were compared directly against the rendered screenshot.
- [ ] Gross proportional differences were fixed before decorative differences.

## Content
- [ ] First render has representative hardcoded demo content.
- [ ] State-dependent layouts demonstrate meaningful states.
- [ ] One product per shop card.
- [ ] Leaderboard values strictly descend.
- [ ] Progression rows each contain goal/progress/reward.
- [ ] Select screen has exactly one active selection.
- [ ] Admin active category matches visible page.

## Assets
- [ ] Exact theme/layout/template IDs used where mandated.
- [ ] Ordinary semantic icons came from `resolve_icon` or verified project art; Creator Store was only a bounded essential-content fallback.
- [ ] Repeated card art is visually coherent as a set.
- [ ] No unresolved decal/library ID was assumed to be a runtime image ID.
- [ ] No invented IDs / emoji substitutes.
- [ ] `ScaleType.Fit` and aspect preservation.
- [ ] Full-colour catalog icons not tinted.

## SIM
- [ ] Recovered SIM scaffold/construction followed for the active layout.
- [ ] White rounded card where panel layout applies; navy linework.
- [ ] Bare stroked title, no title bar; side icon locked to title.
- [ ] Straddling red close.
- [ ] Sticker buttons carry the required Border-mode navy stroke and action-semantic gradient.

## STUDS
- [ ] Square four-layer bevel construction from the recovered body.
- [ ] Black stroke 4 on visible component bases.
- [ ] Non-title faces keep the required vertical shine/gradient.
- [ ] Stud tile density reads clearly at screenshot scale.
- [ ] Title icon/title/close geometry matches recovered body; close is inside title bar.
- [ ] Integral asset IDs used exactly.
- [ ] Interactive targets meet minimum size.

## Validation
- [ ] `inspect_ui` audit ran on the live client after the last interface change and reported no problems (Roqer will not verify the run otherwise).
- [ ] The latest post-mutation screenshot was successfully delivered before visual claims were made.
- [ ] Screenshot acquisition itself was not treated as proof of correctness.
- [ ] Structural/proportional defects fixed before cosmetic polish.
- [ ] Interactive path tested with `interact_ui` or fresh coordinates when relevant.
- [ ] Expected visible state asserted after input.
- [ ] Retry loop remained bounded.
