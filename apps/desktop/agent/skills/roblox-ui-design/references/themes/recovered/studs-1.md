# Recovered STUDS theme body — part 1/2

> Canonical visual/construction guidance from the reference agent. Legacy tool/deployment names are provenance; current Roqer execution rules and specialized contracts/templates override those names only.

<!-- guide-variant: full -->

# studded-blocky-cartoon theme

Follow the style guide for every visual decision. When CREATING a UI, also follow exactly ONE layout guide: classify which UI type the task asks for, then load the matching guide by calling activateSkill with this skill's name and the `layout` parameter (see LAYOUT GUIDES below for the slugs). If no layout guide matches the task, do not force one; keep the style guide and lay the screen out with your own judgment, consistent with the style. When EDITING a UI that already exists, follow the EDITING protocol below instead — layout guides are for creation only and must not be loaded for edits.

Commit to the layout in code: the FIRST line of the builder LocalScript is a comment naming the selected guide (`-- layout: shop-grid`), and before writing any elements re-read that guide's Measurements and Rules and implement every bullet. The layout guide defines the skeleton (panes, grids, rows, their sizes); the style guide only skins it. Building a different skeleton than the declared guide (a row list where the guide says grid, a bare panel where the guide says sidebar + content pane) is a failure, not an interpretation.

While this theme is active, these rules take PRECEDENCE over any generic UI styling guidance from other skills or prompt sections. In particular: for any element this guide covers (patterns, Robux icon, title-bar icon, content art), use the exact asset ids listed HERE, not equivalents from the icon catalog; the icon catalog is only for icons this guide does not cover. Every sizing, color, and construction rule in this guide is exact; follow it over your own defaults, and keep every icon aspect-locked (Fit + square constraint), never stretched.

UI generation only, static data: hardcode all content (item names, amounts, prices) as literal text. Do NOT wire data or behavior: no MarketplaceService or product lookups, no RemoteEvents or RemoteFunctions, no leaderstats reads, no RunService per-frame work. TweenService is allowed only for the presentation motion in Roqer's polish layer (`references/core/polish.md`), which adds motion, merchandising states, and finishing detail on top of this guide without changing any construction rule, color, or asset id here. Click handlers may only toggle visibility or tabs and play that motion. Game logic gets wired in a separate follow-up task, never during UI generation. Exception: SPECIALIZED layout guides (wheel-spin, vertical-reel-roll) ship a fixed canonical builder script deployed server-side via createScript's `layoutTemplate` parameter — never hand-written; its TweenService/RunService use is part of the layout, while the bans on remotes, MarketplaceService, and server scripts still hold.

Every element owns its own space: no two labels or components may ever overlap, and each card presents exactly ONE product (one name, one art image, one price button).

# EDITING an existing UI (overrides layout-guide selection)

When the task modifies a UI that already exists — built earlier this session or already in StarterGui — you are editing, not generating:

1. Read first: locate the existing builder LocalScript. For a small targeted change, grep it for the relevant element names and read ONLY those sections (readScript with startLine/endLine) — read the whole file only when the change spans multiple sections or the structure is unclear. Never create a second script or a second ScreenGui for an edit; keep the ScreenGui name and the script identity stable.
2. Keep the existing layout: do NOT classify the UI type and do NOT select a layout guide. The layout shape was fixed at creation. An edit never changes panel size, layout structure, or section arrangement unless the user explicitly asks for that change. Rebuilding a working screen to match a layout guide is a defect, not an improvement.
3. Smallest change that satisfies the request: touch only the elements the user named. Every element the request does not cover keeps its exact current properties, even where they deviate from this guide.
4. New elements match their siblings: anything you ADD during an edit follows the style guide construction rules (bevel stack, pattern tile size, FredokaOne + stroke) and copies the sizing conventions of the elements next to it.
5. Verify the edit, not the whole guide: screenshot after the change and confirm two things — the requested change landed, and the rest of the UI is visually unchanged.

# studded-blocky-cartoon style guide, v6.0 (style only — layout comes from the selected layout guide)

Adopted from the guide-ablation experiment (experiment/guide-ablation-2026-07-28.md): this compressed form beat the v5.9 long form on every judged axis at 55% of the length. The long form is archived as style-guide.full-archive.md; the emphasis budget and change rules live in reference/ui-themes/REFINEMENT-PROTOCOL.md.

## CONSTRUCTION: every visible element (title bars, buttons, cards, banners, bars, close button) is a 4-layer bevel stack

1. Base frame: DARK shade of the element's color, square corners, black UIStroke thickness 4. The outline lives HERE (never on the face) and applies to panel root, title bar, close button, every card, banner, bar, and every button — never to text labels.
2. Color face: child Frame anchored TOP, WHITE + vertical UIGradient carrying the color. Face height: title bar 0.88, cards/banners 0.94, buttons 0.90. Title bar faces are FLAT solid color (the one class with no gradient); every other face keeps its white-to-color gradient — a flat face elsewhere is a defect.
3. Pattern overlay: ImageLabel Size (1,0,1,0) covering the ENTIRE face edge to edge. Square TileSize T×T: title bars T = round(barHeight × 1.3); buttons T = round(buttonHeight × 0.9); cards/banners/bars T = round(height × 0.6) clamped [40, 110]. Studs read clearly at a glance everywhere; fine or zoomed-out studs are a defect. Dense grid rbxassetid://92521981645530 (transparency 0.5-0.6) for bars/buttons/cards; sparse rbxassetid://102751665779866 (~0.32, + rot-60 gradient) for wide featured banners only.
4. Content on top: FredokaOne TextScaled, white (or near-white) TextColor3, black glyph UIStroke (3 large / 2.5 small), BackgroundTransparency = 1 — bare glyphs, never a box, fill, or outline around a label. Dark text fills on faces are a defect. Icons Fit + UIAspectRatioConstraint(1), never stretched. Content ZIndex above face and pattern; face ZIndex >= base.

