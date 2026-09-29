# Character animation with the `animation` tool

Use this to author an R15 animation with the `animation` tool (check, build,
publish, wire, verify). Start from the recipe closest to the request and change
it. Run `check` before `build`: it validates the format, runs the motion checks
and returns a contact sheet, without touching Studio.

## Format

```text
{ name, rig: "R15" | "R6", loop?, priority?, easing?, keyframes: [{ time, name?, easing?, joints: { <Joint>: pose }, markers? }] }
```

- Joints: `Root`, `Waist`, `Neck`, `LeftShoulder`, `LeftElbow`, `LeftWrist`,
  `RightShoulder`, `RightElbow`, `RightWrist`, `LeftHip`, `LeftKnee`,
  `LeftAnkle`, `RightHip`, `RightKnee`, `RightAnkle`, and `Weapon` for a held
  weapon (see "Weapons").
- The first keyframe is at 0. A joint keyed in any keyframe must also be keyed
  in the first. A joint left out of a later keyframe just keeps moving toward
  its next key.
- A loop's last keyframe must repeat its first, so the loop joins up.
- A joint that turns more than 90° between two of its keys gets in-between
  keys added for it, along the short way round; `animation.inBetweens` in the
  result counts them. Write a big swing as its key poses, not its arithmetic.
- The short way round must be the way you mean. A turn of 175° or more is
  refused, and a wide arc, such as an overhead slash that ends low on the
  other side, needs a key partway along it (the arm forward at the middle
  of the swing) so it goes over the top rather than through the body.
- Elastic and Bounce turns over 90° are not split: split them yourself.
- `easing` is `{ style, direction }`. Styles are Linear, Constant, Cubic,
  CubicV2, Elastic and Bounce; directions are In, Out and InOut. It can be set
  on a joint, a keyframe or the whole animation, and the nearest one applies.

## Markers

A keyframe's `markers` puts named events at its time, for scripts to time
gameplay to: the frame a sword hit lands, a footstep, a whoosh.

```text
{ time: 0.32, joints: {}, markers: [{ name: "Hit", value: "light" }] }
```

- A script listens with `track:GetMarkerReachedSignal("Hit")`; its handler
  receives `value` (a string, `""` when left out).
- A keyframe that only carries markers may key no joints: `joints: {}`.
- A keyframe's `name` is not a marker. It only fires the older
  `KeyframeReached` event, so use `markers` for anything a script waits on.

## Poses

Each pose takes one of these:

- `aim: [right, up, forward]` (shoulders and hips): the direction the upper arm
  or thigh points, seen from the character. `[0, -1, 0]` hangs it at rest,
  `[1, 0, 0]` holds the right arm straight out to the side, and `[0, -1, 0.4]`
  swings a leg forward. The vector does not need to be unit length.
- `bendToward: [right, up, forward]`, with `aim`: which way the elbow or knee
  folds. Leave it out to fold as at rest: arms forward, legs back. A raised
  waving arm folds up: `bendToward: [0, 1, 0]`.
- `bend: degrees` (elbows and knees): 0 is straight and 90 a right angle.
- `rotation: [x, y, z]` (any joint): degrees about the parent part's axes,
  applied as `CFrame.Angles` does. Use it for the torso, head, wrists and
  ankles. `Waist` at -X leans forward and at +X leans back. `Neck` at +X tips
  the head back. An ankle at +X lifts the toe.
- `position: [x, y, z]` (`Root` only): studs that offset the whole body.
  Negative y lowers the body, as a stride or crouch needs.

Prefer `aim` and `bend` for arms and legs. Working out a combined Euler rotation
by hand is where poses go wrong.

## Recipes

Every recipe below compiles and passes every motion check. A unit test holds
each of them to that. Pass `locomotion: true` for walk and run, which turns on
the ground-contact, foot-sliding and gait-symmetry checks.

### Wave (loop)

