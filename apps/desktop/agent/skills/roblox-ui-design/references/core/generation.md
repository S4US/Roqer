# Core Generation Rules

## Programmatic UI

Ordinary Roblox GUI is created through a builder **LocalScript**, not as loose edit-time GUI instances. If the bridge has no structured operation that creates the builder, use `execute_luau` only to create/find the `LocalScript`, leaving `Source` untouched, then write the body with `set_script_source`.

For a new UI:
1. Inspect existing Studio/UI context only when it can affect the route.
2. Choose the semantic layout and theme.
3. If SIM/STUDS is active, load the recovered theme parts named by the entrypoint plus `references/selected/<theme>/<layout>.md`; that selected body is the geometry/composition authority.
4. Resolve required icons/assets before or while writing the builder.
5. Start an ordinary builder with `-- layout: <slug>`. Canonical wheel/reel templates keep their managed prefix before this marker.
6. Build a stable named ScreenGui and stable builder LocalScript.
7. Seed representative hardcoded content, including the states in `references/core/polish.md`.
8. Add the polish layer's motion and finishing detail (`references/core/polish.md`) on top of the theme construction.
9. Render, inspect, and screenshot the result; compare it to the selected body's measurements/rules before finishing.

## Responsive geometry

For an ordinary selected layout, interpret its `Scale` measurements directly against the live `ScreenGui`/viewport. A rule such as `Size = UDim2.new(0.45, 0, ...)` means 45% of the actual screen width, not 45% of an invented fixed-width design canvas.

A panel sized by separate width and height screen fractions (STUDS panels such as `UDim2.new(0.45, 0, 0.66, 0)`) describes its 1080p shape, not a stretch. Lock that shape with a `UIAspectRatioConstraint` of `AspectRatio = (widthScale × 16) / (heightScale × 9)` and the default `FitWithinMaxSize`, so an ultra-wide or narrow window shrinks the panel instead of distorting it. Derive every pixel measurement inside it (cells, banner, rows) from the panel's `AbsoluteSize`, not the viewport, so they follow the locked shape.

Use Scale for responsive outer geometry, Offset for deliberate pixel details, and layout objects/constraints for repeated content. **Do not wrap an ordinary selected layout in an arbitrary fixed `DesignCanvas` plus root `UIScale` unless that selected body or an exact specialized template explicitly requires it.** Mixing viewport-relative Scale rules with an unrelated fixed canvas changes their meaning and can collapse column counts or distort density.

For a supplied screenshot/mockup, a coherent pixel design canvas plus uniform root `UIScale` may be used when preserving that reference image's fixed composition requires it. That is a reference-reconstruction technique, not the default shell for ordinary generated UI.

No visible screen UI may occupy the top-left `350×70` Core UI keep-out unless the existing project deliberately owns that area.

## Reference-image reconstruction

When a screenshot/mockup is supplied, treat it as the primary composition specification. Preserve outer footprint/aspect, placement, header proportions, rows/columns, card aspect ratios, gaps/padding, relative type/art/button scale, density, and negative-space distribution. The active theme changes construction/style; the semantic layout fills unspecified behavior. Do not replace the reference's geometry with a generic layout default and do not stretch it to fill a wider viewport.

## Static data, live presentation

For ordinary layouts, the initial UI hardcodes its data and wires no game behavior:
- hardcode names, amounts, values, prices, progress, and demo states;
- no MarketplaceService/product lookup;
- no RemoteEvents/RemoteFunctions;
- no leaderstats reads;
- no RunService per-frame work;
- click handlers may toggle visibility or tabs and play presentation motion.

Presentation motion with `TweenService` (opening, hover and press, staggered entry, a little ambient motion) is part of a finished screen, not game behavior: follow `references/core/polish.md`. Wire gameplay/data behavior in a follow-up task.

Exception: specialized canonical templates (`wheel-spin`, `vertical-reel-roll`) include their maintained animation, and the polish layer does not apply to them.

## Evaluable state

Never render an empty shell when the layout is state-dependent. Seed the state that best exposes the design:
- shop → believable products/sections/offers;
- inventory → filled + empty slots and a selected item;
- progression → incomplete + claimable + claimed;
- leaderboard → ranked descending values;
- notifications → 2–3 simultaneous different toast types;
- wheel → open and spinnable;
- reel → configured long item stack with a winner;
- admin → active category with commands;
- select screen → selected and locked states where appropriate.

## Keep structures semantic

A layout is more than visual styling:
- shop cards sell;
- inventory slots select owned items;
- progression rows show goal/progress/reward/claim state;
- leaderboard rows display only;
- select tiles compare and commit to one;
- admin pages issue commands;
- clicker centers a repeatable earn action;
- toast informs and disappears.

Do not blur these interaction contracts.
