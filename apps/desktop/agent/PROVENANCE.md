# Agent bundle provenance

This directory is a versioned product artifact. The desktop build copies it as a unit. A release must preserve the provenance and licence material below.

## Repository-owned material

Repository-owned material is under the repository's licence: the GNU Affero General Public License, version 3 or any later version (`LICENSE` and `NOTICE.md` at the repository root). Releases up to and including 0.1.6 distributed it under the MIT licence.

The following material is developed in this repository and distributed under the repository's licence:

- `system.md`;
- `developer.md`; and
- `skills/roblox-studio-mcp/`, which describes this repository's public Studio bridge and Roqer safety model.

## Vendored skill pack

The remaining Roblox domain skills are based on `roblox-brain` 2.2.0 at commit `38826be57ee37bcf023e9c2b85681bea3909281c`, published by TabooHarmony under the MIT licence. They may include repository-specific review/adaptation while retaining that origin. They were first vendored from 1.2.1 at commit `479b88759d27b85bb5d34dc4f3f3c3bbc2f2e983`.

On 2026-10-08 the bundle was refreshed from 2.2.0. Upstream groups its skills into `core`, `gameplay`, `design` and `tools` folders; this bundle keeps them flat under `skills/`.

- Taken from 2.2.0 as published: `roblox-analytics`, `roblox-architecture`, `roblox-audio`, `roblox-input`, `roblox-lighting`, `roblox-localization`, `roblox-luau-core`, `roblox-luau-patterns`, `roblox-luau-types`, `roblox-monetization`, `roblox-networking`, `roblox-performance`, `roblox-security`, `roblox-server-data`, and the two skills added upstream in 2.0, `roblox-game-design` and `roblox-player-psychology`.
- Taken from 2.2.0 with small edits for Roqer's bridge: `roblox-camera` (playtest camera work goes through `eval_client_runtime`), `roblox-cloud` (the asset menu names `generate_model`, `search_assets` and `insert_asset`), `roblox-data`, `roblox-cloud` and `roblox-publish-checklist` (they describe the mutation record in place instead of pointing at the upstream Studio MCP skill, which this bundle does not ship), `roblox-publish-checklist` and `roblox-growth-design` (they keep the cross-reference to `roblox-ui-design`), and `roblox-tooling` (its Rojo note says to link the project in Roqer first, and one line names roblox-brain as this bundle's upstream).
- `roblox-growth-design/references/full.md` exceeds the 64 KB a skill document may have, and a loaded resource must also fit in one 50,000-character tool result, so its §6–§10 moved to `references/operations.md` and §11 to `references/community.md`, unchanged apart from cross-references that now name the file; `full.md` and `SKILL.md` point to them.
- Merged from 2.2.0 while keeping this repository's changes: `roblox-gui` keeps its description, When to Load and the rule that `roblox-ui-design` owns visual composition, and its reference no longer tells the agent to choose a provisional visual style itself; `roblox-npc-ai` and `roblox-physics` keep their `animation` tool and playtest-peer lines; `roblox-animation-vfx` takes the upstream `references/full.md` (track control, blending, flipbooks) with its Roqer marker note and pointers to the repository-authored VFX references.
- `roblox-building` stays on its repository rewrite. From 2.2.0 it adds the Creator Store judging guidance (adapted to `insert_asset`, which strips scripts), mesh-backed geometry, `EditableImage`/`EditableMesh`, the terrain import workflow (described as a pipeline the user runs), spawn return paths, player-facing route acceptance, large-place readback, `ProximityPrompt` and community leads. Studio Assistant editor workflows and the upstream MCP tool names were not taken.
- A line-by-line review of the 2.2.0 text, the same day, corrected factual errors and broken examples against the Roblox and Luau documentation, and fitted advice to Roqer's bridge, in `roblox-architecture`, `roblox-cloud`, `roblox-data`, `roblox-gui`, `roblox-input`, `roblox-luau-core`, `roblox-luau-patterns`, `roblox-luau-types`, `roblox-networking`, `roblox-performance`, `roblox-physics`, `roblox-security`, `roblox-tooling`, `roblox-animation-vfx` (where it also defers to the repository's VFX references) and `roblox-building`. In `roblox-game-design` only the Today's Picks and Moments summaries (checked against the official posts), section cross-references and one label changed; its design and monetization guidance, and all of `roblox-player-psychology`, `roblox-growth-design`, `roblox-monetization` and `roblox-analytics`, are as upstream wrote them.
- Kept although removed upstream in 2.0: `roblox-code-review`, still at its 1.2.1 text. Not taken: `roblox-collaboration-mode`, a governor skill that sets when to act, warn and ask, because Roqer's developer instructions and approval policy own that, and upstream's `roblox-studio-mcp`, which describes Roblox's official MCP rather than this bridge.

