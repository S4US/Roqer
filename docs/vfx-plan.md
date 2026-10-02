# VFX study

Status as of 2026-10-02: step 1 (guidance) is implemented, unit tested and
checked live in Studio; open questions 1 and 2 are answered. The rest is
research only. It
records how strong Roblox VFX are built today, what the agent can and cannot
do toward that, and a proposed order of work. Facts were gathered from the web
on that date and carry their sources. Items tagged **[unverified]** are common
practice or inference with no primary source found; do not turn them into
defaults without testing them.

## Where VFX stands today

- **Blender can make the parts, by hand.** The `blender` tool runs any bpy
  script headless (`apps/desktop/runtime/blender-worker.ts`). It exports
  `.glb/.gltf/.fbx/.obj` models, which Roqer re-imports and inspects, and PNG
  renders. Today the user gets flipbooks and slash meshes by telling the agent
  to write the whole bpy pipeline itself: rendering the frames, packing the
  grid, writing the UVs.
- **The worker does not know what a flipbook is.** A PNG is just a PNG. At most
  4 are read per job (`MAX_RENDERED_IMAGES`), a side over 1024 is flagged
  (`MAX_UPLOAD_IMAGE_SIDE`), and a file over 2 MB is not attached
  (`MAX_PREVIEW_BYTES`, `blender-worker.ts:38-44`). Nothing checks that a sheet
  divides evenly into its grid, that no frame bleeds into its neighbour, that no
  cell is empty, or which blending mode the sheet was made for.
  `grep -ri flipbook` over the repo finds nothing.
- **No mesh-VFX helpers.** `roqer.*` helpers cover kit building and rigs (`box`,
  `cylinder_between`, `join`, `paint`, `bind`, `skin`, `export_animation`;
  `roblox-building/references/blender.md`). There are no crescents, rings,
  spirals or swirls, and no rule for laying out UVs on them.
- **Studio-side creation works.** `build_instances` creates `ParticleEmitter`,
  `Beam`, `Trail` and `Attachment` with sequences and ranges converted by the
  plugin (`studio-plugin/src/modules/Utils.ts`). `upload_asset` with `Decal`
  returns the `imageId` a `ParticleEmitter.Texture` or `Beam.Texture` needs
  (`packages/core/src/tools/index.ts:5396`). `search_assets` takes
  `assetType: "VFX"`, and `preview_asset` reports `hasVfx`.
- **Guidance is thin.** The `roblox-animation-vfx` skill
  (`references/full.md` §4-8) covers `Rate = 0` with `:Emit(n)`, attachments
  for beams and trails, tweening, `Debris` and pooling. It says nothing about
  textures, flipbooks, mesh VFX, layering, timing, impact frames or
  performance budgets.
- **The agent cannot see motion.** `capture_screenshot` takes a still. Each
  capture goes through `capture-begin`/`capture-read` round trips
  (`index.ts:5903-5910`), far slower than a 0.3 s burst. The only multi-frame
  check in the product is the animation contact sheet
  (`packages/core/src/animation/contact-sheet.ts`), and it draws rigs only.
  **This is the largest gap.** An effect is mostly timing, and the agent cannot
  check timing.

## How strong Roblox VFX are built

### Mesh VFX

