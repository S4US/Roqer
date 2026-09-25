# Layout: hud-zone-system

**Use for:** always-on gameplay HUD: own stats/currency, timers/objectives, side menu buttons, health/stamina, buffs, actions.  
**Not for:** full menus, labeled sidebar-only nav, toast stack.

## Semantic contract
A sparse overlay using semantic screen zones, with the world visible.

## Shared 3×3 zones
- top-left: own stats/currency;
- top-center: objective/timer;
- top-right: controls;
- middle-left/right: menu/control rails;
- bottom-left: health/stamina;
- bottom-center: primary actions;
- bottom-right: secondary status/actions;
- center gameplay area is forbidden; keep roughly the middle 50×50% visually open.
- Normally use 3–4 zones; maximum ~6.
- No panel/scrim/title/close.

## SIM
- top-left anchor uses exact y offset around 80 px to avoid Core UI.
- Currency chip ~260×54, white with navy outline, icon ~44.
- Heavy amount font allowed.
- Standalone rail sticker buttons may be ~86 px with icon ~48 and label ~26.
- Example left rail around `(0.02,0,0.5,0)`, ~110×260; Shop green, Inventory blue.
- Settings ~86 px top-right.
- Health ~420×38 bottom-left.
- Top-center objective ~18% screen width.
- Bottom-center up to 4 actions, roughly ~11%×8%.
- Fixed pixel sizes are common.

## STUDS
- top-left around `(0.02,0,0,70)`.
- Stat chips ~16%w ×5.5%h; icon ~70% chip height.
- Icon buttons ~`UDim2.new(0.045,0,0.08,0)` with aspect 1 (~86 px at 1080p).
- Timer ~18%×7%.
- Health ~22%×3.5%.
- Prefer Scale sizing for major HUD placement.
