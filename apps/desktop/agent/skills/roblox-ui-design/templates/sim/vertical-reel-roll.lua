-- LEMONADE_UI_SCALE_CONVERTER (managed by Lemonade, do not edit or remove)
-- Rewrites pixel (Offset) sizing on every GuiObject under the ScreenGuis this
-- script creates into Scale relative to the parent, so the UI keeps its
-- authored proportions on phones, tablets and other resolutions. Absolute
-- geometry is read first and written second, so the result is pixel-identical
-- at the viewport it was built for.
local lemonadeUiScale_LAYOUT_CLASSES = { "UIListLayout", "UIGridLayout", "UIPageLayout", "UITableLayout" }

local function lemonadeUiScale_resolve(udim: UDim, extent: number): number
	return udim.Scale * extent + udim.Offset
end

local function lemonadeUiScale_hasLayout(parent: Instance): boolean
	for _, className in lemonadeUiScale_LAYOUT_CLASSES do
		if parent:FindFirstChildWhichIsA(className) then
			return true
		end
	end
	return false
end

local function lemonadeUiScale_contentBox(parent: GuiBase2d): (Vector2, Vector2)
	local size = parent.AbsoluteSize
	local origin = parent.AbsolutePosition
	local padding = parent:FindFirstChildWhichIsA("UIPadding")
	if not padding then
		return origin, size
	end
	local left = lemonadeUiScale_resolve(padding.PaddingLeft, size.X)
	local right = lemonadeUiScale_resolve(padding.PaddingRight, size.X)
	local top = lemonadeUiScale_resolve(padding.PaddingTop, size.Y)
	local bottom = lemonadeUiScale_resolve(padding.PaddingBottom, size.Y)
	return origin + Vector2.new(left, top), size - Vector2.new(left + right, top + bottom)
end

local function lemonadeUiScale_toScale(absolute: Vector2, content: Vector2): UDim2
	return UDim2.fromScale(absolute.X / content.X, absolute.Y / content.Y)
end

local function lemonadeUiScale_planObject(object: GuiObject, plan: { () -> () })
	local parent = object.Parent
	if not (parent and parent:IsA("GuiBase2d")) then
		return
	end
	if parent:FindFirstChildWhichIsA("UIGridLayout") then
		return
	end
	local contentOrigin, content = lemonadeUiScale_contentBox(parent)
	if content.X <= 0 or content.Y <= 0 then
		return
	end
	local absoluteSize = object.AbsoluteSize
	local size = object.Size
	local automatic = object.AutomaticSize
	local scaled = lemonadeUiScale_toScale(absoluteSize, content)
	local keepX = automatic == Enum.AutomaticSize.X or automatic == Enum.AutomaticSize.XY
	local keepY = automatic == Enum.AutomaticSize.Y or automatic == Enum.AutomaticSize.XY
	local newSize = UDim2.new(if keepX then size.X else scaled.X, if keepY then size.Y else scaled.Y)
	local positionManaged = lemonadeUiScale_hasLayout(parent)
	local anchored = object.AbsolutePosition - contentOrigin + object.AnchorPoint * absoluteSize
	local newPosition = lemonadeUiScale_toScale(anchored, content)
	local pureOffset = size.X.Scale == 0 and size.Y.Scale == 0 and absoluteSize.X > 0 and absoluteSize.Y > 0
	local fixedShape = pureOffset and automatic == Enum.AutomaticSize.None
	local aspect = if fixedShape and not object:FindFirstChildWhichIsA("UIAspectRatioConstraint")
		then absoluteSize.X / absoluteSize.Y
		else nil
	table.insert(plan, function()
		object.Size = newSize
		if not positionManaged then
			object.Position = newPosition
		end
		if aspect then
			local constraint = Instance.new("UIAspectRatioConstraint")
			constraint.AspectRatio = aspect
			constraint.Parent = object
		end
	end)
end

