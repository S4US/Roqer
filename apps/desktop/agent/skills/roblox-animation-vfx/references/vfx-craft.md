# VFX craft

Load this before building any visual effect: a hit, a slash, an explosion, a
spell, an aura, a pickup. It covers how a strong effect is put together, the
engine properties that matter, starter recipes, and how to play effects. It
does not replace looking: screenshot every effect you build.

Numbers marked *(starting point)* are common practice with no primary source.
Tune them by looking, not by trusting them.

This reference is a toolbox and a list of traps, not a style. The recipes,
helpers and module exist so the plumbing is quick and correct. The design is
yours: depart from any of it when the effect calls for it.

## What separates great effects

The starter recipes make readable effects, not memorable ones. Top Roblox
VFX get there through:

- **One strong idea.** Decide what the effect is before building layers: a
  heavy crushing slam, a clean surgical cut, a wild unstable surge. Every
  layer, colour and curve serves that idea.
- **Shape language.** Sharp, angular shapes read as fast and violent; round,
  soft ones as magical or gentle. Custom meshes and textures carry this far
  better than default particles.
- **Value and colour.** A bright core, saturated mid-tones and dark accents.
  Two or three colours, not a rainbow. Something dark (smoke, a shadow, a
  black outline) makes the bright parts read.
- **Timing with contrast.** Fast against slow, and holds against bursts. An
  impact that snaps in, holds for a beat, then lingers reads as heavy;
  everything easing at one speed reads as floaty.
- **Secondary motion.** Debris that settles, embers that drift, a shockwave
  that kicks up dust, a lingering glow on the ground.
- **Custom assets.** Bespoke textures, flipbooks and meshes made in Blender
  for this effect.
- **Iteration.** Look at each version frame by frame and at full speed,
  compare it against the idea, and change what is weakest. Several passes
  are normal.

Ask the user for the game's style or a reference when it is not clear. An
effect that fits the game beats a technically busy one.

## 1. How a strong effect is built

**Layers.** A good effect is several simple emitters that each do one job, not
one emitter doing everything. A typical impact, back to front:

| Layer | Job | Typical make |
| --- | --- | --- |
| Glow | Large, faint light behind everything | One additive soft particle |
| Flash | The bright instant of impact | One additive particle, very short |
| Sparks | Speed and direction | Many small particles stretched along their velocity |
| Shockwave | The force spreading out | A flat ring particle, or a mesh that grows and fades |
| Smoke or dust | Weight and aftermath | Normal-blended puffs that slow down and fade |
| Light | Lights the scene for a moment | A `PointLight` that fades out |
| Ground | What stays | A decal, cracks or debris (optional) |

**Phases** *(starting point)*:

- **Anticipation**, 0.1-0.3 s: energy gathers inward.
- **Impact**, 1-3 frames: flash, light, camera shake and hitstop all at once.
- **Dissipation**, 0.5-1.5 s: smoke and embers slow down and fade.

Without the anticipation the impact reads as weaker. The effect is mostly
timing, so stagger the layers with `EmitDelay` rather than firing everything
at once.

**Contrast.** Additive layers (`LightEmission = 1`) only brighten, and wash out
against a bright sky or a white floor. Give a bright effect a darker,
normal-blended layer (smoke, dust) so it reads against any background. Check it
against the place's real lighting.

## 2. Where effects live and how they play

- **Templates** go in `ReplicatedStorage.VFX`, one Model per effect.
  - Each Model has an invisible root part (`Transparency = 1`, anchored, no
    collision), with Attachments holding the emitters.
  - Name the Model after the effect (`Slam`, `SlashHit`). Name each emitter
    after its layer.
- **The player module** is the template `templates/vfx/emit.lua` in this
  skill. Load it with `load_skill`. Create a ModuleScript named `Emit` with
  `build_instances` under the build root `ReplicatedStorage.VFX`, so it sits
  at `ReplicatedStorage.VFX.Emit` beside the templates. Read it for its
  revision, then write the template's body into it with `set_script_source`.
  It is a starting point, not a cage. Extend it, or write your own player,
  when an effect needs something it does not do: Bezier paths, beam texture
  scrubbing, colour over time, camera work, chained effects. If you change
  it, keep the attribute names so VFX editors can still read the effect.
