# Recovered selected body: SIM / select-screen

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="select-screen")

# LAYOUT guide: select-screen

For: character/skin/class pickers, team select, map or mode select, hero select, job and role pickers: any screen where the player compares a few options and commits to ONE. NOT for shops (those sell), inventories (those manage), or dialogs.

The defining trait: **a row of comparable option tiles, exactly one selected, and a single confirm.** Every tile shows the same fields. Locked options stay visible and dimmed, never hidden.

## Measurements (1080p)

- Panel: wrapper+shadow+card scaffold, centered, `Size = UDim2.new(1, 0, 0.4, 120)`, `UIAspectRatioConstraint.AspectRatio = 1.7` (~49% x 51% of screen).
- Straddling title ("Select!"), side icon LOCKED against the title text (parented to the title label per the scaffold, never parked at the panel corner), straddling close button: per the style guide.
- Option tiles: copy THIS builder (requires the scaffold's `makeStickerButton`). EVERY tile — selected, normal, locked — gets the SAME white cell construction; state changes only the fill wash, stroke weight, or overlay. A row where some options float as bare icons while others have cards is an automatic fail, and so is a tile with zero-size children:

  ```lua
  local TILE_W, TILE_H = 200, 250
  local PETS = {
      { name = "Dog", role = "Loyal Companion", state = "selected" },
      { name = "Cat", role = "Agile Hunter", state = "normal" },
      { name = "Dragon", role = "Fire Breather", state = "normal" },
      { name = "Secret", role = "Mystery Pet", state = "locked" },
  }

  local tileRow = Instance.new("Frame")
  tileRow.BackgroundTransparency = 1
  tileRow.AnchorPoint = Vector2.new(0.5, 0.5)
  tileRow.Position = UDim2.new(0.5, 0, 0.45, 0)
  tileRow.Size = UDim2.new(1, -40, 0, TILE_H)
  tileRow.Parent = card
  local rowStack = Instance.new("UIListLayout")
  rowStack.FillDirection = Enum.FillDirection.Horizontal
  rowStack.HorizontalAlignment = Enum.HorizontalAlignment.Center
  rowStack.Padding = UDim.new(0, 24)
  rowStack.SortOrder = Enum.SortOrder.LayoutOrder
  rowStack.Parent = tileRow

  local function buildTile(order, pet)
      local tile = Instance.new("TextButton") -- the tile IS the click target; never add a button child
      tile.Text = ""
      tile.LayoutOrder = order
      tile.BackgroundColor3 = pet.state == "selected" and Color3.fromRGB(214, 250, 214) or Color3.new(1, 1, 1)
      tile.Size = UDim2.fromOffset(TILE_W, TILE_H)
      tile.Parent = tileRow
      local tileCorner = Instance.new("UICorner")
      tileCorner.CornerRadius = UDim.new(0.08, 0)
      tileCorner.Parent = tile
      local tileStroke = Instance.new("UIStroke")
      tileStroke.Color = NAVY
      tileStroke.Thickness = pet.state == "selected" and 6 or 4
      tileStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border -- the tile is a TextButton: contextual mode renders no outline
      tileStroke.Parent = tile
      local art = Instance.new("ImageLabel")
      art.BackgroundTransparency = 1
      art.ScaleType = Enum.ScaleType.Fit
      -- full-color catalog icon, no tint; set the Image NOW
      art.AnchorPoint = Vector2.new(0.5, 0)
      art.Position = UDim2.new(0.5, 0, 0, 26)
      art.Size = UDim2.fromOffset(110, 110)
      art.Parent = tile
      local name = Instance.new("TextLabel")
      name.BackgroundTransparency = 1
      name.Font = Enum.Font.FredokaOne
      name.Text = pet.name
      name.TextColor3 = NAVY
      name.TextScaled = true
      name.Position = UDim2.new(0, 10, 0, 158)
      name.Size = UDim2.new(1, -20, 0, 30)
      name.Parent = tile
      local role = Instance.new("TextLabel")
      role.BackgroundTransparency = 1
      role.Font = Enum.Font.FredokaOne
      role.Text = pet.role
      role.TextColor3 = Color3.fromRGB(84, 86, 98) -- grey for ALL options, never per-option colors
      role.TextScaled = true
      role.Position = UDim2.new(0, 10, 0, 196)
      role.Size = UDim2.new(1, -20, 0, 22)
      role.Parent = tile
      if pet.state == "locked" then
          local overlay = Instance.new("Frame")
          overlay.BackgroundColor3 = Color3.new(0, 0, 0)
          overlay.BackgroundTransparency = 0.75
          overlay.Size = UDim2.new(1, 0, 1, 0)
          overlay.Parent = tile
          local overlayCorner = Instance.new("UICorner")
          overlayCorner.CornerRadius = UDim.new(0.08, 0)
          overlayCorner.Parent = overlay
      end
      return tile
  end

  for i, pet in ipairs(PETS) do
      buildTile(i, pet)
  end

  local confirm = makeStickerButton(card, "green", "Confirm", UDim2.new(0.35, 0, 0.13, 0))
  confirm.AnchorPoint = Vector2.new(0.5, 0.5)
  confirm.Position = UDim2.new(0.5, 0, 0.84, 0)
  ```

  - 6 or more options: keep the SAME tile size and wrap to a second row; never shrink tiles.
- Locked tile: the overlay above, optional lock badge top-right at ~18% tile width, name still legible. Never removed from the row.

## Rules

- Exactly one tile reads as selected at all times: visible in a still screenshot.
- With 4+ options: one confirm action BELOW the row, not on the tiles. A tile carrying its own SELECT/CHOOSE button is a defect.
- With 2-3 options (team pickers): tiles MAY commit directly on click and no confirm is needed: the panel drops to AspectRatio 1.25 and shrinks to fit.
- Every tile carries art in its art band (icons-and-images skill). A row of text-only tiles is a defect.
- Tiles are uniform: same size, same fields, same construction. A "featured" option rendered larger is a defect.
- No prices anywhere. A price on a tile means this is a shop, not a select screen.
- Compare, don't sell: no banners, no offers, no currency chips.