```json
{ "name": "Wave", "rig": "R15", "loop": true, "easing": { "style": "CubicV2", "direction": "InOut" }, "keyframes": [
  { "time": 0, "joints": { "RightShoulder": { "aim": [1, 0.3, 0.4], "bendToward": [0, 1, 0] }, "RightElbow": { "bend": 70 } } },
  { "time": 0.3, "joints": { "RightElbow": { "bend": 115 } } },
  { "time": 0.6, "joints": { "RightShoulder": { "aim": [1, 0.3, 0.4], "bendToward": [0, 1, 0] }, "RightElbow": { "bend": 70 } } }
] }
```

The upper arm holds still, out to the side and slightly forward. The forearm
swings between 70° and 115°. For a bigger wave, widen that range.

### Idle (loop)

```json
{ "name": "Idle", "rig": "R15", "loop": true, "easing": { "style": "CubicV2", "direction": "InOut" }, "keyframes": [
  { "time": 0, "joints": { "Waist": { "rotation": [0, 0, 0] }, "Neck": { "rotation": [0, 0, 0] }, "LeftShoulder": { "aim": [-0.08, -1, 0] }, "RightShoulder": { "aim": [0.08, -1, 0] }, "LeftElbow": { "bend": 8 }, "RightElbow": { "bend": 8 } } },
  { "time": 1.5, "joints": { "Waist": { "rotation": [3, 0, 0] }, "Neck": { "rotation": [-3, 0, 0] }, "LeftShoulder": { "aim": [-0.14, -1, 0] }, "RightShoulder": { "aim": [0.14, -1, 0] }, "LeftElbow": { "bend": 14 }, "RightElbow": { "bend": 14 } } },
  { "time": 3, "joints": { "Waist": { "rotation": [0, 0, 0] }, "Neck": { "rotation": [0, 0, 0] }, "LeftShoulder": { "aim": [-0.08, -1, 0] }, "RightShoulder": { "aim": [0.08, -1, 0] }, "LeftElbow": { "bend": 8 }, "RightElbow": { "bend": 8 } } }
] }
```

This is a slow breath. Keep idle motion small and slow: a few degrees over
seconds.

### Walk (loop, `locomotion: true`)

```json
{ "name": "Walk", "rig": "R15", "loop": true, "easing": { "style": "Linear" }, "keyframes": [
  { "time": 0, "joints": { "Root": { "position": [0, -0.09, 0] }, "LeftHip": { "aim": [0, -0.92, 0.38] }, "LeftKnee": { "bend": 11 }, "LeftAnkle": { "rotation": [-11, 0, 0] }, "RightHip": { "aim": [0, -0.98, -0.19] }, "RightKnee": { "bend": 11 }, "RightAnkle": { "rotation": [22, 0, 0] }, "LeftShoulder": { "aim": [0, -1, -0.35] }, "RightShoulder": { "aim": [0, -1, 0.35] }, "LeftElbow": { "bend": 15 }, "RightElbow": { "bend": 15 } } },
  { "time": 0.25, "joints": { "Root": { "position": [0, -0.01, 0] }, "LeftHip": { "aim": [0, -0.99, 0.11] }, "LeftKnee": { "bend": 12 }, "LeftAnkle": { "rotation": [6, 0, 0] }, "RightHip": { "aim": [0, -0.76, 0.65] }, "RightKnee": { "bend": 76 }, "RightAnkle": { "rotation": [36, 0, 0] }, "LeftShoulder": { "aim": [0, -1, 0] }, "RightShoulder": { "aim": [0, -1, 0] }, "LeftElbow": { "bend": 15 }, "RightElbow": { "bend": 15 } } },
  { "time": 0.5, "joints": { "Root": { "position": [0, -0.09, 0] }, "LeftHip": { "aim": [0, -0.98, -0.19] }, "LeftKnee": { "bend": 11 }, "LeftAnkle": { "rotation": [22, 0, 0] }, "RightHip": { "aim": [0, -0.92, 0.38] }, "RightKnee": { "bend": 11 }, "RightAnkle": { "rotation": [-11, 0, 0] }, "LeftShoulder": { "aim": [0, -1, 0.35] }, "RightShoulder": { "aim": [0, -1, -0.35] }, "LeftElbow": { "bend": 15 }, "RightElbow": { "bend": 15 } } },
  { "time": 0.75, "joints": { "Root": { "position": [0, -0.01, 0] }, "LeftHip": { "aim": [0, -0.76, 0.65] }, "LeftKnee": { "bend": 76 }, "LeftAnkle": { "rotation": [36, 0, 0] }, "RightHip": { "aim": [0, -0.99, 0.11] }, "RightKnee": { "bend": 12 }, "RightAnkle": { "rotation": [6, 0, 0] }, "LeftShoulder": { "aim": [0, -1, 0] }, "RightShoulder": { "aim": [0, -1, 0] }, "LeftElbow": { "bend": 15 }, "RightElbow": { "bend": 15 } } },
  { "time": 1, "joints": { "Root": { "position": [0, -0.09, 0] }, "LeftHip": { "aim": [0, -0.92, 0.38] }, "LeftKnee": { "bend": 11 }, "LeftAnkle": { "rotation": [-11, 0, 0] }, "RightHip": { "aim": [0, -0.98, -0.19] }, "RightKnee": { "bend": 11 }, "RightAnkle": { "rotation": [22, 0, 0] }, "LeftShoulder": { "aim": [0, -1, -0.35] }, "RightShoulder": { "aim": [0, -1, 0.35] }, "LeftElbow": { "bend": 15 }, "RightElbow": { "bend": 15 } } }
] }
```

