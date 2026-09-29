# Animation and 3D preview plan

Status as of 2026-09-28. Steps 1 to 10 are the adopted plan, and all of them
have landed. Steps 11 to 14 are proposed next and not yet scheduled. Update each
step's status here as it lands.

## Goal

A user can ask Roqer for a character animation in plain words and get a
working result in their place, with evidence they can check. The bar is the
prompt a competing tool uses to show the feature off:

> Make a running animation and set it up in R15.

That run is done only when all of these are true:

- a published animation ID, owned by whoever owns the place;
- the animation wired to player characters;
- a playtest showing the track actually plays;
- a 3D preview of the motion in the chat;
- no motion check left failing.

A run that cannot reach one of these says which, and why. It never claims the
rest.

## Principles

- **Roblox data first.** Animations are built as Roblox `KeyframeSequence`s from
  a compact pose description. Blender is optional: it is used when it is on,
  never required.
- **Numbers before pictures.** Motion checks measure the pose data. Images help
  a model that can see them, but the checks must be enough without them,
  because some Custom-provider models take no images.
- **Trusted rendering only.** Anything the model is shown is rendered by the main
  process or core, never by the chat window. The renderer is untrusted, and
  AGENTS.md allows renderer text to reach the model only through the prompt and
  the mid-run note.
- **Proof, not claims.** Checks, read-back and playtests are recorded as run
  evidence, so the completion check can stop a run that claims success without
  them.

## Steps

### 1. License — done

Roqer is AGPL-3.0-or-later as of S4US/Roqer#27. Left over: the release note for
the next release (0.1.6 and earlier stay MIT), and a decision on a contributor
agreement before the first outside contribution.

### 2. Live test of the Roblox unknowns — done, all four answered yes

