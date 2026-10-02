# VFX design

Load this with `references/vfx-craft.md` before building a visual effect. It
covers what experienced Roblox VFX artists do and why:
- what the effect is for;
- colour, value and brightness;
- textures, layers and timing;
- projectiles, beams, sustained forms, and the camera and world around them.

`vfx-craft.md` covers the engine, the tools and how to check an effect. This
reference is a set of observations, not a style. Depart from it when the
effect calls for it.

How far to trust a number:
- *(measured)*: from two studies of published effects by experienced Roblox
  VFX artists.
  - The first covered 22 effects: 3,950 particle emitters, their scripts and
    videos of them playing.
  - The second covered 27 effects: skills, showcases, practice pieces and a
    hand-drawn texture set, plus a tutorial by the artist snaliel.
- *(verified)*: checked in Studio.
- *(starting point)*: common practice; tune it by looking.

## 1. Start from what the effect is

- **Name the move before drawing anything:** a frequent basic skill, an
  ultimate, a summon, a buff, a pickup, an aura, a showcase piece. Its role
  sets its scale *(measured)*:
  - **A basic skill** with a one-second cooldown (a water barrage) is small,
    one hue and short. Its hits last about 1 s and are cleaned up by 3 s.
  - **An ultimate** is staged. It roots the caster for seconds, charges, uses
    camera and screen work, and leaves craters and scorch marks.
