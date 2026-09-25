# Source Contradictions and Normalization Policy

The supplied reconstruction contained these conflicts. The normalized decisions below preserve them explicitly.

## SIM native sticker buttons vs selected 9-slice language

SIM base says every normal button is built through native `makeStickerButton` (TextButton + UICorner + UIGradient + Border UIStroke).
Selected `incremental-clicker` and `notification-alert` descriptions refer to a "canonical 9-slice" button/chip.

Normalized policy:
- preserve the conflict;
- for ordinary SIM controls, prefer the canonical `makeStickerButton` implementation from the base unless a maintained specialized template owns the component;
- do not invent an external 9-slice asset ID absent from the selected guide.

## SIM incremental-clicker counter color

SIM base says text glyph fills are only white or navy, accents live on surfaces.
Selected incremental-clicker explicitly describes a cyan gradient counter.

Normalized policy: selected layout-specific counter treatment wins for that display value.

## SIM stat-leaderboard value chip

An early selected-layout sentence describes a green gradient value chip, but the canonical row implementation uses a plain TextLabel and the final Rules explicitly say a pill/chip reads as a button and is a structural failure.

Normalized policy: plain TextLabel wins (canonical implementation + final explicit failure rule).

## SIM vertical-navigation sizing

Selected sidebar guide contains a generic "Scale, never offset" style statement while its canonical skeleton uses many fixed offsets.

Normalized policy: preserve the canonical skeleton measurements; do not rewrite them solely to satisfy the generic sentence.

## STUDS admin player data

Generic theme generation says static/hardcoded UI with no live data reads.
Admin selected reference implementation reads real `Players:GetPlayers()` and pads with demo names.

Normalized policy: for a static visual-only first pass, hardcoded/padded demo players are sufficient. If following the canonical admin template/reference exactly, the selected layout-specific player list behavior may override the generic static rule. Do not add other live-data dependencies.

## STUDS admin panel height

Prose says panel height depends on the ACTIVE page's row count; reference code appears to compute around maximum category command count.

Normalized policy: prefer the explicit active-page density rule for normalized layout sizing; preserve raw reference code unchanged in source archive.

## Motion vs static-generation ban

The recovered theme bodies originally banned TweenService and RunService during UI generation, and produced correct but lifeless screens.
`wheel-spin` and `vertical-reel-roll` explicitly ship maintained canonical templates with animation.

Normalized policy:
- ordinary screens stay static in their *data* (hardcoded content, no remotes, purchases, product lookups, leaderstats, or per-frame RunService work) and add presentation motion through `references/core/polish.md`;
- the polish layer only adds: it never changes a theme construction rule, color, asset id, or a selected body's geometry, and any conflict resolves in favour of the theme and selected body;
- specialized templates keep their maintained animation, get no polish layer, and the agent must not hand-write new behavior into them.

## Conflict priority

When executing:
1. specialized-template contract;
2. selected layout's explicit final Rules / canonical implementation;
3. theme base;
4. polish layer, which adds to 2 and 3 and never overrides them;
5. generic core guidance.

Never alter a canonical Lua template outside its documented `CONFIG` table.

## Specialized `-- layout` first-line rule vs managed template prefix

The specialized guide says the deployed script begins with `-- layout: wheel-spin`.
The captured canonical SIM wheel body actually has a 155-line managed `LEMONADE_UI_SCALE_CONVERTER` prefix, with `-- layout: wheel-spin` at line 156.

Normalized policy: exact captured template body wins. Preserve the managed prefix; do not relocate the layout marker.

## SIM and STUDS specialized templates are not interchangeable

The captured SIM wheel template is 553 lines. A real STUDS wheel deployment reports 571 lines.

Normalized policy: treat specialized templates as `(theme, layout)` artifacts. Never reuse a SIM template as the STUDS canonical body or vice versa unless byte-equivalence has been proven from full captures.
