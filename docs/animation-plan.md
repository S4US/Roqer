# Animation and 3D preview plan

Status as of 2026-09-28. Adopted plan; nothing below is implemented yet except
where a step says so. Update each step's status here as it lands.

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

- **The previews card.** It is one card in the Activity card's style.
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
- **What is saved.** A saved run keeps its newest six previews.
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

### Proposed: animations from Blender

Not scheduled; to be confirmed. When Blender is on, it could author or refine
an animation for the standard R15 rig. A worker script would export the
animation as a pose description, and `animation` would check, build, publish
and wire it like any other. Studio would then have one path in, whether the
model writes the poses or Blender does.

What that needs:

- converting Blender's bone rotations (Z-up, with bone rest orientations) into
  joint rotations;
- keyframe reduction, since a 30 fps bake reaches the 240-keyframe limit at
  8 seconds;
- a clear refusal for rigs that are not the standard R15.

The easing measured in step 6 applies when converting Blender's
interpolation.

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
    one-shot's last frame is kept. The top row shows the front three-quarter,
    the bottom row the right side, facing right.
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
  - In the answer, the latest animation plays inline in the previews card, with
    its playback bar underneath, and opens in the full viewer.
  - Chromium keeps only a few WebGL contexts alive, so the inline view mounts
    only while the card is on screen and the viewer is closed; otherwise the
    card shows the contact sheet.
- **The viewer.**
  - It plays any GLB that carries an animation: looping, with play/pause, a
    keyboard-operable scrub bar and the time.
  - Opened in the full viewer it plays at once. Inline, it waits under reduced
    motion.
  - A GLB baked by Blender plays the same way, once a Blender job exports one.
- **Not built: a Blender-rendered sheet.** The box-rig sheet needs no Blender,
  and a Blender sheet waits for the proposed Blender step.

### 10. Guidance, docs and evals

- **Docs.**
  - A new `docs/animation.md` in the style of [blender.md](blender.md).
  - Update the MCP tool list, the README features and the "animation not
    supported" line in `blender.md`.
- **Guidance.** Studio guidance for the agent.
- **Eval.** The goal prompt above becomes an eval scenario with an oracle for
  each "done" condition.

## Deferred

These wait until the steps above prove out:

- Tools for human animators: live sync, face animation, clothing.
- Skinned mesh rigs.
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
