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

### 2. Live test of the Roblox unknowns

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
the activity list. Clicking one opens it larger.

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

None recorded yet. Record each spike or model-driven run here: date, Studio
version, what was run, and the answer to each question.
