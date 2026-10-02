# Modeling in Blender

Use this whenever the `blender` tool is offered and [What gets
modeled](mesh-boundary.md) says a piece is modeled, which with Blender on is
every visual piece. Write the brief in [Modeling a mesh](modeling.md) first.
The tool exists only while the user has turned Blender on in Roqer's Settings.
If it is not offered, do not ask for it or pretend to have run it: build from
Parts, and tell the user they can turn Blender on for modeled visuals.

## What a job is

One `blender` call runs one Python script in the user's own Blender, in the
background. `bpy` is imported and `OUTPUT_DIR` is defined. The script starts on
an empty scene, or, with `continue_from` set to an earlier job's id, on the
scene that job saved. Every job whose script finishes saves its scene, and its
result gives the job's id and lists the scene's objects by name, size and
centre, so the next job reads what exists rather than recalling it. A chat's
first job leaves `continue_from` out: no id stands for an empty scene.

A small prop is one job. A detailed model is built in stages, one job per
stage, each continuing from the last: for a vehicle, the frame; then the body
panels; then the running gear; then the cockpit and details. Look at each
stage's preview before starting the next, and fix what is wrong while it is
the newest stage: a fix is a short script that changes the objects already
there, by name (`bpy.data.objects["Left_Side_Pod"].location.z += 0.2`), not a
rebuild. A job that fails saves nothing and the next attempt starts from the
last job that worked; to undo a step, continue from an earlier job.

Read the listing as well as the preview. It names what a small preview hides:
a left and right pair (`Fender_L`, `Fender_R`) that does not mirror, which is
usually a side sign the script forgot to flip, and geometry at NaN positions,
which an export fails on. Fix those in the next job, before building on them.

Every job is irreversible: the user approves it unless they run in Full auto,
so make each job a real stage, not a probe, and do not split one stage across
several jobs. A script may be at most 60,000 characters, and one that long
takes minutes to write: build repeated parts (wheels, bolts, tube runs, vents)
with loops and small functions rather than writing each one out.

Export once, when the model is ready to upload, with `use_visible=True`: an
export otherwise includes hidden helper objects such as boolean cutters. A job
that exports nothing is still checked and previewed from its saved scene.

The script must:

- build everything with `bpy`: a new model starts from the empty scene, and a
  continued one from the scene its earlier job saved; nothing else is loaded;
- model at the size it should have in Studio: one Blender unit arrives as one
  stud, so a barrel is about 4 units tall, not 1;
- name its objects and materials for what they are (`Barrel`, `BarrelWood`);
- face the model's front toward −Y: Blender (x, y, z) arrives in Roblox at
  (−x, z, y), so −Y becomes Roblox's forward (−Z, the `LookVector`), and a
  front built toward +Y arrives backwards;
- colour the model in Blender, with vertex colours or a packed image texture
  (see [Modeling a mesh](modeling.md), "Colour and material"). Both survive the
  upload; a flat material base colour does not, and arrives white;
- when the model is ready, export into `OUTPUT_DIR` and nowhere else, normally
  one GLB, with modifiers applied (without `export_apply=True` a bevel or
  mirror never reaches Roblox) and only visible objects:
  `bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "barrel.glb"), export_format="GLB", export_apply=True, use_visible=True)`;
- read or write no other files and use no network.

### Roqer's helpers

Every job also has `roqer`, a few helpers that build parts directly, in studs.
They place a part by where it starts and ends, so there is no rotation angle to
get the direction of wrong, and they paint it when given a colour:

- `roqer.box(name, size, center, rgba)`: an upright box of size `(x, y, z)`.
- `roqer.box_between(name, start, end, width, thickness, width_axis=(1, 0, 0), rgba)`:
  a box running from `start` to `end`, `width` wide along `width_axis`. A
  leaning seat back runs from its bottom edge to its top edge; a sloping panel
  from its low end to its high end.
- `roqer.cylinder_between(name, start, end, radius, rgba, vertices=12)`: a
  cylinder whose caps sit at `start` and `end`: a bar, a pipe, a column, an
  axle, or a wheel from its inner face to its outer face.
- `roqer.cone_between(name, start, end, start_radius, end_radius=0, rgba, vertices=12)`:
  a cone or taper whose start radius sits at `start` and end radius at `end`
  (0 is a point). A boost flame runs from the exhaust, its wide end, to its tip;
  a spike from its base to its point.
- `roqer.join(name, objects)`: joins parts that never move apart into one
  flat-shaded object with a vertex-colour material. Join each moving part (a
  wheel, a lid, a door) on its own.
- `roqer.paint(obj, rgba)` and `roqer.vertex_color_material()`, for parts made
  another way.
- `roqer.piece(obj, pivot, parent=None)`: makes a joined object a moving piece
  of a creature (see "A creature of moving pieces"): its origin goes to
  `pivot` without moving its shape, its mesh is named after it, and it hangs
  from `parent`.
- `roqer.bind(obj, bones)` and `roqer.skin(obj, bones, name="Armature")`: for
  a creature that bends (see "A creature that bends"): bind says which bones a
  part follows, and skin makes the armature and weights the joined mesh.
- `roqer.export_animation(name, source, rig, start=None, end=None, loop=True)`:
  bakes what a creature does in the scene into an animation for Studio (see
  "Animating a creature in Blender").
