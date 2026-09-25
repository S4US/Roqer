# Layout: incremental-clicker

**Use for:** tap/click-to-earn screen with a running total and a giant repeatable earn action.  
**Not for:** blocking title screen, ordinary HUD, upgrade catalog.

## Semantic contract
World remains visible. The click target owns the composition.

## Shared
- No panel/title/close/backdrop.
- Running total centered near top:
  - ~28% screen width ×9% height;
  - center y ~0.10.
- Optional per-click/rate line ~3% screen height.
- Main click target:
  - square;
  - ~15% screen width;
  - centered around `(0.5,0.60)`;
  - at least 2× width and 2× height of any other button;
  - must not be tiny (<~10% screen height).
- Currency icon inside button ~45% target height.
- At most two small secondary shortcut buttons, bottom-right, ~7% screen height, ~2% inset.
- Shortcuts open Shop/Upgrades; do not embed an upgrade list on this screen.
- Initial generation uses a believable nonzero hardcoded total.
- Floating `+N` effects and live increments belong to later behavior wiring.

## SIM
- Total uses heavy font asset; selected guide describes cyan/white display treatment.
- Click target green, currency icon above `TAP!`.
- Use theme button construction per normalized contradiction policy.

## STUDS
- Total uses white→gold big-number treatment.
- Giant green studded bevel-stack target with icon + `TAP!`.
- Secondary controls use normal STUDS buttons.
