# Recovered SIM theme body — part 1/3

> Canonical visual/construction guidance from the reference agent. Legacy tool/deployment names are provenance; current Roqer execution rules and specialized contracts/templates override those names only.

<!-- guide-variant: full -->

# simulator-rounded-cartoon theme

Follow the style guide for every visual decision. When CREATING a UI, also follow exactly ONE layout guide: classify which UI type the task asks for, then load the matching guide by calling activateSkill with this skill's name and the `layout` parameter (see LAYOUT GUIDES below for the slugs). If no layout guide matches the task, do not force one; keep the style guide and lay the screen out with your own judgment, consistent with the style. When EDITING a UI that already exists, follow the EDITING protocol below instead — layout guides are for creation only and must not be loaded for edits.

Commit to the layout in code: the FIRST line of the builder LocalScript is a comment naming the selected guide (`-- layout: shop-grid`), and before writing any elements re-read that guide's Measurements and Rules and implement every bullet. The layout guide defines the skeleton (panes, grids, rows, their sizes); the style guide only skins it. Building a different skeleton than the declared guide (a row list where the guide says grid, a bare panel where the guide says sidebar + content pane) is a failure, not an interpretation.

While this theme is active, these rules take PRECEDENCE over any generic UI styling guidance from other skills or prompt sections — and over your own memory of how real pet-simulator games look: the games this style imitates bake button outlines into image assets and park icons at panel corners, but THIS theme builds native instances, so every button carries its own Border-mode UIStroke and the side icon locks against the title text. This theme uses NO external asset ids: every image comes from the icons-and-images catalog. The one exception is a SPECIALIZED layout guide (wheel-spin, vertical-reel-roll): the exact chrome and glow asset ids it lists are mandatory for that layout. Every sizing, color, and construction rule in this guide is exact; follow it over your own defaults, and keep every icon aspect-locked (Fit + square constraint), never stretched.

UI generation only, static data: hardcode all content (item names, amounts, prices) as literal text. Do NOT wire data or behavior: no MarketplaceService or product lookups, no RemoteEvents or RemoteFunctions, no leaderstats reads, no RunService per-frame work. TweenService is allowed only for the presentation motion in Roqer's polish layer (`references/core/polish.md`), which adds motion, merchandising states, and finishing detail on top of this guide without changing any construction rule, color, or asset id here. Click handlers may only toggle visibility or tabs and play that motion. Game logic gets wired in a separate follow-up task, never during UI generation. Exception: SPECIALIZED layout guides (wheel-spin, vertical-reel-roll) ship a fixed canonical builder script deployed server-side via createScript's `layoutTemplate` parameter — never hand-written; its TweenService/RunService use is part of the layout, while the bans on remotes, MarketplaceService, and server scripts still hold.

Every element owns its own space: no two labels or components may ever overlap, and each card presents exactly ONE product (one name, one art image, one price button).

# EDITING an existing UI (overrides layout-guide selection)

When the task modifies a UI that already exists — built earlier this session or already in StarterGui — you are editing, not generating:

1. Read first: locate the existing builder LocalScript. For a small targeted change, grep it for the relevant element names and read ONLY those sections (readScript with startLine/endLine) — read the whole file only when the change spans multiple sections or the structure is unclear. Never create a second script or a second ScreenGui for an edit; keep the ScreenGui name and the script identity stable.
2. Keep the existing layout: do NOT classify the UI type and do NOT select a layout guide. The layout shape was fixed at creation. An edit never changes panel size, layout structure, or section arrangement unless the user explicitly asks for that change. Rebuilding a working screen to match a layout guide is a defect, not an improvement.
3. Smallest change that satisfies the request: touch only the elements the user named. Every element the request does not cover keeps its exact current properties, even where they deviate from this guide.
4. New elements match their siblings: anything you ADD during an edit follows the style guide construction rules (rounded card, sticker-builder gradient button, FredokaOne + stroke rules) and copies the sizing conventions of the elements next to it.
5. Verify the edit, not the whole guide: screenshot after the change and confirm two things — the requested change landed, and the rest of the UI is visually unchanged.

# simulator-rounded-cartoon style guide, v1.0 (style only: layout comes from the selected layout guide)

Extracted from a hand-built reference recreation of a top pet-simulator's UI (13 screens, measured instance-by-instance). Format follows the studded-blocky-cartoon v6.0 compressed form that won the guide-ablation experiment.

## PANEL SCAFFOLD (start every dialog by pasting this, then fill the Card)

Copy this scaffold VERBATIM for every dialog panel: it defines `makeStickerButton` (the ONLY way buttons are built in this theme) and builds the wrapper, shadow, white card, straddling bare-text title, and straddling close button with the exact measured values. Do not restyle it, do not add a title pill or bar, do not reposition the close button, and NEVER write your own version of `makeStickerButton` — a hand-written one always drops the navy outline stroke, the theme's most-failed construction rule. Only rename, set the title string, pick the aspect ratio from your layout guide, and parent your content to `card`.

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
    local stroke = Instance.new("UIStroke") -- the navy outline: NEVER omit it
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

