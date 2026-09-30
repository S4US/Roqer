# Character animation

Roqer can make an R15 or R6 character animation from a request in plain words. It
checks the motion, shows it to you, builds it in your place, publishes it to
Roblox, wires it to your players' characters, and checks in a playtest that it
plays. For "Make a running animation and set it up in R15", a finished run
leaves:

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
   | Gait symmetry | legs that do not alternate evenly |

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
`Animator`; the animation skill shows how. Creatures with bodies of their own,
such as a four-legged wolf, are planned in [the creature plan](creature-plan.md).

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

## Limits

- R15 and R6 only, and only the standard bodies' joints, plus three props: a
  held item in each hand and a sheath at the hip. R6 has no elbows or knees, and the foot-sliding check is
  not applied to it. Faces, fingers, clothing and skinned-mesh rigs are not
  animated.
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
