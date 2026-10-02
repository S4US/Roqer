# VFX craft

Load this before building any visual effect: a hit, a slash, an explosion, a
spell, an aura or a pickup. It covers:
- the engine properties that matter;
- textures, layer skeletons and how to play effects;
- how to check an effect.

It does not replace looking: screenshot every effect you build.

This reference is a toolbox and a list of traps, not a style. The design is
yours: depart from any of it when the effect calls for it.

**Load `references/vfx-design.md` with it.** That reference covers what
experienced Roblox VFX artists do and why, measured from their published
effects:
- what the effect is for;
- palette, value and brightness;
- textures, layers and the intensity curve of timing;
- projectiles, slashes, beams and sustained forms;
- camera, screen and world reactions.

Numbers here carry the same marks: *(measured)* from those studies,
*(verified)* checked in Studio, *(starting point)* common practice to tune by
looking.

## 1. What experienced artists do

See `references/vfx-design.md`. The short version:
- custom, hard-edged white textures tinted by `Color`;
- many single-sprite layers;
- a palette of about five colours that is never broken;
- dark layers or dim twins so the bright parts read;
- Brightness and `LightEmission` chosen against the place's bloom;
- one emit whose layers die in order, getting quieter and never brighter
  again.

## 2. Where effects live and how they play

- **Templates** go in `ReplicatedStorage.VFX`, one Model per effect.
  - Each Model has an invisible root part (`Transparency = 1`, anchored, no
    collision), with Attachments holding the emitters.
  - Name the Model after the effect (`Slam`, `SlashHit`). Name each emitter
    after its layer. The studied artists split a long effect into one Model or
    Folder per beat (`Dash`, `Up`, `Down`).
- **The player module** is the template `templates/vfx/emit.lua` in this
  skill.
  1. Load it with `load_skill`.
  2. Create a ModuleScript named `Emit` with `build_instances` under the build
     root `ReplicatedStorage.VFX`, so it sits at `ReplicatedStorage.VFX.Emit`
     beside the templates.
  3. Read it for its revision, then write the template's body into it with
     `set_script_source`.

  It is a starting point, not a cage. Extend it, or write your own player,
  when an effect needs something it does not do: camera shake, Bezier paths,
  colour over time, chained effects. If you change it, keep the attribute
  names so VFX editors can still read the effect.
- **Playing an effect:**
  - `VFX.play(template, cframe)` clones the template, places it, plays it and
    removes it once the last particle is gone.
  - `VFX.emit(instance)` plays emitters that already sit on a weapon or
    character, and restores them afterwards.
  - The handle returned has `freeze(seconds)` for hitstop and
    `setTimeScale(scale)` for slow motion. One clock drives particles, meshes,
    lights and trail lifetimes, so they stay in step. The handle's scale
    multiplies each emitter's own `TimeScale`, so a slowed smoke layer stays
    slower than the core.
- **The attributes it reads**, the convention VFX Editor, VFX Forge and other
  editors share:

| On | Attribute | Meaning |
| --- | --- | --- |
| ParticleEmitter | `EmitCount` | Burst this many particles (bounded to 500) |
| ParticleEmitter | `EmitDuration` | Emit at `Rate` for this many seconds |
| ParticleEmitter, Beam, Trail, lights | `EmitDelay` | Seconds after the effect starts |
| Beam, Trail | `EmitDuration` | Enabled for this long |
| PointLight, SpotLight, SurfaceLight | `EmitDuration` | On, then `Brightness` fades to 0 over this long |
| Model or Folder with `Start` and `End` parts | `Duration`, `Easing`, `EasingDirection`, `Spin`, `EmitDelay` | `Start` moves to `End`'s CFrame, Size, Transparency and Color; `Spin` is degrees about `Start`'s own up axis (its `UpVector`), so spin a ring mesh, not a cylinder laid on its side |
| The effect's root | `EffectDuration` | When the effect ends, if nothing above sets it |

- **Delays are absolute.** `EmitDelay` counts from the effect's start. Editors
  that set a delay on a group write it onto every descendant, so a delay is
  never added to its parent's.
- **`EmitDuration` means two things in the wild.** Some community emit
  scripts re-burst `EmitCount` every 0.1 s for that long. This module turns
  the emitter on at its `Rate` for that long. Set `Rate` for the stream you
  want.
