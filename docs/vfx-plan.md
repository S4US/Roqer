# VFX study

Status as of 2026-10-02: steps 1 and 2 are implemented, unit tested and
checked live in Studio and Blender; open questions 1 and 2 are answered. A
study of experienced artists' published effects ("Reference study" below)
reshaped the guidance and added texture drawing. The document also records
how strong Roblox VFX are built today, what the agent can and cannot do toward
that, and a proposed order of work. Web facts were gathered on that date and
carry their sources. Items tagged **[unverified]** are common
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
- **In Studio, 2026-10-02**, with the user's approval for two uploads: a
  `vfx_arc` crescent (model 93242260704793) and a fade texture (decal
  84595241411908, image 86775129723972). Both were approved at once.
  - The crescent arrived as a MeshPart, 0.001 studs thick, in a Model under
    `Crescent_Node`.
  - The texture was tried on crescents in front of a green wall:
    - `TextureID` on red SmoothPlastic, also at `Transparency` 0.01, and on
      white Neon: white everywhere, so alpha is ignored. Nothing showed
      through and no red appeared.
    - `SurfaceAppearance`, `AlphaMode = Transparency`: it fades, but
      dithered.
    - A `Decal` on the card's face, on an invisible part: a clean fade that
      takes `Color3` and `Transparency`. It is projected across the box
      face, ignoring UVs, so this UV-laid texture lost the crescent's middle
      in a test slash.
  - The rebuilt slash uses two Neon crescents fading by part `Transparency`
    (core and glow) plus sparks.
  - With `RenderFidelity` Automatic the crescents drew as straight-sided
    wedges. `Precise` kept them smooth.
  - Side by side with the swept-trail slash, the mesh slash reads as a real
    sword slash.
  - The emit module now fades Decals on `Start` toward the same-named Decals
    on `End`.
- **Texture helpers:** reconsidered. Since `TextureID` ignores alpha, the
  useful texture for a mesh effect is a Decal drawn for flat projection, and
  that is a different helper from the UV gradient first planned.

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

## Reference study of experienced artists' effects

Done 2026-10-02, after Roqer built a fire punch from the guidance above that the
user called generic and cheap. The user supplied a local collection of
effects by experienced Roblox VFX artists:
- 11 `.rbxm` and 10 `.rbxl` files, including Marcid's open-source slashes,
  Jaxelos's stars and cosmic impact, a Megumin explosion, orbs, magic circles,
  wind and smoke, water, and shape-and-value practice pieces;
- 9 showcase videos;
- an artist's source textures, with stylised wind meshes and their 30-frame
  texture sequences.

They are not in this repository.

### Method

- **Files:** the binary files were parsed offline and every property,
  attribute and script dumped.
  - Distributions were computed over all 3,950 particle emitters.
  - The script-driven, slash, orb and practice effects were each read in
    depth.
- **Textures:** the 144 most-used were rendered in a Studio gallery and looked
  at.
- **Effects:** several were rebuilt in Studio and captured frame by frame.
- **Videos:** each was cut into contact sheets, and its impacts stepped at
  30 fps.
- **Engine probes:** the behaviours the data only implied were probed in
  Studio with one test texture over a dark and a bright background.

### Findings

**Textures**
- 915 distinct textures; only 8 emitters use a Roblox built-in.
- Almost all are white, hard-edged, cel-shaded drawings on transparency.
- 46% of emitters play a flipbook, mostly 4 x 4, whose frames break apart
  rather than fade.

**Layers**
- 40-60 distinct layers make one hit in the slashes.
- The median `EmitCount` is 1, and 37% of emitters have Speed near 0: stacked,
  timed sprites.

**Value**
- 7% of emitters are pure black, and 10-35% in the value-focused pieces.
- Black is used as backing behind colour, as accents in front, and as twins
  that move differently.
- Impacts stack a colour copy, a black copy at `ZOffset` +0.25 and a white copy
  at +1.

**Brightness and blending**
- The median Brightness is 9.
- 39% of emitters use `LightEmission` 0, 35% use 1, and 10% are negative.
- Every studied place has Bloom at Threshold 2, the same as a new place.

**Orientation**
- 34% `VelocityPerpendicular`: flat rings and crescents in a fixed plane.
- 23% `VelocityParallel` with `Squash`: streaks.

**Timing**
- Flash and impact frames: 0.03-0.15 s.
- Crescents: 0.15-0.4 s.
- Rings and debris: 0.4-1.4 s.
- Smoke: 1-3 s.
- The median lifetime is 0.45 s.

**Videos**
- A one-frame overexposed star flash.
- Full size within two frames.
- About 0.6-0.8 s in total for a hit.
- Fire turns into dark smoke with glowing cracks.
- Anticipation before big hits.
- Scorch marks that linger.

