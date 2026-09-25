# Recovered selected body: STUDS / select-screen

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="select-screen")

# LAYOUT guide: select-screen

For: character/skin/class pickers, team select, map or mode select, hero select, job and role pickers: any screen where the player compares a few options and commits to ONE. NOT for shops (those sell), inventories (those manage), or dialogs.

The defining trait: **a row of comparable option tiles, exactly one selected, and a single confirm.** Every tile shows the same fields so options can be compared at a glance. Locked options stay visible and dimmed, never hidden: seeing what you have not unlocked is the point.

## Measurements (1080p)

- Panel: 45-60% screen width x 55% screen height, centered. Models consistently build ~45-50% wide select panels and they read fine; do not stretch the panel to hit a bigger number.
- Title bar: ~11% of panel height, close button flush right per the style guide.
- Option tiles: 3 to 5 in ONE centered row, each ~28% of content width, portrait aspect ~0.8, with ~3% content-width gaps. Laid out by a horizontal UIListLayout, centered as a group.
  - Tile content bands: art 8-62% of tile height (Fit + aspect 1), name 66-84%, optional one-line stat or role label 86-96%. Bands never overlap.
  - 6 or more options: keep the SAME tile size and wrap to a second row; never shrink tiles to fit one row.
- Selected tile: the bright face plus a visible selection cue (a brighter face and a thicker/lighter outline than its neighbours). Unselected tiles use a desaturated face of the same construction.
- Locked tile: dark face, name still legible, a lock badge in the tile's top-right at ~18% of tile width. Locked tiles are never removed from the row.
- Confirm button: ONE, centered below the row, ~35% panel width x ~13% panel height, ~5% panel height below the tiles. Canonical style-guide button, green face.
- Bottom breathing room: >= 5% panel height below the confirm button.

## Rules

- Exactly one tile reads as selected at all times. A screen where every tile looks identical is a defect: the selection state must be visible in a still screenshot.
- With 4 or more options: one confirm action, and it lives BELOW the row, not on the tiles. A tile carrying its own SELECT / LOCKED / CHOOSE button is a defect: the tile itself is the click target, and the single button below commits.
- With 2-3 options (team pickers, yes/no class splits): tiles MAY commit directly on click and no confirm button is needed — but each tile still uses the full bevel construction, and the panel shrinks to fit (a 2-tile picker inside a half-empty full-size panel is a defect).
- Every tile carries art in its art band. A row of text-only tiles is a defect; if no listed icon fits the content, use a coloured face plus the name rather than leaving the band empty.
- Tiles are uniform: same size, same fields, same construction. A "featured" option rendered larger is a defect.
- No prices anywhere. A price on a tile means this is a shop, not a select screen.
- Locked options are shown dimmed with a lock badge, never omitted and never merely greyed text.
- Compare, don't sell: no banners, no offers, no currency chips in this layout.