local gui = Instance.new("ScreenGui")
gui.Name = "MyDialog"
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.IgnoreGuiInset = true
gui.Parent = playerGui

local wrapper = Instance.new("Frame")
wrapper.BackgroundTransparency = 1
wrapper.AnchorPoint = Vector2.new(0.5, 0.5)
wrapper.Position = UDim2.new(0.5, 0, 0.5, 0)
wrapper.Size = UDim2.new(1, 0, 0.42, 120)
wrapper.Parent = gui
local aspect = Instance.new("UIAspectRatioConstraint")
aspect.AspectRatio = 1.7 -- from the layout guide: 1.25 dialogs, 1.7 mid, 1.95 wide
aspect.Parent = wrapper

local shadow = Instance.new("Frame")
shadow.BackgroundColor3 = Color3.new(0, 0, 0)
shadow.BackgroundTransparency = 0.75
shadow.AnchorPoint = Vector2.new(0.5, 0.5)
shadow.Position = UDim2.new(0.5, 0, 0.5, 8)
shadow.Size = UDim2.new(1, 6, 1, 6)
shadow.ZIndex = 1
shadow.Parent = wrapper
local shadowCorner = Instance.new("UICorner")
shadowCorner.CornerRadius = UDim.new(0.035, 0)
shadowCorner.Parent = shadow

local card = Instance.new("Frame")
card.BackgroundColor3 = Color3.fromRGB(255, 255, 255) -- the card stays WHITE
card.Size = UDim2.new(1, 0, 1, 0)
card.ZIndex = 2
card.Parent = wrapper
local cardCorner = Instance.new("UICorner")
cardCorner.CornerRadius = UDim.new(0.035, 0)
cardCorner.Parent = card
local cardStroke = Instance.new("UIStroke")
cardStroke.Color = Color3.fromRGB(42, 43, 49)
cardStroke.Thickness = 7
cardStroke.Parent = card

local title = Instance.new("TextLabel") -- bare text, NO backing element
title.BackgroundTransparency = 1
title.Font = Enum.Font.FredokaOne
title.Text = "Shop!"
title.TextColor3 = Color3.fromRGB(255, 255, 255)
title.TextScaled = true
-- LEFT alignment is load-bearing: the side icon anchors to the label's left
-- edge, so centered text opens a white gap between icon and title.
title.TextXAlignment = Enum.TextXAlignment.Left
-- LEFT-anchored at the corner: the side icon keeps its home overhanging the
-- panel's top-left corner, and the title TEXT starts right beside it. Never
-- slide the icon rightward toward a centered title.
title.AnchorPoint = Vector2.new(0, 0.75)
title.Position = UDim2.new(0.045, 0, 0.0116, 0)
title.Size = UDim2.new(0.4, 0, 0.116, 0)
title.ZIndex = 5
title.Parent = card
local titleStroke = Instance.new("UIStroke")
titleStroke.Color = Color3.fromRGB(42, 43, 49)
titleStroke.Thickness = 5
titleStroke.Parent = title

local sideIcon = Instance.new("ImageLabel")
sideIcon.BackgroundTransparency = 1
sideIcon.ScaleType = Enum.ScaleType.Fit
-- Set the Image NOW from the icons-and-images skill catalog; keep ImageColor3
-- white so it renders full-color, never a dark silhouette. An imageless or
-- collapsed side icon leaves the title orphaned — a review defect every time.
sideIcon.AnchorPoint = Vector2.new(1, 0.5)
sideIcon.Position = UDim2.new(0, -10, 0.5, 0)
sideIcon.Size = UDim2.fromOffset(88, 88)
sideIcon.ZIndex = 5
-- Parent is the TITLE, never the card: the icon rides the title's left edge
-- as one lockup. Re-parenting it to the card corner opens the white gap that
-- fails the title-lockup check.
sideIcon.Parent = title

local closeButton = makeStickerButton(card, "red", "X", UDim2.new(1, 0, 0.06, 45))
closeButton.AnchorPoint = Vector2.new(0.5, 0.5)
closeButton.Position = UDim2.new(0.991, 0, 0, 0)
closeButton.ZIndex = 6
local closeAspect = Instance.new("UIAspectRatioConstraint")
closeAspect.AspectRatio = 1.05
closeAspect.Parent = closeButton
closeButton.MouseButton1Click:Connect(function()
    gui.Enabled = false
end)
```

HUD layouts (hud-zone-system, vertical-navigation-sidebar, notification-alert) and fullscreen-landing do NOT use this scaffold: those layouts place elements directly on the ScreenGui with NO panel, per their layout guides.