**Conventions**
- `EmitDelay` is absolute. VFX Forge writes a group's delay onto every
  descendant; summing ancestors would double it.
- `EmitDuration` means "re-burst every 0.1 s" in some scripts and "Enabled at
  `Rate`" in others.
- `TimeScale_*`, `Size_*` and `Part_*` attributes are VFX Forge editor inputs.
- The Keyframe data in the slash places animates only the character rig. The
  effects are fired from Moon Animator markers.

### Verified in Studio

**Blending**
- At `LightEmission` 0, Brightness 5-150 renders a solid shape pushed toward
  white, which blooms.
- `LightEmission` 1 washes out over a bright background.
- Negative `LightEmission` (-1, -3) keeps the colour saturated and opaque over
  a bright background, with a dark rim.
- A black layer renders as:
  - solid ink at `LightEmission` 0;
  - a faint veil at 0.55;
  - nothing at 1.

**Other behaviour**
- `VelocityPerpendicular` at Speed 0 does not show; at 0.001 it lies flat.
- Transparency keys above 1 make a particle vanish early. Negative
  Transparency does not harden a soft texture.
- A Decal's `Color3` above 1 renders overbright and blooms.
- `Emit(0)` emits nothing.

### Roqer's fire punch, against this

- **Sheets:** Roqer made 8 x 8 sheets of soft, grey, rendered smoke with no
  silhouette, and the frames barely changed. (This first said each frame
  filled about 5% of its cell. A later measurement put their widest drawing
  at 39-62% of a cell. Size was not the fault; see the second study below.)
- **Meshes:** plain grey.
- **Result:** a generic glow, orange spikes and a brown cloud:
  - no flash frame;
  - no dark layers;
  - no hard silhouettes.

### What changed

- **Guidance:** `vfx-craft.md` is rewritten around the measured and verified
  findings, with the source of every number marked.
  - Layer skeletons replace the built-in-texture recipes.
  - Two earlier claims are corrected: that additive textures need a black
    background, and that soft shapes read as magical.
- **Drawing helpers:** the Blender worker gains `roqer.draw_flipbook`,
  `draw_texture` and 2D primitives (`tex_coords`, `tex_polar`, `tex_noise`,
  `tex_cells`, `tex_sample`, `tex_edge`, `tex_ease`) for drawing stylised
  textures with numpy.
  - The worked examples in `blender.md` were run verbatim in Blender 5.2: two
    sheets and a texture in about 5 s.
  - `roqer.flipbook` now defaults to a 4 x 4 grid.
- **Flipbook check:** Roqer noted a sheet whose drawing spans under 40% of a
  cell at its largest frame. This was removed after the second study: it
  would have flagged most of a professional hand-drawn set and missed Roqer's
  own sheets.
- **Emit module:** the handle's time scale multiplies each emitter's own
  `TimeScale`, so artists' slowed smoke keeps its pace, and the authored value
  is restored afterwards.
- **Checked live:** the reference's JSON examples, built verbatim as one
  effect, play in Place1 as designed. The sequence is an anticipation point, a
  one-frame star flash, a hot core with a dark rim and streaks, then a ground
  ring and smoke.

### After a second run

The same brief, re-run on the new guidance, produced a different effect. It
had drawn textures, cel smoke, glowing branching cracks, ground slabs, a
wind-up and a flash, and the user called it a better direction. Four faults
remained:
- **A white blob at the core.** The data shows pure-white layers are thin
  shapes at Brightness 1-2, about as big as the coloured layers; the hot centre
  is a coloured layer at high Brightness.
- **A large half-transparent dome.**
- **Smoke in one flat tone.**
- **A light that tinted the whole floor.**

The guidance now covers each one, and they are added to its checking
questions.

The run also used 10 uploads, one wasted on a texture it then redrew. So
previewing a texture in Studio without uploading was tested (2026-10-02, edit
mode):
- An `EditableImage` made by `AssetService:CreateEditableImage` and filled with
  `WritePixelsBuffer` shows on a `Decal` and an `ImageLabel` through
  `TextureContent` and `ImageContent`.
- `ParticleEmitter.TextureContent` and `Beam.TextureContent` accept it. The
  particle draws nothing, even after re-emitting, and the beam draws a plain
  white strip.

So a true particle preview cannot come from memory today.

The content folder was then tried, with the user's consent, and adopted:
- A PNG copied into `content/textures/roqer-preview` loads as an
  `rbxasset://` address with no restart, and plays as a flipbook.
- An overwritten file keeps showing its first image, so each job's files get
  new names.
- The Blender tool's `preview_in_studio` flag does this
  (`runtime/studio-preview.ts`, documented in `docs/blender.md`). It was
  checked end to end: a real job's sheets were staged into the real install
  and played on a particle in Place1.

