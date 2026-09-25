# Recovered selected body: STUDS / grid-inventory

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="grid-inventory")

# LAYOUT guide: grid-inventory

For: inventories, pet/item storage, backpacks, lockers, collections you manage: any screen where the player looks at what they own and equips or drops it. NOT for shops (those sell), select screens (those commit to one option), or HUDs.

The defining trait: **a fixed grid of uniform square slots with a capacity counter, where empty slots stay visible.** The grid is storage, so its shape is constant: how full it is IS the information.

## Measurements (1080p)

- Panel: 50% screen width x 60% screen height, centered, aspect ~1.39.
- Title bar: ~11% of panel height, close button flush right. The capacity counter ("12/20") sits in the title bar, right-aligned, and must END at least one close-button-width before the bar's right edge per the style guide.
- Slot grid: UIGridLayout, 5 columns, ~4 rows visible, square cells (aspect 1) at ~18% of content width, CellPadding ~2% of content width. Compute cells to FILL the content width: 5 x cell + 4 x padding spans the pane edge to edge.
- Category tabs (when the inventory has item categories): a vertical rail of square tabs PARENTED TO THE PANEL and flush against its LEFT edge — rail Frame `AnchorPoint = Vector2.new(1, 0)`, `Position = UDim2.new(0, 0, 0.13, 0)` (right edge of every tab touches the panel's left edge, top aligned just below the title bar), tabs stacked by a vertical UIListLayout with ~1% panel-height padding, each tab the canonical bevel button at ~9% panel height with aspect 1. Tabs floating detached from the panel — including template tabs left at their old positions during a restyle — are a defect; parent them to the panel so they move with it.
- Render one slot per unit of CAPACITY, not per owned item: 3 pets out of 20 means 3 filled slots followed by 17 empty ones. Rows fill left to right and only wrap when full, so a half-empty first row above a second row is a defect, and so is a panel with three cards floating in an otherwise empty pane.
- When the game has no real item data, SEED demo content: create 5-8 sample
  items with distinct names before building the grid. An inventory rendered
  with zero items shows none of the layout and cannot be evaluated — "No items
  yet" as the whole screen is a defect, not an empty state.
- Build slots with EXACTLY this shape — the SLOT ITSELF is the button; a slot
  NEVER contains a button child, and exactly ONE action button exists, in the
  action row under the grid:

  ```lua
  local selected
  local function makeSlot(item) -- item = { name = "...", image = "..." } or nil for an empty slot
      local slot = Instance.new("ImageButton") -- style-guide cell construction on this
      if item then
          -- art ImageLabel (aspect 1, Fit) + name TextLabel; NO buttons here
      end
      slot.MouseButton1Click:Connect(function()
          selected = item
          -- move the highlight stroke to this slot and update the ONE action
          -- button's text (Equip/Unequip); do NOT create per-slot buttons
      end)
      return slot
  end
  -- After the grid: ONE action TextButton acting on `selected`.
  ```
  - Filled slot: art centered at 8-62% of cell height (Fit + aspect 1), name label 66-88% of cell height, optional count or rarity badge in the cell's top-right at ~22% of cell width.
  - Empty slot: the same cell construction with a darker face and no content. Empty slots are RENDERED, never skipped.
- ScrollingFrame for overflow: AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness ~6. The visible grid never changes column count when scrolling.
- Action row: at most 2 buttons at the bottom of the panel, each ~24% panel width x ~10% panel height, centered as a group, ~4% panel height below the grid.
- Bottom breathing room: >= 4% panel height below the action row.

## Detail-pane variant (use when the task mentions item details, stats, or selecting an item to inspect)

Same panel, split into two panes below the title bar:

- Slot grid on the LEFT: 62% of content width, ~3% gap, same square cells and same fill rule as above, recomputed to 3 columns so the grid still spans its pane edge to edge.
- Item-detail card on the RIGHT: 35% of content width, full content height, one card in the theme's bevel construction. Its bands top to bottom: item art 6-46% of card height (Fit + aspect 1), item name 50-60%, up to three stat lines 62-84%, action button 86-96% (~70% of card width, centered).
- The card always shows one item: the selected slot's. It is never empty and never a placeholder.
- The selected slot carries the same visible selection cue as select-screen: a brighter face and a heavier outline than its neighbours.
- In this variant the action button lives on the detail card, so there is no bottom action row.

## Rules

- Empty slots are visible. An inventory that renders only owned items is a defect: the player cannot see capacity, which is the question the screen answers.
- The capacity counter is mandatory and shows current/max.
- Cells are SQUARE and uniform. A grid of tall rectangular cards with buy buttons is shop-grid, not this.
- No prices, no purchase buttons, no banners anywhere in this layout.
- Equip and unequip are ONE button whose label reflects the selected item's state, not two competing buttons.
- The action button does NOT live on every slot. A grid where each cell carries its own Equip button is a defect: slots select, and the single action button (bottom row, or the detail card in the variant above) acts on the selection.
- The item name belongs on the slot. A grid of bare icons with no names is a defect.
- Density is fixed by the grid: never resize cells to fill leftover space, and never change the column count between rows.
