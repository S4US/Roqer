# World continuity evaluation

Run these in a dedicated scratch place through the desktop's configured local
provider. They are manual multi-session scenarios, not entries in the reset-per-task
harness: resetting between prompts would erase the state being measured. Record
provider/model, agent bundle version, each prompt, tool activity, before/after
readbacks and screenshots. No successful run is recorded by adding this procedure.

## A second area in a new session

1. Ask: "Build a small chunky island called Island with a Cove zone, a walkable
   route, a cliff and six trees. Use a small saturated palette and reusable tree
   and cliff kits. Keep world intent in the place so I can add another area later."
2. Inspect WorldSpec, the relevant Kit and Zones JSON, the actual templates,
   component tags/attributes, counts and palette. Record their values and IDs.
   Save the scratch place.
3. Start a new Roqer conversation with no prior transcript. Ask: "Add a Ridge
   area to this island using the same style and trees. Keep Cove as it is."
4. Compare the saved spec and kit definitions, template identities, both areas'
   colors/materials, and the original Cove geometry. Pass only if the agent reads
   the persisted intent, reuses the existing kit/palette, adds Ridge without
   duplicating the registry or rebuilding Cove, and reports observed evidence.
   Check traversal and visual continuity separately from structural reuse.

## A local edit after the user moves geometry

1. In Studio, move the Cove cliff horizontally by one grid step. Record the
   current transform, size and bottom elevation; leave the kit template alone.
2. In another new conversation ask: "Make the Cove cliff four studs taller,
   keeping its base where it is. Preserve the rest of the island."
3. Pass only if the agent discovers the component by zone/kit/role, reads its
   current transform, preserves the user's move and bottom elevation, and updates
   only the intended cliff plus any explicitly necessary traversal connections.
   The shared template, Ridge and unrelated gameplay objects must stay unchanged.
   Check updated intent and verify traversal if the route was affected.

## Interrupted or incompatible intent

- Undo only the metadata update after a successful geometry edit, then begin a
  new conversation asking to continue. The agent must identify and reconcile the
  mismatch from live state without deleting the verified area or blindly
  replaying its initial creation batch.
- On a copy of the scratch place, set WorldSpec's schemaVersion to 999 or damage
  its JSON. Ask to add an area. The agent must preserve the unsupported data and
  explain the conflict; silently replacing the registry fails the scenario.
- Add an unrelated same-named cliff outside Island. A local Cove edit must not
  touch it. Duplicate sibling paths inside Cove must be resolved before mutation.

For every scenario record part counts versus saved budgets and bounded scene
analysis. Do not count a screenshot alone as proof of reuse, traversal or frame
rate. Keep results separate from unit/handler test results: those validate example
mechanics, not the model's decisions across real sessions.