The two ways considered:
- **A stand-in card:** a billboard `ImageLabel` stepping through the sheet's
  cells. It shows shape and timing, but not particle blending, Brightness or
  bloom.
- **Studio's content folder:** files there load as `rbxasset://` and render as
  real particles. Writing there changes the user's Roblox install, so it needs
  their consent, and a Studio update removes the files.

### Next

- **Camera, screen and debris effects:** the studied scripts add camera shake
  presets, impact frames (ColorCorrection), light flashes and ground-sampled
  crater rings. The guidance documents them with numbers; the emit module does
  not do them yet.
- **Proof:** re-run the fire-punch brief in Roqer and compare against the
  study. That needs the user's look, and texture uploads only with their
  approval.

## Second reference study: design

Done 2026-10-02, with a second collection from the user:
- 27 Roblox files: skills, showcases, practice pieces and asset packs;
- a hand-drawn texture set of 49 sheets, by Qwinkle;
- a captioned tutorial video by the artist snaliel.

The aim was design: what each effect is for and why it looks as it does.

### Method

- **Files:** dumped as before. Three parallel readings covered the beam and
  projectile skills, the character skills and showcases, and the practice
  pieces with the texture set.
- **Textures:** the 168 most-used were rendered in a Studio gallery.
- **Effects in Studio:** some practice pieces and Reversal Red were rebuilt in
  Place1 and captured.
- **Video:** the captions were read frame by frame.

### What the effects are

| Effect | Kind | What it is |
| --- | --- | --- |
| AbyssalRay | Ultimate | A dark summoning-circle beam: 7.5 s root, two implosions, black and white impact frames, then a 0.25 s beam sweep with a crater |
| beam | Held beam | A Kamehameha-style hand beam |
| fiya beam | Held beam | An overhead fire cannon |
| firedragon | Summon | A Katon fire dragon, homing on a Bezier path |
| Fireball | Ultimate | A meteor ultimate |
| Flame Beziers | Barrage | Fire missiles |
| Water Barrage | Volley | A Gate-of-Babylon portal volley |
| Mildly wet projectiles | Basic skill | Water projectiles on a one-second cooldown |
| Missile Sequence | Showcase | An arcane star barrage between staged cubes |
| Ayato | Showcase | A five-hit sword combo and a dash, hand-timed to a 3.2 s animation |
| Healing | Practice | An A/B of pulsed bursts against a continuous stream |
| teleport | Kit | A glitch blink |
| Petal Pathway | Showcase | A traversal path |
| Reversal Red | Fan move | Gojo's Reversal Red |
| Colouring Practice | Practice | Colour |
| Constellations | Practice | An A/B of a halftone overlay |
| Pink and Blue | Practice | A two-hue aura and hit |
| Magic Missiles | Practice | One recipe recoloured four ways |
| orb thingies | Pickups | Three orbs differing only in colour |
| Jaxelos explosion | Showcase | A staged mega-explosion with colour-correction frames |
| VFX_MASTERSTUDY | Study | A two-hit study timed with Moon Animator, with camera FOV keys |

The rest are mesh packs and Part_Icles mesh-particle, trail and lightning
rigs.

### New findings

**Palette and colour:**
- Many skills are a single hue, with value from Brightness, dim twins and a
  dark gradient tail.
- Two-hue effects use analogous hues about 45-50° apart; a complementary
  accent stays at about 10% of layers.
- The tutorial says: choose about five colours and never break the palette,
  and pair saturated energy with desaturated debris and smoke.

**Value without black:**
- a Brightness 0-0.01 white sprite;
- same-hue dim twins;
- a gradient that runs to near-black at `LightEmission` 0;
- a white base under additive colour;
- inverted value for dark energy: a black core in front of a white halo.

**Timing:**
- The tutorial's intensity curve: one emit, with layers dying in order. Key
  poses only get less intense: the flash with wind, then the scatter, then
  the residue.
- Cause and effect are staggered.
- Shockwave rings are thin Neon discs that grow in 0.2 s while fading.
- Hit, hold, then a hit 1.6-1.8 times bigger about 1.4 s later.
- Impacts fire 0.1 s before a projectile arrives.

**Construction:**
- Projectile anatomy: a head, 2-3 trails, and shed particles.
- Slashes drawn in time, with points along the arc delayed 0.04-0.05 s apart.
- Held beams: 2-3 Beams with unsynced scroll, plus Rate-driven streaks.

**Camera, screen and world:**
- FOV pulls back while charging and snaps at release; blur, tint, and black
  and white impact frames.
- Shakes are rotation-only and gated by distance.
- Lights expand their Range while dying.
- Craters copy the floor's material and colour.

**Bloom and textures:**
- Bloom thresholds in these places run 1 to 2. Brightness is relative to the
  place's bloom.