- **Playing an effect:**
  - `VFX.play(template, cframe)` clones the template, places it, plays it and
    removes it once the last particle is gone.
  - `VFX.emit(instance)` plays emitters that already sit on a weapon or
    character, and restores them afterwards.
  - The handle returned has `freeze(seconds)` for hitstop and
    `setTimeScale(scale)` for slow motion. One clock drives particles, meshes,
    lights and trail lifetimes, so they stay in step.
- **The attributes it reads**, the convention VFX Editor, VFX Forge and other
  editors share:

| On | Attribute | Meaning |
| --- | --- | --- |
| ParticleEmitter | `EmitCount` | Burst this many particles (bounded to 500) |
| ParticleEmitter | `EmitDuration` | Emit at `Rate` for this many seconds |
| ParticleEmitter, Beam, Trail, lights | `EmitDelay` | Seconds after the effect starts |
| Beam, Trail | `EmitDuration` | Enabled for this long |
| PointLight, SpotLight, SurfaceLight | `EmitDuration` | On, then `Brightness` fades to 0 over this long |
| Model or Folder with `Start` and `End` parts | `Duration`, `Easing`, `EasingDirection`, `Spin`, `EmitDelay` | `Start` moves to `End`'s CFrame, Size, Transparency and Color; `Spin` is degrees about its up axis |
| The effect's root | `EffectDuration` | When the effect ends, if nothing above sets it |

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

**Built-in textures, no upload.** These ship with Roblox for the legacy Fire,
Smoke, Sparkles and Explosion effects. The default `ParticleEmitter.Texture`
is one of them.

| Texture | Looks like | Use for |
| --- | --- | --- |
| `rbxasset://textures/particles/explosion01_implosion_main.dds` | Soft white round glow | Glow, flash, sparks (stretched), energy |
| `rbxasset://textures/particles/explosion01_shockwave_main.dds` | Soft ring | Shockwaves |
| `rbxasset://textures/particles/explosion01_core_main.dds` | Orange fiery puff | Fire, explosion cores |
| `rbxasset://textures/particles/smoke_main.dds` | Grey cloudy puff | Smoke, dust |
| `rbxasset://textures/particles/sparkles_main.dds` | Four-point star | Twinkles, pickups, magic |
| `rbxasset://textures/particles/fire_main.dds` | Wispy flames | Flames |
| `rbxasset://textures/particles/forcefield_vortex_main.dds` | Thin ring with dots | Magic circles, auras |

These are enough for prototypes, but they are generic, and every Roblox
player has seen them. Distinctive effects come from textures made for them:
- shaped glows and streaks;
- noise-broken smoke;
- stylised slashes and sharp sparkle stars;
- hand-timed flipbooks.

Make them in Blender when the effect deserves it: procedural noise,
compositor passes, painted shapes, rendered simulations. The Creator Store
(`search_assets` with `assetType: "VFX"` or `"Particle"`, then
`preview_asset`) is worth a look when it saves an upload or matches the
style.

**Making a texture.**

- Render it in Blender (load `roblox-building` and its Blender reference), and
  upload it with `upload_asset` as a `Decal`. Use the result's `imageId`
  as `rbxassetid://<imageId>`.
- Every upload is irreversible and moderated, so reuse one texture across
  layers by changing `Color`, `Size` and `Squash`, and say how many uploads a
  request will use before uploading.
- Keep textures square, 512 px or less for most effects and 256 px for small
  ones; memory scales with pixels.
- Pick a blending mode before rendering:
  - **Additive** (`LightEmission = 1`): a white or coloured shape on **black**,
    no alpha needed. Black adds nothing. Use it for fire, energy, glows and
    sparks.
  - **Normal** (`LightEmission = 0`): a straight-alpha PNG, transparent
    background. Use it for smoke, dust, debris and anything that should darken.
  - Roblox has no multiply or premultiplied mode.

