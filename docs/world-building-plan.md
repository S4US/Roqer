# World building and modeling implementation

Status as of 2026-09-24. The accepted design has two independent tracks:
Studio world construction and optional general-purpose Blender modeling. The
modeling track serves props, tools, vehicles and UI renders as well as maps;
it does not depend on completing the world-quality checkpoint.

## World construction

- **Phase 0 — tool guidance and baseline:** building guidance now names actual
  bridge tools, with drift coverage. The first blocky-island and realistic-meadow
  model runs are recorded below. Low-poly village and large adventure map
  scenarios remain outstanding; tests passing is not that baseline.
- **Phase 1 — native batches:** `build_instances` implements create, clone,
  set and remove under one owned root with atomic application and Studio undo.
  The user reported `npm run test:studio:runner` passing all 14 suites on
  2026-09-23, including studio-tooling-smoke. Earlier handoff notes identify
  unrelated core test/lint and Windows packaging-test failures; those are not
  made passing by the live result.
- **Phase 2 — persisted intent:** the building skill ships a version 1
  WorldSpec/Kit/Zones convention, native JSON examples, identity rules, bounded
  readback, world budgets and local repair instructions. Intent stays in the
  place; geometry stays authoritative. The examples have handler coverage and
  [cross-session acceptance scenarios](../apps/desktop/eval/world-continuity.md).
  Real model-driven continuity and visual/traversal evaluation remain unverified.
- **Phase 3 — deterministic scatter:** implemented as a step in the existing
  build tool. It supports rectangular XZ zones, density, weighted templates,
  seeded yaw/scale, explicit ground raycasts, slope limits, spacing and tagged
  obstacle bounds. An explicitly replaced owned group is one atomic undo step.
  Scatter runs alone after its ground/templates are committed. Targets are
  bounded to 1000 placements and 20 attempts each; shortfalls are reported and
  zero placements preserve existing output. Multi-part templates require Models,
  and engine-clamped sizes are refused before insertion. Polygon sampling and
  alignment/support across the whole ground footprint remain outside this slice.
- **Phase 4 — visual repair:** exit criteria met (see Phase 4 exit below). The building skill now defines a
  bounded screenshot → diagnosis → smallest-scope mutation → structural readback
  → comparable screenshot loop. T9 seeds one conspicuous Cove outlier beside an
  intact Ridge and fails collateral rebuilding. The first slice also removes
  T7's unsupported minimum-part-count requirement. T9 has since repaired the
  seeded defect live (below), and T10's village baseline has passed once.
  T11's large-map edit has also passed once (below). The mesh boundary is
  documented and the world-task trajectories are compared; the comparison
  names composition guidance and a screenshot view option as follow-ups.

## General modeling

