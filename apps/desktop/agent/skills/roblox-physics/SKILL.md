---
name: roblox-physics
description: "Use when building Roblox vehicles, ragdolls, projectiles, elevators, constraints, forces, or other physics-driven gameplay."
last_reviewed: 2026-07-26
sources:
  - https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/physics/mechanical-constraints.md
  - https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/physics/mover-constraints.md
  - https://create.roblox.com/docs/projects/server-authority
---

# Roblox Physics

## When to Load

Use this skill when building physics-driven gameplay: vehicles, ragdolls, projectiles, mechanical contraptions, elevators, swinging platforms, or anything using constraints and forces.

## Quick Reference

### Constraint Types
**Mechanical:** `HingeConstraint`, `PrismaticConstraint`, `CylindricalConstraint`, `BallSocketConstraint`, `UniversalConstraint`, `WeldConstraint`/`RigidConstraint`
**Motion:** `AlignPosition`, `AlignOrientation`, `LinearVelocity`, `AngularVelocity`, `VectorForce`, `Torque`
**Spring/Rope:** `SpringConstraint`, `RopeConstraint`, `RodConstraint`

### Attachment Pattern
Constraints connect via `Attachment` objects. Create one on each part, set `Attachment0`/`Attachment1`, and parent the constraint to part0. Actuator types include `None`, `Motor`, and `Servo`.

### Vehicles
Vehicles: use motorized `HingeConstraint` wheels, `SpringConstraint` suspension, servo steering, and `CustomPhysicalProperties` for friction tuning.

### Ragdoll
Replace Motor6Ds with `BallSocketConstraint`: create Attachments from motor.C0/C1, set `LimitsEnabled=true`, `UpperAngle=45`. Keep Root Motor6D for HRP. Set humanoid state to `Physics`. Re-enable motors to recover.

### Authority and Network Ownership
Classic projects: automatic ownership can give an unanchored assembly to a nearby player. `SetNetworkOwner(nil)` keeps it server-owned; `SetNetworkOwner(player)` gives a player simulation ownership. Treat player-owned physics as untrusted and validate gameplay outcomes.

Server Authority: set `Workspace.AuthorityMode = Server` with its required settings. Core objects can remain server-owned while prediction keeps controls responsive, so the classic secure-but-laggy trade-off does not apply. `SetNetworkOwner()` is not a substitute.

**Rule:** choose the model first. Keep NPC and gameplay-critical objects authoritative; give client ownership to non-critical physics only when the resulting behavior is acceptable and tested.

**Testing player-owned physics in a playtest:** an assembly a player owns is simulated on that player's client, and its seat's `Throttle` and `Steer` come from that client's input. Drive it from the `client-1` peer, not by setting values on the server, which the owner overwrites. Hold the input and measure in the same call, since speed read after the input ends is zero whether the controls work or not. Read speed from `AssemblyLinearVelocity` on the owning client. Once a behaviour is measured working, record it and move on rather than re-testing it another way.

### Common Gotchas
- Constraints do nothing on Anchored parts
- Both Attachment0 AND Attachment1 required (missing one = silent fail)
- Over-constraining = jitter. Tune mass with `CustomPhysicalProperties`
- Use Raycast for hitscan, `Touched` only for slow physics projectiles
- Always set lifetime on physics projectiles (forgotten ones kill perf)
**Need more detail?** Load `references/full.md` for the complete reference with code examples, API tables, and edge cases.