- **Attributes it does not drive.** VFX Forge's `TimeScale_*`, `Size_*` and
  `Part_*` attributes are inputs to that plugin's own editor; the module does
  not read them.

The module only controls what carries these attributes. An emitter with none
(an always-on aura) keeps running at full speed through `setTimeScale` and
`freeze`. Give it `EmitDuration` if it should slow down and stop with the
effect.

- **Replication.** Effects are presentation, so play them on clients.
  - The server decides that something happened and fires an
    `UnreliableRemoteEvent` with the effect's name and a CFrame. Each client
    calls `VFX.play`.
  - Unreliable events drop payloads over 1000 bytes, so send names and
    numbers, never instances. Load the `roblox-networking` skill for the
    remote itself.
  - Never let damage or rewards wait on an effect.
- **Timing to an animation.** Put a marker on the keyframe where the hit lands
  (`markers: [{ "name": "Impact" }]` with the `animation` tool). Play the
  effect from `GetMarkerReachedSignal("Impact")`; see `references/full.md` §2.

## 3. Textures

**Draw your own.** In a Blender job (load the `roblox-building` skill's
`references/blender-vfx.md`, with its `references/blender.md`), `roqer.draw_flipbook` and
`roqer.draw_texture` draw textures with numpy:
- describe a shape from coordinates;
- break it up with noise;
- cut it with a hard edge;
- eat it away over the frames.

Roqer checks each sheet from its pixels and attaches it. One job can make
every texture an effect needs. `roqer.flipbook` renders a 3D scene into a
sheet instead, for a lit volume or simulation.

- **Preview first.** A Blender job run with `preview_in_studio: true`
  returns an `rbxasset://textures/roqer-preview/...` address for each
  texture. That address plays on a particle in Studio as an upload would
  (checked in Studio on Windows), so iterate on textures inside the effect
  for free.
  - A redraw comes from a new job, with new addresses.
  - The addresses work on this computer only; players see nothing there.