Phase 5's credential setup, durable upload status, and first-class upload-result
slices are implemented (see the Phase 5 sections below). A real upload and its
result card have passed; a pending operation followed by a later status lookup
remains live validation. Phase 6, the opt-in local Blender worker executing
model-written Python, is implemented and has run end to end (see "Phase 6
Blender worker" below). Phase 7 is implemented (see "Phase 7 modeling guidance
and asset workflows" below): modeling guidance beyond the worker's own
reference, gameplay assembly, kit revisions, UI renders, and a modeling
evaluation; its model-driven runs are still to be recorded. Keep
execution local, credentials out of the renderer, cancellation process-wide,
and mesh/render outputs independently verified. Raw Python is an irreversible
operation under the existing runtime approval policy. Rigging, skinning, UGC
accessories and animation conversion are deferred.

## Phase 2 verification

- Desktop typecheck, lint, all 786 tests and build pass. The build includes the
  new reference in the shipped agent bundle.
- Core typecheck and package build pass. All 13 build-instance tests pass,
  including execution of the four shipped JSON examples against the actual
  handler with a fresh handler between calls. Asset security, subprocess runner
  and port-isolation suites pass separately.
- Full core Jest: 380 passed, four failed in
  `packages/core/src/__tests__/studio-response-delivery.test.ts` with
  `ReferenceError: string is not defined`. They are the same four failures
  documented in the Phase 1 handoff: lost acknowledgement retry, terminal
  non-2xx disposition, legacy 2xx acknowledgement, and pending-response eviction.
- Core lint still has four errors, independently reproduced from committed
  HEAD: `http-server.ts` (`no-async-promise-executor`), `opencloud-client.ts`
  (`no-constant-condition`), and both editions' `install-plugin.ts`
  (`no-unused-vars`). No new lint errors were introduced.
- `test:package-contents` still fails at `tests/prepack-package-contents.mjs:72`
  because its direct Windows `npm.cmd` spawn returns no process exit status.
  This reproduces the handoff's packaging-test limitation.
- The generic skill-creator Python validator could not start because PyYAML
  is unavailable. The actual desktop skill loader, reference links, tool-name
  drift check and handler example tests passed instead.

The reported 14/14 Studio runner result supplies Phase 1 live evidence. This
slice changes guidance, evaluations and tests, not plugin behavior; it does not
claim a new live Studio run or a successful model-driven cross-session build.
The manual continuity scenarios and visual/traversal checks remain outstanding.

## Phase 3 verification

- Final managed Studio run: all 14 functional suites pass, including 150 seeded
  placements from Part and multi-part Model templates, real ground contact,
  obstacle clearance, same-seed replacement, different-seed changes, one-step
  undo, refused unowned replacements, multipart-Part refusal and size-clamping
  refusal. The command exited 1 after the suites because Windows locked its
  temporary worker directory during cleanup. Both runs' leftover directories
  were subsequently removed after checking no matching Studio process remained.
- All 47 planner tests and 16 build-handler/routing tests pass. The planner's
  growing descendant queue uses an explicit while loop: generated Luau numeric
  for loops snapshot their upper bound. Code review found this gap in the
  JavaScript engine stand-in; the expanded live Model test now covers it.
- Desktop typecheck, lint, all 786 tests and build pass. Final skill-loader
  checks pass and the shipped scatter reference matches the source file.
- Core typecheck, build and `build:all` pass, including main/inspector plugin
  compilation. Asset-security, subprocess-runner and port-isolation suites pass.
  Core Jest has 430 passes and the same four response-delivery failures described
  above. The same four baseline lint errors and Windows package-content spawn
  failure remain; no new failures were introduced in those gates.
- The tool catalog remains 51 tools, with scatter inside `build_instances`;
  its schema budget is now 47,000 characters. The inspector remains read-only,
  and desktop risk/approval behavior is unchanged.

The scatter mechanics are verified. Real model-driven scene quality, traversal
and cross-session reuse still require the separate evaluation work in Phases 0,
2 and 4; a passing bulk-placement test does not establish those outcomes.


## First recorded world-quality baseline

These are model-driven scratch-place runs reported on 2026-09-23; they are
quality evidence, not unit-test results.

- T7 `world-blocky-island` built the requested recognizable two-level Part
  island with path/stairs, trees and spawn and captured a screenshot, but the
  old oracle failed it solely because the scene used fewer than 30 BaseParts.
  That lower bound rewarded unnecessary geometry and conflicted with the skill's
  low-detail/merged-cell guidance, so Phase 4 removes it while keeping the
  structural, scale, material, tree, spawn, screenshot and 2,000-part upper
  checks.
- T8 `world-realistic-meadow` passed with
  `anthropic/claude-opus-5-5` at medium effort: 34 tool calls, 28 model turns,
  357.1 s total, 330.6 s model wait, 4.6 s tool time and 0.2 s stream tail. The
  resulting scratch scene used Terrain and visible meadow dressing. This run
  establishes that the Studio/tool path is a small part of the wall time; model
  turns dominate this baseline.
- The screenshots reveal the kind of defects Phase 4 must measure separately
  from structural validity: scene-edge composition, macro-shape hierarchy,
  repetitive/procedural dressing and local visual outliers. A structural pass
  or Terrain-cell threshold alone is not a visual-quality verdict.

## Phase 4 first-slice acceptance

- T7 must no longer fail merely for an efficient low part count.
- T9 must capture a successful screenshot before the structured mutation and a
  second one after it, repair the seeded Cove outlier into a plausible green
  tree scale, structurally read the result back, and preserve Ridge.
- The shipped building skill must route visual-polish work to the same bounded
  repair workflow and distinguish local instance repair from shared-kit or
  scatter-group replacement.
- No new Studio primitive is introduced in this slice; it exercises existing
  screenshot, readback and structured mutation tools.


## Phase 4 first live T9 run

The first T9 run on 2026-09-23 used `anthropic/claude-opus-5-5` at
medium effort. It did not expose a visual-diagnosis failure: the model captured
the baseline view, identified only `Cove.BadTree.Canopy` as the defect, compared
it with the surrounding 10–13 stud green canopies, and attempted one local
Size+Color write (11×11×11 and a matching green). The run then hit a
`set_properties` bridge failure: its response reported that an instance
reference could not be created because the target was outside `game`, and
subsequent reads found the entire `WorkbenchEvalRepair` fixture absent. The
model correctly refused to reconstruct Ridge from incomplete notes.

Treat this run as a tooling failure discovered by Phase 4, not evidence that the
repair policy failed. The live Studio smoke reproduced it independently: raw
`ChangeHistoryService` Size+Color writes kept the nested fixture live, while
`set_properties` rejected the same Color3 write because strict equality treated
Roblox's normalized Color3 readback as different from the requested value. A
first float-only tolerance was still too strict in the live smoke, so property
verification is now shared by `set_properties` and `build_instances`: ordinary
numeric/vector/UDim values use tight float tolerance while Color3 channels allow
one 8-bit channel step plus float error. The live readback demonstrated the
normalization directly: 0.2627 became 66/255 and 0.5686 became 144/255. The smoke requires both
structured mutation paths to keep the target and containing fixture live and to
land the requested values. Do not spend
another model run on T9 until that regression passes. Physical 3D repair
guidance now prefers a bounded `build_instances set` under the smallest
containing root.

The second live T9 run, after the property-verification fix, completed the intended
repair successfully: it used one bounded `build_instances set` on
`Cove.BadTree.Canopy`, reduced the canopy to 11×11×11, changed it to green,
read Cove and Ridge back, and captured the comparable after screenshot. The
probe confirmed the canopy repair and `ridgeStable=true`. The run still scored
FAIL only because the oracle recognized three named structured read tools but
not a target-bearing post-edit `execute_luau` readback. The harness now keeps
tool-result detail for task oracles, and T9 accepts `execute_luau` only when its
returned payload actually names the repaired canopy; a generic camera or other
post-edit Luau call still does not satisfy structural readback.

## Phase 4 village scenario

T10 `world-lowpoly-village` turns the outstanding village baseline into a
scored task. Its hard checks are only what the prompt states: Parts rather than
Terrain, under 1,500 parts, anchored and not default gray, about 160 studs
across, at least five `House_<n>` models whose `RoqerKit` names one of at least
two saved kits with at least one reused, a WorldSpec, one `Landmark` taller than
every house, a `Path` network that comes within a doorstep (4 studs) of the
landmark and every house and carries a SpawnLocation, a screenshot taken after
the last geometry write, a playtest, and the completion gate. Connectivity uses
each part's exact top-down footprint, so a diagonal strip is not credited with
its bounding square. Material mix, palette spread and narrow path pieces are
recorded in the probe's `observed` field for reading beside the screenshots,
not scored.

The first T10 run went through the model gateway of Roqer's former hosted
service, since removed (`anthropic/claude-opus-5-5`, medium), and stopped
after 912 s when its 15-minute access token expired. It had saved a sound plan (WorldSpec, a Village
zone, two house kits, trees, lamp, rock and hill templates) but placed nothing
in the village. That is a harness limit, not a result: 908 s of it was model
wait, with several turns writing 9,000–24,000 output tokens each. The harness
now reports such runs as `STOPPED` rather than `FAIL`.

The first complete T10 run, on 2026-09-23 through the Claude Code control
(`opus`, medium), passed in 360.9 s with 21 tool calls, no failed calls and no
off-target writes. It built the templates in one batch and the whole village in
a second: 203 parts over 160×160 studs, six houses alternating two kits around
a 51-stud landmark (houses top out at 16.5 and 22.5), a plaza with six spoke
paths, four of them diagonal, and one spawn on the network. It then measured
door reachability by raycast, captured two overview screenshots, and in the
playtest walked a character from the spawn to every house door, retrying after
one route first fell 45 studs short. Recorded observations: SmoothPlastic
throughout with Neon only on the 11 lamp lanterns, nine distinct colors, and
no path piece narrower than 6 studs.

Visual read of two user-captured overviews of that run's result:

- Strong: the tower is an unmistakable focal point from both angles; the
  plaza, lamp ring and spokes read as a village centre; cream walls, red roofs
  and green trees hold one consistent palette; the two house kits are
  distinguishable without looking like different worlds.
- Weak: the ground is one flat rectangular slab with hard edges on the
  baseplate, the same abrupt boundary T8's meadow had, and the saved Hill
  template left no visible relief. The six houses sit on a perfect ring facing
  the centre, so the layout reads as a diagram rather than a settlement.
  Trees repeat one cubic silhouette at similar scale and even spacing. The
  flat gray rock slabs read as litter, not rocks.
- Style: the result is blocky rather than low-poly. Apart from the wedge roofs,
  nothing is faceted, although the prompt asked for faceted Parts and wedges.
  T10 cannot catch this, and it should stay an observation: a faceting ratio
  would be the kind of hidden constant T7 dropped.

These are the defects Phase 4 repair and the large-map scenario should
exercise: edge treatment, macro relief, layout irregularity and scatter
variation, not structure.

## Phase 4 large-map scenario

T11 `world-adventure-edit` starts from a seeded three-zone map (Village,
Canyon, Forest on 40-stud raised ground) with saved WorldSpec, three kits and
zone intent, one visible defect and one user edit the intent does not record.
The prompt asks for a repair and an extension in one session: fix the Canyon
bridge, which floats 6 studs above the rim and stops 6 studs short of each
edge, and add a registered Summit zone north of Forest from the saved kits,
joined to Forest's north path. It fails a run that changes Village, Forest, the
kits or templates (by seed-time fingerprint and by any write under them),
replaces a zone, or moves the user's Well back to its saved position. The bridge
passes only if rays along the route never drop into the canyon, meet the Bridge
across the gap, and never step more than two studs between samples.

A dry run (`--dry-run`) seeded and probed it in Studio without a model: the
fingerprints and sentinels read unchanged, the Well read at its user position,
and the untouched fixture failed on the drop at x = -18, as intended.

The first T11 run, on 2026-09-23 through the Claude Code control (`opus`,
medium), passed in 176.6 s with 22 tool calls, no failed calls and no
off-target writes. It read the saved intent and templates before touching
anything, framed a fixed camera on the canyon for its before and after views,
and made three mutations:

- one `build_instances` batch rooted at `Canyon.Bridge` that set the existing
  deck and rails to 44 studs long with the deck top at 40.4, flush with the
  rim paths and overlapping each rim by two studs, without replacing a part;
- one batch creating Summit (a 100×100 raised block beside Forest, a path
  meeting Forest's north path end to end, a plaza, a 22-stud stepped Landmark,
  and Tree_A/Rock_A clones);
- one batch registering Summit's zone document.

In the playtest it walked a character from the spawn, over the bridge and to
the Summit plaza. Village, Forest, the kits and the templates read identical
to their seed-time fingerprints, and the Well stayed at the user's x = -138.

Two observations the score does not capture. The Summit batch was rooted at the
whole map, not at the new zone: the fingerprints proved it touched nothing
else, but the build tool's own containment would have covered only Summit had
the batch been rooted there, as the visual-repair guidance prefers. And from
the user's overview "Summit" has no height at all: it is a block at Forest's
elevation, so it reads as more Forest with a gray stepped shrine in one
corner. The prompt did not ask for elevation, and adding it would have meant
building a traversable climb; the model took the flat option. The repaired
bridge reads clearly as a plain plank crossing.

## Mesh-quality boundary

The building skill now ships `references/mesh-boundary.md`, routed from its
construction-choice section. It decides per component whether Parts suffice,
using silhouette at player distance, repetition versus detail, curvature, what
a player notices, and collision separated from the look. It then orders the
sources: native, existing model, Creator Store, `generate_model`, then import
or upload, and, since Phase 6, a Blender job when the user has the worker on.
Where no available source can produce the shape it says to build a labelled
native proxy and report it, not to promise one. This is guidance, not a
measurement, and it did not gate Phase 6.

## Phase 4 trajectory comparison

The world-task runs recorded so far. They are not a controlled comparison: T7
ran a different model, and T10/T11 ran through Claude Code, which records no
per-turn timing. `hosted` marks a run through the model gateway of Roqer's
former hosted service, since removed.

| Task | Arm | Result | Time | Calls | Geometry writes | Luau calls | Screenshots | Playtests | Failed calls | Off-target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T7 island | hosted `claude-fable-5` | FAIL (old part-count rule, since removed) | 624 s | 16 | 2 | 0 | 2 | 4 | 0 | none |
| T8 meadow | hosted `claude-opus-5-5` | PASS | 357 s | 24 | 8 | 8 | 3 | 0 | 2 | none |
| T9 repair, 2nd run | hosted `claude-opus-5-5` | FAIL (readback rule, since fixed) | 47 s | 8 | 1 | 3 | 3 | 0 | 1 | none |
| T10 village, hosted | hosted `claude-opus-5-5` | STOPPED (token expiry) | 913 s | 18 | 3 | 3 | 0 | 0 | 0 | none |
| T10 village | Claude Code `opus` | PASS | 361 s | 21 | 2 | 6 | 2 | 1 | 0 | none |
| T11 adventure edit | Claude Code `opus` | PASS | 177 s | 22 | 3 | 7 | 6 | 1 | 0 | none |

What repeats:

1. **Every failure so far was the harness's, not the model's.** T7 failed on an
   unsupported part-count floor, T9's first run on the Color3 verification
   bug, its second on a readback rule that missed Luau, and the hosted T10 on a
   15-minute token. Each was fixed at the primitive or oracle. Read the
   trajectory before changing guidance; this pattern is why.
2. **Structure and preservation are reliable.** No run wrote off target. T9
   left Ridge and T11 left Village, Forest, the kits and the user-moved Well
   byte-identical by fingerprint. Repairs edited in place (T9's canopy, T11's
   deck and rails) instead of rebuilding. Builds batch well: one to three
   geometry writes for T9–T11, the village's 203 parts in one.
3. **Composition is the weak axis, in every build.** The same four defects
   recur: hard rectangular boundaries (T8's meadow edge, T10's slab, T11's
   Summit block), missing macro relief (T10's unused Hill template, T11's
   flat "Summit"), over-regular layout (T10's ring of houses) and one-template
   scatter at even spacing (T8, T10). None is structural, so no oracle can
   fail it without a hidden constant. That makes it a guidance target: a
   composition section in the building skill covering edges, relief,
   irregular layout and scatter variants, checked by rerunning T10 and reading
   the screenshots.
4. **Framing a view costs a Luau call every time.** `capture_screenshot` has
   no camera argument, so every world run positioned the camera through
   `execute_luau` (two calls in T10, three in T11) to get comparable before and
   after views. `execute_luau` is classed irreversible, so outside Full auto
   each framing asks the user. A view option on the screenshot tool would
   remove that, at the cost of a public-schema change across all MCP layers.
5. **Model wait dominates wall time.** On the hosted runs that report it, tool
   time was 1–5% of the run (T8: 4.6 s of 357 s; T9: 4.5 s of 47 s). The
   hosted T10 wrote 9,000–24,000 output tokens in single turns while laying out
   templates. The Studio path is not the bottleneck.

## Phase 4 exit

Against the acceptance list: T7 no longer rewards filler; T9's bounded repair
is validated live; the repair skill ships and is routed; the village (T10) and
large-map (T11) scenarios are recorded with traversal checks (path
connectivity and a playtest walk in T10; ray-walked crossing and a playtest
walk in T11); preservation is tested in a multi-zone scene with a user edit;
the mesh boundary is documented; the Color3 mutation regression is fixed and
covered by the live smoke; desktop gates pass. The two follow-ups above
(composition guidance and a screenshot view option) are improvements found by
Phase 4, not conditions of it.

## Phase 4 follow-ups

- **Composition:** the building skill ships `references/composition.md` (edges,
  relief, layout, repetition, and a four-question check against the overview
  screenshot), loaded for map and area work. Judge it by rerunning T10 and
  comparing screenshots with the first run; T10's score does not measure it.
- **Screenshot framing:** no new public parameter was needed. The MCP already
  has `selection` `action: "view"`, which frames a part or model from an exact
  azimuth, elevation and distance, reports the camera position, and is
  classed as a read. Roqer's tool description never mentioned it, so models
  wrote the camera in `execute_luau` instead. The description now documents
  it and says not to move the camera in Luau, and the building guidance aims
  comparable views by framing the same stable container with the same
  arguments. A rerun should show no camera-writing Luau calls.

### Second T10 run, after the follow-ups

Claude Code `opus`, medium, 324.1 s, 16 tool calls. The harness printed FAIL
("far from the requested 160-stud scale"), and the trajectory showed the
oracle was wrong again: the model edged its ground with 160-stud wedges turned
90°, and T7/T10's `Position ± Size / 2` extent counted them along X as a
326-stud village. Both probes now use each part's rotated world box; re-probing
the live result gives 172×172 studs and a PASS on every check.

- Framing: the one overview was aimed with `selection` `view` on the village
  root; no camera-writing `execute_luau` call remained.
- Composition, compared with the first village from the user's overviews:
  layout improved most (a cross of streets with branches, eight houses at
  varied setbacks and angles in loose clusters instead of a ring, one roof
  color variant); the edge is now a bevelled two-tier skirt rather than a bare
  slab, though still a rectangular platform; relief exists but is slight (two
  low stepped pads with rocks and a stepped base under the tower); trees use
  two variants and varied yaw but are still spread evenly around the border,
  and the rocks are still flat slabs.
- A new defect: every Tree_B leaned 45° under a square canopy. The template's
  largest part was a canopy cube turned (45, 0, 45) to read as a diamond;
  with no PrimaryPart, Studio's own pivot for the model took that tilt, and a
  clone's `rotation` sets the pivot outright, so "yaw 30" undid it and tipped
  the trunk. `build_instances` now gives any Model it creates without a
  PrimaryPart or WorldPivot an upright pivot at Studio's chosen position,
  before the model is cloned or turned in its batch and at the end of the
  batch. The unit stand-in reproduces Studio's choice; a live smoke assertion
  clones such a template in the same and in a later batch and requires upright
  trunks. The user ran `npm run test:studio:tools` against the rebuilt plugin
  on 2026-09-23 and every assertion passed, including the new ones: the
  template read `pivot=0,0,0 trunk=0,0,0`, and both the same-batch and the
  later-batch clone read `pivot=0,30,0 trunk=0,30,0`. The rest of the smoke
  (Color3 repairs, atomic refusal, undo, scatter, selection) still passes.
- Fixing that exposed six `build-instances` and three `atomic-properties`
  unit tests that had failed since the Color3 fix: the Color3 change made the
  handlers import `samePropertyValue` from Utils, and neither test's stand-in
  Utils provided it. Both now do; core Jest is back to the four known
  `studio-response-delivery` failures.

## Phase 5 credential setup

Before this slice, `upload_asset` worked from Roqer only if the user had set
`ROBLOX_OPEN_CLOUD_API_KEY` and a creator ID in the environment Roqer was
launched from, and the building skill could only say that none was configured.

- Settings has a Roblox Open Cloud section: an API key and whether uploads
  publish as a user or a group, with its ID. The main process stores the key
  encrypted with the operating system's credential store in `open-cloud.json`,
  atomically, and moves a damaged file aside. The renderer only learns whether
  a key is saved.
- The bridge Roqer starts receives the key and creator in its environment,
  never on its command line. Saving restarts that bridge so it reads them, but
  after the last active run ends, not under one. A bridge another program
  started keeps its own environment, and Settings says so.
- Check key calls Roblox's `POST /api-keys/v1/introspect` from the main
  process. It reports the key's name, expiry, and asset read/write access,
  whether it is disabled or expired, and whether its Assets scope covers the
  chosen user or group. When no creator is chosen, it offers the key's owner.
  It creates nothing, and it never echoes the key in an error.
- The building skill now sends the user to Settings rather than to
  environment variables when an upload has no key. The privacy page and the
  data-handling contract state that the key stays on the machine and that a
  file reaches Roblox only on an approved upload or in Full auto.

Verified: desktop typecheck, lint, 822 tests, build and the Electron smoke;
service typecheck, lint, build and tests (the service tests fail
intermittently on different timing-sensitive tests from run to run, and pass
on rerun); rendered screenshots of the empty, editing and checked states
against the render-bench stub. On 2026-09-23 the user saved a real key with
Assets read and write access in Settings, and Check key confirmed it against
Roblox. On 2026-09-24 that saved-key path uploaded `wqeqwe.png` as the Decal
`funny head`; Roblox returned asset `74552612431149` with moderation state
`Approved`, and Roqer rendered the corresponding asset result and link.

## Phase 5 durable upload status

`upload_asset` now keeps Roblox's long-running operation useful after its
bounded initial wait. A pending upload returns `status: "processing"` and a
stable `operation_id` instead of failing at 60 seconds; action `status` reads
that operation later without sending the file again. Completed results include
the asset ID and Roblox's moderation state (`Reviewing`, `Rejected`, or
`Approved`) when Roblox provides it, while failed operations retain Roblox's
bounded error. Operation IDs are validated before they enter a request path.

The desktop gives the initial poll enough call time to finish. Its policy still
treats action `upload` as irreversible, but treats action `status` as a read, so
checking processing or moderation never asks the user to approve another
upload. The legacy call shape with no action remains an upload. The full bridge
no longer accepts an Open Cloud key on its command line; secrets enter only
through the process environment (including the environment Roqer constructs
from its encrypted settings).

When an upload completes, the host records one first-class asset result in the
run: its `rbxassetid://` target, numeric asset ID, Roblox link, asset type,
operation ID, and moderation state. A later status lookup for the same asset is
deduplicated rather than producing a second result card. A processing operation
stays a tool result until Roblox returns an asset ID, so the interface never
claims that a pending upload exists as a usable asset.

Verified on 2026-09-23: core and desktop typechecks and builds pass, including
the full/inspector package build and both plugin variants; all 829 desktop tests
and the 61 upload/schema/security-focused core tests pass. Asset security,
subprocess-runner, and port-isolation suites pass. Full core Jest has 438 passes
and the same four `studio-response-delivery` failures recorded above; root lint
has the same four pre-existing errors. The Windows package-content test still
returns no child-process exit status at `tests/prepack-package-contents.mjs:72`.
The 2026-09-24 live upload initially exposed one model-facing schema loss: the
model guessed `path`, `type`, and `name`, so the bridge rejected a first call
before the correctly shaped upload succeeded. Roqer's generated catalog now
retains discriminated `oneOf` requirements, advertises the complete upload
shape up front, and answers guessed upload arguments locally with the exact
schema. Such a correction no longer reaches the bridge or creates a failed
activity row. Desktop typecheck, lint, all 832 tests, and build pass with this
fix. A deliberately pending Roblox operation followed by action `status` has
not yet been observed live.

## Phase 6 Blender worker

An opt-in, local Blender worker that runs model-written Python, built as a
Roqer operation rather than an MCP tool: Blender is not Studio, and the repo
keeps local orchestration in the desktop.

- **Settings → Blender modeling.** Off by default. Roqer finds Blender in the
  standard install folders (newest version first), or the user picks it in a
  file dialog the main process opens; the renderer never names the executable.
  It cannot be turned on until that file answers `--version` as Blender. The
  choice is kept in `blender.json` in Roqer's data folder.
- **The `blender` tool** is offered to Claude Code, Codex and custom-endpoint
  runs only while the worker is on; a kept Claude or Codex session is keyed on
  the setting, so switching it starts a fresh one. A call becomes one
  `run_blender_script` operation in the run engine, classified irreversible in
  a separate local risk table (not the MCP surface, and not the `roblox_studio`
  operation list): it is approved like `execute_luau` except in Full auto,
  and cancelled with the run. The approval card shows the whole script.
- **A job** runs in its own folder under Roqer's data folder: background
  Blender from factory settings on an empty scene, through Roqer's wrapper that
  defines `OUTPUT_DIR` and reports a failure with its traceback. Its
  environment is stripped of anything named like a credential and of Roqer's
  own settings. A timeout (default 120 s, at most 200 s) or a cancelled run
  kills Blender's whole process tree. Old job folders are pruned after 7 days
  or beyond the newest 40.
- **Verification** does not trust the script. A second, Roqer-written Blender
  pass re-imports each exported .glb/.gltf/.fbx/.obj (up to three), counts
  triangles, meshes and materials, measures the bounds, and renders a framed
  Workbench preview in the model's material colours. The preview reaches the
  model as an image, the same way a screenshot does.
- **Into Studio** through what Phase 5 built: `upload_asset` as a Model, then
  `insert_asset`, then a size read-back. The building skill's new
  `references/blender.md` gives the job contract and this workflow, and
  `references/mesh-boundary.md` lists Blender as a source when it is on.

Verified: against a real Blender 5.2.1 install, a coloured low-poly tree
exported, re-imported (32 triangles, 2 meshes, 2 materials) and rendered a
correctly framed, coloured preview in 5.5 s; a raising script returned its
traceback; a script that exported nothing was reported as such; a cancelled
infinite loop left no Blender process running. Unit tests cover the worker
with a fake process, the settings store and detection, routing that keeps
local operations off the bridge, the policy (irreversible: asks outside Full
auto), the agent-loop planner offering and routing the tool, and Claude Code's
`--allowedTools` with Blender on. Desktop typecheck, lint, 849 tests, build and
the Electron smoke pass; the Settings row and approval card were rendered
against the bench stub.

End to end (Claude Code, Opus, Full auto): "Model a low-poly wooden barrel in
Blender and put it in the Workspace" ran one Blender job (5.7 s, 548
triangles), which the model checked against the preview. It then uploaded the
barrel as a Model (Approved by moderation), inserted it, scaled it to about 4
studs, set materials and took screenshots, in 77 s in total. The run showed
two behaviours of the import that the guidance had wrong, and
`references/blender.md` now says: one Blender unit arrives as one stud (the
1.2-unit barrel came in 1.2 studs tall), and Roblox makes one MeshPart per
material slot, all arriving white, so `Color` and `Material` are set in Studio.
A second live run in Auto approve stopped before the Blender job and showed the
whole script in the approval card.

