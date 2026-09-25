# Recovered selected body: STUDS / wheel-spin

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="wheel-spin")

# LAYOUT guide: wheel-spin (SPECIALIZED)

For: prize wheel / lucky wheel / spin-to-win screens: a radial wheel of 8 prize wedges, a pointer, a SPIN button, and spin-pack purchase buttons. NOT for vertical rolling reels (vertical-reel-roll), shops, or reward dialogs.

SPECIALIZED means this guide works differently from the other layout guides: the wheel chrome is built from the EXACT asset ids listed below (never swapped for icon-catalog equivalents, never re-drawn with native frames), and the builder script is canonical — you never write it. It is deployed server-side by `createScript` with the `layoutTemplate` parameter (see "Deploying the builder script" below). The ONLY thing that changes per task is the `CONFIG` table at the top of the deployed file (the 8 prizes, demo counters, spin-pack prices). Do not restructure the script, do not re-derive the geometry, do not "improve" the animation.

## Fixed chrome assets (exact, not from the icon catalog)

- Wheel ring base: `rbxassetid://110833418157060`
- Wedge divider overlay: `rbxassetid://134944584099686` (ImageColor3 black)
- Center hub: `rbxassetid://132449669432787`
- Pointer arrow: `rbxassetid://121446361788141` (aspect 1.319, points DOWN at the wheel top)
- Open-button wheel icon: `rbxassetid://79841360279510`
- Wedge slice masks, one per position 1-8 (each is the same wedge pre-rotated; they are positional, never reordered): `93917478516867`, `126317571251493`, `85329237473568`, `139163490421697`, `79640255136580`, `116368159017334`, `107141681148446`, `104881857625848`
- Sounds: hover `99955064134003`, click `87437544236708`, spin loop `5406934065`, reward `4612378086`

Prize art INSIDE the wedges is content, not chrome: those images come from the icons-and-images catalog per prize.

## Composition (1080p)

- No card, no panel, no title bar: the wheel floats over the world. A card behind the wheel is a defect.
- Wheel: square, ~27% screen width (aspect-locked), centered at (0.5, 0.46). Pointer at top center over the rim. Close button just right of the wheel top. All sizing lives in the script's geometry tables.
- Under the wheel: spins-remaining line, then the free-spin timer line beside the SPIN button, then a row of three buy-pack buttons with their "+ N Spins" captions.
- HUD open button at the left edge (0.032, 0.46) with a red timer chip; it toggles the wheel.
- The screen generates OPEN (wheel visible) so the build is verifiable in a screenshot.

## Theme adaptation

The wheel chrome keeps its exact assets in every theme. The BUTTONS (open, close, SPIN, buy packs) are NOT chrome: the deployed template already builds every one of them as the canonical studded bevel-stack button (dark base + black stroke 4, face 0.90 with the 3-stop shine, edge-to-edge studs at the button tile size): green with the Robux icon for the buy packs, gold for SPIN, bright red for the close X. Wedge accent colors come from CONFIG and should sit in the theme's bright saturated palette.

## Deploying the builder script

The builder script is canonical and deployed server-side — you never write or paste it. Create it with a single `createScript` call using `layoutTemplate` and NO `content`:

createScript({ parentId: "sps", robloxClass: "LocalScript", name: "WheelSpinUI", layoutTemplate: "wheel-spin" })

The server inserts the complete canonical script — chrome assets, wedge geometry, theme buttons, sounds, and animation — exactly as maintained in the skill package. While this layout is active, hand-writing a ScreenGui LocalScript is rejected; deploy the template instead.

Then customize ONLY the `CONFIG` table at the top of the deployed file: readScript the first ~40 lines, then editScript the prize entries (8 prizes in wedge order, chances sum to 100, prize icons from the icons-and-images catalog), the demo counters, and the spin-pack prices to fit the task. Everything below the CONFIG table stays exactly as deployed.

## Rules

- The deployed script begins with `-- layout: wheel-spin`; keep that line and everything outside CONFIG untouched.
- Chrome asset ids are used exactly as listed. A wheel rebuilt from native frames, or with catalog art in place of the ring/slices/hub/arrow, is a defect.
- Every button (open, close, SPIN, buys) is a `makeStudButton` button. Reusing the source system's pill/badge button images is a defect.
- `CONFIG.prizes` is exactly 8 entries and the chances sum to 100. Prize icons come from the icons-and-images catalog (aspect-locked Fit, never stretched).
- Wedge accents are bright saturated theme colors; no two adjacent wedges share an accent.
- No card, panel, backdrop, or title behind the wheel; the world stays visible.
- The animation script stays as deployed: no remotes, no MarketplaceService, no server scripts. Purchases and real spin inventory get wired in a follow-up task; buy buttons only animate.
- The screen generates open and spinnable so a screenshot shows the full wheel.