On 2026-09-23 `skills/roblox-building/` replaced the upstream's tool names, which belong to a different Studio MCP (`generate_procedural_model`, `generate_mesh`, `wait_job_finished`, and others), with this repository's operations, and rewrote its asset section as a per-component construction choice. The same day it added a repository-authored Batch Building section and moved its build phases from per-call `execute_luau` batches to `build_instances`. The underlying spatial examples, CSG patterns and validation script retain their upstream origin.

The repository-authored `skills/roblox-building/references/world-intent.md` adds the version 1 place-resident world, kit and zone convention, with native build examples, bounded inspection and cross-session repair guidance. The entrypoint and full reference route map work to it and adopt its grid, metadata and performance-budget rules. This material is under the repository's licence.

The required upstream notice is `skills/ROBLOX-BRAIN-LICENSE.txt`. The agent manifest declares the SPDX identifier and notice path, and the runtime refuses to load the bundle if that notice is missing or resolves outside the bundle.

The repository-authored `skills/roblox-building/references/scatter.md` documents
the native deterministic scatter operation and its limits, grounding, avoidance
and replacement behavior. It is distributed under the repository's licence.

The repository-authored `skills/roblox-building/references/visual-repair.md` adds
a bounded screenshot-driven world repair loop: before evidence, one observable
defect, smallest-scope mutation, structural readback, preserve targets, and a
comparable after view. It is distributed under the repository's licence.

The repository-authored `skills/roblox-building/references/mesh-boundary.md`
decides what is modeled: with the Blender worker on, every visual piece is a
Blender model over Part collision and gameplay; without it, when native Parts
suffice and when another mesh source is warranted. It also sets out layered
collision and says to leave a labelled native proxy rather than promise a
model the host cannot make. It is distributed under the repository's licence.

The repository-authored `skills/roblox-building/references/blender.md` describes
the opt-in local Blender worker: the job contract (one complete script, empty
scene, export into `OUTPUT_DIR`), reading Roqer's re-import and preview, and
bringing the model into Studio through upload and insert, and rendering PNG
icons for UI. It is distributed under the repository's licence.

The repository-authored `skills/roblox-animation-vfx/references/vfx-textures.md`,
`vfx-rendered-flipbooks.md` and `vfx-mesh-shapes.md` (once
`skills/roblox-building/references/blender-vfx.md`) cover drawing particle
textures and flipbooks with numpy, rendering flipbook sheets from a scene,
previewing textures in Studio before upload, and shapes for mesh effects. Their
observations about how experienced Roblox VFX artists build textures come from
a study of published effects the user supplied (recorded in
`docs/vfx-plan.md`); no third-party text or asset is included. They are
distributed under the repository's licence.

The repository-authored `skills/roblox-animation-vfx/references/vfx-design.md`,
with the design parts of `vfx-textures.md`, `vfx-motion.md` and
`vfx-camera-world.md`, summarises how experienced Roblox VFX artists design
effects: palette, value, brightness, textures, layering, timing and the camera
and world around an effect. It is drawn from studies of published effects the
user supplied and from a captioned tutorial by the artist snaliel. It
paraphrases their observations with measured numbers; no third-party text or
asset is included. It is distributed under the repository's licence.

The repository-authored `skills/roblox-animation-vfx/references/vfx-explosions.md`,
added on 2026-10-11, covers explosions, fire and smoke:
- the fire body as a mass of flipbooks;
- the handover from fire to smoke;
- smoke's value, lighting and opacity;
- drawn fire-burst and burn-out sheets.

It is drawn from a fifth study of the same user-supplied effects and videos
(recorded in `docs/vfx-plan.md`). It paraphrases their observations with
measured numbers; no third-party text or asset is included. Its drawing
examples are original. It is distributed under the repository's licence.

The repository-authored `skills/roblox-animation-vfx/references/vfx-reference.md`
covers matching a reference clip the user attaches: reading Roqer's labelled
frames and measurements, looking closer with `reference_clip`, and comparing
with `capture_moments`. It is distributed under the repository's licence.

