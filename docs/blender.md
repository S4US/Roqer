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
  the Assets API with Write access; set it up under **Settings → Roblox → Open
  Cloud** (see [Roblox Open Cloud in Roqer](configuration.md#roblox-open-cloud-in-roqer)).
  Without one, the agent can still model and preview in Blender, but cannot
  upload.

## Turn it on

1. Open **Settings → Blender** in Roqer.
2. If Roqer did not find Blender, click **Choose…** and pick the Blender
   executable (`blender.exe` on Windows).
3. Turn on **Use Blender for modeling**. Roqer turns it on only once that file answers
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

   The preview also shows in the chat's answer. There, the model it pictures
   opens in 3D in the viewer, on Roblox's axes and facing the way it will in
   Studio, with its vertex colours as Studio will show them. Roqer's inspection
   exports that model as a self-contained GLB, which only the viewer reads; the
   agent never sees it. Previews of one output file (`sword.glb` written again
   after a revision) are versions of one model: the answer shows the latest and
   steps back through the others.
4. To use a model, the agent exports it, uploads it to Roblox as a Model and
   inserts it into your place, then checks its size there. An image uploads as
   a Decal, whose image ID a UI element can display. Uploads ask first too,
   outside Full auto, and go through Roblox's moderation.

A job stops after two minutes by default, and never runs longer than 200
seconds. Stopping the run stops Blender.

## Creatures that move

A creature that will be animated, for "Model a low-poly wolf, rig it and make
it walk", is modelled as separate pieces: a body, a head, a tail, and each leg
as an upper and a lower piece. Each piece is its own object, parented to the
piece it hangs from, with its origin at the joint it turns about.

Roblox keeps where each piece is when the model is uploaded, but not where it
turns: every piece arrives hung from one root at its own middle. So Roqer's
check of the exported file reads the pivots while they still exist:

- It lists the pieces as a tree, and gives the agent the joints to rig them
  with: each piece, the piece it hangs from, and its pivot.
- It points out what would rig badly, while the model can still be changed:
  an origin left at a piece's middle or outside both pieces it joins, left and
  right pivots that do not mirror, a mesh named apart from its object (Roblox
  names the part after the mesh), a piece with two materials, and a piece
  parented to nothing.
- Pieces passing into each other at their joints are not reported as
  overlaps, since they are meant to, so a turn opens no gap.

After the upload, the agent rigs the inserted model with those joints
(see [Rigging a model](animation.md#rigging-a-model)). The pivots are measured
from the model's own origin, so they hold wherever it was inserted.

### Creatures that bend

Pieces turn rigidly. A body that must bend along its length, for "Model a
snake and make it slither" or a creature with a long tail, is modelled as one
mesh skinned to bones instead. Roblox keeps the bones and the skin's weights
when such a model is uploaded, so it arrives ready to animate.

Roqer's check of the exported file reads the armature and the weights, and
points out what Roblox would not keep, while the model can still be changed:

- a vertex that follows no bone, which would stay behind;
- a vertex that follows more than four bones, since Roblox keeps the four
  largest;
- more than one mesh on the armature, or more than one armature;
- more than 63 bones, which is as many as Roqer animates;
- a leg with no foot bone, or a foot bone above the ground.

After the upload, the agent has Roqer build the rig around the mesh's bones
(see [Skinned creatures](animation.md#skinned-creatures)).

### Animating in Blender

Most motion is written for Roqer's animation tool directly. For motion that
Blender's own tools make, such as a tail pulled toward a moving target by
inverse kinematics or a head made to track a point, the agent animates the
creature in the scene it was exported from and has Roqer bake it:

- Roqer samples the scene frame by frame, with constraints and inverse
  kinematics applied, and keeps only the keys each joint needs to stay within
  a quarter of a degree of what was sampled.
- The result is an animation file for Roqer's animation tool, which checks,
  previews, builds and publishes it like any other
  ([Animations made in Blender](animation.md#animations-made-in-blender)).
- It works for a skinned creature's armature and for a creature of pieces.
  Only the body as a whole can travel; any other bone or piece only turns.
- At most 60 seconds, sampled as up to 240 keyframes.

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
  scene it saved, the preview renders and the 3D preview. Roqer deletes a job's
  folder after seven days, and keeps only the newest 40, except a job another
  job is continuing from. The 3D view goes with the folder; the still picture
  stays with the chat.

## Limits

- One Blender unit becomes one stud, so models are built at their in-game size.
- Colour survives the upload when it is painted as vertex colours or a packed
  image texture. Plain material colours arrive white, so the agent sets those
  colours in Studio after inserting the model.
- Studio shows a GLB's vertex colours darker and richer than Blender does: it
  reads the stored values as sRGB, where glTF and Blender mean them as linear.
  The 3D view shows them as Studio will; the still picture shows them as
  Blender does.
- A creature is rigged in Studio from rigid pieces modelled in Blender.
  Skinning (a mesh that bends) and UGC accessories are not supported yet, and
  Blender does not animate. Animations are made in Studio instead; see
  [Character animation](animation.md).
