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
it. Results are recorded below.

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

### 4. 3D preview for Blender models

- **What's shown.** The Blender job's own verification pass exports a preview
  GLB, so the preview is the model Roqer checked, not whatever the script wrote.
- **How it reaches the window.** The main process keeps the file and the
  renderer asks for it by an opaque ID through one new IPC call. The file is
  size-capped and must be a self-contained GLB with no external fetches. The
  renderer never sees a path.
- **The viewer.** three.js, loaded only when a preview is on screen:
  - orbit, zoom, pan and reset;
  - a grid floor, light and shadow, and both themes;
  - an overlay with size in studs, triangle count and part count.
- **One live 3D view at a time.** Chromium limits live WebGL contexts, so
  off-screen and older previews show the step 3 thumbnail until clicked.
- **Stages.** A model built in stages (frame, body, wheels) is one card that
  steps through them.
- **Labels and expiry.**
  - The card says "Blender result, before upload".
  - Blender job folders are kept for seven days (newest 40). After that the
    card says the 3D preview has expired and keeps the still image.
- **Fallbacks.**
  - A still image when WebGL is unavailable.
  - Caps on triangles and texture size.
  - No autoplay under reduced motion.
  - Keyboard access.

### 5. Pose compiler (core)

It turns a compact pose description (joint rotations per keyframe, easing,
loop, priority, rig type) into a `KeyframeSequence` description:

- It validates the whole animation before anything touches Studio.
- It knows the R15 joint tree, taken from the step 2 rest pose.
- It is pure TypeScript with no Studio or Blender dependency, so it is
  unit-tested here.

### 6. Motion checks

Numeric checks on the compiled motion:

- joint limits;
- foot sliding and ground contact for locomotion;
- loop continuity;
- root drift;
- symmetry and phase for gaits;
- velocity spikes.

Thresholds are calibrated against Roblox's own R15 animations, which must pass.
Without that, the thresholds are guesses.

### 7. Studio `animation` tool

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

### 8. Publish and wire up

- **Publish.** `export_rbxm` plus `upload_asset` with type `Animation`, with an
  owner check: the animation must belong to the place's owner, user or group.
- **Wire up.** The new ID goes onto player characters (the Animate script or a
  small loader), and a playtest confirms the track plays.
- **Fallbacks.**
  - No Open Cloud key: build and test locally with a temporary ID, and explain
    how to publish.
  - A group-owned place with a personal key: stop before uploading.
  - Moderation pending or rejected: report it; never claim success.

### 9. Animation playback and contact sheet

- **Playback.** The step 4 viewer plays the rig from the compiled pose data (no
  Blender needed), or a GLB with the animation baked in when Blender made it.
  It has play/pause and a scrub bar.
- **Contact sheet.** The sheet the model checks is a grid of frames rendered in
  trusted code, by a small box-rig renderer in core using the existing PNG
  encoder, or by Blender when it is on. It is never rendered by the chat
  window.

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
