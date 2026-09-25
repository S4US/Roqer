# Layout: stat-leaderboard

**Use for:** top-player rankings, richest list, kill board, high scores.  
**Not for:** the local player's own stat readout (`hud-zone-system`).

## Semantic contract
Read-only ordered display:

`rank | player | value`

No row-level actions.

## Shared
- Strict descending demo values.
- Rank 1 visible immediately.
- Uniform rows.
- Fixed columns: rank X constant, player-name start X constant, value end X constant.
- Do not let value alignment drift with name length.
- Top 1/2/3 remain ordinary rows, not a podium; only rank styling changes.
- No View/Trade/Challenge/Add buttons.

## SIM
- Narrow portrait card ~29% screen width ×61% height, aspect ~0.85.
- Row height ~60 px, gap ~4; visible viewport should be a whole multiple of 64 px.
- If headers/tabs consume 64 px, remove a demo row instead of clipping.
- Every row includes circular avatar art; use distinct full-color catalog icons for demo players and `rbxthumb` only for actual players where appropriate.
- Top-three rank badges: gold/silver/bronze; later ranks neutral.
- Value must be a plain TextLabel in normalized execution; do not use a button-like price pill.
- Local player may receive a brighter/cyan-wash row treatment without changing row structure.

## STUDS
- Panel ~38% width ×68% height.
- Title ~10% height.
- Row ~64 px, gap ~6, full width minus ~26 px.
- Three columns: rank badge, player name, right-aligned value.
- Rank badge ~70% row height.
- Top-three gold/silver/bronze; later neutral.
- Name ~45% row width.
- Value right aligned ~2% from right; optional stat icon immediately left.

Load `references/core/contradictions.md` for the SIM value-chip source conflict.