## Phase 7 modeling guidance and asset workflows

Phase 6 made a model possible; Phase 7 makes one usable. It is guidance, one
bridge fix, one worker extension and an evaluation, built on the tools that
exist rather than new ones.

- **Modeling guidance.** The building skill's new `references/modeling.md` is
  the brief to settle before any new mesh, whatever makes it: role, size in
  studs, style from WorldSpec, the surfaces that need their own Roblox colour
  or material, moving pieces, rest point and a triangle budget by role. It
  covers low-poly technique, scale and pivot, colour after upload, and
  acceptance with a `RoqerAssetId` provenance attribute. Blender's glTF
  export drops modifiers unless `export_apply=True` (a bevelled cube exported
  24 vertices by default and 216 with it, in Blender 5.2.1), so the job
  contract, the example and the worker's own hint now pass it.
- **Gameplay assembly.** `references/gameplay-assembly.md` turns a model into
  something that works: static or physical per object, one welded root as the
  `PrimaryPart`, simple collision under a detailed look, server-owned
  outcomes, and recipes for a held tool, seat and vehicle, door and lever, and
  pickup, each proven in a playtest.
- **Kit revisions.** "Revise a kit everywhere" in `references/world-intent.md`
  changes a kit's template for every placement: find placements by
  `RoqerKit`, build the new template beside the old with a matching pivot and
  footprint, swap placements with `remove` + `clone` at the same transforms
  per zone, replay scatter groups with the new template, and only then update
  the Kit's `source`. The version 1 convention is unchanged.