- **Upload:** use `upload_asset` as a `Decal`, and use the result's `imageId`
  as `rbxassetid://<imageId>`.
  - Every upload is irreversible and moderated, so upload only the settled
    set, and say how many uploads a request will use before uploading.
  - Then replace every preview address left in the place (see the
    `roblox-building` skill's `references/blender-vfx.md`).
  - Reuse one texture across layers by changing `Color`, `Size`, `Rotation`
    and `Squash`.
- **Size:** keep a single texture square, 512 px or less, and 256 px for
  small ones; memory scales with pixels. A flipbook sheet is 1024 x 1024.
- **White on transparency** suits almost everything: the particle's `Color`
  tints it, and `LightEmission` picks the blending (`vfx-design.md`, section 4). Bake onto black
  (`mode="additive"`) only for a layer that will only ever be additive.
- Roblox has no multiply or premultiplied mode. For darkening, use a black
  layer at `LightEmission` 0, or negative `LightEmission`.

**Built-in textures, no upload.** These ship with Roblox for the legacy Fire,
Smoke, Sparkles and Explosion effects. They are fine as stand-ins while
blocking an effect out, and every Roblox player has seen them.

| Texture | Looks like |
| --- | --- |
| `rbxasset://textures/particles/explosion01_implosion_main.dds` | Soft white round glow |
| `rbxasset://textures/particles/explosion01_shockwave_main.dds` | Soft ring |
| `rbxasset://textures/particles/explosion01_core_main.dds` | Orange fiery puff |
| `rbxasset://textures/particles/smoke_main.dds` | Grey cloudy puff |
| `rbxasset://textures/particles/sparkles_main.dds` | Four-point star |
| `rbxasset://textures/particles/fire_main.dds` | Wispy flames |
| `rbxasset://textures/particles/forcefield_vortex_main.dds` | Thin ring with dots |

The Creator Store (`search_assets` with `assetType: "VFX"` or `"Particle"`,
then `preview_asset`) is worth a look when a texture there matches the style.

**Flipbook rules:**

- `FlipbookLayout` is `Grid2x2`, `Grid4x4` or `Grid8x8` (4, 16 or 64 frames).
  4 x 4 is the usual choice. `Custom` with `FlipbookSizeX/Y` was in client
  beta from October 2025; do not rely on it until confirmed.
- Make the sheet 1024×1024, the size uploaded and seen playing frame by frame.
  That is 512 px a frame at 2×2, 256 at 4×4 and 128 at 8×8.
- Do not judge a sheet by `FlipbookIncompatible`. Studio shows "Particle
  texture must be 1024 by 1024 to use flipbooks." there even for a 1024 sheet
  that plays, and for a texture with no flipbook layout at all. Every studied
  emitter carries the message.
- To check a sheet, hold one particle at a few ages (`TimeScale = 0`) and
  screenshot it. Each capture should show one frame, not the whole grid.
- Leave a few pixels of empty space inside each cell. A frame that touches its
  cell edge bleeds into its neighbour.
- `FlipbookMode`:
  - `OneShot` plays once across the particle's lifetime. It is almost always
    the choice for a burst *(measured)*.
  - `Loop` repeats at `FlipbookFramerate` (at most 30 fps);
  - `PingPong` plays forward and back;
  - `Random` shows one random frame.
  - Use `Loop` with `FlipbookStartRandom = true` for a burning fire.
- Some low-memory devices switch flipbooks off, so the first frame should
  still read on its own.

## 4. Particle properties worth knowing

- **Slowing down:** `Drag` is the half-life of speed in seconds.
- **Shapes:**
  - `Shape` (Box, Sphere, Cylinder, Disc) emits from the parent part's volume
    or surface (`ShapeStyle`). The emitter must sit directly under a part
    sized for the shape; under an Attachment it emits from a point.
  - `ShapeInOut = "Inward"` on a sphere gathers particles toward the centre,
    which suits anticipation.
  - `ShapePartial` on a Disc hollows it into a ring.
- **Layer order:** `ZOffset` moves a layer toward the camera without changing
  its size. Scale it with the effect: about ±1 for a 10-stud orb, 0-3 for an
  impact, and tens of studs for a huge explosion *(measured)*.
- **Following a moving source:** `LockedToPart = true` makes particles follow
  the emitter (an aura, a held torch, a spinning model). Leave it off for
  anything thrown off.
- **Lighting:** `LightInfluence = 0` keeps a glowing layer at its own colour.
  Smoke reads better lit by the scene (`LightInfluence` 0.35-1).

## 5. Beams, trails and meshes

- **Beams:**
  - A Beam is a curve between two attachments. `CurveSize0` and `CurveSize1`
    bend it into an arc.
  - Give it enough `Segments` to look smooth: at least one fewer than the
    number of Color and Transparency keypoints, and 20 or more for a visible
    curve. The studied slash beams use 100-360.
  - `TextureSpeed` scrolls the texture along the beam, the one built-in way
    to scroll a texture. Use it for flowing energy, lasers and lightning
    arcs.
  - **Launch beams** *(measured)*: a beam whose width starts at 40-200 and
    tweens to 0 over 0.15-0.4 s, with a transparency band that is clear at
    both ends (`0:1, 0.5:0, 1:1`), reads as a streak passing through.
- **Linking:** `build_instances` cannot set a Beam's or Trail's
  `Attachment0`/`Attachment1`. Build everything, then link them in one
  `execute_luau` (`trail.Attachment0, trail.Attachment1 = inner, outer`) and
  read the result back.
- **Trails** draw a ribbon behind two attachments as they move.
  - For a weapon slash, put the attachments at the base and tip of the blade
    and keep the trail disabled. Enable it only for the swing
    (`EmitDelay` and `EmitDuration`, timed to the animation).
  - Weapon trails come in pairs *(measured)*:
    - a thin hot core: Lifetime 0.04-0.15, Brightness 10-30;
    - a wide, soft, dark or coloured wisp: Lifetime 0.15-0.4,
      `LightEmission` 0.55-0.75.
    Both have a `WidthScale` that tapers to 0.
- **A crescent slash without a mesh:** sweep a trail through an arc.
  - Make a Model with `Start` and `End` parts at the same CFrame, both
    invisible, and give it `Spin` (160), `Duration` (0.14) and `Easing`
    `Quart` `Out`.
  - Put two Attachments on `Start` at the blade's inner and outer radius,
    along -Z. A narrow band reads as a crescent; a wide one reads as a fan.
  - A Trail between them, with `FaceCamera = false` and a width tapering to
    0, draws the crescent as `Start` spins.
  - Roll the whole effect for a diagonal swing. A flat slash seen from a
    low camera is edge-on and almost invisible, so check it from the game's
    real camera height.
- **Mesh effects** are tweened shapes: a crescent slash, a shockwave ring, a
  twisting swirl, a sphere shell. Strong battleground-style games are built
  on them.
  - Build one as a Model with `Start` and `End` parts. The emit module moves
    `Start` to `End`.
  - **How the studied artists tween them** *(measured)*:
    - ease out (cubic) over 0.2-1 s;
    - a shockwave flattens (height x0.1-0.3) while it widens (x2-7) and spins
      120-170°;
    - a swirl stretches upward as it narrows.
  - **How they surface them** *(measured)*:
    - Faint `Neon` that fades out: starting `Transparency` 0.9-0.96 for white
      wind swirls, or 0 for a coloured one.
    - Black `Neon` swirls as dark accents.
    - A `SpecialMesh` (FileMesh) on an invisible part, with a Decal whose
      `Color3` is above 1 so it blooms, fading the Decal. `build_instances`
      takes colour components from 0 to 1 only, so build the Decal there and
      set `Color3.new(4, 6, 8)` and the like with `execute_luau` afterwards.
  - Use `Material = "Neon"` for a glowing shape, or `"ForceField"` with a
    texture for a shimmering, edge-lit shell. ForceField's animation speed
    cannot be controlled, so it suits a shield or aura, not a timed wipe.
  - A one-sided card mesh (a slash) needs `DoubleSided = true` to show from
    behind.
  - Under vertex colours, keep the part's `Color` white, because `Color`
    multiplies them.
  - A MeshPart's texture cannot scroll (`TextureID` has no offset) and
    ignores alpha (checked in Studio: nothing shows through). Animate the
    mesh's size, rotation and `Transparency` instead, or put a scrolling Beam
    alongside.
  - Set `RenderFidelity = Precise` on thin curved shapes. Automatic level of
    detail turns a crescent into a straight-sided wedge at distance.
  - For a texture that fades, put a `Decal` on the card's face and set the
    part's `Transparency` to 1. The emit module fades each Decal on `Start`
    toward the same-named Decal on `End`.
    - On a MeshPart, a Decal is projected across the part's box face and
      ignores UVs, so draw its texture for that projection.
    - On a part with a FileMesh `SpecialMesh`, the studied artists' Decals
      follow the mesh's surface. *(measured; not checked here)*
  - **Verified crescent slash:** two crescents from `roqer.vfx_arc`.
    - A white `Neon` core goes from `Transparency` 0.05 to 1 over 0.2 s.
    - A larger blue `Neon` glow goes from 0.55 to 1 over 0.32 s.
    - Each grows from about 0.8 to 1.2 times its size with `Spin` 50 and
      `Quart` `Out`, and sparks come off the edge.
  - Make the shapes in a Blender job with `roqer.vfx_arc` (crescent),
    `vfx_ring` (shockwave or blast wall), `vfx_cone`, `vfx_swirl` (tornado,
    aura), `vfx_shell` (barrier, dome) or `vfx_surface` (anything else). See
    the `roblox-building` skill's `references/blender-vfx.md`, "Shapes for
    mesh effects". Each has UVs laid out along its sweep.
  - Upload all of an effect's shapes as one model. Without Blender, a flat
    Neon cylinder part works as a ground wave.
- **Shells, domes and columns:** a large mesh that is half transparent across
  its whole surface reads as tinted plastic and covers the screen. That holds
  for a blast dome, a shockwave sphere or a light column; below a
  `Transparency` of about 0.75 it looks solid against a bright sky.
  - Keep a big shell faint (0.85-0.96, as the studied wind swirls start).
  - Or give it a texture (a Decal on a FileMesh) that puts shape on its
    surface: streaks, a broken edge.
  - Let particles and a flash carry the brightness.

## 6. Layer skeletons

Skeletons from the studied effects, with their numbers *(measured)*. Fill
each role with your own texture and colour, and add or drop roles as the
effect's idea needs. They are a floor, not a target: a finished effect should
look made for its game. R is the effect's radius in studs.

**Impact** (a hit, an explosion; every layer fires by `EmitCount` and
`EmitDelay`; times are from the hit):

| Time | Role | Make |
| --- | --- | --- |
| -0.15 s | Anticipation | A glow that shrinks from 1.5R to 0 over 0.1-0.15 s, spinning fast |
| 0 | Flash | A soft ball or four-point flare, 0 to 2.5R, Lifetime 0.06-0.1, Brightness 10, `ZOffset` in front |
| +0.03 s | Impact stars | A spiky 4 x 4 sheet, Lifetime 0.075-0.15, EmitCount 2-6, as a colour layer (`ZOffset` z), a black copy (z + 0.25) and a white copy (z + 1) |
| +0.03 s | Black backing | A soft black blob behind, 2-4R |
| +0.05 s | Streaks | `VelocityParallel` with `Squash`, Speed 60-200, Drag 8-12, with a few black twins |
| +0.05 s | Ring | A flat `VelocityPerpendicular` ring (Speed 0.001) growing to 2-3R over 0.2-0.4 s |
| +0.05 s | Smoke | Constant-size cel puffs (4 x 4 OneShot), Speed 50-120, Drag 8, Lifetime 1-1.5, Transparency to above 1, `TimeScale` 0.7, a warm and a grey layer; beside fire, carrying the fire's colour where it is lit |
| +0.05 s | Embers | Dots at `LightEmission` 1, Speed 10-120, Drag 10, Lifetime 0.75-2 |
| 0 | Light | A PointLight at Brightness 7-16, Range 7-15, fading over 0.5 s |

**Orb** (a sustained form: every layer at Speed 0.001, `LockedToPart`, `Rate`
2-4, Lifetime 0.5-1, Transparency `0:1, 0.5:0, 1:1`, random `Rotation`; front to
back):

| ZOffset | Role | Make |
| --- | --- | --- |
| +0.4 | Black linework | A spiral or rune sheet, 1R, black |
| +0.3 | Hard ring | `LightEmission` 0, Brightness 20-150, 0.9R |
| +0.1 | Black pupil | A small disc pulsing 0.15-0.5R |
| 0 | Core | Rays and fill, `LightEmission` 1, Brightness 5-10, 0.45R, `RotSpeed` ±10-20 |
| -1 | Outer ring | `LightEmission` 1, Brightness 1-4, growing 0.9-1.5R |
| -1.05 | Halo | A soft blob, `LightEmission` 1, Brightness 0.3, 1.6R |
| -1.1 | Black backdrop | A soft black blob, 2R, and a black disc 0.6R behind the core |

**Wind and smoke:**
- **Wind:** 3-6 nearly transparent grey arcs and rings.
  - Crescent and radial-streak textures, flat (`VelocityPerpendicular`,
    Speed 0.001).
  - Growing to 25-35 studs by 60% of life, Transparency from 0.45-0.85 to
    above 1.
  - `LightEmission` 1, `RotSpeed` ±15-20, `ZOffset` 0.5, over the smoke.
- **Smoke:** puffs in warm and grey pairs, lit by the scene.
- **A ground skirt:** a flat copy of the smoke, squashed.
- **Black grit:** a few dark dust particles.

**Examples** of the property shapes as `build_instances` create steps. Add
`parent` (an Attachment for most particles), and replace each stand-in
texture with one drawn for the effect. Colours are 0-1. Sequences are
keypoints from time 0 to 1. On their own they emit nothing: fire them with
`VFX.play` or `VFX.emit`.

Anticipation, a glow that shrinks into the hit:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Anticipation",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_implosion_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": 0.14, "Speed": 0.001, "LockedToPart": true,
    "LightEmission": 1, "LightInfluence": 0, "Brightness": 2, "ZOffset": 1,
    "Rotation": [0, 360], "RotSpeed": [-700, -500], "Color": [1, 0.6, 0.25],
    "Size": [{ "time": 0, "value": 9 }, { "time": 1, "value": 0 }],
    "Transparency": [{ "time": 0, "value": 0.4 }, { "time": 0.3, "value": 0 }, { "time": 1, "value": 0 }]
  },
  "attributes": { "EmitCount": 1 }
}
```

Flash, in front of everything, for a frame or two:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Flash",
  "properties": {
    "Texture": "rbxasset://textures/particles/sparkles_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": [0.06, 0.1], "Speed": 0.001, "LockedToPart": true,
    "LightEmission": 1, "LightInfluence": 0, "Brightness": 10, "ZOffset": 3,
    "Rotation": [0, 360], "Color": [1, 0.95, 0.85],
    "Size": [{ "time": 0, "value": 4 }, { "time": 0.3, "value": 16 }, { "time": 1, "value": 18 }],
    "Transparency": [{ "time": 0, "value": 0 }, { "time": 1, "value": 1 }]
  },
  "attributes": { "EmitCount": 1, "EmitDelay": 0.14 }
}
```

