# Modeling a mesh

Use once [What gets modeled](mesh-boundary.md) has decided a component needs a
mesh, whatever makes it: the `blender` tool, `generate_model`, or a file the
user supplies. [Blender modeling](blender.md) covers the job itself; this
covers what to decide before it and what to check after.

## Write the brief first

Before the first job, settle these in your plan. A model built without them is
the wrong size, the wrong style, or arrives in one colour.

- **Role:** background prop, hero prop, held tool, vehicle body, building
  piece, or UI icon. The role sets the budget and whether it needs gameplay
  assembly afterwards ([Gameplay assembly](gameplay-assembly.md)).
- **Size in studs** for each major dimension, from the Player Scale table: a
  player is about 5 studs, a door 4 × 7, a seat 1.5 high, a counter 3.5–4. A
  barrel is about 4 studs tall; a sword about 4 long; a car about 12–16 long.
- **Style:** read WorldSpec `style` and palette when the place has one;
  otherwise take it from the request. Low-poly, chunky and faceted is the
  usual Roblox look; smooth and detailed needs a reason.
- **Surfaces:** list the colours, and every region that needs its own Roblox
  `Material` or transparency (a glass window, a glowing lamp). Only those need
  their own material slot, which arrives as its own MeshPart.
- **Moving pieces:** list anything that must move or be touched on its own
  (a wheel, a door leaf, a lid, a trigger). Keep each as a separate object.
- **Rest point:** where it stands or is held. That is where its pivot goes.
- **Triangle budget** (design budgets, not platform limits): background prop
  up to about 300; ordinary prop up to 1,500; hero prop or vehicle body up to
  5,000. Count it against WorldSpec `budgets.maxMeshTriangles` when set.

## Shape

- Build from a few strong forms. Revolve a profile for round things (a ring of
  vertices per height); extrude a footprint for
  flat-sided things; combine simple solids for assemblies.
- Place a part that is not upright by its two ends (`roqer.box_between`,
  `roqer.cylinder_between` in [Blender modeling](blender.md)), not by a
  rotation angle whose direction is easy to get backwards.
- For the low-poly look use 6–12 segments around a curve, flat shading, and a
  one-segment bevel on hard edges so they catch light. Never smooth-shade a
  hard-edged model: boxes and panels come out looking puffy.
- Modifiers are not exported unless the export passes `export_apply=True`: by
  default Blender's glTF export drops them, so a bevel you can see in the
  script never reaches Roblox. Pass it on every export.
- Keep normals outward (`bmesh.ops.recalc_face_normals`) and avoid coincident
  faces; they flicker in Studio.
- Join pieces that share a material and never move apart into one object.
  Keep moving pieces separate and named for what they are (`WheelFrontLeft`),
  then read back how they arrived before relying on them.

## Scale, orientation, pivot

- One Blender unit arrives as one stud. Model at the brief's size.
- Model with Z up, as Blender does; the glTF export converts to Roblox's Y up,
  so the model arrives upright.
- Stand the model on Z = 0 with its footprint centred on the origin.
- Face the model's front toward Blender −Y, as Blender's own Front view does.
  A point at Blender (x, y, z) arrives in Roblox at (−x, z, y), so −Y becomes
  Roblox's forward, −Z, the direction a part's `LookVector` points and a seat
  faces. A front modeled toward +Y arrives facing backwards. Measured from two
  uploads, by comparing each wheel's Blender position with its position in
  Studio.
- After insert, set the Model's pivot to its rest point (base centre for a
  prop, grip for a tool) with `WorldPivot` or a `PrimaryPart`, so later clones
  and `PivotTo` land it correctly.

## Colour and material

Colour the model in Blender. A Roblox Model upload keeps two kinds of colour,
verified by uploading one cube of each (`npm run eval:colors`), and loses one:

- **Vertex colours** (kept): one colour per face or per corner, in a colour
  attribute. The natural fit for low-poly: flat faces in a small palette, with
  no texture to make and every colour in one MeshPart. Paint the attribute's
  corners, and wire a Color Attribute node into the Principled Base Color, or
  the glTF export leaves the colours out.
- **A packed image texture** (kept, as the MeshPart's `TextureID`): for what
  faces cannot carry, such as wood grain, a painted logo, a gradient or
  lettering. Generate or draw the image in the script, keep it square and at
  most 1024 pixels a side, `image.pack()` it, wire it into Base Color, and
  UV-unwrap the mesh.
- **Flat material colours** (lost): a Principled base colour on its own arrives
  white. Use it only for a slot you will paint in Studio.

Roqer's inspection reports which one each exported model uses, and its preview
shows it. After insert:

- Leave `Color` white on a vertex-coloured or textured MeshPart: white shows the
  colour unchanged.
- Give a region its own material slot only when it needs its own Roblox
  `Material` or transparency: `Glass` for a window, `Neon` only for things that
  glow, or a physical material a player hears or feels. Changing `Material`
  also changes how the surface is lit and patterned, so screenshot it
  afterwards.
- For a slot painted in Studio, set `Color` and `Material` on its MeshPart:
  `Wood`, `WoodPlanks`, `Metal`, `DiamondPlate`, `Slate`, `Brick`, `Fabric` or
  `SmoothPlastic`.

## Accept it

1. The preview matches the brief: silhouette, proportions and colours.
2. Triangles are within budget; the measured size is within about 10% of the
   brief.
3. After insert, read back the MeshParts, size, pivot and anchoring. Set
   collision deliberately: `CollisionFidelity` `Box` for small props, `Hull`
   for convex shapes, the detailed default only where players need it; turn
   `CanCollide`, `CanTouch` and `CanQuery` off on purely visual pieces.
4. Screenshot it at the distance players will see it.
5. Record provenance: a `RoqerAssetId` string attribute on the Model with the
   uploaded asset ID. If it is a kit, register it as one and follow the kit
   revision steps in [World intent](world-intent.md) when it changes later.
