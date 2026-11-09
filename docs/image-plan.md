# Image generation plan

Proposed on 2026-11-05. Nothing here is built. It maps an `image` tool onto the
code as it stands, layer by layer, with the tool contract and the guidance the
model would read. The Blender worker is the pattern throughout: an opt-in
local operation, offered only when the user turned it on, approved like any
tool, checked by Roqer rather than trusted, and previewed before anything is
uploaded.

## Goal

One run that designs an effect, generates the sprites it needs, checks them,
previews them in Studio, uploads the settled set and wires the image ids into
the emitters. Today that is three apps and a lot of pasting. The same tool
serves UI icons, item art, decals and tileable surfaces.

What it does not replace: Blender renders anything that moves frame to frame
(flipbooks) or needs exact geometry (effect meshes). Image models do not keep
frames consistent, and the flipbook check would reject most of what they
make.

## Principles

- **The host checks, the model reads.** Every output is measured against the
  texture study before the model may use it: size, family (crisp drawn matter
  or soft light), share at full brightness, a ring's evenness, a tile's seams.
- **Nothing new after generation.** Studio preview, upload as Decals, image
  ids into emitters: the existing path, unchanged.
- **Spending is irreversible.** A call spends the user's key or plan and sends
  the prompt to a third party, so it is classified like `generate_model`: it
  asks in every mode but Full auto, and a per-run cap holds in every mode.
- **The user's own account first.** The sources, in order of fit: the
  subscriptions the user already connected (ChatGPT through Codex, Google
  through Antigravity), then a key, then a local endpoint.
- **Provenance travels with the picture.** The prompt, the source and the
  model are written beside each output and kept with the upload record, which
  answers the VFX plan's moderation concern.

## The pieces, by layer

### Shared contract: `apps/desktop/shared/image-generation.ts`

Names and bounds the main process and the renderer both use, as
`shared/blender.ts` does for Blender.

```ts
export const IMAGE_TOOL_NAME = "image";            // model-facing
export const IMAGE_OPERATION = "generate_image";    // the run-engine operation
export const MAX_IMAGE_PROMPT_CHARACTERS = 2_000;
export const MAX_IMAGES_PER_CALL = 4;
export const MAX_IMAGES_PER_RUN = 24;               // holds in every mode
export const IMAGE_KINDS = ["light", "matter", "icon", "decal", "tile"] as const;
export const IMAGE_SIZES = ["512x512", "1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageSourceKind = "openai" | "openai-compatible" | "google" | "chatgpt" | "antigravity";
export type ImageSettingsView = { enabled; source; model; hasKey; state: "ready" | "off" | "missing" | "broken"; message };
```

### Settings and storage

- **Store:** `runtime/image-settings.ts`, one file `image-generation.json` in
  the data folder, written atomically and validated on load, with the key
  encrypted through the operating system store exactly as
  `open-cloud-store.ts` does. The renderer is told only whether a key is
  saved. A damaged file is moved aside.
- **IPC:** `image-generation:get`, `save`, `test`, `remove`, each checking
  `isTrusted`, each added to the preload as a narrow typed call. New IPC means
  the Electron smoke runs.
- **Settings page:** a section beside Blender: source, model, key, a default
  quality, and Test, which generates nothing: it asks the provider for its
  model list or a dry request and reports the answer.
- **Offered only when ready:** `main.ts` computes `imageGeneration: boolean`
  from the store the way it computes `blender` today, and passes it to the
  planners.

### Sources: `runtime/image-sources/`

One interface, several adapters. Each takes a request and an abort signal and
returns PNG bytes with the provider's own notes.

```ts
export type ImageRequest = { prompt; kind; background; size; count; quality; reference?: { bytes: Buffer; mediaType: string } };
export type ImageSource = { generate(request: ImageRequest, signal: AbortSignal): Promise<{ images: Buffer[]; model: string; cost?: { estimateUsd: number } }> };
```

- **`openai-images.ts`:** the Images API. Generation posts JSON to
  `images/generations` with `model`, `prompt`, `n`, `size`, `quality`,
  `background` and `output_format: "png"`, and reads base64. An edit with a
  reference posts multipart to `images/edits`. Retries follow
  `model-api/http.ts`: transient statuses and `Retry-After`, with the key
  redacted from every message. The same adapter with an editable base URL is
  the `openai-compatible` source, which is how a local server (LocalAI, a
  ComfyUI wrapper) plugs in.
- **`google-images.ts`:** Gemini image output through `generateContent` with
  image modalities. Second.
