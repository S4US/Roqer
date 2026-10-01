# Character animation

Roqer can make an R15 or R6 character animation from a request in plain words. It
checks the motion, shows it to you, builds it in your place, publishes it to
Roblox, wires it to your players' characters, and checks in a playtest that it
plays. It can also animate an NPC, and a creature or other model you rigged
yourself (see [A model's own rig](#a-models-own-rig)).

For "Make a running animation and set it up in R15", a finished run leaves:

- a published animation owned by whoever owns the place;
- the animation set as every character's run animation;
- a playtest in which it played on the character;
- a 3D preview of the motion in the chat;
- no motion check left failing.

A run that cannot finish one of these says which one, and why.

All of this goes through one Studio tool, `animation`. MCP clients other than
Roqer can use it too; see [the MCP server guide](mcp-server.md).

## What you need

- **An R15 or R6 character.** Animations are made for the standard R15 body,
  which is what Roblox gives players by default, or for the classic six-block
  R6 body that many combat games use. An animation plays only on the rig it
  was made for, so the agent checks which one your players use, and a
  playtest verification refuses a mismatch.
- **To publish:**
  - a Roblox Open Cloud API key with the Assets API's Write access, set under
    **Settings → Roblox → Open Cloud** (see
    [Roblox Open Cloud in Roqer](configuration.md#roblox-open-cloud-in-roqer));
  - the upload creator set to the place's owner, the user or the group.

  An animation plays in a live game only for its owner, so Roqer refuses to
  upload one for anybody else. It can upload for a place that is not published
  yet. It then says that you must publish the place under the same owner.

Without a key, the agent can still make, check and build an animation, and
play it in a playtest. It can't publish it or wire it to characters, and it
tells you that publishing needs a key.

## How it works

1. **The agent describes the motion.** It writes a short list of keyframes.
   Each keyframe gives some joints a pose:
   - a rotation;
   - for an arm or a leg, the direction it points and how far the elbow or
     knee bends.

   - for an arm or a leg, a point its hand or foot should reach: Roqer bends
     the elbow or knee to reach it, and a foot held on one point stays
     planted while the body lunges over it.

   It starts from tested recipes, which ship with Roqer's animation skill:
   for R15 a wave, idle, walk, run, jump, sword slash and lunge, and for R6 a
   walk and a wave.

   For a sword or other weapon, the agent can also move the weapon in the
   hand, so a swing can flick and tilt the blade, and a second item in the
   left hand or a sheath at the hip.

   A keyframe can also carry markers: named events, such as the moment a
   sword hit lands, that a game script waits for with
   `GetMarkerReachedSignal`.
2. **Roqer checks it before Studio sees it.** It compiles the description and
   measures the motion:

   | Check | What it catches |
   | --- | --- |
   | Joint limits | a joint bent past what a body can do |
   | Velocity | a joint that snaps round too fast |
   | Root drift | the body sliding away from where the character stands |
   | Loop continuity | a loop whose end does not meet its start |
   | Ground contact | feet sinking into the ground, or never touching it |
   | Foot sliding | a planted foot skating |
   | Gait symmetry | legs that do not alternate evenly; on more than two legs, a foot that never steps |

   The last three run for walks, runs and other gaits. For any other
   animation performed on the ground, such as a crouching attack, the agent
   can ask for the ground check alone, which fails when a foot sinks into
   the floor. The limits are set so
   that Roblox's own R15 animations pass every check. On R6, foot sliding is
   reported as not checked: its limit has not been calibrated on R6's block
   legs. A failed check names the
   joint, the time and the limit. The agent fixes it, or waives it when it is
   meant, such as a jump that leaves the ground.
3. **You see the motion.** Roqer draws the stock rig at several moments of
   the animation in one picture, the contact sheet, which the agent can look
   at: five evenly spaced, plus the moments that matter most (each named
   keyframe, each marker such as a hit, and the instant the body moves
   fastest), so a fast strike is never missed between columns.
   - The top row shows the front three-quarter.
   - The bottom row looks straight at the front. For a gait, it looks from the
     side instead, where strides show.

   The same motion plays in 3D in the chat.
4. **Studio builds it.** Before writing anything, Studio plays the animation
   on a temporary dummy and compares it with what Roqer checked. Only if they
   match does it write the animation as a `KeyframeSequence`, in one undo
   step, and read it back.

   A rebuild of the same animation replaces it only when the agent gives the
   revision its last build returned. It never replaces one that was edited by
   hand after its build, or one that Roqer did not build.
5. **It is published.** The animation is uploaded as the place's owner. Roblox
   then serves it back, and Roqer checks that it holds the motion that was
   built. Publishing asks you first, outside Full auto, and goes through
   Roblox's moderation.
6. **It is wired to characters.** Roqer keeps one small Script,
   `ServerScriptService.RoqerAnimate`. It sets each character's default
   `Animate` script to the animations it holds, one per slot: idle, walk, run,
   jump, fall, climb, swim, swimidle and sit.
   - The Script's code never changes; each slot's animation ID is one of its
     attributes.
   - Replacing a slot's animation needs the ID it holds now.
   - If the Script's code was edited, it is left alone.
7. **A playtest proves it.** In a running playtest, the animation plays on the
   player's character and is compared with what was checked. With a slot
   given, Roqer also confirms that the character's `Animate` script holds the
   published animation.

## NPCs

Roqer can also make an NPC and animate it, for "Add a guard NPC who walks
back and forth between two posts".

- **The body.** The agent makes Roblox's stock R15 or R6 body where the NPC
  should stand, in one undo step. A stock body's `Animate` script is a
  LocalScript, which runs only under a player, so an NPC that keeps it stands
  still. Roqer leaves it out.
- **The loader.** In its place, Roqer puts one Script inside the NPC,
  `RoqerModelAnimate`. It plays the NPC's idle while it stands and its walk or
  run while it moves, reading how fast its Humanoid moves, and cross-fades
  between them. It runs on the server, so every player sees the same thing,
  and every copy of the NPC carries it, so a spawner that clones the NPC needs
  nothing else. It starts with Roblox's default idle, walk and run, which the
  agent replaces with the NPC's own, published as for a character.
  - As with `RoqerAnimate`, its code never changes and each animation is one
    of its attributes. Replacing one needs the ID it holds now, and a loader
    whose code was edited is left alone.
- **Feet that keep pace.** For a walk or run, the check reports the speed
  its feet travel backward, its ground speed. The loader plays a gait at the
  NPC's speed divided by that, from half to twice its own pace, so the feet
  do not slide. Outside that range they still do, so the agent sets the NPC's
  `WalkSpeed` to suit its walk, or makes a faster walk. Roblox's defaults have
  no known ground speed, so the loader plays them at their own pace.
- **A playtest proves it.** On the playtest's server, Roqer watches your
  game's own scripts move the NPC until it has seen it walk and stand, or
  walks it to a point itself. It records which
  animation the loader played: the walk while the NPC moved and the idle while
  it stood, at the pace its speed needs. A failure says what to change, such as
  the WalkSpeed.

An attack or other one-shot is played by your game's script on the NPC's
`Animator`; the animation skill shows how. A creature with a body of its own,
such as a four-legged dog, is animated on its own rig, as the next section
describes.

## A model's own rig

Roqer can animate a model that is already rigged, such as a dog built from
Parts and joined with `Motor6D`s, for "Make my dog wag its tail". The agent
gives the model's path as the animation's rig.

- **The rig is read from Studio.** Roqer reads the model's `Motor6D`s and
  `AnimationConstraint`s between its own parts, under its `Humanoid` or
  `AnimationController`, with each part's size and shape, the parts welded to
  them, and each MeshPart's mesh. Reading changes nothing in the model. The
  result lists the joints an animation can move.
- **Poses are turns about the body's own axes.** Each keyframe turns joints by
  degrees about the body's right, up and back at rest, whichever way the
  model's joint frames point. A position moves the whole body, on the one
  joint everything hangs from.
- **Declarations add what the joints cannot say.** The model can carry a
  `RoqerRig` attribute, JSON naming its feet, its limbs and the hinges that
  bend them, and how far each joint may turn. With it, the agent can point a
  leg, bend a knee and plant a foot on a point, and the checks can judge ranges,
  feet and gait. The animation skill shows the format.
- **Checks say what they could not judge.** A check that needs a declaration
  the model lacks is reported as not checked, never as passed: the joint-range
  check for a joint with no declared range, the foot checks for a body with no
  declared feet. Distance limits are R15's, scaled to the body's size, and a
  result measured against them says so.
- **The preview is the model.** The contact sheet and the 3D preview draw the
  model's own parts: blocks, wedges, cylinders and balls as Roblox shapes them,
  welded parts with the part they move with, and MeshParts with their own
  meshes, read from Studio. A mesh Studio will not hand over is drawn as its
  box, and the result names it. A long body gets wider frames.
- **Build plays it on a copy of the model.** A copy in a temporary folder plays
  the animation, is compared with what was checked on the model's own joints,
  and is removed. The model must be rigged as it was when checked. A model is
  refused, with the cause named, when a copy would not be faithful: a part,
  joint or weld that cannot be archived, or a joint or weld holding a part
  outside the model, which the copy would still hold.
- **A playtest proves it.** `verify` plays the animation on the model on the
  playtest's server and compares it with what was checked.

The model's loader plays its idle, walk and run as an NPC's does.

## Rigging a model

Roqer can also make the rig, for "Rig my dog so it can walk". The model's
pieces stay where they are, and the agent says which piece hangs from which
and where each one turns.

- **The whole rig is checked first.** Nothing is changed when the joints do
  not form one tree, a part name repeats or is missing, a pivot lies outside
  the pieces it joins, a part would be left loose, or a weld would hold a
  joint still. The refusal lists every problem.
- **One undo step.** Roqer adds an invisible root part, a `Motor6D` at each
  pivot lined up with the body's axes, welds for the parts that ride along
  (ears, eyes), the physics settings, a `Humanoid` or an
  `AnimationController` with an `Animator`, and the `RoqerRig` declarations.
  It then reads the rig back and compares it with what it planned. It refuses
  if the model changed after it was read.
- **Humanoid or AnimationController.** A `Humanoid` suits a creature that
  walks: its root is free to move and its hip height is set from the rest
  pose. An `AnimationController` suits one that flies, swims or stays put:
  its root is anchored, for a script to move.
- **Body plans.** The `quadruped` plan declares a four-legged body's feet,
  legs, knees and ranges from its part names (`FrontLeft`, or
  `FrontLeftUpper`, `FrontLeftLower` and `FrontLeftFoot`; likewise
  `FrontRight`, `HindLeft` and `HindRight`; `Head`, `Jaw`, `Tail`). The
  `custom` plan declares only what the agent gives.
- **The range sheet.** The result shows every joint turned 30° each way, as
  an image and a 3D preview. A pivot in the wrong place shows as a piece
  swinging off the body.
- **An uploaded model's rig.** An upload can arrive with every piece hung
  from one `RootPart` at the piece's own centre. Roqer replaces that rig only
  when the call says to, and the approval card says so. An upload can also
  arrive with no rig, its pieces loose in nested Models, and is then rigged
  as any loose pieces are.
- **Pivots from Blender.** For a creature modelled in Blender, the pivots
  come from Roqer's check of the exported file
  ([Creatures that move](blender.md#creatures-that-move)), measured from the
  model's own origin. `rig` places them wherever the model was inserted, and
  keeps where that origin is, so the model can be rigged again from the same
  pivots after it is moved.
- **Rigging again.** Replacing a rig Roqer built needs its current revision.
  A rig Roqer did not build, or one edited since, is left alone.
- **A model that is already rigged** can be given declarations without
  changing a joint.

## Skinned creatures

A creature that is one mesh bent by bones, such as a snake, a fish or a wolf
with a tail that curls, is animated the same way as one made of pieces. Each
bone is a joint, named after the bone.

- **Where it comes from.** Usually Blender
  ([Creatures that bend](blender.md#creatures-that-bend)). Any model whose
  MeshPart holds `Bone`s works, including one from the Creator Store.
- **Rigging it.** Roqer adds what a skinned mesh lacks to be animated and
  moved: a hidden root part joined to the mesh, a `Humanoid` or an
  `AnimationController`, and the declarations of its legs, read from its
  bones' names. It never adds, moves or removes a bone. It is one undo step.
- **Previews bend the mesh.** The contact sheet and the 3D preview show the
  mesh skinned as Studio skins it. When Studio will not hand a mesh's skin
  over, the result says the mesh is drawn rigid, so a still image is not
  mistaken for a check.
- **The checks and the generators are the same**: waves, gaits and every
  motion check work on bones as on parts.
- **Limits.** A rig of at most 64 joints, the root among them. Roblox keeps
  at most four bones on a vertex.

## Animations made in Blender

An animation can be made in Blender and brought in, for "Make its tail reach
for the fish with inverse kinematics". Roqer bakes what the creature does in
the Blender scene into a file ([Animating in Blender](blender.md#animating-in-blender)),
and the agent gives the animation tool that file in place of a written
description.

- **Everything after that is the same**: the motion checks, the contact
  sheet and 3D preview, Studio playing it on a copy before anything is
  written, publishing and wiring.
- **It must be made on the model that is in Studio.** The file carries the
  skeleton it was animated on. If a joint is missing in Studio, hangs from
  another joint, or stands somewhere else, the animation is refused with what
  differs, rather than played on a body of another shape.
- **The file is read on your machine** by the MCP server. Only a file named
  `*.animation.json`, of at most 2 MB, is read.

## Waves

A tail, a tentacle, a wing or a spine sways as a wave rather than as
hand-written keys, for "Make my octopus's arms drift while it idles". The
agent names a chain of joints, the axis they turn about, how far, and how
much each joint trails the one before; Roqer writes the keys, twelve to a
cycle.

- Waves and a duration can be the whole animation, or run beside hand-written
  keyframes on other joints. A joint a wave drives cannot also be keyed by
  hand.
- Two waves can drive one joint about different axes, so a tip moves in an
  ellipse.
- In a loop a wave runs a whole number of cycles, so the loop always joins up.
- The keys are ordinary keys: the motion checks, the previews and Studio's
  playback comparison treat them as any others.
- Waves work on R15 and R6 as well as on a model's own rig.

## Gaits

A walk, a trot or a run is written from a few numbers rather than by hand,
for "Make my dog trot". The agent gives the pattern, how far a foot travels
each cycle, and the cycle's length; Roqer places every foot 30 times a second.

- **The legs** are the limbs that end in one of the body's declared feet: two
  on R15 and R6, four on a dog, six or eight on an insect or a spider.
- **Patterns**: `walk` (one foot after another), `trot` (diagonal feet
  together; on six or eight legs, two alternating sets), `pace` (each side's
  feet together), `bound` (hind feet, then front) and `gallop`. Which leg
  steps when comes from where each stands at rest.
- **Planted feet stay put.** While a foot is down it travels straight back
  along the ground, as the ground does under a body walking in place. While
  it is up it swings forward along an arc. The body rides just low enough for
  the legs to reach, and a stride the legs cannot reach is refused with the
  longest they can.
- **A leg needs a knee to stay on the ground.** A leg of one piece only
  swings from its hip, so its foot skims the ground and the foot-sliding
  check may fail.
- **A leg needs slack to stride.** A leg built straight cannot reach forward
  or back, so the body is lowered until it can and the creature walks
  crouched. A leg built bent at rest, as an animal's is, strides by
  straightening, and the body stays level. Roqer's check of a Blender model
  points out legs built straight.
- **The speed it was written for** is in the result, and the model's loader
  uses it to pace the gait to how fast the body moves.
- **The gait check for many legs.** On a body with no pair of hips, the
  check that compared a biped's two hips looks at the feet instead: every
  foot must step each cycle, the feet must share the ground evenly, and the
  result says what order they land in.
- The head, the tail and anything else the gait does not drive can be keyed
  by hand or by a wave in the same animation.

## In the chat

The latest animation plays in the answer's previews card, with a play/pause
button and a scrub bar, and opens larger in the viewer.

When the agent revises an animation, each check or build of the same name is
a new version of one preview, not a new tile. The card and the viewer step
between versions ("Version 3 of 6"), and the newest is shown first.

## Where Roqer keeps things

- **3D previews** are kept in the `blender-jobs` folder in Roqer's data folder,
  beside Blender's jobs, and expire the same way: after seven days, keeping
  only the newest 40. The contact sheet stays with the chat.
- **The stock rig's meshes.** Previews are drawn with them. The first build
  reads them from Studio and caches them under `~/.robloxstudio-mcp/cache`.
  Until then, previews use a stand-in made of rounded blocks, and the result
  says which one it drew.
- **A model's meshes.** The meshes of a model's MeshParts are read from Studio
  the first time a check or build needs them, and cached in the same folder by
  mesh ID, up to 256 of them.

## Limits

- R15 and R6, with only the standard bodies' joints plus three props: a
  held item in each hand and a sheath at the hip. R6 has no elbows or knees, and the foot-sliding check is
  not applied to it. Faces, fingers, clothing and skinned-mesh rigs are not
  animated.
- A model's own rig has at most 64 joints and 128 parts, and its `Bone`s are
  not read. Roqer rigs a model of at most 512 parts, made of rigid pieces; it
  does not skin a mesh. The only body plan with names is `quadruped`. A preview draws at most 256 welded parts and 40,000 triangles of
  meshes, each mesh at most 3,000; a part past these is drawn as its box.
- A prop is animated through a `Motor6D` the game adds when the weapon is
  equipped (or, for a sheath, when the character spawns), because Roblox's
  own grip weld cannot be animated. The animation skill has the scripts.
- Animations are `KeyframeSequence`s, not `CurveAnimation`s.
- Wiring sets the default `Animate` script's slots, or an NPC's idle, walk and
  run. A game that plays its own animations from its own scripts needs those
  scripts changed instead.
- NPCs are Roblox's stock R15 and R6 bodies. The loader paces a gait only when
  it was wired with its ground speed, which R6 animations do not report.
- An animation is made in Studio from its pose description. Animating in
  Blender is not supported yet.