- The hand-drawn textures are white with binary or posterised alpha, take
  their detail from negative space, and grow then fragment.
  - Their shapes are small in the cell: the widest drawing's median is 27% of
    the cell, and 40 of 49 are under 40%.

### Corrections

- **The small-drawing note is removed** from Roqer's flipbook check. It would
  have flagged most of the hand-drawn set, while the sheets it was written for
  measured 39-62% and would not all have been caught.
- **The guidance now says size in the cell varies,** and names what made
  Roqer's first sheets generic: softness, grey, no silhouette, and frames that
  barely changed.
- **The study's own attribute decoder** read colour and number sequences in
  attributes in the wrong field order (the envelope comes first). It is fixed;
  the first study's conclusions did not rest on those values.

### What changed

- **`references/vfx-design.md` (new):** what the effect is for; palette;
  value; brightness against the place's bloom; textures; layers; the intensity
  curve; motion; projectiles, slashes, beams and sustained forms; camera,
  screen and world.
  - It combines both studies and the tutorial.
  - `vfx-craft.md` keeps the engine, tools, skeletons and checking, and points
    to it.
- **`references/blender-vfx.md`:** describes hand-drawn texture traits and
  drops the cell-fill claims.

## After the ice spear run

A third brief tested the new guidance: an ice spear for an anime battlegrounds
game.

**What improved:**
- the palette held: five named colours, with cobalt and navy as the darks;
- the shards were cel-shaded with lit and shadow faces;
- textures were previewed in Studio and redrawn before upload, and only the
  settled set of 7 was uploaded.

The user called it a lot of progress, but not yet top notch.

**What still separated it from the references:**
- **Textures looked like clip art:** a perfectly radial impact star with even
  outlines, a snowflake-symmetric frost patch, and a ring with gear-like
  notches. The drawing helpers made geometry easy (polar rays and rings) and
  gave nothing for drawn shapes.
- **Little speed:** the spear was a thin sprite in flight, with few streaks
  and no wind rings or smears.
- **The core blew out:** a white blob again, pale on a light floor.

**Changed:**
- **Four drawing helpers:**
  - `tex_curve`: smooth paths;
  - `tex_stroke`: tapered brush strokes along a path, drawn on and erased by
    `start` and `end`;
  - `tex_blob`: lumpy, lopsided blobs;
  - `tex_warp`: noise-warped coordinates.
- **New examples in `blender-vfx.md`:** a claw slash, a lopsided cel-shaded
  puff, a splinter burst and branching ground cracks. The radial star and the
  Voronoi lava cracks are gone. The examples ran as written in Blender 5.2,
  and look close to the hand-drawn set's claws, puffs and cracks.
- **A "does it look drawn" checklist** in `blender-vfx.md`.
- **Speed carriers** for anything that moves, in `vfx-design.md`.
- **New checks in `vfx-craft.md`:** clip-art textures, floating projectiles,
  and a pale effect needing its darks on a light floor.

## After the second ice spear run

The same ice spear brief, run after the stroke helpers. The user: the charge
on the hand was the best part; the impact and explosion "look bad", nowhere
near the dump.

**What was measured.** The shatter was rendered on the study stage with the
same camera and timings as the dump's explosions, then from the caster's
camera 50 studs away. Its numbers were compared with 26 impact groups from
both dumps (deduplicated):
- **Size class:** the shatter's largest layer was 13 studs (30 for a ground
  ring). By screen area over time it sat with the dump's single arrow and
  barrage hits (peak 400-1,000 size² units), not with its explosions
  (4,000-25,000 for practice pieces, 480,000 for a meteor slam).
- **Distance:** from the caster's camera the shatter was a speck. Roqer's
  own checks framed it close, where it filled the view. The craft guidance
  told it to "frame close".
- **Size numbers:** the dump's largest layers (10-13 studs for one hit of
  many, 70-360 for a whole-skill projectile) are mostly flashes, flares and
  shockwaves at full size for a fraction of a second. Solid bodies are
  smaller (crescents 19-125 studs).
- **Brightness:** Place1's bloom threshold is 2. Every impact layer but a
  0.08 s flash sat at Brightness 1-3, so the shatter read as flat paint. The
  dump's impacts peak at Brightness 15 (median) and 50 or more in a third.
  The guidance's "most layers sat at 3-10" was read as applying to the hit.
- **Growth:** the shatter's mass peaked at +0.1 s and only shrank. Seven of
  nine dump explosions and slams kept growing 0.25-1.35 s after the hit. The
  guidance's "nothing gets bigger" rule said the opposite.
- **Flat:** apart from a 6-stud spike mesh, it spread on the floor. The frost
  patch was even Voronoi cells, which read as tiles.