The keys alternate between contact, with both feet down and the body lowered,
and passing, with the swing foot lifted under the body. Each arm swings against
its own side's leg. The ankles keep the planted foot flat. The body is lowered
at contact so that the straighter legs reach the ground without sinking into
it.

- To go faster, scale every time down.
- For a longer stride, raise the hips' forward and back aims together. Then
  lower `Root` a little more at contact, or the feet sink into the ground.

### Run (loop, `locomotion: true`)

```json
{ "name": "Run", "rig": "R15", "loop": true, "easing": { "style": "Linear" }, "keyframes": [
  { "time": 0, "joints": { "Root": { "position": [0, -0.18, 0] }, "Waist": { "rotation": [-10, 0, 0] }, "LeftHip": { "aim": [0, -0.82, 0.57] }, "LeftKnee": { "bend": 25 }, "LeftAnkle": { "rotation": [-10, 0, 0] }, "RightHip": { "aim": [0, -1, 0.05] }, "RightKnee": { "bend": 50 }, "RightAnkle": { "rotation": [48, 0, 0] }, "LeftShoulder": { "aim": [0, -1, -0.6] }, "RightShoulder": { "aim": [0, -1, 0.6] }, "LeftElbow": { "bend": 85 }, "RightElbow": { "bend": 85 } } },
  { "time": 0.17, "joints": { "Root": { "position": [0, -0.08, 0] }, "Waist": { "rotation": [-10, 0, 0] }, "LeftHip": { "aim": [0, -0.95, 0.3] }, "LeftKnee": { "bend": 33 }, "LeftAnkle": { "rotation": [16, 0, 0] }, "RightHip": { "aim": [0, -0.63, 0.77] }, "RightKnee": { "bend": 95 }, "RightAnkle": { "rotation": [45, 0, 0] }, "LeftShoulder": { "aim": [0, -1, 0] }, "RightShoulder": { "aim": [0, -1, 0] }, "LeftElbow": { "bend": 85 }, "RightElbow": { "bend": 85 } } },
  { "time": 0.34, "joints": { "Root": { "position": [0, -0.18, 0] }, "Waist": { "rotation": [-10, 0, 0] }, "LeftHip": { "aim": [0, -1, 0.05] }, "LeftKnee": { "bend": 50 }, "LeftAnkle": { "rotation": [48, 0, 0] }, "RightHip": { "aim": [0, -0.82, 0.57] }, "RightKnee": { "bend": 25 }, "RightAnkle": { "rotation": [-10, 0, 0] }, "LeftShoulder": { "aim": [0, -1, 0.6] }, "RightShoulder": { "aim": [0, -1, -0.6] }, "LeftElbow": { "bend": 85 }, "RightElbow": { "bend": 85 } } },
  { "time": 0.51, "joints": { "Root": { "position": [0, -0.08, 0] }, "Waist": { "rotation": [-10, 0, 0] }, "LeftHip": { "aim": [0, -0.63, 0.77] }, "LeftKnee": { "bend": 95 }, "LeftAnkle": { "rotation": [45, 0, 0] }, "RightHip": { "aim": [0, -0.95, 0.3] }, "RightKnee": { "bend": 33 }, "RightAnkle": { "rotation": [16, 0, 0] }, "LeftShoulder": { "aim": [0, -1, 0] }, "RightShoulder": { "aim": [0, -1, 0] }, "LeftElbow": { "bend": 85 }, "RightElbow": { "bend": 85 } } },
  { "time": 0.68, "joints": { "Root": { "position": [0, -0.18, 0] }, "Waist": { "rotation": [-10, 0, 0] }, "LeftHip": { "aim": [0, -0.82, 0.57] }, "LeftKnee": { "bend": 25 }, "LeftAnkle": { "rotation": [-10, 0, 0] }, "RightHip": { "aim": [0, -1, 0.05] }, "RightKnee": { "bend": 50 }, "RightAnkle": { "rotation": [48, 0, 0] }, "LeftShoulder": { "aim": [0, -1, -0.6] }, "RightShoulder": { "aim": [0, -1, 0.6] }, "LeftElbow": { "bend": 85 }, "RightElbow": { "bend": 85 } } }
] }
```

