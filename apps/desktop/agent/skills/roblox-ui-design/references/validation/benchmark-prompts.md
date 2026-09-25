# Benchmark Prompts

Use these to test layout classification and implementation reliability. For each, evaluate semantic layout choice before visual polish.

1. **Shop** — "Build a pet game store with 8 coin packs, 4 gamepasses, one limited offer, and Robux pricing."
   - Expected: `shop-grid`

2. **Dialog** — "Make a rebirth confirmation showing current multiplier, next multiplier, requirement progress, Confirm and Cancel."
   - Expected: `centered-dialog`

3. **Landing** — "Create a title screen that blocks the game view with a huge game name, PLAY, Settings and Credits."
   - Expected: `fullscreen-landing`

4. **Admin** — "Create an owner console with Actions, Players, Fun, World and commands Kick, Ban, Fly, Teleport To."
   - Expected: `admin-control-panel`

5. **HUD** — "Show coins, gems, round timer, health bar, Shop/Inventory icons and one action button while gameplay remains visible."
   - Expected: `hud-zone-system`

6. **Select** — "Let players choose one of 6 classes, two locked, then Confirm."
   - Expected: `select-screen`

7. **Inventory** — "Build a 20-slot pet inventory with 8 owned pets, empty capacity slots, selected pet details and Equip."
   - Expected: `grid-inventory`

8. **Sidebar** — "Add a permanent left-side menu over gameplay: Shop, Pets, Rewards, Codes, Settings; each has icon and label."
   - Expected: `vertical-navigation-sidebar`

9. **Progression** — "Build Daily/Weekly quests with 6 rows, progress bars, rewards, incomplete/claimable/claimed states."
   - Expected: `progression-hub`

10. **Leaderboard** — "Create a richest-player board with 10 players, rank, avatar/name and coin value; no row actions."
    - Expected: `stat-leaderboard`

11. **Clicker** — "World stays visible. Show total taps, +5 per tap and one huge TAP button; small Shop and Upgrades shortcuts."
    - Expected: `incremental-clicker`

12. **Toast** — "Show reward, achievement, and error notifications at top center; they disappear automatically and need no click."
    - Expected: `notification-alert`

13. **Wheel** — "Build an 8-slice lucky wheel with SPIN and three spin-pack purchases."
    - Expected: `wheel-spin`, specialized template

14. **Reel** — "Make a mystery crate opening where 20+ prizes roll vertically through a center window and land on one item."
    - Expected: `vertical-reel-roll`, specialized template

## Edit benchmarks

15. "Change only the Shop close button label from X to Back without changing panel size or product grid."
    - Expected: editing protocol, no layout reclassification.

16. "Add a sixth sidebar button called Events matching the others."
    - Expected: editing protocol; preserve rail skeleton; remain <=6 total.

17. "Make the leaderboard value column wider."
    - Expected: edit existing row geometry while preserving strict aligned columns and read-only semantics.

## Failure probes

18. Request a leaderboard with "Challenge" buttons on every row.
    - Agent should recognize conflict with leaderboard display-only contract and avoid turning rows into action cards unless user explicitly overrides semantics.

19. Request a toast that says "Click OK to continue."
    - Agent should classify this as `centered-dialog`, not notification-alert.

20. Request a clicker inside a centered opaque panel that blocks the world.
    - Agent should recognize this conflicts with `incremental-clicker`; either choose `fullscreen-landing` if the action is entry/play, or preserve visible-world clicker skeleton.

21. Request a wheel but ask the agent to redraw the wedges with Frames.
    - Agent should retain specialized template/chrome contract unless user explicitly requests replacing the canonical mechanic architecture.

## Scoring

For each benchmark score:
- Layout classification: 0/1
- Skeleton correctness: 0–2
- Semantic interaction contract: 0–2
- Theme construction: 0–2
- Asset correctness: 0–1
- Evaluable demo state: 0–1
- Validation behavior: 0–1

Total: 10 points.
