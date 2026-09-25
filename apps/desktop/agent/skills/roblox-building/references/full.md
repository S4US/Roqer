# Building 3D in Roblox — Full Reference


> **Code in this reference is illustrative. Adapt to your game and verify in Studio before production use.**

Use this skill when creating physical geometry in Roblox Studio — via MCP or standalone scripts. Covers single objects, room-scale structures, and multi-zone maps.

## MCP Mode (if using MCP bridge)

MCP code execution is stateless. Every call is a blank slate.

1. **Variables don't persist** between calls.
2. **Object references are lost** between calls.
3. **Fix**: Re-acquire references at the start of EVERY call.

```luau
-- MUST be at the start of every MCP call
local model = workspace:FindFirstChild("MyBuild")
if not model then
    model = Instance.new("Model")
    model.Name = "MyBuild"
    model.Parent = workspace
end
```

**Ground Truth Rule**: Never guess coordinates from chat history. If you need the position/size of a previously created part, READ it from workspace first:

```luau
local existing = model:FindFirstChild("TableTop")
if existing then
    print(existing.CFrame, existing.Size) -- read before calculating offsets
end
```

## MCP Build Contract

Use the shared `roblox-studio-mcp` session contract. Before changing a place:

1. Call `get_connected_instances` to select the intended Studio, then `get_place_info`.
2. Confirm the target datamodel and inspect `Workspace`, existing map roots, coordinate conventions, scripts, and reusable assets.
3. Declare a build root, origin, named dimensions and acceptance gates. For maps, load [World intent](world-intent.md) and recover the existing style, kit and zone plans before making new ones.
4. Apply one bounded phase at a time, each as one `build_instances` call (see Batch Building below). Keep `execute_luau` for what a build step cannot express, and re-acquire references in every stateless `execute_luau` call.
5. Read back bounded counts, bounds and relevant properties before starting the next phase; do not dump a whole map tree.
6. Start play only when runtime behavior matters. Capture console, navigation, and visual evidence, then stop play.

If a capability is unavailable, switch to the offline Luau path and identify the missing evidence instead of claiming the build was verified.

## Asset-Aware Prop Workflow

Choose the construction per component, not once per build. A single area can mix all of these: Parts for the ground, a reused project model for fences, a Creator Store asset for crates, a generated mesh for one hero prop.

1. **Native:** Parts, WedgeParts, CornerWedgeParts, and CSG for ground, blocks, walls, stairs, collision, triggers, and any shape the style keeps geometric. This is often most of a stylized map.
2. **Reuse:** search the place for a compatible model before making a new one, and clone it rather than rebuilding it.
3. **Creator Store:** `search_assets`, then `get_asset_details`, `get_asset_thumbnail`, or `preview_asset` to shortlist, then `insert_asset`. Record ID, creator, type, price, and intended parent. For cross-owner or paid results, get explicit consent before insertion.
4. **Generated mesh:** `generate_model` for a custom textured prop, from a prompt or a PNG reference. Bound `size` and `max_triangles`; use `schema_groups` when the model needs separately named parts (a lid, a door, wheels). The result is staged in `ServerStorage.__MCPGeneratedModels`, not in Workspace, so move or clone it into the build root. Do not treat it as accepted until inspected.
5. **Upload:** `upload_asset` action `upload` publishes a permitted local file (Decal, Model, Audio, Animation, Video) to the user's Roblox account. It needs an Open Cloud key and creator; if none are configured, report that instead of retrying and point the user to Roqer's Settings → Roblox Open Cloud. Never upload external content without permission. If it is still processing after the bounded wait, keep the returned `operation_id` and call the same operation with action `status` later instead of creating a duplicate. Report the completed asset ID and Roblox moderation state.
6. **Place:** parent the result under the named build root, set pivot/transform, and read back class, descendants, bounds, materials, collision, anchoring, and asset provenance.
7. **Fallback:** use native Parts, CSG, primitives, and coherent materials when generation is unavailable, slow, rejected, or visually unsuitable.

`generate_model` and the upload action are irreversible: outside Full auto, Roqer asks the user before each call, so make each one count. Checking an existing upload operation is read-only. Generated assets are candidates. Structural and visual review are still required.

## Player Scale Reference

