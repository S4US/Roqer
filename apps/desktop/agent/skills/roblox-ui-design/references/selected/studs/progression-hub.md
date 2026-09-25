# Recovered selected body: STUDS / progression-hub

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="progression-hub")

# LAYOUT guide: progression-hub

For: quest logs, daily/weekly quest boards, battle pass and season screens, achievement lists, daily reward tracks: any screen where the player reviews goals and claims earned rewards. NOT for shops (those sell), inventories (grid-inventory), rebirth/prestige confirms (centered-dialog), or leaderboards (stat-leaderboard).

The defining trait: **full-width goal rows, each with a progress bar and a claim state.** Every row answers three questions at a glance: what to do, how far along, what you get. The screen is a checklist, not a catalog.

## Measurements (1080p)

- Panel: EXACTLY `Size = UDim2.new(0.52, 0, 0.62, 0)`, centered. Copy this size; a shorter panel fails the height check (band floor 0.52).
- Title bar: ~11% of panel height, close button flush right per the style guide.
- Optional tab row (Daily / Weekly / Season): directly below the title bar, 2-4 canonical buttons, each ~16% panel width x ~7% panel height, left-aligned as a row with ~1% gaps. EXACTLY ONE has a bright face (the active tab); the others use desaturated faces of the same construction, and the active tab MUST be the one whose rows are on screen.
- Content: ScrollingFrame below (AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness ~6), rows stacked by UIListLayout with ~2% panel-height gaps.
- Quest rows: full content width, EXPLICIT pixel height (e.g. Size = UDim2.new(1, -26, 0, 96)), bevel-stack card construction. Row bands, left to right:
  - Icon: square (Fit, aspect 1, ~70% of row height), left margin ~1.5%.
  - Middle block (~52% of row width): quest name on top (bare TextLabel, left-aligned, ~40% of row height), progress bar under it (progress-bar construction from the style guide, ~90% of block width x ~28% of row height) with the count ("3/10") centered ON the bar.
  - Right block: reward chip (icon LEFT of the amount text, bare glyphs) then the claim button (~14% of row width x ~60% of row height, canonical construction) flush toward the row's right edge with ~1.5% margin.
- Claim states, encoded by the button face: a completed, unclaimed row gets a GREEN "CLAIM" button; a claimed row keeps the same button desaturated with label "CLAIMED"; an incomplete row keeps it desaturated with label "CLAIM" and its bar mid-fill.
- When the game has no real quest data, SEED demo content: 5-7 quests with varied progress, including at least one claimable, one claimed, and one barely started ("barely started" means 1-2 of N, never 0). An empty quest board shows none of the layout and cannot be evaluated.
- Set every progress fill through EXACTLY this function — never assign a
  fill Size anywhere else. A zero-width frame fails the eval outright:

  ```lua
  local function setProgress(fill, progress, goal)
      if progress <= 0 then
          fill.Visible = false
      else
          fill.Visible = true
          fill.Size = UDim2.new(math.clamp(progress / goal, 0.04, 1), 0, 1, 0)
      end
  end
  ```

## Rules

- Rows are uniform and span the full content width, each exactly as wide as the next. Rows narrower than the content area are a defect.
- Every row carries a progress bar with its count ON the bar. A goal row with no visible progress is a defect.
- The bar's fill fraction MATCHES its count: a "3/10" bar filled to 80% is a defect.
- Green faces appear ONLY on claimable buttons. A green CLAIM on an incomplete or claimed row is a defect.
- No prices, no purchase buttons, no Robux icons: rewards here are earned, never bought. A price on a row means this is a shop.
- Rows scroll; the title bar and tab row never scroll with them.
- Density is the point: 5+ rows visible. One or two giant rows filling the panel is a defect.