- `roqer.draw_flipbook(name, frame, grid=4, ...)` and `roqer.draw_texture`,
  with `roqer.tex_coords`, `tex_polar`, `tex_noise`, `tex_cells`, `tex_sample`,
  `tex_edge` and `tex_ease`: draw particle textures and flipbooks in 2D with
  numpy (see "Particle textures and flipbooks").
- `roqer.flipbook(name, grid=4, mode="alpha", start=None, end=None, loop=False, padding=4)`:
  renders the scene's animation into a 1024 x 1024 particle flipbook sheet
  (same section).
- `roqer.vfx_arc`, `vfx_ring`, `vfx_cone`, `vfx_swirl` and `vfx_shell`: shapes
  for mesh effects (a crescent slash, a shockwave, a burst, a tornado, a
  barrier), each with UVs laid out along its sweep. `roqer.vfx_surface`
  builds any other shape from a function (see "Shapes for mesh effects").

Prefer them for any part that is not upright. Raw `bpy` is still available for
shapes they do not cover; there, keep the model flat-shaded (no
`shade_smooth` on hard edges) and apply a rotation only after checking its
direction (see "Reading the result").

A script that raises returns Blender's traceback. Fix the cause and run the
corrected script; after two failed attempts at the same model, stop and report
what is failing instead of escalating.

## Reading the result

Roqer does not trust the script. It re-imports each exported model and returns
its triangles, meshes, materials and size, its layout, and a preview of four
views in one image: the side from +X, the top, and three-quarter views from two
opposite corners.

- The preview is how you check the model, but it is not evidence of the
  place: Roqer's completion check counts only what Studio shows. In a task
  list, a task that only models in Blender asks for no evidence; ask for
  visual evidence on the task that inserts the model, and take a Studio
  screenshot there.
- Look at every view. A part that looks right from one angle can lean the wrong
  way, float, or pass through another part in the side or top view. If the
  silhouette or colours are wrong, fix the script; do not upload a model you
  have not seen.
- Read the layout. It gives each finding in your script's own Blender
  coordinates, naming a piece by the size and centre your script gave it, so
  find the line that made it:
  - a piece attached to nothing, in its own object or any other, is almost
    always a gap: move it until it meets the part it belongs to;
  - separate objects passing into each other are wrong for a part that must
    move freely, and fine where one is meant to sit inside the other;
  - an object touching no other object is right for a kit set, and a gap in one
    assembled model;
  - the lowest point should be at Z 0 for a model that stands on the ground.
- A shading line means the model is smooth-shaded across hard edges, which
  makes boxes and panels look puffy. Remove `shade_smooth` unless the object is
  meant to look rounded.
- When a part is angled and a finding shows it missing what it should meet,
  check the rotation's direction before moving it: a positive rotation about X
  lifts the +Y end, about Y lowers the +X end, and about Z turns +X toward +Y.
- Keep triangles low. A prop rarely needs more than a few thousand; stay well
  under Roblox's per-mesh triangle limit, and split a large model into parts.
- Sizes are in Blender units, which arrive as studs. Still measure the model
  after it is inserted rather than trusting the number.

## A kit set in one upload

A map's visual pieces are made together: one job, one file, one upload, then
split into kit templates in Studio. That costs two approvals for the whole set
instead of two per piece. It is verified (`npm run eval:kits`): three
vertex-coloured pieces in one GLB, sharing one material, arrived as three
MeshParts, each named after its object, in its colours and at its modeled
size.

1. **One script builds every kit.** Make each kit one object: join its parts,
   and name the object and its mesh data for the kit (`Tree_A`, `CliffEdge_A`,
   `Rock_B`). Model each at its stud size, standing on the ground plane, and
   space them apart so none overlap. Their spacing does not survive the
   upload, so never rely on it.
2. **One material for the set is enough:** a vertex-colour material shared by
   every kit. Give a kit a second material only where a surface needs its own
   Roblox `Material` or transparency, and expect that kit to arrive as one
   MeshPart per material.
3. **Export one GLB and check Roqer's list.** It names every object with its
   size; each becomes its own MeshPart named after it.
4. **Upload once** (`assetType: 'Model'`) and `insert_asset` the result into a
   staging Model under the registry's `Templates`, for example
   `RoqerWorld.Templates.Import_1`.
5. **Split it with one `build_instances` batch rooted at `Templates`.** For
   each kit: `create` a Model named for the kit; `clone` its MeshPart into it
   with `CanCollide`, `CanTouch` and `CanQuery` off; `create` its collision
   Part (see "Collision" in [What gets modeled](mesh-boundary.md)); set a
   `RoqerAssetId` attribute. Then `remove` the staging Model. Each new Model
   gets an upright pivot at the centre of its bounds, so place a clone at the
   ground height plus half its height. Recognise each MeshPart by its
   name, or by the size Roqer listed if Roblox renamed it.
6. **Register the kits** in the registry's `Kit` folder and place them by
   cloning, like any template.

## A creature of moving pieces

A creature that will be animated (a wolf, a spider, a bird, a robot) is
modelled as separate pieces, one object for each part that moves on its own,
and rigged in Studio by the `animation` tool's `rig` action. An upload keeps
every piece where it was modelled but not where it turns, so the pivots leave
Blender in the job's result. Load the animation skill's
`references/creature-animation.md` before modelling: it names the pieces a
body plan needs.

- **One object per moving piece**, joined with `roqer.join`: the body; the
  head; the tail, or each tail segment; each leg as an upper and a lower
  piece, so it has a knee. Ears, eyes and teeth that never move on their own
  are joined into their piece. Give each piece one material.