**Flipbooks.** A flipbook is a sheet of frames that a particle plays through.
Make one with `roqer.flipbook` in a Blender job: it renders and packs the
sheet to these rules, and Roqer checks it from its pixels. Load the
`roblox-building` skill's Blender reference ("Flipbook sheets for particles").

- `FlipbookLayout` is `Grid2x2`, `Grid4x4` or `Grid8x8` (4, 16 or 64 frames).
  `Custom` with `FlipbookSizeX/Y` was in client beta from October 2025; do not
  rely on it until confirmed.
- Make the sheet 1024×1024, the size uploaded and seen playing frame by
  frame. That is 512 px a frame at 2×2, 256 at 4×4 and 128 at 8×8.
- Do not judge a sheet by `FlipbookIncompatible`. Studio shows "Particle
  texture must be 1024 by 1024 to use flipbooks." there even for a 1024 sheet
  that plays, and for a texture with no flipbook layout at all.
- To check a sheet, hold one particle at a few ages (`TimeScale = 0`) and
  screenshot it. Each capture should show one frame, not the whole grid.
- Leave a few pixels of empty space inside each cell. A frame that touches its
  cell edge bleeds into its neighbour.
- `FlipbookMode`:
  - `OneShot` plays once across the particle's lifetime;
  - `Loop` repeats at `FlipbookFramerate` (at most 30 fps);
  - `PingPong` plays forward and back;
  - `Random` shows one random frame.
  - Use `OneShot` for explosions and `Loop` with `FlipbookStartRandom = true`
    for fire and smoke.
- Some low-memory devices switch flipbooks off, so the first frame should
  still read on its own.

## 4. Particles that look made, not default

- **Stretched sparks:** `Orientation = "VelocityParallel"` with `Squash` above
  0 stretches each particle along its motion. A soft round texture becomes a
  streak.
- **Flat rings and ground waves:** `Orientation = "VelocityPerpendicular"`
  with a small upward `Speed` lays the particle flat.
- **Slowing down:** `Drag` is the half-life of speed in seconds. Fast-then-slow
  motion reads as force; constant speed reads as floaty.
- **Size and transparency curves:** give `Size` and `Transparency`
  keypoints. A burst grows fast then holds, and fades late. A constant size is
  the clearest sign of a default effect.
- **Shapes:**
  - `Shape` (Box, Sphere, Cylinder, Disc) emits from the parent part's volume
    or surface (`ShapeStyle`). The emitter must sit directly under a part
    sized for the shape; under an Attachment it emits from a point.
  - `ShapeInOut = "Inward"` on a sphere gathers particles toward the centre,
    which suits anticipation.
  - `ShapePartial` on a Disc hollows it into a ring.
- **Layer order:** `ZOffset` moves a layer toward the camera without changing
  its size. Put the flash in front of the glow.
- **Following a moving source:** `LockedToPart = true` makes particles follow
  the emitter (an aura, a held torch). Leave it off for anything thrown off.
- **Lighting:** `LightInfluence = 0` keeps a glowing layer bright in a dark
  place. Smoke wants `LightInfluence = 1` so it is shaded like the scene.

## 5. Beams, trails and meshes

- **Beams:**
  - A Beam is a curve between two attachments. `CurveSize0` and `CurveSize1`
    bend it into an arc.
  - Give it enough `Segments` to look smooth: at least one fewer than the
    number of Color and Transparency keypoints, and 20 or more for a visible
    curve.
  - `TextureSpeed` scrolls the texture along the beam, the one built-in way
    to scroll a texture. Use it for flowing energy, lasers and lightning
    arcs.
- **Linking:** `build_instances` cannot set a Beam's or Trail's
  `Attachment0`/`Attachment1`. Build everything, then link them in one
  `execute_luau` (`trail.Attachment0, trail.Attachment1 = inner, outer`) and
  read the result back.