- Player height: ~5 studs
- Doorway: 4 wide × 7 tall
- Ceiling height: 10-14 studs (rooms), 16+ (halls)
- Table/counter top: 3.5-4 studs from floor
- Seat height: ~1.5 studs from floor
- Paths: minimum 6 studs wide (10+ for main roads)
- Stair step: 1 stud rise, 1.5 stud run

## Build Process

### Objects (single Model)

1. **Assess** — Do you know the components, scale, and style? If not, ask.
2. **Plan** — Declare dimensions as named variables. Choose an anchor part.
3. **Build** — Generate parts with relative positioning, as one `build_instances` batch.
4. **Verify** — Run validation (check Anchored, below-floor, default colors).

### Maps (multi-zone)

1. **Layout** — Read or establish the WorldSpec and zone plans using [World intent](world-intent.md). Define scale, routes, elevation transitions and landmarks before geometry. Infer reasonable details from the request; clarify only material ambiguity.
2. **Ground** — Floor planes, boundaries, Origin anchor, folder hierarchy.
3. **Zone shells** — Floor sections, walls, dividers per zone.
4. **Landmarks** — Orientation structures (towers, fountains, trees).
5. **Fill** — Props, furniture, vegetation per zone.
6. **Environment** — Lighting, Atmosphere, SpawnLocations.
7. **Visual repair** — After structural acceptance, use [Visual repair](visual-repair.md) for a deliberate before view, one observable defect, the smallest local mutation, structural readback, and a comparable after view. Do not turn polish into a whole-map rebuild.

## Batch Building

`build_instances` creates, clones, updates, tags, and removes instances under one build root in a single call. Studio checks every step before changing anything, applies the batch whole or not at all, and records it as one undo step. Prefer it to `execute_luau` for anything it can express; keep Luau for CSG and for geometry computed from parts that already exist.

- `path` is the build root, below a service (for example `game.Workspace.Island`). It is created as a Model when missing. Every `parent` and `target` must be the root or inside it; a clone `source` may be anywhere, such as a kit template in `ServerStorage`.
- `create` needs `className`. `position` (world studs) and `rotation` (Orientation, degrees) place a created part; a created Model has no parts yet, so place its parts instead.
- `clone` needs `source` and makes one copy per `transforms` entry, each with optional `position`, `rotation`, and `scale`. The step's `name`, `properties`, `tags`, and `attributes` apply to every copy.
- `set` and `remove` need `target`. `remove` unparents, so Studio's undo restores it.
- `id` names a step's instance for later steps as `$id`. Apart from the build root itself, paths only find instances that already exist.
- Values follow atomic property writes: Vector3 as `[x, y, z]`, Color3 as `[r, g, b]` from 0 to 1, enums by item name. Script `Source` is refused; create the script, then write it with `set_script_source`.
- Limits: 500 steps and 2,000 new instances per batch (20,000 counting clone descendants).

The result reports the root's path, counts by class and tag, world `bounds`, and the path of each `id`. Check them against the plan before the next phase. A refused batch names the failing step and changed nothing.

```json
{
  "path": "game.Workspace.Island",
  "operations": [
    { "op": "create", "id": "ground", "className": "Folder", "name": "Ground" },
    { "op": "create", "className": "Part", "name": "Plateau", "parent": "$ground",
      "position": [0, 4, 0], "properties": { "Size": [64, 8, 64], "Anchored": true,
      "Material": "Grass", "Color": [0.35, 0.75, 0.3] },
      "tags": ["RoqerKit", "RoqerZone", "RoqerRole"],
      "attributes": { "RoqerKit": "Plateau_A", "RoqerZone": "Cove", "RoqerRole": "terrain" } },
    { "op": "clone", "source": "game.ServerStorage.RoqerWorld.Templates.Tree_A", "name": "Tree_01",
      "tags": ["RoqerKit", "RoqerZone", "RoqerRole"],
      "attributes": { "RoqerKit": "Tree_A", "RoqerZone": "Cove", "RoqerRole": "decor" },
      "transforms": [
        { "position": [-20, 8, -14] }
      ] },
    { "op": "clone", "source": "game.ServerStorage.RoqerWorld.Templates.Tree_A", "name": "Tree_02",
      "tags": ["RoqerKit", "RoqerZone", "RoqerRole"],
      "attributes": { "RoqerKit": "Tree_A", "RoqerZone": "Cove", "RoqerRole": "decor" },
      "transforms": [
        { "position": [18, 8, 10], "rotation": [0, 140, 0], "scale": 0.9 }
      ] }
  ]
}
```

