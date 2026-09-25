# Agent bundle provenance

This directory is a versioned product artifact. The desktop build copies it as a unit. A release must preserve the provenance and licence material below.

## Repository-owned material

The following material is developed in this repository and distributed under the repository's MIT licence:

- `system.md`;
- `developer.md`; and
- `skills/roblox-studio-mcp/`, which describes this repository's public Studio bridge and Roqer safety model.

## Vendored skill pack

The remaining Roblox domain skills are based on `roblox-brain` 1.2.1 at commit `479b88759d27b85bb5d34dc4f3f3c3bbc2f2e983`, published by TabooHarmony under the MIT licence. They may include repository-specific review/adaptation while retaining that origin.

On 2026-09-23 `skills/roblox-building/` replaced the upstream's tool names, which belong to a different Studio MCP (`generate_procedural_model`, `generate_mesh`, `wait_job_finished`, and others), with this repository's operations, and rewrote its asset section as a per-component construction choice. The same day it added a repository-authored Batch Building section and moved its build phases from per-call `execute_luau` batches to `build_instances`. The underlying spatial examples, CSG patterns and validation script retain their upstream origin.

The repository-authored `skills/roblox-building/references/world-intent.md` adds the version 1 place-resident world, kit and zone convention, with native build examples, bounded inspection and cross-session repair guidance. The entrypoint and full reference route map work to it and adopt its grid, metadata and performance-budget rules. This material is under the repository's MIT licence.

The required upstream notice is `skills/ROBLOX-BRAIN-LICENSE.txt`. The agent manifest declares the SPDX identifier and notice path, and the runtime refuses to load the bundle if that notice is missing or resolves outside the bundle.

The repository-authored `skills/roblox-building/references/scatter.md` documents
the native deterministic scatter operation and its limits, grounding, avoidance
and replacement behavior. It is distributed under the repository's MIT licence.

The repository-authored `skills/roblox-building/references/visual-repair.md` adds
a bounded screenshot-driven world repair loop: before evidence, one observable
defect, smallest-scope mutation, structural readback, preserve targets, and a
comparable after view. It is distributed under the repository's MIT licence.

The repository-authored `skills/roblox-building/references/mesh-boundary.md`
decides what is modeled: with the Blender worker on, every visual piece is a
Blender model over Part collision and gameplay; without it, when native Parts
suffice and when another mesh source is warranted. It also sets out layered
collision and says to leave a labelled native proxy rather than promise a
model the host cannot make. It is distributed under the repository's MIT
licence.

The repository-authored `skills/roblox-building/references/blender.md` describes
the opt-in local Blender worker: the job contract (one complete script, empty
scene, export into `OUTPUT_DIR`), reading Roqer's re-import and preview, and
bringing the model into Studio through upload and insert, and rendering PNG
icons for UI. It is distributed under the repository's MIT licence.

The repository-authored `skills/roblox-building/references/paths.md` covers
building along a line or curve: placing a part by its two ends, deriving every
strip from one centre line, meeting straights tangentially, sizing curve
segments to the outer chord, and checking a path from above. It is
distributed under the repository's MIT licence.

The repository-authored `skills/roblox-building/references/modeling.md` (the
brief, shape, scale, colour and acceptance rules for any new mesh) and
`skills/roblox-building/references/gameplay-assembly.md` (turning a model into
a held tool, seat, vehicle, door or pickup), the "Revise a kit everywhere"
section of `references/world-intent.md`, and the "Made for this game" section of
`skills/roblox-ui-design/references/core/assets.md` were written for Phase 7
of the world-building plan. They are distributed under the repository's MIT
licence.

The repository-authored `skills/roblox-building/references/composition.md`
adds scene-composition rules for edges, relief, layout and repetition, derived
from the defects recorded in the Phase 4 world evaluations, and a four-question
check against the overview screenshot. It is distributed under the repository's
MIT licence.

## User-provided UI reconstruction

`skills/roblox-ui-design/` was substantially revised from the user-provided `codex-ui-integration-handoff.zip` beginning 2026-09-08.

As of 2026-09-13 the shipped UI skill preserves the recovered SIM/STUDS **base theme bodies and the selected layout-body sections for all 14 layouts**, embedded in selectively loaded recovered theme and selected-layout resources. This restores the concrete construction, measurement, density, and failure rules that were lost when those captures were previously compressed into short normalized summaries. The package still does **not** ship the raw HTTP/conversation capture corpus; it ships the extracted design guidance needed by the agent plus the four exact SIM/STUDS wheel/reel Lua templates.

On 2026-09-23 the repository added `references/core/polish.md`, a polish layer of presentation motion, merchandising states, and finishing detail that sits on top of the recovered themes. It is repository-authored under the MIT licence. To make room for it, the "no RunService or TweenService" sentence in `themes/recovered/sim-1.md` and `studs-1.md` was changed to allow that presentation motion; no other recovered construction or geometry rule changed.

Legacy tool/deployment names that appear inside recovered bodies are provenance from the source environment, not Roqer capabilities. `SKILL.md`, current core references, the desktop developer instructions, and specialized contract/template files define execution in Roqer.

The supplied archive identifies captured payload hashes but declares no licence or original rights holder. Do not represent this material as part of `roblox-brain` or as repository-authored. The agent manifest lists `roblox-ui-design` as customized so this provenance boundary is visible to release review.

On 2026-09-25, ahead of publishing Roqer as open source, the project owner confirmed that they hold the rights to this material and chose to distribute it with the repository under its MIT licence.

## Curated icon catalog

`skills/roblox-ui-design/references/icons/` holds 106 Roblox image content IDs supplied by the project owner on 2026-09-08. The list was recovered by probing another agent's icon lookup and recording returned IDs/search phrasings. Entry names are semantic slots; recovered phrasings are evidence, not authored synonyms.

No image bytes are copied into the repository. Referencing an ID does not distribute the artwork it points at; Roblox serves artwork at runtime, under the terms its creator set on Roblox. The catalog records no creator or terms for each entry. On 2026-09-25 the project owner chose to keep the catalog in the open-source repository on that basis.

Eight IDs across five categories were checked through a live Studio bridge on 2026-09-08; all resolved to square pre-coloured images. That is a transcription sanity check, not review of all 106. A final targeted saturation pass yielded one new ID from 120 probes, so 106 is treated as practically saturated rather than mathematically complete.

## Release requirements

When the bundle changes:

1. update `manifest.json` with the upstream version and immutable commit where applicable;
2. keep every applicable third-party notice in the shipped bundle;
3. list repository-owned additions explicitly above;
4. review any new copied/adapted material before serving it commercially;
5. do not infer redistribution rights from a public URL or attribution alone.