- **`codex-images.ts`:** the spike. A second app-server process started with
  Roqer's lockdown list except `image_generation`, a thread with no dynamic
  tools, a workspace-write sandbox whose cwd is the job folder, one turn
  carrying the prompt, and the PNG collected from the folder or from the
  item. To verify before building: how the app server reports the picture,
  whether the sandbox lets the tool write, which models have it, and what the
  plan allows. `antigravity-images.ts` is the same spike for Google's tool,
  with a home whose gate allows it.

### The tool: `runtime/image-tool.ts`

`imageToolDefinition()` and `parseImageToolInput()`, mirroring
`blender-tool.ts`. The definition is in "The tool the model sees" below. The
parser validates every field, applies the kind's default background, and
throws `MalformedToolCallError` so every provider reports the same message.

### The worker: `runtime/image-worker.ts`

One approved call, in its own job folder under `image-jobs/<scope>/<jobId>`,
scoped to the chat like Blender jobs, pruned with the same retention
(`pruneJobFolders`, `JOB_RETENTION_MS`, `MAX_KEPT_JOBS` from
`model-preview.ts`).

1. Resolve the reference, if any: an earlier output of this chat by job and
   file name, or a user attachment by its opaque id through the attachment
   registry. Never a path from the model.
2. Call the source with the run's abort signal. Stopping the run aborts the
   request.
3. Write `<name>.png`, `<name>_2.png`, and a sidecar `<name>.json` with the
   prompt, kind, size, quality, source, model, reference and time.
4. Check each output with code that exists plus two small additions:
   - `decodePng` from `flipbook-sheet.ts`, and the size against the 1,024
     pixels Roblox keeps;
   - `analyzeRing` from `texture-ring.ts` when the drawing is a ring;
   - new `textureFamily()`: the share of partly transparent pixels says crisp
     or soft, and the share of drawn pixels at full brightness is reported
     against the study's medians (1% for soft light, 19% for crisp matter);
   - new `seamMismatch()` for `tile`: the mean difference between opposite
     edges, so a seam is a number;
   - for `light` on black, the same brightness share from luminance.
5. Make the model's view with `onDarkGround` and `reviewSheet` from
   `png-view.ts`, because a model cannot see alpha and a white shape on
   transparent reads as a blank square.
6. When `preview_in_studio` is set, `stageStudioPreviews` copies the PNGs
   into every Studio install and returns `rbxasset://` addresses.
7. Return a `McpToolOutcome`: text with one block per image (file path, size,
   family, brightness share, ring or seam report, preview address) and the
   review sheet as the call's image.

### Policy, activity and the approval card

- `shared/mcp-tools.ts`: `LOCAL_TOOL_RISK[IMAGE_OPERATION] = "irreversible"`,
  with the reason in a comment; `timeoutForTool` gives it 240 s, enough for
  four images at high quality; `summarizeToolCall` returns
  `generate_image · <kind> · <count> × <size>`.
- `shared/activity.ts`: "Generating images" and "Generated images".
- The approval card shows the prompt, the kind, the count, the size, the
  quality, the source, and an estimated price per source and quality,
  labelled as an estimate.
- The per-run cap is counted in the closure `main.ts` creates per run, where
  the Blender job already receives the chat id. A call past the cap is
  refused with a message the model can read.
- `main.ts` registers the operation in the `withLocalOperations` map beside
  `run_blender_script`.

### Planners

`WorkbenchToolOptions` gains `imageGeneration?: boolean`, and the tool is
listed after `blender` in `workbenchToolNames` and `workbenchMcpTools` for
Claude Code and the Antigravity CLI. The ChatGPT planner adds it to
`dynamicTools` and `parseDynamicCall`. The custom loop adds it to `loopTools`
and its parse branch. `MAX_WORKBENCH_TOOLS` is eight today, and a Claude run
with Blender, clips and MCP servers on already reaches eight; #97 raises it to
sixteen, and this needs that or its own raise.

### Previews and evidence

`studio-tools.ts` keeps a Blender result's picture as preview evidence by
operation name. `IMAGE_OPERATION` joins that condition, with its own evidence
title ("Generated images") and a lineage by output name like
`blenderLineage`, so `rune_ring.png` written again after a variant shows as
versions of one picture in the Previews tab.

### Into Studio

No change. `upload_assets` takes the job folder's paths and uploads each as a
Decal; the Decal's `imageId` goes into the `ParticleEmitter.Texture`,
`ImageLabel.Image` or `Decal.Texture`. The upload record keeps the sidecar's
prompt, source and model as metadata, and the asset ledger, if built, shows
them.

### Documentation

- `docs/images.md`: what you need, turn it on, how a call works, what Roqer
  checks, previewing in Studio, safety (the prompt leaves the machine; the
  picture goes through Roblox moderation; what the skill never asks for),
  where files are kept, limits. Modelled on `blender.md`.
- `configuration.md`: the Settings section. `README.md`: one feature line.
- `token-efficiency.md`: the tool list, if it names the workbench tools.

