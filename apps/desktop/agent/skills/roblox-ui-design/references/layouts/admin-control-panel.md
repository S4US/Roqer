# Layout: admin-control-panel

**Use for:** admin/mod/staff/owner/event/troll/developer command consoles.  
**Not for:** player-facing settings, shop, ordinary dialog.

## Semantic contract
A two-pane operator console:
- category rail on the LEFT;
- dense labeled command grid on the RIGHT;
- command buttons are label-only, never product cards.

Active category visual state must match the visible command page.

## Shared
- One category page visible/exists at a time.
- Default active category should be an action-command page, not Players.
- Commands use a 3-column grid:
  - X cell fraction `0.313`;
  - X gap `0.03`;
  - `3×.313 + 2×.03 ≈ 1`.
- Row height:
  - 1–2 rows → ~145;
  - 3 rows → ~96;
  - 4+ rows → ~64.
- Command region + target row should fill the pane; a dead bottom band means height/density is wrong.
- Destructive commands (kick/ban/freeze/jail/kill) red; ordinary commands non-red.
- Spawnables remain label-only grid entries.
- Player targeting:
  - Players page uses the same 3-column label-only grid;
  - selecting a player writes the name into `TargetBox`;
  - seed/pad >=6 players for evaluation.
- Target state belongs in `TargetRow`; do not create a separate selected-player panel.
- `TargetBox` ~70% width, `AmountBox` ~28%, ~46 px tall.
- `AmountBox` only for commands that use numeric amount.

## SIM
- Dialog scaffold, wide aspect ~1.95.
- Wrapper commonly `UDim2.new(1,0,0.4,120)` (~56×51%).
- Example categories `{Actions, Players, Fun, World}`, >=3.
- Rail pos around `(20 px, y=78)`, width ~28%.
- Rail hugs buttons; no tall empty slab.
- Rail face white/grey gradient, padding ~10 vertical / 8 horizontal, gap ~8.
- Category buttons ~52 px; active green, inactive grey.
- Content pane starts around X 32%, Y 78; width ~68%.
- Target row ~46 px.
- Example action page:
  - Kick/Ban/Freeze red;
  - Unfreeze green;
  - Fly/Teleport To blue.

## STUDS
- Panel baseline width `0.55`, but clamp on ultrawide:
```lua
local viewport = workspace.CurrentCamera.ViewportSize
local panelW = 0.55 * math.min(1, 1.78 / (viewport.X / viewport.Y))
```
- Panel black @0.40.
- Title bar ~11%.
- Rail pos ~(.02,.14), size ~(.22,.83), button h ~52, gap 8.
- Content pane pos ~(.26,.14), size ~(.72,.83).
- Target row ~46.
- Command scroll starts ~54 px below pane top, auto Canvas Y, scrollbar ~6.
- Dynamic height target:
  - 1–2 rows → .42
  - 3 → .47
  - 4 → .51
  - 5+ → .55 and scroll.
- Never shrink width just because there are few commands; 3-column geometry must survive.
- Target inputs are dark track-like components with stroke 4.
- Load `references/core/contradictions.md` for live Players/static-generation and panel-height conflicts.
