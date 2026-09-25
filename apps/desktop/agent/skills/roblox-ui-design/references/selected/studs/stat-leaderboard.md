# Recovered selected body: STUDS / stat-leaderboard

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="stat-leaderboard")

# LAYOUT guide: stat-leaderboard

For: leaderboards, rankings, top-player boards, high scores, richest lists, kill boards: any screen ranking players by a value. NOT for your OWN stat readouts on screen (that is hud-zone-system), select screens (those commit to an option), or quest boards (progression-hub).

The defining trait: **ranked rows, one player each, in strict columns.** The screen reads top to bottom as 1-2-3; rank, name, and value each align vertically as a column.

## Measurements (1080p)

- Panel: 38% screen width x 68% screen height, centered — taller than wide; a leaderboard is a column.
- Title bar: ~10% of panel height, close button flush right per the style guide.
- Optional scope tabs (Daily / All Time): 2-3 canonical buttons directly below the bar, each ~22% panel width x ~6% panel height; EXACTLY ONE bright active face, others desaturated, and the active tab matches the rows on screen.
- Optional column header row below: bare TextLabels (~4% panel height) over the rank / name / value columns, no background component behind them.
- Rows: ScrollingFrame (AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness ~6), UIListLayout, each row full content width x EXPLICIT pixel height (e.g. UDim2.new(1, -26, 0, 64)) with ~6px gaps, bevel-stack card construction.
- Row columns, left to right:
  - Rank badge: square bevel chip (aspect 1, ~70% of row height), left margin ~1.5%, rank number TextScaled white + stroke. Ranks 1, 2, 3 get gold, silver, and bronze faces; every other rank shares one neutral face.
  - Player name: bare TextLabel, LEFT-aligned, starting past the badge + ~1.5% margin, ~45% of row width, TextTruncate = AtEnd.
  - Value: RIGHT-aligned ending ~2% from the row's right edge, gradient number treatment from the style guide (white->gold), optional stat icon LEFT of the number (~60% of row height).
- Local player's row: when the local player is ranked, their row face is brighter than its neighbours (same selection cue as select-screen).
- When the game has no real stat data, SEED demo content: 8-12 demo players with strictly descending values. A board with one row shows none of the layout and cannot be evaluated.

## Rules

- Values DESCEND top to bottom, and rank 1 is visible without scrolling. Out-of-order values are a defect.
- Rows are uniform height and construction. Rendering the top 3 as giant podium cards above the list is a defect: this layout is rows.
- Columns align: every value ends at the same x, every name starts at the same x. Values drifting to sit beside their names are a defect.
- No buttons on rows: a leaderboard displays, it never acts. A row carrying a button is a defect.
- No prices, no purchase buttons, no banners anywhere in this layout.
- Names truncate; a name wrapping to two lines is a defect.
