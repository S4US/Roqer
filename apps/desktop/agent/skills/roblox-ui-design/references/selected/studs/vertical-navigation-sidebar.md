# Recovered selected body: STUDS / vertical-navigation-sidebar

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="vertical-navigation-sidebar")

# LAYOUT guide: vertical-navigation-sidebar

For: persistent sidebar menus over gameplay: a vertical stack of labeled nav buttons on a screen edge (Shop, Pets, Rewards, Codes, Settings) where each button opens its own menu. NOT for HUDs with stat readouts or icon-only corner stacks (that is hud-zone-system), admin category rails (admin-control-panel), or any bordered panel with a title bar.

The defining trait: **an edge-anchored button rail over the visible world.** The rail IS the whole screen's UI: no panel, no title bar, no close button, no backdrop. Gameplay stays fully visible; the rail hugs one edge and everything else is empty.

## Measurements (1080p)

- Container: ONE transparent Frame anchored to the LEFT screen edge, AnchorPoint (0, 0.5), Position (0.015, 0, 0.5, 0), sized to its buttons. UIListLayout vertical, ~1.2% screen-height padding between buttons.
- Buttons: 3 to 6, uniform, each ~9% screen width x ~7% screen height, canonical style-guide button construction, one color per destination.
- Button content: square icon (Fit, aspect 1, ~55% of button height) LEFT with ~8% button-width margin, TextScaled label beside it in a container ~58% of button height, icon + label centered as a row. Both are mandatory: an icon-only stack is hud-zone-system, a text-only rail is a defect here.
- Optional notification badge: a small square bevel chip on a button's top-right corner, ~28% of button height, red face, white count text with stroke. At most one badge per button.
- Size and position in Scale, never offset: the rail must hold on phone aspect ratios.

## Rules

- No panel, no title bar, no close button, no backdrop: the world stays fully visible. A bordered plate or dark strip behind the rail is a defect.
- ONE column, vertically centered on the screen edge. A rail pinned into a top corner is a HUD zone, not this layout; two columns is a menu, not a sidebar.
- Buttons are uniform: same width, same height, same construction. A "featured" bigger button is a defect.
- Each button opens its own menu; the rail itself never expands, slides out, or becomes a panel. Nothing else on this screen belongs to the rail.
- At most 6 buttons. More destinations than 6 means the game needs a menu screen, not a longer rail.
- Compact over large: the rail is read while playing. If the rail could shrink and still read, shrink it.
