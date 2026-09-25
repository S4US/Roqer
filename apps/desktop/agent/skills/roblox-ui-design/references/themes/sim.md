# Theme: SIM / simulator-rounded-cartoon

## Identity

Pet-simulator-like rounded cartoon UI:
- clean white rounded cards;
- dark navy linework `Color3.fromRGB(42,43,49)`;
- hard cartoon downward shadow;
- saturated two-stop sticker gradients;
- FredokaOne;
- titles are bare stroked text straddling the panel top-left;
- one full-color side icon immediately left of the title, parented to the title;
- red/pink close button straddles top-right.

No title bar exists in this theme.

## Canonical dialog scaffold

For dialog/panel layouts:
- transparent centered wrapper;
- shadow: black, transparency `0.75`, ~8 px downward offset, `Size = UDim2.new(1,6,1,6)`;
- card: white, `UICorner` radius `0.035`, navy `UIStroke` thickness `7`;
- title: FredokaOne, white, navy glyph stroke `5`, left aligned, straddling top;
- title side icon: `88×88`, `ScaleType.Fit`, parented to title at its left edge;
- close: canonical red sticker X straddling top-right.

Canonical title measurements:
- `AnchorPoint = Vector2.new(0,0.75)`
- `Position = UDim2.new(0.045,0,0.0116,0)`
- `Size = UDim2.new(0.4,0,0.116,0)`
- `TextXAlignment = Left`

Side icon:
- `AnchorPoint = Vector2.new(1,0.5)`
- `Position = UDim2.new(0,-10,0.5,0)`
- `Size = UDim2.fromOffset(88,88)`

Close:
- `AnchorPoint = Vector2.new(0.5,0.5)`
- `Position = UDim2.new(0.991,0,0,0)`
- `Size = UDim2.new(1,0,0.06,45)`
- aspect `1.05`

The top ~12% straddle band belongs only to title/icon/utility pills/close.

## Canonical sticker button

Every ordinary SIM button should use the canonical `makeStickerButton` behavior:

- empty `TextButton`;
- white base;
- `UICorner` radius `0.3`;
- vertical (`Rotation=-90`) two-stop gradient;
- navy `UIStroke` thickness `4`;
- `stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border`;
- child label: FredokaOne, white, TextScaled, black glyph stroke `3`.

Gradients:
- green `(92,239,0) → (163,253,28)` — primary, confirm, buy, CTA, on;
- red `(255,2,61) → (255,39,125)` — close/back/destructive/off;
- blue `(87,216,255) → (135,255,249)` — secondary/save/info;
- grey `(147,149,168) → (208,212,238)` — inactive/disabled/unselected.

Do not omit the Border-mode navy outline.

## Text

- Titles/floating text over color: white + navy/black glyph stroke.
- Text on white card: navy, no glyph stroke.
- Secondary body copy: `(84,86,98)`, no stroke.
- Normal glyph fills are white or navy; layout-specific exceptions are documented in `references/core/contradictions.md`.
- Numbers may use `Font.new("rbxassetid://11702779409", Enum.FontWeight.Bold)`.

## Panels and composition

- Dialog wrappers are centered.
- Pick aspect per layout (`1.25` compact dialog, `1.7` mid, `1.95` wide).
- Do not leave a dead white bottom half; last content should end within roughly 8% of card bottom.
- Center content groups horizontally.
- Shared action-row buttons are uniform width and height.
- Section headings are centered bare labels with divider lines where appropriate.

## Images

SIM's house art is the [curated icon catalog](../icons/index.md): 106 verified image IDs in exactly this theme's style — square, pre-coloured, navy outline, sticker gradients. Load the index whenever a screen needs icons and use its IDs verbatim; they need no resolution step.

Its `X` is this theme's close glyph. Currency counters, shop and navigation chrome, boosts, luck, pets, quests and progression all resolve there.

Invent no IDs. For essential content art the catalog does not cover — a particular pet, product or item — follow the Creator Store fallback in [assets](../core/assets.md). Omit non-essential decoration rather than substituting a vaguely related icon. Keep semantic art full colour with `ScaleType.Fit` and no tint.

Exception: specialized layouts (`wheel-spin`, `vertical-reel-roll`) require their exact chrome/glow IDs.

## No-panel layouts

`hud-zone-system`, `vertical-navigation-sidebar`, `notification-alert`, `fullscreen-landing`, and `incremental-clicker` place elements directly on the ScreenGui instead of using the dialog scaffold.

## Core UI keep-out

No visible element may occupy the top-left 350×70 px Core UI rectangle. Elements near top-left should use a Y offset >=70 px rather than a tiny scale Y.
