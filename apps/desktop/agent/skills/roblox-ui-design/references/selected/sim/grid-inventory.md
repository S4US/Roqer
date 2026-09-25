# Recovered selected body: SIM / grid-inventory

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="grid-inventory")

# LAYOUT guide: grid-inventory

For: inventories, pet/item storage, backpacks, lockers, collections you manage: any screen where the player looks at what they own and equips or drops it. NOT for shops (those sell), select screens (those commit to one option), or HUDs.

The defining trait: **a fixed grid of uniform square slots with a capacity counter, where empty slots stay visible.** The grid is storage: how full it is IS the information.

## Measurements (1080p)

- Panel: wrapper+shadow+card scaffold, centered, `Size = UDim2.new(1, 0, 0.46, 120)`, `UIAspectRatioConstraint.AspectRatio = 1.95` (~63% x 57% of screen).
- Straddling title ("Inventory!"), side icon locked against the title text, straddling close button: per the style guide.
- Search pill (when the task wants search/sort): copy THIS, straddling the top edge at the RIGHT side, ending just before the close button — a search pill floating mid-edge with gaps both sides is a defect:

  ```lua
  local searchPill = Instance.new("Frame")
  searchPill.BackgroundColor3 = Color3.new(1, 1, 1)
  searchPill.AnchorPoint = Vector2.new(1, 0.5)
  searchPill.Position = UDim2.new(0.93, 0, 0, 0)
  searchPill.Size = UDim2.fromOffset(260, 44)
  searchPill.ZIndex = 5
  searchPill.Parent = card
  local pillCorner = Instance.new("UICorner")
  pillCorner.CornerRadius = UDim.new(0.45, 0)
  pillCorner.Parent = searchPill
  local pillStroke = Instance.new("UIStroke")
  pillStroke.Color = NAVY
  pillStroke.Thickness = 4
  pillStroke.Parent = searchPill
  local magnifier = Instance.new("ImageLabel")
  magnifier.BackgroundTransparency = 1
  magnifier.ScaleType = Enum.ScaleType.Fit
  -- magnifying-glass icon from the icons-and-images catalog; set the Image
  -- NOW and leave ImageColor3 white — a black/tinted or missing icon is a defect
  magnifier.AnchorPoint = Vector2.new(0, 0.5)
  magnifier.Position = UDim2.new(0, 10, 0.5, 0)
  magnifier.Size = UDim2.fromOffset(28, 28)
  magnifier.ZIndex = 6
  magnifier.Parent = searchPill
  local searchBox = Instance.new("TextBox")
  searchBox.BackgroundTransparency = 1
  searchBox.Font = Enum.Font.FredokaOne
  searchBox.Text = ""
  searchBox.PlaceholderText = "Search..."
  searchBox.PlaceholderColor3 = Color3.fromRGB(150, 152, 165)
  searchBox.TextColor3 = Color3.fromRGB(30, 30, 30)
  searchBox.TextScaled = true
  searchBox.TextXAlignment = Enum.TextXAlignment.Left
  searchBox.Position = UDim2.new(0, 46, 0, 8)
  searchBox.Size = UDim2.new(1, -56, 1, -16)
  searchBox.ZIndex = 6
  searchBox.Parent = searchPill
  ```
