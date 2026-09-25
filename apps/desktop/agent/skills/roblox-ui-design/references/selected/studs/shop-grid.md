# Recovered selected body: STUDS / shop-grid

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="shop-grid")

# LAYOUT guide: shop-grid

For: shops, stores, gamepass menus, bundle/offer screens: any screen selling multiple items. NOT for rebirth/confirm dialogs, inventories with selection panes, or HUDs.

The defining trait: **dense sectioned merchandising.** Content fills the panel width in uniform card rows; the screen reads as a catalog.

## Measurements (1080p)

- Panel: 45% screen width, centered, with its 1080p proportions locked by a `UIAspectRatioConstraint` (core generation, Responsive geometry) so wide windows do not stretch it. Height comes from THIS TABLE — copy the number for your row count, never pick one by eye:
  - 1 card row, no banner: `Size = UDim2.new(0.45, 0, 0.40, 0)`
  - 2 card rows, no banner: `Size = UDim2.new(0.45, 0, 0.53, 0)`
  - banner + 1 row: `Size = UDim2.new(0.45, 0, 0.55, 0)`
  - 3+ rows, or banner + 2+ rows: `Size = UDim2.new(0.45, 0, 0.66, 0)` (overflow scrolls)
  Content ending more than ~25% above the panel bottom is a defect — the panel is one table row too tall; use the smaller size.
- Title bar: ~11.3% of panel height. ONLY the icon, title text, and close button live in the bar — restock/refresh timers and any other status text are bare stroked TextLabels on the FIRST content row below the bar, never inside it (title/status overlap in the bar is a recurring structural fail).
- Content: ScrollingFrame below the bar, 13px side insets, sections stacked by UIListLayout with ~10px padding.
- Optional ONE wide featured banner at top: full content width, aspect ~3.5, sparse-stud pattern treatment.
- Card rows: EXPLICIT pixel heights (e.g. Size = UDim2.new(1, -26, 0, 240)); UIGridLayout CellSize = UDim2.fromOffset(255, 235), CellPadding = UDim2.fromOffset(14, 14) for 3 columns in ~837px content width. Compute cells to FILL the width: no wasted columns.
- Cards: name top (~18% card height), art or gradient display number middle (~50%), buy button bottom (55-80% card width, ~28% card height, raised ~6% off the card bottom).
- ScrollingFrame: AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness ~6.

## Rules

- Rows are uniform within a section; sections may differ (banner vs packs vs passes).
- **A banner is a real offer, never decoration**: it contains an actual product (art, name, price button), laid out horizontally inside the banner. A banner with only text is a defect.
- **Rows fill the full content width**: every card row spans edge to edge, exactly as wide as the banner above it. Rows narrower than the banner are a defect.
- **Density floor**: cards stay near the listed cell size: never scale cards up to fill vertical space. 4+ items means multiple rows (3 columns). One row of tall cards filling the panel height is a defect; a card taller than ~45% of the content area is a defect. With few products, the PANEL shrinks to the content (see the height clamp above) — never pad with invented products and never leave a dead region under the cards.
- Every purchasable shows a price button (Robux icon rule from the style guide).
- Fill the width; scroll for overflow. Density is the point here.