local function lemonadeUiScale_planHelpers(object: GuiBase2d, plan: { () -> () })
	local _, content = lemonadeUiScale_contentBox(object)
	local size = object.AbsoluteSize
	for _, child in object:GetChildren() do
		if child:IsA("UIGridLayout") then
			local cell = Vector2.new(
				lemonadeUiScale_resolve(child.CellSize.X, content.X),
				lemonadeUiScale_resolve(child.CellSize.Y, content.Y)
			)
			local gap = Vector2.new(
				lemonadeUiScale_resolve(child.CellPadding.X, content.X),
				lemonadeUiScale_resolve(child.CellPadding.Y, content.Y)
			)
			table.insert(plan, function()
				child.CellSize = lemonadeUiScale_toScale(cell, content)
				child.CellPadding = lemonadeUiScale_toScale(gap, content)
			end)
		elseif child:IsA("UIListLayout") then
			local extent = if child.FillDirection == Enum.FillDirection.Horizontal then content.X else content.Y
			local gap = lemonadeUiScale_resolve(child.Padding, extent)
			table.insert(plan, function()
				child.Padding = UDim.new(gap / extent, 0)
			end)
		elseif child:IsA("UIPadding") then
			local left = lemonadeUiScale_resolve(child.PaddingLeft, size.X)
			local right = lemonadeUiScale_resolve(child.PaddingRight, size.X)
			local top = lemonadeUiScale_resolve(child.PaddingTop, size.Y)
			local bottom = lemonadeUiScale_resolve(child.PaddingBottom, size.Y)
			table.insert(plan, function()
				child.PaddingLeft = UDim.new(left / size.X, 0)
				child.PaddingRight = UDim.new(right / size.X, 0)
				child.PaddingTop = UDim.new(top / size.Y, 0)
				child.PaddingBottom = UDim.new(bottom / size.Y, 0)
			end)
		elseif child:IsA("UICorner") then
			local shortest = math.min(size.X, size.Y)
			local radius = lemonadeUiScale_resolve(child.CornerRadius, shortest)
			table.insert(plan, function()
				child.CornerRadius = UDim.new(radius / shortest, 0)
			end)
		end
	end
end

local function lemonadeUiScale_convert(screenGui: ScreenGui)
	if screenGui.AbsoluteSize.X <= 0 or screenGui.AbsoluteSize.Y <= 0 then
		return
	end
	local plan: { () -> () } = {}
	for _, descendant in screenGui:GetDescendants() do
		if descendant:IsA("GuiObject") then
			lemonadeUiScale_planObject(descendant, plan)
			if descendant.AbsoluteSize.X > 0 and descendant.AbsoluteSize.Y > 0 then
				lemonadeUiScale_planHelpers(descendant, plan)
			end
		end
	end
	for _, apply in plan do
		apply()
	end
end

local lemonadeUiScale_RunService = game:GetService("RunService")
if lemonadeUiScale_RunService:IsRunning() and lemonadeUiScale_RunService:IsClient() then
	local playerGui = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")
	playerGui.ChildAdded:Connect(function(child)
		if not child:IsA("ScreenGui") then
			return
		end
		task.defer(function()
			lemonadeUiScale_RunService.RenderStepped:Wait()
			lemonadeUiScale_convert(child)
		end)
	end)
end

-- layout: vertical-reel-roll
local TweenService = game:GetService("TweenService")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")

