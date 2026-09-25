# Recovered selected body: SIM / centered-dialog

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="centered-dialog")

# LAYOUT guide: centered-dialog

For: rebirth, confirmations, offline earnings, prestige, prompts, "you got X" dialogs: any screen that presents a small amount of important information with one or two actions. NOT for shops, inventories, HUDs, transient toasts (notification-alert), or quest/reward boards (progression-hub).

The defining trait: **a loose, centered, breathing layout.** Content is a centered vertical composition with generous whitespace on the white card. Elements do NOT fill the card width, and empty space is intentional.

## Measurements (1080p)

- Panel: wrapper+shadow+card scaffold, centered, `Size = UDim2.new(1, 0, 0.4, 120)`, `UIAspectRatioConstraint.AspectRatio = 1.25` (~36% x 51% of screen).
- Straddling title ("Rebirth!"), side icon LOCKED against the title text (parented to the title label per the scaffold, never parked at the panel corner), straddling close button: per the style guide.
- Content area: below the straddle zone, >= 4% card-height gaps between blocks.
- Section headings ("You Will Receive", "You Will Lose"): the divider-flanked dark-navy heading row, centered, EXACTLY 40px tall — a heading that renders under ~28px glyph height reads as body copy and fails review.
- Reward/info items: centered icon+title+description blocks in a UIGridLayout or centered row (each ~20-47% card width), never spanning the card. Item titles dark navy 30px tall, descriptions (84,86,98) 22px tall, art LEFT of its text block at 56px square (full-color catalog icons, uniform size across items — a shrunken icon on one row unbalances the pair).
- Progress/requirement bar (if any): the style guide's pill progress bar, ~84% card width, ~10% card height, centered; count text centered ON the bar.
- Action buttons: `makeStickerButton` (scaffold builder), small, uniform, centered: NOT full width. With two actions, copy EXACTLY:

  ```lua
  local confirm = makeStickerButton(card, "green", "Confirm", UDim2.new(0.28, 0, 0.14, 0))
  confirm.AnchorPoint = Vector2.new(1, 0.5)
  confirm.Position = UDim2.new(0.485, 0, 0.85, 0)
  local cancel = makeStickerButton(card, "red", "Cancel", UDim2.new(0.28, 0, 0.14, 0))
  cancel.AnchorPoint = Vector2.new(0, 0.5)
  cancel.Position = UDim2.new(0.515, 0, 0.85, 0)
  ```

  Identical sizes; confirm LEFT, cancel RIGHT; the 0.03 gap is load-bearing. A single action gets ONE green `makeStickerButton` centered at (0.5, 0.85), width ~0.4. Any extra action (Edit, More Info) is the same builder in blue.
- Optional note line ("You keep everything else!" / "Coins will reset."): ONE centered dark-navy label directly above the buttons, 26px tall, no stroke, no colored glyphs — it sits on the white card, so the body-text rule applies. A green/lime note line is a defect.
- Bottom breathing room: >= 6% card height empty below the buttons.

## Rules

- Never apply grid-fill or full-width list habits here. If an element could shrink and still read clearly, shrink it.
- Padding is SYMMETRIC: every centered element leaves equal space left and right.
- At most 2 action buttons. Centered column composition throughout.
- Vertical rhythm over density: when unsure, add space, not size.
- Never place text outside the card (the straddling title and close button are the only elements that cross the edge).
