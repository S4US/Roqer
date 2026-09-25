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

The script must:

- build everything with `bpy`; start from the empty scene, nothing else is loaded;
- model at the size it should have in Studio: one Blender unit arrives as one
  stud, so a barrel is about 4 units tall, not 1;
- name its objects and materials for what they are (`Barrel`, `BarrelWood`);
- colour the model in Blender, with vertex colours or a packed image texture
  (see [Modeling a mesh](modeling.md), "Colour and material"). Both survive the
  upload; a flat material base colour does not, and arrives white;
- export into `OUTPUT_DIR` and nowhere else, normally one GLB, with modifiers
  applied (without `export_apply=True` a bevel or mirror never reaches Roblox):
  `bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "barrel.glb"), export_format="GLB", export_apply=True)`;
- read or write no other files and use no network.

A script that raises returns Blender's traceback. Fix the cause and run the
corrected script; after two failed attempts at the same model, stop and report
what is failing instead of escalating.

## Reading the result

Roqer does not trust the script. It re-imports each exported model and returns
its triangles, meshes, materials and size, with a preview render attached.

- Look at the preview. If the silhouette or colours are wrong, fix the script;
  do not upload a model you have not seen.
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

def paint(obj, rgba):
    """Colour every corner of the object; the colour travels in the GLB."""
    attribute = obj.data.color_attributes.get("Col") or obj.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for corner in attribute.data:
        corner.color = rgba
    obj.data.color_attributes.active_color = attribute

# One material that shows the vertex colours; without the Color Attribute node
# the glTF export leaves them out.
paint_material = bpy.data.materials.new("BarrelPaint")
paint_material.use_nodes = True
nodes = paint_material.node_tree.nodes
colors = nodes.new("ShaderNodeVertexColor")
colors.layer_name = "Col"
paint_material.node_tree.links.new(colors.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])

# Stud scale: 4 studs tall, 3.6 across.
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=1.8, depth=4.0, location=(0, 0, 2.0))
body = bpy.context.active_object
body.name = "Barrel"
paint(body, WOOD)
for height in (0.7, 3.3):
    bpy.ops.mesh.primitive_torus_add(major_radius=1.84, minor_radius=0.1, major_segments=12, minor_segments=4, location=(0, 0, height))
    paint(bpy.context.active_object, IRON)

# One object, one material: the barrel arrives as a single MeshPart in its colours.
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body.data.materials.clear()
body.data.materials.append(paint_material)

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
