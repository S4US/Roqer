#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, assert, runTest, safeStopPlaytest, startPlaytestAndWait } from './lib/mcp-client.mjs';

const FIXTURE_NAME = '__RSMCP_SemanticUI';

function parseToolBody(result, label) {
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${label}: missing text result (${JSON.stringify(result)})`);
  return JSON.parse(text);
}

async function connectedRoles(client) {
  const result = await client.callTool('get_connected_instances', {});
  const places = Array.isArray(result.instances) ? result.instances : [];
  return places.flatMap((place) => (place.roles ?? []).map((role) => ({ id: place.id, role })));
}

async function waitForClientRole(client, present, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const roles = await connectedRoles(client);
    const clientRole = roles.find((entry) => /^client-\d+$/.test(entry.role));
    if (present === Boolean(clientRole)) return clientRole;
    await delay(250);
  }
  throw new Error(`Timed out waiting for runtime client present=${present}`);
}

const CREATE_FIXTURE = `
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local player = Players.LocalPlayer
assert(RunService:IsClient() and player, "runtime client required")
local playerGui = player:WaitForChild("PlayerGui")
local old = playerGui:FindFirstChild("${FIXTURE_NAME}")
if old then old:Destroy() end

local screen = Instance.new("ScreenGui")
screen.Name = "${FIXTURE_NAME}"
screen.IgnoreGuiInset = true
screen.ResetOnSpawn = false
screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
screen:SetAttribute("Clicks", 0)
screen:SetAttribute("ClientInputs", 0)
screen:SetAttribute("ButtonInputs", 0)
screen:SetAttribute("UnderlyingClicks", 0)
screen:SetAttribute("OccluderClicks", 0)
screen:SetAttribute("NestedParentClicks", 0)
screen:SetAttribute("NestedChildClicks", 0)
game:GetService("UserInputService").InputBegan:Connect(function()
    screen:SetAttribute("ClientInputs", (screen:GetAttribute("ClientInputs") or 0) + 1)
end)

local valid = Instance.new("TextButton")
valid.Name = "ValidButton"
valid.Position = UDim2.fromOffset(20, 80)
valid.Size = UDim2.fromOffset(120, 40)
valid.Text = "Ready"
valid.Parent = screen
valid.InputBegan:Connect(function()
    screen:SetAttribute("ButtonInputs", (screen:GetAttribute("ButtonInputs") or 0) + 1)
end)
valid.MouseButton1Click:Connect(function()
    local clicks = (screen:GetAttribute("Clicks") or 0) + 1
    screen:SetAttribute("Clicks", clicks)
    valid.Text = "Clicked " .. tostring(clicks)
end)

local input = Instance.new("TextBox")
input.Name = "SemanticInput"
input.Position = UDim2.fromOffset(360, 80)
input.Size = UDim2.fromOffset(150, 36)
input.PlaceholderText = "Type here"
input.Text = ""
input.Parent = screen

local viewportFrame = Instance.new("ViewportFrame")
viewportFrame.Name = "SemanticViewport"
viewportFrame.Position = UDim2.fromOffset(530, 130)
viewportFrame.Size = UDim2.fromOffset(80, 50)
viewportFrame.Parent = screen

for index = 1, 2 do
    local duplicate = Instance.new("TextButton")
    duplicate.Name = "Duplicate" .. tostring(index)
    duplicate.Position = UDim2.fromOffset(360 + (index - 1) * 100, 130)
    duplicate.Size = UDim2.fromOffset(90, 30)
    duplicate.Text = "Duplicate"
    duplicate.Parent = screen
end

local overflow = Instance.new("TextLabel")
overflow.Name = "OverflowText"
overflow.Position = UDim2.fromOffset(20, 70)
overflow.Size = UDim2.fromOffset(80, 20)
overflow.Text = "This text is intentionally much too wide"
overflow.TextSize = 24
overflow.TextWrapped = false
overflow.TextScaled = false
overflow.Parent = screen

local zero = Instance.new("TextButton")
zero.Name = "ZeroButton"
zero.Position = UDim2.fromOffset(120, 70)
zero.Size = UDim2.fromOffset(0, 0)
zero.Text = "Zero"
zero.Parent = screen

local viewport = workspace.CurrentCamera and workspace.CurrentCamera.ViewportSize or Vector2.new(800, 600)
local offscreen = Instance.new("Frame")
offscreen.Name = "OffscreenFrame"
offscreen.Position = UDim2.fromOffset(viewport.X + 100, 20)
offscreen.Size = UDim2.fromOffset(40, 40)
offscreen.Parent = screen

local clip = Instance.new("Frame")
clip.Name = "ClipFrame"
clip.Position = UDim2.fromOffset(180, 20)
clip.Size = UDim2.fromOffset(50, 50)
clip.ClipsDescendants = true
clip.Parent = screen

local clipped = Instance.new("TextButton")
clipped.Name = "ClippedButton"
clipped.Position = UDim2.fromOffset(70, 0)
clipped.Size = UDim2.fromOffset(30, 30)
clipped.Text = "Clipped"
clipped.Parent = clip

local underlying = Instance.new("TextButton")
underlying.Name = "OccludedUnderlying"
underlying.Position = UDim2.fromOffset(540, 20)
underlying.Size = UDim2.fromOffset(120, 40)
underlying.ZIndex = 1
underlying.Text = "Underlying"
underlying.Parent = screen
underlying.MouseButton1Click:Connect(function()
    screen:SetAttribute("UnderlyingClicks", (screen:GetAttribute("UnderlyingClicks") or 0) + 1)
end)

local occluder = Instance.new("TextButton")
occluder.Name = "ActiveOccluder"
occluder.Position = underlying.Position
occluder.Size = underlying.Size
occluder.ZIndex = 10
occluder.Text = "Occluder"
occluder.Parent = screen
occluder.MouseButton1Click:Connect(function()
    screen:SetAttribute("OccluderClicks", (screen:GetAttribute("OccluderClicks") or 0) + 1)
end)

local nestedParent = Instance.new("TextButton")
nestedParent.Name = "NestedParent"
nestedParent.Position = UDim2.fromOffset(540, 70)
nestedParent.Size = UDim2.fromOffset(120, 40)
nestedParent.Text = "Parent"
nestedParent.Parent = screen
nestedParent.MouseButton1Click:Connect(function()
    screen:SetAttribute("NestedParentClicks", (screen:GetAttribute("NestedParentClicks") or 0) + 1)
end)

local nestedChild = Instance.new("TextButton")
nestedChild.Name = "NestedChild"
nestedChild.Size = UDim2.fromScale(1, 1)
nestedChild.Text = "Child"
nestedChild.Parent = nestedParent
nestedChild.MouseButton1Click:Connect(function()
    screen:SetAttribute("NestedChildClicks", (screen:GetAttribute("NestedChildClicks") or 0) + 1)
end)

local hidden = Instance.new("Frame")
hidden.Name = "HiddenParent"
hidden.Position = UDim2.fromOffset(250, 20)
hidden.Size = UDim2.fromOffset(80, 50)
hidden.Visible = false
hidden.Parent = screen

local hiddenChild = Instance.new("TextButton")
hiddenChild.Name = "HiddenChild"
hiddenChild.Size = UDim2.fromScale(1, 1)
hiddenChild.Text = "Hidden"
hiddenChild.Parent = hidden

local scroll = Instance.new("ScrollingFrame")
scroll.Name = "ScrollFrame"
scroll.Position = UDim2.fromOffset(20, 120)
scroll.Size = UDim2.fromOffset(150, 80)
scroll.CanvasSize = UDim2.fromOffset(150, 240)
scroll.ScrollingDirection = Enum.ScrollingDirection.Y
scroll.Parent = screen

local below = Instance.new("TextButton")
below.Name = "BelowFold"
below.Position = UDim2.fromOffset(10, 170)
below.Size = UDim2.fromOffset(120, 30)
below.Text = "Below fold"
below.Parent = scroll

-- Overlap defects from a live shop: a badge over a card title, a discount
-- label hanging off its price button, a row past the end of its scroll, and a
-- drop-shadow title that must not be mistaken for one.
local card = Instance.new("Frame")
card.Name = "OverlapCard"
card.Position = UDim2.fromOffset(20, 220)
card.Size = UDim2.fromOffset(160, 90)
card.Parent = screen

local cardTitle = Instance.new("TextLabel")
cardTitle.Name = "CardTitle"
cardTitle.Size = UDim2.fromOffset(160, 24)
cardTitle.BackgroundTransparency = 1
cardTitle.Text = "1,000 Coins pack"
cardTitle.TextSize = 18
cardTitle.Parent = card

local cardBadge = Instance.new("Frame")
cardBadge.Name = "CardBadge"
cardBadge.Position = UDim2.fromOffset(90, 0)
cardBadge.Size = UDim2.fromOffset(70, 22)
cardBadge.ZIndex = 2
cardBadge.Parent = card

local priceButton = Instance.new("TextButton")
priceButton.Name = "PriceButton"
priceButton.Position = UDim2.fromOffset(60, 50)
priceButton.Size = UDim2.fromOffset(90, 30)
priceButton.Text = ""
priceButton.Parent = card

local discount = Instance.new("TextLabel")
discount.Name = "DiscountLabel"
discount.Position = UDim2.fromOffset(20, 55)
discount.Size = UDim2.fromOffset(70, 20)
discount.BackgroundTransparency = 1
discount.Text = "-20%"
discount.TextSize = 18
discount.Parent = card

for index, offset in ipairs({ 2, 0 }) do
    local label = Instance.new("TextLabel")
    label.Name = index == 1 and "ShadowTitleBack" or "ShadowTitleFront"
    label.Position = UDim2.fromOffset(200 + offset, 220 + offset)
    label.Size = UDim2.fromOffset(160, 24)
    label.BackgroundTransparency = 1
    label.ZIndex = index
    label.Text = "Shop!"
    label.TextSize = 20
    label.Parent = screen
end

local shortScroll = Instance.new("ScrollingFrame")
shortScroll.Name = "ShortScroll"
shortScroll.Position = UDim2.fromOffset(380, 220)
shortScroll.Size = UDim2.fromOffset(150, 80)
shortScroll.CanvasSize = UDim2.fromOffset(150, 80)
shortScroll.Parent = screen

local lastRow = Instance.new("Frame")
lastRow.Name = "LastRow"
lastRow.Position = UDim2.fromOffset(0, 60)
lastRow.Size = UDim2.fromOffset(130, 40)
lastRow.Parent = shortScroll

screen.Parent = playerGui
RunService.RenderStepped:Wait()
RunService.RenderStepped:Wait()
return true
`;

await runTest('semantic runtime UI inspection', async ({ track }) => {
  const client = track(new McpClient('semantic-ui'));
  await client.start();
  await client.initialize();

  await safeStopPlaytest(client);
  await waitForClientRole(client, false);

  const missing = await client.rpc('tools/call', {
    name: 'inspect_ui',
    arguments: process.env.MCP_INSTANCE_ID ? { instance_id: process.env.MCP_INSTANCE_ID } : {},
  });
  const missingBody = parseToolBody(missing, 'inspect_ui without runtime client');
  assert(missing.isError === true, 'missing runtime client is a structured tool error');
  assert(missingBody.error === 'runtime_client_required', 'missing runtime client reports runtime_client_required');

  const missingInteraction = await client.rpc('tools/call', {
    name: 'interact_ui',
    arguments: {
      action: 'click',
      selector: { name: 'Missing' },
      ...(process.env.MCP_INSTANCE_ID ? { instance_id: process.env.MCP_INSTANCE_ID } : {}),
    },
  });
  const missingInteractionBody = parseToolBody(missingInteraction, 'interact_ui without runtime client');
  assert(missingInteraction.isError === true, 'interaction without a runtime client is a structured tool error');
  assert(missingInteractionBody.error === 'runtime_client_required', 'interaction reports runtime_client_required');

  await startPlaytestAndWait(client);
  const runtime = await waitForClientRole(client, true);
  const target = runtime.role;

  try {
    const created = await client.callTool('eval_client_runtime', { target, code: CREATE_FIXTURE });
    assert(created.ok === true, 'runtime LocalScript bridge creates the PlayerGui fixture');

    let inspected;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      inspected = await client.callTool('inspect_ui', {
        mode: 'inspect',
        target,
        max_depth: 12,
        max_nodes: 100,
        include_text: true,
        include_styles: true,
      });
      const overflow = inspected.elements?.find((element) => element.name === 'OverflowText');
      if (overflow?.textFits === false && overflow?.textBounds?.x > 0) break;
      await delay(100);
    }

    assert(inspected.success === true && inspected.source === 'runtime_player_gui', 'inspect_ui reads the live PlayerGui');
    assert(inspected.target === target, 'inspect_ui reports the routed client role');
    assert(inspected.viewport?.width > 0 && inspected.viewport?.height > 0, 'inspect_ui returns the live viewport');

    const byName = new Map(inspected.elements.map((element) => [element.name, element]));
    const valid = byName.get('ValidButton');
    const overflow = byName.get('OverflowText');
    const hidden = byName.get('HiddenChild');
    const clipped = byName.get('ClippedButton');
    const scroll = byName.get('ScrollFrame');
    const below = byName.get('BelowFold');
    const input = byName.get('SemanticInput');
    const viewportFrame = byName.get('SemanticViewport');
    const underlying = byName.get('OccludedUnderlying');
    const occluder = byName.get('ActiveOccluder');
    const nestedParent = byName.get('NestedParent');
    const nestedChild = byName.get('NestedChild');
    assert(typeof valid?.ref === 'string' && valid.ref.startsWith('ir:'), 'elements include stable client-session refs');
    assert(typeof valid?.path === 'string' && valid.path.includes(FIXTURE_NAME), 'elements include canonical runtime paths');
    assert(Math.abs(valid.rect.width - 120) <= 1 && Math.abs(valid.rect.height - 40) <= 1, 'rendered button rectangle is accurate');
    assert(valid.effectiveVisible === true && valid.interactable === true, 'valid button is visibly actionable');
    assert(overflow?.textFits === false && overflow.textBounds.x > overflow.rect.width, 'text fit and bounds expose overflow');
    assert(hidden?.visible === true && hidden.effectiveVisible === false, 'ancestor visibility is reflected in effective visibility');
    assert(clipped?.visible === true && clipped.visibleRect === null && clipped.clipped === true, 'fully clipped child is distinguished from Visible');
    assert(scroll?.absoluteCanvasSize?.y > scroll?.absoluteWindowSize?.y, 'scrolling geometry is exposed');
    assert(scroll?.canScrollVertical === true, 'scrollability is derived from runtime geometry');
    assert(below?.inScrollingWindow === true && below.requiresScrolling === true, 'below-fold content is marked as requiring scrolling');
    assert(typeof input?.ref === 'string', 'TextBox exposes a stable interaction ref');
    assert(viewportFrame?.role === 'viewport', 'ViewportFrame keeps the same semantic role across Studio and core normalization');
    assert(underlying?.interactable === false && occluder?.interactable === true, 'an active higher-Z button makes the covered control non-actionable');
    assert(nestedParent?.interactable === false && nestedChild?.interactable === true, 'an interactive child owns input instead of making its covered parent actionable');

    const nestedParentClick = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { ref: nestedParent.ref },
    });
    assert(nestedParentClick.success === false && nestedParentClick.reason === 'occluded', 'a parent fully covered by an interactive child is rejected');

    const nestedChildClick = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { ref: nestedChild.ref },
    });
    assert(nestedChildClick.success === true && nestedChildClick.interaction_mode === 'real_input', 'the nested child receives real input');
    await delay(100);
    const nestedClickState = await client.callTool('eval_client_runtime', {
      target,
      code: `local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${FIXTURE_NAME}") return { parent = gui:GetAttribute("NestedParentClicks") or 0, child = gui:GetAttribute("NestedChildClicks") or 0 }`,
    });
    const nestedClickCounts = typeof nestedClickState.result === 'string' ? JSON.parse(nestedClickState.result) : nestedClickState.result;
    assert(nestedClickCounts?.parent === 0 && nestedClickCounts?.child === 1, 'nested input is delivered only to the selected child');

    const occludedClick = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { ref: underlying.ref },
    });
    assert(
      occludedClick.success === false && occludedClick.error === 'ui_target_not_actionable' && occludedClick.reason === 'occluded',
      'covered controls are rejected as occluded before input',
    );
    const noOccludedClickState = await client.callTool('eval_client_runtime', {
      target,
      code: `local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${FIXTURE_NAME}") return { underlying = gui:GetAttribute("UnderlyingClicks") or 0, occluder = gui:GetAttribute("OccluderClicks") or 0 }`,
    });
    const noOccludedClickCounts = typeof noOccludedClickState.result === 'string' ? JSON.parse(noOccludedClickState.result) : noOccludedClickState.result;
    assert(noOccludedClickCounts?.underlying === 0 && noOccludedClickCounts?.occluder === 0, 'rejecting an occluded control does not dispatch a click');

    const occluderClick = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { ref: occluder.ref },
    });
    assert(occluderClick.success === true && occluderClick.interaction_mode === 'real_input', 'the topmost active occluder receives real input');

    const hideOccluder = await client.callTool('eval_client_runtime', {
      target,
      code: `local RunService = game:GetService("RunService") local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${FIXTURE_NAME}") gui.ActiveOccluder.Visible = false RunService.RenderStepped:Wait() return true`,
    });
    assert(hideOccluder.ok === true && hideOccluder.result === 'true', 'the occluder can be hidden after its click');
    const afterOccluderHidden = await client.callTool('inspect_ui', {
      mode: 'inspect',
      target,
      max_depth: 12,
      max_nodes: 100,
    });
    const uncoveredUnderlying = afterOccluderHidden.elements?.find((element) => element.name === 'OccludedUnderlying');
    assert(uncoveredUnderlying?.interactable === true, 'the underlying control becomes actionable after the occluder is hidden');

    const underlyingClick = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { ref: uncoveredUnderlying.ref },
    });
    assert(underlyingClick.success === true && underlyingClick.interaction_mode === 'real_input', 'the uncovered control receives real input');
    await delay(100);
    const occlusionClickState = await client.callTool('eval_client_runtime', {
      target,
      code: `local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${FIXTURE_NAME}") return { underlying = gui:GetAttribute("UnderlyingClicks") or 0, occluder = gui:GetAttribute("OccluderClicks") or 0 }`,
    });
    const occlusionClickCounts = typeof occlusionClickState.result === 'string' ? JSON.parse(occlusionClickState.result) : occlusionClickState.result;
    assert(
      occlusionClickCounts?.underlying === 1 && occlusionClickCounts?.occluder === 1,
      `only the visible topmost control receives each click (${JSON.stringify(occlusionClickCounts)})`,
    );

    const clickedByRef = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { ref: valid.ref },
    });
    assert(
      clickedByRef.success === true && clickedByRef.interaction_mode === 'real_input' &&
        clickedByRef.resolved_target?.ref === valid.ref && typeof clickedByRef.input_point?.y === 'number',
      'click by stable ref uses real input and reports the resolved target',
    );
    await delay(100);
    const firstClick = await client.callTool('eval_client_runtime', {
      target,
      code: `local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${FIXTURE_NAME}") return { clicks = gui:GetAttribute("Clicks"), clientInputs = gui:GetAttribute("ClientInputs"), buttonInputs = gui:GetAttribute("ButtonInputs"), text = gui.ValidButton.Text }`,
    });
    const firstClickState = typeof firstClick.result === 'string' ? JSON.parse(firstClick.result) : firstClick.result;
    assert(firstClickState?.clicks === 1 && firstClickState?.text === 'Clicked 1' && firstClickState?.buttonInputs === 1, 'real click activates the UI callback');

    const clickedBySelector = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { name: 'ValidButton', class: 'TextButton', text: 'Clicked 1', visible_only: true },
    });
    assert(clickedBySelector.success === true, 'compound selector resolves and clicks one control');

    const ambiguous = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { text: 'Duplicate' },
    });
    assert(ambiguous.success === false && ambiguous.error === 'ambiguous_ui_selector', 'ambiguous selector returns candidates instead of guessing');
    assert(Array.isArray(ambiguous.candidates) && ambiguous.candidates.length === 2, 'ambiguous selector returns a compact candidate list');

    const missingTarget = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { name: '__does_not_exist__' },
    });
    assert(missingTarget.success === false && missingTarget.error === 'ui_target_not_found', 'missing selectors return a structured not-found result');

    const hiddenClick = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { ref: hidden.ref },
    });
    assert(
      hiddenClick.success === false && hiddenClick.error === 'ui_target_not_actionable' &&
        hiddenClick.resolved_target?.effectiveVisible === false,
      'hidden controls are rejected before input and reported as not effectively visible',
    );

    const clippedClick = await client.callTool('interact_ui', {
      action: 'click',
      target,
      selector: { ref: clipped.ref },
    });
    assert(
      clippedClick.success === false && clippedClick.error === 'ui_target_not_actionable' &&
        clippedClick.resolved_target?.effectiveVisible === true,
      'fully clipped controls are rejected before input without conflating clipping with effective visibility',
    );

    const focused = await client.callTool('interact_ui', {
      action: 'focus',
      target,
      selector: { ref: input.ref },
    });
    assert(focused.success === true && focused.interaction_mode === 'real_input', 'focus resolves a TextBox through real input');

    const invalidType = await client.callTool('interact_ui', {
      action: 'type',
      target,
      selector: { ref: input.ref },
    });
    assert(invalidType.success === false && invalidType.error === 'invalid_ui_request', 'type validates text before sending input');

    const typed = await client.callTool('interact_ui', {
      action: 'type',
      target,
      selector: { ref: input.ref },
      text: 'semantic input',
    });
    assert(typed.success === true && typed.interaction_mode === 'real_input', 'type uses the focused TextBox input path');
    await delay(100);
    const typedState = await client.callTool('eval_client_runtime', {
      target,
      code: `local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${FIXTURE_NAME}") return gui.SemanticInput.Text`,
    });
    assert(typedState.result === 'semantic input', 'typed text reaches the live TextBox');

    const revealed = await client.callTool('interact_ui', {
      action: 'scroll_into_view',
      target,
      selector: { ref: below.ref },
    });
    assert(revealed.success === true && revealed.interaction_mode === 'test_helper', 'scroll_into_view is explicitly labeled as a test helper');
    assert(revealed.canvas_position?.y > 0, 'scroll_into_view moves the nearest scrolling container');

    const resetScroll = await client.callTool('interact_ui', {
      action: 'set_scroll',
      target,
      selector: { ref: scroll.ref },
      canvas_position: { x: 0, y: 0 },
    });
    assert(resetScroll.success === true && resetScroll.canvas_position?.y === 0, 'set_scroll clamps and reports the applied canvas position');

    const hiddenSubtree = await client.callTool('inspect_ui', {
      mode: 'inspect',
      target,
      root: { ref: hidden.ref },
      max_depth: 2,
      max_nodes: 10,
    });
    assert(hiddenSubtree.elements[0]?.effectiveVisible === false, 'subtree inspection retains hidden ancestor context');

    const clippedSubtree = await client.callTool('inspect_ui', {
      mode: 'inspect',
      target,
      root: { ref: clipped.ref },
      max_depth: 2,
      max_nodes: 10,
    });
    assert(clippedSubtree.elements[0]?.visibleRect === null, 'subtree inspection retains external clipping context');

    const audited = await client.callTool('inspect_ui', {
      mode: 'audit',
      target,
      root: { ref: inspected.elements.find((element) => element.name === FIXTURE_NAME)?.ref },
      max_depth: 12,
      max_nodes: 100,
    });
    const issues = audited.audit?.issues ?? [];
    const issueCodes = new Set(issues.map((issue) => issue.code));
    for (const code of ['text_overflow', 'zero_size_interactive', 'element_outside_viewport', 'fully_clipped_interactive']) {
      assert(issueCodes.has(code), `audit reports ${code}`);
    }
    assert(!issues.some((issue) => issue.ref === valid.ref), 'valid control is not falsely reported');
    assert(!issues.some((issue) => issue.ref === below.ref), 'below-fold scroll content is not falsely reported as fully clipped');
    const reported = (name, code) => issues.some((issue) => issue.code === code && issue.ref === byName.get(name)?.ref);
    assert(reported('CardTitle', 'text_obscured'), 'audit reports a badge drawn over a title\'s letters');
    assert(reported('OccludedUnderlying', 'text_obscured'), 'audit reports a button whose label a higher button covers');
    assert(reported('DiscountLabel', 'text_straddles_edge'), 'audit reports text hanging off the edge of the button beneath it');
    assert(reported('LastRow', 'content_beyond_scroll'), 'audit reports a row past the end of its scroll canvas');
    assert(!issues.some((issue) => ['ShadowTitleBack', 'ShadowTitleFront'].some((name) => issue.ref === byName.get(name)?.ref)),
      'a drop-shadow title is not reported as covered');

    const limited = await client.callTool('inspect_ui', {
      mode: 'inspect',
      target,
      root: { ref: audited.root.ref },
      max_depth: 12,
      max_nodes: 3,
    });
    assert(limited.elements.length <= 3, 'max_nodes bounds output');
    assert(limited.truncation?.truncated === true && limited.truncation.reason === 'max_nodes', 'node limit returns explicit truncation metadata');

    const snapshot = await client.callTool('inspect_ui', {
      mode: 'snapshot',
      target,
      root: { ref: audited.root.ref },
      max_depth: 12,
      max_nodes: 100,
    });
    assert(snapshot.snapshot?.success === true && Array.isArray(snapshot.snapshot.elements), 'snapshot returns a compact deterministic semantic representation');
  } finally {
    try {
      await client.callTool('eval_client_runtime', {
        target,
        code: `local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${FIXTURE_NAME}") if gui then gui:Destroy() end return true`,
      });
    } finally {
      await safeStopPlaytest(client);
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));
