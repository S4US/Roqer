# Recovered selected body: STUDS / admin-control-panel

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="admin-control-panel")

# LAYOUT guide: admin-control-panel

For: admin panels, staff/mod/owner panels, event and troll panels, developer spawn tools: any restricted console where an operator runs commands on the game or on another player. NOT for shops, settings dialogs, or player-facing menus.

The defining trait: **a two-pane console: categories on the left, a dense grid of labeled command buttons on the right.** Commands are plain labeled buttons, never cards: no art, no price, no icon, no description line.

## Build EXACTLY this tree (sizes are Scale unless marked Offset)

```
ScreenGui  (ZIndexBehavior = Sibling)
└─ Panel Frame — AnchorPoint (0.5, 0.5), Position (0.5, 0, 0.5, 0),
   Size (panelW, 0, panelH, 0) — panelH comes from the row-count table in the
   Rules (0.42 for 1-2 grid rows; NEVER a blanket 0.55); panelW is 0.55
   clamped by the viewport-proportion line in the script below (a panel
   strip wider than ~2.4:1 physical is a defect). Black,
   BackgroundTransparency 0.40, UIStroke 4.
   ├─ TitleBar — Size (1, 0, 0.11, 0), top. Bevel stack per the style guide;
   │  title text LEFT; close button flush RIGHT at 66% of bar height.
   ├─ Rail Frame — Position (0.02, 0, 0.14, 0), Size (0.22, 0, 0.83, 0),
   │  transparent. UIListLayout vertical, Padding (0, 8).
   │  └─ One category TextButton per category — Size (1, 0, 0, 52),
   │     canonical style-guide button. EXACTLY ONE has a bright face (the
   │     active category); the others use desaturated faces of the same
   │     construction.
   └─ ContentPane Frame — Position (0.26, 0, 0.14, 0), Size (0.72, 0, 0.83, 0),
      transparent.
      ├─ TargetRow Frame — Size (1, 0, 0, 46), top. Only when any command
      │  acts on a player.
      │  ├─ TargetBox TextBox — Size (0.7, 0, 1, 0), PlaceholderText
      │  │  "Player name". Dark track + UIStroke 4 (the ONE dark-faced
      │  │  component class in this theme), white text with glyph stroke.
      │  └─ AmountBox TextBox — Size (0.28, 0, 1, 0), right-aligned in the
      │     row, PlaceholderText "Amount". Same construction. Only when a
      │     command takes a number.
      └─ CommandScroll ScrollingFrame — Position (0, 0, 0, 54),
         Size (1, 0, 1, -54). AutomaticCanvasSize = Enum.AutomaticSize.Y,
         ScrollBarThickness 6, transparent.
         └─ UIGridLayout — CellSize (0.313, 0, 0, H) where H comes from the
            ACTIVE page's row count: 1-2 rows → H = 145; 3 rows → H = 96;
            4+ rows → H = 64. CellPadding (0.03, 0, 0, 10). The grid plus
            TargetRow must FILL the pane — chunky over dainty; a dead band
            under the grid means H is one step too small.
            └─ One command TextButton per command — canonical style-guide
               button, TextScaled label only. NEVER a card: a command
               button has no ImageLabel, no icon, no price, no
               description child. If you are adding any child besides
               the label and the face layers, stop.
```

One page of commands per category, and ONLY the active category's page exists
under CommandScroll at any moment (destroy or Visible=false the others —
never stack pages).

## Rules

- Copy the tree's numbers as written; do not re-derive them. The three grid
  columns fill the pane exactly because 3 x 0.313 + 2 x 0.03 = 1.0.
- Color encodes danger: destructive commands (kick, ban, freeze, jail, kill)
  get red faces; every other command gets a non-red face.
- The highlighted category MUST be the one whose commands are on screen.
- Commands are label-only buttons — a spawnables category (cars, items,
  dummies) uses the same grid, never cards, never art.
- The panel ends where the commands end. Size.Y comes from THIS TABLE, keyed
  by the ACTIVE page's grid row count (3 columns, so rows =
  ceil(commands / 3); other pages scroll) — copy the number, never pick one
  by eye:
  - 1-2 grid rows: `Size.Y = 0.42`
  - 3 grid rows: `Size.Y = 0.47`
  - 4 grid rows: `Size.Y = 0.51`
  - 5+ grid rows: `Size.Y = 0.55` (overflow scrolls)
  A dead band below the grid taller than ~12% of the panel means the height
  is one table row too big — it is this layout's most-failed judged
  dimension. Never go below 0.42: a shorter panel turns the title bar into a
  thin strip and reads as a floating toolbar, and the height check fails
  below 0.38. Size.X stays EXACTLY 0.55 no matter how few commands exist —
  only the height shrinks; a narrower panel collapses the 3-column grid to 2
  columns and fails the width check.
- Categories live in the LEFT RAIL: never a top tab strip, never a dropdown.
- No banners, no featured slots, no artwork anywhere in this layout.
- Player targeting ("select/click a player to target them"): player names are
  ORDINARY label-only buttons in the same 3-column grid, under a "Players"
  category; clicking one writes the name into `TargetBox.Text`. Selection is
  TargetRow state — NEVER a lone selected-player chip, header strip, or its
  own pane. Pad the Players page with demo player names to at least 6 entries
  (a page with 1-2 chips and empty grid below is a defect).
- The DEFAULT ACTIVE category on build is the action-command category (Kick /
  Ban / Fly / ...), never the Players page: the command grid must be on screen
  in the panel's initial state.

## Reference implementation — START FROM THIS CODE

Copy this implementation and modify ONLY the `CATEGORIES` and `DESTRUCTIVE`
tables to match the request. Apply the style guide's full bevel construction
to the frames and buttons it creates; do not change any Position, Size,
AnchorPoint, or layout class it uses. If the game has no real data for a
category, KEEP demo entries like these — never render an empty pane.

