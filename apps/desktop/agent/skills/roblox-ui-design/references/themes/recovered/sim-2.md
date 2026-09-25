# Recovered SIM theme body — part 2/3

> Canonical visual/construction guidance from the reference agent. Legacy tool/deployment names are provenance; current Roqer execution rules and specialized contracts/templates override those names only.

## STICKER BUTTON BUILDER (for layouts WITHOUT the panel scaffold)

The scaffold above already begins with `makeStickerButton`. Layouts with NO panel (hud-zone-system, vertical-navigation-sidebar, fullscreen-landing, incremental-clicker, notification-alert) paste THIS block instead. Every button in every sim UI — dialog actions, buy pills, claim chips, HUD tiles, landing CTAs, tabs, admin commands, nav rail buttons — is created through this function and then gets its children (icons, badges) added. A button built any other way, or a re-typed `makeStickerButton` from memory, renders as a flat unoutlined fill and fails the measured button-outline gate. Paste it verbatim:

```lua
local NAVY = Color3.fromRGB(42, 43, 49)
local GRADIENTS = {
    green = ColorSequence.new(Color3.fromRGB(92, 239, 0), Color3.fromRGB(163, 253, 28)),
    red = ColorSequence.new(Color3.fromRGB(255, 2, 61), Color3.fromRGB(255, 39, 125)),
    blue = ColorSequence.new(Color3.fromRGB(87, 216, 255), Color3.fromRGB(135, 255, 249)),
    grey = ColorSequence.new(Color3.fromRGB(147, 149, 168), Color3.fromRGB(208, 212, 238)),
}

local function makeStickerButton(parent, colorName, labelText, size)
    local button = Instance.new("TextButton")
    button.Text = ""
    button.BackgroundColor3 = Color3.new(1, 1, 1)
    button.Size = size
    button.Parent = parent
    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0.3, 0)
    corner.Parent = button
    local gradient = Instance.new("UIGradient")
    gradient.Rotation = -90
    gradient.Color = GRADIENTS[colorName]
    gradient.Parent = button
    local stroke = Instance.new("UIStroke")
    stroke.Color = NAVY
    stroke.Thickness = 4
    -- Border mode is LOAD-BEARING: the default (Contextual) strokes a text
    -- object's GLYPHS, and this button's own Text is empty, so without this
    -- line the outline renders as NOTHING.
    stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
    stroke.Parent = button
    if labelText ~= "" then
        local label = Instance.new("TextLabel")
        label.BackgroundTransparency = 1
        label.Font = Enum.Font.FredokaOne
        label.Text = labelText
        label.TextColor3 = Color3.new(1, 1, 1)
        label.TextScaled = true
        label.AnchorPoint = Vector2.new(0.5, 0.5)
        label.Position = UDim2.new(0.5, 0, 0.5, 0)
        label.Size = UDim2.new(0.9, 0, 0.62, 0)
        label.Parent = button
        local labelStroke = Instance.new("UIStroke")
        labelStroke.Color = Color3.new(0, 0, 0)
        labelStroke.Thickness = 3
        labelStroke.Parent = label
    end
    return button
end
```

Set Position/AnchorPoint on the returned button as the layout needs. Icon-on-button: add an ImageLabel child (Fit, aspect 1, ImageColor3 left white so the art keeps its natural colors).

## CONSTRUCTION: every panel is one rounded white card; every button is one rounded gradient sticker

1. Panel root: a TRANSPARENT wrapper Frame carries the anchor, position, size, and a UIAspectRatioConstraint. Inside it, exactly two layers: the Shadow (ZIndex 1), then the Card (ZIndex 2).
   - Shadow: a plain Frame (black, BackgroundTransparency 0.75) offset ~8px DOWN from center, `Size = UDim2.new(1, 6, 1, 6)`, with the same UICorner as the card: a chunky hard cartoon drop shadow. No image assets.
   - Card: Frame `Size = UDim2.new(1, 0, 1, 0)`, BackgroundColor3 WHITE (255,255,255), BackgroundTransparency 0, UICorner `CornerRadius = UDim.new(0.035, 0)`, UIStroke Color3 (42,43,49) Thickness 7. All content parents to the Card. The card face stays CLEAN white: no texture or pattern overlays.
2. Canonical button (every button in every UI): the `makeStickerButton` builder above — white TextButton, UICorner `UDim.new(0.3, 0)`, vertical two-stop UIGradient carrying the action color, navy UIStroke (42,43,49) thickness 4, white FredokaOne TextScaled label with black glyph stroke 3. EVERY interactive element (buttons, close button, tabs, toggle knobs, bar tracks) carries that navy outline: a flat unoutlined gradient pill is a defect. Never build a button by hand when the builder is in scope.
4. Text: FredokaOne everywhere. Three treatments, chosen by what the text sits on:
   - Floating over the panel edge or over color (titles, button labels, values on gradients): WHITE TextColor3 + glyph UIStroke (42,43,49) thickness 5 for titles, black thickness 3 for button labels and values.
   - Sitting ON the white card (row labels, section headings, body copy): dark navy (42,43,49), NO stroke. Secondary/description lines: (84,86,98), NO stroke.
   - Text glyph fills are ONLY ever white or dark navy: colored glyph fills (cyan, green, red, yellow text) are a defect. Accents come from gradients on SURFACES (bars, buttons, badges), never from coloring the text itself; counters and values over color are white glyphs with black stroke 3.
   Numbers and amounts may use the heavier companion font `Font.new("rbxassetid://11702779409", Enum.FontWeight.Bold)`; everything else stays FredokaOne.

