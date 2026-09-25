# Visual repair loop

Use this after a world or zone exists and the task is to improve what is visibly weak. This is a repair workflow, not permission to redesign the whole map.

## Evidence order

1. Recover the relevant WorldSpec, kit, zone intent and live component identities.
2. Read bounded structure for the affected area: current transforms, sizes, materials, roles, nearby gameplay objects and budgets.
3. Capture a deliberate **before** screenshot that shows the suspected defect and enough surrounding context to judge it.
4. Name one concrete defect in observable terms, for example: oversized canopy, abrupt terrain edge, repeated spacing, weak landmark silhouette, palette outlier, floating prop, blocked path, or obvious empty patch.
5. Choose the smallest repair scope that can fix it:
   - one component when the defect is local;
   - one saved kit only when every use of that kit is wrong and changing all uses is intended;
   - one zone when the composition is wrong across that zone;
   - never the whole world merely because a local repair is easier to regenerate.
6. Apply one bounded change. For physical 3D geometry under a known build root, prefer one `build_instances` `set` batch under the smallest containing root; it gives containment, atomic application and build readback. Use another structured operation only when that build edit cannot express the change, and prefer either over free-form mutation.
7. Read the changed component/zone back. Confirm the intended properties landed and unrelated named areas still exist unchanged.
8. Capture an **after** screenshot from the same or a directly comparable view.
9. If traversal, collision, spawn access or gameplay geometry changed, playtest that route. Purely decorative color/scale fixes do not need a playtest by default.
10. Stop after the defect is corrected. Do not continue polishing unrelated areas unless the request asks for a broader pass.

## Local versus kit repair

A visible instance can differ from its template because the user moved or edited it. Treat the live instance as authoritative for a local repair.

Change the shared kit only when all of these are true:

- the defect belongs to the reusable design itself rather than one placement;
- the current uses of that kit have been inspected;
- changing every intended use is within scope;
- user-modified placements that should remain unique are excluded or preserved.

Otherwise repair only the live component and reconcile saved intent only for fields that actually changed.

For scatter output, changing the saved scatter rule and replacing the owned group is appropriate for a composition-wide density/spacing/template issue. Do not re-scatter a whole group to fix one manually edited tree unless the request explicitly accepts replacing the group.

## What screenshots can and cannot prove

A screenshot can support claims about visible composition, silhouette, color, spacing and obvious intersection/floating problems. It cannot prove collision, traversal, exact dimensions, scripts, performance, semantic identity or that an unseen zone was preserved.

Pair visual evidence with structural readback. Use runtime evidence only when behavior matters.

When comparing before and after:

- aim both views with `selection` `action: "view"` on the same stable container
  (the zone or build root, not the component being repaired, whose bounds
  change) with the same `from`, `angleY` and `padding`; it needs no approval,
  unlike moving the camera in `execute_luau`;
- keep the camera position and framing identical when practical;
- otherwise keep the same target, distance scale and major landmarks in frame;
- do not present a dramatic camera change as proof the geometry improved;
- do not claim improvement where the screenshots are inconclusive.

## Bounded repair rule

Before mutation, write down the repair target in this form:

```text
Defect: <observable problem>
Scope: <component | kit | zone>
Preserve: <named zones/assets/user edits>
Success: <what the after screenshot and readback must show>
```

If the planned mutation touches something outside `Scope` or contradicts `Preserve`, narrow the plan before editing.

A repair pass should usually be one mutation followed by readback and one verification view. If two consecutive attempts fail to correct the same visible defect, stop escalating blindly: re-inspect the live state, reconsider the diagnosis, or report the limitation.

## Examples

### Oversized outlier tree

Before: one Cove tree has a canopy far larger and more saturated than nearby trees.

Repair: read that tree's current parts, resize/recolor only its canopy to fit the surrounding kit, read it back, and recapture Cove. Do not rebuild Cove or touch Ridge.

### Abrupt terrain edge

Before: a realistic meadow ends as a visible rectangular shelf.

Repair: inspect the terrain boundary and nearby non-terrain objects, then smooth/extend only the affected perimeter while preserving the meadow center and prop groups. Recapture from the same overview. If the edge crosses a traversal route, playtest it.

### Uniform scatter

Before: vegetation is mechanically even despite a natural style.

Repair: inspect the saved scatter rule and live obstacles, adjust density/template weighting/zone subdivision or seed only for that owned scatter group, replace it atomically, verify counts and bounds, then recapture. Preserve hand-placed landmarks outside the regenerated group.

## Acceptance

A visual repair is complete only when:

- the before evidence clearly shows the defect;
- the mutation is no broader than required;
- the changed structure is read back successfully;
- named preserve targets were not rewritten;
- the after evidence addresses the same defect from a comparable view;
- any affected traversal/runtime behavior is tested;
- budget regressions or unmeasured performance are reported rather than hidden.
