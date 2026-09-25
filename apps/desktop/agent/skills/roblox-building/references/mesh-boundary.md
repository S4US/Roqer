# What gets modeled

Use this whenever you decide how a piece of a map or a prop is made. The rule
depends on whether the `blender` tool is offered.

## With Blender on: the look is modeled, the play is Parts

When the `blender` tool is offered, the user has chosen modeled visuals. Split
every piece by its job, whatever the style, blocky and low-poly included:

- **Anything whose job is to look like something is a Blender model:** props,
  foliage, rocks, buildings and their trims, cliff and edge faces, fences,
  landmarks, and whatever else the style calls for. Parts can approximate a
  blocky style, but a model carries it better: one MeshPart instead of a stack
  of Parts, bevels, overhangs and drip edges in one piece, and one painted
  palette.
- **Anything whose job is how players move or interact is Parts:** the
  surfaces they walk on, collision, stairs and ramps, spawns, triggers,
  pickups' hitboxes, doors that open.
- **A piece that is both gets both layers:** a Blender visual with collision
  off, over a simple Part that does the physical work (see "Collision" below).

Make the whole visual set of a build in as few jobs as possible: one job that
exports every kit into one file, uploaded once (see "A kit set in one upload"
in [Blender modeling](blender.md)). Reuse a compatible model or saved kit
already in the place before modeling a new one.

## With Blender off

Without the `blender` tool, Parts, wedges and CSG are the default, and the
questions below decide whether a piece is worth another mesh source. Never
promise a modeled asset the host cannot make.

### Ask these, in order

1. **Is the silhouette simple at player distance?** Most map geometry is seen
   from 20–200 studs away. Ground, walls, stairs, cliffs, roofs, crates, fences
   and stylized trees read correctly as Parts, wedges and CSG. A detail smaller
   than about a stud at that distance is not worth a mesh.
2. **Is it repetition, not detail?** A forest, a rock field or a street of
   houses that looks mechanical needs variation: more kit variants, seeded
   yaw and scale, and zone subdivision in scatter. Remodeling one tree does not
   fix a uniform forest.
3. **Does it need curvature or topology Parts cannot give?** Organic forms
   (creatures, twisted trunks, draped cloth), smooth hulls (boats, cars, bells)
   and continuous curves (arches, pipes bent in two axes) become lumpy or
   expensive as Part stacks. These are mesh candidates.
4. **Would a mesh change what a player notices?** A hero prop at the plaza,
   the vehicle the player drives or a tool held in first person: yes. A barrel
   among forty others at the edge of the map: no.
5. **Is collision separate from the look?** Keep gameplay collision simple:
   an invisible Part or a box collision fidelity under a detailed visual. A mesh
   is never the reason a route becomes hard to walk.

If the answers to 3 and 4 are no, stay native and spend the effort on
composition, variation and palette instead.

## Where the geometry comes from

Take the first source that fits, per component. For any source that makes a
new mesh (4 to 6), write the brief in [Modeling a mesh](modeling.md) first,
and load [Gameplay assembly](gameplay-assembly.md) when it must do more than
stand there.

1. **Native Parts, wedges and CSG** for everything the questions above keep
   simple. `build_instances` places them in one undoable batch.
2. **A model already in the place** with a compatible style and scale.
3. **Creator Store:** `search_assets`, then `get_asset_details` or
   `preview_asset`, then `insert_asset`. Check triangle count, style and
   scale against the world before accepting it, and record the asset ID.
   Cross-owner or paid assets need the user's consent first.
4. **Generated mesh:** `generate_model` for one custom textured prop, bounded
   by `size` and `max_triangles`. It is irreversible outside Full auto; make
   the prompt specific to the world's palette and style, then inspect the
   result before placing it.
5. **An imported model** the user supplies, through `import_rbxm`, or a file
   they upload with `upload_asset` once an Open Cloud key is set in Roqer's
   Settings.
6. **Modeled in Blender:** when the `blender` tool is offered, this comes
   before 3 to 5 for every visual piece, as above. Load
   [Blender modeling](blender.md) first.

The `blender` tool is offered only while the user has turned Blender on in
Settings. When a component needs custom topology that none of the available
sources can produce, do not promise one: build a native proxy with the right
footprint, height, collision, anchoring and name, tag it `RoqerRole` `decor`
or `gameplay` as usual, and say in the result that it is a placeholder for a
modeled asset, and that turning Blender on would let Roqer model it.

## Collision

Players touch only simple, deliberate collision, never the detail of a model.

- **Visual meshes:** `CanCollide`, `CanTouch` and `CanQuery` off, so they cost
  no physics and rays and clicks reach the real surface.
- **Walkable volumes** (a cliff, a platform, a building's floor): an invisible
  anchored Part (`Transparency` 1, `CanCollide` on) whose top is exactly the
  walking height and whose sides are flush with the visible faces. Along a run
  of cliff or wall sections, merge the collision into one block per run, so
  players do not bump over seams.
- **Obstacles** (tree trunks, posts, fence runs): an invisible box or cylinder
  around the part a player would walk into; one thin box per fence run.
- **Rocks:** `CollisionFidelity` `Hull` on the MeshPart, or `Box`; small ones
  none.
- **Grass, flowers, small decoration:** none.
- Never `PreciseConvexDecomposition` on a detailed visual: it is expensive and
  snags players on every bump.

Build the collision into the kit template, so every clone carries it.

## Budgets and evidence

- A mesh counts against the world's `maxMeshTriangles` budget when WorldSpec
  sets one; compare it with `get_scene_analysis` before and after.
- Keep one mesh per kit and clone it; do not generate or insert the same prop
  twice.
- Accept a mesh only after a structural read (size, pivot, parent, collision,
  anchoring) and a screenshot at the distance players will see it. Every
  MeshPart's collision must be deliberate: off, or `Box`/`Hull`.
- Report what stayed native and what became a mesh or a proxy, so a later
  modeling pass knows which components to revisit.