## MANDATORY

- Dialog panels are CENTERED: wrapper `AnchorPoint = Vector2.new(0.5, 0.5)`, `Position = UDim2.new(0.5, 0, 0.5, 0)`, Scale sizing only. NEVER compute a panel's position or size in pixels from `ViewportSize`: that math pins the panel to a screen corner or clips it off-screen, the single most common defect in generated UIs. Corner-anchored placement is only for HUD elements the layout guide explicitly places.
- Every list, grid, leaderboard, and quest board renders CONTENT IMMEDIATELY from a hardcoded demo table in the LocalScript (6-10 plausible entries: names, values, icons). Never gate content on server data, RemoteEvents, or other players being present: a panel that renders empty or shows only a placeholder line is a defect. Wire live data later if asked; the first render must look full.
- Close button on EVERY dialog panel: EXACTLY the scaffold's close construction — white TextButton + UICorner 0.3 + red-pink vertical gradient (255,2,61)->(255,39,125) rot -90 + navy UIStroke 4 + white "X" label with black stroke 3. Keep the gradient and stroke: a flat solid-red chip is a defect. It STRADDLES the panel's top-right corner: parented to the Card with EXACTLY `AnchorPoint = Vector2.new(0.5, 0.5)`, `Position = UDim2.new(0.991, 0, 0, 0)`, `Size = UDim2.new(1, 0, 0.06, 45)`, plus UIAspectRatioConstraint `AspectRatio = 1.05`: half in, half out of the corner, its center sitting ON the corner. A close button floating clear of the card (any visible gap between it and the card edge) is a defect. ZIndex above everything else on the card.
- Title: a bare white FredokaOne TextScaled label with navy stroke 5 that STRADDLES the panel's top edge, anchored at the LEFT corner: `AnchorPoint = Vector2.new(0, 0.75)`, `Position = UDim2.new(0.045, 0, 0.0116, 0)`, `Size = UDim2.new(0.4, 0, 0.116, 0)`, `TextXAlignment = Left` ALWAYS. The side icon overhangs the panel's top-left corner (its home position); the TEXT starts immediately beside it. Centering the title, or sliding the icon rightward to meet a centered title, are both defects — the icon stays at the corner and the text comes to IT. Title text ends with an exclamation mark ("Shop!", "Settings!", "Inventory!"). The title is TEXT ONLY: no pill, no badge, no rounded plate, no colored bar behind it. If you built ANY backing element under the title, delete that element and keep the bare stroked text. There is NO title bar in this theme: a full-width header bar is a defect, and so is a blue title pill.
- The straddle band (the top ~12% of the card) belongs to the title, side icon, utility pills, and close button ONLY. No other text or element may occupy it: a label or row placed there ends up half-hidden behind the straddling elements with fragments peeking out on both sides.
- Exactly ONE title per panel: creating a second title label or badge (one straddling, one floating) is a defect.
- Title side icon: one content icon (icons-and-images skill), square, `UDim2.fromOffset(88, 88)`, sitting IMMEDIATELY left of the title's first glyph (parented to the title label, AnchorPoint (1, 0.5), Position `UDim2.new(0, -10, 0.5, 0)`), moving with the title as one lockup, its Image ALWAYS set from the catalog. An icon parked at the panel corner with a gap of white edge between it and the title is a defect: icon and title read as ONE unit.
- ScreenGui: `ZIndexBehavior = Enum.ZIndexBehavior.Sibling`, `IgnoreGuiInset = true` for dialogs.
- Roblox core-UI keep-out: the engine draws its menu button and chat/mic unibar in the top-left corner, over everything. No element of ANY layout (chips, counters, toasts, buttons) may render inside the rectangle from the top-left corner to 350px right and 70px down. Elements near the top-left anchor their y at a >= 70px OFFSET, never a small scale value.
- Button color encodes the action, always as the two-stop rot-90 gradient:
  - GREEN (92,239,0)->(163,253,28): primary, confirm, buy, CTA, toggle-on.
  - RED-PINK (255,2,61)->(255,39,125): close, back, destructive, toggle-off.
  - BLUE-CYAN (87,216,255)->(135,255,249): secondary confirm, save, info.
  - GREY (147,149,168)->(208,212,238): inactive, disabled, unselected.
- Robux prices: green canonical button + a Robux/currency icon from the icons-and-images skill catalog (Fit, aspect 1, ~70% of button height, full natural colors, no tint) LEFT of the amount.
- Panel height fits content: no dead band of empty card below the content. The panel's aspect constraint is picked per layout guide; content fills it. Concretely: the last row of content ends within ~8% of the card's bottom edge. If content is short, shrink the panel (smaller Scale height, aspect toward 1.25); NEVER leave the lower half of a card white and empty.
