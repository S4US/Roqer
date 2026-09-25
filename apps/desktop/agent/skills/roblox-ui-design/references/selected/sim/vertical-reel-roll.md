# Recovered selected body: SIM / vertical-reel-roll

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="vertical-reel-roll")

# LAYOUT guide: vertical-reel-roll (SPECIALIZED)

For: case/crate/egg opening screens where prizes roll vertically through a center window and decelerate onto the won item (limited-item unboxing, mystery box, item roulette). NOT for radial wheels (wheel-spin) or reward dialogs.

SPECIALIZED means this guide works differently from the other layout guides: the construction and the rolling animation script are canonical — you never write them. The builder script is deployed server-side by `createScript` with the `layoutTemplate` parameter (see "Deploying the builder script" below). The ONLY thing that changes per task is the `CONFIG` table at the top of the deployed file (the item list and the winner). Do not restructure the script, do not re-derive the proximity math, do not "improve" the animation.

The defining trait: **a clipped vertical window over a dimmed screen; a tall stack of item cards scrolls down through it, and the card nearest the center grows, brightens, and glows.** Three cards are visible at once; the middle one is the focus. A single ROLL button with a dice icon sits below the window and triggers the roll.

## Composition (1080p)

- Fullscreen black overlay at transparency 0.6 dims the world; this is the ONE layout where a backdrop is required. No card, no panel, no title, no close button.
- ROLL button: 220x64 px, centered 350 px below screen center (just under the reel window), dice icon on the left, "ROLL" label on the right. It is the ONLY button on screen; clicking it runs the roll, it hides while the reel is rolling, and it returns when the reel lands.
- Reel window: 300x600 px (offset, not scale), centered, `ClipsDescendants = true`, transparent background.
- Item cards: 200x200 px, stacked upward at 200 px pitch inside a zero-size holder frame; rolling moves the holder DOWN so cards flow downward through the window.
- Each card: rarity-colored chance line on top, item image 100x100 in the middle, rarity-colored value line at 0.73, white item name at the bottom; a glow image behind the card that only shows near the window center.
- All text FredokaOne, TextScaled, black glyph strokes at transparency 0.8.

## Fixed assets and colors

- Card glow: `rbxassetid://4925956526` (ImageColor3 = rarity color, random rotation per card).
- ROLL button dice icon: `rbxassetid://110883654232694` (aspect-locked Fit, left of the ROLL label in a centered horizontal lockup).
- Item images: real Roblox catalog items render via `rbxthumb://type=Asset&id=<assetId>&w=420&h=420`; game-specific items use icons-and-images catalog art instead.
- Rarity colors (exact, never invented): Common (205,205,205), Uncommon (34,255,41), Rare (255,190,25), Epic (161,46,151), Legendary (255,255,17), Mythic (255,0,89), Collector (150,0,25).

## Theme adaptation

The reel itself is theme-neutral: no panels, identical in both themes; the item art is the content surface (rbxthumb for real catalog items, icons-and-images catalog art for game items). The ROLL button is the one themed element: the deployed template already builds it with the style guide’s `makeStickerButton`, green, with the dice icon beside the label.

## Deploying the builder script

The builder script is canonical and deployed server-side — you never write or paste it. Create it with a single `createScript` call using `layoutTemplate` and NO `content`:

createScript({ parentId: "sps", robloxClass: "LocalScript", name: "VerticalReelRoll", layoutTemplate: "vertical-reel-roll" })

The server inserts the complete canonical script — reel window, item cards, theme ROLL button, sounds, and animation — exactly as maintained in the skill package. While this layout is active, hand-writing a ScreenGui LocalScript is rejected; deploy the template instead.

Then customize ONLY the `CONFIG` table at the top of the deployed file: readScript the CONFIG section, then editScript the item list (20+ items, winnerIndex >= 15; icons are numeric catalog asset ids rendered via rbxthumb, or icons-and-images catalog art for game items) to fit the task. Everything below the CONFIG table stays exactly as deployed.

## Rules

- The deployed script begins with `-- layout: vertical-reel-roll`; keep that line and everything outside CONFIG untouched.
- The glow asset id and the rarity color map are used exactly as listed; invented rarity colors are a defect.
- `CONFIG.items` has at least 20 entries and `winnerIndex` is at least 15; a short reel that barely rolls is a defect.
- Every rarity named in CONFIG exists in the color map, and each item's chance/value lines use its rarity color; the name line is always white.
- No card chrome, no panel, no title: the dark overlay, the reel window, the cards, and the ROLL button are the entire screen.
- The ROLL button is the only button, always carries the dice icon, is built through the theme's canonical button builder, hides while rolling, and returns when the reel lands. A reel with no ROLL button, or one that rolls without being clicked, is a defect.
- Card pitch, card size, and the 300x600 window are fixed offsets; converting them to scale sizing is a defect.
- The roll always lands the winner centered in the window and icons stay aspect-locked (Fit).
- The animation script stays as deployed: no remotes, no MarketplaceService, no server scripts. Real odds and inventory grants get wired in a follow-up task.
