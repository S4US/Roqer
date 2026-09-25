# Recovered selected body: STUDS / centered-dialog

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="centered-dialog")

# LAYOUT guide: centered-dialog

For: rebirth, confirmations, offline earnings, prestige, prompts, "you got X" dialogs: any screen that presents a small amount of important information with one or two actions. NOT for shops, inventories, HUDs, transient toasts that dismiss themselves (notification-alert), or quest/reward boards (progression-hub).

The defining trait: **a loose, centered, breathing layout.** Content is a centered vertical composition with generous whitespace. Elements do NOT fill the panel width, there is NO uniform list/grid stretching, and empty space is intentional.

## Measurements (from the reference dialog, 1080p)

- Panel: 45% screen width x 55% screen height, centered horizontally, center-y ~0.45.
- Title bar: 13.5% of panel height.
- Content area: below the bar. Stacked content blocks (headings, chip rows, grids) flow through ONE vertical UIListLayout on the content region (`FillDirection = Vertical`, `HorizontalAlignment = Center`, `SortOrder = LayoutOrder`, `Padding = UDim.new(0.04, 0)`), each block a fixed-height Frame. Hand-positioning sibling blocks with scale values is a defect — that is how a chip grid ends up rendering under the block above it. Action buttons keep their exact positions from the bullet below.
- Section headings ("You will receive", "Requirement"): BARE TextLabels, centered, ~7% panel height, NO background component behind them.
- Reward/info items: centered elements (each ~20-24% panel width: chunky, clearly readable), side by side with ~2% gaps, centered as a group. They do not span the panel.
- Progress/requirement bar (if any): ~84% panel width, ~13% panel height, centered. The bar content (icon plus amount text) is centered ON the bar as a single group, both horizontally and vertically; content hugging the left edge of the bar is a defect.
- Action buttons: **small, uniform, and centered: NOT full width.** With two
  actions, build BOTH buttons with these exact properties — copy them, never
  size a button to its text:
  - ConfirmButton: `AnchorPoint = Vector2.new(1, 0.5)`, `Position = UDim2.new(0.485, 0, 0.82, 0)`, `Size = UDim2.new(0.28, 0, 0.13, 0)`
  - CancelButton: `AnchorPoint = Vector2.new(0, 0.5)`, `Position = UDim2.new(0.515, 0, 0.82, 0)`, `Size = UDim2.new(0.28, 0, 0.13, 0)`
  The two Size values are IDENTICAL; a confirm wider than its cancel is the
  most common defect in this layout. The 0.03 gap between them is load-bearing:
  buttons that touch read as one striped bar. The CONFIRM/affirmative button
  sits LEFT, the cancel/decline button RIGHT.
- Icons that label a value (currency, requirement amounts) sit LEFT of the text they label, never after it, and never floating at the far end of the bar.
- Bottom breathing room: leave >= 6% panel height empty below the buttons.
- Optional: one warning/note line INSIDE the panel, centered between the last
  content block and the action row, red or white with glyph stroke. Never place
  text outside the panel: a line floating below the dialog reads as detached
  from it.

## Rules

- Never apply grid-fill or full-width list habits here. If an element could shrink and still read clearly, shrink it.
- Padding is SYMMETRIC: every centered element leaves equal space left and right. Content drifting toward one side of the panel is a defect.
- At most 2 action buttons. Centered column composition throughout.
- Vertical rhythm over density: when unsure, add space, not size.