The repository-authored `skills/roblox-building/references/paths.md` covers
building along a line or curve: placing a part by its two ends, deriving every
strip from one centre line, meeting straights tangentially, sizing curve
segments to the outer chord, and checking a path from above. It is
distributed under the repository's licence.

The repository-authored `skills/roblox-building/references/modeling.md` (the
brief, shape, scale, colour and acceptance rules for any new mesh) and
`skills/roblox-building/references/gameplay-assembly.md` (turning a model into
a held tool, seat, vehicle, door or pickup), the "Revise a kit everywhere"
section of `references/world-intent.md`, and the "Made for this game" section of
`skills/roblox-ui-design/references/core/assets.md` were written for Phase 7
of the world-building plan. They are distributed under the repository's licence.

The repository-authored `skills/roblox-building/references/composition.md`
adds scene-composition rules for edges, relief, layout and repetition, derived
from the defects recorded in the Phase 4 world evaluations, and a four-question
check against the overview screenshot. It is distributed under the repository's
licence.

The repository-authored `skills/roblox-animation-vfx/references/character-animation.md`,
added on 2026-09-28, documents authoring R15 animations with the `animation`
tool: the pose format with `aim` and `bend`, and wave, idle, walk, run and jump
recipes that a core unit test compiles and runs through the motion checks. The
skill's entrypoint points to it. It is distributed under the repository's
licence.

## User-provided UI reconstruction

`skills/roblox-ui-design/` was substantially revised from the user-provided `codex-ui-integration-handoff.zip` beginning 2026-09-08.

As of 2026-09-13 the shipped UI skill preserves the recovered SIM/STUDS **base theme bodies and the selected layout-body sections for all 14 layouts**, embedded in selectively loaded recovered theme and selected-layout resources. This restores the concrete construction, measurement, density, and failure rules that were lost when those captures were previously compressed into short normalized summaries. The package still does **not** ship the raw HTTP/conversation capture corpus; it ships the extracted design guidance needed by the agent plus the four exact SIM/STUDS wheel/reel Lua templates.

On 2026-09-23 the repository added `references/core/polish.md`, a polish layer of presentation motion, merchandising states, and finishing detail that sits on top of the recovered themes. It is repository-authored under the repository's licence. To make room for it, the "no RunService or TweenService" sentence in `themes/recovered/sim-1.md` and `studs-1.md` was changed to allow that presentation motion; no other recovered construction or geometry rule changed.

On 2026-10-11 the repository added the MODERN STUDS theme: `references/themes/modern-studs.md`, `references/themes/modern-studs/part-1.md` and `part-2.md`, and the 14 `references/selected/modern-studs/<layout>.md` bodies. They are repository-authored under the repository's licence, from a study of the UI of two published Roblox games (screen recordings and UI hierarchy captures). They ship no art, sprites, or code from those games. Their asset IDs are the repository's existing theme and catalog IDs plus two public Creator Store stud decals, each named with its decal and image ID. Layouts the study did not cover carry their geometry from the recovered STUDS bodies. The same day, after two Studio benchmark runs (a shop and a rebirth dialog), MODERN STUDS became the default stud theme and the recovered STUDS theme is named CLASSIC STUDS in routing; the recovered files themselves are unchanged apart from a one-line note in `themes/studs.md`.

Also on 2026-10-11 the repository added `templates/modern-studs/wheel-spin.lua`, the MODERN STUDS prize wheel. It is repository-authored, not part of the handoff: it is the CLASSIC STUDS wheel template with its button and label builders replaced by the MODERN STUDS surface kit from `themes/modern-studs/part-1.md`. Its managed prefix, `CONFIG` API, wheel chrome asset IDs, wedge geometry, sounds and spin animation are copied unchanged from `templates/studs/wheel-spin.lua`. No sprite from the studied games is used. The CLASSIC and SIM templates are unchanged.

Also on 2026-10-11 the repository added `references/themes/sim-refresh.md`, repository-authored from a study of three published simulator games: screen recordings of all three and a UI hierarchy capture of one. It updates the recovered SIM theme without editing it:
- a faint pattern on the card;
- a lower drop shadow;
- big item art with labels over it;
- tier-coloured item tiles;
- a measured shop width;
- HUD icons over the ends of pills and tiles.

It ships no art or code from those games. Its one new asset is the public Creator Store decal 14605469461 "Star Pattern" by 28Pixels, used by its image ID 14605469420. To fit the SIM route with the refresh in one batch, the desktop runtime's `load_skill` limit rose from 8 to 10 resources per call.

