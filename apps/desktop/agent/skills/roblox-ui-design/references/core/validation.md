# Validation Protocol

## Structural and visual evidence

After creating a new UI or making a meaningful visual edit:

1. Start the smallest useful solo playtest when runtime rendering is needed.
2. Run `inspect_ui {mode: 'audit'}` on the live client, rooted at the screen. It measures what a screenshot review misses and Roqer requires it: a run that changed interface is not verified until an audit after the last interface change comes back clean. Fix every finding, rerun the audit, and repeat:
   - `text_obscured`: another element with a higher ZIndex covers the letters (a badge over a title). Move the badge off the text or give the text room, for example by narrowing its label or reserving a badge column.
   - `text_straddles_edge`: text sits partly on and partly off a painted element (a balance running under its "+" button, a "-20%" hanging off a price button). Lay them out side by side with a `UIListLayout` or padding, or put the text wholly inside the element.
   - `content_beyond_scroll`: content extends past its ScrollingFrame's canvas, so no scrolling reaches it. Use `AutomaticCanvasSize` on the scrolling axis, or size the canvas to the content, including padding.
   - `text_overflow`: the text does not fit its label; widen it, wrap it, or shorten the string. `TextScaled` hides the problem by shrinking the text.
   - `fully_clipped_interactive`, `zero_size_interactive`, `element_outside_viewport`: a control the player cannot see or press.
   Use `inspect_ui` in inspect mode as well where you need hierarchy, bounds, styles or stable selectors.
3. Capture one screenshot of the latest post-mutation UI.
4. Perform a visual review before considering the visual task complete.

During that review, compare the screenshot against the active recovered theme/layout body. Review in this order:

1. overall footprint and scale;
2. panel/card proportions and layout geometry;
3. content density and unused/dead space;
4. clipping, overflow, overlap, or partial rows;
5. title/action hierarchy and relative text/icon/button scale;
6. theme construction consistency;
7. polish-layer state and detail (`references/core/polish.md` Review);
8. minor cosmetic polish.

A screenshot being successfully captured is not a passing visual result.

### Repair gate

If the screenshot has an obvious structural or proportional defect, make one targeted repair that addresses that concrete defect while preserving parts that are already correct. Then validate the repaired revision from a fresh playtest and review its new screenshot.

Examples of defects that require repair:

- the panel is much wider/taller than the recovered layout intends;
- cards are stretched or have obviously wrong aspect ratios;
- a large part of the panel is unused while content occupies only a small area;
- the final row/content ends far above the bottom of a panel that could be contracted;
- text/icons/actions are tiny relative to their containers;
- content is clipped, overlapping, or partially visible;
- the UI visibly contradicts the active recovered theme/layout construction.

Do not redesign a screen merely because another aesthetic choice might also work. Minor cosmetic preferences do not require another pass. Allow at most two visual repair passes. If a major defect remains after two repairs, stop and report that visual verification is incomplete.

Report visual claims only after the screenshot image is returned successfully. If the turn reports that the image exceeded its limit, retry once as JPEG at lower quality.

## Playtest freshness and validation cycles

A playtest is fresh only for the UI/script state that existed when that playtest started.

- If a UI- or runtime-affecting mutation happens after the current playtest started, stop the stale playtest and start a fresh one before validating the changed result.
- If no such mutation happened, reuse the current playtest. Never restart merely to reconfirm an unchanged revision.
- Never call playtest start while a playtest is already running.
- A runtime interaction does not by itself make the code/UI revision stale. Restart only when a required independent scenario genuinely needs clean state that cannot be restored in-place.

For one unchanged UI/script revision, perform at most one normal validation cycle. For a straightforward visual-only creation, that cycle is:

1. inspect the live UI;
2. read runtime logs only when they are relevant to the requested result or reveal an obvious runtime problem;
3. capture the post-mutation screenshot;
4. review it against the active recovered body.

If that passes and no repair mutation is needed, stop the playtest and finish. Do not run another validation cycle for confidence alone.

## Interaction is conditional

Do **not** treat every created UI as an interaction-testing task. Interaction evidence is required only when:

- the user explicitly requested behavior or a working interaction;
- the selected layout's requested function cannot reasonably be considered complete without exercising that action; or
- interaction is necessary to expose the visual state that must be reviewed, such as one other tab of a tabbed screen.

When interaction is required, exercise the smallest representative set of actions once and observe their postconditions. Prefer `interact_ui` with a selector that resolves exactly one live element. If semantic interaction cannot express the action, derive fresh viewport coordinates from `inspect_ui` or `capture_screenshot` and use `simulate_mouse_input`.

Do not click every button merely because it exists. In particular, for a static visual-only screen creation, do not test a Close button if that only hides the UI and forces another playtest/screenshot. Input delivery alone is not success; when an interaction is required, inspect the state that should have changed.

Read logs from the runtime peer that produced them. Stop every playtest you start, even after a failed check.

## Retry limit

- Stop after three failed fix attempts for the same defect.
- Stop when the same defect remains after two consecutive fixes.
- Do not perform a second validation cycle on an unchanged revision just because the first cycle passed and you want more confidence.

Do not enter an open-ended edit, screenshot, interaction, or playtest loop.