The run has the same structure as the walk, with these differences:

- a forward lean (`Waist` -10);
- a longer, lower stride;
- a higher knee lift;
- arms bent to 85° and swinging wider.

The knee lift stops at 95° from about 25°: a bigger lift reads as a sprint.

### Jump (one shot)

```json
{ "name": "Jump", "rig": "R15", "loop": false, "priority": "Movement", "easing": { "style": "CubicV2", "direction": "Out" }, "keyframes": [
  { "time": 0, "joints": { "LeftShoulder": { "aim": [0, -1, 0] }, "RightShoulder": { "aim": [0, -1, 0] }, "LeftElbow": { "bend": 0 }, "RightElbow": { "bend": 0 }, "LeftHip": { "aim": [0, -1, 0] }, "RightHip": { "aim": [0, -1, 0] }, "LeftKnee": { "bend": 0 }, "RightKnee": { "bend": 0 }, "LeftAnkle": { "rotation": [0, 0, 0] }, "RightAnkle": { "rotation": [0, 0, 0] } } },
  { "time": 0.12, "joints": { "LeftShoulder": { "aim": [-1, -0.2, 0.25] }, "RightShoulder": { "aim": [1, -0.2, 0.25] } } },
  { "time": 0.3, "joints": { "LeftShoulder": { "aim": [-0.5, 1, 0.2] }, "RightShoulder": { "aim": [0.5, 1, 0.2] }, "LeftElbow": { "bend": 20 }, "RightElbow": { "bend": 20 }, "LeftHip": { "aim": [0, -1, 0.35] }, "RightHip": { "aim": [0, -1, 0.1] }, "LeftKnee": { "bend": 45 }, "RightKnee": { "bend": 25 }, "LeftAnkle": { "rotation": [-15, 0, 0] }, "RightAnkle": { "rotation": [-10, 0, 0] } } }
] }
```

The Humanoid does the jumping. The animation only poses the body in the air:
arms thrown up and knees tucked. The arms pass through the side at 0.12 s,
because going straight from down to overhead would be about half a turn, and
the key at the side says which way round the arms go.

## Weapons

A sword, axe or staff is animated through one more joint, `Weapon`. It moves
a part named `BodyAttach` from the right hand, so a swing can flick, tilt and
roll the blade, not only carry it on a stiff wrist.