## MANDATORY

- Close button on EVERY panel with a title bar: square, flush right, owning that corner (nothing else within one button-width of the bar's right edge). It reads BRIGHT red — the dark base is only the shadow sliver and outline; a flat dark-red button with no bright face is a defect. It must sit fully INSIDE the bar — taller than the bar is a structural fail. Build it with THIS function, always — including on restyles, where any pre-existing close/exit button (and its reused X label with stale AnchorPoint) is destroyed first, never recolored in place:

  ```lua
  local function applyCloseButton(titleBar)
      for _, n in { "Close", "CloseButton", "Exit", "ExitButton", "ExitInventory", "X" } do
          local old = titleBar.Parent:FindFirstChild(n, true)
          if old then old:Destroy() end
      end
      local btn = Instance.new("TextButton")
      btn.Name = "Close"
      btn.Text = ""
      btn.AutoButtonColor = false
      btn.Size = UDim2.new(0.05, 0, 0.66, 0)
      btn.AnchorPoint = Vector2.new(1, 0.5)
      btn.Position = UDim2.new(1, -6, 0.5, 0)
      btn.BackgroundColor3 = Color3.fromRGB(120, 14, 14)
      btn.BorderSizePixel = 0
      btn.Parent = titleBar
      local aspect = Instance.new("UIAspectRatioConstraint")
      aspect.AspectRatio = 1
      aspect.DominantAxis = Enum.DominantAxis.Height
      aspect.Parent = btn
      local stroke = Instance.new("UIStroke")
      stroke.Color = Color3.new(0, 0, 0)
      stroke.Thickness = 4
      stroke.Parent = btn
      local face = Instance.new("Frame")
      face.BackgroundColor3 = Color3.new(1, 1, 1)
      face.BorderSizePixel = 0
      face.Size = UDim2.new(1, 0, 0.90, 0)
      face.ZIndex = btn.ZIndex + 1
      face.Parent = btn
      local grad = Instance.new("UIGradient")
      grad.Rotation = 90
      grad.Color = ColorSequence.new(Color3.fromRGB(255, 130, 130), Color3.fromRGB(239, 28, 28))
      grad.Parent = face
      local x = Instance.new("TextLabel")
      x.BackgroundTransparency = 1
      x.AnchorPoint = Vector2.new(0.5, 0.5)
      x.Position = UDim2.fromScale(0.5, 0.5)
      x.Size = UDim2.fromScale(0.7, 0.7)
      x.Font = Enum.Font.FredokaOne
      x.Text = "X"
      x.TextColor3 = Color3.new(1, 1, 1)
      x.TextScaled = true
      x.ZIndex = face.ZIndex + 1
      x.Parent = face
      local xs = Instance.new("UIStroke")
      xs.Color = Color3.new(0, 0, 0)
      xs.Thickness = 3
      xs.Parent = x
      return btn
  end
  ```
- Restyle prompts ("restyle/retheme/improve my existing UI"): every rule in this guide applies to the RESULT, not only to new elements. Reparent and reposition existing elements to the specs (close button via `applyCloseButton`, panel centering from the layout guide, tabs/rails attached to their panel); recoloring template elements in place while keeping their old geometry is a defect.
- Robux-costing buttons: GREEN face with the 3-stop shine (255,255,255)@0 -> light tint@0.1 -> saturated@1 rot90. The Robux icon rbxassetid://87608142780557 and the price are ONE centered group — never an icon pinned to the button edge with the number floating apart from it. Inside the face: transparent row Frame `AnchorPoint = Vector2.new(0.5, 0.5)`, `Position = UDim2.fromScale(0.5, 0.5)`, `Size = UDim2.new(1, 0, 0.62, 0)` holding a UIListLayout (`FillDirection = Horizontal`, `HorizontalAlignment = Center`, `VerticalAlignment = Center`, `Padding = UDim.new(0, 6)`); children are the icon ImageLabel (Fit, explicit `UDim2.fromOffset(H, H)`, H ~60% of button height) then the price TextLabel (TextScaled, `Size = UDim2.new(0, 0, 1, 0)`, `AutomaticSize = Enum.AutomaticSize.X`). Same row construction for coin prices with coin rbxassetid://84697600263846.
- ScreenGui ZIndexBehavior = Enum.ZIndexBehavior.Sibling.
- Roblox core-UI keep-out: the engine draws its menu button and chat/mic unibar in the top-left corner, over everything. No element of ANY layout (chips, counters, toasts, buttons) may render inside the rectangle from the top-left corner to 350px right and 70px down. Elements near the top-left anchor their y at a >= 70px OFFSET, never a small scale value.
- Panel height fits content: the last content element's bottom edge ends within ~12% of panel height of the panel bottom. Size.Y ALWAYS stays within [0.40, 0.66]; a panel with no matching layout guide stays within [0.45, 0.62]. At the floor with content left over, GROW the content (bigger cells, cards, sections) — never shrink below 0.40; above the ceiling, pack sections tighter — never exceed it. An empty panel band below or beside content is the single most-failed rule in judged runs.