```lua
-- Players category: real players first, padded with demo names to 6+ so the
-- page never renders sparse. Player buttons write TargetBox.Text on click.
local playerNames = {}
for _, plr in game:GetService("Players"):GetPlayers() do
    table.insert(playerNames, plr.Name)
end
for _, demo in { "Builderman", "Noob123", "GuestZilla", "BrickLuke", "PixelPete", "LavaLass" } do
    if #playerNames >= 6 then break end
    table.insert(playerNames, demo)
end

local CATEGORIES = {
    { name = "Players", commands = playerNames },
    { name = "Commands", commands = { "Kick", "Ban", "Freeze", "Unfreeze", "Ring", "Teleport To" } },
}
local DESTRUCTIVE = { Kick = true, Ban = true, Freeze = true }

local playerGui = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")
local existing = playerGui:FindFirstChild("AdminPanel")
if existing then existing:Destroy() end

local gui = Instance.new("ScreenGui")
gui.Name = "AdminPanel"
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.Parent = playerGui

-- Panel height comes from the row-count table in the Rules, never by eye.
local maxCommands = 0
for _, cat in CATEGORIES do
    maxCommands = math.max(maxCommands, #cat.commands)
end
local gridRows = math.ceil(maxCommands / 3)
local panelH = 0.55
if gridRows <= 2 then
    panelH = 0.42
elseif gridRows == 3 then
    panelH = 0.47
elseif gridRows == 4 then
    panelH = 0.51
end

local panel = Instance.new("Frame")
panel.AnchorPoint = Vector2.new(0.5, 0.5)
panel.Position = UDim2.new(0.5, 0, 0.5, 0)
-- Width clamp: scale-only sizing turns into a flat strip on ultrawide or short
-- viewports (a 0.55-wide panel at 1920x680 is a 3.7:1 band). Keep the panel's
-- 16:9 physical proportions on any viewport.
local viewport = workspace.CurrentCamera.ViewportSize
local panelW = 0.55 * math.min(1, 1.78 / (viewport.X / viewport.Y))
panel.Size = UDim2.new(panelW, 0, panelH, 0)
panel.BackgroundColor3 = Color3.new(0, 0, 0)
panel.BackgroundTransparency = 0.40
panel.Parent = gui

local titleBar = Instance.new("Frame")  -- bevel stack per style guide
titleBar.Size = UDim2.new(1, 0, 0.11, 0)
titleBar.Parent = panel
-- In the bar: a small icon from the icon catalog LEFT of the title (shield,
-- wrench, or crown — same pattern as every other layout's title bar), then
-- the title TextLabel; close TextButton flush RIGHT at 66% of bar height,
-- red face

local rail = Instance.new("Frame")
rail.Position = UDim2.new(0.02, 0, 0.14, 0)
rail.Size = UDim2.new(0.22, 0, 0.83, 0)
rail.BackgroundTransparency = 1
rail.Parent = panel
local railList = Instance.new("UIListLayout")
railList.FillDirection = Enum.FillDirection.Vertical
railList.Padding = UDim.new(0, 8)
railList.Parent = rail

local content = Instance.new("Frame")
content.Position = UDim2.new(0.26, 0, 0.14, 0)
content.Size = UDim2.new(0.72, 0, 0.83, 0)
content.BackgroundTransparency = 1
content.Parent = panel

local targetRow = Instance.new("Frame")
targetRow.Size = UDim2.new(1, 0, 0, 46)
targetRow.BackgroundTransparency = 1
targetRow.Parent = content

local targetBox = Instance.new("TextBox")
targetBox.Size = UDim2.new(0.7, 0, 1, 0)
targetBox.PlaceholderText = "Player name"
targetBox.TextScaled = true
targetBox.Parent = targetRow
-- dark track + UIStroke 4, white text with glyph stroke; AmountBox
-- (0.28, 0, 1, 0) right-aligned, same construction, only when a command
-- takes a number

local scroll = Instance.new("ScrollingFrame")
scroll.Position = UDim2.new(0, 0, 0, 54)
scroll.Size = UDim2.new(1, 0, 1, -54)
scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
scroll.ScrollBarThickness = 6
scroll.BackgroundTransparency = 1
scroll.Parent = content
local grid = Instance.new("UIGridLayout")
grid.CellSize = UDim2.new(0.313, 0, 0, 64)
grid.CellPadding = UDim2.new(0.03, 0, 0, 10)
grid.Parent = scroll

local function showCategory(cat)
    for _, child in scroll:GetChildren() do
        if child:IsA("TextButton") then child:Destroy() end
    end
    for _, cmd in cat.commands do
        local b = Instance.new("TextButton")  -- canonical style-guide button
        b.Text = cmd
        b.TextScaled = true
        -- red face when DESTRUCTIVE[cmd]; NO ImageLabel, icon, or price child
        if cat.name == "Players" then
            b.MouseButton1Click:Connect(function()
                -- targetBox is the TargetRow's TextBox; selection is its state
                targetBox.Text = cmd
            end)
        end
        b.Parent = scroll
    end
    -- brighten cat's rail button; desaturate the others
end

for _, cat in CATEGORIES do
    local btn = Instance.new("TextButton")  -- canonical style-guide button
    btn.Size = UDim2.new(1, 0, 0, 52)
    btn.Text = cat.name
    btn.TextScaled = true
    btn.MouseButton1Click:Connect(function() showCategory(cat) end)
    btn.Parent = rail
end
-- Default active page: the COMMAND category, never Players — the command
-- grid must be visible in the initial state.
showCategory(CATEGORIES[2])
```
