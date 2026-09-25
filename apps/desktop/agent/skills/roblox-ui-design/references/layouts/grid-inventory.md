# Layout: grid-inventory

**Use for:** inventories, pet/item storage, backpack, locker, owned collection with equip/drop/manage actions.  
**Not for:** shop or one-of-N select screen.

## Semantic contract
Capacity-driven uniform square slots, visible empty capacity, one selected item, one primary management action.

Slot click selects. Primary action operates on the selection.

## Shared
- Render slots according to capacity; empty slots are visible.
- Seed ~5–8 owned items when no data is available.
- Uniform square slots.
- Selected slot clearly highlighted.
- One main action such as Equip/Unequip.
- Optional detail pane.
- No prices/purchase banners.
- Overflow scrolls rather than shrinking slots.

## SIM
- Dialog scaffold, wrapper ~`UDim2.new(1,0,0.46,120)`, aspect ~1.95.
- Optional search.
- Use exact whole rows; >24 slots may scroll.
- Selected stroke ~5 cyan, normal ~4 navy.
- One green primary action.
- Optional count/rarity.
- Optional Equipped/Stored divider.
- Optional detail split ~62% / gap 3% / 35%.
- Capacity indicator dark navy bottom-right.
- Avoid slots taller than ~1.15× width.

## STUDS
- Panel ~50%×60%, aspect ~1.39.
- Title bar ~11%; capacity text like `12/20` in title bar.
- Typical grid: 5 columns, ~4 rows, square cells ~18% content width, gap ~2%.
- Optional attached category rail on left.
- Filled slot bands: art ~8–62%, name ~66–88%, count/rarity top-right.
- One Equip/Unequip action.
- Detail split ~62/35 if used.
- Max ~2 bottom actions.
- No prices/purchase/banner.
