# Recovered selected body: STUDS / incremental-clicker

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="incremental-clicker")

# LAYOUT guide: incremental-clicker

For: clicker and tap-to-earn screens: a big click target that grants currency per press, with a running total (cookie-clicker style, tap simulators). NOT for HUDs (hud-zone-system), shops, upgrade menus, or any screen that blocks the world (fullscreen-landing).

The defining trait: **one giant click target dominates, with the total above it.** Everything else is small; the click button is unmistakably THE thing to press, and the world stays visible behind it.

## Measurements (1080p)

- No panel, no title bar, no close button, no backdrop: the composition sits over the visible world.
- Counter lockup, top-center: the running total as a big display number, ~28% screen width x ~9% screen height, centered at y ~0.10, gradient number treatment from the style guide (white->gold rot90), bare glyphs + black stroke. Optional currency icon LEFT of the number (Fit, aspect 1, ~60% of the number's rendered height). Under it one optional bare rate line ("+5 per click", ~3% screen height, white + stroke).
- Click button: square (aspect 1), ~15% screen width, centered at (0.5, 0.60). Canonical style-guide button construction scaled up: bevel base + stroke 4, gradient face, edge-to-edge studs at the button tile size. Face content: currency icon (~45% of button height) above a short TextScaled label ("TAP!"), stacked and centered.
- Size ratio: the click button is at least 2x the height and 2x the width of every other button on screen.
- Optional menu access: at most 2 square icon buttons (aspect 1, ~7% screen height) in the bottom-right corner, inset ~2%, canonical construction. They OPEN shop/upgrade screens; upgrades never render on this screen.
- Static generation hardcodes a believable total (e.g. "12,450"), never zero. Click feedback ("+N" floating labels) and counter updates are behavior for a later wiring task, never part of UI generation.
- Size and position in Scale, never offset: the screen must hold on phone aspect ratios.

## Rules

- The click target is the largest interactive element on screen. A click button under 10% of screen height is a defect.
- The total is a gradient display number, never flat (style guide big-number rule), and it is the only large text on screen.
- No panel chrome anywhere: a clicker inside a bordered panel with a title bar is a defect.
- The world stays visible: no backdrop, no dimming, no full-screen frame.
- The counter and the button never overlap, and neither covers the screen center's remaining play view more than the measurements above allow.
- At most 2 secondary buttons. An upgrade LIST on this screen is a defect: upgrades live in their own screen, opened from a corner button.