- **Trails** draw a ribbon behind two attachments as they move.
  - For a weapon slash, put the attachments at the base and tip of the blade
    and keep the trail disabled. Enable it only for the swing
    (`EmitDelay` and `EmitDuration`, timed to the animation).
  - Use a short `Lifetime` *(starting point: 0.1-0.3 s)* and a `WidthScale`
    that tapers to 0.
- **A crescent slash without a mesh:** sweep a trail through an arc.
  - Make a Model with `Start` and `End` parts at the same CFrame, both
    invisible, and give it `Spin` (160), `Duration` (0.14) and `Easing`
    `Quart` `Out`.
  - Put two Attachments on `Start` at the blade's inner and outer radius,
    along -Z. A narrow band reads as a crescent; a wide one reads as a fan.
  - A Trail between them, with `FaceCamera = false` and a width tapering to
    0, draws the crescent as `Start` spins. A second, wider, fainter trail
    is the afterglow. A ParticleEmitter on the outer attachment sheds motes
    along the edge.
  - Roll the whole effect for a diagonal swing. A flat slash seen from a
    low camera is edge-on and almost invisible, so check it from the game's
    real camera height.
- **Light columns:** a Neon cylinder at `Transparency` below about 0.75 looks
  like solid plastic against a bright sky. Keep it at 0.8 or above and let a
  flash and particles carry the brightness.
- **Mesh effects** are tweened shapes: a crescent slash, a shockwave ring, a
  twisting swirl, a sphere shell. Strong battleground-style games are built
  on them.
  - Build one as a Model with `Start` and `End` parts (recipe below). The emit
    module moves `Start` to `End`.
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
    toward the same-named Decal on `End`. A Decal is projected across the
    part's box face and ignores UVs, so draw its texture for that projection.
  - **Verified crescent slash:** two crescents from `roqer.vfx_arc`.
    - A white `Neon` core goes from `Transparency` 0.05 to 1 over 0.2 s.
    - A larger blue `Neon` glow goes from 0.55 to 1 over 0.32 s.
    - Each grows from about 0.8 to 1.2 times its size with `Spin` 50 and
      `Quart` `Out`, and sparks come off the edge.
    - It reads far better than the swept-trail slash.
  - Make the shapes in a Blender job with `roqer.vfx_arc` (crescent),
    `vfx_ring` (shockwave or blast wall), `vfx_cone`, `vfx_swirl` (tornado,
    aura) and `vfx_shell` (barrier, dome). See the `roblox-building` skill's
    Blender reference, "Shapes for mesh effects". Each has UVs laid out along
    its sweep.
  - Upload all of an effect's shapes as one model. Without Blender, a flat
    Neon cylinder part works as a ground wave.
- **Impact frames:** for the frame or two of a big hit, add a
  `ColorCorrectionEffect` and a white `Highlight` on the target. Parent the
  correction to `workspace.CurrentCamera` so it affects only the local player.
  Some correction settings hide particles; screenshot to check.
- **Camera shake:** small offsets that decay, owned by the local player. See
  `references/full.md` §7.

## 6. Recipes

Each recipe is a `build_instances` create step. Add `parent` (an Attachment
for most particles, the root part for shaped emitters), then tune by
screenshot. Colours are 0-1. Sequences are keypoints from time 0 to 1.

These start from the built-in textures above. All are bursts unless
noted. Fire them with `VFX.play` or `VFX.emit`; on their own they emit nothing.
They were tuned by contact sheet against the default Baseplate's lighting:
together (gather, then everything else delayed 0.25 s) they make a readable
ground slam. A darker or brighter place needs its own pass.

They are a floor, not a target: correct property shapes and sensible values
to start from. Change textures, colours, curves and counts freely, and add
layers they do not have. A finished effect should look made for its game,
not assembled from these.