The impact's three-value stack: colour, a black copy just in front of it, and
a small white core in front of both:

```json
[
  { "op": "create", "className": "ParticleEmitter", "name": "ImpactColour",
    "properties": {
      "Texture": "rbxasset://textures/particles/explosion01_core_main.dds",
      "Rate": 0, "Enabled": false, "Lifetime": [0.1, 0.15], "Speed": 0.001, "LockedToPart": true,
      "LightEmission": -1, "LightInfluence": 0, "Brightness": 5, "ZOffset": 1,
      "Rotation": [0, 360], "Color": [1, 0.35, 0.08],
      "Size": [{ "time": 0, "value": 6 }, { "time": 0.25, "value": 11 }, { "time": 1, "value": 12 }],
      "Transparency": 0 },
    "attributes": { "EmitCount": 2, "EmitDelay": 0.16 } },
  { "op": "create", "className": "ParticleEmitter", "name": "ImpactBlack",
    "properties": {
      "Texture": "rbxasset://textures/particles/explosion01_core_main.dds",
      "Rate": 0, "Enabled": false, "Lifetime": [0.08, 0.12], "Speed": 0.001, "LockedToPart": true,
      "LightEmission": 0, "LightInfluence": 0, "Brightness": 1, "ZOffset": 1.25,
      "Rotation": [0, 360], "Color": [0, 0, 0],
      "Size": [{ "time": 0, "value": 4 }, { "time": 0.25, "value": 8 }, { "time": 1, "value": 9 }],
      "Transparency": 0 },
    "attributes": { "EmitCount": 1, "EmitDelay": 0.16 } },
  { "op": "create", "className": "ParticleEmitter", "name": "ImpactWhite",
    "properties": {
      "Texture": "rbxasset://textures/particles/explosion01_core_main.dds",
      "Rate": 0, "Enabled": false, "Lifetime": [0.06, 0.1], "Speed": 0.001, "LockedToPart": true,
      "LightEmission": 0, "LightInfluence": 0, "Brightness": 60, "ZOffset": 2,
      "Rotation": [0, 360], "Color": [1, 1, 1],
      "Size": [{ "time": 0, "value": 3 }, { "time": 1, "value": 5 }],
      "Transparency": 0 },
    "attributes": { "EmitCount": 1, "EmitDelay": 0.16 } }
]
```

