# Creature and NPC animation plan

Status as of 2026-09-30: step 1, the creature spike, is done, and its answers
are in [Live results](#live-results); the design below follows them. Steps 2
to 8 are proposed and not yet scheduled. The plan details steps 12 to 14 of the
[animation plan](animation-plan.md) (creatures made of rigid parts, skinned
creatures, animating in Blender), adds NPCs, and orders the work anew. Update
each step's status here as it lands.

## Goal

A user can ask Roqer for a creature or an NPC in plain words and get it in
their place: modelled, rigged, animated and moving, with evidence they can
check. The bar is three prompts, one for each way of making the body:

> Model a low-poly wolf in Blender, rig it, give it idle and walk animations,
> and make it walk around.

> Build a blocky four-legged dog from Parts and make it wander around the
> spawn.

> Add a guard NPC who walks back and forth between two posts.

A run is done only when all of these are true:

- the model is in the place, and its rig reads back from Studio as the tool
  built or adopted it;
- every animation it uses is published, owned by the place's owner;
- the animations are wired to the model itself, so every copy of it plays
  them;
- a playtest shows the model moving with its walk playing, and standing with
  its idle playing;
- a 3D preview of each motion is in the chat;
- no motion check is left failing, and none is reported as passed that could
  not judge this body.

A run that cannot reach one of these says which, and why, and never claims the
rest. Without an Open Cloud key the agent still models, rigs, checks, builds
and verifies with temporary clips, and says that uploading a Blender model,
publishing and wiring need a key.

## Where things stand

Most of the animation pipeline already reads a rig table (`Rig` in
`packages/core/src/animation/r15-rig.ts`) rather than R15 itself: the pose
compiler, the motion model with turned joint frames (C0 and C1), optional
joints, per-rig skipped checks, and the contact sheet and GLB writers, which
draw whatever parts and meshes they are given. R6 was added as a second table.
What still assumes a two-legged character, or a player's character:

- **The rig is a name.** `rig` is `R15` or `R6` in the schema and in `RIGS`,
  and `Rig.name` is typed to those two.
- **Limbs are R15's.** `aim`, `bend` and `aimAt` look their joints up in the
  compiler's own `LIMBS` and `HINGES` tables by R15 joint names, and `grip` is
  written for `LeftShoulder`.
- **Two feet.** `Rig.feet` and `Rig.hips` are pairs, and gait symmetry compares
  two hips' swing about X.
- **Silent passes.** The joint limits are tables keyed by R15 names, and a
  joint in neither is skipped without a word. A custom rig would read "every
  joint stays within its range" with nothing checked.
- **An R15-sized body.** Root drift looks for a joint named `Root`, every
  distance limit is in studs calibrated on the R15 body, and the contact sheet
  frames a cell 7.4 studs tall.
- **A stock dummy.** The Studio preview builds its dummy with
  `CreateHumanoidModelFromDescription` and caps a keyframe at 32 poses nested 8
  deep. A spider's legs pass the first, a snake's spine the second.
- **A character or a stock NPC.** Since step 2, `wire` and `verify` also take
  a model, whose loader plays its idle, walk and run, and `rig` makes a stock
  R15 or R6 NPC. A model of any other shape can be wired and verified, but no
  animation can yet be written for it: everything above reads R15's or R6's
  table.

On the modeling side:

- A creature exported as one node tree, uploaded as a Model and inserted,
  arrives as one Model: a MeshPart per mesh, named after the mesh rather than
  its object, at its modelled size and where it was modelled, whether or not
  `insert_asset` is given a position (spike question 7). What it loses is the
  rig: the importer hangs every piece flat from a `RootPart` it adds, each by
  a `Motor6D` at the piece's own centre, and no pivot survives in a part or a
  joint. The kit probe's lost layout (`npm run eval:kits`, 2026-09-24) is not
  a creature's case.
- Roqer's inspection lists each exported object's name and size, and a saved
  scene's listing adds each object's centre and parent. Nothing reports an
  object's origin, which is where a piece pivots, so nothing yet carries the
  pivots from Blender to the rig.
- `generate_model` with `schema_groups` returns each group as its own MeshPart,
  named `<group>_geom`, rigged flat as an upload is (spike question 8).
- The NPC skill covers pathfinding and state machines, and since step 2 points
  to the animation skill's NPC section for animating one.

## Principles

The animation plan's principles stand: Roblox data first, numbers before
pictures, trusted rendering only, proof rather than claims, and a live test
before anything is built on a Roblox unknown. Added for creatures:

- **The rig in Studio is the truth.** A custom rig's parts, joints and rest
  frames are read from the model. A template only names limbs and says how they
  bend; it never stands in for the joints the Animator will drive.
- **One path for every rig.** R15, R6 and custom rigs go through the same
  compiler, checks, previews and Studio comparison. R15 and R6 become built-in
  rig descriptions rather than special cases, and what they compile to does not
  change.
- **The creature is its own dummy.** A custom rig is previewed on a temporary
  copy of the model itself, so "Studio played it as checked" is a statement
  about the creature, not a stand-in.
- **Nothing passes by default.** A check that cannot judge a body is reported
  as not checked, and says what it lacks: a joint with no declared range, a
  gait with no declared feet.
- **The body's source does not matter to the rig.** Parts built in Studio, a
  Blender upload, a generated model or a model the user already has are
  rigged, animated and wired the same way.
- **Generators write keys.** Eight legs walking or a tail swaying is described
  in a few numbers and expanded by the compiler into ordinary keys, as `aimAt`
  is today, so the checks, previews and Studio see plain keyframes.

## Design

### Rigs read from Studio

`Rig` becomes the description of any rig. R15 and R6 stay built in; a custom
rig is read from its model.

- **Name and revision.** `name` is `R15`, `R6`, or the model's path. A rig
  read from Studio carries a revision (see the next section).
- **Parts and joints**, as now: each joint's parent and child part, C0 and C1.
  A custom rig's joints are `Motor6D`s; an adopted rig may use
  `AnimationConstraint`s, which the preview and `verify` already read. A part
  welded to a jointed part moves with it.
- **Pose axes.** A pose's `rotation` means the same on every rig: degrees
  about the body's own axes at rest (right, up, back) at that joint. The
  compiler converts through each joint frame's rest orientation, found by
  forward kinematics from the rest pose. That generalises today's R6
  conversion, which relies on the parent part standing upright.
- **Root and body.** The joint that takes a `position`, and the part that
  heading and the shadow follow. Today these are `rig.joints[0]` and
  `Rig.body`, and root drift looks for a joint named `Root`. Under an
  `AnimationController` the top pose may carry the root part's own name as
  well as `HumanoidRootPart` (spike question 2), so a rig keeps its root's
  name.

What geometry cannot say is declared:

- **Feet**: any number of parts, each with the points that meet the ground (by
  default its box's bottom corners, as today).
- **Limbs**: a limb's root joint (a hip or shoulder), its hinges in order, its
  end point, an optional joint that lays the foot flat, and which way it folds.
  They replace `LIMBS` and `HINGES`, so `aim`, `bend` and `aimAt` work on any
  declared limb. A three-segment leg, such as a dog's hind leg, couples its
  second hinge to its first by a declared ratio, so the two-bone solver still
  has one answer.
- **Hinges**: the axis, and the sign that flexes (R15: elbows +X, knees -X), so
  `bend` always folds a joint the way it folds.
- **Limits**: a turn limit or a hinge range for each joint.
- **Gaits**: named phase patterns over the feet, such as a four-legged walk
  (0, 0.25, 0.5, 0.75 of a cycle), a trot (diagonal pairs together), a pace
  (same side together), a gallop, and a six-legged tripod.

### Declarations on the model

The declarations live on the model as one versioned attribute, `RoqerRig`
(JSON, version 1). The `rig` action writes it, and every read validates it: an
unknown version or a malformed value is refused, never guessed at. A revision
covers the joints and the declarations together, as `RoqerAnimationRevision`
covers a sequence, so an animation is never built for a rig that changed after
it was checked. A new chat can animate a creature an earlier chat built, as
WorldSpec keeps a world's intent in the place.

Body plans fill the declarations in from part names, as R15's names do, so the
agent writes them out only for an unusual body. The skill's reference fixes
each plan's names.

| Plan | Limbs and feet | Gaits |
| --- | --- | --- |
| `biped` | R15's parts and joints, at any proportions: a custom humanoid | walk, run |
| `quadruped` | four legs, front and hind, of two or three segments | walk, trot, pace, gallop |
| `hexapod`, `octopod` | six or eight legs | tripod, wave |
| `serpent` | a spine chain and no feet | none; its motion is a wave |
| `winged` | a biped or quadruped with two wing chains | its base plan's |
| `custom` | only what is declared | only what is declared |

A body with no declarations can still be animated with `rotation`. The checks
that need feet or ranges say they could not run.

### Building a rig: action `rig`

A new action on the `animation` tool rather than a new tool: a rig exists to be
animated, and the tool's revision, read-back and approval handling fit it. It
takes the model, its root part, the joints (each a child part, its parent part
and its pivot, in the model's space), the controller and a body plan. The
pieces stay where they are: an upload keeps its layout (spike question 7).

In one undo step, all or nothing, it:

- **validates the whole rig first**: one root; every jointed part a BasePart in
  the model and reachable from the root; no cycle; part names unique within the
  rig, since a keyframe's poses find their joints by name; a pivot inside or
  touching both parts it joins, since a pivot at the middle of a piece instead
  of its end is the usual mistake; at most 64 joints, a bound of Roqer's for
  summaries and previews, since the engine drove a 128-joint chain and 256
  joints in one keyframe (spike question 3);
- **replaces an importer's rig** when the call says to. An upload or a
  generated model arrives with one: every piece hung from a `RootPart` by a
  `Motor6D` at the piece's own centre, an `AnimationController` with no
  `Animator`, and an `InitialPoses` folder (spike questions 7 and 8). Each
  piece would turn about its middle and carry nothing, so `rig` removes those
  joints, the `RootPart` and the folder, and names what it removed in its
  result;
- **joins the pieces** with one `Motor6D` per joint, whose C0 and C1 line the
  joint's frame up with the root's axes at the pivot, so every rig it builds
  takes rotations in the body's axes with no conversion, as the spike's dogs
  were joined;
- **welds** each piece's other parts (a second material's mesh, an eye) to the
  part its joint moves;
- **sets the physics**: the root collides and nothing else does, every part but
  the root is massless and unanchored, and the root is the model's
  `PrimaryPart`. Without a root it makes one: an invisible box named
  `HumanoidRootPart` around the body;
- **adds the controller**: a `Humanoid`, with its hip height from the rest pose,
  for a creature that walks with Humanoid movement and pathfinding, on two legs
  or four (spike question 6), or an `AnimationController` for one that flies,
  swims, slithers or stays put; each with an `Animator`. A Humanoid on a body
  without R15's neck has `RequiresNeck` and `BreakJointsOnDeath` off, as the
  spike's walking dog had;
- **writes `RoqerRig`** and stamps the rig's revision;
- **reads the rig back** and returns a compact summary: joints as parent to
  child, limbs, feet, ground height, hip height and the revision. With it comes
  a range sheet and 3D preview: every joint turning a little each way, where a
  misplaced pivot shows as a piece swinging off the body.

Replacing a rig needs its current revision, and a rig the tool did not build,
or one edited since, is left alone, as `build` treats a sequence. The one
exception is an importer's rig, which the call names to be replaced and the
approval card says is being replaced.

Two other forms:

- **Adopt.** Given only a model and, optionally, declarations, `rig` reads the
  model's existing joints, writes `RoqerRig`, and changes no joint. That covers
  creatures from the Creator Store and rigs the user made.
- **Stock.** Given `stock: "R15"` or `"R6"`, it makes a stock NPC body at a
  path that names nothing yet, from a default `HumanoidDescription`, which the
  recipes already fit, instead of the agent writing Luau for it. Its feet
  stand at `position`, the origin by default. It leaves out the body's
  `Animate` script, which plays nothing on an NPC (spike question 5), and
  puts the loader in its place holding the idle, walk and run `Animate`
  carried, so the loader is the one thing that animates it, and a stock NPC
  moves like a character until its own animations replace Roblox's. Built in
  step 2.

The inspector edition refuses `rig`, which writes. Reading a rig for `check`
works in both editions.

### Animating a custom rig

`animation.rig` takes `R15`, `R6`, or a rigged model's path. For a path, core
reads the rig through a read-only plugin call and compiles against it, so
`check` on a custom rig needs Studio; the tool's description says so. The rest
of the pose description works as on R15: `rotation` on any joint, `aim`, `bend`
and `aimAt` on declared limbs, `position` on the root joint, markers, easing,
and the split of turns over 90°.

Two generators write what would otherwise be dozens of keys:

- **`gait`** walks every foot of a gait from a few numbers: the gait's name,
  the cycle's length, the stride, the lift, and the share of the cycle a foot is
  down. A foot that is down travels backward along the ground in a straight
  line, solved again every 1/30 s: today's planting, widened from one point to
  a line. A foot that is up lifts along an arc. The body bobs and pitches with
  the steps. It works on R15 and R6 as well.
- **`wave`** sends a wave down a chain of joints, such as a tail, a spine, a
  neck, a tentacle or a wing: its axis, amplitude, cycles, and the lag from
  one joint to the next. A loop meets itself at the seam.

A joint a generator drives may not also be keyed by hand in the same
animation, and the error names the joint. Both expand into ordinary keys before
the checks run.

For every locomotion animation, generated or not, the checks report the ground
speed it was written for, measured from its planted feet. The loader uses it
to match playback to how fast the body moves.

### Checks for any body

The seven checks stay, generalised:

- **Joint limits** come from the declarations. A joint without one is listed as
  not checked. R15 and R6 declare their props as free-turning, so their results
  do not change.
- **Ground contact and foot sliding** run over every declared foot.
- **Gait pattern.** On a body that is not a biped, gait symmetry becomes a
  pattern check: each foot's time on the ground is compared with its gait's
  phase, and the share of the cycle each foot is down is reported. A biped
  keeps today's hip-swing check and its calibration.
- **Distance limits scale with the body.** On a custom rig, root drift, the
  loop seam, ground penetration, the contact tolerance and foot sliding use
  R15's calibrated limits, scaled by how high its hips stand above the ground
  at rest over R15's 2.19 studs, or by its rest height for a body with no legs.
  Each such result says that its limit was scaled from R15's. R15 and R6 keep
  the limits they have.
- **Joint speed** stays in degrees a second and is not scaled: a snap reads as
  a snap at any size.

There are no Roblox creature animations to calibrate against, as the default
`Animate` animations were for R15, so nothing here claims to be calibrated. If
Roblox-published animated creatures turn up, they are measured the same way.

### Previews for any body

- **The contact sheet** frames a custom rig's rest bounds instead of R15's 7.4
  studs, with wide cells for a long body, and still looks from the side at a
  gait.
- **Real geometry.** MeshParts are drawn from their own meshes, read through
  `EditableMesh` as the stock R15 meshes are, cached by mesh ID and size, and
  bounded in triangles. Parts are drawn as their shape: block, wedge, cylinder
  or ball. A mesh Studio will not hand over is drawn as its box, and the result
  says so.
- **The 3D preview** is the same GLB writer, given the rig and its meshes.

### Studio side

- **Reading a rig** (read-only): the model's joints, its parts' sizes, shapes
  and mesh IDs, the controller, the hip height, `RoqerRig` and the revision.
  Bounded at 64 joints and 128 parts.
- **Previewing on the model.** The preview clones the model into the temporary
  Workspace folder, anchors its root far from the place, plays and steps the
  clip as it does the stock dummy, and destroys everything on every path; a
  copy played as checked (spike question 4). A copy leaves out a part that
  cannot be archived, and a weld or joint in the copy that held it still holds
  the original's part, as does one that reaches a part outside the model. So a
  model with either is refused, with the part named.
- **Limits follow the rig.** A keyframe's poses and their nesting are bounded
  by the rig's own joint count, up to 64, instead of 32 and 8.

### Wiring and verifying a model

- **`wire` on a model** (a `model`, with `slot` naming one of its states)
  keeps one Script, `RoqerModelAnimate`, inside the model, so every copy
  carries it. Its code never changes. Its attributes are the data: one asset
  ID per state (idle, walk and run), and the ground speed each gait was
  written for. Replacing an ID needs the current one, and a loader whose code
  was edited is left alone, as with `RoqerAnimate`. It runs on the server, and
  what it plays reaches every client, as a published animation the spike's
  server played did (question 1).
- **The loader** picks idle, walk or run from how fast the model moves
  (`Humanoid.Running`, which reported 7.97 and 15.94 studs a second for a dog
  walking at 8 and 16 in the spike, or the root's motion each frame under an
  `AnimationController`): the idle below half a stud a second, and, with both
  gaits paced, the run above the speed halfway between their ground speeds.
  It cross-fades over 0.2 s, and plays a gait at the model's speed over the
  speed it was written for, from half to twice its own pace, so feet do not
  slide in the game. A one-shot, such as an attack, is the game's: its script
  plays the animation on the model's Animator at `Action` priority and hears
  its markers with `GetMarkerReachedSignal`. The loader has no events of its
  own, so a game depends on nothing in it but its attributes.
- **`verify` on a model** runs on the playtest's server peer. With an
  animation, it plays it on the model's Animator and compares the joints with
  the checked model, as it does on a character; with a slot, it reads the ID
  that state holds. With `position` it walks the model's Humanoid there with
  `Humanoid:MoveTo`, for up to nine seconds, since `MoveTo` gives up after
  eight, then samples it standing; with nothing else it watches the model for
  eight seconds while the game moves it. A model under an
  `AnimationController` is watched, never moved: its speed is timed from its
  root's motion. Walked or watched, it records a tenth of a second apart which
  track the loader played at which speed, and passes when the walk played for
  most of the time it moved, the idle for most of the time it stood, and the
  gait at the pace the model's speed needs.

A stock R15 or R6 NPC is a model too, and the same loader animates it.

### Making the body

No new modeling tool: guidance, and extensions to the Blender worker.

- **Parts**, always available: one Model built with `build_instances`, a Part
  or welded group per moving piece, named for its body plan, then rigged. It
  suits a blocky style, and it is the path without Blender, since the model
  needs no upload; only publishing its animations does.
- **Blender**, when the user has it on: an articulated recipe in the building
  skill. Each moving piece is its own object with its origin at its joint,
  parented to the piece it hangs from and overlapping it at the joint, so a
  turn opens no gap. Left and right pieces are named `_L` and `_R`, and the
  body faces -Y with its feet at Z 0. Each piece's mesh carries the piece's
  name too, since a MeshPart is named after its mesh, not its object (spike
  question 7). The inspection reports each object's origin and parent in
  Roblox's axes, flags an origin that lies in neither its own piece nor its
  parent, left and right origins that do not mirror, and a mesh named apart
  from its object, and ends with the `rig` arguments, each piece's pivot,
  ready to pass on, since the upload keeps the layout but no pivot.
- **`generate_model`**, without Blender or an upload: `schema_groups` from the
  body plan's pieces, each of which comes back as its own MeshPart (spike
  question 8). The generator's wolf faced +Z, backward by Roblox's convention,
  came at about 0.8 by 1.4 by 1.9 studs against the 2 by 3 by 5 asked for,
  and split one front leg unevenly. So the skill turns a generated body to
  face -Z and scales it before rigging, takes each pivot from its piece's box
  (a leg's hip at the top of its box), and reads the range sheet before
  animating, where a badly split piece shows.
- **A model the user already has**: adopt its rig, or rig its pieces.

### A run, end to end

The wolf, as the agent would make it:

1. `blender` jobs model the wolf as pieces, each with its origin at its joint.
   The last exports one GLB, and the inspection gives the `rig` arguments.
2. `upload_asset` publishes the GLB as a Model, and `insert_asset` puts it in
   `Workspace.Wolf`.
3. `animation` `rig` replaces the importer's rig, joins the pieces at the
   inspection's pivots as a quadruped under a Humanoid, and returns the rig
   and its range sheet.
4. `animation` `check` with `rig: "game.Workspace.Wolf"`: an idle written by
   hand and a walk from `gait`. Each returns its checks, contact sheet and 3D
   preview; the walk also returns its ground speed.
5. `build`, `publish` and `wire` for each, the walk with its ground speed.
6. A wander script from the NPC skill moves the wolf.
7. In a playtest, `verify` on the model: each animation plays as checked, and
   the loader walks while the wolf moves and idles while it stands.

For the dog, steps 1 and 2 become one `build_instances` batch. For the guard,
`rig` makes a stock R15 body and step 4 starts from the R15 recipes.

## Steps

Each step ends with something a user can use, and each rests on what a live
test showed.

### 1. Creature spike — done 2026-09-30

`tests/creature-spike.mjs`, run with `npm run test:spike:creature`, is a
research probe like the animation spike: its answers are findings, not
assertions; it writes a JSON report under `tmp/creature-spike/`; and it works in
temporary folders it removes on every path. [tests/README.md](../tests/README.md#creature-spike)
says how to run it. Its questions:

1. Does a sequence keyed by part names drive `Motor6D`s made on a model that is
   not a character: under a `Humanoid` (rig type R15, a custom hip height) and
   under an `AnimationController`; in edit mode, stepped by hand; and in a
   playtest, on the server? Does a client see what the server plays, and can a
   client play on the model itself?
2. Under an `AnimationController`, must the top pose be named
   `HumanoidRootPart`, or does the root part's own name work? May the poses
   start below the root?
3. How deep a chain (24, 64 and 128 joints), and how many joints in one
   keyframe (48, 128 and 256), does a sequence drive?
4. Does a model cloned into a temporary Workspace folder preview as the stock
   dummy does: the track loads, and the joints step? Is a part that cannot be
   archived left out of the copy, as the preview's refusal assumes?
5. Does an NPC made with `CreateHumanoidModelFromDescription` carry an
   `Animate` script, and does it run outside a player's character?
6. Does `Humanoid:MoveTo` walk a four-legged Humanoid rig steadily at 8 and 16
   studs a second, and does `Running` report its speed?
7. With the upload on (`ROQER_SPIKE_UPLOAD=1`; it creates assets), one GLB of
   an articulated four-legged creature, each piece a node with its origin at
   its joint, as Blender exports one; the spike writes it itself, so no
   Blender is needed. Does each piece arrive as one MeshPart, named after its
   node or its mesh, and at its size? Placed as modelled? Nested as modelled?
   Does each MeshPart's pivot sit at its bounds' centre or at the node's
   origin? Does it come rigged: joints between the pieces, at their node
   origins, under a controller? Where do the values in its `InitialPoses`
   folder put their frames? Does `insert_asset` place the pieces the same
   with a position as without one? Can `EditableMesh` read the meshes back?
   The dog's test animation is published too, so question 1 sees a published
   animation played by the server reach a client.
8. With `ROQER_SPIKE_GENERATE=1`: does `generate_model`, with `schema_groups`
   naming a creature's pieces, return them as separate, named parts?

A "no" changes the steps that rest on it before any code is written. The
answers, and what they changed, are in [Live results](#live-results).

### 2. NPCs on stock rigs — built, awaiting its live run

The smallest step that animates something other than the player's character.
It builds what every creature needs anyway: a way to make a body, a loader on
a model, verification on a model, and states that follow movement. The rigs are
R15 and R6, whose recipes already pass.

- `rig` in its stock form.
- `wire` with a `model` and a state (`slot`): the `RoqerModelAnimate` loader, and the
  rules for installing and replacing it.
- `verify` with a `model`, on the server peer, watching or moving it.
- The ground speed of every locomotion animation, reported by the checks.
- Every layer in step: schema, handler, `RobloxStudioTools`, routing, the
  plugin, the inspector's refusal of the writes, the desktop's risk table (`rig`
  and `wire` are mutations, `verify` a read), approval summaries in words,
  activity labels, playtest evidence naming the model and the states seen, and
  the drift tests.
- Guidance: an NPC section in the animation skill (a stock NPC, the loader,
  WalkSpeed and ground speed, and one-shots from the game's script), and a
  pointer to it from the NPC skill.
- Tests: unit tests for the loader's fixed code, the compare-and-set rules and
  the comparisons `verify` makes; in the live animation suite, an R15 NPC walks
  with `MoveTo` and the loader switches between walk and idle.
- **Eval T18** `npc-patrol` gives the guard prompt. The oracle wants an NPC with
  the loader, an idle and a walk published by the run and owned by the place's
  owner, playtest evidence of the walk while it moved and the idle while it
  stood, a 3D preview, and every check passed.

**Done when** T18 passes.

**Status, 2026-09-30.** Everything above is built, with its unit tests and
every repository check passing. The live suite's NPC section
(`npm run test:studio:animation`) and T18 have not run against Studio yet, so
this step is not done. What changed from the proposal, and why:

- `wire` and `verify` name a model's state with `slot`, as for a character,
  rather than a new `state` argument: one argument fewer in the catalog.
- The loader plays idle, walk and run only. It has no `Play` or `Marker`
  events: a one-shot is played by the game's own script on the model's
  Animator, which needs no loader support and keeps the loader's code fixed.
- `rig`'s stock form carries Roblox's default idle, walk and run into the
  loader, so an NPC moves like a character from the start. Their ground speed
  is unknown, so the loader plays them at their own pace until the NPC's own
  replace them.
- `verify` moves a model only through its Humanoid, with `position`. A model
  under an `AnimationController` is watched while the game moves it; pivoting
  one along a line is left for a step that animates such creatures.
- The ground speed is the median backward speed of planted foot corners over
  planted stretches: 2.21 studs a second for the skill's Walk and 4.08 for
  its Run. A Humanoid's default WalkSpeed of 16 is beyond what the loader can
  pace them to, so the guidance has the agent match an NPC's WalkSpeed to its
  walk, and a pace `verify` cannot keep fails with the speed to set.
- The repository runs no Luau, so the loader's fixed code is unit-tested as a
  contract (`model-loader-contract.test.ts`): its pace limits, its states and
  the ground speed cap match core's. Its behaviour is the live suite's to
  check; while it was written, it ran in a Luau VM against mocked services.
- T18's prompt adds "with idle and walk animations of its own", since `rig`'s
  defaults would otherwise be a fair answer, and names the posts, the guard
  and where the sequences go, so the reset owns them. Its oracle wants the
  playtest to have watched the guard's own patrol, after the last wiring,
  rather than `verify` walking it.

### 3. Rigs read from Studio — proposed

Everything that reads a rig learns to read one from a model, and R15 and R6
move onto the same description.

- Core: the generalised `Rig`; `RoqerRig` version 1 and its validation; body
  plans; `aim`, `bend` and `aimAt` from declared limbs; pose axes from rest
  frames; the checks' changes (any number of feet, scaled limits, reporting
  what was not checked); and the previews' framing and real geometry.
- The plugin: reading a rig, previewing on a clone of the model with its
  refusals, and limits that follow the rig.
- Schema: `animation.rig` takes a model's path, and `check` on a path reads
  Studio.
- A regression guard: before the change, snapshot the compiled sequence and
  check report of every recipe and test fixture; after it, each must be
  identical.
- Tests: a custom rig fixture, a Parts dog rigged by hand with `Motor6D`s,
  compiles, checks, draws a sheet and exports a GLB; live, the same dog
  previews on its own clone and plays as checked.

**Done when** a model rigged by hand, with no declarations, can be animated
with `rotation`, and every check it cannot run says so.

### 4. Building rigs — proposed

- `rig`'s build and adopt forms: body plans, the range sheet and preview, the
  physics and controller, replacement by revision, and replacing an
  importer's rig.
- Every layer in step, as in step 2. The approval card says what `rig` builds
  in words, for example "rig Workspace.Dog: 13 joints, quadruped, Humanoid".
- A creature section in the animation skill: choosing a body plan, naming
  pieces, placing pivots, choosing the controller.
- Tests: unit tests for each refusal (two roots, a cycle, a repeated name, a
  missing part, a pivot outside the parts it joins), for C0 and C1 lining up
  with the root, and for `RoqerRig` round trips. Live: build a Parts dog's rig
  in one undo step and read it back, refuse a stale rebuild, adopt an
  existing rig without changing a joint, and replace an importer's rig, built
  in the test the way an upload arrives, only when told to.

**Done when** the tool can rig a Parts dog, and `aim` and `aimAt` move its legs
with every check passing.

### 5. Motion for any body — proposed

- The `gait` and `wave` generators, and planting along a line.
- The gait-pattern check.
- Recipes for each body plan in the skill: a four-legged idle, walk, trot and
  run; a six- or eight-legged walk; a slither; a wing flap; a tail sway. A unit
  test holds each to its checks and its gesture, as `animation-recipes.test.ts`
  holds the R15 recipes: diagonal feet together in a trot, planted feet within
  0.05 studs of their line, a slither's wave running from head to tail.
- **Eval T19** `creature-parts` gives the dog prompt. It needs no Blender.

**Done when** T19 passes, including the loader switching tracks as the dog
moves.

### 6. Blender and generated creatures — proposed

- The articulated recipe, and the inspection's origins, parents, pivot flags,
  mesh names and ready `rig` arguments.
- The flow: one job, one upload, `insert_asset`, `rig` replacing the
  importer's rig and joining the pieces at the inspection's pivots, then the
  animations.
- Generated bodies the same way, without Blender: `generate_model` with the
  body plan's pieces, turned and scaled, then `rig` with pivots from the
  pieces' boxes. The skill says how, and a live test rigs and walks a
  generated four-legged body.
- **Eval T17** `creature-blender` gives the wolf prompt, which the animation
  plan reserved T17 for. It needs `--blender` and an Open Cloud key.

**Done when** T17 passes.

### 7. Skinned creatures — proposed

Some creatures bend along their skin instead of hinging between pieces: a
snake, a tentacle, a dragon's neck. That needs a Blender armature with skin
weights, exported as a skinned mesh, which Roblox imports as a `MeshPart` with
`Bone` instances. A bone is a joint whose C0 is its `CFrame` and whose C1 is
the identity, so bones read into the same `Rig`, and steps 3 to 5 apply to
them: declared limbs and feet, the generators, the checks, the loader and
`verify`.

Its own live test comes first:

- whether an Open Cloud Model upload keeps the armature, bones and weights, or
  only Studio's own importer does;
- Roblox's limits on bones and on influences per vertex, and what happens past
  them;
- how poses must be named and nested to drive bones, and whether a sequence the
  tool builds drives them as the part-keyed one drives joints;
- whether `EditableMesh` hands over skin weights, for previews;
- how Blender's bone axes (Z up, with a rest orientation per bone) turn into
  Roblox's bone frames.

Then:

- **A Blender rigging recipe**: an armature from a template for each body plan,
  and automatic weights. The worker checks the weights itself rather than
  taking the script's word: every vertex weighted, within Roblox's influence
  limit.
- **Previews**: the viewer plays a GLB with its skin. For the contact sheet,
  decide at the time between a Blender render and a skinned renderer in core.

**Done when** a skinned creature passes T17's checks.

### 8. Animating in Blender — proposed

For motion that is easier to make with Blender's tools (inverse kinematics,
constraints, a creature's own armature) than to write as poses. Blender bakes
the action, and a worker script exports it as a pose description for any of
these rigs, R15, R6 or custom, which `animation` then checks, builds, publishes
and wires like any other. Studio keeps one path in. It needs:

- converting Blender's bone rotations into joint rotations for each rig;
- reducing keyframes, since a 30 fps bake reaches the 240-keyframe limit at 8
  seconds;
- a refusal when the Blender rig's joints do not match the Studio rig's;
- the easing measured in the animation plan's step 6, to convert Blender's
  interpolation.

## Verification

Each step runs the gates in `AGENTS.md` for what it touches. A step that changes
the plugin also runs the managed animation suite (`npm run test:studio:animation`)
and `npm run test:e2e`, and a desktop change runs the desktop gates, with the
Electron smoke for IPC or persistence changes.

## Risks

- **A Humanoid on four legs** walked a dog to a goal 24 studs away on flat
  ground at 8 and 16 studs a second with no tilt, no bob and no change of state
  (spike question 6), so four-legged walkers default to a Humanoid. Slopes,
  stairs, turns and long or heavy bodies were not tried; if one of them tips
  or jitters, that body gets an `AnimationController` and a simple mover the
  skill supplies.
- **Generated bodies split as the generator decides.** Its wolf's front left
  leg came back half as tall as its front right. The range sheet shows such a
  piece before anything is animated, and the skill says to generate again.
- **Limits borrowed from R15** are reasoned guesses until reference creature
  animations exist, and their results say so.
- **Name collisions.** Poses find joints by name. `rig` refuses repeated names,
  and an adopted rig that has them is refused with the names listed.
- **Token cost.** A rig summary lists at most 64 joints with its limbs and feet;
  a generated walk is a few numbers; results stay within the budget
  `apps/desktop/runtime/studio-tools.ts` sets.
- **The catalog budget.** `rig` and the new arguments grow the `animation`
  tool's schema. The budget in [token-efficiency.md](token-efficiency.md) rises
  by the measured size, as an explicit API decision, as it did for the tool
  itself.

## Deferred

- Feet that find the ground at runtime (`IKControl`), for slopes and stairs.
- Faces, blend shapes and fingers.
- Ragdolls and death physics.
- Movement for flying and swimming creatures, beyond the loader's states.
- Crowds: many NPCs animating at once, and level of detail.

## Live results

Record each spike and model-driven run here: the date, the Studio version,
what was run, and the answer to each question.

### Creature spike

`npm run test:spike:creature` on the managed runner's Baseplate place, with
streaming on. The first runs, on 2026-09-29 in Studio 0.740.19, answered
questions 1 to 6 as below, cut question 7's readback short, and could not ask
question 8: a proxy-mode MCP server forwarded every Studio request with a
30-second wait, whatever its tool asked for, and `generate_model` asks for two
minutes. Core now forwards the tool's wait. The run of 2026-09-30, in Studio
0.741.19, with the upload and the generator on, answered all eight:

| Question | Answer |
| --- | --- |
| 1. Does a part-keyed sequence drive `Motor6D`s on a model? | Yes: under a `Humanoid` and under an `AnimationController`, in edit mode and on the playtest's server, every joint as keyed |
| 1. Does a client see what the server plays? | Yes, for a published animation as for a registered clip |
| 1. Can a client play on the model itself? | Yes |
| 2. The top pose under an `AnimationController` | The root part's own name, `HumanoidRootPart`, or none, with the body's pose on top |
| 3. How many joints does a sequence drive? | Every size tried: a 128-joint chain, its poses 129 deep, and 256 joints in one keyframe |
| 4. Does a copy preview as the dummy does? | Yes. The part that cannot be archived was left out of the copy, but the copy's weld still held a part: the original's |
| 5. Does a stock NPC's `Animate` run? | No. It is a `LocalScript` with the legacy run context, which runs only under a player, and it played nothing on the server or the client. Its slots hold the stock animations |
| 6. Does `Humanoid:MoveTo` walk four legs steadily? | Yes: to a goal 24 studs away at 8 and 16 studs a second, averaging 7.7 and 15.3, with no tilt, no bob and no change of state. `Running` reported 7.97 and 15.94 |
| 7. How does an articulated upload arrive? | As one Model: a MeshPart per mesh, named after the mesh rather than the node, at its size and where it was modelled, half a turn about Y from glTF's axes, each pivot at its part's centre, nothing nested. `insert_asset` kept the layout with a position and without. The importer rigs it flat: a `RootPart` at the scene's origin, a `Motor6D` from it to every piece at the piece's centre, an `AnimationController` with no `Animator`, and 48 `InitialPoses` values. `EditableMesh` read every mesh |
| 8. Does `generate_model` return named pieces? | Yes: each of the seven groups came back as its own MeshPart, named `<group>_geom`, with a `Motor6D` and `InitialPoses` values as an upload has. The wolf faced +Z, measured about 0.8 by 1.4 by 1.9 studs against the 2 by 3 by 5 asked for, and its front left leg came back half as tall as its front right |

The spike's own answer to question 8 read "no group came back as a named
part": it looked for the bare group names. It now also accepts
`<group>_geom`, and re-judged on this run's readback it answers "separate,
named pieces, as <group>_geom; facing +Z, spanning 0.82 x 1.37 x 1.92 studs".

What changes:

- Questions 1, 2 and 4 hold the design: a model under either controller can
  be animated by a loader on the server, which every client sees, and
  previewed as a character is.
- Question 3: 64 joints is Roqer's bound, not the engine's.
- Question 4: a copy's references to what it left out still point at the
  original, so the preview refuses a part that cannot be archived and a joint
  or weld that reaches outside the model.
- Question 5: an NPC stands still until the loader animates it; `rig`'s stock
  form leaves `Animate` out.
- Question 6: four-legged walkers get a `Humanoid`, and the loader reads their
  speed from `Running`.
- Question 7: an upload needs no placing, but its rig only turns each piece
  about its own middle: `rig` replaces it when told to, with the pivots the
  Blender inspection gives, and the recipe names each mesh after its piece.
- Question 8: `generate_model` is a way to make a body without Blender; the
  skill turns it, scales it and takes its pivots from its pieces' boxes.

Still open: whether the `InitialPoses` values keep the modelled pivots. This
run counted them without reading them; the spike now reads where each puts its
frame. If the node values sit at the node origins, `rig` can take pivots from
any import, a generated body's included, instead of from its boxes.
