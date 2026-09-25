# Recovered selected body: SIM / fullscreen-landing

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="fullscreen-landing")

# LAYOUT guide: fullscreen-landing

For: main menus, title screens, play screens, intro/warning screens, loading screens, round-start and respawn screens: any screen that fills the display and blocks the game view. NOT for shops, dialogs, inventories, HUDs, or click-to-earn screens over the visible world (incremental-clicker).

The defining trait: **the screen is the panel, and one action dominates.** There is no card and no close button. The composition is anchored to the screen itself in three horizontal zones: a big title lockup on top, one large primary button in the middle, small secondary buttons under it.

## Measurements (1080p)

- ScreenGui: EXACTLY `IgnoreGuiInset = true`: without it a strip of raw world shows along the top and the eval fails outright.
- Backdrop: one full-screen Frame with EXACTLY `BackgroundColor3 = Color3.new(0, 0, 0)` and `BackgroundTransparency = 0.18`, lowest ZIndex. Grey backdrops are a defect; the color is literal black.
- Composition: everything centers on screen center-x and stays inside the center 70% of screen width. Size and position in Scale so the screen holds at other aspect ratios.
- Zone A, screen y 0-35%: the title lockup. Bare FredokaOne TextScaled label ~70% screen width x ~16% screen height centered at y ~0.19, WHITE with navy (42,43,49) glyph stroke 5 (glyphs render >= 11% screen height: see the TextScaled cap in the style guide). The title string ends with an exclamation mark ("Pet Legends!") like every sim title. Optional rainbow gradient for special-event titles only. Optional one-line tagline under it (~35% x ~4%), white + black stroke 3.
- Zone B, screen y 35-75%: the action group, centered as a group. Every button comes from the style guide's `makeStickerButton` (paste the builder even though there is no scaffold here); a flat solid fill is a defect. Copy EXACTLY:

  ```lua
  local play = makeStickerButton(gui, "green", "Play", UDim2.new(0.26, 0, 0.11, 0))
  play.AnchorPoint = Vector2.new(0.5, 0.5)
  play.Position = UDim2.new(0.5, 0, 0.5, 0)

  local secondaries = { { "Shop", "blue" }, { "Settings", "blue" }, { "Credits", "blue" } }
  local rowWidth = #secondaries * 0.13 + (#secondaries - 1) * 0.02
  for i, entry in ipairs(secondaries) do
      local button = makeStickerButton(gui, entry[2], entry[1], UDim2.new(0.13, 0, 0.07, 0))
      button.AnchorPoint = Vector2.new(0, 0.5)
      button.Position = UDim2.new(0.5 - rowWidth / 2 + (i - 1) * 0.15, 0, 0.66, 0)
  end
  ```

  Settings is BLUE like its siblings, never grey: grey means disabled.
  - Size ratio: the primary is at least 1.5x the height and 1.8x the width of a secondary. Equal-size buttons are a defect.
- Zone C, screen y 75-100%: empty. Optional one bare footer line at y ~0.95, ~3% screen height, white + black stroke.
- Corner slots (optional): up to 2 square icon buttons (canonical construction, icon-only), ~7% screen height, inset ~2% from a screen corner.
- Breathing room: >= 8% screen height empty above the title lockup.

## Loading variant

Same backdrop and title lockup, no buttons at all: one style-guide pill progress bar (~50% screen width x ~5% screen height, centered, top edge at y ~0.64) and one bare white stroked status line under it at ~3.5% screen height. A loading screen with action buttons is a defect. The backdrop stays the SAME black low-transparency frame; the title stays a BARE label: never on a plate or banner.

## Rules

- No card, no close button: this is the one screen type with neither. Exception: a screen the player can dismiss back into gameplay gets ONE canonical red-pink close button in the top-right SCREEN corner, ~7% screen height, inset 2%.
- One primary action only. Two same-size CTAs side by side is a defect.
- Button budget: 1 primary, at most 4 secondary, at most 2 corner icon buttons.
- Nothing spans the screen: no element wider than 30% screen width except the title lockup, the tagline, and the backdrop.
- The title carries the screen: rendered glyph height below 10% screen height is a defect. Never stretch or pad a title to hit a width number.
- Text is bare glyphs plus stroke at this scale too: no boxes or plates behind any label.