- `Weapon` takes `rotation` only: degrees about the hand's own axes, pivoting
  at the grip. At rest the blade points forward out of the fist, square to the
  forearm. `[-90, 0, 0]` runs it straight out along the forearm, as in a
  thrust; `[90, 0, 0]` folds it back along the arm; `Y` rolls it about the
  forearm.
- The preview draws a 4-stud stand-in blade, and only when the animation
  keys `Weapon`.
- Roblox's own grip weld cannot be animated, so the game has to rig the
  weapon for it. Build the tool this way:
  - `RequiresHandle` off, and no part named `Handle`, so Roblox adds no weld of
    its own;
  - one part named `BodyAttach` at the grip, unanchored, `CanCollide` off and
    `Massless` on, with every other part of the weapon welded to it
    (`WeldConstraint`);
  - the weapon modelled with its blade along `BodyAttach`'s up (+Y) axis;
  - this Script in the tool, which swaps in the motor the animation drives:

```luau
local tool = script.Parent
local bodyAttach = tool:WaitForChild("BodyAttach")
local motor: Motor6D?

tool.Equipped:Connect(function()
	local character = tool.Parent
	local hand = character:FindFirstChild("RightHand") or character:FindFirstChild("Right Arm")
	local grip = hand and hand:FindFirstChild("RightGripAttachment")
	if not grip then
		return
	end
	motor = Instance.new("Motor6D")
	motor.Name = "BodyAttach"
	motor.Part0 = hand
	motor.Part1 = bodyAttach
	motor.C0 = grip.CFrame
	motor.Parent = hand
end)

tool.Unequipped:Connect(function()
	if motor then
		motor:Destroy()
		motor = nil
	end
end)
```

- Play the attack from the tool's `Activated` on the character's `Animator`,
  and apply damage from the animation's `Hit` marker, not from a timer (see
  `full.md`, "Priorities and markers").
- To verify a weapon animation in a playtest, equip the weapon first: without
  the motor, verify reports that the character has nothing for `Weapon` to
  move.

### Slash (one shot, with a weapon)

```json
{ "name": "Slash", "rig": "R15", "priority": "Action", "keyframes": [
  { "time": 0, "joints": { "Waist": { "rotation": [0, 0, 0] }, "RightShoulder": { "aim": [0.2, -0.8, 0.6] }, "RightElbow": { "bend": 50 }, "Weapon": { "rotation": [0, 0, 0] } } },
  { "time": 0.25, "name": "WindUp", "joints": { "Waist": { "rotation": [0, 30, 0] }, "RightShoulder": { "aim": [0.4, 1, 0.2], "bendToward": [0, 0, -1] }, "RightElbow": { "bend": 70 }, "Weapon": { "rotation": [0, 0, 0] } } },
  { "time": 0.37, "joints": { "Waist": { "rotation": [0, -5, 0] }, "RightShoulder": { "aim": [0.15, 0, 1], "bendToward": [0, 1, 0] }, "RightElbow": { "bend": 10 }, "Weapon": { "rotation": [-95, 0, 0] } }, "markers": [{ "name": "Hit" }] },
  { "time": 0.47, "easing": { "style": "CubicV2", "direction": "Out" }, "joints": { "Waist": { "rotation": [0, -30, 0] }, "RightShoulder": { "aim": [-0.4, -0.6, 0.7], "bendToward": [0, 1, 0.3] }, "RightElbow": { "bend": 15 }, "Weapon": { "rotation": [-70, 0, 0] } } },
  { "time": 0.8, "joints": { "Waist": { "rotation": [0, 0, 0] }, "RightShoulder": { "aim": [0.2, -0.8, 0.6] }, "RightElbow": { "bend": 50 }, "Weapon": { "rotation": [0, 0, 0] } } }
] }
```

