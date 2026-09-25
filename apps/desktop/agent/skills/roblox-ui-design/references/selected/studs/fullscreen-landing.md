# Recovered selected body: STUDS / fullscreen-landing

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="fullscreen-landing")

# LAYOUT guide: fullscreen-landing

For: main menus, title screens, play screens, intro/warning screens, loading screens, round-start and respawn screens: any screen that fills the display and blocks the game view. NOT for shops, dialogs, inventories, HUDs, or click-to-earn screens over the visible world (incremental-clicker).

The defining trait: **the screen is the panel, and one action dominates.** There is no bordered center panel and no title bar. The composition is anchored to the screen itself in three horizontal zones: a big title lockup on top, one large primary button in the middle, small secondary buttons under it. Hierarchy is the point here: after the title, the primary action is the biggest thing on screen.

## Measurements (1080p)

- The ScreenGui has EXACTLY `IgnoreGuiInset = true`: without it the backdrop
  stops at the topbar and a strip of raw world shows along the top of the
  screen, which fails the eval outright.
- Backdrop: one full-screen Frame with EXACTLY `BackgroundColor3 = Color3.new(0, 0, 0)` and `BackgroundTransparency = 0.18`, lowest ZIndex. Grey backdrops (any channel above 0.2) are a defect — three consecutive runs shipped grey; the color is literal black. This is LOWER (more opaque) than the style guide's 0.40 panel background on purpose: a landing screen blocks the world, it does not tint it. Above 0.30 the scene still reads through, which is a defect.
- Composition: everything centers on screen center-x and stays inside the center 70% of screen width. Size and position in Scale, never offset, so the screen holds at other aspect ratios.
- Zone A, screen y 0-35%: the title lockup. Title box ~70% screen width x ~16% screen height, centered at y ~0.19: a BARE TextLabel, no plate and no bar behind it, FredokaOne TextScaled, white->gold rot90 gradient, black stroke 3. The glyphs must RENDER at >= 11% screen height (see the TextScaled cap in the style guide's hard rules); rendered width follows the string, so a short title is narrower than the box and that is correct. Optional one-line tagline directly under it, ~35% screen width x ~4% screen height, white + stroke 2.5. Optional sunburst underlay centered on the title (Crop, aspect 1, ~1.4x the title's RENDERED width, ImageTransparency ~0.75, below the text ZIndex): it stays inside Zone A and never reaches the action group.
- Zone B, screen y 35-75%: the action group, centered as a group.
  - Primary button: ~26% screen width x ~11% screen height, centered at y ~0.50. Green face, canonical button construction from the style guide.
  - Secondary buttons: 2 to 4 in ONE centered row, each ~13% screen width x ~7% screen height, ~2% screen width between them. The gap between the primary's bottom edge and the secondary row's top edge is ~7% of screen height, and NEVER less than 5%: the primary must read as its own object, not as the top of a button block. Canonical buttons; one color per action.
  - Size ratio: the primary is at least 1.5x the height and 1.8x the width of a secondary. Buttons of equal size are a defect.
- Zone C, screen y 75-100%: empty. Optional one bare footer line (version, credit) at y ~0.95, ~3% screen height.
- Corner slots (optional): up to 2 square icon buttons, aspect 1, ~7% screen height, inset ~2% from a screen corner, for settings or credits.
- Breathing room: >= 8% screen height empty above the title lockup.

## Loading variant

Same backdrop and title lockup as the main menu, no buttons at all: one progress bar (~50% screen width x ~5% screen height, centered, top edge at y ~0.64, progress-bar construction from the style guide) and one bare status line under it at ~3.5% screen height. A loading screen with action buttons is a defect.

Exact properties the loading variant keeps getting wrong:
- The backdrop is the SAME black low-transparency frame as the main menu. A white or bright backdrop is a defect.
- The title stays a BARE TextLabel with the white-to-gold gradient. Putting the title on a banner, plate, or bar is a defect on this screen exactly as on the main menu.

## Rules

- No panel, no title bar, no close button: this is the one screen type with none of them. A bordered center panel with a header bar here is a defect (that is centered-dialog). Exception: a screen the player can dismiss back into gameplay gets ONE close button in the top-right SCREEN corner, style-guide construction, ~7% screen height, inset 2%.
- One primary action only. Two same-size CTAs side by side is a defect.
- Button budget: 1 primary, at most 4 secondary, at most 2 corner icon buttons. A vertical list of 6+ equal buttons is a defect.
- Nothing spans the screen: no element wider than 30% screen width except the title lockup, the tagline, and the backdrop.
- The title carries the screen. Rendered glyph height below 10% screen height is a defect. Width follows the string: never stretch, letter-space, or pad a title to hit a width number.
- Text is bare glyphs plus stroke at this scale too: no boxes, plates, or outlines around any label.
- The gaps between zones are the composition, not leftovers. When unsure, add space, not size.
