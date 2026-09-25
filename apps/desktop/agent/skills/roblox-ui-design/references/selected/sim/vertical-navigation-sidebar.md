# Recovered selected body: SIM / vertical-navigation-sidebar

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="vertical-navigation-sidebar")

# LAYOUT guide: vertical-navigation-sidebar

For: persistent sidebar menus over gameplay: a vertical stack of labeled nav buttons on a screen edge (Shop, Pets, Rewards, Codes, Settings) where each button opens its own menu. NOT for HUDs with stat readouts or icon-only corner stacks (hud-zone-system), admin category rails (admin-control-panel), or any dialog card.

The defining trait: **an edge-anchored button rail over the visible world.** The rail IS the whole screen's UI: no card, no title, no close button, no backdrop.

## Measurements (1080p)

- Copy THIS skeleton (requires the style guide's `makeStickerButton`; `gui` is a plain ScreenGui, no card). Icon AND label live INSIDE each button — a label escaping its button is a measured structural fail:

  ```lua
  local rail = Instance.new("Frame")
  rail.BackgroundTransparency = 1
  rail.AnchorPoint = Vector2.new(0, 0.5)
  rail.Position = UDim2.new(0.015, 0, 0.5, 0)
  rail.Size = UDim2.new(0, 176, 0, 430)
  rail.Parent = gui
  local railStack = Instance.new("UIListLayout")
  railStack.Padding = UDim.new(0, 13)
  railStack.SortOrder = Enum.SortOrder.LayoutOrder
  railStack.Parent = rail

  local NAV = {
      { "Shop", "green" }, { "Pets", "blue" }, { "Rewards", "green" },
      { "Codes", "blue" }, { "Settings", "blue" }, -- Settings BLUE, never grey
  }
  for i, entry in ipairs(NAV) do
      local button = makeStickerButton(rail, entry[2], "", UDim2.new(1, 0, 0, 74))
      button.LayoutOrder = i
      local icon = Instance.new("ImageLabel")
      icon.BackgroundTransparency = 1
      icon.ScaleType = Enum.ScaleType.Fit
      -- full-color catalog icon, no tint
      icon.AnchorPoint = Vector2.new(0, 0.5)
      icon.Position = UDim2.new(0, 14, 0.5, 0)
      icon.Size = UDim2.fromOffset(40, 40)
      icon.Parent = button
      local label = Instance.new("TextLabel")
      label.BackgroundTransparency = 1
      label.Font = Enum.Font.FredokaOne
      label.Text = entry[1]
      label.TextColor3 = Color3.new(1, 1, 1)
      label.TextScaled = true
      label.TextXAlignment = Enum.TextXAlignment.Left
      label.AnchorPoint = Vector2.new(0, 0.5)
      label.Position = UDim2.new(0, 62, 0.5, 0)
      label.Size = UDim2.new(1, -72, 0, 40)
      label.Parent = button
      local labelStroke = Instance.new("UIStroke")
      labelStroke.Color = Color3.new(0, 0, 0)
      labelStroke.Thickness = 3
      labelStroke.Parent = label
  end
  ```

- Both icon and label are mandatory: an icon-only stack is hud-zone-system, a text-only rail is a defect here.
- Optional notification badge: the style guide's badge construction on a button's top-right corner, ~28% of button height. At most one badge per button.
- Size and position in Scale, never offset: the rail must hold on phone aspect ratios.

## Rules

- No card, no title, no close button, no backdrop: the world stays fully visible. A plate or strip behind the rail is a defect.
- ONE column, vertically centered on the screen edge. A rail pinned into a top corner is a HUD zone; two columns is a menu.
- Buttons are uniform: same width, same height, same construction. A "featured" bigger button is a defect.
- Each button opens its own menu; the rail itself never expands or becomes a panel.
- At most 6 buttons. More destinations means the game needs a menu screen, not a longer rail.
- Compact over large: if the rail could shrink and still read, shrink it.