- **UI renders.** A Blender job may now leave PNGs in `OUTPUT_DIR`, with or
  without a model. The worker reads each one's size from its own header,
  flags anything over the 1,024 pixels a side Roblox keeps, and attaches it
  after any model previews. `blender.md` gives the recipe (Workbench, which
  draws `diffuse_color`; a transparent film; a square of 512 or 1,024), and
  the UI design skill points made-for-this-game images at it.
- **Image IDs.** An image reaches an `ImageLabel` through `upload_asset` as a
  Decal, whose result carries the `imageId` the label needs. That lookup ran
  in Studio without naming a place, so with two places open it quietly
  returned null, and a Decal still processing at upload never got one.
  `upload_asset` now takes `instance_id` (Roqer already sends the run's
  place) and uses it, and a status check that finds a finished Decal resolves
  `imageId` too. The catalog's drift guard rises by 100 characters for it.
- **Evaluation.** T12 asks for a handcart modeled in Blender and judges what
  the barrel run got wrong or skipped: a job and an upload, the uploaded mesh
  in the cart, about 8 studs long, more than one colour on its mesh parts,
  resting on the ground, anchored, screenshotted after the last change. The
  harness gains `--blender auto|<path>`, which runs the app's own worker and
  routing; without it T12 is skipped. It also now records the approval mode a
  run actually used (the header said Auto approve while runs used Full auto)
  and no longer counts an upload as a write to the place.

