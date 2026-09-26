# Modeling in Blender

Use this whenever the `blender` tool is offered and [What gets
modeled](mesh-boundary.md) says a piece is modeled, which with Blender on is
every visual piece. Write the brief in [Modeling a mesh](modeling.md) first.
The tool exists only while the user has turned Blender on in Roqer's Settings.
If it is not offered, do not ask for it or pretend to have run it: build from
Parts, and tell the user they can turn Blender on for modeled visuals.

## What a job is

One `blender` call runs one complete Python script in the user's own Blender,
in the background, on an empty scene. `bpy` is imported and `OUTPUT_DIR` is
defined. Every job is irreversible: the user approves it unless they run in
Full auto, so write the whole model in one script rather than probing with
several small ones.

A script may be at most 60,000 characters, and a call that long takes minutes
to write. Build repeated parts (wheels, bolts, tube runs, vents) with loops and
small functions rather than writing each one out. A model too detailed for one
script is built in several jobs, each exporting its own parts (the body in one,
the wheels and running gear in another), and placed together in Studio.

The script must:

- build everything with `bpy`; start from the empty scene, nothing else is loaded;
- model at the size it should have in Studio: one Blender unit arrives as one
  stud, so a barrel is about 4 units tall, not 1;
- name its objects and materials for what they are (`Barrel`, `BarrelWood`);
- face the model's front toward −Y: Blender (x, y, z) arrives in Roblox at
  (−x, z, y), so −Y becomes Roblox's forward (−Z, the `LookVector`), and a
  front built toward +Y arrives backwards;
- colour the model in Blender, with vertex colours or a packed image texture
  (see [Modeling a mesh](modeling.md), "Colour and material"). Both survive the
  upload; a flat material base colour does not, and arrives white;
- export into `OUTPUT_DIR` and nowhere else, normally one GLB, with modifiers
  applied (without `export_apply=True` a bevel or mirror never reaches Roblox):
  `bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "barrel.glb"), export_format="GLB", export_apply=True)`;
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

bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "barrel.glb"), export_format="GLB", export_apply=True)

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