-- CONFIG: the ONLY content edits. 20+ items top to bottom; the reel rolls down
-- through them. winnerIndex >= 15 so the roll travels a long way. icon is a
-- numeric catalog asset id (rendered via rbxthumb) or an "rbxassetid://..."
-- string from the icons-and-images catalog.
local CONFIG = {
	items = {
		{ name = "JJ5x5's White Top Hat", chance = "1/275", rarity = "Rare", value = "Value: 170K | RAP: 182K", icon = 1073690 },
		{ name = "Cake Topper", chance = "1/85", rarity = "Common", value = "Value: 191 | RAP: 191", icon = 3798248888 },
		{ name = "The Classic ROBLOX Fedora", chance = "1/575", rarity = "Epic", value = "Value: 400K | RAP: 368K", icon = 1029025 },
		{ name = "Bluesteel Bling $$ Necklace", chance = "1/15000", rarity = "Mythic", value = "Value: 10.5M | RAP: 377K", icon = 489196035 },
		{ name = "Valentine's Day 2011 Cap", chance = "1/22", rarity = "Common", value = "Value: 2.3K | RAP: 2.3K", icon = 46138556 },
		{ name = "Eggraging Shark of the Sea", chance = "1/68", rarity = "Common", value = "Value: 177 | RAP: 177", icon = 4786869155 },
		{ name = "Gold Clockwork Headphones", chance = "1/110", rarity = "Uncommon", value = "Value: 9K | RAP: 6.4K", icon = 16477149823 },
		{ name = "Immortal Sword - Wicked Heart", chance = "1/340", rarity = "Rare", value = "Value: 280K | RAP: 299K", icon = 2222720521 },
		{ name = "Sparkle Time Fedora", chance = "1/2350", rarity = "Legendary", value = "Value: 3M | RAP: 3.3M", icon = 1285307 },
		{ name = "Purple Queen of the Night", chance = "1/475", rarity = "Epic", value = "Value: 340K | RAP: 309K", icon = 553971858 },
		{ name = "Eggmunition", chance = "1/61", rarity = "Common", value = "Value: 166 | RAP: 166", icon = 4771632715 },
		{ name = "Eggraging Shark of the Sea", chance = "1/68", rarity = "Common", value = "Value: 177 | RAP: 177", icon = 4786869155 },
		{ name = "Tasteless Shades", chance = "1/3000", rarity = "Legendary", value = "Value: 3.8M | RAP: 264K", icon = 33337038 },
		{ name = "Malicious Egg", chance = "1/88", rarity = "Common", value = "Value: 194 | RAP: 194", icon = 152980783 },
		{ name = "Fiesta Sombrero", chance = "1/24", rarity = "Common", value = "Value: 2.3K | RAP: 2.3K", icon = 114693174 },
		{ name = "ROBLOX Madness Face", chance = "1/150", rarity = "Rare", value = "Value: 40K | RAP: 38.6K", icon = 130213380 },
		{ name = "Target Hat", chance = "1/9", rarity = "Common", value = "Value: 1.9K | RAP: 1.9K", icon = 1051578 },
		{ name = "Fuchsia Fantastique", chance = "1/345", rarity = "Rare", value = "Value: 290K | RAP: 256K", icon = 20980138 },
		{ name = "Radioactive Beast Mode", chance = "1/127", rarity = "Uncommon", value = "Value: 35K | RAP: 32.5K", icon = 2225761296 },
		{ name = "Shaggy", chance = "1/5", rarity = "Common", value = "Value: 1.3K | RAP: 1.3K", icon = 20573078 },
		{ name = "White Sparkle Time Fedora", chance = "1/4700", rarity = "Legendary", value = "Value: 5.7M | RAP: 3.4M", icon = 1016143686 },
		{ name = "Bombastic Antlers", chance = "1/200", rarity = "Rare", value = "Value: 75K | RAP: 70.3K", icon = 147144571 },
		{ name = "Brainfreeze Egg", chance = "1/77", rarity = "Common", value = "Value: 187 | RAP: 187", icon = 4773579034 },
		{ name = "Dominus Empyreus", chance = "1/50000000", rarity = "Collector", value = "Value: 40M | RAP: 13.6M", icon = 21070012 },
		{ name = "WC Ultimates: Aquamarine Attitude", chance = "1/3200", rarity = "Legendary", value = "Value: 4.2M | RAP: 1M", icon = 323417812 },
	},
	winnerIndex = 19,
}

-- FIXED geometry and animation constants. Never edited.
local CARD = 200
local PITCH = 200
local INFLUENCE = 260
local ROLL_TIME = 7

local RARITY_COLORS = {
	Common = Color3.fromRGB(205, 205, 205),
	Uncommon = Color3.fromRGB(34, 255, 41),
	Rare = Color3.fromRGB(255, 190, 25),
	Epic = Color3.fromRGB(161, 46, 151),
	Legendary = Color3.fromRGB(255, 255, 17),
	Mythic = Color3.fromRGB(255, 0, 89),
	Collector = Color3.fromRGB(150, 0, 25),
}

local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")

local gui = Instance.new("ScreenGui")
gui.Name = "VerticalReelRoll"
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.IgnoreGuiInset = true
gui.ResetOnSpawn = false
gui.Parent = playerGui

local overlay = Instance.new("Frame")
overlay.Name = "DarkOverlay"
overlay.BackgroundColor3 = Color3.new(0, 0, 0)
overlay.BackgroundTransparency = 0.6
overlay.BorderSizePixel = 0
overlay.Size = UDim2.new(1, 0, 1, 0)
overlay.Parent = gui