Verified: against the real Blender 5.2.1 through the worker, a bevelled crate
exported with its modifier applied (44 triangles) and a 512 × 512 transparent
icon came back attached, in 6.1 s; `blender.md`'s example, run verbatim,
exported a 4-stud, two-material barrel and rendered its icon. Unit tests cover
the image path (sizes from headers, a fake PNG rejected, previews ordered
before renders), T12's oracle, the harness fixes, the Decal status lookup
through the addressed place, and the new references' reachability. Core
typecheck and build pass; core Jest has 440 passes and the same four
`studio-response-delivery` failures, and lint the same four errors, recorded
above. Desktop typecheck, lint, tests and build pass.

T12 live (Claude Code `opus`, Full auto). The first run drove a bridge
started by hand, with no Open Cloud key: its Blender job succeeded (1,276
triangles, 8.06 studs), the upload failed, and the model built a Part stand-in
and said so, which the oracle failed. It also exposed that `build_instances`
took `Color: [107, 64, 31]` without complaint and stored pale blue. Two fixes
followed: the harness now refuses a Blender task on a bridge without a key
before any model runs (an `upload_asset` status check with a malformed ID,
which never reaches Roblox), and every plugin Color3 conversion refuses
components outside 0 to 1 and names the fix. The rerun, on Roqer's own bridge,
passed in 92.6 s and 12 calls: one Blender job (about 1,180 triangles), an
upload (asset 113740442377433, Approved), `insert_asset`, colours and
materials set on the two imported MeshParts (`CartWood` `WoodPlanks`,
`CartIron` `Metal`) after one 0-255 colour was refused and retried as 0-1, the
cart placed at (30, 0, 30) resting on the baseplate at 8.2 × 3.05 × 4.8
studs, a `RoqerAssetId` attribute, and a final screenshot. The user ran
`npm run test:studio:tools` against the rebuilt plugin on 2026-09-24 and every
assertion passed.