**Experiment.** The same shatter with sizes and speeds ×2.5 and its hot
layers at Brightness 12-60 read as a burst from the caster's camera, and was
overblown close up. Size and brightness are most of the gap. It still read as
a splash rather than an eruption, so the rest is design: something must rise.

**What changed:**
- `vfx-design.md` section 1: size the payoff for where it is seen, with the
  measured size classes; a flat impact shrinks to a smear at range.
- Section 4: the hit's hottest layer runs Brightness 15-50+, apart from the
  3-10 of trails and smoke.
- Section 7: brightness falls, but an explosion's mass grows for 0.25-1.35 s;
  the flash is the biggest thing in its frames.
- `vfx-craft.md` section 8: capture from the player's camera as well as
  close, and check size share, bloom and rise.
- `blender-vfx.md`: even cells as a whole shape read as tiles; ground marks
  spread from the point of impact.

## After the third ice spear run

The user: "looking better once again". Roqer checked the impact from the
caster's camera this time, sized it up (a 30-stud flash at Brightness 25, a
22-26-stud star, a 40-stud ground ring, upward spires) and it reads from
range.

**What still separates it from the dump:**
- **A pop, not a swell.** Its screen area peaks at about 2,600 (size² units)
  by +0.1 s, three times the previous run, but falls to a third by +0.25 s.
  Its star body lives 0.16-0.2 s; the dump's explosion bodies live 0.35-1.2
  s. What remains is 40 shards of about 2 studs, which reads as a sparkler
  from the caster's camera.
- **The flash** is a thin four-ray flare at 30 studs. Rotated, it shows as
  two white beams in a V.
- **Overbright decal colour** was refused by `build_instances`, whose
  `color3From` (`studio-plugin/src/modules/Utils.ts`) takes components from
  0 to 1 only, on purpose, to catch 0-255 values. The guidance asked for
  `Color3` 2-20 on decals without saying how. It now says to set it with
  `execute_luau` after the build.

Considered and dropped: reporting each flipbook cell's drawing span. The
star's spikes span 70% of its cell, so the span was not what made it read
small.

**What changed:** section 7 of `vfx-design.md` names the body layers and their
measured lifetimes, adds a lifetime row, and says a flash's body is a filled
shape. `vfx-craft.md` adds a check for the body at 0.3 s, and the overbright
decal route.

**Follow-up:** `draw_texture` images are not checked at all. Only flipbook
sheets are.

## The magic missile run, and what a run costs

The user: "looks actually pretty good", but the missiles' trails are bad, and
the run used 13% of a Max 5x session.

**Trails.** In the run's screenshots they are thin, uniform-width white
lines: no taper, no coloured or dark body, nothing shed. Roqer never saw them
in a capture. Pausing discards a trail's segments, and at 0.04x it captured
before the missiles had moved. Its own module moved the missiles, and may not
stretch trail lifetimes when slowed.

**Cost.** Run records keep no token counts. Claude Code runs with
`--no-session-persistence`, and the planner reads `modelUsage` only for the
context meter. So the following is an estimate. The run made 96 Studio and
Roqer tool calls, about 115 model requests, and each request re-reads the
whole conversation:
- About 40 of those calls were the pause, capture and resume loop: 16
  screenshots and 25 runtime evals.
- 16 screenshots reach the model at full size (2246 x 982, which Claude Code
  passes to Opus 5.5 at 2000 x 874, about 2,300 tokens each; first estimated
  here at 1,400 on a 1568-pixel premise, corrected after run 3). Each stays in context for the rest of the
  run.
- The first three calls read 820 lines of existing modules, including Emit,
  which the skill ships.
- Not a cost: the `get_script_source` rows after each write are Roqer's own
  read-backs, which never reach the model.

**Changed now:** two calls a moment instead of three; pick 4-6 moments; the
trail wait (effect seconds ÷ 0.04) and the lifetime stretch in a module of
the agent's own; Emit's first line carries a version, so an existing copy is
checked from one line.

**Proposed:**
1. Record each run's usage (`usage`, `num_turns`, `total_cost_usd` from Claude
   Code's `result` event) in the run record, with the migration and
   validation a stored schema needs, so savings can be measured.
2. A Roqer operation that captures several moments of a playing effect in one
   call: slowed rather than paused for trails, N images in one result.
3. Then, once measured: smaller screenshots, and the model and effort dials.

**Trails, read from the saved place.** The missiles play through the emit
module, so their trails were stretched when slowed; that was not the fault.
`TrailCore` is 0.32 studs wide and lives 0.22 s; `TrailBody` is 1.7 studs,
mostly transparent. What the missile sheds is 0.25-0.28 studs. The studied
missiles run 2-3 trails across about 5 studs, a dark or wide body under a hot
core, and shed particles at around 100 a second. The guidance says so; Roqer
never saw its own trails to compare.

