---
name: roblox-building
description: "Use when building Roblox geometry, maps, props, or generated assets with MCP or standalone Luau."
last_reviewed: 2026-09-23
sources:
  - original
  - https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/studio/mcp.md
---

# Roblox Building

## When to Load

Load when building physical geometry, maps, props, or environment assets in Roblox Studio through MCP or standalone scripts. Covers spatial planning, CSG, generated/reused assets, scale, and verification. See `references/full.md` for complete patterns.

## Quick Reference

### MCP Build Mode
1. `get_connected_instances` and `get_place_info`, then inspect Workspace and existing asset conventions.
2. For a map or area edit, load [World intent](references/world-intent.md). Read the place's saved WorldSpec, relevant kit entries and zones before planning. Establish the build root, origin, routes, grid, palette and budgets before geometry; keep standalone props lightweight. From a reference image, record its surface treatment (flat or textured, which Roblox material) and its colours as values in WorldSpec before building. Also load [Composition](references/composition.md) and plan edges, relief, layout and variation before the first batch.
3. Build in bounded phases: ground → zone shells → landmarks → props → environment. Each phase is one `build_instances` call under the build root: one undo step, applied whole or not at all. Clone a template once per transform instead of rebuilding it; tag what you place so later edits can find it.
4. Read the build's returned counts and bounds, and read back assets and scripts, before continuing. Store compact versioned intent in `ServerStorage.RoqerWorld`; actual placements remain in the live tree. Reuse the saved kit and palette in later sessions.
5. Validate structure, capture a deliberate view (aim it with `selection` `action: "view"` on the build root or zone, never by moving the camera in `execute_luau`), and playtest traversal when relevant. Answer the composition checks against that view, and compare it with the reference image when there is one, and repair any defect before reporting.

For repeated trees, rocks or props, load [Deterministic scatter](references/scatter.md).
One `build_instances` scatter step handles seeded placement on selected ground,
tag-based avoidance, and undoable replacement of its named group.

For an existing scene that needs polish or correction, load [Visual repair](references/visual-repair.md).
Capture a before view, name one observable defect, repair the smallest component/kit/zone that owns it, read the change back, and capture a comparable after view. Preserve named unaffected zones and user edits.

### Construction Choice
When the `blender` tool is offered, every visual piece is a Blender model, whatever the style, and walkable or interactive pieces are Parts beneath it; make the whole visual set in one job and one upload. Load [What gets modeled](references/mesh-boundary.md) before planning. Without Blender, decide per component, not once per build, and take the first source that fits:
1. **Native Parts/CSG** for ground, blocks, walls, stairs, collision, triggers, and anything the style keeps geometric.
2. **Existing project assets:** reuse a compatible model already in the place before making a new one.
3. **Creator Store:** `search_assets` → `get_asset_details`/`preview_asset` → `insert_asset`. For cross-owner or paid assets, surface creator/source/price and get explicit consent first.
4. **Generated mesh:** `generate_model` for a custom textured prop. It stages the result in `ServerStorage.__MCPGeneratedModels`; move it into the build root, then inspect it before accepting it.

[What gets modeled](references/mesh-boundary.md) decides, per piece, what is modeled and what is Parts, how collision is layered under a model, and what placeholder to leave when nothing available can produce a shape. For any mesh, write the brief in [Modeling a mesh](references/modeling.md) first: role, stud size, style, surfaces, moving pieces and budget. When the `blender` tool is offered, load [Blender modeling](references/blender.md) before the first job: it covers a whole kit set in one upload, and rendering PNG icons for UI. When a model must be held, driven, sat on, opened or picked up, load [Gameplay assembly](references/gameplay-assembly.md). To change a kit's template everywhere it is placed, follow "Revise a kit everywhere" in [World intent](references/world-intent.md).

`upload_asset` action `upload` publishes a local file (image, model, audio) to the user's Roblox account and needs an Open Cloud key and creator. If it reports none are configured, do not retry and do not suggest environment variables: tell the user to add them in Roqer's Settings → Roblox Open Cloud, where Check key confirms the key can publish, then try again. If an upload returns `status: "processing"`, keep its `operation_id` and call `upload_asset` with action `status` later; never upload the same file again just to learn its result. A completed result reports Roblox's moderation state when available. `generate_model` and the upload action are irreversible: outside Full auto, Roqer asks before each call. A status check is read-only.

### Player Scale
Player ~5 studs | Door 4w×7h | Ceiling 10-14 | Counter 3.5-4 | Seat 1.5 | Path 6+

### Spatial Rules
- Named dimensions manifest, no magic numbers.
- Offset sub-parts from anchor CFrames, not guessed world coordinates.
- Place a part that runs from A to B by its ends, not by guessing angles: in Luau `CFrame.lookAt((A + B) / 2, B)` with the length on `Size.Z`; in `build_instances`, `position` at the midpoint and `rotation` `[0, yaw, 0]` with yaw = `math.deg(math.atan2(-(B.X - A.X), -(B.Z - A.Z)))`, since a yaw of θ turns the front (−Z) toward (−sin θ, −cos θ). Build a curve as segments whose ends meet: a curve joining two straights has its centre midway between their ends and a radius of half their separation, so it starts and stops exactly on them; size each segment to the chord at its outer edge, 2·r·sin(Δθ/2) with r the outer radius, so neighbours overlap on the inside instead of opening wedge gaps on the outside; and give every edge strip, kerb or barrier its own radius. Keep driving and walking surfaces flat unless banking is asked for, and check any path from directly above before moving on.
- Snap structural geometry to the world's grid and vertical step (for example 4 and 2 studs for a chunky map); use finer increments only for details or player traversal that needs them.
- Merge adjoining cells with the same elevation/material into larger blocks. A grid is a design rule, not a requirement to create a Part for every cell.
- Build complex CSG near origin, then `PivotTo` the destination.
- Set `Anchored`, `CanCollide`, `CastShadow`, `Color`, and `Material` explicitly.
- Keep everything a build makes inside its build root, spawn included: create a `SpawnLocation` there rather than moving one the place already has.
- Read with read tools (`get_instance_properties`, `get_project_structure`, `search_objects`, `get_scene_analysis`), not `execute_luau`: Luau is an irreversible call that asks the user for approval outside Full auto, even when it only reads.
- Separate gameplay models and collision proxies from decoration. Turn off `CanCollide`, `CanTouch`, and `CanQuery` on purely visual decoration; preserve touch/query behavior on triggers and interactables.

### Acceptance
**Prop:** named model, pivot, scale, bounds, materials, collision, anchoring, no loose parts, asset provenance.
**Map:** root/origin, zones, landmarks, spawns, path widths, traversal, and bounds checks excluding Baseplate/Terrain/SpawnLocation.
**Evidence:** structural readback plus screenshot when supported, console/runtime result when playtested.
**Budget:** compare bounded `get_scene_analysis` results and local counts with the saved world budgets; report missing measurements instead of claiming a performance pass.

### Anti-Patterns
Guessing coords | unanchored parts | hardcoded world positions | silent CSG failures | building through `execute_luau` what `build_instances` can do | one call per part | default gray | claiming generation succeeded without readback

**Need detail?** Load [World intent](references/world-intent.md) for map planning, saved kit/zone conventions, cross-session reuse and targeted edits. Load [Visual repair](references/visual-repair.md) for screenshot-driven local repair and before/after verification. Load `references/full.md` for CSG wrappers, map structure, validation scripts, asset recipes, and evidence workflows.
