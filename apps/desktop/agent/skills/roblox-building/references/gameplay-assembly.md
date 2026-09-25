# Gameplay assembly

Use when a model in Studio must do something: be held, driven, sat on,
opened or picked up. The mesh is only the look. The behaviour comes from the
Roblox instances around it, and a model that looks right but is not assembled
falls apart, will not equip, or cannot be used.

## Principles

- **Static or physical, chosen per object.** A prop that never moves stays
  anchored. Anything that moves under physics or with a character is unanchored
  parts welded to one root part.
- **One root, welded.** Weld every piece to the root with `WeldConstraint`
  (`Part0` the root, `Part1` the piece). Make the root the Model's
  `PrimaryPart`. A piece without a weld drops off the moment the game runs.
- **Simple collision, detailed look.** Collision comes from the root or an
  invisible Part shaped to the footprint. Visual MeshParts get `CanCollide`,
  `CanTouch` and `CanQuery` off and `Massless` on, so they neither snag
  players nor change how the object handles.
- **Server owns the outcome.** A prompt, touch or seat event is handled in a
  server `Script`; anything a client sends is validated there (the
  `roblox-networking` skill).
- **Prove it in a playtest.** Structure alone does not show that a tool
  equips or a door opens. Run the place, use the object, and check that no
  piece falls away and that the output has no errors.

## Held tool

1. A `Tool` in `StarterPack` (everyone starts with it) or `ServerStorage` (given
   by a script later).
2. A direct child `BasePart` named exactly `Handle`: the grip MeshPart, or an
   invisible Part the size of the grip. `RequiresHandle` stays true.
3. Every other piece is a child of the Tool, welded to `Handle`, unanchored,
   `Massless`, with collision off.
4. Orient it in the hand with `Tool.Grip` (or `GripPos`, `GripForward`,
   `GripRight`, `GripUp`). Equip it in a playtest and screenshot the character
   holding it; adjust the grip, not the mesh.
5. Behaviour hooks `Activated` in a server Script. Keep a model's blade or
   head out of player collision; detect hits with a query or a touch on a
   dedicated hit Part.

## Seat and vehicle

- A seat is a `Seat` or `VehicleSeat` Part, anchored in a static prop and
  welded to the chassis in a vehicle. Its top face is where the character
  sits, and the character faces the seat's `LookVector`; a `VehicleSeat`
  also drives along it. Before welding, read the seat's `LookVector` and the
  model's front and make them match; a seat created with no rotation faces
  −Z, which is the model's front only if the model was built facing Blender
  −Y (see [Modeling a mesh](modeling.md)). Check both in a playtest.
- A vehicle is a chassis Part (the root and collision), a `VehicleSeat`,
  wheels as separate parts on `HingeConstraint`s, and the body mesh welded to
  the chassis with collision off and `Massless` on. Model wheels as separate
  objects so each arrives as its own part. Load the `roblox-physics` skill
  for motors, suspension and steering.

## Door, lid, lever

- Keep the frame anchored and the moving leaf a separate part or Model with
  its pivot on the hinge line (set `WorldPivot` there).
- For a door that only swings, keep it anchored and tween its pivot on the
  server (the `roblox-animation-vfx` skill covers tweens). Use a
  `HingeConstraint` only when it must respond to physics.
- Put a `ProximityPrompt` under an `Attachment` at the handle, with a clear
  `ActionText` and a `MaxActivationDistance` of about 8–10 studs. Handle
  `Triggered` in a server Script.

## Pickup

- Anchored, `CanCollide` off, `CanTouch` on for a touch pickup or a
  `ProximityPrompt` for a deliberate one. The server removes it or hides it,
  awards the item once per player, and ignores repeated touches.

## Evidence

Read the assembly back: the root, `PrimaryPart`, a weld on every piece,
anchoring and collision as planned. Then playtest the interaction and report
what was used, what happened, and the output. A static screenshot is not
evidence that a tool works.