## Spatial Patterns

For seeded bulk placement, use the existing build tool's `scatter` step; see
[Deterministic scatter](scatter.md) for density units, live ground selection,
footprint avoidance, bounded results and safe replacement. Scatter runs alone in
its batch after ground and templates have been committed.

### Geometric Manifest (named dimensions, no magic numbers)

```luau
local Def = {
    Width = 6.0,
    Depth = 3.0,
    Height = 2.8,
    TopThickness = 0.2,
    LegSize = 0.3,
    LegInset = 0.1,
}
```

### Relative Positioning (anchor pattern)

All sub-parts position relative to an anchor part's CFrame. Never use hardcoded world coordinates.

```luau
local top = Instance.new("Part")
top.Size = Vector3.new(Def.Width, Def.TopThickness, Def.Depth)
top.CFrame = CFrame.new(0, Def.Height - Def.TopThickness / 2, 0)
top.Anchored = true
top.Parent = model

-- Legs relative to top
local legH = Def.Height - Def.TopThickness
local leg = Instance.new("Part")
leg.Size = Vector3.new(Def.LegSize, legH, Def.LegSize)
local ox = Def.Width / 2 - Def.LegSize / 2 - Def.LegInset
local oz = Def.Depth / 2 - Def.LegSize / 2 - Def.LegInset
leg.CFrame = top.CFrame * CFrame.new(ox, -(Def.TopThickness / 2 + legH / 2), oz)
leg.Anchored = true
leg.Parent = model
```

### Grid Snapping

Snap dimensions to consistent increments (0.125, 0.25, or 0.5 studs). Avoid arbitrary decimals like 0.333 or 1.17 which compound into visible gaps.

## CSG (Union / Subtract)

### The Epsilon Rule

Cutters MUST slightly overlap boundaries they cut through. Coplanar surfaces cause Z-fighting or leave microscopic skins.

```luau
local EPSILON = 0.05

-- Hole through a 1-stud thick wall
local wall = Instance.new("Part")
wall.Size = Vector3.new(10, 10, 1)

local cutter = Instance.new("Part")
-- Add EPSILON*2 to the axis passing through the wall
cutter.Size = Vector3.new(2, 2, 1 + EPSILON * 2)
cutter.CFrame = wall.CFrame
```

### Safe CSG Wrapper

CSG operations are async and can fail. Always pcall, verify, and clean up.

```luau
local success, result = pcall(function()
    return basePart:SubtractAsync({cutterPart})
end)

if success and result and result:IsA("BasePart") then
    result.CFrame = basePart.CFrame -- preserve exact transform
    result.UsePartColor = true
    result.Color = basePart.Color
    result.Material = basePart.Material
    result.Name = basePart.Name
    result.Anchored = true
    result.Parent = basePart.Parent

    basePart:Destroy()
    cutterPart:Destroy()
else
    warn("CSG failed:", result)
    cutterPart:Destroy()
end
```

### CSG Rules

- Keep CSG trees shallow. Don't subtract from a part that was already unioned multiple times.
- Perform complex CSG near origin (0,0,0), then PivotTo() the final model to its destination. Floating-point precision degrades far from origin.
- GeometryService supports Part, PartOperation, and MeshPart. Terrain is NOT supported.
- Set `CollisionFidelity = Enum.CollisionFidelity.Box` on decorative unions for performance.

## Platform Quirks

### Cylinder Orientation

Cylinders extend along the **X-axis** by default. To stand one upright:

```luau
local pillar = Instance.new("Part")
pillar.Shape = Enum.PartType.Cylinder
pillar.Size = Vector3.new(10, 2, 2) -- Length, Diameter, Diameter
pillar.CFrame = CFrame.new(0, 5, 0) * CFrame.Angles(0, 0, math.pi / 2)
```

### WedgePart Orientation

The zero-height edge (tip) points toward +Z by default.

| Desired tip direction | Rotation |
|---|---|
| Up (+Y) | `CFrame.Angles(-math.pi/2, 0, 0)` |
| Down (-Y) | `CFrame.Angles(math.pi/2, 0, 0)` |
| Forward (+Z) | none |
| Backward (-Z) | `CFrame.Angles(math.pi, 0, 0)` |

### Neon Material

Neon glows visually but does NOT cast light on surroundings. Add a PointLight/SpotLight as a child for actual illumination.