An overhead chop. The ready guard holds the blade up in front. The wind-up
lifts the arm with the elbow folding back, so the blade hangs down the back,
and twists the waist right. The swing brings the arm forward over the top
while `Weapon` snaps the blade out along the arm; the `Hit` marker fires when
the blade is level in front of the chest. The follow-through carries it low
with `CubicV2 Out`, and the last key returns to the guard.

- To swing faster, shrink the gap between the wind-up and `Hit`. Below about
  0.08 s the velocity check fails; waive `velocity` when that snap is meant.
- For a thrust, keep the arm aimed forward and move `Weapon` to `[-90, 0, 0]`.

## R6

Many places, combat games especially, give players R6 characters: six blocks
with no elbows, wrists, knees, ankles or waist. An R15 animation does not play
on them, so find which rig the players use before animating:

- In a running playtest, read the character's `Humanoid.RigType` (for example
  with `eval_client_runtime`). A `StarterCharacter` in `StarterPlayer` decides
  it too. If a place lets players choose, make one animation for each rig.
- `verify` refuses when the playtest character's rig is not the animation's.

Set `rig: "R6"`. Its joints are `Root`, `Neck`, `LeftShoulder`,
`RightShoulder`, `LeftHip`, `RightHip` and `Weapon`, and they take poses in the
same terms as on R15: `aim` points an arm or leg the same way, and a
`rotation` turns about the same body axes. There is no `bend`: an R6 arm or
leg swings as one rigid block. The contact sheet draws the R6 blocks. Foot
sliding is reported as not checked for R6: its limit was set on R15 feet.

### Walk (R6, loop, `locomotion: true`)

```json
{ "name": "WalkR6", "rig": "R6", "loop": true, "easing": { "style": "CubicV2", "direction": "InOut" }, "keyframes": [
  { "time": 0, "joints": { "LeftHip": { "aim": [0, -1, 0.4] }, "RightHip": { "aim": [0, -1, -0.4] }, "LeftShoulder": { "aim": [0, -1, -0.4] }, "RightShoulder": { "aim": [0, -1, 0.4] } } },
  { "time": 0.4, "joints": { "LeftHip": { "aim": [0, -1, -0.4] }, "RightHip": { "aim": [0, -1, 0.4] }, "LeftShoulder": { "aim": [0, -1, 0.4] }, "RightShoulder": { "aim": [0, -1, -0.4] } } },
  { "time": 0.8, "joints": { "LeftHip": { "aim": [0, -1, 0.4] }, "RightHip": { "aim": [0, -1, -0.4] }, "LeftShoulder": { "aim": [0, -1, -0.4] }, "RightShoulder": { "aim": [0, -1, 0.4] } } }
] }
```

The legs swing as rigid pendulums, about 22° each way, with each arm against
its own side's leg. To go faster, scale the times down; for a run, widen the
swing and lean with `Root` `rotation`.

### Wave (R6, loop)

```json
{ "name": "WaveR6", "rig": "R6", "loop": true, "easing": { "style": "CubicV2", "direction": "InOut" }, "keyframes": [
  { "time": 0, "joints": { "RightShoulder": { "aim": [1, 0.5, 0.2] } } },
  { "time": 0.35, "joints": { "RightShoulder": { "aim": [1, 1.4, 0.2] } } },
  { "time": 0.7, "joints": { "RightShoulder": { "aim": [1, 0.5, 0.2] } } }
] }
```

With no elbow, the whole arm waves, raised out to the side and rocking up and
down. An R6 arm turns about the top of its inner edge, so one raised past the
shoulder brushes the head's block: keep the hand out to the side, not over
the head.

## Reading the result

- The contact sheet shows five moments. The top row is the front
  three-quarter. The bottom row looks straight at the front, where arm and head
  motion reads; for a gait (`locomotion: true`) it looks from the side, where
  strides and foot plants read.
- Check the pose against the request, not only the checks. The checks catch
  broken motion, but a pose can pass them and still not be the gesture that was
  asked for.
- Build the same `name` again to revise an animation. Roqer shows the versions
  in one card, and `build` replaces the sequence when you pass the revision the
  earlier build returned.
