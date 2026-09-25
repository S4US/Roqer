# Layout: progression-hub

**Use for:** quest logs, daily/weekly goals, achievements, battle pass/season, daily reward tracks.  
**Not for:** shop, inventory, rebirth confirm, leaderboard.

## Semantic contract
A checklist, not a catalog. Every full-width goal row answers:
1. what is the goal?
2. how far along?
3. what is the reward?

## State machine
- `INCOMPLETE`: progress < goal; proportional fill; disabled/desaturated CLAIM.
- `CLAIMABLE`: progress >= goal; full fill; green actionable CLAIM.
- `CLAIMED`: progress >= goal; full fill; desaturated CLAIMED.

Count/progress text belongs on the bar. Green is reserved for actionable claim.

## Shared
- >=5 rows visible.
- No Robux/prices.
- Optional Daily/Weekly/Season tabs; exactly one active.
- More rows scroll; title/tabs stay fixed.

## SIM
- Dialog scaffold, wrapper ~`UDim2.new(1,0,0.42,120)`, aspect ~1.6.
- Five rows ~82 px fit exactly.
- List around x20, y82, width minus 40, height ~450; padding ~10.
- Claim button ~110×48.
- Optional tabs 2–4, each ~16% card width ×40 px; active bright, inactive grey.
- With tabs, drop one demo row if necessary rather than clipping.
- Example states should include incomplete, claimable, claimed, and barely-started.

## STUDS
- Panel ~52%×62%.
- Title bar ~11%.
- Tabs 2–4 around 16%w ×7%h, left aligned with ~1% gap.
- Content ScrollingFrame, scrollbar ~6.
- Rows around 96 px, full width.
- Icon square ~70% row height.
- Middle text/progress block ~52% row width.
- Progress bar ~90% middle-block width ×28% row height.
- Right reward+claim block ~14% row width ×60% row height.
- Use a defensive progress setter so 0 progress hides fill and nonzero fill clamps to >=~0.04 fraction.