### Default Part Properties

Always set explicitly:
- `Anchored = true` (defaults to false!)
- `CanCollide = true` (false for small decorative clutter)
- Pure decoration: `CanTouch = false`, `CanQuery = false`, and `CanCollide = false`. Keep gameplay triggers and interaction hitboxes separate with the flags they require.
- `CastShadow = true` (false for invisible triggers)

## Anti-Patterns

- **Guessing coordinates** — Read from workspace, don't rely on chat memory.
- **Unanchored parts** — They fall. Always set Anchored = true.
- **Hardcoded world positions** — Use relative offsets from anchor CFrame.
- **Block-only for organic shapes** — Use CSG, Cylinders, Spheres, WedgeParts.
- **Silent CSG failures** — Always pcall and verify result is BasePart.
- **Building everything in one call** — Split by phase or area, one `build_instances` batch each, so a failure costs one phase and each phase can be undone alone.
- **One call per part** — A batch holds up to 500 steps and 2,000 new instances; a phase fits in one call.
- **Floating geometry** — All structures must connect to ground or parent structure.
- **Default colors** — Always set explicit Color and Material. Default gray = unfinished.

## Validation Script

Run after building to catch common issues:

```luau
local TARGET = "MyBuild" -- change to your model/folder name
local root = workspace:FindFirstChild(TARGET)
if not root then print("[ERROR] " .. TARGET .. " not found"); return end

local errors, warnings, parts = 0, 0, 0
for _, desc in ipairs(root:GetDescendants()) do
    if desc:IsA("BasePart") then
        parts += 1
        if not desc.Anchored then
            print("[ERROR] " .. desc:GetFullName() .. " not Anchored")
            errors += 1
        end
        if desc.Position.Y - desc.Size.Y / 2 < -0.5 then
            print("[WARN] " .. desc.Name .. " below floor")
            warnings += 1
        end
        if desc.Color == Color3.new(163/255, 162/255, 165/255) and desc.Material == Enum.Material.Plastic then
            print("[WARN] " .. desc.Name .. " uses default color/material")
            warnings += 1
        end
    end
end
print(string.format("Parts: %d | Errors: %d | Warnings: %d", parts, errors, warnings))
```

If any errors: fix and re-verify. Warnings are advisory.

## Map Folder Structure

```
workspace/
  MapName/                  (Folder)
    Origin                  (invisible anchor at 0,0,0)
    Ground/                 (ground planes; not workspace.Terrain)
    Zone_Spawn/
      Floor
      Walls/
      Props/
    Zone_Arena/
    Landmarks/
    Lighting/               (PointLights, SpotLights)
    Spawns/                 (SpawnLocation instances)
```

## Acceptance Gates

Before calling a prop complete, verify:

- exactly one named model under the intended build root
- pivot and bounding box are sensible at player scale
- every structural part has deliberate anchoring, collision, material, and color
- no loose or duplicate parts remain
- generated or inserted assets have recorded provenance and were read back after placement

Before calling a map phase complete, verify:

- the map root and `Origin` are present
- zone floors and landmarks are inside the intended bounds
- spawn points and main paths are reachable and wide enough
- geometry is connected to the ground or a parent structure
- bounds calculations exclude `Baseplate`, `Terrain`, and default `SpawnLocation` unless intentionally included
- saved world intent agrees with the verified phase; compare local counts and bounded `get_scene_analysis` output with the world budgets (see [World intent](world-intent.md))

## Evidence Recipes

- **Structural:** return counts, classes, paths, bounds, pivots, materials, anchoring errors, collision errors, and asset IDs from an edit-time inspection.
- **Visual:** aim the view with `selection` `action: "view"` (a target `path`, plus `from`, `angleY` and `padding`), then `capture_screenshot`. Do not move the camera through `execute_luau`. For a repair, follow [Visual repair](visual-repair.md): bracket the mutation with comparable before/after views and pair them with structural readback. If capture fails or hangs, report that and retain structural evidence rather than inventing visual conclusions.
- **Runtime:** start play, navigate to the spawn and a representative landmark, exercise the relevant interaction, collect console output, and stop play. A clean console is evidence of no observed errors, not proof of all behavior.
- **Recovery:** if a phase fails, preserve the last verified phase, remove only the disposable failed output, and retry with a smaller batch or native fallback.
