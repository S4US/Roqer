# Image generation

Roqer can ask an image model for the flat pictures an effect or an interface
needs: particle sprites and light textures, UI icons and item art, decals and
signs, and tileable surface textures. You bring the model: OpenAI's image API,
OpenRouter's image list, Google's Gemini API, Cloudflare's Workers AI, or any
server that speaks OpenAI's `/images/generations` API, such as a local one. The
agent writes the
prompt, Roqer makes the call, measures what comes back, shows it to the agent
and to you, and the agent then previews it in Studio and uploads it when it is
right.

The integration is off until you turn it on. Flipbooks (anything that plays
across frames) and effect meshes still come from
[Blender](blender.md); the image tool is for a single drawn or lit shape.

## What you need

- **An image model.** One of:
  - an OpenAI API key that may use the Images API (the default model is
    `gpt-image-1`);
  - an OpenRouter key, with any model in OpenRouter's image list (the
    default is `openai/gpt-image-1`). OpenRouter has its own image API, not
    OpenAI's, so choose **OpenRouter** rather than the compatible server;
  - a Google AI Studio key, with a Gemini image model (the default is
    `gemini-2.5-flash-image`) or an Imagen model such as
    `imagen-4.0-generate-001`. This is the Gemini API, not a Google
    subscription and not Vertex AI;
  - a Cloudflare account ID and a Workers AI API token with Workers AI Read
    and Edit, with one of Cloudflare's image models. Roqer starts from
    `@cf/black-forest-labs/flux-2-klein-4b` (the default), FLUX.2 Klein 9B,
    FLUX.2 Dev, Leonardo Lucid Origin, Leonardo Phoenix and FLUX.1 Schnell;
    **Custom model…** names any other Workers AI image model;
  - an OpenAI-compatible server's address and, if it needs one, a key.

  The image source must return PNG files, except Cloudflare: OpenAI does when
  asked, OpenRouter and Google return PNG from their image models, and a
  compatible server has to be set to PNG. Cloudflare's image models often
  return JPEG, which Roqer converts to PNG before measuring or keeping it; any
  other format is refused.
