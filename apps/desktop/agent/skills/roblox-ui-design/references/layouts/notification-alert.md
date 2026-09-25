# Layout: notification-alert

**Use for:** toast notifications, reward/achievement banners, errors/status, server announcements.  
**Not for:** decision dialog or persistent HUD.

## Semantic contract
A short-lived message chip that never blocks play. Player never has to touch it.

## Shared
- One transparent stack container, top-center:
  - `AnchorPoint (0.5,0)`;
  - `Position (0.5,0,0.03,0)`;
  - vertical `UIListLayout`;
  - gaps ~1% screen height.
- Newest toast at TOP; stack grows downward.
- Normal toast ~24% screen width ×5.5% screen height.
- Icon optional:
  - square, Fit;
  - ~65% toast height;
  - left with ~1.5% margin.
- Message is exactly one line; use end truncation.
- Uniform width/height/construction; type changes color/content only.
- Static generation shows 2–3 sample toasts of different types.
- No backdrop/dimming/buttons.
- Never center-screen.
- Toasts stack vertically; never overlap or sit side-by-side.
- Server announcement:
  - one wide top-center banner;
  - ~40%w ×6.5%h;
  - gold;
  - replaces itself instead of stacking.

Later behavior only:
- enter tween <=0.3 s;
- hold ~3–5 s;
- exit and destroy;
- max 3 visible; 4th evicts oldest where specified;
- announcement up to ~8 s.

## SIM
- Semantic gradients:
  - green success/reward;
  - red-pink error/warning;
  - blue-cyan information;
  - gold `(252,240,111)→(255,255,127)` rare/achievement.
- White FredokaOne message + black stroke ~3.
- The supplied source mentions a 9-slice chip; the normalized button/surface policy is in `references/core/contradictions.md`.

## STUDS
- Standard bevel-stack bar: dark base/stroke4, gradient face, studs.
- Face color:
  - green success/reward;
  - red error/warning;
  - gold rare/achievement;
  - another bright face for information.
