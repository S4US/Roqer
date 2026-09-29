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

   It starts from tested recipes for a wave, idle, walk, run and jump, which
   ship with Roqer's animation skill.

   For a sword or other weapon, the agent can also move the weapon in the
   hand, so a swing can flick and tilt the blade.

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

   The last three run for walks, runs and other gaits. The limits are set so
   that Roblox's own R15 animations pass every check. On R6, foot sliding is
   reported as not checked: its limit has not been calibrated on R6's block
   legs. A failed check names the
   joint, the time and the limit. The agent fixes it, or waives it when it is
   meant, such as a jump that leaves the ground.
3. **You see the motion.** Roqer draws the stock rig at five moments of the
   animation in one picture, the contact sheet, which the agent can look at.
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

- R15 and R6 only, and only the standard bodies' joints, plus one held weapon
  in the right hand. R6 has no elbows or knees, and the foot-sliding check is
  not applied to it. Faces, fingers, clothing and skinned-mesh rigs are not
  animated.
- A weapon is animated through a `Motor6D` the game adds when the weapon is
  equipped, moving a part named `BodyAttach`, because Roblox's own grip weld
  cannot be animated. The animation skill has the script for it.
- Animations are `KeyframeSequence`s, not `CurveAnimation`s.
- Wiring sets the default `Animate` script's slots. A game that plays its own
  animations from its own scripts needs those scripts changed instead.
- An animation is made in Studio from its pose description. Animating in
  Blender is not supported yet.