- **Name pieces as the body plan does**, since each arrives as a MeshPart of
  that name: `Body`, `Head`, `Tail`, and for a four-legged body
  `FrontLeftUpper`, `FrontLeftLower`, `FrontRightUpper`, `FrontRightLower`,
  `HindLeftUpper` and so on. With the front toward −Y, the creature's left is
  Blender's +X.
- **`roqer.piece(obj, pivot, parent)` for every piece but the body**, after
  it is joined: `pivot` is the point the piece turns about, in the same
  coordinates the piece was built in. A leg's upper piece turns at the hip,
  inside the body; its lower piece at the knee, where the two overlap; the
  head at the back of the skull; the tail at its root. A pivot at a piece's
  middle makes it spin in place.
- **Overlap pieces at their joints** by a tenth of a stud or more, so a turn
  opens no gap. The layout does not report those overlaps.
- **Model it standing as it rests**: feet at Z 0, front toward −Y.
- **Bend each leg at rest**, as an animal's are. A leg modelled straight has
  no slack, so a walk can only stride by lowering the body and every knee
  stays bent: the creature walks crouched. Put each knee off the line from
  hip to foot by about 15% of the leg's height, a front knee forward (toward
  −Y) and a hind knee back (toward +Y), which is the way each folds. The leg
  then strides by straightening.
- Export one GLB as usual.

Read the result's **moving pieces** line. It lists anything that would rig
badly (an origin left at a piece's middle or outside both pieces it joins,
left and right pivots that do not mirror, a mesh named apart from its object,
a piece with two materials, a piece parented to nothing, legs modelled
straight or bent against their fold), each with what to
change: fix those in the next job before uploading, since an upload cannot be
changed. It ends with the `joints` to pass to `rig`, pivots included.

```python
import bpy, os

FUR, DARK, PALE = (0.45, 0.45, 0.48, 1), (0.2, 0.2, 0.22, 1), (0.8, 0.8, 0.78, 1)

# A low-poly wolf facing -Y, standing on Z 0, about 5 studs long.
body = roqer.join("Body", [
    roqer.box("chest", (1.3, 1.6, 1.3), (0, -0.8, 2.3), FUR),
    roqer.box("belly", (1.1, 1.8, 1.1), (0, 0.8, 2.25), FUR),
])

head = roqer.join("Head", [
    roqer.box("skull", (1.0, 1.0, 1.0), (0, -2.0, 2.9), FUR),
    roqer.box("snout", (0.5, 0.7, 0.45), (0, -2.8, 2.75), PALE),
    roqer.cone_between("ear_l", (0.3, -1.8, 3.3), (0.3, -1.8, 3.8), 0.18, 0, DARK, vertices=4),
    roqer.cone_between("ear_r", (-0.3, -1.8, 3.3), (-0.3, -1.8, 3.8), 0.18, 0, DARK, vertices=4),
])
roqer.piece(head, (0, -1.5, 2.7), body)          # the neck, inside the chest

tail = roqer.join("Tail", [roqer.box_between("t", (0, 1.6, 2.5), (0, 3.0, 2.0), 0.3, 0.3, rgba=DARK)])
roqer.piece(tail, (0, 1.6, 2.5), body)

# Blender +X is the wolf's left once it faces -Y. Each leg is bent at rest: its
# knee stands 0.3 off the line from hip to paw, a front knee forward, a hind knee back.
for end, y, bend in (("Front", -1.1, -0.3), ("Hind", 1.3, 0.3)):
    for side, x in (("Left", 0.45), ("Right", -0.45)):
        knee = (x, y + bend, 0.95)
        upper = roqer.join(f"{end}{side}Upper", [roqer.box_between("u", (x, y, 2.0), (x, y + bend * 1.1, 0.85), 0.42, 0.5, rgba=FUR)])
        lower = roqer.join(f"{end}{side}Lower", [
            roqer.box_between("l", (x, y + bend * 1.1, 1.05), (x, y, 0.1), 0.34, 0.4, rgba=FUR),
            roqer.box("paw", (0.4, 0.55, 0.2), (x, y - 0.08, 0.1), PALE),
        ])
        roqer.piece(upper, (x, y, 1.9), body)     # the hip or shoulder, inside the body
        roqer.piece(lower, knee, upper)           # the knee, where the two overlap

bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "wolf.glb"), export_format="GLB", export_apply=True, use_visible=True)
```

Then upload and insert it as in "Getting it into Studio", and rig it: the
creature reference's "From Blender" section has the call.

## A creature that bends: one skinned mesh

Pieces turn rigidly, which suits a blocky creature. A body that must bend
along its length (a snake, a fish, a tentacle, a worm, a long tail or neck)
is one mesh skinned to bones instead. The upload keeps the bones and the
weights, so nothing about the rig has to be carried to Studio by hand.

- **Bind each part to its bones as you make it**: `roqer.bind(part, "Head")`
  for a part that moves rigidly with one bone, `roqer.bind(part, ["Tail",
  "Tail2"])` for one that bends between several. A part left unbound is
  weighted among every bone by which lie nearest, which is right for a single
  tube and wrong for a leg beside a belly.
- **Run a limb up into the body it hangs from.** A part bound to several
  bones keeps its top with the bone above them: whatever of a leg lies above
  its hip stays with the spine, and blends into the leg just below the hip,
  so the thigh does not swing out of the rump as the leg turns. So start a
  leg's mesh a little above its upper bone's head, inside the body, and put
  that bone's head where the leg should turn. A part bound to one bone moves
  rigidly with it.