- Slot grid: copy THIS skeleton (requires the scaffold's `makeStickerButton`). The columns span the pane edge to edge with EQUAL side margins; every slot renders whole — a slot cut by the panel edge is an automatic fail.

  ```lua
  local CAPACITY = 20
  local DEMO_ITEMS = { -- seed demo items; an empty inventory cannot be evaluated
      { name = "Buddy" }, { name = "Whiskers" }, { name = "Hop" },
  }

  local gridFrame = Instance.new("Frame")
  gridFrame.BackgroundTransparency = 1
  gridFrame.Position = UDim2.new(0, 0, 0, 78)
  gridFrame.Size = UDim2.new(1, 0, 0, 440)
  gridFrame.Parent = card
  local gridPad = Instance.new("UIPadding")
  gridPad.PaddingTop = UDim.new(0, 8)
  gridPad.PaddingLeft = UDim.new(0, 24)  -- symmetric: same both sides
  gridPad.PaddingRight = UDim.new(0, 24)
  gridPad.Parent = gridFrame
  local grid = Instance.new("UIGridLayout")
  grid.CellSize = UDim2.fromOffset(132, 132) -- 8 columns x 3 rows fill this panel exactly
  grid.CellPadding = UDim2.fromOffset(14, 14)
  grid.FillDirectionMaxCells = 8 -- keep 8 columns: fewer columns leave dead side gutters and push rows under the Equip button
  grid.SortOrder = Enum.SortOrder.LayoutOrder
  grid.Parent = gridFrame

  local function buildSlot(index, item)
      local slot = Instance.new("TextButton") -- the slot IS the click target
      slot.Text = ""
      slot.LayoutOrder = index
      slot.BackgroundColor3 = item and Color3.fromRGB(224, 240, 255) or Color3.fromRGB(235, 240, 252)
      slot.Parent = gridFrame
      local slotCorner = Instance.new("UICorner")
      slotCorner.CornerRadius = UDim.new(0.12, 0)
      slotCorner.Parent = slot
      local slotStroke = Instance.new("UIStroke")
      slotStroke.Color = NAVY
      slotStroke.Thickness = 3
      slotStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border -- the slot is a TextButton: contextual mode would stroke no glyphs and show nothing
      slotStroke.Parent = slot
      if item then
          local art = Instance.new("ImageLabel")
          art.BackgroundTransparency = 1
          art.ScaleType = Enum.ScaleType.Fit
          -- item art from the icons-and-images catalog, full natural colors
          art.AnchorPoint = Vector2.new(0.5, 0)
          art.Position = UDim2.new(0.5, 0, 0, 10)
          art.Size = UDim2.fromOffset(74, 74)
          art.Parent = slot
          local name = Instance.new("TextLabel")
          name.BackgroundTransparency = 1
          name.Font = Enum.Font.FredokaOne
          name.Text = item.name
          name.TextColor3 = NAVY
          name.TextScaled = true
          name.Position = UDim2.new(0, 6, 1, -34)
          name.Size = UDim2.new(1, -12, 0, 26)
          name.Parent = slot
      end
      return slot
  end

  for i = 1, CAPACITY do
      buildSlot(i, DEMO_ITEMS[i]) -- filled slots first, then visible empties
  end

  local equip = makeStickerButton(card, "green", "Equip", UDim2.fromOffset(220, 56))
  equip.AnchorPoint = Vector2.new(0.5, 1)
  equip.Position = UDim2.new(0.5, 0, 1, -16)

  local counter = Instance.new("TextLabel")
  counter.BackgroundTransparency = 1
  counter.Font = Enum.Font.FredokaOne
  counter.Text = #DEMO_ITEMS .. "/" .. CAPACITY .. " Storage"
  counter.TextColor3 = NAVY -- dark navy on the card, no stroke, never yellow
  counter.TextScaled = true
  counter.AnchorPoint = Vector2.new(1, 1)
  counter.Position = UDim2.new(1, -24, 1, -24)
  counter.Size = UDim2.new(0, 220, 0, 34)
  counter.TextXAlignment = Enum.TextXAlignment.Right
  counter.Parent = card
  ```

- Render one slot per unit of CAPACITY: 3 pets out of 20 means 3 filled slots then 17 empty ones. Rows fill left to right and wrap only when full.
- A capacity above 24 scrolls: put the grid in a ScrollingFrame sized so the visible area shows EXACT whole rows (`visibleRows * 146 + 8`) and whole overflow rows sit below the fold.
- Selection cue: heavier navy stroke (thickness 5) + brighter cyan wash on the selected slot; a slot NEVER contains a button child. The ONE action button (green, label Equip/Unequip by state) is the code above.
- Optional count/rarity badge (style-guide notification-badge construction) top-right of a filled slot at ~22% cell width.
- Section splits (Equipped vs Stored): the style guide's divider-flanked dark-navy heading rows.

## Detail-pane variant (task mentions item details, stats, or inspecting)

Same panel, split below the straddle zone: slot grid LEFT (62% of content width, 4-5 columns of the same square slots, same fill rule), item-detail card RIGHT (35%, full height): one white rounded card (UICorner 0.05, navy stroke 4) with bands top to bottom: item art 6-46% (Fit + aspect 1), name 50-60% (dark navy), up to three stat lines 62-84% ((84,86,98)), canonical action button 86-96% (~70% card width). The card always shows the selected slot's item: never empty. In this variant the action button lives on the detail card; no bottom action row.

## Rules

- Empty slots are visible; capacity counter is mandatory (current/max), dark navy, bottom-right.
- The grid frame stays FULL card width and the slot rows end above the Equip row: a slot rendering under the Equip button is a measured interactive-overlap fail. With the given numbers 20 slots make exactly 3 rows ending at y=518, clear of Equip at y=545; if you change cell size or capacity, re-do that arithmetic.
- Cells are SQUARE and uniform; never resize cells to fill leftover space; never change column count between rows. Portrait cells are a defect: `CellSize` height NEVER exceeds width x 1.15 (a 156x268 cell renders as a tall card with a dead bottom band). When per-item text (rarity, unlock lines) will not fit a square cell, keep the cells square and move the text to the detail-card variant below — never grow the cell.
- No prices, no purchase buttons, no banners anywhere.
- Equip and unequip are ONE button whose label reflects the selected item's state.
- The item name belongs on the slot; a grid of bare icons is a defect.
