# Specialized Layout: vertical-reel-roll

## Contract

Do not hand-write this UI. Load `templates/<theme>/vertical-reel-roll.lua`. Use `execute_luau` only to create or find the stable `VerticalReelRoll` `LocalScript` without assigning `Source`, then write the customized full body through `set_script_source`.

Customize only the item list and winner/config values in `CONFIG`. Preserve the managed prefix, `-- layout: vertical-reel-roll`, and all code outside `CONFIG` byte-for-byte.

The maintained template owns construction, proximity scaling/glow, sounds, themed ROLL button, and animation.

## Defining interaction

A clipped vertical window sits over a dimmed screen. A tall stack of prize cards flows **downward** through the window. Three cards are visible; the card nearest center becomes the visual focus by growing, brightening, and glowing.

A single ROLL button triggers the mechanic.

## Fixed composition

- fullscreen black overlay, transparency `0.6` — required;
- no card/panel/title/close;
- reel window: exactly `300×600` px, centered, transparent, `ClipsDescendants=true`;
- cards: exactly `200×200` px;
- card pitch: `200` px;
- cards stacked upward in a positional holder; holder moves DOWN;
- ROLL: `220×64` px, centered ~350 px below screen center;
- ROLL is the **only button**;
- dice icon left, label right;
- ROLL hides during rolling and returns after landing.

Do not convert the fixed reel/window/card geometry to Scale.

## Card anatomy

- chance/rarity line at top, colored by rarity;
- item image `100×100`, aspect-locked;
- value line around y=0.73, colored by rarity;
- item name at bottom, always white;
- center-proximity glow behind the card.

Text: FredokaOne, TextScaled, black glyph stroke with transparency ~0.8.

## Fixed assets

- glow: `rbxassetid://4925956526`
  - tint to rarity color;
  - random rotation per card.
- ROLL dice: `rbxassetid://110883654232694`
  - Fit/aspect locked.

Real Roblox catalog item art:
`rbxthumb://type=Asset&id=<assetId>&w=420&h=420`

Game-specific item art:
use exact theme/layout assets, verified project art, or the bounded Creator Store search and preview flow.

## Exact rarity map

- Common `(205,205,205)`
- Uncommon `(34,255,41)`
- Rare `(255,190,25)`
- Epic `(161,46,151)`
- Legendary `(255,255,17)`
- Mythic `(255,0,89)`
- Collector `(150,0,25)`

Never invent rarity colors.

## CONFIG constraints

- `CONFIG.items` >=20 entries;
- `winnerIndex` >=15;
- every rarity name exists in the exact rarity map;
- winner always lands centered;
- short reels that barely move are defective.

## Theme adapter

The reel itself is theme-neutral.

### SIM
ROLL is a green canonical `makeStickerButton` with dice+label.

### STUDS
ROLL is a green studded bevel-stack button with dice+label.

## Runtime boundary

The maintained animation is allowed.
Do not add remotes, MarketplaceService, or server scripts during visual generation.
Real odds/inventory grants are follow-up gameplay wiring.

## Failures

- auto-roll without click;
- no ROLL button;
- additional buttons;
- panel/title/close chrome;
- missing overlay;
- scaling the fixed 300×600 / 200×200 / 200px-pitch geometry;
- <20 items or winner before index 15;
- invented rarity color;
- winner not centered;
- editing template below CONFIG.