Flash:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Flash",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_implosion_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": [0.12, 0.16], "Speed": 0,
    "LightEmission": 1, "LightInfluence": 0, "ZOffset": 1,
    "Color": [1, 0.95, 0.85],
    "Size": [{ "time": 0, "value": 2 }, { "time": 0.3, "value": 7 }, { "time": 1, "value": 8 }],
    "Transparency": [{ "time": 0, "value": 0 }, { "time": 0.5, "value": 0.2 }, { "time": 1, "value": 1 }]
  },
  "attributes": { "EmitCount": 1 }
}
```

Glow:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Glow",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_implosion_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": 0.35, "Speed": 0,
    "LightEmission": 1, "LightInfluence": 0, "ZOffset": 0.5,
    "Color": [1, 0.55, 0.2],
    "Size": [{ "time": 0, "value": 8 }, { "time": 1, "value": 14 }],
    "Transparency": [{ "time": 0, "value": 0.55 }, { "time": 1, "value": 1 }]
  },
  "attributes": { "EmitCount": 1 }
}
```

Sparks:

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Sparks",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_implosion_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": [0.3, 0.5], "Speed": [40, 70],
    "SpreadAngle": [180, 180], "Drag": 5, "Acceleration": [0, -40, 0],
    "Orientation": "VelocityParallel", "LightEmission": 1, "LightInfluence": 0, "Brightness": 3,
    "Color": [{ "time": 0, "value": [1, 0.85, 0.4] }, { "time": 1, "value": [1, 0.35, 0.05] }],
    "Size": [{ "time": 0, "value": 0.8 }, { "time": 1, "value": 0 }],
    "Squash": [{ "time": 0, "value": 3 }, { "time": 1, "value": 1.5 }],
    "Transparency": 0
  },
  "attributes": { "EmitCount": 30 }
}
```

Shockwave ring (lies flat; put the Attachment level with the ground):

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Shockwave",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_shockwave_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": 0.4, "Speed": 0.1, "Drag": 10,
    "EmissionDirection": "Top", "SpreadAngle": [0, 0],
    "Orientation": "VelocityPerpendicular", "LightEmission": 1, "LightInfluence": 0, "Brightness": 2,
    "Color": [1, 0.85, 0.6],
    "Size": [{ "time": 0, "value": 2 }, { "time": 0.4, "value": 14 }, { "time": 1, "value": 18 }],
    "Transparency": [{ "time": 0, "value": 0 }, { "time": 0.5, "value": 0.3 }, { "time": 1, "value": 1 }]
  },
  "attributes": { "EmitCount": 1, "EmitDelay": 0.02 }
}
```

