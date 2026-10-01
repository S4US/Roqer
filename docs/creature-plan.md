# Creature and NPC animation plan

Status as of 2026-10-01: steps 1 to 6 are done. Step 1, the creature spike,
answered its questions in [Live results](#live-results), and the design below
follows them. Step 2 made NPCs on stock rigs, and eval T18 passes. Step 3
reads a rig from any rigged model, and a dog rigged by hand in Studio plays
its animation as checked. Step 4 rigs a model's loose pieces, and `aim` and
`aimAt` move the legs of a dog it rigged. Step 5 added the `wave` and `gait`
generators, and eval T19 passes. Step 6 carries a Blender creature's pivots
to `rig`, and eval T17 passes. Step 7, skinned creatures, has run its live test,
which found that an upload keeps its bones and weights, and is being built. Step 8 is proposed and not yet
scheduled. The
plan details steps 12 to 14 of the [animation plan](animation-plan.md)
(creatures made of rigid parts, skinned creatures, animating in Blender), adds
NPCs, and orders the work anew. Update each step's status here as it lands.

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

Since step 3, everything that reads a rig reads one description (`Rig` in
`packages/core/src/animation/rig.ts`): the pose compiler, the motion model and
its checks, and the contact sheet and GLB writers. R15 and R6 are built in,
and any other rig is read from its model in Studio, with what its geometry
cannot say declared in its `RoqerRig` attribute. `animation` checks, builds
and verifies an animation for a model's own rig, and previews it on a copy of
the model. What still stands between a creature and a walk:

- **Declarations by hand.** A model's feet, limbs, hinges and ranges are known
  only when its `RoqerRig` declares them. Without them, `aim`, `bend` and
  `aimAt` are refused, and each check that needs them reports what it did not
  judge, so a creature without declarations is posed with `rotation` alone.
- **One hinge a limb.** A declared limb bends at one hinge; a leg of three
  segments is posed with `rotation` on the extra joint. `grip` needs a
  `LeftShoulder` and a `Weapon` joint, as R15 and R6 have.
- **Walks are a biped's.** The skill's walk and run recipes are R15's and
  R6's, and gait symmetry compares a biped's two hips. A walk on four legs is
  written joint by joint, and nothing checks its pattern.
- **Stock NPCs only.** `rig` makes a stock R15 or R6 NPC. It cannot yet join a
  model's parts into a rig, or replace the rig an import arrives with.

On the modeling side:

- A creature exported as one node tree, uploaded as a Model and inserted,
  arrives as one Model: a MeshPart per mesh, named after the mesh rather than
  its object, at its modelled size and where it was modelled, whether or not
  `insert_asset` is given a position (spike question 7). What it loses is the
  rig: the importer hangs every piece flat from a `RootPart` it adds, each by
  a `Motor6D` at the piece's own centre, and no pivot survives in a part or a
  joint. T17's upload arrived the other way: no rig at all, each piece loose
  in a Model of its own nested as the objects were parented, and the model's
  pivot at the scene's origin. `rig` takes both. The kit probe's lost layout (`npm run eval:kits`, 2026-09-24) is not
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
takes the model, the joints (each a child part, its parent part and its pivot,
in the world), the controller and a body plan. The
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
  eight, then samples it standing; with nothing else it watches the model
  while the game moves it, until it has seen it move and stand for two seconds
  each, or for twenty seconds at most. A model under an
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

### 2. NPCs on stock rigs — done 2026-09-30

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

**Status, 2026-09-30.** Done. T18 passed, and so did the live suite's NPC
section (`npm run test:studio:animation`); both runs are in
[Live results](#npcs-on-stock-rigs). What changed from the proposal, and why:

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
- A stock R15 body is jointed by `AnimationConstraint`s, not `Motor6D`s, as
  Roblox now makes avatar joints. `rig` counts either kind, as the preview and
  `verify` already did. Before it did, the live suite read a new NPC back with
  no joints.
- A new body drops after it is parented. `rig` waits until it stops, for two
  still frames in a row and ten frames at most, then stands it at `position`
  again, and lists whatever in its read-back differs.
- `verify` with no `position` watches until it has seen the model move and
  stand for two seconds each, or for twenty seconds at most, rather than for a
  fixed eight: at a pace a walk can keep, one leg of a patrol can take longer
  than eight seconds.
- T18's first two runs failed on the harness, not the agent. The first found
  no loader on the guard, most likely because the installed Roqer app's
  bridge, older than the checkout, answered the eval. The second built a guard
  that patrolled, playing its walk and idle, in a place with no owner: an
  unpublished place, or one opened from a file, reports its `CreatorId` as 0,
  which no animation's owner matches. The eval now refuses both before a run:
  a bridge whose tool catalog differs from the checkout's, and a place with no
  owner. The server also names a plugin older than itself
  (`plugin_outdated`) instead of passing on "Unknown endpoint".

### 3. Rigs read from Studio — done 2026-09-30

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

**Status, 2026-09-30.** Done. The live animation suite's dog section passed
(`npm run test:studio:animation`), and so did `npm run test:e2e`; both runs
are in [Live results](#a-dog-rigged-by-hand). A Parts dog rigged by hand in
Studio, with no declarations, was animated with `rotation`: `check` read its
rig and said which checks it could not run, and the animation played as
checked on a copy of the dog and on the dog itself in a playtest. What was
built:

- **One description for every rig.** `Rig` describes R15, R6 and any model
  alike: its root joint (if one joint moves the whole body), any number of
  feet, limbs and hinges, per-joint ranges, and each joint frame's
  orientation at rest, so a `rotation` means the same on every rig. The
  compiler, the checks and both previews read only the description.
- **R15 and R6 are unchanged.** Before the change, a guard recorded a digest
  of every skill recipe's and test fixture's compiled sequence, check report,
  contact-sheet pixels and GLB bytes
  (`rig-regression.test.ts`). Every one still matches.
- **Reading a rig.** A read-only plugin endpoint reads a Model's `Motor6D`s
  and `AnimationConstraint`s between its own parts, its root, each part's
  size, shape and visibility, the visible parts welded to them, each
  MeshPart's mesh, `RoqerRig`, and a revision of all of it: at most 64 joints,
  128 parts and 256 welded parts. Core refuses, with every problem at once,
  a reading that is not one tree of uniquely named parts from its root, and
  names a joint that shares its name with another after the part it moves.
- **`RoqerRig` version 1**: feet (optionally the points they stand on), a
  biped's hips, limbs with their hinge, end, foot, axis and fold, hinges with
  their axis and flex, and ranges. Any error refuses the whole rig.
- **Checks for any body.** Distance limits are R15's scaled by the body's
  size: its hips' height at rest over R15's 2.19 studs when it has declared
  legs, else its height over R15's; each result measured against one says so.
  A joint that moves with no declared range, a body with no feet or no hips,
  and a rig with no root joint are each reported as not checked.
- **Previews for any body.** A model's contact sheet is framed by its own
  size at rest, in cells up to twice R15's width for a long body, with a
  shadow that follows its footprint. Parts are drawn as Roblox shapes them,
  welded parts with the part they move with, and MeshParts from their own
  meshes, read through `EditableMesh` and cached by mesh ID: at most 3,000
  triangles a mesh and 40,000 a preview, a part past either drawn as its box
  and named in the result.
- **Building on the model.** `build` previews on a copy of the model while its
  rig's revision is the one the checks used, and refuses a model a copy would
  not preview faithfully (spike question 4). A keyframe's poses and nesting
  are bounded by 64 joints and the root rather than 32 and 8.
- **Every layer.** `animation.rig` takes a model's path; `check`, `build` and
  `verify` read the rig from Studio and answer with a summary of it; the
  desktop names the rig in approvals and on the preview; the skill and
  [the animation guide](animation.md#a-models-own-rig) say how.

What changed from the proposal, and why:

- **Body plans moved to step 4.** A body plan fills declarations in from the
  part names `rig` gives the pieces it joins, so it belongs with `rig`'s build
  and adopt forms. A model rigged by hand has no plan's names, so step 3 reads
  what it declares, and nothing is guessed from names.
- **A limb bends at one hinge.** Legs of three segments, such as a dog's hind
  leg with its hock, are posed with `rotation` on the extra joint for now;
  coupling several hinges waits for the gaits of step 5, which need them.
- **A skipped check needs no waiver.** A check that could not run is
  `skipped`, never `fail`, so a creature without declarations can still be
  built; its result says, check by check, what was not judged.
- **MeshPart meshes are read on demand**, by a second endpoint, rather than
  with the rig: the reading stays small, and a mesh read once serves every
  later call and every part that shows it.

### 4. Building rigs — done 2026-10-01

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

**Status, 2026-10-01.** Done. The live animation suite's rig section passed
(`npm run test:studio:animation`); the run is in
[Live results](#a-dog-rigged-by-the-tool). `rig` joined a dog of loose Parts
into a rig, and a paw lift posed with `aim` and `aimAt` passed every check,
played as checked on a copy, and played on the dog itself in a playtest. What
was built:

- **Core plans, the plugin applies.** A read-only endpoint reads the model's
  pieces: every part's size, shape and place, the welds and joints between
  them, the controller, and a revision of all of it, at most 512 parts. Core
  validates the call against that reading and works out every C0, C1, weld,
  physics setting and declaration. The plugin applies the plan in one undo
  step, only while the pieces' revision is the one read, and cancels the step
  on any error. Core then compares the rig read back with the plan and says
  how they differ.
- **Refusals**, all listed at once: joints that are not one tree, a cycle, a
  piece moved by two joints, a repeated joint name, a part name missing or
  shared, a pivot more than 0.1 studs outside both pieces it joins, a part
  left loose, a weld holding two jointed pieces together, and a joint named
  `Root`.
- **The root.** `rig` makes an invisible `HumanoidRootPart` over the piece
  every other hangs from, joined to it by `Root`, with the model pivot's
  heading as the body's axes. Every joint frame is lined up with it.
- **Replacement.** A rebuild needs the rig's revision, and takes out the
  rig's joints with only the root and welds `rig` made. A rig it did not build, or one edited since, is
  left alone. An importer's rig is recognised by its shape (every `Motor6D`
  from one part to a piece's own centre, under an `AnimationController`) and
  replaced only with `replace: "importer"`; the result names what was removed.
- **Adopt.** With no `joints`, `rig` writes only `RoqerRig`, at the revision it
  read, and reads the rig back. With neither a plan nor
  declarations it only reads the rig and draws its range sheet.
- **The `quadruped` body plan** declares feet, limbs, knees and ranges from
  part names; given declarations override it joint by joint.
- **The range sheet** and its 3D preview come with every result. The desktop
  shows it as a preview of its own, titled apart from an animation's, so it is
  never taken for a checked animation.
- **Every layer.** Schema, handler, three plugin endpoints (none served by
  the inspector edition), the approval card's words, the skill's creature
  section, and
  [the animation guide](animation.md#rigging-a-model).

What changed from the proposal, and why:

- **Two body plans, `quadruped` and `custom`.** Bipeds, birds, fish and
  many-armed bodies get plans with step 5, whose generators decide what a
  plan must declare.
- **No `root` argument.** The root is the piece every joint's tree hangs from;
  `rig` always makes the `HumanoidRootPart` above it unless that piece is
  already one.
- **One range sheet.** It turns every joint but the root's together, 30° each
  way about X and then about Z, rather than a sheet per joint: one image
  shows a misplaced pivot, and it costs one preview.
- **The controller sets the root's anchoring.** A `Humanoid`'s root is free to
  walk; an `AnimationController`'s is anchored, since nothing else holds it
  up.
- **The tool catalog's budget rose** from 49,900 to 50,400 characters for the
  five new arguments ([token efficiency](token-efficiency.md)); step 5's
  `waves` and `duration` raised it to 50,600.
- **Pieces made by untracked Luau undo with the rig.** Studio folds changes
  made outside an undo step into the next one, so the live test gives its
  pieces a step of their own. Pieces made by `build_instances` have one.

### 5. Motion for any body — done 2026-10-01

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

**Status, 2026-10-01.** Done. T19 passed on its first run: in 32 tool calls
and two and a half minutes the agent built a dog from Parts, rigged it with
`rig`, gave it an idle and a walk of its own, and published and wired both; a
playtest watched its own wandering play the walk and then the idle, and
every motion check passed. What was built:

- **`gait` on the pose description.** A pattern (`walk`, `trot`, `pace`,
  `bound`, `gallop`), a stride, and optionally lift, duty, bob, crouch, each
  leg's phase and which limbs step. One cycle fills the animation. Its legs
  are the rig's limbs that end in a declared foot, ordered by where they
  stand at rest, so one description walks two legs, four, six or eight.
- **Planting along a line.** Each leg's end is placed with `aimAt` every
  1/30 s: straight back along the ground while its foot is down, forward on
  an arc while it is up. The body rides just low enough for every leg to
  reach both ends of its stride, at most half its legs' height; a longer
  stride is refused with the longest that fits. The checks then report the
  ground speed it was written for, as for a hand-written gait.
- **The gait-pattern check.** On a rig with feet but no pair of hips,
  `gaitSymmetry` judges the feet: every foot steps each cycle, the least time
  on the ground is at least 60% of the most, and the result gives the share
  each foot is down and the order they land in.
- **One shared path.** `waves` and `gait` are both written out by
  `generators.ts` before anything else reads the description. A joint either
  drives is refused in hand keyframes and in the other.
- **Recipes**, in the skill's new `creature-animation.md`, each held to its
  checks and gesture by `creature-recipes.test.ts` on fixture bodies: a dog's
  idle (a tail sway), walk, trot and run, a six-legged walk, a slither and a
  wing flap.
- **T19** `creature-parts`: T18's conditions on the dog, after four of its
  own: made of Parts, a rig that `rig` built and read back, four declared
  feet, and its range sheet shown.
- **Live.** The animation suite built a trot on the pup that `rig` rigged:
  every check passed and none was skipped, at 4 studs a second, its diagonal
  feet landing together, each foot down 53% of the cycle; a copy played it
  within 0.06° of the poses it was checked with.

What changed from the proposal, and why:

- **A foot on a leg with no ankle meets the ground at the leg's end**, not at
  its box's corners, unless its points are declared. A leaning lower leg's
  corners dip under the ground at any gait, which failed the ground check on
  every walk of a kneed dog. This changed `RoqerRig`'s reading, not its
  format.
- **Legs of one piece only swing from the hip.** They are pointed with `aim`
  at where the foot would be; the foot skims, and the foot-sliding check may
  fail. The body does not sink or bob for them.
- **The body bobs but does not pitch.** No gait here needed it; a pitch can
  be added to the gait when a bound looks stiff without one.
- **The pattern check is not compared with a named gait.** A hand-written
  gait names no pattern, so the check judges what every gait shares and
  reports the order it found.
- **The skill's creature material moved to its own reference**, since the
  one file passed the 45,000 characters a skill resource may be.
- **The catalog budget** rose to 50,750 characters for `gait`.

- **`waves` on the pose description.** Each wave names a chain of joints, a
  body axis, an amplitude, and optionally cycles, the lag from one joint to
  the next, a constant offset and a starting phase; amplitude and offset may
  run from a first value to a last along the chain. With `duration`, waves
  alone are a whole animation.
- **Written out before anything reads it.** A wave becomes `rotation` keys,
  twelve a cycle of the fastest wave, Linear between them, among any hand
  keyframes; a hand keyframe within 1/240 s of a wave's key carries it. The
  compiler, checks, previews and Studio see only keyframes, so an animation
  without waves compiles byte for byte as before.
- **Refusals.** A joint a wave drives keyed by hand; two waves turning one
  joint about the same axis; a part-cycle count in a loop; a chain naming a
  part, an unknown joint or a joint twice; no length; more than 240 keyframes.
- **Two waves on one joint about different axes** are allowed, which the
  proposal did not say: an arm swaying two ways out of phase moves its tip
  in an ellipse.
- **Tests.** Unit tests hold the sine at and between keys, the wave running
  base to tip, the loop's seam, and an eight-armed octopus fixture's idle and
  swim to their checks and their gesture. Live, a wave down the rigged pup's
  tail and neck built as 25 keys and played on a copy within 0.06° of the
  poses it was checked with.
- The skill has a waves section with an octopus idle and swim; the catalog
  budget rose to 50,600 characters for `waves` and `duration`.

### 6. Blender and generated creatures — done 2026-10-01

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

**Status, 2026-10-01.** Done. T17 passed on its first run: in 43 tool calls
and under four minutes the agent modelled a twelve-piece wolf in one Blender
job, uploaded it, rigged it, built an idle of waves and a walk gait, published
and wired both, and a playtest watched it wander.

That run also showed the path as first built did not fit the upload. It
arrived with no importer's rig: each piece loose in a Model named
`<piece>_Node`, nested as the objects were parented, with no `RootPart`. `rig`
refused `replace: "importer"` (nothing to replace) and then
`pivot_space: "import"` (no origin), and the agent read three parts'
positions, worked the origin out and passed the pivots in the world. Its
arithmetic confirmed what the path assumes: the origin was the model's pivot,
unrotated, at the position `insert_asset` was given, and the pivots in
Roblox's axes from it lay in their pieces. So, after the run:

- `replace: "importer"` on a model with no joints takes nothing out and is
  not refused. It is still refused on joints that are not an importer's.
- With no importer's rig and no kept origin, a model with no joints is
  measured from its own pivot. A pivot that is not the origin puts the joints
  outside their pieces, which `rig` refuses.
- `rig` keeps the origin on every first build, so a model first rigged with
  pivots in the world can be rigged again in the import's frame.

The live suite rigs a model shaped as that upload was, with the same call
the skill gives, and rigs it again after moving and turning it. No real
upload has gone through the corrected call; the next T17 run is that test.

- **The inspection reads the pivots.** Roqer's check of an exported file now
  reads each mesh object's origin, box, parent (through any empties), mesh
  name and material count. For a model whose objects hang from one another it
  reports the pieces as a tree and ends with the `joints` for `rig`: each
  piece by the name its MeshPart will have, the piece it hangs from, its
  pivot in Roblox's axes from the model's origin, and for a body plan's leg
  the joint names the recipes key (`FrontLeft`, `FrontLeftKnee`, `Neck`).
- **It flags what would rig badly**, while the model can still be changed: an
  origin in neither piece it joins, an origin at its piece's own middle, left
  and right origins that do not mirror, a mesh named apart from its object,
  two objects sharing a mesh, a piece with more than one material, and more
  than one piece parented to nothing. Overlaps between a piece and the one it
  hangs from are no longer layout findings.
- **`roqer.piece(obj, pivot, parent)`** in the job's helpers moves an
  object's origin to its pivot without moving its shape, names its mesh after
  it, and parents it where it stands, so the recipe has no origin arithmetic.
  Run through the worker in Blender 5.2, the skill's wolf (eleven pieces)
  exported, re-imported and came back as ten joints with nothing flagged.
- **`pivot_space: "import"` on `rig`.** The joints' pivots are then measured
  from the upload's own origin, which the importer's `RootPart` marks, or the
  model's pivot when it arrived without a rig, and core places them in the
  world. `rig` keeps where that origin is, as a
  `RoqerRigOrigin` attribute relative to the root it makes, so a rebuild
  takes the same pivots after the model is moved or turned.
- **Guidance**: the building skill's Blender reference has the creature
  recipe; the creature reference has the upload-and-rig call and how to rig a
  `generate_model` body from its pieces' boxes.
- **T17** `creature-blender`: T19's conditions on a wolf, with a Blender job
  and an upload in place of Parts, and five or more MeshParts.

What changed from the proposal, and why:

- **Pieces are named as the body plan names them** (`FrontLeftUpper`), not
  `_L` and `_R`: the plan reads part names, and a MeshPart takes its mesh's
  name. The mirror check reads both ways of naming a side.
- **Pivots travel in the import's frame, not the world's.** The proposal had
  the inspection give "ready" arguments, but an upload can be inserted
  anywhere, so world pivots would be wrong as soon as it was. The new
  argument added about 120 characters to the catalog, within its budget.
- **A moved model is the same rig.** The rig's revision no longer includes a
  welded part's offset: a `WeldConstraint` stores none, so the offset is
  worked out from two world positions, and its last digits change when the
  model moves. The live suite found a model that had only been moved and
  turned refused as "edited since rig built it".
- **No live test of a generated body.** `generate_model` is guidance only for
  now: a live test would spend a generation on every run, and what comes back
  varies. The skill says to read the range sheet and generate again when a
  piece is split badly.

### 7. Skinned creatures — in progress

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

**Status, 2026-10-01.** The live test is written (`npm run
test:spike:skinned`, described in `tests/README.md`) and has run without its
upload. It writes a skinned snake itself, one mesh on a chain of bones laid
out as Blender exports an armature; imported into Blender 5.2, each of its
variants (8 bones, 300 bones, eight influences a vertex) came back with its
bones, weights summing to 1 on every vertex, and a mesh that bends when a
bone is posed. Run with its upload on 2026-10-01 (Studio 0.741), it answered
every question; the table is in [Live results](#a-skinned-upload). In short:

- **An Open Cloud Model upload keeps the skin.** The snake arrived as one
  Model holding one `MeshPart`, named after the mesh and reporting a skinned
  mesh, with its eight `Bone`s under it, nested as the armature was and named
  as its bones were. It came with an `AnimationController` that has no
  `Animator`, an `InitialPoses` folder, and no `RootPart`, `Motor6D` or other
  joint.
- **Bones keep Blender's axes.** Each bone stood where it was modelled, half a
  turn about Y from glTF's axes as parts are, with its +Y along the bone. So a
  bone's `CFrame` is its rest frame in its parent, as the plan assumed, and
  its rest frame is not the body's axes: a pose written in the body's axes is
  turned into the bone's, as it already is for a part that does not rest
  upright.
- **A `KeyframeSequence` drives bones** in edit mode and on a playtest's
  server, each keyed bone turning exactly as keyed, when its poses nest as the
  bones do: a pose for each bone from the root bone down, the unkeyed ones at
  weight 0. Poses for the parts above (`HumanoidRootPart`, the mesh) are
  optional. Bones keyed side by side are not driven at all. That is the shape
  the builder already writes for parts, with a bone's name in place of a
  part's.
- **`EditableMesh` hands over the skin**: the bones with their names and
  frames, and each vertex's bones and weights, four slots a vertex. So core
  can skin a preview itself, with no Blender render.
- **Limits.** A chain of 300 bones arrived whole, nested 300 deep. A mesh
  weighted to eight bones a vertex arrived with four, renormalised to sum to
  1: Roblox keeps the four largest, so the worker's check refuses more than
  four rather than let the shape change silently.

What follows from it, in the order it is built:

1. Bones read into the rig: a bone is a joint whose C0 is its `CFrame` and
   whose C1 is the identity, moving a "part" named after it that is never
   drawn. The compiler, the checks, the builder and `verify` take it as they
   take a `Motor6D`.
2. Previews that bend the mesh: the plugin reads each vertex's bones and
   weights, and core skins the mesh for the contact sheet and the 3D preview.
3. `rig` on a skinned model: declarations, and for one that walks, the root
   part and `Humanoid` around its mesh.
4. The Blender recipe and the worker's check of the weights, then the eval.

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

### NPCs on stock rigs

On 2026-09-30 the live animation suite (`npm run test:studio:animation`, on
the managed runner) passed its NPC section. T18 passed too
(`npm run eval -- --task T18-npc-patrol`, with the Claude provider), in a
published place owned by the Open Cloud key's creator. Neither run printed
Studio's version.

| Run | Result |
| --- | --- |
| `rig` makes a stock R15 NPC | 16 parts and 15 joints, its feet where asked. Its loader held the idle, walk and run its `Animate` carried, and `Animate` was gone. `rig` refused a path already taken, and one undo removed the NPC |
| `verify` walks it to a position | At the Humanoid's default WalkSpeed of 16, it played its walk in all 12 samples while it moved and its idle in all 11 while it stood. The walk, Roblox's default wired with a ground speed of 10 declared for the test, played at 1.59 times its own pace, where 1.6 was needed |
| `verify` watches its own patrol | A patrol script walked it between two points at 8 studs a second, pausing at each. It played its walk in all 27 samples while it moved and its idle in all 14 while it paused, at 0.79 times its pace, where 0.8 was needed |
| T18 | In 25 tool calls and two minutes, the agent made the guard, gave it an idle and a walk of its own, and published and wired both, the walk with its ground speed. A playtest after the last wiring watched its patrol. The oracle found both animations owned by the place's owner, a 3D preview, and every motion check passed |

### A dog rigged by hand

On 2026-09-30 the live animation suite (`npm run test:studio:animation`, on
the managed runner) passed, its dog section with every R15, R6 and NPC
section, and so did `npm run test:e2e`. Neither run printed Studio's version.
The dog is the spike's: Parts joined by `Motor6D`s under a `Humanoid`, with
wedge ears and a ball nose welded to its head, a MeshPart collar welded to its
body, and no `RoqerRig`. Its animation wags the head and the tail.

| Run | Result |
| --- | --- |
| `check` reads the rig | Its seven joints, `Root` taking the pose's `position`, and distance limits 0.75 times R15's, from its height at rest. Nothing failed; the joint limits reported `not checked: Neck and Tail turn with no declared range`, and nothing that could not be judged passed |
| The preview draws it | The collar was drawn from its own mesh, read from Studio, not as its box |
| `build` previews on a copy | The copy played the animation within 0.23° of the poses it was checked with. The dog stayed where it was, and the copy left nothing in Workspace |
| A weld reaching outside | A `WeldConstraint` from the tail to a post outside the dog was refused before anything was built (`model_not_copyable`), naming the weld and the post, and the post did not move |
| `verify` in a playtest | The animation played on the dog itself within 0.27° of the poses it was checked with |

### A skinned upload

`npm run test:spike:skinned`, run on 2026-10-01 against Studio 0.741 with its
upload on. The snake is one mesh, 8 studs long, skinned to a chain of bones as
Blender exports an armature: the root bone turned so its +Y lies along the
snake, each child one bone's length up its parent's +Y.

| Question | Finding |
| --- | --- |
| Does a Model upload keep the skin? | Yes. One Model holding one `MeshPart`, named after the mesh, with `HasSkinnedMesh` true and the 8 `Bone`s under it. An `AnimationController` with no `Animator`, an `InitialPoses` folder, and no joint or `RootPart` |
| How do the bones arrive? | Named as modelled, nested as the chain was, the root bone under the `MeshPart`, each where it was modelled to within 0.001 studs after the half turn about Y |
| A Blender bone's axes | Kept: each bone's +Y points along the snake (Roblox's -Z after the half turn), and a child's `Position` is `(0, 1, 0)`, its offset in its parent's frame |
| Which sequences drive bones? | Poses nested as the bones are, from the root bone down, with or without poses for `HumanoidRootPart` and the mesh above them: each keyed bone turned as keyed, to 0°. Bones keyed side by side, under the keyframe or the mesh's pose, did not move. The same in edit mode and on a playtest's server, and the same on `Bone`s made by hand under a plain Part |
| Does `EditableMesh` read the skin? | Yes: `GetBones`, `GetBoneName`, `GetBoneCFrame`, `GetVertexBones` and `GetVertexBoneWeights` all work. 8 bones by name, the first at `(0, 0, 4)` in the mesh's space, and every vertex's weights in four slots summing to 1 |
| 300 bones | The upload went through, skinned, and all 300 arrived, nested 300 deep |
| Eight bones a vertex | The upload went through, skinned. Every vertex read back with four bones, weights summing to 1: the four largest kept and renormalised |

### A dog rigged by the tool

On 2026-10-01 the live animation suite passed with its rig section. Its pup is
14 loose anchored Parts: a body, a head with two wedge ears and a ball nose,
four legs of two pieces each, and a tail. The run did not print Studio's
version.

| Run | Result |
| --- | --- |
| `rig` joins the pieces | 11 `Motor6D`s, the ears and nose welded to the head, a hidden root free to walk, a `Humanoid` with hip height 1.6, `RoqerRig` and its stamp. The rig read back matched the plan, and the body had not moved |
| The `quadruped` plan | Four feet, four limbs and four knees declared from the part names, and every joint but the root given a range |
| Undo | One undo took the root, joints, welds, controller and declarations out and left the pieces |
| Rebuilding | Refused with no revision (`revision_required`) and with a stale one (`revision_conflict`); with the current one it rebuilt in place, leaving one root and three welds |
| A pivot outside its pieces | Refused (`invalid_rig`), naming the tail's joint |
| `aim` and `aimAt` on its legs | A paw lift passed every check, the joint ranges included, and a copy played it within 0.58° of the poses it was checked with |
| A rig edited since | Left alone (`rig_edited_since_build`) |
| Adopting the hand-rigged dog | `RoqerRig` written as a quadruped, four feet declared, and no joint's C0 changed. Doing it again needed the revision |
| An upload's rig | Left alone without `replace` (`importer_rig`). With it, the 14 `Motor6D`s, `RootPart`, `InitialPoses` and controller were removed and the new rig built under an `AnimationController`, its root anchored |
| `verify` in a playtest | The paw lift played on the rigged pup itself within 0.64° of the poses it was checked with |
| An upload with no rig | The same pieces, each loose in a `<piece>_Node` Model and the model's pivot at its origin: `replace: "importer"` and `pivot_space: "import"` rigged it under a `Humanoid`, 11 `Motor6D`s and three welds, and again after it was moved and turned |
| T17 | In 43 tool calls and under four minutes, the agent modelled a wolf of twelve pieces in Blender, uploaded and rigged it, and published and wired an idle and a walk. The upload arrived with no rig, so two `rig` calls were refused before the agent gave the pivots in the world; see step 6 |
| A generated trot | `gait` wrote a trot for the pup: every check passed and none was skipped, at 4 studs a second, its diagonal feet landing together, each down 53% of the cycle; a copy played it within 0.06° |
| T19 | In 32 tool calls and two and a half minutes, the agent built a dog from Parts, rigged it with `rig`, gave it an idle and a walk of its own, and published and wired both. A playtest after the last wiring watched its wandering. The oracle found both animations owned by the place's owner, the rig's range sheet, a 3D preview, and every motion check passed |