- **Size the payoff for where the player sees it.** A projectile's impact
  lands at the end of its range, so a 40-stud throw is watched from about 50
  studs. At 50 studs a 16:9 screen at the default field of view is about 125
  studs wide. In 26 studied impacts, the largest layer is usually a flash, a
  flare or a shockwave that reaches its size for a fraction of a second
  while it fades *(measured)*:
  - **One hit of many** (a barrage, an arrow rain, a missile salvo): 10-13
    studs. Most peak at once and halve within 0.1-0.25 s.
  - **One projectile that is the whole skill** (a fireball, a star, a
    Zoltraak beam's end): 70-360 studs. A meteor slam's smoke grows to 237.
  - **A skill's finishing explosion:** 40-275 studs. Seven of nine
    explosions and slams kept growing for 0.25-1.35 s after the hit
    (section 7).

  The solid bodies are smaller: a practice explosion's crescents grow to 19
  studs, and a fireball skill's crescents and lightning to 125.

  A charge reads easily: it is near the camera, against the caster's dark
  body, and moving inward. An impact has the opposite problem: it is far
  away, on a bright floor, and spreading flat. Give it the size, brightness
  and height to make up for that.

  In a test, an ice spear's 13-stud shatter was a speck from the caster's
  camera. The same shatter at 2.5 times the size, with its hot layers at
  Brightness 12-60, read as a burst *(verified)*. It still read as a splash
  rather than an eruption: size and brightness are not the whole fix.
- **Borrow the rhythm and silhouette of a reference, not its colour.** The
  studied fan pieces read clearly as Gojo's Reversal Red, a Kamehameha, a
  Katon fire dragon, a Gate of Babylon volley and Ayato's sword kit:
  - each keeps its move's beats, shape and scale;
  - colour may change (the Ayato piece is amber, not Hydro blue).
- **Decide the dominant shape.** In the tutorial's example the defining
  choice is flat: a wide spiral on the ground, which reads instantly as an
  area attack. A vertical column reads as a pillar; a forward cone reads as a
  directed blast. An impact that stays flat (a ring, a patch, a low splash)
  shrinks to a smear on the floor from the caster's camera. The studied
  explosions throw something up as well: flame tongues, crystal spires, a
  smoke column or rising debris.
- **Ask for the game's style** when it is not clear. An effect that fits the
  game beats a busy one.

## 2. Colour

**Pick a palette before anything else** *(measured: the tutorial)*:
- Choose about five colours. Use them on every part, emitter, beam and decal.
- Add nothing outside them. One orange spark in a purple effect reads as a
  mistake, even to a viewer who cannot say why.
- Colour is seen before timing or shape. It decides whether a move reads as
  hot or cold, physical or magical, and whose it is.

**How the palettes are built** *(measured)*:
- **One hue is common** for elemental skills: water `#7ba5ff`, heal
  `#40ff40`, fire `#ff3c22`, rust `#aa4923`, Gojo's red. Value comes from
  Brightness, LightEmission and a dark stop in the gradient. A screen tint can
  add the saturation the particles hold back.
- **Two analogous hues** about 45-50° apart, such as lime with gold, or
  peach with magenta. Two ways to use them:
  - twin each layer, one copy per hue, 0.01 apart in `ZOffset`;
  - or run a gradient through the second hue over a twin held at the first:
    `#5e76ff` to `#ff55ff` and back.
- **A complementary accent** stays small: about 10% of layers, such as
  purple lightning in orange fire, or blue rings around an orange beam. A
  full complementary clash (orange against cobalt) is kept for impacts, with a
  black layer between the two.
- **Saturated energy, desaturated matter.** Energy (rings, flames, beams) is
  saturated. Debris, rocks, dust and smoke are grey or low-saturation.
  - The contrast sells weight: pure energy feels weightless, and debris
    without energy feels like an accident.
  - Always pair the two.

**Gradients carry value as well as hue** *(measured)*:
- A layer can run light and warm, then saturated, then dark, then nearly
  black over its life, for example `#ffcb47` to `#71ff54` at 0.24, `#143b16`
  at 0.45 and `#031107`.
- At `LightEmission` 0 the dark tail renders as solid dark shapes, so the
  effect gets its darks without a separate black layer.
- Fire gradients end in black, and may start blue or violet for the first
  10-25% of life.

**Smoke and white:**
- **Smoke beside fire takes the fire's colour** where the fire lights it:
  - a `Color` sequence that passes through the fire's orange (the Megumin
    explosion's smoke goes grey, `#ff5500`, grey);
  - or a puff drawn with its colours baked in.

  One flat dark tone reads as a cut-out.
- **Smoke away from fire** comes in warm and grey pairs, lit by the scene
  (`LightInfluence` 0.35-2).
- **White is kept** for thin shapes: rings, flares, winds, crescents and the
  hottest core (section 3).
- **Lights take the palette too.** One PointLight per hue tints the
  character in both colours of a two-hue effect.

## 3. Value

The bright parts read only against something darker *(measured)*. Ways the
studied artists get it:
- **Black layers:** 7% of all emitters in the first study, and 10-35% in
  value-focused pieces.
  - **Backing:** behind the colour (`ZOffset` -1 to -3), 1.1-4.5 times its
    size.
  - **Accents:** in front and smaller: ink lines, a dark pupil, cuts through a
    crescent.
  - **Black twins:** a black copy that moves differently from the bright one,
    so it breaks the shape up instead of muting it.
- **Black without black:**
  - a white sprite at Brightness 0-0.01;
  - a dim twin of the same hue at Brightness 0.05-0.6, one `ZOffset` step
    behind a Brightness 3-6 copy, with a slightly longer life;
  - the dark tail of a gradient (section 2).
- **Stacked copies for an inner gradient.** Three copies of one flame sheet:

  | Copy | Brightness | ZOffset | Squash | Lifetime |
  | --- | --- | --- | --- | --- |
  | Top | 5 | 0 | 0.3 | 0.6 |
  | Middle | 2 | -0.1 | 0.2 | 0.7 |
  | Back | 1 | -0.2 | 0.1 | 0.8 |

  Each copy is a little wider and longer-lived than the one above it, which
  gives a core-to-halo value step inside flat shapes.
- **Glow that cools.** One copy at `LightEmission` 1 that dies first, and one
  at 0 that lives longer, so sparks cool from glow to solid.
- **A white base under additive colour.** Semi-transparent white smoke at
  `LightEmission` 0 (Transparency 0.6-0.95) under coloured additive smoke
  keeps the core readable on a bright sky.
- **Inverted value for dark energy.** A black beam core (width 2-4,
  `ZOffset` +1) in front of a white additive halo (width 12, Transparency 0.5),
  with black and white twins of the same particles. The only colour is one
  accent.
- **The three-value stack on impacts:** colour at `ZOffset` z, black at
  z + 0.25, white at z + 1, all short-lived.
- **White is a thin shape, not a fill.** The short-lived pure-white layers
  are rings, crescents, winds and spiky stars, at Brightness 1-2.
  *(measured: 67 layers)*
  - The hot centre comes from a coloured layer at high Brightness.
  - A filled white disc, or several bright layers stacked over the core, is a
    white blob that hides the shapes. Additive layers add up, so three
    overlapping glows go white.
- **Pickups and icons.** A near-black disc (Brightness 0.01) framed by a
  bright ring keeps an icon readable on any background. Glow, rays and fire
  around it carry the colour code.

How black renders *(verified)*:

| Setting | Result |
| --- | --- |
| `LightEmission` 0 | Solid ink |
| `LightEmission` 0.55 | A faint dark veil |
| `LightEmission` 1 | Invisible |

## 4. Brightness and blending

`Brightness` multiplies `Color`. In the first study the median Brightness was
9 and a quarter were above 25. In the second, most layers sat at 3-10
*(measured)*. Those medians include trails, auras and smoke. In the hit
itself the hottest layer runs higher: Brightness 15 at the median of 26
impacts, and 50 or more in a third of them *(measured)*.

The difference is the place's bloom:
- The first study's places had Bloom Threshold 2, as a new place does.
- The second study's places ran Threshold 1 to 2 and Intensity 1 to 1.5. Five
  of nine were below 2, and at Threshold 1 Brightness 5 already blooms.
- **Read the place's `BloomEffect` before choosing Brightness.**

How one orange shape renders under a new place's lighting *(verified)*:

| Setting | Over a dark background | Over a bright background |
| --- | --- | --- |
| `LightEmission` 0, Brightness 1 | Flat orange | Flat orange |
| `LightEmission` 0, Brightness 5-25 | Hot yellow-orange, blooming | Pale, toward white |
| `LightEmission` 0, Brightness 150 | White-hot core | White |
| `LightEmission` 1 (additive), Brightness 1 | Lighter, pale | Washes out, nearly gone |
| `LightEmission` 1 (additive), Brightness 5 | White glow | White glow |
| `LightEmission` -1 to -3 | Saturated, solid | Saturated, solid, with a dark rim |

- **Hard cel shapes:** `LightEmission` 0 or negative with Brightness 5-55.
  Solid fire bodies go to Brightness 25-100 at `LightEmission` -1 to -5.
- **Glows, flares and halos:** `LightEmission` 1 at Brightness 0.05-1.
  Their job is the bloom around a shape.
- **Glow-first is a different style.** One studied artist ran `LightEmission`
  1 on more than half the layers, with fractional values as a mixing dial and
  colour-correction frames on top. It works in a dark scene.
- **The white-hot core:** one or two front layers at Brightness 50-150, with a
  shape (spikes, a star or a ring), lasting 0.03-0.1 s.
- **Neon mesh flashes** run hotter: Brightness 78 falling to 27 by 7% of
  life, with the colour going white to black as the ring expands
  *(measured)*.
- **A Decal's `Color3` above 1** is overbright and blooms *(verified)*.
  Artists use 2-20 on shockwave and slash decals.
- **A glowing crack that cools:** a decal at `Color3` around 10, tweened to
  black over about 1.3 s.

## 5. Textures

- **They are custom.** In the first study 915 distinct textures appear, and
  only 8 emitters used a Roblox built-in *(measured)*.
- **White, with the shape in alpha.** The particle's `Color` tints them.
- **Hard edges.** Alpha is either binary with a 1-2 px anti-aliased rim, or
  posterised to about 16 steps. Soft gradients are kept for one or two accent
  textures (a glow, a soft rim). *(measured: a 49-sheet hand-drawn set)*
- **Detail from negative space, not shading.** Holes, notches, overhangs and
  scribbled interior strokes. Stroke width tapers as with pen pressure.
  Silhouettes are asymmetric. When there is shading, it is one or two flat
  tones (a lit and a shadow side).
- **Common shapes:** crescents and claws, lumpy puffs, wobbly rings, wisps,
  flame tongues, zig-zags, spiky stars, splinters, shaded rocks and dots.
- **Frames change by growing and then breaking apart.** A shape grows with
  an ease-out to a peak around frame 4-6, then is eaten into 2-6 fragments.
  The last few cells may be blank, so a one-shot particle vanishes early.
  Most sheets are 4 x 4.
- **Size within the cell varies.**
  - Many sheets fill most of the cell at their largest frame.
  - The hand-drawn set keeps shapes small: half span less than 27% of the
    cell, and the particle's `Size` does the scaling.

  Either works; what matters is the edge and the motion.
- **What made a generic texture look generic:**
  - Roqer's first attempt: soft, grey, rendered smoke with no silhouette, low
    contrast, and frames that barely changed.
  - A later attempt: a perfectly radial impact star with even, thin outlines,
    a snowflake-symmetric frost patch, and a ring with gear-like notches. They
    read as clip art and icons, not drawings.
- **Not symmetric, not even.** Hand-drawn shapes are lopsided, with uneven
  counts, lengths and spacing, and strokes that taper. Draw them as tapered
  strokes, lumpy blobs and warped coordinates (`tex_stroke`, `tex_blob`,
  `tex_warp`), not as rays and rings around a centre.

Draw them with `roqer.draw_flipbook` (the `roblox-building` skill's
`references/blender-vfx.md`).

## 6. Layers and orientation

- **Many layers, usually one sprite each** *(measured)*:
  - one hit in the studied slashes has 40-60 distinct layers;
  - a small orb is 17 layers on one attachment;
  - the median `EmitCount` is 1, and 37% of emitters have Speed near 0:
    sprites stacked and timed in place.
- **Big counts are for scatter:** sparks, droplets, debris and dots at 10-160
  a burst. Sustained beams and trails use `Rate` 15-2000.

| Orientation | Used for | Share in the first study |
| --- | --- | --- |
| `FacingCamera` | Puffs, glows, flares, impact stars | 40% |
| `VelocityPerpendicular` | Flat rings, sigils, crescents in a fixed plane, ground marks | 34% |
| `VelocityParallel` | Streaks: sparks, flame tongues, speed lines, debris | 23% |
| `FacingCameraWorldUp` | Rising columns, upright specs | 3% |

- **A flat sprite needs a direction.** `VelocityPerpendicular` lays a sprite
  across its direction of travel, so give it a tiny `Speed` (0.001). At Speed 0
  it does not show at all *(verified)*. Aim a flat crescent with `Rotation` and
  sweep it with `RotSpeed`.
- **Streaks:** `VelocityParallel` with `Squash` (often ramped, up to ±3, or
  -18 for extreme lines) and `Rotation` -90, so the texture's long axis follows
  the motion.
- **Mirrored pairs:** two copies at `Rotation` -90 and +90 make symmetric
  wings.

## 7. Timing: the intensity curve

From the tutorial *(measured)*, in four rules:
- **Fire once, die at different times.** An effect is usually one emit in
  which the elements have different lifetimes. The order in which they
  disappear is what creates the feeling of progression.
- **Intensity only goes down.** Plot intensity against time: it peaks at the
  emit and only goes down from there. Place key poses along that line, each
  one clearly readable and each less intense than the last:
  1. the big flashy energy, with wind;
  2. the scatter: debris, shards and energy fragments moving outward, with the
     flash gone;
  3. the residue: dust settling, a faint glow, the last smoke.

  Nothing in the middle or at the end gets brighter again.

  **Brightness falls, but an explosion's mass can still grow.** Measured as
  the screen area of every live particle, seven of nine explosions and slams
  kept growing for 0.25-1.35 s after the hit: the flash dies while flames,
  spires, smoke and debris swell, rise and spread. Only the small hits peak
  at once *(measured)*. A finisher that is biggest at its flash and then only
  shrinks reads as a pop, not an explosion.

  **The mass comes from body layers that outlive the flash.** In the studied
  explosions, crescents, flame tongues and puffs carry the effect from 0.1 to
  0.6 s *(measured)*:
  - a practice explosion's crescents grow from 2 to 19 studs over 0.36-0.55
    s, and its smoke holds 20 studs for 0.6-1.2 s;
  - a fireball skill's crescents grow to 125 studs over 0.35-0.55 s.

  Shards, sparks and glints are accents, not mass. In a test, an ice
  shatter whose body layers died by 0.2 s became 40 shards of 2 studs by
  0.25 s, and read as a sparkler from the caster's camera *(verified)*.
- **Stagger cause and effect.** Nothing fires at the same time. In the
  tutorial's example the wall launches, then the dragon appears 0.4 s later,
  then the hit, then the cracks, then the debris. Simultaneous layers read as
  noise.
- **Shockwave rings are the cheapest strong trick.** A thin flat Neon disc
  mesh that grows from small to massive in 0.2 s while its Transparency goes
  from 0 to 1.

Typical lifetimes *(measured)*:

| Layer | Lifetime |
| --- | --- |
| Flash, impact frames | 0.03-0.15 s |
| Crescents and slashes | 0.15-0.4 s |
| An explosion's body (crescents, tongues, puffs) | 0.35-1.2 s |
| Rings and debris | 0.4-1.4 s |
| Smoke and ground marks | 1-3 s, scorch up to 6 s |

**Before the hit:**
- **Anticipation:** 0.1-0.6 s before the hit, for a bigger move up to 1.35 s.
  Ways to show it:
  - energy gathers inward;
  - converging trails from a 16-stud circle over 0.5 s;
  - particles at negative Speed or `ShapeInOut` Inward;
  - an implosion: a spiky ring shrinking from 11 to 0 in 0.15-0.2 s, once or
    twice;
  - a tiny charge that then releases about ten times bigger (the Reversal Red
    piece).
- **Fire the hit slightly early.** Projectiles trigger their impact 0.01-0.1
  s before arrival, and accelerate into it (Quad In).

**The hit:**
- **Layer order:** the flash fires at 0, everything else at +0.03 s or later,
  in steps 0.025-0.05 s apart.
- **The flash itself** is a growing sprite, a shrinking one (7 to 0 in 0.1
  s), and a thin squashed flare line (`Squash` -2 to -5, 0.04-0.12 s). In
  its frames it is the biggest thing on screen, larger than the burst that
  follows. Its body is a filled spiky shape covering most of its cell; the
  thin flare is an addition. A thin four-ray flare used as the whole flash
  shows as two white beams in a V once it is rotated *(verified)*.
- **A held contact point** (a beam hitting a wall) strobes its flash:
  Lifetime 0.1 at `Rate` 50.

**After the hit:**
- **Hit, hold, hit bigger.** A second hit about 1.4 s after the first, scaled
  1.6-1.8 times in size and speed, with a camera punch. A held aura bridges
  the gap.
- **Lingering layers run slower:** `TimeScale` 0.6-0.95 on smoke and wind
  while the core stays at 1.
- **A linger can grow about 20%** over 2 s while it fades.
- **Combos:** duplicate a whole impact, move and rotate each copy, and stagger
  the copies 0.1-0.15 s apart.
- **Tie it to the animation.** Without markers, keep one table of delays, and
  make the last event match the clip's length.

## 8. Motion and curves

- **Burst, then hang.** High `Speed` with strong `Drag` so pieces shoot out
  and stop:
  - Speed 45-75 at Drag 16;
  - 25-60 at Drag 6;
  - streaks at 1000-2000 lasting 0.1-0.2 s.

  Constant slow drift reads as floaty. Debris falls at an `Acceleration` of
  -15 to -27.
- **Size pops.** `0:0, 0.1:peak, 1:0` for debris. A flash starts big and
  shrinks. Rings grow on an ease-out. A one-frame `Squash` pop at spawn (2 to
  0 by 2% of life) gives an orb a snap.
- **Spread from one key.** A size of `m ± m` gives sizes from 0 to 2m.
- **Hold, then snap.**
  - Transparency held at 0 for the first 27-30% of life, then snapping to 0.8
    by about 36%.
  - For held sprites: 1 to 0 by 20% of life, held to 80%, then back to 1.
- **Transparency keys above 1** make a particle vanish before its lifetime
  ends *(verified)*. Negative Transparency does not make a soft texture solid
  *(verified)*.
- **Glitch frames:** flip `Squash` from +3 to -3 partway through a short
  flash.

## 9. Projectiles, slashes, beams and sustained forms

**Projectiles** *(measured)*. A projectile has three parts:
- **A head:** one sprite, such as a `VelocityParallel` diamond. Clear it at
  impact (`Clear()`), so it vanishes in that frame.
- **Ribbons:** 2-3 Trails across a span of about 5 studs:
  - a sharp one: lifetime about 0.6, width tapering to 0, transparent for the
    first 15% of its length so there is a gap behind the head;
  - a soft one that bulges in the middle: lifetime about 0.85;
  - a short tendril: lifetime about 0.3.
- **Shed particles:** droplets or specks at 15-60 a second, with gravity or
  drag, not locked to the part.

Paths and volleys:
- **Paths:** Bezier curves with 2-3 random control points 10-25 studs up.
  - Give each projectile its own flight time (0.65-1.5 s), so the hits drum
    rather than land together.
  - A summoned dragon swirls about 45 studs sideways.
- **Volleys:** 10-15 sources, one every 0.1 s, fanned ±20 studs behind and
  above the caster. Each source's emitters stop after 0.1-0.2 s, and their
  particles close it over 0.8-1.5 s.

**Anything that moves carries its speed** *(measured)*:
- `VelocityParallel` streaks shed behind it, with `Squash`;
- flat wind rings shed backwards: negative Speed, growing to 7-12 studs over
  0.3-0.6 s;
- curved wind beams from head to tail;
- a one-frame smear at launch.

A projectile that is only a sprite with a thin trail reads as floating, not
thrown.

**Slashes are drawn in time, not only in space.** One crescent sprite (flat,
about 6.6 studs, 0.2-0.3 s) plus about five invisible points along the arc.
Each point emits sparks at an `EmitDelay` 0.04-0.05 s after the one before, so
the eye follows the blade around the arc.

**Stabs and dashes:**
- A one-frame (0.04 s) flash moving at 155-444 studs a second, with `Squash`
  -0.5, reads as a motion smear.
- Pair it with a real move: about 15 studs in 0.075 s.

**Held beams.** Use a few Beams plus many particles:
- **The body:** 2-3 camera-facing Beams, width 5-12.
  - Give each its own `TextureLength` (0.75-150) and `TextureSpeed` (1-12), so
    the scrolls never line up.
  - Fade the ends over 5-10% of the length, or make the body a capsule
    (Transparency `1, 0, 1` along it).
- **Fill:** `VelocityParallel` flame streaks at `Rate` 500-2000, Speed up to
  300, Drag 10, `Squash` ramping 0 to 3.
- **The muzzle:** a crown of short curved beams, and flat shockwave rings.
- **Duration:** hold the beam 3.5-5 s, then collapse the widths to 0 over
  0.5-1 s.
- **A drilling dash:** three beams around one axis that roll 180° while
  their widths fall from 6 to 0 over 0.75 s.

**Teleports and blinks:**
- an implosion flash (31 to 0 over 0.23 s) with `Squash` glitch frames;
- upward streaks at 45-200 studs a second with drag 4-9, dying in 0.12-0.4
  s;
- a white ground ring growing from 1 to 19 in 0.14 s.

**Sustained forms:** orbs, sigils and auras.
- **The stack:** stationary billboards on one attachment, with `Speed` 0.001
  and `LockedToPart`.
- **The cross-fade:** `Rate` x `Lifetime` about 2-4, Transparency `0:1,
  0.5:0, 1:1` and a random `Rotation`. Copies cross-fade, so the form holds but
  shimmers.
- **Size ladder:** core 1, rings about 2, halo about 3.5, black backdrop about
  4.5.
- **Ground sigils:** 5-7 studs, lifetime 2, spinning 0.5-5° a second, in two
  or three sizes that shrink slightly as they live, so the circle breathes.
- **Healing over time pulses:** a burst every 1.6 s with lifetimes up to 1.25
  s, so the pulses read as ticks.

## 10. Camera, screen and world

The studied scripts do these around the particles *(measured)*. The emit
module does not; write them alongside it when the effect needs them.

**Field of view:**
- Widen it by 10-20° over 0.6-1.5 s while charging.
- Snap it back past the default (by up to 20°) in 0.15-0.25 s at release.
- For a hit, punch it in by 5-7° over 4 frames and recover on Back Out.

**Blur and tint:**
- Blur 6-15 at release: 0.01 s in, 0.1-0.65 s out.
- A 0.25 s screen tint toward the effect's hue.

**Impact frames** (`ColorCorrectionEffect`), 1-3 frames each:
- black: Contrast 2 to 3, Saturation -1;
- white: Brightness 1, Saturation -1;
- the two can overlap about 0.15 s apart.

A tinted full-screen flash fading over 0.4 s is a lighter alternative.

**Camera shake:** rotation only, gated by distance (150-350 studs). Stop
every sustained shake.

| Use | Magnitude | Roughness | Fade out |
| --- | --- | --- | --- |
| Light hit | 0.3-0.55 | 3-23 | 0.15-0.3 s |
| Heavy hit | 2.5-5 | 6-10 | 0.9-1.5 s |
| Held beam | 1.4-2 | 8-50 | 6-6.5 s |

**Lights:**
- Flash a light, then fade it, ideally with its Range growing as Brightness
  falls: from Brightness 3-9 and Range 0-8 to 0 and 35-40 over 0.3-1 s.
- Clone a fresh light per shot.
- Keep a light's Range short enough that it marks the spot rather than
  tinting the whole floor.

**The world reacts:**
- **Craters:** 6-36 rocks at radius 3-54, tilted 8-55°, copying the hit
  surface's Material, Color and Textures from a raycast. They grow over 0.4 s,
  hold 1.5-5 s, then sink or shrink over 1.5-3 s.
- **A held beam** throws 1-2 rocks every 0.1 s.
- **A scorch decal** stays 5-6 s.

**Clean up everything.** One studied showcase leaves its explosion dome, a
ring loop and a sustained shake running until the next cast. That is the
failure to avoid.