### Tests

- Unit: parse and schema; each adapter against a fake fetch, including the
  transparent background parameter, the multipart edit, a 429 with
  `Retry-After`, and redaction; the worker on synthetic PNGs (a crisp shape,
  a soft glow, an even ring, an uneven ring, a tile with and without a seam);
  the per-run cap; risk, timeout, summary and activity labels; the tool
  offered only when on, in every planner; the settings store's encryption,
  validation and damaged-file path; the skill references' reachability.
- Electron smoke for the new IPC.
- Eval `T22-generated-textures`: a rune-circle impact effect with generated
  textures, run with `--images`, like `--blender`. The oracle checks that a
  generation succeeded, that the emitters reference uploaded image ids and no
  `rbxasset://` preview address, that light textures sit on emitters with
  `LightEmission` 1 and matter textures on ones without, that each kept
  texture passed its checks, and that the capture tone check found the colour
  solid. A recorded run beside the magic missile prompt shows whether
  generated sprites read better than the drawn ones that looked cheap.

## The tool the model sees

Claude Code keeps only the first 2,048 characters of a tool description, so the
description carries the decisions and the properties carry the details, as the
Blender tool does.

```ts
export function imageToolDefinition() {
  return {
    name: IMAGE_TOOL_NAME,
    description: [
      "Generate one to four PNG images with the user's configured image model: particle sprites and light textures for effects, UI icons and item art, decals and signs, and tileable surface textures.",
      "Use it for a single drawn or lit shape. Render anything that moves frame to frame (a flipbook) or needs exact geometry (an effect mesh) in Blender instead.",
      "Each call is irreversible: it spends the user's key or plan and sends the prompt to the image provider, so the user approves it outside Full auto. Ask for what the effect needs rather than probing, and iterate at most twice on one texture before drawing it in Blender or taking a Creator Store texture.",
      "Roqer does not judge the picture by eye: it measures each output (size, whether it landed as crisp drawn matter or soft light, how much is at full brightness, a ring's evenness, a tile's seams) and attaches a review sheet with transparent images shown on a dark ground. Read the measurements before using an image.",
      "To use an image: preview_in_studio shows it on a ParticleEmitter, Beam or Decal before any upload; when settled, upload_assets each file as a Decal and put its imageId in the emitter, label or decal, replacing every rbxasset preview address.",
      "Before a first call for an effect, load roblox-animation-vfx references/vfx-generated-textures.md; for UI art, roblox-ui-design references/core/assets.md.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string", minLength: 1, maxLength: MAX_IMAGE_PROMPT_CHARACTERS,
          description: "One subject, centred on an empty background, filling about two thirds of the frame, in the shape's own colour: white for a texture the particle will tint. Say the style (cel, painted, soft light) and the edge (crisp or soft). No text, logos, brands, characters, scenery or drop shadows.",
        },
        kind: {
          type: "string", enum: IMAGE_KINDS,
          description: "What the image is for; it sets the default background and the checks. light: flares, glows, rings, ray bursts, on black, used with LightEmission 1. matter: slashes, puffs, bursts, debris, cracks, on transparent, crisp edges. icon: a UI icon, transparent, 512. decal: a sign, poster or picture, opaque. tile: a seamless surface, opaque, seams measured.",
        },
        background: { type: "string", enum: ["transparent", "black", "opaque"], description: "Overrides the kind's default." },
        size: { type: "string", enum: IMAGE_SIZES, default: "1024x1024", description: "Particle textures are 1024 square; Roblox keeps at most 1,024 pixels a side." },
        count: { type: "integer", minimum: 1, maximum: MAX_IMAGES_PER_CALL, default: 1, description: "Variants of one prompt; compare them in the review sheet and keep one." },
        quality: { type: "string", enum: IMAGE_QUALITIES, default: "medium", description: "low for a draft, high for the settled texture." },
        name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$", description: "File stem: rune_ring gives rune_ring.png and rune_ring_2.png; the result returns their paths for upload." },
        reference: {
          type: "object",
          properties: {
            output: { type: "string", description: "An earlier output of this chat, as its result named it (jobId/file), to vary or edit: the composition is kept and the prompt says what changes." },
            attachment: { type: "string", description: "The id of a picture the user attached, to match its style or shape." },
          },
        },
        preview_in_studio: { type: "boolean", description: "Copy the outputs into the user's Roblox Studio install and return an rbxasset:// address for each, so a texture can be seen on an emitter before it is uploaded. The addresses work on this computer only." },
      },
      required: ["prompt", "kind", "name"],
      additionalProperties: false,
    },
  };
}
```

What the result says, per image, in the order the model needs it:

