# Layout: vertical-navigation-sidebar

**Use for:** persistent edge navigation over gameplay with labeled buttons like Shop/Pets/Rewards/Codes/Settings.  
**Not for:** HUD stat stack, admin category rail, bordered panel.

## Semantic contract
The rail itself is the entire UI. Each button opens its own menu; the rail never becomes a panel.

## Shared
- World fully visible.
- No panel/card/title/titlebar/close/backdrop/plate/dark strip.
- One vertical column centered on a screen edge.
- 3–6 uniform buttons; max 6.
- Every button must contain **both** square icon and text label.
  - icon-only → use `hud-zone-system`;
  - text-only → defect.
- Optional notification badge, max one per button, around 28% button height.
- No featured larger button.
- Rail never expands/slides into a panel.

## SIM
- Transparent rail around `(0.015,0,0.5,0)`, roughly 176×430.
- `UIListLayout` gap ~13.
- Buttons ~176×74.
- Icon ~40 px at x~14.
- Label begins around x~62, Fredoka white, left aligned, black stroke ~3.
- Representative colors: Shop green; Pets blue; Rewards green; Codes blue; Settings blue.
- Label and icon stay inside the button.
- Source contains scale-vs-offset contradiction; preserve canonical skeleton.

## STUDS
- Transparent rail at left edge around x~0.015, vertically centered.
- Button size roughly 9% screen width ×7% screen height.
- Vertical gap ~1.2% screen height.
- Icon ~55% button height, left margin ~8%.
- Label beside it, centered as row.
- Optional red studded badge top-right ~28% button height.
- Major size/position uses Scale.
