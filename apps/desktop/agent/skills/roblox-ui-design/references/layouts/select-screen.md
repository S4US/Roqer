# Layout: select-screen

**Use for:** character/skin/class/team/map/mode/hero/job/role picker where player compares options and commits to ONE.  
**Not for:** shops or owned-item inventory.

## Semantic contract
Uniform options → exactly one selected → selection changes → one commit path.

## Shared
- Locked options stay visible but dimmed/marked locked.
- 4+ options usually use central confirm; do not put SELECT on every tile.
- 2–3 options may use direct commit and a smaller panel.
- Options wrap to additional rows rather than shrinking into unreadable cards.
- No prices/offers/currency.

## SIM
- Dialog scaffold, aspect ~1.7, wrapper commonly `UDim2.new(1,0,0.4,120)`.
- Tiles ~200×250, gap ~24, art ~110.
- Name ~30, role/subtitle ~22.
- Whole tile is a TextButton.
- Selected stroke ~6 vs normal ~4.
- Locked overlay black ~0.75, rounded ~0.08.
- Confirm green ~35% panel width ×13% height, y~0.84.
- 6+ → second row, same tile size.
- 2–3 direct-commit variant may use aspect ~1.25.

## STUDS
- Panel width ~45–60%, height ~55%.
- Title bar ~11%.
- 3–5 options one row; tile ~28% content width, aspect ~0.8, gap ~3%.
- Art band ~8–62%, name ~66–84%, role ~86–96%.
- 6+ wrap.
- Selected option bright/outlined; unselected desaturated.
- Locked option dark + badge around 18% tile size.
- Confirm ~35%×13%, gap/bottom breathing ~5%.