Legacy tool/deployment names that appear inside recovered bodies are provenance from the source environment, not Roqer capabilities. `SKILL.md`, current core references, the desktop developer instructions, and specialized contract/template files define execution in Roqer.

The supplied archive identifies captured payload hashes but declares no licence or original rights holder. Do not represent this material as part of `roblox-brain` or as repository-authored. The agent manifest lists `roblox-ui-design` as customized so this provenance boundary is visible to release review.

On 2026-09-25, ahead of publishing Roqer as open source, the project owner confirmed that they hold the rights to this material and chose to distribute it with the repository under its MIT licence. On 2026-09-28 the repository moved to the GNU Affero General Public License, version 3 or any later version, and this material moved with it.

## Curated icon catalog

`skills/roblox-ui-design/references/icons/` holds 106 Roblox image content IDs supplied by the project owner on 2026-09-08. The list was recovered by probing another agent's icon lookup and recording returned IDs/search phrasings. Entry names are semantic slots; recovered phrasings are evidence, not authored synonyms.

No image bytes are copied into the repository. Referencing an ID does not distribute the artwork it points at; Roblox serves artwork at runtime, under the terms its creator set on Roblox. The catalog records no creator or terms for each entry. On 2026-09-25 the project owner chose to keep the catalog in the open-source repository on that basis.

Eight IDs across five categories were checked through a live Studio bridge on 2026-09-08; all resolved to square pre-coloured images. That is a transcription sanity check, not review of all 106. A final targeted saturation pass yielded one new ID from 120 probes, so 106 is treated as practically saturated rather than mathematically complete.

## Stud UI Clean Roblox (CLEANSTUD)

`skills/roblox-cleanstud/` is generated from [TemporaryLooker22/Stud-UI-Clean-Roblox](https://github.com/TemporaryLooker22/Stud-UI-Clean-Roblox), under the MIT licence; its notice is `skills/roblox-cleanstud/LICENSE.txt`, and `skills/roblox-cleanstud/UPSTREAM.json` records the commit and a hash of every generated file. Upstream describes the kit as measured on one shipped Roblox simulator it does not name, and its README sets that game's shop beside the kit's copy.

`apps/desktop/scripts/update-cleanstud.mjs` builds the skill, and an update is a re-run of it:
- the kit's three modules (`StudUI`, `StudMotion`, `CheckUIIcons`) are copied unchanged below `templates/install/`, which Roqer writes into a place with `set_script_source {template}` and `load_skill` refuses;
- the five example builders and the menu controller are copied unchanged below `templates/examples/`;
- the references have upstream's file paths and three Studio MCP tool names rewritten to Roqer's;
- the icon catalog is split into one file per category;
- `references/kit-api.md` gathers the kit's own doc comments.

Only `SKILL.md` is written by hand. It keeps upstream's identity rules, kit reference, rules of thumb and extension guide as upstream wrote them, and fits the workflow to Roqer's operations: installing the kit by template, a builder module per screen, and Roqer's audit. The script stops instead of writing when the licence changes, when upstream adds a file it has no rule for, or when the kit's Luau goes past building UI (catalog `require`s, remotes, HTTP, dynamic code). Upstream's reference screenshots are captures of the reference game and are not shipped; their descriptions are.

The kit names asset IDs that upstream does not own. Checked through Roblox's public asset API on 2026-10-19 and 2026-10-20:
- the 1,022 registry icons and the sunburst are images uploaded on 2026-09-30 and 2026-10-01 by the account `drawygamemake`, not offered on the Creator Store. Upstream credits the icons to a "Check-UI Clean Roblox" set under MIT; that grant is upstream's statement, not the uploader's;
- the stud tile, shop header, basket, Robux coin and the eight rarity panels are images uploaded on 2026-10-14 and 2026-10-15 by `TuriptoMakeGames`, an account created on 2026-10-09; upstream calls them "the reference creator's uploaded images";
- the five sounds are public Creator Store audio by their own creators.

On 2026-10-20 the project owner chose to reference these IDs as the kit does, and to ship CLEANSTUD as an opt-in theme, reached only when a user asks for it by name, while it is tested against MODERN STUDS.

## Release requirements

When the bundle changes:

1. update `manifest.json` with the upstream version and immutable commit where applicable;
2. keep every applicable third-party notice in the shipped bundle;
3. list repository-owned additions explicitly above;
4. review any new copied/adapted material before serving it commercially;
5. do not infer redistribution rights from a public URL or attribution alone.
