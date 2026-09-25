# Recovered selected body: SIM / admin-control-panel

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="admin-control-panel")

# LAYOUT guide: admin-control-panel

For: admin panels, staff/mod/owner panels, event and troll panels, developer spawn tools: any restricted console where an operator runs commands on the game or on another player. NOT for shops, settings dialogs, or player-facing menus.

The defining trait: **a two-pane console: an in-panel sidebar of category buttons on the left, a dense grid of labeled command buttons on the right.** Commands are plain labeled buttons, never cards: no art, no price, no description line.

## Measurements (1080p)

- Panel: wrapper+shadow+card scaffold, centered, `Size = UDim2.new(1, 0, 0.4, 120)`, `UIAspectRatioConstraint.AspectRatio = 1.95` (~56% x 51% of screen).
- Straddling title ("Admin!"), side icon LOCKED against the title text (parented to the title label per the scaffold, never parked at the panel corner), straddling close button: per the style guide.
- Copy THIS skeleton (requires the scaffold's `makeStickerButton`). The rail hugs its buttons (no dead grey slab below them), the target box is a labeled dark inset with placeholder text, and the 3-column command grid fills the pane:

  ```lua
  local CATEGORIES = { "Actions", "Players", "Fun", "World" } -- at least 3; a 2-tab rail reads as dead space
  local ACTIVE_CATEGORY = "Actions" -- always the action-command page, never Players

  local rail = Instance.new("Frame")
  rail.BackgroundColor3 = Color3.new(1, 1, 1)
  rail.Position = UDim2.new(0, 20, 0, 78)
  rail.Size = UDim2.new(0.28, 0, 0, 0)
  rail.AutomaticSize = Enum.AutomaticSize.Y -- the rail ends where its buttons end
  rail.Parent = card
  local railCorner = Instance.new("UICorner")
  railCorner.CornerRadius = UDim.new(0.055, 0)
  railCorner.Parent = rail
  local railGrad = Instance.new("UIGradient")
  railGrad.Rotation = -90
  railGrad.Color = ColorSequence.new(Color3.fromRGB(230, 230, 230), Color3.fromRGB(255, 255, 255))
  railGrad.Parent = rail
  local railPad = Instance.new("UIPadding")
  railPad.PaddingTop = UDim.new(0, 10)
  railPad.PaddingBottom = UDim.new(0, 10)
  railPad.PaddingLeft = UDim.new(0, 8)
  railPad.PaddingRight = UDim.new(0, 8)
  railPad.Parent = rail
  local railStack = Instance.new("UIListLayout")
  railStack.Padding = UDim.new(0, 8)
  railStack.SortOrder = Enum.SortOrder.LayoutOrder
  railStack.Parent = rail
  for i, categoryName in ipairs(CATEGORIES) do
      local color = categoryName == ACTIVE_CATEGORY and "green" or "grey"
      local tab = makeStickerButton(rail, color, categoryName, UDim2.new(1, 0, 0, 52))
      tab.LayoutOrder = i
  end

  local pane = Instance.new("Frame")
  pane.BackgroundTransparency = 1
  pane.Position = UDim2.new(0.32, 0, 0, 78)
  pane.Size = UDim2.new(0.68, -20, 1, -98)
  pane.Parent = card

  local targetBox = Instance.new("TextBox")
  targetBox.BackgroundColor3 = Color3.new(0, 0, 0)
  targetBox.BackgroundTransparency = 0.75
  targetBox.Size = UDim2.new(0.7, 0, 0, 46)
  targetBox.Font = Enum.Font.FredokaOne
  targetBox.Text = ""
  targetBox.PlaceholderText = "Player name..."
  targetBox.PlaceholderColor3 = Color3.fromRGB(200, 200, 210)
  targetBox.TextColor3 = Color3.new(1, 1, 1)
  targetBox.TextScaled = true
  targetBox.Parent = pane
  local targetCorner = Instance.new("UICorner")
  targetCorner.CornerRadius = UDim.new(0.125, 0)
  targetCorner.Parent = targetBox
  local targetPad = Instance.new("UIPadding")
  targetPad.PaddingLeft = UDim.new(0, 12)
  targetPad.PaddingTop = UDim.new(0, 8)
  targetPad.PaddingBottom = UDim.new(0, 8)
  targetPad.Parent = targetBox

  local COMMANDS = { -- the ACTIVE page; red = destructive, blue/green = everything else
      { "Kick", "red" }, { "Ban", "red" }, { "Freeze", "red" },
      { "Unfreeze", "green" }, { "Fly", "blue" }, { "Teleport To", "blue" },
  }
  local gridFrame = Instance.new("Frame")
  gridFrame.BackgroundTransparency = 1
  gridFrame.Position = UDim2.new(0, 0, 0, 54)
  gridFrame.Size = UDim2.new(1, 0, 1, -54)
  gridFrame.Parent = pane
  local grid = Instance.new("UIGridLayout")
  local rowCount = math.ceil(#COMMANDS / 3)
  local cellHeight = rowCount <= 2 and 145 or rowCount == 3 and 96 or 64
  grid.CellSize = UDim2.new(0.313, 0, 0, cellHeight)
  grid.CellPadding = UDim2.new(0.03, 0, 0, 10)
  grid.SortOrder = Enum.SortOrder.LayoutOrder
  grid.Parent = gridFrame
  for i, command in ipairs(COMMANDS) do
      local button = makeStickerButton(gridFrame, command[2], command[1], UDim2.new())
      button.LayoutOrder = i
  end
  ```

  - AmountBox (only when a command takes a number): `Size = UDim2.new(0.28, 0, 0, 46)` right-aligned beside TargetBox, same dark-inset construction.
  - One command per `makeStickerButton`, TextScaled label only. NEVER a card: no ImageLabel, no icon, no price, no description child.

## Rules

- One page of commands per category; ONLY the active category's page exists under CommandScroll at any moment.
- Color encodes danger: destructive commands (kick, ban, freeze, jail, kill) get the RED-PINK gradient; every other command a non-red gradient (green, blue, or grey by grouping).
- The highlighted category MUST be the one whose commands are on screen.
- Commands are label-only buttons: a spawnables category uses the same grid, never cards or art.
- The grid plus TargetRow FILL the pane: a dead band under the grid means H is one step too small.
- Categories live in the LEFT sidebar: never a top tab strip, never a dropdown.
- Player targeting: player names are ordinary label-only buttons in the same 3-column grid under a "Players" category; clicking one writes the name into TargetBox.Text. Pad the Players page with demo names to at least 6 entries.
- The DEFAULT ACTIVE category on build is the action-command category (Kick / Ban / Fly / ...), never the Players page.
