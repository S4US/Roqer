# Polish Layer

Apply this to every new ordinary screen, themed or not, unless the user asks for a plain, minimal, or static UI. Do not apply it to an edit unless the user asks for polish, and never to `wheel-spin` or `vertical-reel-roll`, whose templates own their animation.

The theme owns construction: shapes, colors, strokes, fonts, and exact asset ids. The selected layout owns the skeleton and measurements. Polish sits on top of both. It never resizes, moves, recolors, or replaces a canonical element, and never breaks a structural rule: no overlap, labels in their own bands, balanced rows, nothing cut at the fold, density kept.

## Motion

Presentation only, with `TweenService`:

- **Open:** a `UIScale` on the panel tweens 0.85 → 1 (`Back`, `Out`, ~0.25 s) each time the screen is shown.
- **Buttons:** hover 1.06, press 0.94, release back to 1, through a `UIScale` child (~0.12 s). `AutoButtonColor = false`.
- **Cards:** hover 1.03. On first show and on every tab switch, cards pop in one after another (≤0.03 s apart, the whole group ≤0.4 s).
- **Ambient, two or three at most:** featured art floats gently (`Sine`, `InOut`, reversing, repeating), an alert dot pulses, a shine sweeps across the featured buy button (`UIGradient.Offset`).

Rules:

- Tween `UIScale.Scale`, transparency, gradient offset, or the position of a decorative child. Never tween the `Size` or `Position` of anything a `UIListLayout`, `UIGridLayout`, or the selected body places.
- Nothing inside a `ScrollingFrame` is rotated, tilted, or rocked. Roblox does not clip rotated descendants, so a tilted element scrolled out of view draws outside the panel. Rotation is only for elements that never scroll. Do not clip with a `CanvasGroup` instead: it renders to a texture that blurs and costs memory.
- The resting state is the canonical state: a screenshot taken after the open animation matches the layout exactly.
- No `RunService` per-frame work. A cosmetic countdown is one `task` loop that ends when the screen leaves the DataModel (`while gui.Parent do ... task.wait(1) end`).
- Handlers may play motion and switch visibility or tabs. They still never buy, grant, or read game data.

## Merchandising state

Seed the states a real shop shows, inside the layout's own cells and bands:

- **Tier** on each card (Common, Rare, Epic, Legendary), expressed with the theme's own means: STUDS through the card's face color, SIM through the card fill tint and the sticker `GRADIENTS`.
- **Tags** on one to three cards (HOT, NEW, BEST, x2): a small upright sticker in the card's top corner, inside the card's bounds and clear of name, art, and price.
- **Owned:** one item whose button reads OWNED in the theme's grey treatment.
- **Discount:** one old price struck through beside the new one, or a "-60%" sticker.
- **Featured value cue:** when the layout has a banner, a discount sticker or a countdown such as "ENDS IN 02:14:09".

**Tabs:** with three or more categories, a row of theme buttons at the top of the content area may switch which category's section is shown, with a clear active state. Each section still uses the selected body's grid, cell size, column rule, and density rules. Two categories stay as stacked sections.

**Balances:** when items cost soft currency, show coin and gem balances with small "+" buttons where the layout allows status content: SIM in pills straddling the top edge, STUDS on the first content row, never in the title bar.

## Finishing detail

- **SIM gloss:** on sticker buttons and cards, a white child frame with the same corner and a top-down transparency gradient (about 0.55 at the top, fully clear by the middle), above the gradient face and below the text. STUDS already carries its shine in the face gradient; never cover the stud pattern.
- **Outline scaling:** record each `UIStroke` with its guide thickness and multiply by `viewport height / 1080` (minimum 1) whenever the viewport changes, so the guide's values stay exact at 1080p and phones do not get heavy outlines.
- **Text caps:** give `TextScaled` labels a `UITextSizeConstraint` so a large screen does not inflate them.

## Code shape

- One data table drives every card (name, icon, price, currency, tier, tag, owned, category), and one empty `onPurchase(item)` near the top is the single place purchase wiring will go.
- Small helpers for text, cards, and tweens keep construction consistent. Use the theme's canonical button builder; add gloss and hover to what it returns rather than writing another.

## Review

After the layout review, check the screenshot for polish defects: a tag or badge over a name, art, or price, or drawn outside the panel; an owned, discount, or tier state that does not read; an element caught mid-animation. A still image cannot show motion, so do not add playtests to watch it.
