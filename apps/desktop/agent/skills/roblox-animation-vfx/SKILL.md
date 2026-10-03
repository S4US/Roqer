---
name: roblox-animation-vfx
description: "Use when implementing Roblox character animations, particles, beams, trails, tweens, camera shake, or other visual effects."
last_reviewed: 2026-10-02
sources:
  - https://create.roblox.com/docs/animation/using
  - https://create.roblox.com/docs/reference/engine/classes/Animator
  - https://create.roblox.com/docs/reference/engine/classes/ParticleEmitter
  - https://create.roblox.com/docs/effects/particle-emitters
  - https://create.roblox.com/docs/reference/engine/classes/Beam
  - https://create.roblox.com/docs/reference/engine/classes/Trail
  - https://create.roblox.com/docs/performance-optimization/improve
  - https://docs.zilibobi.dev/vfx-forge/effects/particle/
  - https://create.roblox.com/docs/reference/engine/classes/TweenService
  - https://create.roblox.com/docs/projects/server-authority
  - https://create.roblox.com/docs/projects/server-authority/techniques
  - original
---

# roblox animation and vfx

## When to Load

Load when implementing character animation, particle or beam effects, tweens, camera feedback, or visual cleanup.

## Quick Reference

- To author a new R15 or R6 animation in Roqer, use the `animation` tool and load `references/character-animation.md` first: it has the pose format, how to animate a held weapon, and tested recipes to adapt (R15 wave, idle, walk, run, jump, sword slash and lunge; R6 walk and wave). Use `aimAt` to plant feet and put hands on things, and `grounded: true` for anything done standing. Check which rig the place's players use first. For an NPC, its NPCs section makes a stock body with `rig` and has the model's loader play its idle and walk.
- For a creature or any model that is not a stock body (a dog, a spider, a snake, a bird, an octopus), also load `references/creature-animation.md`: `rig` joins its loose pieces into a rig or adopts the rig it has, `waves` sway tails, tentacles, wings and spines, `gait` walks any number of legs, and it has tested recipes (a dog's idle, walk, trot and run, a six-legged walk, a slither, a wing flap).
- To build any visual effect (a hit, slash, explosion, spell, aura or pickup), load `references/vfx-design.md` and `references/vfx-craft.md` with the topics below that the effect needs: ask for them all in one call, and load in a second call whatever the first could not carry. The two cover what experienced Roblox VFX artists do, measured from their published effects (what the move is for, a fixed palette, dark layers and dim twins for value, brightness against the place's bloom, single-sprite layers, the intensity curve of timing); the emit module that plays effects from `EmitCount`/`EmitDelay`/`EmitDuration` attributes; layer skeletons and `build_instances` examples; and how to check an effect in slow motion. The topics:
  - `references/vfx-textures.md`: drawing the effect's own hard-edged textures and flipbooks in Blender, previewing them in Studio and uploading them. Most effects should.
  - `references/vfx-motion.md`: anything that travels, sweeps or is held: projectiles, volleys, trails, beams, slashes, dashes, teleports, orbs, sigils and auras.
  - `references/vfx-mesh-shapes.md`: mesh effects (crescent meshes, shockwave rings, swirls, domes, ground waves) and making their shapes in Blender.
  - `references/vfx-camera-world.md`: camera shake, field of view, blur and impact frames, lights, craters and scorch marks, and a cast pose on the character.
  - `references/vfx-rendered-flipbooks.md`: a flipbook rendered from a 3D scene rather than drawn.

  Roqer writes the emit module (`templates/vfx/emit.lua`) into the place itself, as `references/vfx-craft.md` explains, so load it only to change it.
- Load tracks through an `Animator` on a `Humanoid` or `AnimationController`; set `AnimationTrack.Priority` deliberately.
- Use `GetMarkerReachedSignal()` for named gameplay or presentation cues, then disconnect or replace the listener when the track ends. The `animation` tool writes the markers it listens for from a keyframe's `markers`; a keyframe's `name` is not a marker.
- A burst `ParticleEmitter` usually has `Rate = 0` and uses `:Emit(count)` with a bounded lifetime; use pooling for frequent effects.
- Beams and trails need two attachments with a stable world-space relationship and a cleanup owner.
- Tween a bounded set of properties with `TweenService:Create`; cancel or destroy temporary effects when their owner ends, and use `Debris:AddItem` for simple lifetimes.
- In Server Authority projects, keep synchronized animation logic in `RunService:BindToSimulation()` (requires `Workspace.UseFixedSimulation` enabled in Studio), query current tracks instead of caching handles across rollback, and make predicted effects reversible.
- Profile particle counts, lights, post-processing, and per-frame camera work on the target device class.

**Need the details?** Load `references/character-animation.md` to author a character animation, `references/creature-animation.md` to rig and animate a creature, [VFX design](references/vfx-design.md) and [VFX craft](references/vfx-craft.md), with the topics above, to build a visual effect ([the emit module](templates/vfx/emit.lua) only to change it), and `references/full.md` for animation playback and runtime effect patterns.