**Built: `capture_moments`** (`runtime/capture-moments.ts`), offered inside
`roblox_studio` as a gateway operation (`shared/gateway-operations.ts`):
Roqer composes it from `execute_luau` or `eval_client_runtime` and
`capture_screenshot`. One call runs the code that starts an effect, plays it
slowly to each requested time (at most 20 s of real time per moment), holds it
or, with `hold: false`, keeps it playing for trails, captures, and returns up
to 8 frames in one result. It stops the effect afterwards, after a failure or
cancel too. It is classified irreversible like the calls it is made of, and
the approval card shows its code. `vfx-craft.md` section 8 now checks effects
with it.

**Checked live** in the user's saved missile place (2026-10-02):
- Held: the final blast at 0.05, 0.15, 0.35, 0.6 and 4 s. Five frames came
  back in one call, the last one empty after the effect ended.
- Not held: a full cast at 0.04x. The missiles' trails show, as they never
  did in the run's own captures.
- A caster-to-target marker viewed from the caster's side puts the camera
  about where the player's is.
- Workspace was left as it was.
- The wait now gives up once the effect's clock has stood still for 1.5 s; it
  used to sit out its 20 s cap after the effect ended.

**Magic missile, run 2 (first measured run).** 25% to 34% of a Max 5x
session, against 13% for run 1; 102 steps against 141; 71 tool calls against
96, 9 of them `capture_moments`. The usage line: 12.5M tokens read from
cache, 337k written to it, 153k output, 81 requests, about $8.27 at API
prices. Run 2 also carried the other guidance changes (two calls a moment,
Emit's one-line check, not reading other effects' code) and two playtest
start timeouts, so the saving is not the capture operation's alone.

*Corrected after run 3:* an earlier version of this note put cache reads at
about half of run 2's cost, and its frames at about 1,400 tokens each. Both
were wrong. Claude Code's model
table prices Opus 5.5 at $4 per million input tokens, $20 output and $0.20
cache reads, and run 2's $8.265385 reproduces exactly with cache writes at
$8, the one-hour rate. So run 2 was 30% cache reads ($2.51), 33% cache writes
($2.70) and 37% output ($3.06), not "about half" cache reads. Its frames were
estimated at about 14% of its cost.

**Contact sheet.** `capture_moments` now returns its frames tiled into one
image, two to a row (`composeContactSheet` in `electron/image-encoder.ts`,
using `nativeImage`). `sheet: false` returns full-size frames. The eval
harness runs without Electron, so it gets separate frames. *Corrected after
run 3:* the first version was 1568 pixels wide, on the premise that the
provider scales any image to about that size. For Opus 5.5 that was wrong:
Claude Code passes images up to 2000 x 2000, so run 2's frames reached the
model at 2000 pixels and the 784-pixel tiles had 6.5 times fewer pixels. The
sheet is now 2000 pixels wide (1000-pixel tiles).

