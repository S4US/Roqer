#!/usr/bin/env node
// Throwaway probe for step 8's wiring design. Not committed.
import { McpClient, assert, runTest, safeStopPlaytest, startPlaytestAndWait } from './lib/mcp-client.mjs';

const WAVE = 'http://www.roblox.com/asset/?id=507770239';

const INSTALL = `
local sss = game:GetService("ServerScriptService")
local old = sss:FindFirstChild("__ProbeLoader")
if old then old:Destroy() end
local loader = Instance.new("Script")
loader.Name = "__ProbeLoader"
loader:SetAttribute("idle", ${JSON.stringify(WAVE)})
loader.Source = [[
local Players = game:GetService("Players")
local function apply(character)
  local animate = character:WaitForChild("Animate", 10)
  if not animate then return end
  for _, slot in { "idle" } do
    local id = script:GetAttribute(slot)
    local folder = id and animate:FindFirstChild(slot)
    if folder then
      for _, child in folder:GetChildren() do
        if child:IsA("Animation") then child.AnimationId = id end
      end
    end
  end
end
local function watch(player)
  if player.Character then task.spawn(apply, player.Character) end
  player.CharacterAdded:Connect(apply)
end
for _, player in Players:GetPlayers() do watch(player) end
Players.PlayerAdded:Connect(watch)
]]
loader.Parent = sss
return true
`;

const CLIENT = `
local player = game:GetService("Players").LocalPlayer
local character = player.Character or player.CharacterAdded:Wait()
local animate = character:WaitForChild("Animate", 10)
local humanoid = character:WaitForChild("Humanoid", 10)
task.wait(3)
local ids = {}
for _, child in animate:WaitForChild("idle"):GetChildren() do
  if child:IsA("Animation") then table.insert(ids, child.Name .. "=" .. child.AnimationId) end
end
local playing = {}
local animator = humanoid:FindFirstChildOfClass("Animator")
for _, track in animator:GetPlayingAnimationTracks() do
  table.insert(playing, track.Animation and track.Animation.AnimationId or "?")
end
return { idleIds = ids, playing = playing }
`;

const passed = await runTest('wire probe', async ({ track }) => {
  const client = track(new McpClient('probe'));
  await client.start();
  await client.initialize();
  const installed = await client.callTool('execute_luau', { code: INSTALL, target: 'edit' });
  assert(installed.success === true, `loader installed (${installed.error ?? 'ok'})`);
  try {
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    const result = await client.callTool('execute_luau', { code: CLIENT, target: 'client-1' }, 60_000);
    console.log(JSON.stringify(result.success ? JSON.parse(result.returnValue) : result, null, 2));
    await safeStopPlaytest(client);
  } finally {
    await client.callTool('execute_luau', { code: 'local l = game:GetService("ServerScriptService"):FindFirstChild("__ProbeLoader") if l then l:Destroy() end return true', target: 'edit' });
  }
});
process.exit(passed ? 0 : 1);
