# Deterministic scatter

Use `build_instances` with one `scatter` step for repeated trees, rocks or props.
The plugin samples seeded placements, raycasts against selected live ground and
keeps template footprints clear of tagged obstacles. Commit ground and templates
first: scatter must be the only step in its request, so its observations describe
the scene that actually exists. Select the intended Studio and supply its
`instance_id` on every call.

## Inputs and preparation

- `path` is the owned build root. `name` identifies a unique child Model holding
  this scatter; optional `parent` must stay inside the root. Use unique sibling
  names for the root, ground, templates and destination. Ambiguous paths fail.
- `zone` is an axis-aligned world XZ rectangle `{min:[x,z], max:[x,z]}`. Irregular
  zones currently need several rectangles or tagged exclusion geometry.
- `density` is the target number per **10,000 square studs**. The requested count
  is `floor(width * depth * density / 10000)` and must be 1–1000. It is a target,
  not a promise that every candidate fits.
- `seed` is an integer from 0 to 2147483646. Keep it with the zone's scatter intent.
  A seed repeats the same layout only when all other inputs, templates, ground and
  obstacles remain unchanged. It does not freeze live scene state.
- `templates` holds 1–16 `{source, weight, kit?}` entries. Sources are existing
  archivable Parts or Models with physical descendants; weights are positive.
  Multi-part templates must use a Model; Parts with child Parts are refused
  because those children do not move or scale with their parent Part.
  Optional `kit` sets the clone root's `RoqerKit` tag and attribute. Read and accept
  the actual template's scripts, anchoring, appearance and collision flags first.
- `ground` is 1–16 existing paths inside Workspace, naming Parts, Terrain,
  Models or Folders. Only these roots participate in downward raycasts; water is
  ignored. Name actual ground, not a whole area that also contains trees or roofs.
  Ground and templates must not overlap the group being replaced.
- `raycast:{top,bottom}` is the world Y search interval, top greater than bottom,
  spanning at most 100,000 studs. `maxSlope` is 0–89 degrees, default 30.
- `rotation:[minYaw,maxYaw]` defaults to `[0,360]` degrees; this is yaw only.
  `scale:[min,max]` defaults to `[1,1]`, with factors between 0.05 and 20.
- `spacing` adds clearance between placement footprint circles, default 0.
  `avoid` contains up to 16 `{tag,distance}` rules. The tag must mark Parts or
  Models in Workspace; distance adds clearance beyond their projected bounds.
  At most 1000 obstacle matches are accepted. Tag the path or building geometry,
  not a Folder. Avoidance considers object extents, not just their centers.
- `tags` and scalar `attributes` decorate each clone root. Model children retain
  the template's values. Set zone and role as in the world-intent convention.
  Do not disable touch/query on actual gameplay objects to treat them as decor.

The whole template's bounds relative to its pivot determine a conservative
horizontal footprint circle and its lowest point. Placement keeps that circle
inside the rectangle, away from obstacles and away from other new placements.
The lowest point is placed at the ground hit under the pivot. This does not align
to the ground normal or prove support under every corner on uneven terrain;
inspect steep edges and overhangs before accepting the result.

The plugin reads scaled sizes back before insertion. If Studio clamps a template's
requested size, the batch is refused; revise the template or scale range instead
of accepting a footprint that no longer matches the planned geometry.

## Example: target 150 trees

First inspect the named ground, templates and avoidance tags; adapt the paths and
heights to the selected place. The 200×200 rectangle at density 37.5 requests 150
placements. The example needs existing Tree_A and Tree_B kit templates.

```json
{
  "path": "game.Workspace.Island",
  "operations": [{
    "op": "scatter",
    "name": "CoveTrees",
    "zone": { "min": [-100,-100], "max": [100,100] },
    "density": 37.5,
    "seed": 18273,
    "templates": [
      { "source": "game.ServerStorage.RoqerWorld.Templates.Tree_A", "weight": 2, "kit": "Tree_A" },
      { "source": "game.ServerStorage.RoqerWorld.Templates.Tree_B", "weight": 1, "kit": "Tree_B" }
    ],
    "ground": ["game.Workspace.Island.Ground"],
    "raycast": { "top": 100, "bottom": -20 },
    "rotation": [0,360], "scale": [0.8,1.2], "spacing": 2,
    "avoid": [{ "tag": "RoqerScatterObstacle", "distance": 3 }],
    "maxSlope": 20,
    "tags": ["RoqerZone", "RoqerRole"],
    "attributes": { "RoqerZone": "Cove", "RoqerRole": "decor" }
  }]
}
```

## Re-scatter and verification

The result's `scatter` object reports `requested`, `placed` and `attempts`; it
returns no placement list. Sampling stops at the requested count or 20 attempts
per requested placement. A shortfall can succeed and must be reported as a
shortfall. Zero placements is an error and leaves any existing group intact.
The ordinary build limits still apply: 2000 new instances, 20,000 including
descendants, for the whole request. Large templates can exhaust the instance
budget even when the requested placement count is legal.

Save the zone's scatter rule in an optional `scatters` object keyed by group name
inside its versioned JSON. Each value holds the step inputs (seed, zone, density,
templates, ground, raycast, ranges, avoidance, parent and identity decorations),
omitting `op`, `id`, `name` and `replace`. Store rules, not a list of placements;
the key supplies `name` when reconstructing a request. As with other intent,
metadata and live geometry use separate batches;
verify the geometry before recording a rule as the one applied.

For "denser trees in Cove", read the saved rule and live group, retain the seed,
adjust density and send the rule again with `replace:true`. This replaces only a
Model carrying the tool's `RoqerScatter` tag and `RoqerScatterVersion:1` attribute.
An unrelated or ambiguous same-named object is refused. The old group is excluded
from avoidance; the complete replacement is one undo step. If preparation or
application fails, the old group is preserved or restored. Manually edited
children of that scatter group are replaced too: inspect and preserve user edits
outside the regenerated group when the request requires them. Do not manually
mark unrelated Models as owned scatter output to bypass a refusal.

Inspect returned counts/bounds and bounded per-kit/zone counts, then capture a
view of the area and test relevant traversal. Check budgets before asking for
more density. A deterministic count and clean raycasts do not establish visual
quality, frame rate, walkability, or safety of scripts in a cloned template.