**Follow-up (bridge):** while Studio was not drawing frames,
`capture_screenshot` first refused ("window appears minimized or not
rendering"), then returned frames that were 46 minutes old, from an earlier
playtest, without an error. A stale frame should be refused too.

## Magic missile run 3: why it looked worse

The same prompt a third time. The user: "way worse". It also cost more: 16.7M
cache reads, 299k cache writes, 175k output, 102 requests, about $9.23
against run 2's $8.27, and it ended unverified.

**What was compared.** Run 2's and run 3's `VFX` folders were exported from
the user's saved places and played side by side in Place1, on one stand-in
R15 caster, from the same cameras, at each version's own beats. Five
independent analyses covered the evidence images, the textures, the process,
the contact sheet and the playtest failures. Their load-bearing claims were
checked against Claude Code's logs and binary, Studio's logs and the code.

**How run 3 looks worse** (live, same conditions):
- **Sigil:** a 9-stud root with rune rings growing to 15 studs, thin line art
  around the whole caster; run 2's is about 5-6 studs, compact and saturated.
- **Missiles:** small white sparks with soft ribbons; run 2's are bright
  shards with white cores and magenta ribbons.
- **Finisher:** run 2 has a 30-40-stud light lance, crystal spires, crescents,
  dark violet dust smoke for 1.2-1.7 s and a ground sigil. Run 3 has a small
  flash, a camera-facing ring growing to 42 studs (a pale shell), a swirl of
  claw strokes up to 46 studs and no smoke.
- By the screen-mass metric, run 3's finisher is as large and lasts as long
  (peak about 8,500 against 9,100). The metric counts each particle's quad;
  thin claws and translucent rings fill little of theirs.

**Why** (most to least weight; one sample of each run):
1. **Design choices made before any capture.** Run 3 drew 8 textures to run
   2's 11, as geometric polar and segment shapes. Its scripts call `tex_warp`,
   `tex_blob` and `tex_curve` 0 times, against 4, 3 and 3 in run 2. It dropped
   run 2's cel smoke puff (its only matter layer) and loose rune glyphs, used a
   static 1.4%-wide ring on 10 emitters, and arranged its claws evenly around
   the centre. The guidance was identical, so this is model variance. Commit
   f2c9b03 cannot have caused it: every texture was drawn before the first
   capture.
2. **Its checks were weaker.**
   - **Playtests wedged.** The agent sent `stop` and `start` in one batch.
     Studio refused the start while still stopping ("already in transition
     StoppingPlayTest") and then refused every later start ("a previous one is
     still in progress"). The plugin returned `success` before Studio started
     (`TestHandlers.startPlaytest`) and only `warn()`ed the error, so each
     retry waited out a timeout. Several open Studio windows were not the
     cause. Run 3 then tuned on a stand-in in the edit viewport and never saw
     its final version on the character.
   - **Claude Code cut every call at 60 s** (`timeoutMs: 60000` for HTTP
     servers). Captures over 60 s and long playtest waits never reached the
     model, though Roqer recorded them as successful. A trail capture
     (`hold: false`) played the whole effect at 0.04x and always ran past 60 s,
     so neither run's model saw its trails in flight.
   - **The Blender result attaches at most 4 plain PNGs, by sorted name.** Run
     3's spark had no preview until a third job, and its own review sheets
     (`zz_review_*`) were never shown to it.
   - **The contact sheet** showed every run 3 frame at 784 pixels against run
     2's 2000. Plausible, not shown: the agent still caught the obvious
     problems.
3. **Process variance.** Run 3 tuned in a playtest first. Its accumulating
   camera shake moved the playtest camera. Its first arm fix (turning the
   `AnimationConstraint`'s attachment) did nothing. And it edited the module
   after uploading, so the completion gate asked for a fresh look.

**Cost:** +21 requests at peak context (the playtest wedge, arm and camera
debugging, the gate's re-capture) explain the extra cache reads. The contact
sheet lowered image cost (estimated about $0.30 against about $1.93 for the
same frames sent alone).

**Changed:**
- Claude Code gets a 24-hour tool-call timeout for Roqer's server (the
  per-server `timeout` key), so Roqer's own budgets, approvals and cancellation
  decide. Its automatic backgrounding of MCP calls running past two minutes
  (on when a user sets `CLAUDE_AUTO_BACKGROUND_TASKS`) is turned off with
  `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`.
- `capture_moments`:
  - It plays at normal speed and slows down only for the last stretch before
    each moment. For trails that stretch is 0.9 s of effect time, longer than
    any studied trail lives, but never more than one wait covers.
  - A capped wait continues in another call.
  - It keeps within its call budget and names the moments it had no time for.
  - It no longer rescales an effect that has finished. Emit's
    `setTimeScale` now refuses too, so its version line is 2026-10-03.
  - Checked live: a 3-moment trail capture reached every moment in 34 s with
    full trails, and an 8-moment held capture took 23 s instead of 35 s.
- The contact sheet is as wide as a frame sent alone would reach the model, at
  most 2000 pixels, so each tile is half that width and a frame is never
  enlarged. Eight 2246-pixel frames make 2000 x 1744 at 327 KB.
- Guidance:
  - tune in the edit viewport;
  - take the final look as full-size frames from the player's camera;
  - camera shake takes its offset back off;
  - pose an `AnimationConstraint` joint by writing `Transform` in
    `PreSimulation`;
  - never batch a playtest stop with a start, and stop retrying after one
    failure.

**Follow-ups, not done:**
- **Plugin and bridge:**
  - `stop` should wait out Studio's stop transition before returning;
  - `start` should fail with Studio's own error instead of reporting
    success;
  - readiness should be tied to the start that asked for it (run 2's call 50
    reported a session the bridge had not started).
  These need the live suites.
- **Blender worker:** stage previews for every texture, attach the agent's own
  review sheets, and name the PNGs not attached.
- **Texture checks:** report thin line art that will not survive distance
  (survival under a 1% erosion: run 3's rune ring 0.00, run 2's smoke 0.88)
  and radial arrangement, so the agent sees them as numbers.
- **The camera skill's shake recipe** pins the camera to where the shake
  began, which fights a following camera.
- **Per-request usage** is not kept, so where context grows can only be
  estimated.

## Texture study: light and drawn matter

Done 2026-10-04, after a void-slash run drew its four-point flare as four
bent strokes of different lengths around a lumpy blob, cut hard, with a glow
pasted underneath. The user asked why it looked weird. The cause was the
guidance: "Not symmetric, not even… not as rays and rings around a centre"
and "Hard edges… only an accent texture or two is soft" applied to every
texture. The run followed them. The same chat's first version, a cross
flare, was built the same way.

### Method

- **Files:** the 47 place and model files of the user's collection were
  parsed again. They hold 5,803 texture uses (4,950 particle emitters, plus
  beams, trails, decals and meshes) and 1,438 distinct textures.
- **Pixels:** every texture was fetched from Roblox's public thumbnail
  service, which serves an image asset as a 420 px PNG with its alpha and
  needs no login. Asset delivery at full size now requires authentication.
  1,431 came back; 5 are blocked by moderation and 2 were still pending.
- **Measured per texture:** how far faint alpha reaches past the shape's
  0.5 outline (about 1 px for a crisp edge at any thickness, tens of pixels
  for a glow), mirror and radial symmetry, and, for flipbooks, each cell's
  coverage, pieces and mean alpha. Each use was joined with its emitter's
  `LightEmission`, `Brightness`, `Lifetime`, `Squash` and `Rotation`.
- **Kinds** come from the emitters' and their parents' names (flare, shine,
  glow, ring, burst and so on), which is approximate. The 19 four-point
  flares were picked by eye from contact sheets of the flare, shine and
  flash kinds.
- **Limits:** 420 px is resampled from the 1,024 px originals, so this
  cannot check the hand-drawn set's posterised alpha, and an 8 x 8 cell is
  only 52 px.

### Findings

- **The blend predicts the edge.** At `LightEmission` 1, 83% of 1,734
  emitters use a texture that falls off softly. At `LightEmission` 0, 57% of
  2,440 use a crisp or nearly crisp one. Flipbook emitters are 65% crisp or
  nearly crisp; single-image emitters are 77% soft.
- **Four-point flares (19, on 124 emitters):**
  - 16 have four straight arms of the same length within 4%. The others are
    a tiny glint, a horizontal lens streak, and one with a longer lower arm.
  - 16 fall off softly and 2 are crisp concave-sided stars. Each arm thins
    and fades toward its tip from one smooth core.
  - None has bent arms or a lumpy core.
  - The emitters stretch them: 41% squash the flare, against 21% of
    emitters on other soft textures. Rotation is not special: 75% rotate it,
    against 86% of all emitters. They live a median 0.35 s (0.49 s across
    all emitters), mostly at `LightEmission` 1 and Brightness 5-12.
- **Round soft glows** (436 emitters) run at a median Brightness 2, and 39%
  at 1 or below.
- **Drawn matter holds the old description:** crescents, cel bursts,
  splashes, debris and puffs are crisp, lopsided and two-toned.
- **Flipbooks (463 one-shot sheets):** 57% break apart, 15% shrink and fade,
  6% erode in one piece. Coverage peaks a median 27% of the way through, and
  half end in blank cells. 4 x 4 is on 81% of flipbook emitters.
- **Decals:** one splash is 16 Decals swapped frame by frame on a part.
  Ornament and magic-circle decals are symmetric.

### Corrections

- "Almost all are white, hard-edged, cel-shaded drawings" (first study) was
  from the 144 most-used textures viewed by eye. It holds for drawn matter
  and for most flipbooks, not for the textures as a whole: light is soft.
- "Glows, flares and halos: `LightEmission` 1 at Brightness 0.05-1" holds for
  glows only. Flares run at 5-12.

### What changed

- **`vfx-textures.md`:** textures are split into two families, drawn matter
  and light. Light keeps its symmetry, as symbols do: a four-point flare
  mirrors on both axes with equal arms and one smooth core, and the
  emitter's `Squash` stretches it. The drawing pattern and the checklist
  say which family they apply to. Two flare examples were added (a soft
  glint and a crisp concave star), written in plain numpy and run in
  Blender 5.2 with the repository's helpers; they match the studied flares
  side by side.
- **`vfx-design.md`:** the fourth study, and flare and glow brightness. The
  blend-edge rule lives in `vfx-textures.md`: `vfx-design.md` and
  `vfx-craft.md` load together in one call, capped at 48,000 characters
  (`MAX_BATCH_CHARACTERS`, enforced by `vfx-craft.test.ts`). That call now
  returns 47,843, leaving 157 characters (about 400 before this change).
  The next addition to either file needs content moved to a topic file such
  as `vfx-textures.md`, not a higher cap.
- **`vfx-craft.md`:** the hard-silhouette and clip-art checks now say they
  are for drawn shapes, and ask about a flare's arms and core.

**The helpers were not changed.** They are thin numpy primitives and forbid
nothing. What steered two runs to the same broken flare was the
documentation around them: every example was drawn matter, the one pattern
was "draw, make it lopsided, cut it hard", and light was named only as the
thing not to draw ("rays and rings around a centre"). The guidance now says
the helpers are shortcuts for drawn matter and shows light written directly.

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
