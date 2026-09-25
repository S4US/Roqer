---
name: roblox-ui-design
description: "Mandatory design route for creating or editing Roblox screens: menus, HUDs, shops, dialogs, inventories, leaderboards, notifications, wheels, and reels. Uses recovered canonical SIM/STUDS theme+layout bodies, exact specialized templates, curated assets, and bounded visual validation."
---

# Roblox UI Design

Use this skill for the visual structure and implementation of Roblox UI. Roqer's Studio operation contract is already in your developer instructions, so a UI build does not need `roblox-studio-mcp`. Load `roblox-gui` only when the task materially needs engine-side UI behavior such as focus/input, safe-area/container behavior, state ownership, scrolling/lifecycle, or game wiring; do not load it for a straightforward static visual build.

For UI work this skill owns **composition and visual construction**. When `roblox-gui` is also active, it owns engine behavior and containment only and must not replace geometry required by the selected UI-design body.

## Route before loading detail

First decide whether the request creates a new UI or edits an existing one.

### Creation

The host marks clear UI-creation requests so this entrypoint is not optional. Minimize skill-loading turns.

1. Resolve the requested theme and semantic layout from the user request when they are already obvious. Inspect nearby UI/builders first only when project context can actually change that route.
2. For a normal new UI, load all resources needed for the chosen route in **one `load_skill` call after this entrypoint**:
   - `references/core/generation.md`
   - `references/core/assets.md`
   - `references/core/validation.md`
   - `references/core/polish.md`, except for `wheel-spin` and `vertical-reel-roll`
   - with **SIM**: `references/themes/recovered/sim-1.md`, `sim-2.md`, `sim-3.md`, and `references/selected/sim/<layout>.md`
   - with **STUDS**: `references/themes/recovered/studs-1.md`, `studs-2.md`, and `references/selected/studs/<layout>.md`
   - with no packaged theme: the chosen generic layout reference instead of recovered theme/selected-body resources
   - for `wheel-spin` or `vertical-reel-roll`: also load the specialized contract and exact `(theme, layout)` Lua template in that same call.
3. Recovered theme parts are authoritative for construction/style; the recovered selected body is authoritative for geometry/composition. Do not also load the short generic layout reference when a recovered selected body is active.
4. Resolve all ordinary icons with one `resolve_icon` call. Exact assets named by the active recovered theme/layout or specialized template always win. Never invent IDs or substitute drawn/emoji shapes for a catalog icon.

If project inspection was genuinely required before the route could be known, one additional route-resource load after that inspection is acceptable. Do not split a known route across several model turns.

One result carries a bounded amount of text, so a large route (every SIM route) comes back with some resources listed as "not loaded yet". Load exactly those in one more call before writing any UI; that second call is part of the route, not a split. Never build from a theme or selected body you have not received in full.

The polish layer is part of a finished screen: motion, merchandising states, and finishing detail on top of the theme. It never overrides theme construction or selected-body geometry.

### Reference-image creation

When the user supplies a screenshot/mockup and asks to reproduce it, the image is the **primary composition specification**. Preserve its UI footprint/aspect, panel placement, header proportions, rows/columns, card aspect ratios, gaps/padding, relative text/icon/button scale, density, negative-space distribution, and visible-world ratio. Theme guidance changes construction/style; the semantic layout fills only details the image leaves unspecified.

For reference-image reconstruction only, a coherent pixel design canvas plus uniform root `UIScale` may be appropriate when that is needed to preserve the supplied image's proportions across a different viewport. Do not apply that technique to an ordinary selected layout whose measurements are expressed directly in ScreenGui/viewport Scale values.

### Editing

Load [editing](references/core/editing.md), locate the current builder, and preserve its identity, layout, theme, and unrelated geometry. Do not classify or load a new layout unless the user explicitly requests a structural redesign. If an edit adds a component to an existing SIM/STUDS screen, load the recovered active-theme parts and `references/selected/<theme>/<layout>.md` only when exact sibling construction is not already visible in source.

## Layout taxonomy for new UI

