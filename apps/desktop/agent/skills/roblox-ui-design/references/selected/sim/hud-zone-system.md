# Recovered selected body: SIM / hud-zone-system

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="hud-zone-system")

# LAYOUT guide: hud-zone-system

For: the always-on gameplay HUD (also called active-hud-overlay): currency and stat readouts, round timers and objectives, side button stacks that open menus, health/stamina bars, buff chips, action buttons. NOT for menus, shops, dialogs, any screen that blocks play, a labeled sidebar nav menu asked for on its own (vertical-navigation-sidebar), or toast stacks (notification-alert).

The defining trait: **edge-anchored zones around an empty play area.** The HUD never owns the screen; it lines the edges of it. Every element belongs to exactly one zone container, zones never touch each other, and the middle of the screen stays clear.

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

- Every zone is a transparent Frame anchored to its screen corner or edge, holding its children with a UIListLayout. Elements are never positioned individually against the screen. Zone POSITIONS use Scale; element sizes are the fixed px below, like every other sim guide.
- Safe inset >= 2% of screen width/height; zone gaps >= 2% screen width; the middle 50% x 50% of the screen contains no HUD element; no zone wider than 22% of screen width except top-center and bottom-center (up to 40%).
- Roblox core-UI keep-out: the engine renders its own menu button and chat/mic unibar in the top-left corner, on top of everything. NOTHING may render inside the rectangle from the top-left corner to 350px right and 70px down. The top-left zone therefore anchors at EXACTLY `UDim2.new(0, 12, 0, 80)` as in the skeleton — the y is a pixel OFFSET >= 80, never a scale value (the engine bar is fixed-height, so scale values shrink under it on small screens) and never a smaller offset. An element overlapping the engine's top-left controls is a structural defect.
- Copy THIS skeleton (requires the style guide's `makeStickerButton`; `gui` is a plain ScreenGui, ZIndexBehavior Sibling, IgnoreGuiInset true, NO card). The holders are sized so labels stay INSIDE them — a label escaping its holder is a measured structural fail:

  ```lua
  local function zone(anchor, position, size)
      local frame = Instance.new("Frame")
      frame.BackgroundTransparency = 1
      frame.AnchorPoint = anchor
      frame.Position = position
      frame.Size = size
      frame.Parent = gui
      local stack = Instance.new("UIListLayout")
      stack.Padding = UDim.new(0, 12)
      stack.SortOrder = Enum.SortOrder.LayoutOrder
      stack.Parent = frame
      return frame
  end

  local function currencyChip(parent, amount)
      local chip = Instance.new("Frame")
      chip.BackgroundColor3 = Color3.new(1, 1, 1)
      chip.Size = UDim2.new(0, 260, 0, 54)
      chip.Parent = parent
      local chipCorner = Instance.new("UICorner")
      chipCorner.CornerRadius = UDim.new(0.45, 0)
      chipCorner.Parent = chip
      local chipStroke = Instance.new("UIStroke")
      chipStroke.Color = NAVY
      chipStroke.Thickness = 4
      chipStroke.Parent = chip
      local icon = Instance.new("ImageLabel")
      icon.BackgroundTransparency = 1
      icon.ScaleType = Enum.ScaleType.Fit
      -- currency icon from the icons-and-images catalog, full color, no tint;
      -- it pokes slightly past the pill's left edge by design
      icon.AnchorPoint = Vector2.new(0, 0.5)
      icon.Position = UDim2.new(0, -8, 0.5, 0)
      icon.Size = UDim2.fromOffset(44, 44)
      icon.Parent = chip
      local amountLabel = Instance.new("TextLabel")
      amountLabel.BackgroundTransparency = 1
      amountLabel.Font = Font.new("rbxassetid://11702779409", Enum.FontWeight.Bold)
      amountLabel.Text = amount
      amountLabel.TextColor3 = NAVY
      amountLabel.TextScaled = true
      amountLabel.TextXAlignment = Enum.TextXAlignment.Left
      amountLabel.Position = UDim2.new(0, 48, 0, 10)
      amountLabel.Size = UDim2.new(1, -60, 1, -20)
      amountLabel.Parent = chip
      return chip
  end

  local function railButton(parent, colorName, labelText)
      local holder = Instance.new("Frame") -- sized to button + label: the label stays INSIDE
      holder.BackgroundTransparency = 1
      holder.Size = UDim2.new(1, 0, 0, 118)
      holder.Parent = parent
      local button = makeStickerButton(holder, colorName, "", UDim2.fromOffset(86, 86))
      button.AnchorPoint = Vector2.new(0.5, 0)
      button.Position = UDim2.new(0.5, 0, 0, 0)
      local icon = Instance.new("ImageLabel")
      icon.BackgroundTransparency = 1
      icon.ScaleType = Enum.ScaleType.Fit
      -- full-color catalog icon, no tint
      icon.AnchorPoint = Vector2.new(0.5, 0.5)
      icon.Position = UDim2.new(0.5, 0, 0.5, 0)
      icon.Size = UDim2.fromOffset(48, 48)
      icon.Parent = button
      local label = Instance.new("TextLabel")
      label.BackgroundTransparency = 1
      label.Font = Enum.Font.FredokaOne
      label.Text = labelText
      label.TextColor3 = Color3.new(1, 1, 1)
      label.TextScaled = true
      label.AnchorPoint = Vector2.new(0.5, 1)
      label.Position = UDim2.new(0.5, 0, 1, 0)
      label.Size = UDim2.new(1, 0, 0, 26)
      label.Parent = holder
      local labelStroke = Instance.new("UIStroke")
      labelStroke.Color = Color3.new(0, 0, 0)
      labelStroke.Thickness = 3
      labelStroke.Parent = label
      return holder
  end

  -- y = 80 OFFSET, never scale and never less: 0-70px down is the engine's
  -- own top-left control band (see keep-out rule) and chips placed there
  -- render under the Roblox menu button.
  local topLeft = zone(Vector2.new(0, 0), UDim2.new(0, 12, 0, 80), UDim2.new(0, 260, 0, 130))
  currencyChip(topLeft, "12,450")
  currencyChip(topLeft, "850")

  local leftRail = zone(Vector2.new(0, 0.5), UDim2.new(0.02, 0, 0.5, 0), UDim2.new(0, 110, 0, 260))
  railButton(leftRail, "green", "Shop")
  railButton(leftRail, "blue", "Inventory")

  local settings = makeStickerButton(gui, "blue", "", UDim2.fromOffset(86, 86))
  settings.AnchorPoint = Vector2.new(1, 0)
  settings.Position = UDim2.new(0.98, 0, 0.03, 0)
  -- add a gear icon child exactly like railButton's icon

  local track = Instance.new("Frame")
  track.BackgroundColor3 = Color3.new(0, 0, 0)
  track.BackgroundTransparency = 0.5
  track.AnchorPoint = Vector2.new(0, 1)
  track.Position = UDim2.new(0.02, 0, 0.97, 0)
  track.Size = UDim2.new(0, 420, 0, 38)
  track.Parent = gui
  local trackCorner = Instance.new("UICorner")
  trackCorner.CornerRadius = UDim.new(1, 0)
  trackCorner.Parent = track
  local trackStroke = Instance.new("UIStroke")
  trackStroke.Color = NAVY
  trackStroke.Thickness = 4
  trackStroke.Parent = track
  local fill = Instance.new("Frame")
  fill.BackgroundColor3 = Color3.new(1, 1, 1)
  fill.Size = UDim2.new(0.85, 0, 1.1, 0)
  fill.Parent = track
  local fillCorner = Instance.new("UICorner")
  fillCorner.CornerRadius = UDim.new(1, 0)
  fillCorner.Parent = fill
  local fillGrad = Instance.new("UIGradient")
  fillGrad.Rotation = -90
  fillGrad.Color = ColorSequence.new(Color3.fromRGB(92, 239, 0), Color3.fromRGB(163, 253, 28))
  fillGrad.Parent = fill
  local fillStroke = Instance.new("UIStroke")
  fillStroke.Color = NAVY
  fillStroke.Thickness = 3
  fillStroke.Parent = fill
  local healthValue = Instance.new("TextLabel") -- BARE label ON the track, never a boxed chip
  healthValue.BackgroundTransparency = 1
  healthValue.Font = Enum.Font.FredokaOne
  healthValue.Text = "85/100"
  healthValue.TextColor3 = Color3.new(1, 1, 1)
  healthValue.TextScaled = true
  healthValue.Size = UDim2.new(1, 0, 0.9, 0)
  healthValue.Position = UDim2.new(0, 0, 0.05, 0)
  healthValue.ZIndex = 3
  healthValue.Parent = track
  local healthValueStroke = Instance.new("UIStroke")
  healthValueStroke.Color = Color3.new(0, 0, 0)
  healthValueStroke.Thickness = 3
  healthValueStroke.Parent = healthValue
  ```

- Timer / objective (top-center): the `currencyChip` construction at ~18% screen width, content centered as a group, dark navy text.
- Bottom-center action buttons: at most 4 `makeStickerButton`s in a row, each ~11% x ~8%, ~2% screen width gaps.
- Each currency uses a DIFFERENT icon; the icon is required.

## Rules

- No backdrop, no scrim, no dimming: the world stays fully visible. A full-screen background frame is a defect (that is fullscreen-landing).
- No card, no title, no close button. A HUD is always on.
- Every element lives inside a zone container; zones never overlap; no two elements overlap.
- The center stays empty (a crosshair is the one exception, only when asked).
- Compact over large: if an element could shrink and still read, shrink it.
- At most 6 zones in use: pick the zones the task names.