Black backing behind the impact:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Backing",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_implosion_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": 0.3, "Speed": 0.001, "LockedToPart": true,
    "LightEmission": 0, "LightInfluence": 0, "Brightness": 1, "ZOffset": -1,
    "Color": [0, 0, 0],
    "Size": [{ "time": 0, "value": 14 }, { "time": 1, "value": 20 }],
    "Transparency": [{ "time": 0, "value": 0.35 }, { "time": 1, "value": 1 }]
  },
  "attributes": { "EmitCount": 1, "EmitDelay": 0.16 }
}
```

Streaks that shoot out and stop:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Streaks",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_implosion_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": [0.2, 0.35], "Speed": [60, 160],
    "SpreadAngle": [180, 180], "Drag": 10, "Orientation": "VelocityParallel",
    "LightEmission": 0, "LightInfluence": 0, "Brightness": 8, "ZOffset": 2,
    "Color": [{ "time": 0, "value": [1, 0.9, 0.6] }, { "time": 1, "value": [1, 0.3, 0.05] }],
    "Size": [{ "time": 0, "value": 1.2 }, { "time": 1, "value": 0 }],
    "Squash": [{ "time": 0, "value": 3 }, { "time": 1, "value": 1 }],
    "Transparency": 0
  },
  "attributes": { "EmitCount": 12, "EmitDelay": 0.18 }
}
```