- **A part bends only where it has vertices.** A box has them at its ends, so
  build a bending length from several short segments end to end (a tail of six
  boxes, a snake of twenty), all bound to the same list of bones.
- **Join everything into one object** with `roqer.join`, then
  `roqer.skin(obj, bones)`. `bones` lists `(name, head, tail)` or
  `(name, head, tail, parent)`, parents first: each bone runs from `head` to
  `tail`, and a part turns about its bone's `head`. Keep to 63 bones or fewer.
- **Name bones as the body plan names pieces**: `Head`, `Tail`, `Tail2`, and
  for a four-legged body `FrontLeftUpper`, `FrontLeftLower` and
  `FrontLeftFoot` for each leg. The foot bone's head is at the sole, on Z 0:
  it is where the leg ends and where the foot meets the ground. Do not name a
  bone `Root`, or after the mesh; name the spine `Spine`.
- **Bend each leg at rest**, the mesh and its bones alike: the knee, which is
  the lower bone's head, off the line from hip to foot by about 15% of the
  leg's height, a front knee toward −Y and a hind knee toward +Y. A straight
  leg has no slack, and the creature walks crouched (see "A creature of
  moving pieces").
- Model it at rest, front toward −Y, feet on Z 0, and export one GLB as usual.

Read the result's **skinned** line. It names the mesh and its bones, and
lists what Roblox would not keep, each with what to change: a vertex no bone
holds, a vertex held by more than four bones, more than one mesh or armature,
a leg with no foot bone, legs modelled straight. It ends with the `rig` call,
which takes no joints.

```python
import bpy, os

GREEN, PALE = (0.3, 0.5, 0.28, 1), (0.75, 0.78, 0.6, 1)
names = [f"Spine{index + 1}" for index in range(8)]

# A snake facing -Y, 8 studs long, lying on Z 0: twenty short segments that
# bend along eight bones, and a head that moves with the first.
parts = [roqer.bind(roqer.box_between("head", (0, -4.6, 0.3), (0, -4.0, 0.3), 0.7, 0.5, rgba=GREEN), "Spine1")]
for index in range(20):
    y = -4 + index * 0.4
    parts.append(roqer.bind(roqer.box_between(f"s{index}", (0, y, 0.25), (0, y + 0.4, 0.25), 0.5, 0.5, rgba=GREEN if index % 2 else PALE), names))

bones = [(name, (0, -4 + index, 0.25), (0, -3 + index, 0.25), names[index - 1] if index else None) for index, name in enumerate(names)]
snake = roqer.join("Snake", parts)
roqer.skin(snake, bones)

bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "snake.glb"), export_format="GLB", export_apply=True, use_visible=True)
```

Then upload and insert it, and rig it: the creature reference's "A skinned
creature" section has the call.

## Animating a creature in Blender

Most creature motion is written for the `animation` tool directly: keys,
`waves` and `gait` (the animation skill's creature reference). Animate in
Blender instead when Blender's own tools make the motion: inverse
kinematics pulling a chain toward a moving target, a constraint that makes a
head track a point, a path, a physics bake. Roqer samples the result frame by
frame and hands the `animation` tool a pose description, so everything after
that (checks, previews, build, publish, wire) is the same.

- **Animate the scene the creature was exported from**: a second job with
  `continue_from` set to the job that made it. The armature is named
  `Armature`; a creature of pieces has its body piece. Leave the model as it
  is: an animation made on a body of another shape is refused in Studio.
- **Set the frames**: `scene.frame_start`, `scene.frame_end` and
  `scene.render.fps`. At most 60 seconds, sampled as up to 240 keyframes.
- **For a loop, the last frame is the first pose again.**
- **`roqer.export_animation(name, source, rig, start=None, end=None,
  loop=True)`** bakes it. `source` is the armature, or the body piece of a
  creature of pieces. `rig` is the path the model has, or will have, in
  Studio, such as `game.Workspace.Snake`: the model must be uploaded,
  inserted there and rigged before the animation is checked.
- A creature of pieces is at rest at `start`, so begin from the pose it was
  exported in.
- Only the body as a whole can travel: the root bone's, or the body piece's,
  change of place goes on the rig's `Root` joint. Any other bone or piece
  only turns, and a slide of its own is left out and reported.

The result lists each animation with its length, how many joints move, how
many keys were kept, and its file. Pass the file, not its contents:

```text
{ "action": "check", "animation_file": "<path from the job's result>", "locomotion": false }
```

then `build` with the same animation_file and a `parent`. A gait made this
way is checked with `locomotion: true` like any other. After publishing and
wiring it, `verify` with the model, the same animation_file, the published
animation_id and the `slot`, in a playtest, checks that the asset plays on
the model as checked and that the state holds it.

This job continues from the snake's and sweeps its tail from side to side
with inverse kinematics:

```python
import bpy, math

armature = bpy.data.objects["Armature"]
scene = bpy.context.scene
scene.frame_start, scene.frame_end, scene.render.fps = 1, 41, 20

# The last five bones reach for a target that swings across behind the snake and lifts.
target = bpy.data.objects.new("TailTarget", None)
scene.collection.objects.link(target)
reach = armature.pose.bones["Spine8"].constraints.new("IK")
reach.target, reach.chain_count = target, 5
for frame in range(1, 42):
    turn = 2 * math.pi * (frame - 1) / 40
    target.location = (1.6 * math.sin(turn), 3.6, 0.25 + 0.7 * abs(math.sin(turn)))
    target.keyframe_insert("location", frame=frame)

roqer.export_animation("TailSweep", armature, "game.Workspace.Snake")
```

## Getting it into Studio

For one model on its own; a map's set follows the section above.


1. `upload_asset {action: 'upload', filePath: <the exported path>, assetType: 'Model', displayName}`
   publishes it with the user's Open Cloud key. It is irreversible and asks for
   approval. If the result is pending, check it with `action: 'status'` rather
   than uploading again. With no key configured, send the user to Settings →
   Roblox Open Cloud.
2. `insert_asset` with the new asset id, into the build root or a kit's
   template folder.
3. Read the inserted model back: its MeshParts, size, pivot, anchoring,
   collision. It arrives as one MeshPart per object and material, named after
   it (`Barrel`, or `BarrelBody` and `BarrelBody2` for two materials), so tell
   them apart by name and size. Roqer's inspection said where the colour lives: for vertex
   colours or a texture, leave each MeshPart's `Color` white, which shows the
   colour unchanged; for flat material colours, set `Color` and `Material` on
   each part now. Scale the model if it is off, anchor it, and give it
   deliberate collision (see "Collision" in [What gets modeled](mesh-boundary.md)). Take a screenshot to confirm the colours.
4. Reuse it as a kit template: clone it for every placement. Never upload the
   same model twice. Record the asset ID as a `RoqerAssetId` attribute on the
   Model.
5. If it must be held, driven, opened or picked up, assemble it next: load
   [Gameplay assembly](gameplay-assembly.md).

## Particle textures and flipbooks

A particle texture decides most of how an effect looks. Most textures by
experienced Roblox VFX artists are 2D drawings, not renders: a white,
hard-edged silhouette on transparency, cel-shaded in two or three flat tones,
that the particle's `Color` tints. In 3,950 emitters studied across 22
published effects (see the `roblox-animation-vfx` skill's VFX craft
reference):

- the shapes were flame tongues, spiky impact stars, crisp smoke puffs with a
  lit and a shadow side, crescent arcs, rings with radial streaks, shaded
  rocks, four-point flares and dots;
- 4 x 4 sheets of 16 frames were the most common flipbook, and the subject
  filled most of its cell at its largest frame;
- frames changed by breaking apart: the shape is eaten into pieces and
  shrinks, rather than a soft blob fading;
- soft round glows were one layer among many, not the effect.

A soft, grey, rendered smoke ball, small in its cell, is the look to avoid.
It reads as a smudge at game distance.

There are two ways to make one. Both write a sheet that Roqer checks the same
way.

### Drawing with numpy

`roqer.draw_flipbook(name, frame, grid=4, loop=False, fps=None, mode="alpha", padding=4)`
calls `frame(t, size)` once per cell and packs the results into
`<name>.flipbook.png`. `t` runs from 0 at the first frame to 1 at the last.
`frame` returns one of:
- the alpha (a `size` x `size` array, 0..1) of a white shape;
- `(alpha, value)`, where `value` is a grey level (a number or an array), so
  one shape can carry a lit and a shadow tone under one `Color`;
- an RGB or RGBA array, when the colour must be baked in.

`roqer.draw_texture(name, image, size=512)` writes one texture as
`<name>.png`, from an array or a function of `size`.

The building blocks:

| Helper | Gives |
| --- | --- |
| `tex_coords(size)` | `x, y` arrays from -1 to 1, x right and y up |
| `tex_polar(x, y)` | `r, angle`: distance from the centre and the angle |
| `tex_noise(size, scale, octaves, seed)` | Smooth noise in 0..1 that tiles |
| `tex_cells(size, cells, seed)` | Voronoi `near, edge`: blobs, and cracks along `edge` near 0 |
| `tex_sample(image, u, v)` | `image` looked up at 0..1 with wrapping, to scroll or warp noise per frame |
| `tex_edge(value, at, soft)` | The hard edge: 0 below `at`, 1 above it, blended over `soft` |
| `tex_ease(t, power)` | Ease out, for a burst that grows fast then slows |

The pattern behind most stylised textures:
1. **Describe the shape** as a signed distance or field from the coordinates:
   `reach - r` for a star or ring, `half - abs(x - middle)` for a blade.
2. **Break it up** by adding a little noise to that field.
3. **Cut it** with `tex_edge` (soft about 0.01) for a crisp silhouette.
4. **Animate it.** Grow it with `tex_ease(t)`, and eat it away with a rising
   threshold on noise, such as `tex_edge(noise - t * 1.1)`, so it breaks into
   pieces instead of fading.

Three examples, each checked in Blender 5.2: an impact star that bursts and
breaks apart, a cel-shaded smoke puff and lava cracks. Change the shapes,
counts and curves freely; they show the pattern, not a house style.

```python
import numpy

NOISE = roqer.tex_noise(256, scale=6, seed=1)
DETAIL = roqer.tex_noise(256, scale=12, seed=9)

# Impact star: uneven spikes that burst out, then break apart.
RNG = numpy.random.default_rng(3)
COUNT = 11
RAYS = (numpy.arange(COUNT) + RNG.uniform(-0.3, 0.3, COUNT)) / COUNT * 2 * numpy.pi
LENGTH = 0.35 + 0.65 * RNG.random(COUNT) ** 1.5
WIDTH = 0.08 + 0.12 * RNG.random(COUNT)                    # half-width of each spike, in radians

def star(t, size):
    x, y = roqer.tex_coords(size)
    r, a = roqer.tex_polar(x, y)
    turn = a + r * 0.3                                      # + r * 0.3 curves the spikes a little
    spike = numpy.zeros_like(r)
    for ray, length, width in zip(RAYS, LENGTH, WIDTH):
        off = numpy.abs(numpy.angle(numpy.exp(1j * (turn - ray))))
        spike = numpy.maximum(spike, length * numpy.clip(1 - off / width, 0, 1) ** 1.6)
    reach = (0.28 + 0.7 * spike) * (0.4 + 0.6 * roqer.tex_ease(t * 2.5))
    eaten = roqer.tex_sample(NOISE, x * 0.5, y * 0.5) - t ** 1.5 * 1.1 + (reach - r) * 1.5
    return roqer.tex_edge(reach - r) * roqer.tex_edge(eaten, soft=0.03)

# Cel-shaded smoke puff: merged blobs, a lit side and a shadow side, holes that grow.
BLOBS = numpy.random.default_rng(11).uniform([-0.35, -0.35, 0.22], [0.35, 0.35, 0.4], (7, 3))

def puff(t, size):
    x, y = roqer.tex_coords(size)
    grow = 0.45 + 0.55 * roqer.tex_ease(t * 2)
    body = numpy.full_like(x, -1.0)
    light = numpy.full_like(x, -1.0)
    for cx, cy, radius in BLOBS:
        cy = cy + t * 0.2                                   # drifts up as it fades
        body = numpy.maximum(body, 1 - numpy.hypot(x - cx * grow, y - cy * grow) / (radius * grow))
        light = numpy.maximum(light, 1 - numpy.hypot(x - cx * grow + 0.12, y - cy * grow - 0.12) / (radius * grow))
    wobble = (roqer.tex_sample(DETAIL, x * 0.35 + 0.5, y * 0.35 + t * 0.3) - 0.5) * 0.35
    alpha = roqer.tex_edge(body + wobble * numpy.clip(body + 0.3, 0, 1), soft=0.015)
    alpha *= roqer.tex_edge(roqer.tex_sample(NOISE, x * 0.3, y * 0.3) + body * 0.6 - t * 0.95, 0.05, soft=0.03)
    lit = roqer.tex_edge(light + wobble, 0.12, soft=0.015)
    return alpha, 0.45 + 0.55 * lit                         # two tones: shadow 0.45, lit 1

roqer.draw_flipbook("ImpactStar", star, grid=4, fps=40)
roqer.draw_flipbook("SmokePuff", puff, grid=4, fps=16)

# Lava cracks: bright veins between cells, for embers glowing inside dark smoke.
near, edge = roqer.tex_cells(512, cells=7, seed=4)
x, y = roqer.tex_coords(512)
roqer.draw_texture("LavaCracks", roqer.tex_edge(0.06 - edge, soft=0.02) * roqer.tex_edge(0.9 - numpy.hypot(x, y), soft=0.1))
```

It runs in seconds: the job above, two sheets and a texture, took about 5 s. Draw at the
final size, since a sheet is 1024 x 1024: 256 px a frame at 4 x 4. Look at the
attached sheet, then change what reads weakly: a shape too thin to survive at
game distance, a burst that never fills its cell, or a fade where it should
break apart.

### Rendering the scene

`roqer.flipbook(name, grid=4, mode="alpha", start=None, end=None, loop=False, padding=4)`
renders the scene's animation through `scene.camera` into
`<name>.flipbook.png`. Use it when a 3D look is the point: a simulation, a
lit volume, shaded debris, a realistic fireball. It handles the size, grid,
padding, frame sampling, colour management and packing. Use any materials,
geometry nodes, simulations, compositor passes or lighting; the helper
renders whatever the scene shows.

- **Frames:** the frames from `start` to `end` (the scene's range by default)
  are sampled evenly to fill every cell, because Roblox plays every cell. With
  fewer frames than cells, some frames are held for two cells, and Roqer
  reports the repeats.
- **Mode:** `"alpha"` renders on a transparent film. `"additive"` renders on
  black for `LightEmission = 1`.
- **Framing:** frame the camera tightly. The subject should fill most of the
  cell at its largest without leaving the view. An orthographic camera looking
  at the effect is simplest.
- **Speed:** colour uses the Standard view transform, so glows stay bright.
  - Use Eevee for emission and Workbench for flat shapes; Eevee measured
    0.06 s a frame for the example below.
  - Cycles measured 0.28 s a frame at 32 samples for a simple sphere, and
    volumes take far longer. Note the per-frame time Roqer reports.

```python
import bpy, math

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.frame_start, scene.frame_end = 1, 16

camera = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
scene.collection.objects.link(camera)
camera.data.type = "ORTHO"
camera.data.ortho_scale = 4.0
camera.location = (0, -10, 0)
camera.rotation_euler = (math.radians(90), 0, 0)
scene.camera = camera

bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, segments=24, ring_count=12)
ball = bpy.context.active_object
material = bpy.data.materials.new("Glow")
material.use_nodes = True
nodes = material.node_tree.nodes
nodes.clear()
emission = nodes.new("ShaderNodeEmission")
output = nodes.new("ShaderNodeOutputMaterial")
material.node_tree.links.new(emission.outputs[0], output.inputs[0])
emission.inputs["Color"].default_value = (1.0, 0.55, 0.15, 1.0)
ball.data.materials.append(material)

# A burst: grows fast, then fades out while it keeps spreading.
for frame, scale, strength in ((1, 0.6, 6.0), (6, 3.0, 4.0), (16, 3.8, 0.0)):
    ball.scale = (scale, scale, scale)
    ball.keyframe_insert("scale", frame=frame)
    emission.inputs["Strength"].default_value = strength
    emission.inputs["Strength"].keyframe_insert("default_value", frame=frame)

roqer.flipbook("GlowBurst", grid=4, mode="additive")
```

### What Roqer checks, and using a sheet

A sheet you pack yourself (frames from several jobs, a hand-ordered
sequence) works too. Save it as a 1024 x 1024 PNG named `<name>.flipbook.png`,
with a `<name>.flipbook.json` beside it giving `grid`, `loop` and `fps` so the
settings can be reported.

What Roqer reports for each sheet is read from its pixels:
- the grid the gutters between frames agree with;
- the coverage of every cell in play order, which should grow and shrink as
  the effect does;
- **problems:** empty cells and drawing cut off at a cell's edge;
- **notes:** frames that hold, and a drawing that fills little of its cells;
- the `FlipbookLayout`, `FlipbookMode` and `LightEmission` to use, with the
  `Lifetime` for a one-shot sheet or the `FlipbookFramerate` for a loop.

Fix every problem before uploading, and weigh every note. The sheet is
attached; look at it.

To use a sheet:

1. Upload it with `upload_asset {action: 'upload', filePath, assetType: 'Decal', displayName}`.
2. Set `ParticleEmitter.Texture` to `rbxassetid://<imageId>`.
3. Apply the settings Roqer listed.
4. Confirm it plays: hold one particle at a few ages (`TimeScale = 0`) and
   take screenshots. Each should show one frame, not the whole grid. Do not go
   by `FlipbookIncompatible`: Studio shows its size message even for a sheet
   that plays.

Every upload is irreversible and moderated, so settle the sheet before
uploading. Put several textures an effect needs into one job, and reuse one
sheet across layers by changing `Color`, `Size`, `Rotation` and `Squash`. For
layering, timing and the rest of the effect, see the `roblox-animation-vfx`
skill's VFX craft reference.

## Shapes for mesh effects

Mesh effects are shapes that grow, spin and fade in Studio: a crescent slash,
a shockwave ring, a twisting tornado, a barrier dome.
- **The named helpers** cover the common shapes.
- **`roqer.vfx_surface`** builds any other shape you can describe as a
  function: a jagged shockwave, a forked lightning card, petals, a spiked
  burst, a wobbling wave.
- **Raw `bpy`** remains available for anything else: modifiers, geometry
  nodes, sculpted or boolean shapes. Roqer inspects every mesh the same way.

**What every shape has in common:**
- It is one open sheet, so set `DoubleSided` on the MeshPart in Studio.
- Its UVs run the same way: U along the sweep (0 at the start, 1 at the end),
  V across it (0 inside or at the bottom, 1 outside or at the top). They are
  for maps that follow the surface. In Roblox, `TextureID` ignores alpha (see
  below), so the shape itself, the part's `Transparency` and a Neon colour do
  most of the work.
- It is built around the origin, horizontal or upright, facing Roblox's
  forward (Blender -Y).
- Sizes are in studs.

**The shapes:**
- **`roqer.vfx_arc(name, radius, width, sweep=160, segments=32, taper=True)`**: a
  flat crescent for a slash. It sweeps `sweep` degrees centred on forward,
  from radius - width out to radius. With `taper`, it is widest in the middle
  and pointed at both ends; U runs from the +X end to the -X end. Roll the
  MeshPart for a diagonal swing.
- **`roqer.vfx_ring(name, radius, width=0.5, height=0, top_radius=None, segments=48)`**:
  - with `height` 0, a flat band on the ground: a shockwave;
  - with a height, a wall from `radius` at the bottom to `top_radius` at the
    top. A flared top makes a blast wave.
- **`roqer.vfx_cone(name, radius, height, tip_radius=0, segments=32)`**: an
  open cone from its base at the origin up to its tip. Point it with the
  MeshPart's orientation, for example along the LookVector for a muzzle
  blast.
- **`roqer.vfx_swirl(name, radius, height, width, turns=1.5, top_radius=None, segments=96)`**:
  a ribbon `width` tall, spiralling up `turns` times to `height`, widening
  to `top_radius`. Use it for a tornado, an aura or a charge-up.
- **`roqer.vfx_shell(name, radius, segments=32, rings=16, dome=False)`**: a
  sphere, or a dome standing on the ground. Use it for a barrier or a blast
  bubble.
- **`roqer.vfx_surface(name, point, columns=32, rows=1)`**: anything else.
  - `point(u, v)` returns the position of each grid corner for u and v from
    0 to 1, and that corner's UV is (u, v).
  - Corners that meet are merged, so closed loops and poles need no special
    care.
  - Vary the radius with `u` for a jagged or wobbling ring. Offset a strip
    sideways with noise for lightning. Shape a petal by tapering it with
    `v`.

```python
import bpy, math, os, random
from mathutils import Vector

random.seed(4)
spikes = [1.0 + random.uniform(-0.25, 0.45) for _ in range(24)]

def jagged(u, v):
    # A shockwave ring whose outer edge is torn into spikes.
    angle = 2 * math.pi * u
    i = u * len(spikes)
    spike = spikes[int(i) % len(spikes)] * (1 - (i % 1)) + spikes[int(i + 1) % len(spikes)] * (i % 1)
    radius = 4.0 + v * 1.5 * spike
    return Vector((math.sin(angle) * radius, -math.cos(angle) * radius, 0.0))

roqer.vfx_surface("TornWave", jagged, columns=96, rows=2)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "torn-wave.glb"), export_format="GLB", export_apply=True, use_visible=True)
```

Put several shapes in one job and export one GLB. Each arrives as its own
MeshPart named after it. Roqer reports their UVs and triangles.

In Studio:
1. Set `Material` (`Neon` to glow, `ForceField` to shimmer), `Color`,
   `DoubleSided`, `RenderFidelity = Precise` and `Anchored`.
2. Turn off `CanCollide`, `CanQuery`, `CanTouch` and `CastShadow`.
3. Animate the parts with the emit module's `Start`/`End` parts (see the
   `roblox-animation-vfx` skill's VFX craft reference).

What arrives, and what works on it, was checked in Studio:
- A shape arrives as a MeshPart inside a Model, under a child named after the
  node (`Crescent_Node`). A flat shape is 0.001 studs thick. Its pivot is the
  centre of its box, not the origin it was built around, so a crescent spins
  about its middle.
- Set `RenderFidelity = Precise`. With Automatic, Roblox simplifies a thin
  curved card at distance until a crescent reads as a straight-sided wedge.
- `TextureID` ignores alpha on a MeshPart: the texture's colour covers the
  whole surface, and nothing shows through. Do not put a fading texture
  there.
- What does fade:
  - **The part's own `Transparency`.** A `Neon` card fading from about 0 to 1
    is the reliable mesh effect.
  - **A `Decal` on the card's face** (`Top`, plus `Bottom` to show from
    below), on a part with `Transparency = 1`. It fades cleanly and takes
    `Color3` and `Transparency`, but it is projected across the part's box
    face and ignores the UVs. Its texture must be drawn for that flat
    projection, not along the sweep.
  - A `SurfaceAppearance` with `AlphaMode = Transparency` follows the UVs,
    but rendered dithered in Studio, and scripts cannot change its maps at
    runtime.

```python
import bpy, os

slash = roqer.vfx_arc("Slash", radius=6, width=1.5, sweep=150)
wave = roqer.vfx_ring("Shockwave", radius=5, width=0.8)
wave.location = (0, 0, -3)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "slash-effect.glb"), export_format="GLB", export_apply=True, use_visible=True)
```

## Rendering an image for UI

A job may render PNGs into `OUTPUT_DIR` instead of, or as well as, exporting
a model: an inventory icon, a shop thumbnail, a badge. Roqer attaches each PNG
as it is, with its pixel size read from the file. Look at it before uploading.

- Render with Workbench: it is fast and needs no lights. Set
  `scene.display.shading.color_type` to where the colour lives: `"VERTEX"` for
  vertex colours, `"TEXTURE"` for an image texture. For flat material colours
  use `"MATERIAL"`, which draws a material's viewport colour, not its node
  colour, so set `material.diffuse_color` to the same RGBA as the base colour.
- Transparent background: `scene.render.film_transparent = True` and
  `scene.render.image_settings.color_mode = "RGBA"`.
- Square and no larger than 1024 pixels a side (Roblox keeps no more); 512 is
  enough for an icon. Frame the object so it fills most of the square.
- Upload it with `upload_asset {action: 'upload', filePath, assetType: 'Decal', displayName}`.
  Use the result's `imageId` in `ImageLabel.Image` as `rbxassetid://<imageId>`.
  The `decalId` does not display in an ImageLabel. If `imageId` is null, check
  the upload again with action `status`, which resolves it once Roblox has
  processed the image.
- Build the UI around it with the `roblox-gui` or `roblox-ui-design` skill.

## Example

```python
import bpy, os

WOOD, IRON = (0.45, 0.28, 0.14, 1), (0.2, 0.2, 0.22, 1)

# Stud scale: 4 studs tall, 3.6 across. A cylinder is given by its two end caps.
body = roqer.cylinder_between("BarrelBody", (0, 0, 0), (0, 0, 4.0), 1.8, WOOD)
hoops = [roqer.cylinder_between(f"Hoop{i}", (0, 0, z - 0.1), (0, 0, z + 0.1), 1.86, IRON) for i, z in enumerate((0.7, 3.3))]
# A part at an angle is given by its two ends, never by a rotation: this tap
# starts inside the barrel wall and runs out and down.
tap = roqer.cylinder_between("Tap", (0, -1.7, 1.0), (0, -2.2, 0.8), 0.08, IRON)

# One object, one vertex-colour material, flat-shaded: it arrives as a single
# MeshPart in its colours.
roqer.join("Barrel", [body, *hoops, tap])

bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "barrel.glb"), export_format="GLB", export_apply=True, use_visible=True)

# Optional: a transparent 512 px icon of the same barrel for an inventory slot.
from mathutils import Vector
scene = bpy.context.scene
camera = bpy.data.objects.new("IconCamera", bpy.data.cameras.new("IconCamera"))
scene.collection.objects.link(camera)
camera.location = (7, -7, 6.5)
camera.rotation_euler = (Vector((0, 0, 2)) - camera.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = camera
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.color_type = "VERTEX"
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.filepath = os.path.join(OUTPUT_DIR, "barrel-icon.png")
bpy.ops.render.render(write_still=True)
```
