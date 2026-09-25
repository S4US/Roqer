# Recovered selected body: SIM / progression-hub

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="progression-hub")

# LAYOUT guide: progression-hub

For: quest logs, daily/weekly quest boards, battle pass and season screens, achievement lists, daily reward tracks: any screen where the player reviews goals and claims earned rewards. NOT for shops (those sell), inventories (grid-inventory), rebirth/prestige confirms (centered-dialog), or leaderboards (stat-leaderboard).

The defining trait: **full-width goal rows, each with a progress bar and a claim state.** Every row answers three questions at a glance: what to do, how far along, what you get. The screen is a checklist, not a catalog.

## Measurements (1080p)

- Panel: wrapper+shadow+card scaffold, centered, EXACTLY `Size = UDim2.new(1, 0, 0.42, 120)`, `UIAspectRatioConstraint.AspectRatio = 1.6` (~48% x 53% of screen). Copy this size; a shorter panel fails the height check.
- Straddling title ("Quests!"), side icon locked against the title text, straddling close button: per the style guide. An optional "Resets in 12h" pill straddles the top edge right of the title (style-guide pill construction, dark navy text — never cyan glyphs).
- Optional tab row (Daily / Weekly / Season): directly below the straddle zone, 2-4 `makeStickerButton` tabs, each ~16% card width x 40px, left-aligned with ~1% gaps. EXACTLY ONE keeps a bright gradient (the active tab); the others use GREY, and the active tab MUST match the rows on screen. With tabs, drop one demo quest so the rows still fit above the panel bottom.
- Rows: copy THIS builder (requires the scaffold's `makeStickerButton`). Five 82px rows fit this panel exactly with no scrolling; a row cut by the panel bottom is an automatic fail.

  ```lua
  local DEMO_QUESTS = {
      { name = "Hatch 10 Eggs", progress = 7, goal = 10, reward = "500 Coins", state = "active" },
      { name = "Collect 5,000 Coins", progress = 5000, goal = 5000, reward = "1 Gift Box", state = "claimable" },
      { name = "Play 30 Minutes", progress = 12, goal = 30, reward = "250 Coins", state = "active" },
      { name = "Reach Zone 3", progress = 3, goal = 3, reward = "Egg Voucher", state = "claimed" },
      { name = "Pet 5 Dogs", progress = 1, goal = 5, reward = "100 Gems", state = "active" },
  }

  local list = Instance.new("Frame")
  list.BackgroundTransparency = 1
  list.Position = UDim2.new(0, 20, 0, 82)
  list.Size = UDim2.new(1, -40, 0, 450)
  list.Parent = card
  local stack = Instance.new("UIListLayout")
  stack.Padding = UDim.new(0, 10)
  stack.SortOrder = Enum.SortOrder.LayoutOrder
  stack.Parent = list

  local function setProgress(fill, progress, goal)
      if progress <= 0 then
          fill.Visible = false
      else
          fill.Visible = true
          fill.Size = UDim2.new(math.clamp(progress / goal, 0.04, 1), 0, 1.1, 0)
      end
  end

  local function buildQuestRow(order, quest)
      local row = Instance.new("Frame")
      row.LayoutOrder = order
      row.BackgroundColor3 = Color3.new(1, 1, 1)
      row.Size = UDim2.new(1, 0, 0, 82)
      row.Parent = list
      local rowCorner = Instance.new("UICorner")
      rowCorner.CornerRadius = UDim.new(0.15, 0)
      rowCorner.Parent = row
      local rowStroke = Instance.new("UIStroke")
      rowStroke.Color = NAVY
      rowStroke.Thickness = 4
      rowStroke.Parent = row

      local icon = Instance.new("ImageLabel")
      icon.BackgroundTransparency = 1
      icon.ScaleType = Enum.ScaleType.Fit
      -- quest icon from the icons-and-images catalog, full natural colors
      icon.AnchorPoint = Vector2.new(0, 0.5)
      icon.Position = UDim2.new(0, 12, 0.5, 0)
      icon.Size = UDim2.fromOffset(56, 56)
      icon.Parent = row

      local name = Instance.new("TextLabel")
      name.BackgroundTransparency = 1
      name.Font = Enum.Font.FredokaOne
      name.Text = quest.name
      name.TextColor3 = NAVY
      name.TextScaled = true
      name.TextXAlignment = Enum.TextXAlignment.Left
      name.Position = UDim2.new(0, 82, 0, 10)
      name.Size = UDim2.new(0.42, 0, 0, 30)
      name.Parent = row

      local track = Instance.new("Frame")
      track.BackgroundColor3 = Color3.new(0, 0, 0)
      track.BackgroundTransparency = 0.5
      track.Position = UDim2.new(0, 82, 0, 48)
      track.Size = UDim2.new(0.42, 0, 0, 20)
      track.Parent = row
      local trackCorner = Instance.new("UICorner")
      trackCorner.CornerRadius = UDim.new(1, 0)
      trackCorner.Parent = track
      local trackStroke = Instance.new("UIStroke")
      trackStroke.Color = NAVY
      trackStroke.Thickness = 4
      trackStroke.Parent = track
      local fill = Instance.new("Frame")
      fill.BackgroundColor3 = Color3.new(1, 1, 1)
      fill.Parent = track
      local fillCorner = Instance.new("UICorner")
      fillCorner.CornerRadius = UDim.new(1, 0)
      fillCorner.Parent = fill
      local fillGrad = Instance.new("UIGradient")
      fillGrad.Rotation = -90
      fillGrad.Color = ColorSequence.new(Color3.fromRGB(87, 216, 255), Color3.fromRGB(135, 255, 249))
      fillGrad.Parent = fill
      local fillStroke = Instance.new("UIStroke")
      fillStroke.Color = NAVY
      fillStroke.Thickness = 3
      fillStroke.Parent = fill
      setProgress(fill, quest.progress, quest.goal)
      local count = Instance.new("TextLabel")
      count.BackgroundTransparency = 1
      count.Font = Enum.Font.FredokaOne
      count.Text = quest.progress .. "/" .. quest.goal
      count.TextColor3 = Color3.new(1, 1, 1) -- white + black stroke ON the bar, never cyan glyphs
      count.TextScaled = true
      count.Size = UDim2.new(1, 0, 0.9, 0)
      count.Position = UDim2.new(0, 0, 0.05, 0)
      count.ZIndex = 3
      count.Parent = track
      local countStroke = Instance.new("UIStroke")
      countStroke.Color = Color3.new(0, 0, 0)
      countStroke.Thickness = 3
      countStroke.Parent = count

      local reward = Instance.new("TextLabel")
      reward.BackgroundTransparency = 1
      reward.Font = Enum.Font.FredokaOne
      reward.Text = quest.reward
      reward.TextColor3 = NAVY
      reward.TextScaled = true
      reward.TextXAlignment = Enum.TextXAlignment.Right
      reward.AnchorPoint = Vector2.new(1, 0.5)
      reward.Position = UDim2.new(1, -136, 0.5, 0)
      reward.Size = UDim2.new(0, 150, 0, 24)
      reward.Parent = row

      local claimColor = quest.state == "claimable" and "green" or "grey"
      local claimText = quest.state == "claimed" and "Claimed" or "Claim"
      local claim = makeStickerButton(row, claimColor, claimText, UDim2.fromOffset(110, 48))
      claim.AnchorPoint = Vector2.new(1, 0.5)
      claim.Position = UDim2.new(1, -12, 0.5, 0)
      return row
  end

  for i, quest in ipairs(DEMO_QUESTS) do
      buildQuestRow(i, quest)
  end
  ```

## Rules

- Rows are uniform and span the full content width, each exactly as wide as the next.
- Every row carries a progress bar with its count ON the bar (white glyphs + black stroke); the fill fraction MATCHES the count.
- Green gradients appear ONLY on claimable buttons.
- No prices, no purchase buttons, no Robux icons: rewards here are earned, never bought.
- More than 5 quests: keep 5 whole rows visible in a ScrollingFrame and put whole overflow rows fully below the fold — a partially visible row reads as clipping and fails.
- Density is the point: 5 rows visible. One or two giant rows filling the card is a defect.