A flat ring. `VelocityPerpendicular` needs its tiny Speed to show; level the
Attachment with the ground:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Ring",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_shockwave_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": 0.35, "Speed": 0.001,
    "EmissionDirection": "Top", "SpreadAngle": [0, 0], "Orientation": "VelocityPerpendicular",
    "LightEmission": 0, "LightInfluence": 0, "Brightness": 3, "ZOffset": 0.5,
    "Color": [1, 0.85, 0.6],
    "Size": [{ "time": 0, "value": 2 }, { "time": 0.4, "value": 16 }, { "time": 1, "value": 20 }],
    "Transparency": [{ "time": 0, "value": 0 }, { "time": 1, "value": 1.3 }]
  },
  "attributes": { "EmitCount": 1, "EmitDelay": 0.18 }
}
```

Smoke that bursts out, hangs, runs slower than the core and is lit by the
scene:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Smoke",
  "properties": {
    "Texture": "rbxasset://textures/particles/smoke_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": [1, 1.5], "Speed": [50, 90],
    "SpreadAngle": [180, 180], "Drag": 8, "Acceleration": [0, 3, 0], "TimeScale": 0.7,
    "Rotation": [0, 360], "RotSpeed": [-30, 30],
    "LightEmission": 0, "LightInfluence": 1, "Brightness": 1,
    "Color": [0.32, 0.28, 0.26],
    "Size": 6,
    "Transparency": [{ "time": 0, "value": 0.2 }, { "time": 1, "value": 1.6 }]
  },
  "attributes": { "EmitCount": 5, "EmitDelay": 0.2 }
}
```