Smoke (normal blending, so it reads on bright backgrounds):

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Smoke",
  "properties": {
    "Texture": "rbxasset://textures/particles/smoke_main.dds",
    "Rate": 0, "Enabled": false, "Lifetime": [1, 1.6], "Speed": [8, 14],
    "SpreadAngle": [180, 180], "Drag": 2.5, "Acceleration": [0, 2, 0],
    "Rotation": [0, 360], "RotSpeed": [-40, 40],
    "LightEmission": 0, "LightInfluence": 0.6,
    "Color": [0.3, 0.27, 0.25],
    "Size": [{ "time": 0, "value": 3 }, { "time": 1, "value": 10 }],
    "Transparency": [{ "time": 0, "value": 1 }, { "time": 0.08, "value": 0.1 }, { "time": 0.6, "value": 0.5 }, { "time": 1, "value": 1 }]
  },
  "attributes": { "EmitCount": 14, "EmitDelay": 0.05 }
}
```

Gather (anticipation; parent it directly to a part sized as the gather radius,
not to an Attachment):

```json
{
  "op": "create", "className": "ParticleEmitter", "name": "Gather",
  "properties": {
    "Texture": "rbxasset://textures/particles/explosion01_implosion_main.dds",
    "Rate": 120, "Enabled": false, "Lifetime": [0.2, 0.25], "Speed": [14, 18],
    "Shape": "Sphere", "ShapeStyle": "Surface", "ShapeInOut": "Inward",
    "Orientation": "VelocityParallel", "LightEmission": 1, "LightInfluence": 0, "Brightness": 3,
    "Color": [1, 0.8, 0.45],
    "Size": [{ "time": 0, "value": 0.7 }, { "time": 1, "value": 0.2 }],
    "Squash": 3,
    "Transparency": [{ "time": 0, "value": 1 }, { "time": 0.3, "value": 0 }, { "time": 1, "value": 0 }]
  },
  "attributes": { "EmitDuration": 0.25 }
}
```

Light flash:

```json
{
  "op": "create", "className": "PointLight", "name": "FlashLight",
  "properties": { "Brightness": 6, "Range": 16, "Color": [1, 0.75, 0.45], "Shadows": false },
  "attributes": { "EmitDuration": 0.25 }
}
```

Slash trail (on the weapon; the attachments are at the base and tip of the
blade; time `EmitDelay` to the swing):

```json
{
  "op": "create", "className": "Trail", "name": "SlashTrail",
  "properties": {
    "Enabled": false, "Lifetime": 0.18, "MinLength": 0.05, "FaceCamera": false,
    "LightEmission": 1, "LightInfluence": 0,
    "Color": [{ "time": 0, "value": [1, 1, 1] }, { "time": 1, "value": [0.4, 0.7, 1] }],
    "Transparency": [{ "time": 0, "value": 0 }, { "time": 1, "value": 1 }],
    "WidthScale": [{ "time": 0, "value": 1 }, { "time": 1, "value": 0 }]
  },
  "attributes": { "EmitDelay": 0, "EmitDuration": 0.25 }
}
```

Energy arc (a Beam between two attachments; give it a scrolling texture to
make it flow):

```json
{
  "op": "create", "className": "Beam", "name": "Arc",
  "properties": {
    "Enabled": false, "CurveSize0": 4, "CurveSize1": -4, "Segments": 24,
    "Width0": 1.2, "Width1": 0.2, "FaceCamera": true,
    "LightEmission": 1, "LightInfluence": 0, "TextureSpeed": 2, "TextureMode": "Stretch",
    "Color": [0.5, 0.8, 1],
    "Transparency": [{ "time": 0, "value": 0.2 }, { "time": 1, "value": 0.8 }]
  },
  "attributes": { "EmitDuration": 0.3 }
}
```

Ground wave (a mesh effect from a flat neon cylinder; replace both parts with
a Blender ring mesh for a real shockwave):

```json
[
  { "op": "create", "id": "wave", "className": "Model", "name": "GroundWave",
    "attributes": { "Duration": 0.35, "Easing": "Quint", "EasingDirection": "Out" } },
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

- **Particle count:** keep each burst's `EmitCount` modest *(starting point:
  under 50 per emitter, a few hundred per effect)*. The engine guide caps
  emission near 400 a second (100 on mobile). Cost grows with how much of the
  screen particles cover, so large overlapping transparent layers (overdraw)
  cost more than many small ones.
- **Changes:** particles, decals and textures do not batch, so every emitter
  is a draw call. Don't change emitter properties every frame.
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
2. Frame the spot: `build_instances` a transparent, anchored marker part
   about the effect's size where it will play, then `selection` with
   `action: "view"` on it, from a side and a little above. Effects read
   smaller than expected, so frame close.
3. Play it slowed, with `execute_luau`:
   `_G.vfx = require(game.ReplicatedStorage.VFX.Emit).play(template, cframe, { timeScale = 0.1 })`.
4. For each moment to see (anticipation, the impact, the peak of the
   shockwave, the smoke, the end):
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
   - Does every layer show? Thin sparks and faint smoke vanish at a normal
     camera distance.
   - Does the bright layer read against the background?
   - Does one layer bury another?
   - Does anything stay constant that should change?
   - Does it end cleanly, with nothing left behind?
6. Stop the effect (`_G.vfx:stop()`), remove the marker, and check
   `get_runtime_logs` for `VFXEmit` warnings: a bad attribute, an emitter with
   nothing to play, a bounded count.
7. To see it on a character or through a player's camera, the same handle
   works in a `solo_playtest` through `eval_client_runtime`, but the character
   can hide an effect played in front of it.

Effects are judged by eye. Tell the user what you checked and ask them to look
at it at full speed.
