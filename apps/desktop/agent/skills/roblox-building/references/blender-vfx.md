# Blender for visual effects

Load this with [Blender modeling](blender.md), which covers what a job is
and how to read its result. This reference covers:
- drawing particle textures and flipbooks;
- previewing them in Studio before uploading;
- making shapes for mesh effects.

For how an effect is layered and timed, see the `roblox-animation-vfx`
skill's VFX craft reference.

## Particle textures and flipbooks

A particle texture decides most of how an effect looks. Most textures by
experienced Roblox VFX artists are 2D drawings, not renders: a white,
hard-edged silhouette on transparency, cel-shaded in two or three flat tones,
that the particle's `Color` tints. This comes from studies of published
effects and a 49-sheet hand-drawn texture set (see the `roblox-animation-vfx`
skill's `references/vfx-design.md`):

- **Shapes:** flame tongues, spiky impact stars, crisp smoke puffs with a lit
  and a shadow side, crescents and claws, wobbly rings, wisps, zig-zags,
  splinters, shaded rocks, four-point flares and dots.
- **Edges:** hard. Alpha is binary with a 1-2 px anti-aliased rim, or
  posterised to about 16 steps. Only an accent texture or two is soft.
- **Detail:** from negative space (holes, notches, overhangs, scribbled
  interior strokes) and tapering stroke widths, not from shading. Silhouettes
  are asymmetric.
- **Frames:** 4 x 4 sheets are the most common. The shape grows to a peak
  around frame 4-6, then breaks into 2-6 pieces; the last cells may be blank.
- **Size in the cell varies.** Many sheets fill most of the cell. The
  hand-drawn set keeps shapes small (half span less than 27% of the cell) and
  lets the particle's `Size` scale them.
- **Glows:** soft round glows are one layer among many, not the effect.

A soft, grey, rendered smoke ball with no silhouette, whose frames barely
change, is the look to avoid. It reads as a smudge at game distance.

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
game distance, a soft edge where it should be crisp, or a fade where it should
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
- **Framing:** frame the camera so the subject stays inside the view on every
  frame, at the size you want in the cell. An orthographic camera looking
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
- **notes:** frames that hold;
- the `FlipbookLayout`, `FlipbookMode` and `LightEmission` to use, with the
  `Lifetime` for a one-shot sheet or the `FlipbookFramerate` for a loop.

Fix every problem before uploading, and weigh every note. The sheet is
attached; look at it.

**Preview before uploading.** Run the job with `preview_in_studio: true`.
Roqer copies each sheet and PNG into the user's Studio install and returns an
`rbxasset://textures/roqer-preview/...` address for each. Set a
`ParticleEmitter.Texture` to it, and Studio plays the sheet as players would
see it, with no upload (checked in Studio on Windows).
- **A redraw needs a new job.** Studio keeps a file's first image for the
  session, and each job's files get new addresses. Point the emitters at the
  new ones.
- **The addresses work on this computer only.** Players see nothing there.

To use a sheet:

1. **While it changes:** iterate on previews (above). Judge each version in
   the effect, at game distance, before drawing the next.
2. **Once it is settled:** upload it with
   `upload_asset {action: 'upload', filePath, assetType: 'Decal', displayName}`,
   and set `ParticleEmitter.Texture` to `rbxassetid://<imageId>`.
   - Replace every `rbxasset://textures/roqer-preview/` address left in the
     place before calling the work done.
   - To find any that remain, scan with `execute_luau`: walk
     `game:GetDescendants()` and report each ParticleEmitter, Beam, Trail,
     Decal or Texture whose `Texture` starts with that prefix.
3. **Apply the settings Roqer listed.**
4. **Confirm it plays:** hold one particle at a few ages (`TimeScale = 0`) and
   take screenshots. Each should show one frame, not the whole grid. Do not go
   by `FlipbookIncompatible`: Studio shows its size message even for a sheet
   that plays.

Every upload is irreversible and moderated, so upload only settled sheets.
Put several textures an effect needs into one job, and reuse one sheet across
layers by changing `Color`, `Size`, `Rotation` and `Squash`. For layering,
timing and the rest of the effect, see the `roblox-animation-vfx` skill's VFX
craft reference.

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