Light flash:

```json
{
  "op": "create", "className": "PointLight", "name": "FlashLight",
  "properties": { "Brightness": 10, "Range": 14, "Color": [1, 0.7, 0.4], "Shadows": false },
  "attributes": { "EmitDelay": 0.14, "EmitDuration": 0.5 }
}
```

Slash trail, the hot core of a pair (on the weapon; the attachments are at the
base and tip of the blade; time `EmitDelay` to the swing):

```json
{
  "op": "create", "className": "Trail", "name": "SlashCore",
  "properties": {
    "Enabled": false, "Lifetime": 0.12, "MinLength": 0.05, "FaceCamera": false,
    "LightEmission": 0, "LightInfluence": 0, "Brightness": 15,
    "Color": [{ "time": 0, "value": [1, 1, 1] }, { "time": 1, "value": [1, 0.3, 0.1] }],
    "Transparency": [{ "time": 0, "value": 0 }, { "time": 1, "value": 1 }],
    "WidthScale": [{ "time": 0, "value": 0.5 }, { "time": 1, "value": 0 }]
  },
  "attributes": { "EmitDelay": 0, "EmitDuration": 0.25 }
}
```

Ground wave, a mesh effect from a flat neon cylinder, timed to the hit (replace
both parts with a Blender ring mesh for a real shockwave, which can also take
`Spin`):

```json
[
  { "op": "create", "id": "wave", "className": "Model", "name": "GroundWave",
    "attributes": { "Duration": 0.35, "Easing": "Cubic", "EasingDirection": "Out", "EmitDelay": 0.16 } },
  { "op": "create", "className": "Part", "name": "Start", "parent": "$wave",
    "properties": { "Shape": "Cylinder", "Size": [0.1, 2, 2], "Material": "Neon",
      "Color": [1, 0.75, 0.4], "Transparency": 0.55, "Anchored": true, "CanCollide": false },
    "rotation": [0, 0, 90] },
  { "op": "create", "className": "Part", "name": "End", "parent": "$wave",
    "properties": { "Shape": "Cylinder", "Size": [0.05, 20, 20], "Material": "Neon",
      "Color": [1, 0.45, 0.15], "Transparency": 1, "Anchored": true, "CanCollide": false },
    "rotation": [0, 0, 90] }
]
```

## 7. Budgets

- **Particle count:** a few hundred particles per effect is fine
  *(starting point)*; the studied hits stay there by emitting one or a few
  sprites per layer. The engine guide caps emission near 400 a second (100
  on mobile). Cost grows with how much of the screen particles cover, so large
  overlapping transparent layers (overdraw) cost more than many small ones.
- **Emitters:** particles, decals and textures do not batch, so every emitter
  is a draw call. The studied hits use 40-60 emitters for a moment that lasts
  a second. Keep always-on effects much leaner. Don't change emitter
  properties every frame.
- **Parts:** effect parts are anchored, with no collision, query, touch or
  shadows (the emit module sets this on copies it owns). Physics debris is a
  common real cause of lag; keep debris few and short-lived.
- **Pooling:** pool effects that fire constantly (muzzle flashes, footsteps).
  `VFX.play` clones each time, which is right for occasional effects.