Not yet observed: a gameplay assembly or kit revision by a model, a rendered
icon used in UI, and a live Decal upload whose `imageId` is resolved on a
later status check.

### Colour through upload

Both Blender runs above arrived white, and the guidance had the agent repaint
every imported MeshPart in Studio. `npm run eval:colors` tested the two
carriers the guidance had marked unverified, without a model: one cube coloured
only by a packed image texture and one only by vertex colours (`COLOR_0`), each
checked in the GLB before upload. On 2026-09-24 (Blender 5.2.1) both were kept:
the textured cube's MeshPart arrived with a `TextureID`, and EditableMesh read
all four vertex colours back from the other; both showed their colours in
Studio. Only a flat material base colour is lost.

`references/modeling.md` and `references/blender.md` now tell the agent to
colour in Blender (vertex colours for low-poly faces, a packed texture for
detail), leave the imported parts' `Color` white, and keep a separate material
slot only for a surface that needs its own Roblox `Material` or transparency.
The guide's barrel example is now vertex-coloured, one MeshPart. Roqer's
inspection reports where each exported model's colour lives (`texture`,
`vertex` or `material`) and previews it in that mode; before, a textured or
vertex-coloured model previewed grey. T12 now accepts a cart coloured either
way. A T12 rerun with the new guidance (Claude Code `opus`, Full auto, Blender
5.2.1) passed in 80.9 s and 11 calls, against 92.6 s and 12 before, and the user
saw the cart arrive in Studio already coloured.