```text
rune_ring.png  1024x1024  transparent  path: C:\...\image-jobs\a1b2c3d4\rune_ring.png
  family: soft light (41% of drawn pixels partly transparent)
  full brightness: 6% of drawn pixels (soft light in the study: median 1%; crisp matter: 19%)
  ring: uneven, brightness spreads 29% around the ring, width 44%: reads as drawn, not clip art
  studio preview: rbxasset://textures/roqer-preview/a1b2c3d4-rune_ring.png
```

## The guidance the model reads

### A new reference: `roblox-animation-vfx/references/vfx-generated-textures.md`

Routed from the VFX skill's topic list and from the first paragraph of
`vfx-textures.md`, which today says most effects should draw their own
textures in Blender. The new line: when the user has an image source on,
single drawn and lit shapes can be generated instead, and this page says how;
flipbooks and meshes stay in Blender.

Sections:

1. **Generate, draw or render.** Generate: a single shape (a ring, sigil,
   slash, claw, puff, burst, spark, glyph, crack, splash). Draw in Blender: a
   shape that must match a measurement (a slash with a known sweep angle, a
   ring of a set thickness). Render in Blender: anything that plays across
   frames, or a lit volume.
2. **The two families as prompts.** Light: "a soft [shape] of white light on a
   black background, bright at [where], fading to nothing, no hard edges";
   used with `LightEmission` 1, `Color` for the hue, no alpha needed. Matter:
   "a [shape] in flat white on a transparent background, crisp cel edges, two
   flat tones at most, holes and notches where it breaks apart, asymmetric";
   used at `LightEmission` 0, tinted by `Color`.
3. **Rules in every prompt.** One subject. Centred. About two thirds of the
   frame. Empty background. No text, logos, brands, characters, scenery or
   shadows. White unless the texture carries its own colour by design. State
   the style the effect's palette and the game's look call for.
4. **Kinds and sizes.** Particles and beams 1024 square. Icons 512, matching
   the UI theme's line weight. Decals wide or tall. Tiles opaque, and the seam
   number must be small.
5. **Reading the result.** What family it landed in, and what to do when it is
   the wrong one (a crisp prompt that came back soft gets "crisp cel edges, no
   gradient"; a glow that came back with an edge gets "fades to nothing").
   The full-brightness share against the study's medians. The ring report.
   The review sheet: transparent images are on a dark ground, as they will
   glow in the game.
6. **Iterating.** Vary with `count` before changing the prompt. Edit with
   `reference.output` to keep a composition. At most two rounds per texture,
   then Blender or the Creator Store. Draft at `low`, settle at `high`.
7. **Into Studio.** Preview on the emitter first. Upload the settled set in
   one `upload_assets` call as Decals. Put each `imageId` in place. Replace
   every preview address before the work is done.
8. **What never to ask for.** Brands, named characters, logos, text,
   recognisable people, another game's assets. The prompt is kept with the
   upload.
9. **Recipes.** A rune ring (light), a slash (matter), a smoke puff with
   mottling (matter, soft inside a crisp silhouette), a spark burst (light),
   a glyph (matter), an item icon (icon), a wooden plank tile (tile), each as
   a complete call.

### Small edits to existing guidance

- `vfx-textures.md`: the routing paragraph above, and in the smoke section a
  line that a generated puff is checked the same way.
- `roblox-ui-design/references/core/assets.md`: custom icons and item art
  through the `image` tool with `kind: "icon"` when it is offered; the
  vendored catalog through the icon tool otherwise.
- `roblox-building/references/blender.md`: a line that a flat picture, such
  as an icon, can come from the `image` tool when Blender's render is not
  needed.
- `developer.md`: unchanged. Blender is not named there either; the tool's own
  description carries its rules.

## Order of work

1. Contract, settings store and page, the OpenAI adapter with the compatible
   base URL, the worker with its checks, planner wiring, docs and unit tests.
   Cost M. This alone serves anyone with a key or a local server.
2. The Codex and Antigravity spikes, one to two days. If the app server hands
   back a picture, the subscription sources follow, and they are the ones
   most users can turn on with nothing new.
3. The skill page, T22, and a recorded run against the magic missile prompt
   with drawn textures beside generated ones.
4. The Google adapter and local presets.

## Risks

- **The subscription path may not exist in a usable form.** The spike decides
  it; the key path does not depend on it.
- **Moderation.** Roblox moderates every upload; a generated image can fail
  it. The state is read back as it is now, and the run says so.
- **Cost drift.** Estimates on the approval card are estimates. The cap per
  run bounds the worst case.
- **Prompt leakage.** The prompt is the model's words and may quote the user's
  place. The Settings page and `docs/images.md` say that the prompt leaves the
  machine, as the MCP servers page does for its servers.
- **Catalog size.** One more workbench tool, and a description near the
  2,048-character limit; measured, not assumed.