| Layout | Use for |
|---|---|
| [shop-grid](references/layouts/shop-grid.md) | Shops, stores, gamepasses, bundles, multi-item offers |
| [centered-dialog](references/layouts/centered-dialog.md) | Confirmation, rebirth, offline earnings, small blocking prompts |
| [fullscreen-landing](references/layouts/fullscreen-landing.md) | Title, play, intro, loading, or round-start screens that block the world |
| [admin-control-panel](references/layouts/admin-control-panel.md) | Staff, moderation, owner, or developer command consoles |
| [hud-zone-system](references/layouts/hud-zone-system.md) | Always-on gameplay stats, bars, timers, and actions |
| [select-screen](references/layouts/select-screen.md) | Compare options, then commit to one character, class, team, map, or role |
| [grid-inventory](references/layouts/grid-inventory.md) | Owned item, pet, backpack, storage, equip, or drop flows |
| [vertical-navigation-sidebar](references/layouts/vertical-navigation-sidebar.md) | Persistent labelled edge navigation over gameplay |
| [progression-hub](references/layouts/progression-hub.md) | Quests, achievements, daily goals, battle pass, and claimable rewards |
| [stat-leaderboard](references/layouts/stat-leaderboard.md) | Ranked players or scores with display-only rows |
| [incremental-clicker](references/layouts/incremental-clicker.md) | A large repeatable earn/tap action with a running total |
| [notification-alert](references/layouts/notification-alert.md) | Transient rewards, achievements, errors, and announcements |
| [wheel-spin](references/layouts/wheel-spin.md) | An eight-wedge radial prize wheel |
| [vertical-reel-roll](references/layouts/vertical-reel-roll.md) | A vertical crate, case, egg, or mystery-box reel |

Choose by interaction and information structure, not one matching word. A toast that requires confirmation is a dialog; an inventory contains owned items while a shop sells items; a clicker keeps the world visible while a landing screen blocks it.

## Authority and precedence

For visual/design decisions use this order:

1. exact specialized template + current specialized contract;
2. supplied reference image for composition when reproducing one;
3. recovered selected body at `references/selected/<theme>/<layout>.md`;
4. recovered packaged theme body;
5. neutral/shared layout summary;
6. generic `roblox-gui` layout advice.

Current Roqer system/developer instructions and current core execution references always override legacy source-environment tool names embedded in recovered bodies. A legacy tool name is provenance, never permission to call an unavailable operation.

## Builder and Studio boundary

- Create visible UI programmatically from one stable, named builder `LocalScript`; do not assemble an ordinary screen as a loose set of edit-time GUI instances.
- If no structured operation creates the builder, use `execute_luau` only to create/find the `LocalScript`, without assigning `Source`. Write its body with `set_script_source` so Roqer can show the diff and verify the read-back.
- A fresh builder may destroy/recreate only its own stable `ScreenGui` to avoid stacking. An edit preserves the existing builder and screen.
- Seed plausible demo content so the first render exposes density, hierarchy, and important states. Do not add production remotes, purchases, or data wiring unless requested.
- Keep every Studio call inside `roblox_studio`; skill content never grants permission or bypasses approvals, cancellation, selected-instance, or read-back rules.

## Canonical wheel and reel templates

`wheel-spin` and `vertical-reel-roll` are template layouts. Load the matching specialized contract and exact `(theme, layout)` Lua resource in the same route call:

| Theme | Wheel | Reel |
|---|---|---|
| SIM | [contract](references/specialized/wheel-spin.md), [template](templates/sim/wheel-spin.lua) | [contract](references/specialized/vertical-reel-roll.md), [template](templates/sim/vertical-reel-roll.lua) |
| STUDS | [contract](references/specialized/wheel-spin.md), [template](templates/studs/wheel-spin.lua) | [contract](references/specialized/vertical-reel-roll.md), [template](templates/studs/vertical-reel-roll.lua) |

If a specialized layout's theme is not known from the project/request, ask once before mutating Studio. Never substitute a theme, redraw the geometry, or move the managed prefix. Customize only documented `CONFIG` values and preserve protected template bytes exactly.

## Validation and stopping

After a meaningful create/edit, compare the live result against the active recovered body's **Measurements** and **Rules**, not merely against whether controls exist. For a straightforward static visual creation, one fresh playtest/render cycle with an `inspect_ui` audit, a screenshot, and a visual review is sufficient when it passes. The audit is required: Roqer does not verify a run that changed interface until an audit after the last interface change reports no problems. Fix what it names (covered or edge-crossing text, content past the scroll canvas, text that does not fit) and audit again; see [validation](references/core/validation.md). Interaction evidence is required only when the user requested behavior, when interaction is part of the layout's requested function, or when an action is necessary to expose the visual state being evaluated.

Do not click every visible control merely because it exists. Do not test Close on a static visual-only request when doing so only hides the screen and forces another playtest. A screenshot being captured is evidence acquisition, not proof the composition is correct.

Use current viewport coordinates with `simulate_mouse_input` only when semantic interaction is unavailable. Prefer JPEG for ordinary visual checks; if the turn reports an image too large, retry once at lower JPEG quality.

Stop after three failed fixes for the same defect, or when the same defect remains after two consecutive fixes. Keep playtests bounded and stop every playtest you start.

For source inconsistencies, load [normalization decisions](references/core/contradictions.md). For a final audit, load the [checklist](references/validation/final-checklist.md). The [benchmark prompts](references/validation/benchmark-prompts.md) are for evaluation, not ordinary task context.