local container = Instance.new("Frame")
container.Name = "MainContainer"
container.BackgroundTransparency = 1
container.AnchorPoint = Vector2.new(0.5, 0.5)
container.Position = UDim2.new(0.5, 0, 0.5, 0)
container.Size = UDim2.new(1, 0, 1, 0)
container.ZIndex = 2
container.Parent = gui

local window = Instance.new("Frame")
window.Name = "ReelWindow"
window.BackgroundTransparency = 1
window.AnchorPoint = Vector2.new(0.5, 0.5)
window.Position = UDim2.new(0.5, 0, 0.5, 0)
window.Size = UDim2.fromOffset(300, 600)
window.ClipsDescendants = true
window.Parent = container

local reel = Instance.new("Frame")
reel.Name = "ReelFrame"
reel.BackgroundTransparency = 1
reel.AnchorPoint = Vector2.new(0.5, 0.5)
reel.Position = UDim2.new(0.5, 0, 0.5, 0)
reel.Size = UDim2.fromOffset(0, 0)
reel.Parent = window

-- THEME BUTTONS: the canonical sticker button from the style guide.
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

local rollButton = makeStickerButton(container, "green", "", UDim2.fromOffset(220, 64))
rollButton.Name = "RollButton"
rollButton.AnchorPoint = Vector2.new(0.5, 0.5)
rollButton.Position = UDim2.new(0.5, 0, 0.5, 350)
rollButton.ZIndex = 3
-- The lockup lives in its own transparent frame so the list layout never
-- touches the button's other children (the studded face frame in the studs
-- theme would otherwise get laid out and shove the content off the button).
local rollContent = Instance.new("Frame")
rollContent.Name = "RollContent"
rollContent.BackgroundTransparency = 1
rollContent.Size = UDim2.new(1, 0, 1, 0)
rollContent.ZIndex = 4
rollContent.Parent = rollButton
local rollLayout = Instance.new("UIListLayout")
rollLayout.FillDirection = Enum.FillDirection.Horizontal
rollLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center
rollLayout.VerticalAlignment = Enum.VerticalAlignment.Center
rollLayout.Padding = UDim.new(0, 10)
rollLayout.SortOrder = Enum.SortOrder.LayoutOrder
rollLayout.Parent = rollContent
local dice = Instance.new("ImageLabel")
dice.Name = "DiceIcon"
dice.BackgroundTransparency = 1
dice.Image = "rbxassetid://110883654232694"
dice.ScaleType = Enum.ScaleType.Fit
dice.Size = UDim2.new(0.3, 0, 0.72, 0)
dice.LayoutOrder = 1
dice.ZIndex = 4
dice.Parent = rollContent
local diceAspect = Instance.new("UIAspectRatioConstraint")
diceAspect.AspectRatio = 1
diceAspect.Parent = dice
local rollText = Instance.new("TextLabel")
rollText.BackgroundTransparency = 1
rollText.Font = Enum.Font.FredokaOne
rollText.Text = "ROLL"
rollText.TextColor3 = Color3.new(1, 1, 1)
rollText.TextScaled = true
rollText.Size = UDim2.new(0.42, 0, 0.6, 0)
rollText.LayoutOrder = 2
rollText.ZIndex = 4
rollText.Parent = rollContent
local rollTextStroke = Instance.new("UIStroke")
rollTextStroke.Color = Color3.new(0, 0, 0)
rollTextStroke.Thickness = 3
rollTextStroke.Parent = rollText

local function makeText(parent, text, color, strokeThickness)
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.FredokaOne
	label.Text = text
	label.TextColor3 = color
	label.TextScaled = true
	label.ZIndex = 2
	label.Parent = parent
	local stroke = Instance.new("UIStroke")
	stroke.Name = "Stroke"
	stroke.Color = Color3.new(0, 0, 0)
	stroke.Thickness = strokeThickness
	stroke.Transparency = 0.8
	stroke.Parent = label
	return label
end