### Blender for the look, Parts for the play

A live map run from a stylised reference (blocky trees, red dirt cliffs with a
jagged grass fringe, lavender rocks) built everything from Parts, correctly
under the guidance of the time, and came out far from the reference: `Grass`
material where the reference is flat colour, a muted palette, and a grass
fringe pasted on as a separate slab. The rule is now by role, not by style:
with Blender on, every visual piece is a Blender model, and walkable or
interactive pieces are Parts beneath it, with collision layered as an
invisible Part under a visual whose collision is off. Without Blender, Parts
as before.

`npm run eval:kits` checked the cost. One Blender job exported a cliff section,
a tree and a rock, vertex-coloured, in one GLB; on 2026-09-24 both uploads (one
shared material, and a material each) arrived as three MeshParts, one per
piece, named after it, in its colours and at its modeled size. Their spacing
did not survive, which the guidance does not rely on. So a map's whole visual
set is one job and one upload, split into templates in Studio.

The guidance now covers the kit set, collision, and the reference: WorldSpec
records surface treatment (flat or textured, which Roblox material) and the
palette as sampled colours, and the final check compares the overview with the
reference for palette, surface and silhouettes. Roqer's inspection lists each
object of an exported file with its size, so the pieces can be told apart
after upload. The same run also led to three small rules: read with read tools
rather than `execute_luau` (an approval each outside Full auto), create a spawn
inside the build root rather than moving the place's own, and the `selection`
angle range stated in the tool description.

T13 `reference-style` scores this: a small map from an attached reference image
(an original render in the stylised look, committed as an eval fixture), with
Blender on. It fails a map without reused Blender kits, with textured
materials on visible Parts, with visual meshes colliding at full detail,
without a plateau a player can stand on, without its own spawn or with the
place's spawn moved, or without a palette in WorldSpec. No model run of T13 is
recorded yet.

