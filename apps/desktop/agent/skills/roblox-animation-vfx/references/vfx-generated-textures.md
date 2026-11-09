# Generated textures

Load this with `vfx-design.md`, `vfx-craft.md` and `vfx-textures.md` when the
`image` tool is offered: the user has an image model on, and a single drawn or
lit shape can be generated instead of drawn in a Blender job. Flipbooks and
effect meshes still come from Blender. Everything `vfx-textures.md` says about
what a texture looks like still holds; this page is how to get it from an
image model and how to read what Roqer measured.

## Generate, draw or render

- **Generate** a single shape: a ring, sigil, slash, claw, puff, burst, spark,
  glyph, crack, splash, a glow or flare. One subject per call.
- **Draw in Blender** (`roqer.draw_texture`) a shape that must match a
  measurement: a slash with a known sweep angle, a ring of a set thickness, a
  radial that lines up with a mesh.
- **Render in Blender** anything that plays across frames (a flipbook) or is a
  lit volume. An image model draws one still; it cannot keep a frame sequence
  consistent.

Each call is irreversible: it spends the user's key or plan and sends the
prompt to the image provider, and the user approves it outside Full auto. Ask
for what the effect needs, not probes. One run may make 24 pictures.

## The two families as prompts

- **Light** (`kind: "light"`, on black, used at `LightEmission` 1, tinted by
  `Color`): "a soft [shape] of white light on a pure black background, bright
  at [where], fading to nothing at the edges, no hard edges, no outline". The
  black is invisible at `LightEmission` 1, so no alpha is needed.
- **Matter** (`kind: "matter"`, on transparent, used at `LightEmission` 0,
  tinted by `Color`): "a [shape] in flat white on a transparent background,
  crisp cel edges, at most two flat tones, holes and notches where it breaks
  apart, asymmetric, no gradient, no outline".
- **Smoke:** mottled, not flat: "a soft-edged billow of white smoke on a
  transparent background, light and dark mottling inside, an irregular
  silhouette". A crisp silhouette around a soft, mottled inside is the second
  studied kind; a flat cel puff is for a clearly toon game only.

## Rules in every prompt

- One subject, centred, filling about two thirds of the frame, on an empty
  background. Say the style the effect's palette and the game's look call
  for (cel, painted, soft light) and the edge (crisp or soft).
- White, unless the texture carries its own colour by design (a decal, a
  tile). The particle's `Color` tints a white texture.
- No text, logos, brands, named characters, recognisable people, scenery,
  drop shadows, or another game's assets. The prompt is kept beside the file
  and the upload.

## Kinds and sizes

Particle and beam textures are 1024 square (the default for `light` and
`matter`); icons 512, matching the UI theme's line weight; decals wide or
tall; tiles opaque. Roblox keeps at most 1,024 pixels a side.

## Reading the result

Roqer does not judge the picture by eye. Read the lines it measured before
using one:

- **Family.** A `light` call that came back as crisp drawn matter needs "a
  soft falloff that fades to nothing"; a `matter` call that came back soft
  needs "crisp cel edges with no gradient". Or use the picture as the family
  it landed in, with the matching `LightEmission`.
- **Full brightness.** The share of drawn pixels at full brightness, beside
  the study's medians: 1% for soft light, 19% for crisp matter, 29% mixed. A
  texture far above its median reads as cheap; `Brightness` on the emitter
  makes it bright, the value inside it reads as craft.
- **Ring.** A ring that is even all round reads as clip art; ask for a
  brighter accent and a fainter rest, or vary it with `count`.
- **Seams.** A tile whose opposite edges differ shows a line when tiled; ask
  for a seamless, tileable texture, or edit it with `reference.output`.
- **The review sheet.** Transparent pictures are over a dark ground, as they
  will glow in the game. Several pictures from one call are numbered on one
  sheet; compare them and keep one.

## Iterating

- Vary with `count` (two to four) before changing the prompt.
- Edit with `reference: {output: "jobId/file.png"}` to keep a composition
  and change one thing; the prompt then says what changes.
- Draft at `quality: "low"`, settle at `"high"`.
- At most two rounds on one texture. Then draw it in Blender or take a
  Creator Store texture, and say so.

## Into Studio

1. `preview_in_studio: true` on the call, or on the settled one, and put the
   returned `rbxasset://` address on the emitter, beam or decal; check it in
   a playtest or a `capture_moments` sheet like any other texture.
2. When settled, `upload_assets` each file as a `Decal` in one call, from the
   paths the result returned.
3. Put each `imageId` in the emitter, label or decal, replacing every
   `rbxasset://textures/roqer-preview/...` address. The work is not done while
   a preview address remains.

## Recipes

Each is one complete call. Adapt the shape and the style words to the effect.

- **Rune ring (light):** `{prompt: "a thin ring of soft white light on a pure black background, brighter at four points around it, fading to nothing outward and inward, no hard edges", kind: "light", name: "rune_ring"}`
- **Slash (matter):** `{prompt: "a single curved sword slash arc in flat white on a transparent background, crisp cel edges, thick in the middle tapering to sharp points, two small gaps along the trailing edge, asymmetric", kind: "matter", name: "slash", count: 3}`
- **Smoke puff (matter, mottled):** `{prompt: "a soft-edged billow of white smoke on a transparent background, light and dark grey mottling inside, an irregular lumpy silhouette, no outline", kind: "matter", name: "smoke_puff", count: 2}`
- **Spark burst (light):** `{prompt: "a burst of thin white light rays from a small hot centre on a pure black background, rays of uneven length, fading to nothing at their tips", kind: "light", name: "spark_burst"}`
- **Glyph (matter):** `{prompt: "a single angular arcane glyph in flat white on a transparent background, crisp cel edges, made of straight strokes and one small circle, no text or letters", kind: "matter", name: "glyph", count: 4}`
- **Item icon (icon):** `{prompt: "a steel longsword with a leather-wrapped grip, cel-shaded with two flat tones and a dark outline, centred on a transparent background, no text", kind: "icon", name: "longsword_icon"}`
- **Wooden plank tile (tile):** `{prompt: "a seamless tileable texture of weathered wooden planks, warm brown, soft grain, flat lighting, edges that continue across the frame", kind: "tile", name: "planks"}`
