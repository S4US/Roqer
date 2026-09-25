# Recovered selected body: SIM / stat-leaderboard

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="stat-leaderboard")

# LAYOUT guide: stat-leaderboard

For: leaderboards, rankings, top-player boards, high scores, richest lists, kill boards: any screen ranking players by a value. NOT for your OWN stat readouts on screen (hud-zone-system), select screens, or quest boards (progression-hub).

The defining trait: **ranked rows, one player each, in strict columns.** The screen reads top to bottom as 1-2-3; rank, name, and value each align vertically as a column.

## Measurements (1080p)

- Panel: wrapper+shadow+card scaffold, centered, `Size = UDim2.new(1, 0, 0.5, 120)`, `UIAspectRatioConstraint.AspectRatio = 0.85` (~29% x 61% of screen): taller than wide; a leaderboard is a column.
- Straddling title ("Top Players!"), side icon LOCKED against the title text (parented to the title label per the scaffold, never parked at the panel corner), straddling close button: per the style guide.
- Optional scope tabs (Daily / All Time): 2-3 canonical buttons directly below the straddle zone, each ~28% card width x ~6% card height; EXACTLY ONE bright gradient (active), others GREY, and the active tab matches the rows on screen.
- Optional column header row below: bare dark-navy labels (~4% card height) over the rank / name / value columns, no background behind them.
- Rows: ScrollingFrame (AutomaticCanvasSize Y, thickness 15), UIListLayout, each row full content width x EXPLICIT pixel height (e.g. `UDim2.new(1, -30, 0, 60)`) with ~4px gaps.
- Local player's row: a white rounded row card behind it (UICorner 0.15, navy stroke 4, soft cyan wash): the one visually distinct row.
- Seed 8 demo rows with strictly descending values when live data is absent; rank 1 must be visible without scrolling.

## Rules

- Values DESCEND top to bottom, and rank 1 is visible without scrolling.
- Rows are uniform height and construction. Rendering the top 3 as giant podium cards above the list is a defect: this layout is rows.
- Rows span the full content width (`Size = UDim2.new(1, -30, 0, 60)`): side margins wider than ~3% of the panel are an automatic fail.
- Columns align: every value ends at the same x, every name starts at the same x.
- No buttons on rows: a leaderboard displays, it never acts. The value is a plain TextLabel.
- No prices, no purchase buttons, no banners.
- Names truncate; a name wrapping to two lines is a defect.
