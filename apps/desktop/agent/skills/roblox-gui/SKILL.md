---
name: roblox-gui
description: "Use when a Roblox UI task materially needs engine behavior: container choice, responsive containment, layout objects and constraints, gamepad/touch input, safe areas, lifecycle, scrolling, state ownership, or game wiring. roblox-ui-design owns visual composition and geometry."
last_reviewed: 2026-09-13
sources:
  - https://create.roblox.com/docs/ui
  - https://create.roblox.com/docs/ui/position-and-size
  - https://create.roblox.com/docs/input
  - https://create.roblox.com/docs/reference/engine/classes/GuiService
  - https://create.roblox.com/docs/reference/engine/classes/GuiObject
  - https://create.roblox.com/docs/reference/engine/classes/ScreenGui
  - https://create.roblox.com/docs/projects/server-authority
  - https://create.roblox.com/docs/input/input-action-system
  - https://raw.githubusercontent.com/Roblox/focus-navigation/main/README.md
  - https://devforum.roblox.com/t/introducing-improvements-to-directional-ui-selection-on-gamepad/3864317
  - https://devforum.roblox.com/t/what-are-the-best-ui-screeninset-settings-for-buttons/3519333
  - https://devforum.roblox.com/t/screenguiscreeninsets-topbarinsets-regression/4047230
  - https://raw.githubusercontent.com/Roblox/react-luau/main/README.md
  - original
---

# roblox gui

## When to Load

Load this skill only for the engine side of UI when the request materially needs container behavior, responsive containment, input/focus, safe areas, scrolling/lifecycle, state ownership, or game wiring. A straightforward static visual screen already covered by `roblox-ui-design` does not need this skill.

Building or editing the visual composition of a screen is `roblox-ui-design`'s job. When a recovered SIM/STUDS theme+layout body is active, that body owns panel/card geometry, density, placement, and visual construction.

## Quick Reference

- Use `ScreenGui` for screen overlays, `SurfaceGui` for a surface, and `BillboardGui` for floating world labels.
- Let `UIListLayout`, `UIGridLayout`, and constraints own repeated layout. Avoid per-frame pixel positioning.
- When `roblox-ui-design` supplies viewport-relative Scale measurements, interpret them directly against the ScreenGui/viewport. Do not insert an arbitrary fixed design canvas that changes their meaning.
- Use Scale for responsive outer structure and Offset for deliberate padding/fixed details unless the active UI-design body says otherwise.
- A uniform root `UIScale` is appropriate only when an explicit reference-image reconstruction or exact packaged template calls for a fixed pixel-authored composition. It is not the default responsive strategy for ordinary selected layouts.
- Design for touch and gamepad as well as mouse/keyboard when the request needs those input modes. Bind gameplay actions with `ContextActionService` where it fits.
- For gamepad UI, define a selected entry point and deliberate directional behavior. `GuiService.SelectedObject` plus `Selectable` is the native baseline.
- Keep UI state separate from the server state that it displays. A button is not an authority boundary.
- In Server Authority projects, durable inventory/currency/ownership displays stay tied to confirmed state.
- Make scrolling, text growth, clipping, and safe-area behavior explicit before adding polish.

**Need the details?** Load `references/full.md` only when the task actually needs the deeper engine/UI behavior guidance.
