# 3D modeling with Blender

Roqer can use your own copy of Blender to make 3D models that Roblox parts
cannot: curved or organic shapes, detailed props, vehicle bodies. It can also
render images, such as item icons for your UI. The agent writes a Blender
Python script, Roqer runs it on your computer and checks what comes out, and
the agent then uploads the result to Roblox and puts it in your place.

In one recorded run, "Model a low-poly wooden barrel in Blender and put it in
the Workspace" took one Blender job, a look at its preview, an upload, an
insert, and a few screenshots to check the result: 77 seconds in all.

The integration is off until you turn it on.

## What you need

- **Blender**, installed normally. Roqer looks for it in the standard install
  folders: Program Files, your user Programs folder and Steam on Windows,
  `/Applications` on macOS, and `/usr/bin`, `/usr/local/bin` or `/snap/bin` on
  Linux. Anywhere else, you choose it yourself. It has been tested with
  Blender 5.2.
- **A Roblox Open Cloud API key**, to put models into your place. The key needs
  the Assets API with Write access; set it up under **Settings → Roblox Open
  Cloud** (see [Roblox Open Cloud in Roqer](configuration.md#roblox-open-cloud-in-roqer)).
  Without one, the agent can still model and preview in Blender, but cannot
  upload.

## Turn it on

1. Open **Settings** in Roqer and find **Blender modeling**.
2. If Roqer did not find Blender, click **Choose…** and pick the Blender
   executable (`blender.exe` on Windows).
3. Turn the switch on. Roqer turns it on only once that file answers
   `--version` as Blender.

While it is on, the agent is offered a `blender` tool. Turning it off takes
the tool away again.

## How a job works

1. The agent writes a Python script, at most 60,000 characters. Roqer gives it
   a few helpers of its own that place each part by where it starts and ends,
   rather than by rotation angles, and keep the model flat-shaded. Unless you
   run in Full auto, Roqer shows you the whole script and asks before running
   it.
2. Roqer runs it in Blender in the background. A job starts on an empty scene,
   or on the scene an earlier job in the same chat saved, when the agent names
   that job. Every job whose script finishes saves its scene, with any
   material the script made but has not used yet; a job that fails saves
   nothing, so the next one starts from the last one that worked. This is
   how a detailed model is built in stages (frame, body, wheels, details), each
   a short script the agent can check before the next, and how a later message
   can change a model rather than rebuild it.
3. Roqer does not trust the script's own report. It re-imports the exported
   models (up to three a job), or, when nothing was exported, opens the saved
   scene, and measures size, triangles, meshes and materials, and checks the
   layout: pieces that touch nothing else, and separate parts that pass into
   each other, reported in the script's own coordinates. It renders a preview
   of four views in one image (side, top, and two opposite corners) that reaches
   the agent the way a screenshot does, and lists every object in the saved
   scene by name, size and position. The list points out what the agent would
   otherwise have to spot for itself: hidden objects an export would carry,
   geometry at invalid (NaN) positions that an export fails on, and left and
   right pairs (`Wheel_L` and `Wheel_R`) that do not mirror each other. A PNG
   reaches the agent as it is.
4. To use a model, the agent exports it, uploads it to Roblox as a Model and
   inserts it into your place, then checks its size there. An image uploads as
   a Decal, whose image ID a UI element can display. Uploads ask first too,
   outside Full auto, and go through Roblox's moderation.

A job stops after two minutes by default, and never runs longer than 200
seconds. Stopping the run stops Blender.

## Safety

A Blender script is a program, and it runs with your permissions. That is why
each job asks first outside Full auto, and why the approval shows the whole
script: read it as you would any script you were about to run.

The agent is told to write only into the job's own folder and not to use the
network, but nothing enforces that; your approval is the safeguard. Roqer does
keep secrets out of Blender's reach: it starts Blender without any environment
variable named like a credential (a key, token, secret, password or cookie) and
without Roqer's own settings.

## Where Roqer keeps things

Both live in Roqer's data folder:

- `blender.json` holds the setting and which Blender to run;
- `blender-jobs` holds one folder per job, with the script, its output, the
  scene it saved and the preview renders. Roqer deletes a job's folder after
  seven days, and keeps only the newest 40, except a job another job is
  continuing from.

## Limits

- One Blender unit becomes one stud, so models are built at their in-game size.
- Colour survives the upload when it is painted as vertex colours or a packed
  image texture. Plain material colours arrive white, so the agent sets those
  colours in Studio after inserting the model.
- Rigging, skinning, UGC accessories and animation are not supported yet.
