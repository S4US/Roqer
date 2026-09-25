# Recovered selected body: STUDS / hud-zone-system

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="hud-zone-system")

# LAYOUT guide: hud-zone-system

For: the always-on gameplay HUD (also called active-hud-overlay): currency and stat readouts, round timers and objectives, side button stacks that open menus, health/stamina bars, buff chips, action buttons. NOT for menus, shops, dialogs, any screen that blocks play, a labeled sidebar nav menu asked for on its own (vertical-navigation-sidebar), or toast stacks (notification-alert).

The defining trait: **edge-anchored zones around an empty play area.** The HUD never owns the screen; it lines the edges of it. Every element belongs to exactly one zone container, zones never touch each other, and the middle of the screen stays clear because that is where the game is.

## Zones

Treat the screen as a 3x3 grid of anchor zones. The CENTER cell is not a zone: it stays empty. Use only the zones the task needs; most HUDs use three or four.

- top-left: currency and stat chips, stacked vertically. This zone starts BELOW the Roblox core UI (see the keep-out rule) — never in the corner itself.
- top-center: round timer, objective, or stage counter. One element.
- top-right: menu icon buttons (settings, map, invite), in a row.
- left / right: vertical icon-button stacks (shop, inventory, rewards, teleports).
- bottom-left: health/stamina bars or buff chips.
- bottom-center: action buttons or a hotbar.
- bottom-right: secondary readouts.

## Measurements (1080p)

- Every zone is a transparent Frame (BackgroundTransparency 1) anchored to its screen corner or edge, holding its children with a UIListLayout. Elements are never positioned individually against the screen.
- Safe inset: every zone sits >= 2% of screen width/height inside the viewport edge. Nothing bleeds off screen.
- Roblox core-UI keep-out: the engine renders its own menu button and chat/mic unibar in the top-left corner, on top of everything. NOTHING may render inside the rectangle from the top-left corner to 350px right and 70px down. The top-left zone therefore anchors its y at a 70px OFFSET (`UDim2.new(0.02, 0, 0, 70)`), never a small scale value (the engine bar is fixed-height, so scale values shrink under it on small screens). An element overlapping the engine's top-left controls is a structural defect.
- Zone gaps: zones keep >= 2% screen width between each other. Two zones that touch or overlap are a defect.
- Center keep-out: the middle 50% width x 50% height of the screen contains no HUD element.
- Zone footprint: no zone is wider than 22% of screen width, except top-center and bottom-center which may reach 40%.
- Stat/currency chip: bar construction from the style guide, ~16% screen width x ~5.5% screen height, icon (Fit, aspect 1, ~70% of chip height) at the left, gradient value text beside it, ~1.5% screen height gaps in the stack. The icon is REQUIRED: a chip showing a bare number with no icon is a defect, and each currency uses a different icon so two chips are never told apart by their number alone.
- Icon buttons: canonical button construction with EXACTLY `Size = UDim2.new(0.045, 0, 0.08, 0)` plus a UIAspectRatioConstraint (`AspectRatio = 1`, `DominantAxis = Enum.DominantAxis.Height`) — that is an 86px square at 1080p. The icon ImageLabel is centered with an explicit `UDim2.fromOffset(48, 48)` (55-60% of button height). Oversized squares (>=10% screen height), portrait rectangles, or an icon smaller than half the button height are defects. ~1.5% screen height gaps in the stack. A label under an icon button, if any, is a bare stroked TextLabel.
- Timer / objective (top-center): ~18% screen width x ~7% screen height, bar construction, content centered as a group.
- Bars (health/stamina): ~22% screen width x ~3.5% screen height, stacked with ~1% gaps. Build EXACTLY: track Frame with `BackgroundColor3 = Color3.fromRGB(35, 30, 45)`, `UIStroke` thickness 4 black, `UICorner` ~0.35 scale; fill Frame inside with a saturated gradient face (green for health, blue or yellow for stamina) sized `UDim2.new(value / max, 0, 1, 0)`; value label a white TextLabel with black glyph stroke centered ON the bar. A flat black rectangle with plain unstroked text is not a bar; it is a defect.
- Bottom-center action buttons: at most 4 in a row, each ~11% screen width x ~8% screen height, ~2% screen width gaps.
- Size and position in Scale, never offset: the HUD must hold on phone aspect ratios.

## Rules

- No backdrop, no scrim, no dimming: the world stays fully visible behind the HUD. A full-screen background frame is a defect (that is fullscreen-landing).
- No panel, no title bar, no close button. A HUD is always on.
- Every element lives inside a zone container. An element positioned with its own ad-hoc offsets, outside any zone, is a defect: this is what makes HUDs collide as they grow.
- Zones never overlap, and no two elements overlap. Overlap is the single most common complaint about generated HUDs.
- The center stays empty. A HUD element in the middle of the screen is a defect (a crosshair is the one exception, and only when the task asks for one).
- Compact over large: HUD elements are read at a glance while playing. If an element could shrink and still read, shrink it.
- At most 6 zones in use. A HUD that fills every edge is a defect: pick the zones the task names.