- **A Roblox Open Cloud API key**, to upload the pictures into your place.
  Without one, the agent can still generate, measure and preview, but cannot
  upload. See [Roblox Open Cloud in Roqer](configuration.md#roblox-open-cloud-in-roqer).

## Turn it on

1. Open **Settings → Images** in Roqer.
2. Click **Change**, choose **OpenAI**, **OpenRouter**, **Google**,
   **Cloudflare** or an **OpenAI-compatible server**, name the model, paste the
   key, and pick a default quality. Cloudflare also asks for the account ID;
   pick one of its listed models or **Custom model…** to type another id.
   **Save**.
3. **Test** asks the server about the model without making a picture. For
   OpenRouter it also says what the model takes: a transparent background, a
   quality, how many pictures a call, reference pictures. For Google it asks
   the models endpoint directly and, when the model is not listed, says which
   image models the key can see. For Cloudflare it asks the Workers AI model
   list for the account and names the image models there when the model is not
   among them.
4. Turn on **Generate images**.

While it is on with what it needs, the agent is offered an `image` tool.
Turning it off, or removing the key, takes the tool away from the next run,
and a run already going gets a refusal from its next call.

## How a call works

Each call asks for one to four pictures from one prompt, with:

- a **kind**: `light` (flares, glows, rings, ray bursts; on black, used with
  `LightEmission` 1), `matter` (slashes, puffs, bursts, debris; on
  transparent, crisp edges), `icon` (transparent, 512 pixels), `decal`
  (opaque) or `tile` (opaque, seams measured). The kind sets the default
  background and size and which checks run.
- a **name**, the file stem: `rune_ring` makes `rune_ring.png` and
  `rune_ring_2.png`.
- optionally a **quality** for this call, a **reference**: an earlier output of
  the same chat to vary rather than draw afresh, and **preview_in_studio**.

Every call is irreversible, because it sends the prompt to the image provider
and spends your key or plan. Roqer asks you before each one unless the chat
is in Full auto, and one run may make at most 24 pictures. The approval card
shows the prompt. If the provider refuses a prompt, the agent reads the
provider's reason and nothing is made.

The result the agent reads names the job, the model that answered and any
rewording the provider made, and for each picture the file's path and what
Roqer measured. One picture is attached as a preview, or a review sheet when
the call made several. Transparent pictures are shown over a dark ground, the
way they will glow in a game.

## What Roqer checks

Roqer does not judge a picture by eye. It reads the pixels and tells the
agent:

- the size, whether it is square and a power of two, and how much of the
  frame is drawn;
- which **family** the picture landed in: crisp drawn matter, soft light,
  mixed, or opaque with no transparency. A light texture that came back with
  hard edges, or a drawn shape that came back soft, gets a line saying what to
  ask for instead;
- how much of the drawn area is at **full brightness**, beside the medians of
  the studied textures (about 1% for soft light, 19% for crisp matter, 29%
  for mixed), because a texture that is mostly full-bright reads as cheap;
- for a ring, whether it is **even all round**, which reads as clip art;
- for a tile, how much the opposite **edges** differ, which shows as a seam.

The agent is told to read these before using a picture, and to iterate at
most twice on one texture before drawing it in Blender or taking one from the
Creator Store.

## Previewing in Studio

With `preview_in_studio`, the pictures are copied into your Roblox Studio
install and come back as `rbxasset://textures/roqer-preview/...` addresses,
so a texture can be seen on a ParticleEmitter, Beam or Decal before any
upload. The same rules as Blender's previews apply: the addresses work on
your computer only, previews older than seven days are removed, and the
agent must replace every preview address with an uploaded asset before the
work is done. See [Previewing textures in Studio](blender.md#previewing-textures-in-studio).

## Into the place

The settled pictures go up with `upload_assets` as Decals, and each
`imageId` goes into the emitter, label or decal. Uploads pass the
[upload ledger](configuration.md#your-uploads), so a picture that was
already uploaded is not uploaded again, and each upload records the file's
name and hash. Each picture's prompt, model and server are written beside it
in a `.json` file, so an upload can say where its picture came from.

## Safety

- The key is encrypted with the operating system's credential store and
  never reaches the window or the model.
- Prompts go only to the server you set. Roqer sends nothing to a server of
  its own.
- Every call is approved outside Full auto, classified like an upload or a
  Blender job, and bounded per run.
- The agent is told what never to ask for: brands, named characters, logos,
  text, recognisable people, another game's assets.

## Where Roqer keeps things

- **Settings:** `image-generation.json` in Roqer's data folder, with the key
  encrypted. A file Roqer cannot read is moved aside, Settings says so, and
  you enter the settings again.
- **Jobs:** `image-jobs/` in Roqer's data folder, one folder per call with a
  `job.json`, the PNG files and a `.json` beside each. Folders older than
  seven days, and all but the newest 40, are removed when a new job starts.
- **Previews in the chat:** the pictures the results card shows are kept
  with the run, like screenshots.

## Limits

- The source must answer with PNG files or, on Cloudflare, JPEG, which Roqer
  converts; WebP or another format is refused with a message saying so.
- A reference may be an earlier output of the same chat only, named as the
  result named it (`jobId/file.png`). An edit needs a server with an
  `/images/edits` route (OpenAI has one), an OpenRouter model that takes
  reference pictures, or a Google Gemini image model. Google's Imagen models
  make a picture from the prompt alone, and Cloudflare's image models take the
  prompt alone.
- On OpenRouter, Roqer reads the model's capabilities first and sends only
  the fields it takes. A model with no transparent background gets the
  background asked for in words and returns an opaque picture, which the
  result's family line says; OpenAI's image models through OpenRouter take
  it as a field. A model that makes one picture a call is asked once per
  picture.
- On OpenRouter, a size reaches the model as an aspect ratio and, when the
  model lists them, a resolution tier. A model with no tiers chooses its own
  pixel size, so a `512x512` request can come back larger. The result reports
  the size Roqer measured.
- On Google, Gemini image models make one picture a call, so a request for
  four is four calls; an Imagen model makes up to four in one `predict` call.
  Roqer uses the Gemini API with a Google AI Studio key, not Vertex AI.
- On Google, a size reaches the model as an aspect ratio: `1:1` for square,
  `3:2` or `2:3` on a Gemini model, `4:3` or `3:4` on Imagen. Google chooses
  the pixels, and the result reports the size Roqer measured.
- Google has no transparent-background or quality field. Roqer asks for the
  background in words and does not send its quality setting; a light or matter
  texture may come back opaque, which the result's family line says.
- On Cloudflare, the Run API makes one picture a call, so a request for four is
  four calls. FLUX.2 and Leonardo models take the width and height from the
  size; FLUX.2 Klein and Dev accept 256 to 1920 pixels, so a `1536x1024`
  request fits, and `flux-1-schnell` takes no size at all. Cloudflare chooses
  the pixels when it is not given a size, and the result reports the size
  Roqer measured.
- A Cloudflare custom model id is sent the prompt with the width and height
  taken from the size, except FLUX.2 ids, which go as multipart form fields,
  and `flux-1-schnell`, which takes the prompt alone. A model that expects a
  different request shape fails with Cloudflare's own message.
- Cloudflare has no transparent-background or quality field. Roqer asks for the
  background in words and does not send its quality setting; a light or matter
  texture may come back opaque, which the result's family line says.
- Cloudflare image models are sent the prompt alone: a reference picture is
  refused before spending anything, so an earlier output cannot be varied
  through Cloudflare. Choose OpenAI or a Google Gemini model for that.
- Roqer sends the prompt as the agent wrote it, with the background added in
  words for servers that take no background field. The provider's own
  rewording, when it reports one, is shown to the agent.
- Image generation through a ChatGPT, Claude or Google subscription is not
  wired; the tool uses the key or server set in Settings → Images, whichever
  provider drives the chat.