- **Quality:** a LocalScript can read
  `UserSettings():GetService("UserGameSettings").SavedQualityLevel` and play a
  lighter variant at low settings. Automatic quality does not expose its level.

## 8. Checking an effect

Effects play in the edit viewport, so no playtest is needed to look at one.
A screenshot takes most of a second, longer than a whole burst, so hold the
effect still for each capture instead of trying to catch it.

1. Build the template and install the module (section 2).

   In edit mode, `require` keeps a ModuleScript's first result for the whole
   Studio session. After changing the emit module, or any module an effect
   uses, remove that ModuleScript and create it again before checking.
   Otherwise the old code runs, and a fix looks as if it did nothing. A new
   playtest always loads fresh code.
2. Frame the spot two ways, and capture each moment from both:
   - **Close**, to judge shapes: `build_instances` a transparent, anchored
     marker part about the effect's size where it will play, then
     `selection` with `action: "view"` on it, from a side and a little above.
   - **From where the player sees it.** This view decides whether the
     effect works. Put a marker where the player's camera will be (about 10
     studs behind and 5 above the caster) and point the camera from it at
     the effect with `execute_luau`: set `CameraType` to `Scriptable`, then
     `CFrame = CFrame.lookAt(eye, target)`.
     A projectile's impact is seen from its whole range away. The close view
     hides an impact that is a speck at range; the far view shows it.

   A new texture can take a moment to load the first time, so a first capture
   may miss layers; take it again.
3. Play it slowed, with `execute_luau`:
   `_G.vfx = require(game.ReplicatedStorage.VFX.Emit).play(template, cframe, { timeScale = 0.1 })`.
4. For each moment to see (anticipation, the flash, the impact stars, the
   peak of the ring, the smoke, the end):
   - one `execute_luau` waits until `_G.vfx.time` reaches it, then calls
     `_G.vfx:setTimeScale(0)`;
   - `capture_screenshot`;
   - another `execute_luau` resumes it with `setTimeScale(0.1)`.

   The frame is held where you asked, to within a few milliseconds of effect
   time.

   **Trails are the exception.** A trail ages in real time while the frame is
   held, so its older segments vanish when the effect resumes. For an effect
   built on trails, play at `timeScale = 0.04` and capture back to back
   without pausing; the module stretches trail lifetimes to match.
5. Ask of each capture:
   - From the player's view, does the payoff fill its share of the screen
     (vfx-design.md section 1)? Does it grow taller for a moment, or stay a
     flat splash on the floor? At 0.3 s, is a body (crescents, tongues,
     puffs) still carrying the mass, or only shards and sparks?
   - Is every layer meant to glow above the place's bloom threshold? A
     Brightness of 1-3 reads as flat paint at Threshold 2.
   - Does the flash frame read as one sharp, overexposed shape, bigger than
     what follows it?
   - Is there something dark, so the bright parts read?
   - Do the shapes have hard silhouettes, or do they look like soft smudges?
   - Is the centre a white blob? Bring the stacked bright layers down until
     the coloured shapes show through. A pale effect on a light floor needs
     its darks most (cobalt, navy, black accents).
   - Does any texture look like clip art or an icon: radially symmetric,
     evenly spaced, or drawn with even outlines?
   - Does everything that moves carry its speed (streaks, wind rings, a
     smear), or does it float?
   - Is a large half-transparent shell covering the view?
   - Does a light tint the whole floor?
   - Does the smoke beside the fire take its colour, or is it one flat tone?
   - Does every layer show? Thin sparks and faint smoke vanish at a normal
     camera distance.
   - Does one layer bury another?
   - Does anything stay constant that should change?
   - Does it end cleanly, with nothing left behind?
6. Stop the effect (`_G.vfx:stop()`), remove the marker, set the camera's
   `CameraType` back to `Custom` so the user's viewport is free, and check
   `get_runtime_logs` for `VFXEmit` warnings: a bad attribute, an emitter with
   nothing to play, a bounded count. Before calling the effect done, check
   that no `rbxasset://textures/roqer-preview/` address is left: players
   would see nothing there.
7. To see it on a character or through a player's camera, the same handle
   works in a `solo_playtest` through `eval_client_runtime`, but the character
   can hide an effect played in front of it.

Effects are judged by eye. Tell the user what you checked and ask them to look
at it at full speed.
