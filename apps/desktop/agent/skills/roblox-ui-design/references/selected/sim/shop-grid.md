# Recovered selected body: SIM / shop-grid

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="shop-grid")

# LAYOUT guide: shop-grid

For: shops, stores, gamepass menus, bundle/offer screens: any screen selling multiple items. NOT for rebirth/confirm dialogs, inventories with selection panes, or HUDs.

The defining trait: **dense sectioned merchandising.** Content fills the card width in uniform item rows; the screen reads as a catalog.

## Measurements (1080p)

- Panel: the style guide's wrapper+shadow+card scaffold, centered, `Size = UDim2.new(1, 0, 0.46, 120)`, `UIAspectRatioConstraint.AspectRatio = 1.7` (~55% x 57% of a 1080p screen).
- Straddling title ("Shop!"), side icon locked against the title text, straddling close button: all per the style guide. NO title bar.
- Optional utility pills (search, filter icons) straddle the top edge between the title and the close button.
- Content: copy THIS skeleton (requires the scaffold's `makeStickerButton`). Every section is a self-sizing frame in one vertical list; every label lives inside its own cell. Free-positioned labels over grids are the top cause of unreadable shops: never set Position on anything the list or grid owns.

  ```lua
  local content = Instance.new("ScrollingFrame")
  content.BackgroundTransparency = 1
  content.BorderSizePixel = 0
  content.Position = UDim2.new(0, 0, 0.12, 0)
  content.Size = UDim2.new(1, 0, 0.88, 0)
  content.AutomaticCanvasSize = Enum.AutomaticSize.Y
  content.ScrollBarThickness = 15
  content.ScrollBarImageColor3 = NAVY
  content.Parent = card
  local pad = Instance.new("UIPadding")
  pad.PaddingTop = UDim.new(0, 16)
  pad.PaddingBottom = UDim.new(0, 16)
  pad.PaddingLeft = UDim.new(0, 20)
  pad.PaddingRight = UDim.new(0, 20)
  pad.Parent = content
  local stack = Instance.new("UIListLayout")
  stack.Padding = UDim.new(0, 8)
  stack.SortOrder = Enum.SortOrder.LayoutOrder
  stack.Parent = content

  local CONTENT_W = 1009 -- inner width of this panel at 1080p (card 1049 minus side padding)
  local CELL_H = 148
  local COL_GAP = 14

  -- Coin and amount are ONE centered group: an icon pinned to the pill's left
  -- edge with the number floating apart from it reads broken on wide pills.
  local function buildPricePill(parent, amount)
      local pill = makeStickerButton(parent, "green", "", UDim2.new(0.86, 0, 0, 34))
      pill.AnchorPoint = Vector2.new(0.5, 1)
      pill.Position = UDim2.new(0.5, 0, 1, -8)
      local row = Instance.new("Frame")
      row.BackgroundTransparency = 1
      row.AnchorPoint = Vector2.new(0.5, 0.5)
      row.Position = UDim2.fromScale(0.5, 0.5)
      row.Size = UDim2.new(1, 0, 0.62, 0)
      row.Parent = pill
      local rowLayout = Instance.new("UIListLayout")
      rowLayout.FillDirection = Enum.FillDirection.Horizontal
      rowLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center
      rowLayout.VerticalAlignment = Enum.VerticalAlignment.Center
      rowLayout.Padding = UDim.new(0, 6)
      rowLayout.Parent = row
      local coin = Instance.new("ImageLabel")
      coin.BackgroundTransparency = 1
      coin.ScaleType = Enum.ScaleType.Fit
      -- set coin.Image from the icons-and-images catalog NOW; ImageColor3
      -- stays white (natural colors, never dark-tinted). An ImageLabel left
      -- with no Image or no Size is a measured structural defect.
      coin.Size = UDim2.fromOffset(24, 24)
      coin.Parent = row
      local amountLabel = Instance.new("TextLabel")
      amountLabel.BackgroundTransparency = 1
      amountLabel.Font = Enum.Font.FredokaOne
      amountLabel.Text = amount
      amountLabel.TextColor3 = Color3.new(1, 1, 1)
      amountLabel.TextScaled = true
      amountLabel.Size = UDim2.new(0, 0, 1, 0)
      amountLabel.AutomaticSize = Enum.AutomaticSize.X
      amountLabel.Parent = row
      local amountStroke = Instance.new("UIStroke")
      amountStroke.Color = Color3.new(0, 0, 0)
      amountStroke.Thickness = 3
      amountStroke.Parent = amountLabel
      return pill
  end

  local function buildProductCard(parent, item)
      local cell = Instance.new("Frame")
      cell.BackgroundColor3 = Color3.fromRGB(235, 240, 252)
      cell.Parent = parent
      local cellCorner = Instance.new("UICorner")
      cellCorner.CornerRadius = UDim.new(0.12, 0)
      cellCorner.Parent = cell
      local cellStroke = Instance.new("UIStroke")
      cellStroke.Color = NAVY
      cellStroke.Thickness = 3
      cellStroke.Parent = cell
      local name = Instance.new("TextLabel")
      name.BackgroundTransparency = 1
      name.Font = Enum.Font.FredokaOne
      name.Text = item.name
      name.TextColor3 = NAVY
      name.TextScaled = true
      name.Position = UDim2.new(0, 6, 0, 6)
      name.Size = UDim2.new(1, -12, 0, 26)
      name.Parent = cell
      local art = Instance.new("ImageLabel")
      art.BackgroundTransparency = 1
      art.ScaleType = Enum.ScaleType.Fit
      -- item art from the icons-and-images catalog, full natural colors
      art.AnchorPoint = Vector2.new(0.5, 0)
      art.Position = UDim2.new(0.5, 0, 0, 36)
      art.Size = UDim2.fromOffset(62, 62)
      art.Parent = cell
      buildPricePill(cell, item.price)
  end

  local function buildSection(order, headingText, items)
      local heading = Instance.new("TextLabel")
      heading.LayoutOrder = order
      heading.BackgroundTransparency = 1
      heading.Size = UDim2.new(1, 0, 0, 28)
      heading.Font = Enum.Font.FredokaOne
      heading.TextColor3 = NAVY
      heading.Text = headingText
      heading.TextScaled = true
      heading.Parent = content
      local holder = Instance.new("Frame")
      holder.LayoutOrder = order + 1
      holder.BackgroundTransparency = 1
      holder.Size = UDim2.new(1, 0, 0, CELL_H)
      holder.AutomaticSize = Enum.AutomaticSize.Y
      holder.Parent = content
      local rows = math.ceil(#items / 5)
      local cols = math.ceil(#items / rows)
      local grid = Instance.new("UIGridLayout")
      grid.CellSize = UDim2.fromOffset(math.floor((CONTENT_W - COL_GAP * (cols - 1)) / cols), CELL_H)
      grid.CellPadding = UDim2.fromOffset(COL_GAP, COL_GAP)
      grid.SortOrder = Enum.SortOrder.LayoutOrder
      grid.Parent = holder
      for _, item in ipairs(items) do
          buildProductCard(holder, item)
      end
  end

  ```

  Then the demo data, and the calls that build every section:

  ```lua
  local COIN_PACKS = {
      { name = "1,000 Coins", price = "49" },
      { name = "5,000 Coins", price = "149" },
      { name = "15,000 Coins", price = "299" },
      { name = "50,000 Coins", price = "699" },
      { name = "200,000 Coins", price = "1,499" },
  }
  local GAMEPASSES = {
      { name = "VIP", price = "399" },
      { name = "Auto Collect", price = "149" },
      { name = "2x Coins", price = "249" },
      { name = "Lucky Eggs", price = "349" },
      { name = "Extra Pets", price = "199" },
  }

  buildSection(10, "Coin Packs", COIN_PACKS)
  buildSection(20, "Gamepasses", GAMEPASSES)
  ```

- Optional ONE featured banner at top (`LayoutOrder = 1`): `Size = UDim2.new(1, 0, 0, 96)` spanning the FULL content width (a half-width banner with dead space beside it is an automatic fail). White Frame, UICorner 0.12, navy UIStroke 4, blue-cyan two-stop gradient (87,216,255)->(135,255,249) rot -90. Inside, left to right: offer art (Fit, aspect 1, 72px, catalog icon, no tint) at x=16; offer name (white + black glyph stroke 3, height 38px at y=16) with a one-line sub ("50,000 Coins + VIP Pass", white + black stroke 3, height 24px at y=58) under it; `buildPricePill`-style green price button (`UDim2.fromOffset(170, 56)`, AnchorPoint (1, 0.5), Position (1, -16, 0.5, 0)). A banner with only text, or with tiny text, is a defect: the name renders at the 38px band height.

## Rules

- The column count comes from the item count (`rows`/`cols` math above): 4 items make 4 wider columns filling the width, 5 make 5. A row that leaves a dead empty column, or one orphan card under a full row, is an automatic fail — balance the rows (6 items = 2 rows of 3, never 5+1).
- Every label lives INSIDE its own cell and inside its own band of that cell (name band, art band, price band). Section headings sit BETWEEN sections in their own full-width row, never on top of cards. Never set Position on a card or heading in `content`: the list and grids own all placement.
- **A banner is a real offer, never decoration**: art, name, price button inside it.
- Every purchasable shows a price on the green pill with the currency icon LEFT of the amount, icon untinted.
- Single-action rows ("Sell", "Claim", "Redeem" — one action, not a product grid): a compact CENTERED row, never a full-content-width band. Row Frame `AnchorPoint = Vector2.new(0.5, 0)`, `Size = UDim2.new(0, 600, 0, 72)` centered in the content column, holding icon (44px, Fit), label, and one canonical button. A lone action stretched across the full 1009px content width is a defect.
- Density floor: cells stay at the listed size; never scale cells up to fill vertical space. With few products the PANEL shrinks (drop toward AspectRatio 1.25): never pad with invented products, never leave a dead region under the cells.
- No section straddles the fold: a section (heading + its cards) either fits COMPLETELY in the visible area or starts fully below it and scrolls. Cards half-cut by the panel edge are an automatic fail. The skeleton's numbers (banner 96 + two 148px-cell sections) fit the panel with ~30px slack: keep them, and absorb any extra content by shrinking cells, never by letting a row slide under the panel edge.
