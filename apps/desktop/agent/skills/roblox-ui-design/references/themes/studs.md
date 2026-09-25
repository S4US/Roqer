# Theme: STUDS / studded-blocky-cartoon

## Identity

Every visible component is a square, chunky 4-layer bevel stack:

1. **Base** — dark shade, square corners, black `UIStroke` thickness `4`.
2. **Face** — child frame anchored top; title bars are flat solid, every other face uses a white→color vertical gradient.
3. **Stud overlay** — tiled image across the whole face.
4. **Content** — FredokaOne, white/near-white, black glyph stroke; icons aspect-locked.

No `UICorner`.

Stud patterns:
- dense: `rbxassetid://92521981645530`, transparency ~0.5–0.6;
- sparse featured banners: `rbxassetid://102751665779866`, ~0.32 plus rotated transparency gradient.

Tile size:
- title bars: ~`round(barHeight*1.3)`;
- buttons: ~`round(buttonHeight*0.9)`;
- cards/banners/bars: ~`round(height*0.6)`, clamped 40–110 px.

Studs must read clearly; fine/zoomed-out texture is a defect.

## Panel

- black panel background, transparency ~`0.40`;
- panel height normally within `[0.40,0.66]`;
- last content element ends within ~12% of panel bottom;
- dark colors belong to bases/outlines/background; faces remain bright/saturated.

## Title bar

Every titled panel uses a title bar bevel stack:
- scoped title icon exactly `50×50`, fully inside bar, left ~1.5%;
- title FredokaOne white + black stroke, left-aligned after icon;
- bright-red close button fully INSIDE title bar, flush right, about 66% of bar height.

Match the title-bar close construction described here; the packaged specialized templates already contain their exact implementation.

## Canonical button

- dark base + black stroke `4`;
- face height `0.90`;
- 3-stop shine: white at 0 → light tint around 0.1 → saturated color at 1, rotation 90;
- dense edge-to-edge studs;
- label/icon lockup centered;
- icon ~55–60% button height, explicit pixel square;
- minimum ~140×48;
- button should not exceed ~30% of its card height.

Green = primary/CTA; destructive may be red.

## Robux / coin prices

Robux buttons are green and use exact:
`rbxassetid://87608142780557`

Coin:
`rbxassetid://84697600263846`

Icon + amount are one centered horizontal group; do not pin icon and text to unrelated edges.

## Integral assets

- shop basket `rbxassetid://110972987269284`
- pig + money `rbxassetid://103120983042082`
- coin `rbxassetid://84697600263846`
- cash stack `rbxassetid://70565105539676`
- crystal `rbxassetid://73150429062000`
- diamond `rbxassetid://75581768563141`
- Robux `rbxassetid://87608142780557`
- sunburst `rbxassetid://91084849147872`

Use these exact IDs for covered semantics. For content beyond this list, use the verified project-art or Creator Store search flow in the asset reference.

Decorative rays use the sunburst asset, never rotated Frame rays.

## Text

- FredokaOne.
- Content text is white/near-white with black glyph stroke.
- Big display numbers: white→gold gradient, rotation 90.
- Timers may use red variant.
- Plain headings are bare TextLabels.

## Engine constraints

- Interactive elements >=44 px high.
- Explicit pixel square size for icons, close buttons, rank badges, slots, hubs.
- Avoid zero Scale width on visual squares; aspect constraints can collapse them.
- Do not place scale fractions in UDim2 offset slots.
- `AutomaticCanvasSize = Enum.AutomaticSize.Y` where layout specifies scrolling.
- TextScaled clamps around 100 px; very large display text can use RichText font size above that.

## Core UI keep-out

No visible element may occupy the top-left 350×70 px Core UI rectangle.