local cards = {}
for i, item in ipairs(CONFIG.items) do
	local rarityColor = RARITY_COLORS[item.rarity]
	local card = Instance.new("Frame")
	card.Name = "Card_" .. i
	card.BackgroundTransparency = 1
	card.AnchorPoint = Vector2.new(0.5, 0.5)
	card.Position = UDim2.new(0, 0, 0, -(i - 1) * PITCH)
	card.Size = UDim2.fromOffset(CARD, CARD)
	card.Parent = reel
	local scale = Instance.new("UIScale")
	scale.Name = "DynamicScale"
	scale.Scale = 0.7
	scale.Parent = card
	local glow = Instance.new("ImageLabel")
	glow.Name = "CardGlow"
	glow.BackgroundTransparency = 1
	glow.Image = "rbxassetid://4925956526"
	glow.ImageColor3 = rarityColor
	glow.ImageTransparency = 1
	glow.AnchorPoint = Vector2.new(0.5, 0.5)
	glow.Position = UDim2.new(0.5, 0, 0.5, 0)
	glow.Size = UDim2.fromOffset(220, 220)
	glow.Rotation = math.random(0, 359)
	glow.ZIndex = 0
	glow.Parent = card
	local chance = makeText(card, item.chance .. " | " .. item.rarity, rarityColor, 3)
	chance.AnchorPoint = Vector2.new(0.5, 0)
	chance.Position = UDim2.new(0.5, 0, 0, 10)
	chance.Size = UDim2.fromOffset(200, 30)
	local icon = Instance.new("ImageLabel")
	icon.Name = "ItemIcon"
	icon.BackgroundTransparency = 1
	if type(item.icon) == "number" then
		icon.Image = "rbxthumb://type=Asset&id=" .. item.icon .. "&w=420&h=420"
	else
		icon.Image = item.icon
	end
	icon.ImageTransparency = 0.8
	icon.ScaleType = Enum.ScaleType.Fit
	icon.AnchorPoint = Vector2.new(0.5, 0.5)
	icon.Position = UDim2.new(0.5, 0, 0.5, 0)
	icon.Size = UDim2.fromOffset(100, 100)
	icon.ZIndex = 2
	icon.Parent = card
	local value = makeText(card, item.value, rarityColor, 2)
	value.AnchorPoint = Vector2.new(0.5, 0.5)
	value.Position = UDim2.new(0.5, 0, 0.73, 0)
	value.Size = UDim2.fromOffset(200, 28)
	local name = makeText(card, item.name, Color3.new(1, 1, 1), 3)
	name.AnchorPoint = Vector2.new(0.5, 1)
	name.Position = UDim2.new(0.5, 0, 1, -10)
	name.Size = UDim2.fromOffset(200, 40)
	cards[i] = { card = card, scale = scale, glow = glow, icon = icon }
end

-- ANIMATION (fixed): proximity emphasis + decelerating roll onto the winner.
RunService.RenderStepped:Connect(function()
	local offset = reel.Position.Y.Offset
	for i, entry in ipairs(cards) do
		local dist = math.abs(offset - (i - 1) * PITCH)
		local t = math.clamp(1 - dist / INFLUENCE, 0, 1)
		entry.scale.Scale = 0.7 + 0.4 * t
		entry.icon.ImageTransparency = 0.8 - 0.65 * t
		entry.glow.ImageTransparency = 1 - 0.65 * t
	end
end)

local rolling = false
local function roll()
	if rolling then return end
	rolling = true
	rollButton.Visible = false
	reel.Position = UDim2.new(0.5, 0, 0.5, 0)
	local target = (CONFIG.winnerIndex - 1) * PITCH
	local tween = TweenService:Create(
		reel,
		TweenInfo.new(ROLL_TIME, Enum.EasingStyle.Quint, Enum.EasingDirection.Out),
		{ Position = UDim2.new(0.5, 0, 0.5, target) }
	)
	tween:Play()
	tween.Completed:Once(function()
		rolling = false
		rollButton.Visible = true
		local winner = cards[CONFIG.winnerIndex]
		local pulse = TweenService:Create(
			winner.glow,
			TweenInfo.new(0.5, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, 3, true),
			{ ImageTransparency = 0.1 }
		)
		pulse:Play()
		print("Won:", CONFIG.items[CONFIG.winnerIndex].name)
	end)
end

rollButton.MouseButton1Click:Connect(roll)