Since about 2018, battlegrounds-style games have built VFX from tweened meshes
that grow, spin and fade, layered with particles
([DevForum, 2026](https://devforum.roblox.com/t/roblox-3d-vfx-for-meshvfx/4585601)).
The meshes are crescent slashes, shockwave rings, twisted cylinders (swirls,
tornadoes), cones and sphere shells, made in Blender. One published recipe:
start from a cylinder subdivided three times; apply Vertex Weight Edit, Mask,
Smooth and a 360° Simple Deform twist; export; give it Neon in Studio
([tutorial](https://devforum.roblox.com/t/vfx-tutorial-roblox/872437)).

What the engine offers a mesh effect:

| Technique | How it works | Limit |
| --- | --- | --- |
| `MeshPart.TextureID` + `Transparency`/`Color`/`Size` tweens | The base of most mesh VFX | `TextureID` has **no UV offset**, so it cannot scroll ([MeshPart](https://create.roblox.com/docs/reference/engine/classes/MeshPart)) |
| `DoubleSided` | Lets a one-sided card (a slash) show from behind | — |
| Vertex colours | Imported from FBX and multiplied by `Color`, so set the part white | MeshPart only ([staff post](https://devforum.roblox.com/t/vertex-colored-meshes-using-blender-and-studio/3050119)) |
| `ForceField` material with a texture | The red channel picks which pixels show as an internal window sweeps; alpha sets strength; fresnel at the edges | Speed cannot be controlled, so it suits a shimmer or dissolve, not a timed wipe ([announcement](https://devforum.roblox.com/t/new-material-forcefield-v20/297785), [analysis](https://devforum.roblox.com/t/how-forcefield-texture-animation-works/3041374)) |
| `Texture` instance with `OffsetStudsU/V` | Scrolls, but projects along face normals rather than using the mesh's UVs | Wrong for curved cards ([thread](https://devforum.roblox.com/t/scrollable-textures-for-meshparts/2820890)) |
| Swapping `TextureID` per frame | A flipbook on a mesh | One asset per frame ([mesh flipbook pack](https://devforum.roblox.com/t/open-source-mesh-flipbook-pack/3635032)) |
| `Bone.Transform` on a skinned mesh | Bends a ribbon or tendril from script | ([Bone](https://create.roblox.com/docs/reference/engine/classes/Bone)) |
| `EditableMesh` / `EditableImage` | Rewrite UVs (`SetUV`) or pixels at runtime | Gated by the player's ID verification (below) |

`SurfaceAppearance` has emissive maps, but "most SurfaceAppearance properties
cannot be modified by scripts"
([reference](https://create.roblox.com/docs/reference/engine/classes/SurfaceAppearance)),
so scripted mesh VFX use `TextureID`.

**[unverified]** Lay out a slash or ring so the sweep runs along U and fade
the tail with an alpha gradient in the texture. Ease `Size` out to 2-4× with
Quad or Expo over 0.2-0.5 s while `Transparency` goes from 0 to 1.

### Particles

All from the [ParticleEmitter reference](https://create.roblox.com/docs/reference/engine/classes/ParticleEmitter)
unless marked:

- **Flipbooks:**
  - `FlipbookLayout` (None, Grid2x2, Grid4x4, Grid8x8, Custom);
    `FlipbookSizeX/Y` apply to Custom.
  - `FlipbookMode` (Loop, OneShot, PingPong, Random). In OneShot the rate is
    lifetime divided by the frame count.
  - `FlipbookFramerate` goes up to 30 fps. Also `FlipbookStartRandom` and
    `FlipbookBlendFrames`.
  - `FlipbookIncompatible` holds the error text, for example "flipbook texture
    size must be an exact multiple of the flipbook layout size".
  - The particle guide gives an 8×8 layout on a 1024² image (64 frames) and
    says to leave spacing between frames. Flipbooks can be disabled on
    low-memory devices
    ([guide](https://create.roblox.com/docs/effects/particle-emitters)).
  - Custom layouts of 1-64 cells per side, with non-square sheets, entered
    Client Beta on 2025-10-13
    ([announcement](https://devforum.roblox.com/t/client-beta-optimize-your-particle-animations-with-custom-flipbook-layouts/4005128)).
    Whether they have left beta is unverified.
- **Blending:**
  - `LightEmission` 1 is additive; use it with black-background RGB textures
    for fire and energy. `LightEmission` 0 is normal alpha blending; use it
    for smoke.
  - There is no multiply or premultiplied mode
    ([request](https://devforum.roblox.com/t/proper-alpha-blend-multiply-for-particles/216474)).
  - Also `LightInfluence`, `Brightness` and `ZOffset`, which layers without
    changing on-screen size.
- **Shape:**
  - `Squash` with `Orientation = VelocityParallel` makes streaked sparks.
  - `Shape`: Box, Sphere, Cylinder or Disc. Also `ShapeStyle` and
    `ShapeInOut`, where Inward suits anticipation.
  - `ShapePartial` on a Disc makes a ring
    ([shapes](https://devforum.roblox.com/t/new-procedural-particle-emitter-shapes/1517642)).
- **Motion:**
  - `Drag` is the half-life of speed. Also `Acceleration` and
    `LockedToPart`.
  - `TimeScale` 0 freezes particles. It is the engine's hitstop hook, and it
    matters for verification (below).
- **Missing from the engine:** mesh particles, collisions, sub-emitters and
  turbulence ([overhaul request](https://devforum.roblox.com/t/particle-system-revampoverhaul/4005723)).
  Studios work around them with mesh VFX and scripted layers.

### Beams, trails, lightning

- **Beams:**
  - A Beam is a cubic Bezier: `CurveSize0/1` bend it into arcs.
  - `Segments` must be at least the keypoint count minus one.
  - `TextureSpeed` scrolls the texture (negative reverses). `SetTextureOffset`
    scrubs it by hand
    ([Beam](https://create.roblox.com/docs/reference/engine/classes/Beam)).
  - Beams are the one built-in way to scroll a texture along a curve.
- **Trails:** width comes from the two attachments times `WidthScale`, and
  `Lifetime` runs from 0.01 to 20 s
  ([Trail](https://create.roblox.com/docs/reference/engine/classes/Trail)).
  - **[unverified]** For a weapon slash, enable the trail only during the
    swing, with a lifetime of about 0.1-0.3 s and `LightEmission` 1.
- **Lightning:** the Lightning Beams module (used in Elemental Battlegrounds)
  moves layered noise along a Bezier
  ([repo](https://github.com/SamyBlue/Lightning-Beams)).

### Composition, timing and feel

- **One container, driven by keyframe events.** Artists weld the effect parts
  to the character, animate them with the attack, and let keyframe events
  drive emission
  ([workflow breakdown, 2025](https://devforum.roblox.com/t/stoic-bomb-vfx-recreation-and-personal-workflow-overview/3608056)).
  The engine hooks are `GetMarkerReachedSignal` and `KeyframeReached`
  ([AnimationTrack](https://create.roblox.com/docs/reference/engine/classes/AnimationTrack)).
  Roqer's `animation` tool already writes markers.
- **An attribute convention the tools share.** VFX Editor, Advanced VFX Plugin
  and VFX Forge all read `EmitCount`, `EmitDelay` and `EmitDuration` from
  emitter attributes, and a module walks a model's descendants to emit them
  ([VFX Editor](https://devforum.roblox.com/t/vfx-editor-all-your-vfx-needs-in-one/3103467),
  [VFX Forge docs](https://docs.zilibobi.dev/vfx-forge/effects/particle/),
  [forge-vfx](https://github.com/zilibobi/forge-vfx)).
  - VFX Forge animates a mesh effect from `Start` and `End` parts whose
    position, size and scale act as keyframes, with tween curves for each
    property ([mesh effects](https://docs.zilibobi.dev/vfx-forge/effects/mesh/)).
  - An agent that writes effects in this shape produces something a VFX
    artist can open and tune.
- **Screen feedback:**
  - `ColorCorrectionEffect` and `BloomEffect` under `CurrentCamera` affect
    only the local player
    ([ColorCorrection](https://create.roblox.com/docs/reference/engine/classes/ColorCorrectionEffect)).
  - Impact frames use black colour correction, a white `Highlight` and speed
    lines. Some colour-correction settings hide particles
    ([impact frames](https://devforum.roblox.com/t/advanced-impact-frames/2468478)).
  - The `Highlight` limit rose to 255 on 2025-11-10
    ([announcement](https://devforum.roblox.com/t/lights-camera-more-highlights/4061534)).
  - Camera shake: RbxCameraShaker presets
    ([repo](https://github.com/Sleitnick/RbxCameraShaker)).
- **[unverified] Layering and timing:**
  - Layers: an additive core, a faint large glow, streaked sparks, alpha
    smoke, a shockwave ring, ground cracks or a decal, and a `PointLight`
    flash.
  - Timing: anticipation 0.1-0.3 s, impact 1-3 frames, dissipation 0.5-1.5 s.
  - No primary source gives numbers. Treat them as starting points the
    verification has to judge, not rules.

### Runtime and performance

- **Replication:** the server decides and fires an id plus parameters, and
  each client renders. `UnreliableRemoteEvent` is meant for effects and drops
  payloads over 1000 bytes
  ([reference](https://create.roblox.com/docs/reference/engine/classes/UnreliableRemoteEvent)).
  The networking skill already says this.
- **Draw calls:** particles, decals and textures do not batch. Overlapping
  transparency causes overdraw, and changing emitter properties can be costly.
  Most textures should be 512² or smaller
  ([performance guide](https://create.roblox.com/docs/performance-optimization/improve)).
  The particle guide caps emission at 400/s (100 on mobile).
- **Quality scaling:** `UserGameSettings.SavedQualityLevel` is readable from a
  LocalScript; the automatic level is not exposed
  ([UserGameSettings](https://create.roblox.com/docs/reference/engine/classes/UserGameSettings)).
- **Physics debris:** in one heavy fighting game, the lag came from physics
  debris rocks, not particles. Pooling and building the effects on the client
  fixed it
  ([thread](https://devforum.roblox.com/t/optimization-for-heavy-vfxparts-fighting-games/3824000)).

### Texture sources

- **Flipbooks from Blender:** render with a transparent film (Cycles or
  Eevee), then pack the frames into a grid
  ([example, 2024](https://devforum.roblox.com/t/2-free-realistic-flipbook-particle-explosions/3035597)).
  The author of that example had trouble with transparency when packing, the
  same step Roqer could do in trusted code.
- **Slashes and dissolves from After Effects**
  ([slash](https://devforum.roblox.com/t/after-effects-slash-vfx-tutorial/3894233),
  [shockwave](https://devforum.roblox.com/t/after-effects-dissolve-shockwave-tutorial/3894243)).
- **Fluid simulations from EmberGen**, exported as flipbooks with configurable
  grids. EmberGen is commercial, closed and GUI-driven, so an agent cannot
  drive it.
- **Blender** remains the one scriptable, free source in this set.

### Engine features worth watching

- **EditableMesh and EditableImage:**
  - Limits: 1024² images and 60k vertices / 20k triangles per mesh.
  - EditableMesh batching APIs reached full release in September 2026
    ([announcement](https://devforum.roblox.com/t/full-release-editablemesh-batching-apis-parallel-queries/4779401)).
  - In published games they still require the player to be 13+ and
    ID-verified, and the creator must enable the APIs
    ([EditableImage](https://create.roblox.com/docs/reference/engine/classes/EditableImage)).
  - So any runtime effect built on them needs a fallback for most players.
- **No official VFX template or pack exists.** The Creator Store's Visual
  Effects category is community content.

## What decides the design

1. **A slice is worth building only if Roqer can check its output itself.**
   This is the same rule as the Blender worker and the audio study.
   - Sheet geometry, alpha and mesh UV facts can be checked locally from
     files.
   - Motion in Studio cannot be checked yet, and it is what makes an effect
     good or bad.
2. **Each part goes in the layer that owns it** (AGENTS.md):
   - Baking flipbooks and making VFX meshes is local orchestration, so it
     belongs in the Blender worker, beside `roqer.export_animation`.
   - Capturing frames of a running effect needs the viewport, so it belongs in
     the plugin and MCP.
   - Composition, timing and property recipes are guidance for the
     `roblox-animation-vfx` skill.
   - Nothing should simulate Roblox rendering outside Studio. Showing a baked
     sheet as an animated strip in a result card is image data, like the 3D
     viewer, and is fine.
3. **Uploads are irreversible and moderated.** VFX need many small textures
   and meshes.
   - Pack textures into shared sheets, and reuse one texture across emitters
     with different `Color`, `Size` and `Squash`.
   - Tell the user the upload count before uploading.
   - The image and mesh upload quota for an unverified account is not known
     (open question 3), so no figure is assumed here.
4. **Write effects in the shape artists already use.** Use one Model per
   effect, emitters with `EmitCount`/`EmitDelay`/`EmitDuration` attributes,
   and `Start`/`End` parts for meshes. The result is then legible to the user
   and to VFX tooling, and does not invent a format. Step 3 below is in
   tension with this rule; see the choice it names.

## Proposed order of work

### 1. Guidance first (no product code)

Add `roblox-animation-vfx/references/vfx-craft.md`, loaded for any effect
request. The emit module below is Luau carried in that reference, which the
agent inserts into the game, not a desktop or core component. It should cover:

- the layer list and the anticipation, impact and dissipation structure
  (tagged as starting points);
- flipbook properties and the sheet rules: exact multiple, spacing, square
  1024² with 8×8, and when to use `LightEmission` 1 or 0;
- spark, smoke, ring and glow recipes as property sets that `build_instances`
  accepts;
- Beam arcs (`CurveSize`, `Segments`, `TextureSpeed`) and trail slashes;
- mesh VFX: card meshes with `DoubleSided`, white `Color` under vertex
  colours, `ForceField` for shimmer only, and why `TextureID` cannot scroll;
- impact frames and hitstop through `TimeScale`;
- a reference emit module written in this repo. It reads the shared
  attributes, plays `Start`→`End` mesh tweens, and is driven by animation
  markers;
- the performance rules above;
- how to search the Creator Store for an existing texture before uploading a
  new one.

Acceptance:

- every property name in the reference exists in the creator-docs API dump;
- the emit module runs in a playtest (`solo_playtest`);
- a test, like `animation-recipes.test.ts`, extracts its recipes and checks
  them against the plugin's value conversions.

Drafted 2026-10-02:

- **What was added:** `references/vfx-craft.md`, the emit module
  `templates/vfx/emit.lua`, and `apps/desktop/runtime/vfx-craft.test.ts`.
- **What the test checks:**
  - recipe properties against the `@rbxts/types` 1.0.906 typings;
  - value shapes against the plugin's conversions;
  - textures against the built-in particle textures, which were read from a
    Studio install;
  - recipe attributes against what the module reads.
- **The module's clock:** it drives particles, mesh motion and light fades
  itself, so `setTimeScale` and `freeze` cover all three without banning
  `TweenService` elsewhere. That answers step 3's choice for effects played
  through the module.
- **Checked outside Studio:** `luau-compile` 0.740 compiles the module, and a
  one-off run under plain Luau with stand-in Roblox objects showed bursts,
  delays, hitstop, slow motion, in-place restore and warnings behaving as
  intended.
- **Live in Studio, 2026-10-02** (a scratch place, through the built bridge,
  addressed by instance id):
  - every recipe was built verbatim from the reference in one atomic
    `build_instances` batch and read back as written;
  - the module was installed with `set_script_source` and loads with
    `require`;
  - the effect played in the edit viewport and in a solo playtest client;
  - `freeze(1)` held the clock (0.318 before and during, 0.617 after);
  - no `VFXEmit` warnings were logged.
- **The first contact sheet showed the recipes too faint.** The gather and
  sparks were hairlines, the smoke barely visible, and the neon ground disc
  buried the shockwave ring. They were retuned (larger, `Brightness`, darker
  smoke, a more transparent disc) until every layer read in a second sheet.
- **Fixed by the live run:** `build_instances` cannot use a service as its
  root and creates a missing root as a Model. The module therefore lives at
  `ReplicatedStorage.VFX.Emit`, not `ReplicatedStorage.VFXEmit`.
- **Three briefed effects** (fire punch, teleport, sword slash) were built
  and tuned by contact sheet in the scratch place. They taught five things,
  now in the reference:
  - `build_instances` cannot set Beam or Trail `Attachment0`/`1`, so links
    need one `execute_luau`. That is a candidate for a `build_instances`
    reference-property extension.
  - Edit-mode `require` caches a ModuleScript for the whole session.
  - Trails age in real time, so frozen frames lose them. The module now
    stretches trail lifetimes by the time scale, and trail effects are
    captured back to back at `timeScale = 0.04`.
  - A flat slash is edge-on from a low camera.
  - A Neon column below about 0.8 transparency reads as plastic.
- **A mesh-free crescent** comes from a trail swept by the module's `Spin`.

### 2. Blender: flipbooks and VFX meshes with checks Roqer computes

Add worker helpers, on the same pattern as `export_animation`:

- **`roqer.flipbook(frames | frame_range, layout, mode, cell_padding)`**
  renders frames with a transparent film and packs them in trusted code into
  one sheet.
  - Sheets are at most 1024² by default, with a Custom layout as an explicit
    option.
  - `mode` is `"alpha"` (straight alpha) or `"additive"` (black background,
    no alpha).
  - Roqer reports:
    - whether the sheet divides exactly into its grid;
    - any frame whose alpha or brightness touches its cell edge (bleed);
    - any empty or duplicate cell;
    - coverage per frame, so the user can see that a burst grows and fades;
    - the matching `FlipbookLayout`, `FlipbookMode` and `LightEmission`
      settings.
  - The sheet comes back as a single image, so the 4-image cap holds, and the
    result card can play it as an animated strip.
  - Render time is a budget. A job is capped at 200 s, and 64 Cycles frames
    may not fit. Default to Eevee (or Workbench for flat shapes), use Cycles
    only on request, and split a long sheet across jobs with `continue_from`,
    packing at the end. Roqer reports render time per frame so the agent can
    plan the split.
- **Mesh primitives:**
  - The helpers are `roqer.vfx_slash`, `vfx_ring`, `vfx_swirl`, `vfx_cone`
    and `vfx_shell`, each with sweep angle, thickness, twist and segment
    count.
  - Each one lays out UVs with the sweep along U, and can bake an alpha
    gradient texture.
  - The existing re-import inspection adds a UV-range check and a triangle
    count against the 20k limit.
- **Texture helpers:** gradient, ring, noise and streak textures (glows,
  sparks, smoke puffs), rendered or composited in Blender.
  - They give the agent a starter set without a generative image model.
  - Every texture is original by construction, which lowers moderation risk.

Acceptance:

- the same script renders the same sheet: same frame numbers, same layout,
  and coverage within tolerance. Eevee is not bit-stable across GPUs, so not
  byte for byte;
- a malformed layout is refused, naming the valid range;
- the checks come from Roqer's own read of the PNG, never from the agent;
- a live check: one uploaded sheet plays in a `ParticleEmitter` with no
  `FlipbookIncompatible` message and no visible bleed.

**Flipbooks done 2026-10-02; mesh primitives and texture helpers not
started.** The flipbook slice as built:

- **`roqer.flipbook(name, grid, mode, start, end, loop, padding)`**
  - Grids are 2, 4 or 8 only, and the sheet is always 1024² (Custom layouts
    were left out).
  - Frames are sampled evenly to fill every cell, and the animation must have
    at least as many frames as cells.
  - Frames render into the job folder, `padding` pixels inside their cells.
  - The view transform is set to Standard while rendering, and the scene's
    settings are restored afterwards.
  - The sheet is packed with numpy and written by a small PNG writer, not
    Blender's image saver.
  - A note beside the sheet records the grid, mode, loop flag, frames and
    per-frame render time.
- **`runtime/flipbook-sheet.ts`** decodes the sheet itself, treats the note
  as a claim, and reports:
  - the grid its gutters agree with;
  - coverage per cell;
  - empty cells (a faded tail is fine for a one-shot sheet);
  - cells the subject runs off the edge of;
  - frozen frames;
  - the settings to use.

  It refuses any size but 1024², and a palette or interlaced PNG.
- **The result:** sheets get their own section in the Blender result, apart
  from renders. A sheet too large to attach is replaced by a half-size copy
  the helper writes.
- **Live, Blender 5.2:**
  - Eevee rendered 64 frames in 4.1 s; Cycles took 0.28 s a frame for a
    simple 4x4 sheet.
  - Packing order, padding and alpha were checked by eye.
  - An oversized subject was caught as cut off in 7 cells.
  - The reference's example runs as written.
- **In Studio, 2026-10-02:** one sheet was uploaded with the user's approval:
  the GlowBurst 8x8 additive sheet, decal 106191190033458, image
  131517682949853, approved by moderation at once.
  - On a `ParticleEmitter` with Roqer's reported settings, one particle held
    at six ages showed one frame each, growing then fading. It played as a
    flipbook, not the whole grid.
  - `FlipbookIncompatible` read "Particle texture must be 1024 by 1024 to use
    flipbooks." throughout. It did so for that working sheet, for a 128 px
    built-in and with no layout set, and it never cleared over 6 s. The
    guidance now says not to go by it and to screenshot held particles
    instead.
- **Not done:** an animated strip in the result card.

**Mesh primitives done 2026-10-02; texture helpers not started.**

- **The helpers:** `roqer.vfx_arc` (crescent), `vfx_ring` (flat band, or a
  wall with a flared top), `vfx_cone`, `vfx_swirl` (helical ribbon) and
  `vfx_shell` (sphere or dome).
  - Each is one open sheet built by a shared strip builder, with UV U along
    the sweep and V across it, facing Blender -Y (Roblox forward).
  - Arguments are checked and refused with their valid ranges.
- **Inspection:** the re-import inspection now reports UVs: meshes with and
  without them, and the range they span, noting when it falls outside 0 to 1.
- **Live, Blender 5.2:** all five shapes built in one job.
  - The preview showed each as intended.
  - UVs spanned 0 to 1 on every mesh, and the six shapes came to 1,760
    triangles.
  - The reference's example ran as written.
- **Not verified:**
  - The shapes have not been uploaded or seen in Studio.
  - Whether a MeshPart texture's transparent pixels show through, or show
    the part's `Color`, is not known. That decides whether fading textures
    work on these shapes, and checking it needs a mesh and a texture upload.
    The texture helpers wait on that answer.

### 3. Seeing motion: an effect contact sheet

Goal: a grid of frames of the effect as it runs in Studio, taken at fixed
effect times, returned as one image like the animation contact sheet.

- Capturing at real speed is presumed too slow, because each still is a
  plugin round trip. That has not been measured; open question 2 decides it.
- The candidate is **slow motion**:
  - set particle `TimeScale` low, for example 0.05, so a 0.5 s burst lasts
    10 s, and capture at fixed intervals;
  - drive mesh tweens and beam offsets from the reference module's own clock,
    which honours the same scale.
- **This forces a choice.** `TweenService` does not read `TimeScale`. Either
  every effect the agent writes runs on the module's clock, or slow-motion
  verification covers particles only.
  - Running everything on the module's clock is defensible: VFX Forge drives
    its own curves too. It does depart from plain `TweenService`, which
    constraint 4 would otherwise favour.
  - The user should make this call before step 3 starts.
- Try existing tools first. A playtest, `execute_luau` to fire the effect and
  `capture_screenshot` in a loop may be enough. A new operation is justified
  only if that cadence is too uneven.
  - If one is needed, add it as a mode on `capture_screenshot` or the
    `animation` tool. That keeps the tool count flat, but it still changes the
    public surface. Schema, handler, routing, plugin, edition allowlists,
    desktop risk and drift tests all have to be updated together.
- **Edition:** firing an effect and running a playtest change the DataModel,
  so the effect contact sheet is for the main edition only. The inspector may
  capture frames but must not fire effects.
- The grid is composed in core with the existing PNG encoder, and the
  timestamps are labelled.

Acceptance:

- frames are taken at the stated effect times, within a measured tolerance;
- the effect, emitters and playtest are cleaned up on every path;
- a known effect gives the expected grid: a ring that grows, a burst that
  fades.

### 4. Evaluation

Brief the agent on four effects: a sword slash, a fireball with a trail and
impact, a ground slam with a shockwave and cracks, and a heal aura. Score:

- layer count and which layer types are present;
- uploads used;
- particle rate and texture sizes against the budgets;
- whether the effect is client-rendered and pooled;
- whether a contact sheet shows anticipation, impact and dissipation.

Record the user's visual verdict beside the score. Quality cannot be unit
tested.

## Deferred, and why

- **Runtime EditableMesh/EditableImage effects** (UV scrolling on meshes,
  procedural trails): most players cannot see them without ID verification.
  Revisit if Roblox removes the gate
  ([request](https://devforum.roblox.com/t/remove-required-id-verification-for-editablemeshesimages/3981479)).
- **Fluid simulation flipbooks** (Blender Mantaflow smoke and fire): not yet
  tested against the 200 s job cap, even with `continue_from` chaining. Wait
  until the step 2 render budget is measured. Creator Store textures cover
  most smoke and fire needs meanwhile.
- **Vendoring a community emit module:** licences are unchecked, and the
  attribute convention is easy to implement. Write the in-repo module, and
  stay compatible with the convention.
- **AI-generated textures:** they give no originality assurance against
  moderation, and need a user key. Revisit after the Blender texture helpers.

## Open questions

1. **Answered 2026-10-02: yes, for particles, lights and Heartbeat.** An
   effect played from `execute_luau` animates in the edit viewport: 31
   Heartbeats in 0.5 s, and particles, a `PointLight` and mesh motion all
   rendered. Step 3 does not need a playtest. Beam `TextureSpeed` and
   `TweenService` were not probed.
2. **Answered 2026-10-02:** a capture took 843-894 ms in edit mode and
   661-812 ms in a playtest client, consistently. That is too slow to catch a
   burst at any speed. Pausing the module's clock (`setTimeScale(0)`) at each
   moment, capturing, then resuming held every frame within 2 ms of the
   requested effect time. That is the step 3 mechanism, and it already works
   with existing tools.
3. What are the image and mesh upload quotas for Open Cloud on an unverified
   account?
4. Have Custom flipbook layouts left Client Beta, and what is
   `FlipbookBlendFrames`' current default? (The `@rbxts/types` 1.0.906 typings
   do not list `FlipbookBlendFrames`.)
   - Related, observed 2026-10-02: Studio's `FlipbookIncompatible` reads
     "Particle texture must be 1024 by 1024 to use flipbooks." for every
     texture tried, including an uploaded 1024² sheet that plays (see step
     2). It says nothing about a sheet.
   - 1024² is verified to play. Whether smaller square power-of-two sheets
     still play, as the 2022 release allowed, is untested.
5. Does vertex alpha from an FBX import reach the renderer on a MeshPart? The
   staff post covers only RGB. If it does, mesh fades need no texture.