`npm run test:spike:animation` (see [tests/README.md](../tests/README.md#animation-spike))
answers four questions on a real Studio before later steps depend on them:

1. Can the stock R15 dummy be built in memory in edit mode?
2. Do temporary animation IDs play, both in edit mode and in a playtest?
3. Does Open Cloud accept a `KeyframeSequence` exported from Studio as an
   Animation asset?
4. Can a just-published animation be read back and played, including while
   moderation is pending?

The upload is opt-in, because it creates a real asset. The script writes a JSON
report and also captures the R15 rest pose, which step 5 uses as reference data.
If a question comes back "no", steps 7 and 8 change before anything is built on
it. Results are recorded below. A fifth question, added for step 5, asks
whether the engine skips the pose compiler's weight-0 placeholders.

### 3. Thumbnails in the answer — implemented

Studio screenshots and Blender previews show in the answer instead of only in
the activity list.

- **The previews card.** It is the Previews tab of the run's Results card,
  beside the Changes and Uploads tabs, in the Activity card's style. A
  finished run opens on it; an earlier run's card folds to its header.
  - The newest picture leads. Up to three earlier ones sit beside it, and past
    that the last tile shows a count of the rest.
  - Each tile says where the picture came from: Studio, Playtest, or Blender ·
    before upload.
  - A caption says when the latest was taken: during the playtest, and after
    which change.
- **The viewer.** It shows the pictures one at a time over the window, with a
  strip of all of them. The arrow keys move through them and Escape closes it.
  The tile that opened it gets the focus back.
- **Playtest pictures.** A screenshot is marked as a playtest picture only when
  a playtest this run started was running. The runner knows that from its own
  start and stop calls, so a playtest someone else started is never claimed.

- **Who makes them.** The main process makes each preview from the image the
  tool returned: a JPEG of at most 640 px on the long edge and at most 128 KiB.
  Neither the model nor the renderer supplies one.
- **Blender previews** are labelled "Blender result, before upload". They are
  recorded as an inspection with no requirement, so they never satisfy the
  completion check.
- **What is saved.** A run shows and keeps up to forty previews, spent on
  distinct things first: the latest picture of each animation, model or
  screenshot, newest first, then earlier versions. A picture past that is
  counted in the answer ("3 earlier pictures not kept"), not dropped silently.
- **Where pictures live.** Each picture is a file in `workspace-pictures`
  beside the chats, named by the SHA-256 of its bytes; a chat keeps only that
  name. The main process serves a picture by name alone and checks the file
  hashes to it. A picture goes once no chat refers to it (its chat was
  deleted), no running run holds it, and it is over ten minutes old. Chats
  saved by earlier builds, with pictures inside, are moved out on load. A
  picture that cannot be stored stays inside its chat, at most six per run.
  Export puts pictures back inline, so an export stands on its own.
- **Validation.** The run engine and the load-time validator both refuse a
  preview that is not a bounded PNG or JPEG data URL.
- **Why no schema bump.** The saved format needed no migration.
  `RunEvidence.imageDataUrl` was already part of workspace schema 3 but had no
  producer. It is optional, so older records still load. Older builds already
  accepted and displayed it, so a downgrade reads the new records too.

### 4. 3D preview for Blender models — implemented

A Blender result opens in 3D in the viewer. The still picture stays in the
answer, and in the viewer it is one switch away ("3D | Picture").

- **What's shown.** Roqer's own inspection of the job's output exports the
  model it measured as one GLB: the same meshes, with modifiers applied and
  hidden objects left out. So the preview is the model Roqer checked, not
  whatever the script wrote. Only the model the chat pictures is kept: the
  first whose still was kept.
- **How it reaches the window.**
  - The GLB stays in the job's folder, named by the model's position alone.
  - The main process checks it before it records an ID, and again each time
    the renderer asks. The file must be at most 24 MiB and well formed. It
    must need nothing outside itself, and no Draco or meshopt compression,
    which the viewer cannot decode. A file that fails is deleted.
  - The renderer asks for it by an opaque ID (`<job id>-<index>`) through one
    IPC call, from a trusted window only. It never sees a path. The model
    never reads the ID either: it travels beside the tool result, like the
    images, not in it.
- **The viewer.** It uses three.js, which loads only when a model is opened.
  - The model stands on a grid floor with a shadow, on Roblox's axes. That is
    half a turn about Y from glTF, so it faces the way it will in Studio. The
    first view is of its front, from the same corner as the still's
    three-quarter view.
  - It can be orbited, zoomed and panned. Buttons turn it left and right and
    reset the view, and an axis gizmo follows the view.
  - Chips over the model give its size in studs, triangle count and object
    count, as the inspection measured them.
  - It is dark in both themes, like the rest of the viewer.
- **One live 3D view at a time.** Chromium limits live WebGL contexts. So the
  answer's card shows stills with a "3D" badge, and only the viewer draws, for
  the picture on screen. It releases its context when it switches to the
  picture, moves on or closes.
- **Expiry.** Blender job folders are cleared after seven days, or once 40
  newer jobs exist. After that the viewer says the 3D preview has expired,
  over the dimmed still, and offers the picture.
- **Fallbacks.**
  - When the window cannot draw 3D, the still shows with a note saying so.
  - A preview that fails to load says so and offers the picture.
  - The 24 MiB cap bounds triangles and textures together.
  - Turns and resets glide, except under reduced motion.
  - Every control is a button.
- **Why no schema bump.** `RunEvidence.modelPreviewId` is optional, so older
  records load unchanged, and older builds ignore it. The load-time validator
  accepts only the ID's shape.
- **Not built yet.** A model built in stages (frame, body, wheels) as one card
  that steps through them. That needs each stage's job kept together, and is
  left for later.

### 5. Pose compiler (core) — implemented

It turns a compact pose description (joint rotations per keyframe, easing,
loop, priority, rig type) into a `KeyframeSequence` description:

- It validates the whole animation before anything touches Studio.
- It knows the R15 joint tree, taken from the step 2 rest pose.
- It is pure TypeScript with no Studio or Blender dependency, so it is
  unit-tested here.

What was built, in `packages/core/src/animation/`:

- **`r15-rig.ts`** holds the rig from the second spike run: 16 parts with
  their sizes, 15 joints with their attachment offsets, and the hip height.
- **`pose-compiler.ts`** takes the description and returns either the whole
  sequence or every problem found, each with its path. It never returns part
  of a sequence.
- **The description.**
  - Joints are named as in the rig ("RightShoulder"). A part name gets an
    error that names the joint that moves it.
  - Each keyed joint takes a rotation in degrees about its parent part's
    axes, applied as `CFrame.Angles` does. An empty pose is the rest pose.
  - Only `Root` takes a position, which offsets the whole body.
  - Easing falls back field by field: joint, then keyframe, then animation,
    then the engine's default (Linear, In).
- **Validation.**
  - The first keyframe is at time 0, and times increase.
  - A joint keyed anywhere is keyed in the first keyframe, so its motion
    starts from a stated pose.
  - Unknown fields are refused, so a misspelt field cannot be silently
    dropped.
  - Limits: 240 keyframes, 60 seconds, ±360° per axis, ±20 studs for `Root`.
    At most 20 problems are listed.
  - Judging the motion itself is step 6's job.
- **The output.**
  - Poses are keyed by part name, the part each joint moves.
  - Each keyframe's poses nest from `HumanoidRootPart` down, and only the
    branches that reach a keyed part are included.
  - A pose on the way to a keyed part is a placeholder: weight 0, identity,
    so it keys nothing itself.
  - CFrames are given as the 12 numbers `CFrame.new` takes.
- **Placeholders observed live.** The engine skips a weight-0 placeholder
  instead of keying its joint to the identity. The spike's fifth question
  showed it against a weight-1 control; see the third run under "Live
  results".

### 6. Motion checks — implemented

Numeric checks on the compiled motion:

- joint limits;
- foot sliding and ground contact for locomotion;
- loop continuity;
- root drift;
- symmetry and phase for gaits;
- velocity spikes.

Thresholds are calibrated against Roblox's own R15 animations, which must pass.
Without that, the thresholds are guesses.

What was built, in `packages/core/src/animation/`:

- **`motion.ts`** samples a compiled sequence and poses the rig.
  - Each part's keyed poses form a track. Between two keys the joint follows
    the earlier key's easing: rotations are slerped and positions lerped.
  - Before a track's first key and after its last, the joint holds that key.
  - The easing curves are Studio's, as measured, including three quirks:
    Constant snaps to the next key (at once for In, halfway for InOut),
    Elastic InOut uses a 0.45 period, and Bounce InOut plays the In shape in
    both halves.
  - Forward kinematics puts every part in the `HumanoidRootPart`'s frame.
- **`motion-checks.ts`** runs the checks at 60 samples a second. Each result
  carries its measurements and a one-line reason.
  - Every animation: joint ranges (hinge direction for elbows and knees), peak
    angular speed, how far the body strays from the root part and whether it
    returns, and a loop's seam.
  - Locomotion only: feet sinking into the ground, how much of the gait has a
    foot down, planted feet sliding forward or sideways, and whether the hips
    swing evenly half a cycle apart.
  - A seam is judged against the joint's own motion either side of it, so a
    stroke that carries on through the seam is not a jump.
  - A foot counts as planted only after it has stayed down for 0.1 s, so a
    foot skimming the ground mid-swing is not taken for sliding.
- **The limits are calibrated.** Each lets Roblox's worst case pass with a
  margin, and the code notes that worst case beside the limit.
  `npm run test:calibrate:animation` ([tests/README.md](../tests/README.md#animation-calibration))
  re-checks all of it against Studio. The run is recorded under
  "Live results".
- **For step 7.** A single Linear segment that swings well past 90° plays
  differently from the model (see "Live results"). The tool should split big
  swings across more keyframes.

### 7. Studio `animation` tool — implemented

One public tool, with every layer in step:

- schema, handler, `RobloxStudioTools`, routing and the plugin;
- the edition allowlists and desktop tool risk;
- generated schemas, on-demand help, activity labels;
- drift tests and a live test.

It builds the `KeyframeSequence` in Studio and previews it on an in-memory
dummy. Safety rules:

- **All or nothing.** It checks the whole pose before touching Studio and
  leaves nothing behind on failure: no temporary dummy, temporary ID or
  playtest.
- **Right target.** It routes `instance_id` end to end.
- **No overwrites.** It refuses to rebuild an animation that was changed in the
  Animation Editor since Roqer built it, and refuses to replace an
  `AnimationId` that changed underneath it.
- **Undo.** Changes are recorded in `ChangeHistoryService`.
- **Readable approvals.** The approval prompt summarises the pose instead of
  showing JSON.
- **Inspector edition.** It gets no write path.

What was built:

- **Two actions.**
  - `check` compiles the pose description and runs the motion checks in core,
    without Studio. The desktop rates it a read, so it needs no approval.
  - `build` does the same, and refuses while a check fails that the caller did
    not name in `waive`. It then has the plugin preview the sequence, and
    writes it only if Studio played it within 1.5° and 0.05 studs of the
    checked model. The write goes into `parent`, named after the animation, as
    one ChangeHistory step, and is read back.
- **The preview dummy is not in memory.** A probe found that an Animator never
  loads a track on a dummy outside the DataModel, even inside a `WorldModel`.
  So the dummy lives in a temporary Workspace folder. It is created outside
  any ChangeHistory recording, which leaves no undo step, and it is destroyed
  on every path. The sequence is registered as a temporary clip while still
  detached.
- **No overwrites.**
  - Each build stamps its content revision on the sequence
    (`RoqerAnimationRevision`), and a rebuild needs that revision as
    `expected_revision`.
  - A rebuild is refused when the target was not built by the tool, or when
    its content no longer matches its stamp, as after an edit in the
    Animation Editor.
  - The rule about an `AnimationId` that changed underneath moves to step 8,
    where `AnimationId`s are first written.
- **One compiler rule from step 6.** A joint may turn at most 90° between its
  keys, unless the earlier key snaps (Constant). Past 90°, Studio's playback of
  Linear keys drifts from the model, and past 180° a turn goes the short way
  round.
  Since 2026-09-29 the compiler keeps the rule itself: a longer turn is split
  into in-between keys of that joint along the short way round, placed where
  the key's easing reaches them. Turns of 175° or more, whose way round is
  unclear, and Elastic or Bounce turns, whose overshoot in-betweens lose, are
  still refused.
- **Layers.**
  - Core: the schema (with the tool guide's "Character animation" section),
    HTTP routing, `RobloxStudioTools.animation` and
    `animation/animation-tool.ts`.
  - The plugin: `AnimationHandlers.ts`, whose two endpoints the inspector build
    refuses.
  - The desktop: its risk table, activity labels, a summary in words on the
    approval card, the operation guidance, and a change card with
    verification evidence for each build.
  - The catalog budget was raised by this one tool's size.
- **Tests.**
  - Unit tests for the tool flow, with the plugin stubbed.
  - Desktop tests for the risk, summaries and evidence.
  - `tests/animation-tool.mjs` exercises all of it against a live Studio, in
    the full managed suite.

### 8. Publish and wire up — implemented

- **Publish.** `export_rbxm` plus `upload_asset` with type `Animation`, with an
  owner check: the animation must belong to the place's owner, user or group.
- **Wire up.** The new ID goes onto player characters (the Animate script or a
  small loader), and a playtest confirms the track plays.
- **Fallbacks.**
  - No Open Cloud key: build and test locally with a temporary ID, and explain
    how to publish.
  - A group-owned place with a personal key: stop before uploading.
  - Moderation pending or rejected: report it; never claim success.

What was built, as three more actions of the `animation` tool:

- **`publish`.**
  - It uploads only a sequence that `build` wrote and nobody has edited since.
  - It uploads only as the place's owner. A group place needs the group as
    creator, a user place that user. A mismatch stops before anything is
    uploaded.
  - An unpublished place has no owner yet, so the configured creator is used,
    and the result says to publish the place under the same owner.
  - After the upload it reads the asset back from Roblox and compares its
    content revision with what was built.
  - A rejected animation is reported as not published. One still in review is
    published but not approved, and the result says so.
  - Without an Open Cloud key it uploads nothing and says how to publish.
    `verify` still tests the animation unpublished.
  - The desktop rates `publish` irreversible, so it always asks first.
- **`wire`.**
  - It keeps one loader Script, `ServerScriptService.RoqerAnimate`, whose code
    never changes; each slot's animation ID is one of its attributes. The first
    wire installs it, so later wiring changes data, not code.
  - At spawn, the loader sets that slot's Animation IDs on each character's
    default Animate script. A probe showed that Animate plays the new ID
    (see "Live results").
  - Replacing a slot's ID needs the current one as `expected_id`, so an ID
    someone else changed is never overwritten. This is step 7's
    "`AnimationId` that changed underneath" rule.
  - A loader whose code was edited is left alone.
  - Each wire is one undo step.
- **`verify`.**
  - It needs a running playtest, and runs on the client.
  - It plays the animation on the player's character, from the pose
    description or from the published `animation_id`, and samples the
    animated joints on the Animator's own clock. It passes within 2° of the
    checked model.
  - Given a slot and an ID, it also confirms that the character's Animate slot
    holds the ID, and whether Animate is playing it.
  - The desktop records it as playtest evidence.
- **Tests.**
  - `tests/animation-tool.mjs` covers wiring, both kinds of verification, and
    the publish refusal without a key on a live Studio, with nothing uploaded.
    It wires Roblox's own wave animation.
  - With `ROQER_ANIMATION_UPLOAD=1` and a key, it also publishes one real test
    animation, reads it back, and verifies the published copy.

### 9. Animation playback and contact sheet — implemented

- **Playback.** The step 4 viewer plays the rig from the compiled pose data (no
  Blender needed), or a GLB with the animation baked in when Blender made it.
  It has play/pause and a scrub bar.
- **Contact sheet.** The sheet the model checks is a grid of frames rendered in
  trusted code, by a small box-rig renderer in core using the existing PNG
  encoder, or by Blender when it is on. It is never rendered by the chat
  window.

What was built:

- **The figure** (`animation/rig-meshes.ts`, `animation/box-rig.ts`).
  - The preview draws the stock R15 rig's real meshes, in one light grey.
  - The first `build` has the plugin build the stock dummy in memory and read
    each body part's mesh through `EditableMesh`, scaled to the part's size.
    The dummy's own dynamic head cannot be read ("no permission to load
    asset"), so the head is Roblox's classic head, which ships with Studio
    (`rbxasset://avatar/heads/head.mesh`).
  - The meshes are validated, each triangle turned to face the way its
    normals do, and cached under `~/.robloxstudio-mcp/cache`. Nothing of
    Roblox's is committed.
  - `check` never reaches Studio. Until a build has read the meshes, the
    preview draws a generated stand-in (rounded boxes at the stock part
    sizes), and the result says which rig it drew.
- **The contact sheet** (`animation/contact-sheet.ts`).
  - A software rasteriser with a depth buffer and smooth shading draws that
    figure, posed by core's own sampler, at the same scale in every frame. The
    background is dark, with a soft shadow under the body.
  - There are five moments across one pass: a loop's wrap is left out, and a
    one-shot's last frame is kept. The top row shows the front three-quarter.
    The bottom row looks straight at the front, where arm and head motion
    reads. For a gait (`locomotion: true`) it looks at the right side instead,
    facing right, where strides and foot plants read.
  - `check` and `build` return it as an image, with a note in the result on how
    to read it. A model that sees images can check the motion; the numeric
    checks stay enough without it.
- **The 3D preview** (`animation/rig-glb.ts`).
  - The same figure as one self-contained GLB, every joint's rotation and
    translation sampled 30 times a second from the same sampler.
  - It travels as a host-only resource block. The MCP transport strips it, so
    MCP clients never receive it; only the desktop's HTTP surface keeps it.
- **The desktop.**
  - The main process validates the GLB with step 4's inspector and keeps it in
    a job folder beside Blender's, under the same id shape. So it is served,
    checked again and expired exactly as a Blender preview is, and older
    builds still load the records.
  - In the answer, the latest animation plays inline in the Previews tab, with
    its playback bar underneath, and opens in the full viewer.
  - Chromium keeps only a few WebGL contexts alive, so the inline view mounts
    only while the card is on screen and the viewer is closed; otherwise the
    card shows the contact sheet.
  - Previews of one animation, by name, are versions of one picture rather
    than a tile each. The card and the viewer step through them ("Version 3 of
    6"), and the latest leads. Blender previews of one output file group the
    same way.
- **Aim posing** (`animation/pose-compiler.ts`). A real run showed the agent
  failing to work out the combined Euler rotation that a wave needs (shoulder
  `[90, 0, 90]`). Poses can now say `aim: [right, up, forward]` for a shoulder
  or hip, with `bendToward` to set which way the limb folds, and `bend:
  degrees` for an elbow or knee. They compile to the same rotations.
- **Recipes** (`apps/desktop/agent/skills/roblox-animation-vfx/references/character-animation.md`).
  Wave, idle, walk, run and jump are written with `aim` and `bend`.
  `animation-recipes.test.ts` compiles each one straight from the reference,
  runs it through the motion checks and checks its gesture: the wave's hand
  above the head, the gaits' opposite arms and legs, the jump's raised arms.
- **The viewer.**
  - It plays any GLB that carries an animation: looping, with play/pause, a
    keyboard-operable scrub bar and the time.
  - Opened in the full viewer it plays at once. Inline, it waits under reduced
    motion.
  - A GLB baked by Blender plays the same way, once a Blender job exports one.
- **Not built: a Blender-rendered sheet.** The box-rig sheet needs no Blender,
  and a Blender sheet waits for skinned models (step 13).

### 10. Guidance, docs and evals — implemented

- **Docs.**
  - [animation.md](animation.md) is written for users, in the style of
    [blender.md](blender.md).
  - The MCP server guide, the README features and documentation list, and
    `blender.md`'s limits (which said animation was not supported) now point
    to it.
- **Guidance.**
  - The tool guide, the desktop guidance and the recipe reference came with
    step 9.
  - The `roblox-studio-mcp` skill now lists `animation` and sends the agent to
    the recipes.
- **Eval.** `T15-animation-run` in `apps/desktop/eval` is the goal prompt,
  with one added sentence saying where to keep the sequence.
  - Its oracle checks each "done" condition from Studio or from the host's
    evidence:
    - `MarketplaceService` reports the asset in the `run` slot as an Animation
      owned by the place's creator, and this run published it;
    - a playtest played the published asset with the slot holding it;
    - a 3D preview was shown;
    - the last build's checks all passed and ran as a gait.
  - For that, the harness now passes the run's evidence to oracles. It keeps
    tool images and 3D previews as the app does, and trajectories record
    pictures by size.
  - The build's evidence now also says whether the motion was checked as a
    gait.
  - The first model run's bridge had no Open Cloud key. The agent built a run
    that passed every check and played it as a temporary clip. `publish` then
    refused, so nothing was wired, and the oracle failed it.
    - The harness now checks for the key before a T15 run, as it already did
      for Blender runs.
    - That run also called `verify` with only the built sequence's path. It now
      answers that `verify` needs the checked animation.
  - With a key, the second run passed in 11 calls and 81 s:
    - it checked, built, published as the place's owner, and wired the run
      slot;
    - it played the published asset in a playtest with the slot holding it.
  - Three of its calls repaired argument mistakes: `verify` without the
    animation, `verify` with `expected_id` for `animation_id`, and
    `solo_playtest` without `mode`. The schema now says what `verify` needs.
  - The agent noted that the character stood still in its playtest. `verify`
    plays the clip directly and reads the slot; it does not drive the
    character. A manual playtest afterwards confirmed the published run plays
    while the player moves.

## Proposed next: R6 and custom rigs

Proposed on 2026-09-28, after the goal above was met; not yet scheduled.

When this was proposed, everything assumed the stock R15 rig: the rig table,
the aim and bend conventions, the checks, the preview meshes, and wiring to
the default `Animate` script. Step 11 has since added R6 (see below); no rig
Roqer did not get from Roblox exists yet.

Each new rig must meet the goal's bar:

- a published animation the place's owner owns;
- wired to whatever uses it;
- seen playing in a playtest;
- a 3D preview;
- no motion check left failing.

The steps are ordered so that each rests on the one before:

1. R6 reuses nearly everything.
2. Rigid-part creatures bring a rig read from the model.
3. Skinned creatures add bones.
4. Blender-authored motion works on all of them.

As in step 2, every step starts with a live test of what Roblox actually does.
Nothing is built on an unconfirmed assumption.

### 11. R6 characters — implemented 2026-09-29, live checks pending

Built ahead of its live test, from the Motor6D C0 and C1 values every R6
character has; the items below marked live are what
`tests/animation-tool.mjs` now checks against Studio and has not yet run.

- Done: `r6-rig.ts`; `rig: "R6"` in the compiler, with poses converted from
  body space so `aim` and `rotation` mean the same on both rigs, and a
  refusal naming the R15 joints R6 lacks; ground contact on the legs' bottom
  corners; gait symmetry measured in body space; block previews; an R6
  preview dummy in the plugin; verify refusing a character of the other rig;
  tested R6 walk and wave recipes.
- Not calibrated: foot sliding is reported as not checked on R6, never as
  passed, until Roblox's own R6 walk and run are measured as step 6 did for
  R15.
- Live: the rig table against an R6 dummy's Motor6Ds; an R6 build playing as
  checked on the R6 preview dummy; the R6 `RightGripAttachment`.
- Not done: reading the place's avatar type (the agent reads the playtest
  character's `RigType` or the `StarterCharacter`), a loader keeping one ID
  per rig and slot for places that let players choose, and eval T16.

The original proposal follows.

**Why.** Many places, combat games especially, set their avatar type to R6. An
R15 animation does not play on an R6 character. Today the agent's best answer
on such a place is a refusal. Worse, it could wire an animation that never
plays, and nothing would show it.

**How R6 differs.** The live test will confirm each of these:

- **Parts.** Six parts and the `HumanoidRootPart`: `Head`, `Torso`,
  `Left Arm`, `Right Arm`, `Left Leg`, `Right Leg`. The names contain spaces.
- **Joints.** Six joints: `RootJoint`, `Neck`, `Left Shoulder`,
  `Right Shoulder`, `Left Hip`, `Right Hip`. There is no waist, elbow, wrist,
  knee or ankle. So `bend` has nothing to act on, and a gait's legs swing
  rigid.
- **Joint frames.** The joints' frames are turned differently from R15's.
  Unless the compiler converts, the same `rotation` would mean a different
  motion on each rig.
- **Animate script.** R6 characters get their own default `Animate` script.
  Two things are unknown:
  - whether it has the same slots;
  - whether the `RoqerAnimate` loader's approach reaches it.

**Work.**

- **Live test first.**
  - Build an R6 dummy with `CreateHumanoidModelFromDescription` and
    `Enum.HumanoidRigType.R6`.
  - Record its joint kind and rest offsets.
  - Play a sequence keyed by part name on it, in edit mode and in a playtest.
  - Read an R6 playtest character's `Animate` script and slots.
  - Find how Studio reports the place's avatar type: R6, R15, or the player's
    choice.
- **Rig and compiler.**
  - An `r6-rig.ts` rig table from that run, and `rig: "R6"` in the pose
    compiler.
  - `aim` works on shoulders and hips in the same body-space directions as on
    R15, so a pose written as where the limbs point means the same on both
    rigs.
  - `bend` on R6 is refused, and the message says why.
- **Checks.**
  - R6 joint ranges.
  - Ground contact and foot sliding measured at the bottom of each leg.
  - Calibrated against Roblox's own R6 walk and run, as step 6 did for R15.
- **Preview.** R6 parts are blocks, so the contact sheet and the 3D viewer can
  draw the figure as boxes without mesh data.
- **Wire and verify.** Wiring and verifying work on R6 characters, in the way
  the live test shows works.
- **Choosing the rig.** The agent reads the place's avatar type before it
  animates, and never wires an animation for a rig its players do not use:
  - an R6 place gets R6;
  - an R15 place gets R15;
  - a place that lets players choose needs both. The loader then keeps one
    attribute per rig and slot.
- **Recipes.** R6 idle, walk, run, jump and wave go in the skill reference,
  tested like the R15 recipes.
- **Eval.** T16 gives "Make a running animation and set it up in R6." to a
  place set to R6.

**Done when** T16 passes, and a manual R6 playtest shows the run playing while
the player moves.

### Weapons — implemented 2026-09-29, live checks pending

A combat animation moves the weapon as well as the arm. Roblox's `RightGrip`
weld cannot be animated, so the rig gains one optional joint, `Weapon`: a
`Motor6D` from the right hand to a part named `BodyAttach`, with C0 at the
hand's `RightGripAttachment` and C1 the identity, which the game swaps in on
equip (the skill has the script). This is the first joint whose frame is
turned in its parent, so the motion model now follows C0 and C1 rotations,
and the compiler takes a pose in the parent part's axes and converts it.

- The joint is optional: it is previewed, drawn and verified only when an
  animation keys it. The preview dummy always carries a stand-in motor built
  from its own `RightGripAttachment`.
- Unconfirmed until `tests/animation-tool.mjs` runs against Studio: the rig
  table's grip position (0, -0.15, 0), and that the preview dummy's Animator
  drives a `Motor6D` beside its `AnimationConstraint` joints. The suite checks
  both.
- Two more props followed: `OffHand`, the left hand's grip (`OffHandAttach`
  at `LeftGripAttachment`), and `Sheath`, worn at the left hip (`SheathAttach`
  at a fixed C0 the game sets, since no stock attachment sits there). Core
  now sends the preview the motors to build, so the plugin names no prop.

### Reaching a point — implemented 2026-09-29

Combat animation plants feet and puts hands on hilts, which the direction
`aim` gives cannot say. `aimAt` gives a shoulder or hip a point, solved at
compile time against the body as it plays at that key: two-bone IK on R15
(the elbow or knee bent to reach, a leg's ankle laying the foot flat), and on
R6 the rigid limb pointed through it. Joints interpolated on their own let a
planted foot slide or sink between keys, so a limb held on one point from
one key to the next is solved again every 1/30 s between them; the recipe
test measures a planted ankle within 0.05 studs. Everything downstream sees
ordinary keys: the checks, the preview and Studio's playback.

Two-handed holds followed: `grip` on `LeftShoulder` keeps the left hand on
the weapon's handle, solved after every `aimAt` so it follows a placed right
arm, and every 1/60 s between grip keys, each solve preferring the last one's
elbow so the arm never flips. A fast two-handed swing keeps the hand within
0.05 studs of the handle.

### 12. Creatures made of rigid parts — proposed

Animals and monsters that Blender models as separate pieces (a body, a head,
four legs, a tail), hinged at joints in Studio. Many Roblox creatures are built
this way. It needs no skinning, and it suits the low-poly style that Blender
modeling already makes.

**Work.**

- **Live test first.**
  - Check whether an uploaded Blender model keeps each piece's name and pivot.
    The joints go at the pivots.
  - Check that a sequence keyed by part name drives `Motor6D` joints the tool
    creates, on a model with a `Humanoid` and on one with an
    `AnimationController`.
- **Rigging.**
  - The Blender recipe names each piece and puts its origin at its joint.
  - A new build step joins the inserted pieces with `Motor6D` joints under a
    root part, adds an `Animator` (under a `Humanoid` for a creature that walks
    with Humanoid movement, otherwise an `AnimationController`), and reads the
    joint tree back.
  - It is one undoable step, like `build`.
- **A compiler for any rig.**
  - The rig is read from Studio instead of a fixed table: its parts, joints and
    rest offsets.
  - Poses give `rotation` by joint name.
  - `aim` and `bend` need to know which joints make a limb, so a rig declares
    its limbs (hip, knee and foot chains) and its feet. A rig with no
    declarations takes rotations only.
- **Checks.**
  - Joint ranges come from the rig's declarations. A joint without one is
    reported as not checked, never as passed.
  - Ground contact and foot sliding use the declared feet.
  - Gait symmetry becomes a declared pattern of leg phases, because two legs
    are no longer the only case:
    - a four-legged walk or trot moves diagonal pairs together;
    - a gallop does not.
- **Preview.** The contact sheet and the 3D viewer draw the creature's own
  meshes from the Blender export, posed by the compiled data.
- **Wiring.** A creature has no default `Animate` script. Wiring puts a small
  fixed loader on the model, with one attribute per state (idle, walk, run,
  attack):
  - speed picks between idle, walk and run;
  - an attribute or event plays a one-shot action such as an attack;
  - the loader's source is fixed and read back, like `RoqerAnimate`.
- **Verify.**
  - Play each animation on the creature in a playtest.
  - Move the creature (`Humanoid:MoveTo`) and confirm the loader switches to
    the walk and the run. T15 could not check this for players.
- **Eval.** T17 asks: "Model a low-poly wolf in Blender, rig it, give it idle
  and walk animations, and make it walk around." It needs `--blender`.

**Done when** T17 passes, including the loader switching tracks as the wolf
moves.

### 13. Skinned creatures — proposed

Some creatures bend along their skin instead of hinging between pieces: a
snake, a tentacle, a dragon's neck. That needs a Blender armature with skin
weights. The model is exported as a skinned mesh, which Roblox imports as a
`MeshPart` with `Bone` instances, and it is animated by poses keyed by bone
name.

**Unknowns to test live before any code:**

- whether an Open Cloud Model upload keeps the armature, bones and weights, or
  only Studio's own importer does;
- Roblox's limits on bones and on influences per vertex, and what happens past
  them;
- whether a `KeyframeSequence` the tool builds, keyed by bone name, drives the
  bones as the part-name one drives joints;
- how Blender's bone axes (Z-up, with a rest orientation per bone) convert to
  Roblox bone frames.

**Work, once those are answered.**

- **A Blender rigging recipe.**
  - An armature from a template per body plan: biped, four-legged, snake,
    winged.
  - Automatic weights.
  - The worker checks the weights itself rather than taking the script's word:
    every vertex weighted, within Roblox's influence limit.
- **The rig.** The rig read from Studio is the bone tree. The rest of step 12
  applies to it: declared limbs and feet, checks, the loader, verify.
- **Preview.** The viewer plays a GLB with the skin. For the contact sheet,
  there are two options, to decide at the time:
  - a Blender render;
  - a skinned renderer in core.

**Done when** a skinned creature passes T17's checks.

### 14. Animating in Blender — proposed

This is for motion that is easier to make with Blender's tools (inverse
kinematics, constraints, the creature's own armature) than to write as poses.

- Blender bakes the action, and a worker script exports it as a pose
  description.
- `animation` then checks, builds, publishes and wires it like any other.
  Studio keeps one path in, whether the model writes the poses or Blender does.
- It covers R15, R6 and the custom rigs of steps 12 and 13, since the export
  goes through the same rig description.

What that needs:

- converting Blender's bone rotations into joint rotations for each rig;
- reducing keyframes, since a 30 fps bake reaches the 240-keyframe limit at
  8 seconds;
- a refusal when the Blender rig's joints do not match the Studio rig's;
- the easing measured in step 6, to convert Blender's interpolation.

## Deferred

These wait until the steps above prove out:

- Tools for human animators: live sync, face animation, clothing.
- Motion capture.
- `CurveAnimation` output.

## Live results

Record each spike or model-driven run here: date, Studio version, what was run,
and the answer to each question.

### 2026-09-28: first spike run, Studio 0.740.19

Run with the upload on, on an unpublished baseplate.

- **Open Cloud upload: yes.** A 1.8 KB `KeyframeSequence` exported with
  `export_rbxm` became an Animation asset in about two seconds. Its first status
  read already said moderation Approved.
- **Read-back: yes.** `GetKeyframeSequenceAsync` returned the new animation at
  once, with the 3 keyframes and 21 poses that were built.
- **Temporary IDs: they register.** `AnimationClipProvider:RegisterAnimationClip`
  and `KeyframeSequenceProvider:RegisterKeyframeSequence` both returned the same
  bare 32-digit hex string, in edit mode and on both playtest peers. Whether that
  string plays as an `AnimationId` is still open.
- **Playback: not measured.** The probe looked for `Motor6D` joints and found
  none. That held for the dummy from `CreateHumanoidModelFromDescription` and
  for the playtest character. These rigs most likely use `AnimationConstraint`
  joints instead.
- **Dummy in edit mode: it builds** (R15, 16 parts, an Animator), but its joints
  went unrecorded for the same reason.

What changes:

- The spike now measures either joint kind, records which kind a rig has and
  tries each form of the temporary ID. The second run answers the rest.
- The pose compiler (step 5) and the motion checks (step 6) must not assume
  `Motor6D`. They take joint data from whichever kind the rig has.

### 2026-09-28: second spike run, Studio 0.740.19

The same setup, with the probe that measures either joint kind. All four
questions came back yes.

- **Dummy in edit mode: yes.** `CreateHumanoidModelFromDescription` with a
  default `HumanoidDescription` builds an R15 rig at once: 16 parts, an
  Animator, and 15 joints. Every joint is an `AnimationConstraint`; there is no
  `Motor6D` on it or on the playtest character.
- **Temporary IDs: yes.** The bare string `RegisterAnimationClip` returns works
  as an `AnimationId` exactly as returned; no `active://` prefix is needed. It
  played in three places:
  - in edit mode, stepped by hand with `Animator:StepAnimations`, the right
    shoulder turned 40°;
  - in a playtest on the client, 39°;
  - on the server, 63°.
- **Open Cloud upload: yes.** It was approved on the first status read again.
- **Published read-back: yes.** The new asset read back at once with its 3
  keyframes and 21 poses. It played in edit mode (48°), on the playtest client
  (72°) and on the server (66°). This was in an unpublished place, with the asset
  owned by the signed-in Studio user.

What this settles:

- A `KeyframeSequence` keyed by part name drives `AnimationConstraint` joints as
  it drives `Motor6D` ones. The pose compiler can target part names and never
  write joint objects.
- The animation tool (step 7) can preview on an in-memory dummy in edit mode
  with a temporary ID and `StepAnimations`, without starting a playtest.
- The publish path in step 8 works. The owner check for group-owned places is
  still untested, because this place was unpublished.

Rest pose of that dummy, for the pose compiler. Each joint's offsets are its
two attachments' positions in the parent and the child part, in studs. Every
attachment rotation is the identity.

| Joint | Parent → child | Offset in parent | Offset in child |
| --- | --- | --- | --- |
| Root | HumanoidRootPart → LowerTorso | (0, −1, 0) | (0, −0.2, 0) |
| Waist | LowerTorso → UpperTorso | (0, 0.2, 0) | (0, −0.849, 0) |
| Neck | UpperTorso → Head | (0, 0.849, 0) | (0, −0.576, 0) |
| LeftShoulder | UpperTorso → LeftUpperArm | (−0.972, 0.598, 0) | (0.501, 0.419, 0) |
| RightShoulder | UpperTorso → RightUpperArm | (0.972, 0.598, 0) | (−0.501, 0.419, 0) |
| LeftElbow, RightElbow | UpperArm → LowerArm | (0, −0.355, 0) | (0, 0.275, 0) |
| LeftWrist, RightWrist | LowerArm → Hand | (0, −0.532, 0) | (0, 0.132, 0) |
| LeftHip | LowerTorso → LeftUpperLeg | (−0.5, −0.2, 0) | (0, 0.471, 0) |
| RightHip | LowerTorso → RightUpperLeg | (0.5, −0.2, 0) | (0, 0.471, 0) |
| LeftKnee, RightKnee | UpperLeg → LowerLeg | (0, −0.449, 0) | (0, 0.413, 0) |
| LeftAnkle, RightAnkle | LowerLeg → Foot | (0, −0.596, 0) | (0, 0.106, 0) |

Part sizes in studs (x × y × z), with HipHeight 2.19:

- HumanoidRootPart 2 × 2 × 1.
- LowerTorso 1.99 × 0.40 × 1.00; UpperTorso 1.94 × 1.70 × 1.00.
- Head 1.16 × 1.18 × 1.16.
- UpperArm 1.00 × 1.24 × 1.00; LowerArm 1.00 × 1.12 × 1.00; Hand 0.98 × 0.32 × 1.03.
- UpperLeg 0.99 × 1.36 × 0.97; LowerLeg 0.99 × 1.30 × 0.97; Foot 1.01 × 0.31 × 1.00.

### 2026-09-28: third spike run, Studio 0.740.19

Run without the upload, to answer the fifth question: does the engine skip a
weight-0 `Pose` that only keeps the hierarchy? The pose compiler writes the
poses between the root and a keyed part that way.

The probe keys the right shoulder at 60° at 0 s and 2 s. At 1 s the upper arm
is only the parent of a keyed elbow: a weight-0 identity pose in one sequence
and a weight-1 identity pose in the control. Each was played on the edit-mode
dummy and stepped by hand, measuring the shoulder from its rest.

| Time | Weight-0 placeholder | Weight-1 control |
| --- | --- | --- |
| 0.5 s | 60° | 30° |
| 1.0 s | 60° | 0° |
| 1.5 s | 60° | 30° |
| 2.0 s | 60° | 60° |

- **Answer: yes.** The weight-0 pose keys nothing, and the shoulder holds its
  60° keys throughout. The control returns to rest at 1 s, which shows the
  measurement would have seen a keyed identity.
- **A probe bug on the way.** The first attempt measured from the joint's
  `Transform` before playing, and came back "inconclusive". A stopped track
  leaves its last pose on the joint until something else moves it, so that
  reading was stale. The probe now measures from the identity, the joint's
  true rest.

What this settles:

- The pose compiler's placeholders are safe. A keyframe can key a hand without
  pinning the arm, torso or root above it.
- Step 7 must measure from the identity, not from whatever pose a previous
  preview left on the joint.

### 2026-09-28: motion check calibration, Studio 0.740.19

`npm run test:calibrate:animation`, run six times while the checks were
calibrated; the last run passed every assertion. The default R15 `Animate`
script listed 27 animations. `mood` was skipped because it moves the face, not
the body joints, and the other 26 were measured.

- **Sampler.** Core's joints matched Studio's to within 0.27° on all 26
  (worst: wave). Playing each as a registered temporary clip, as a preview
  would, came within 0.11° of the published asset.
- **Easing.** Every style and direction matched to within 0.006°, once three
  quirks were measured:
  - Constant snaps to the next key at once for In and halfway for InOut, and
    holds until the next key for Out.
  - Elastic InOut uses a 0.45 period, against 0.3 for In and Out.
  - Bounce InOut plays the In shape in both halves.
  - Legacy Cubic has In and Out swapped. CubicV2, Bounce and Elastic do not,
    which contradicts the Blender Animations plugin's assumption that every
    style is swapped.
- **Joint conventions.** Knees bend negative about X (down to −143° in the
  run), and elbows positive (up to 123° in the swim).
- **Roblox's worst cases**, against which the limits were set:
  - peak joint speed: 2,098°/s (jump, knee);
  - a loop seam 4.4 times the joint's own motion (swim, wrist; its shoulders
    jump 19° at the seam);
  - planted-foot wander: 0.13 studs (walk);
  - a foot on the ground for 64% of the gait (run);
  - hip swing ratio: 0.73 (walk);
  - body excursion: 0.81 studs (climb).
- **Two differences stay unexplained**, both inside the sampler's 1° and 0.1
  stud bound and far below any check's resolution:
  - Linear keys built by the pose compiler turn by a normalised lerp, not a
    slerp. That is 0.9° off over a 90° segment and 7.4° off over 175°, and it
    held for every arc and segment length probed. Roblox's own Linear keys,
    including toolslash's 80° swings, follow slerp, whether played published
    or registered.
  - Root offsets in 10 of Roblox's animations play scaled against the keys
    read with `GetKeyframeSequenceAsync`: by 1.074 for walk, run, idle, jump,
    fall, climb, swim and swim idle, and by 1.104 for wave. Every one has
    `AuthoredHipHeight = 2`, so that property does not explain it. A compiled
    Root offset plays as written.

What this settles:

- The motion checks measure what Studio plays, and Roblox's own animations pass
  them.
- Step 7 should split a swing of more than 90° across several keyframes. The
  motion is then smoother either way, and the model matches Studio closely.

### 2026-09-28: preview probe, Studio 0.740.19

A one-off probe for step 7's preview design, run through `execute_luau` on the
managed Studio. Each case played a 0 to 60° shoulder swing and stepped it by
hand to 0.5 s.

- **Unparented dummy:** the track never loaded (length 0), and the shoulder did
  not move.
- **Dummy in an unparented `WorldModel`:** the same.
- **Dummy in a temporary Workspace folder:** the shoulder read 30.0°, as
  expected.
- **Undo history:** creating and destroying the folder outside a recording
  left `GetCanUndo` false.
- **Detached sequence:** a `KeyframeSequence` that was never parented
  registered and played.

### 2026-09-28: wiring probe, Studio 0.740.19

A one-off probe for step 8's wiring. A server Script in ServerScriptService
set the Animation IDs of each character's `Animate.idle` slot at spawn, to
Roblox's wave animation (507770239). In a solo playtest, the client then read:

- **Replication:** both idle Animations under the character's Animate script
  held the wave's ID. The server's change had replicated to the client.
- **Playback:** the wave was among the Animator's playing tracks, so the
  default Animate script played it as the idle.

So a loader that sets Animate's slots at spawn wires an animation to every
character, with no copy of Roblox's Animate script in the place.

### 2026-09-28: first publish through the tool, Studio 0.740.19

`tests/animation-tool.mjs` with `ROQER_ANIMATION_UPLOAD=1`, on an unpublished
baseplate, publishing as the signed-in user.

- **Upload:** `publish` uploaded the built test wave as an Animation asset.
  Moderation said Approved on the first read.
- **Read-back:** the asset Roblox served back had the same content revision as
  the build: every keyframe, pose, CFrame, easing, loop and priority survived
  the round trip.
- **Playback:** in a solo playtest, `verify` played the published copy on the
  character within 0.06° of the checked model.
- **Owner check:** only the unpublished-place path ran. The group-place refusal
  is covered by unit tests, not yet by a group-owned place.
