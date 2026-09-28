#!/usr/bin/env node
// Live test for the `animation` tool (docs/animation-plan.md step 7).
//
// It checks and builds a small animation in a temporary ServerStorage folder,
// then exercises the safety rules on a real Studio: the preview leaves nothing
// behind, a rebuild needs the current revision, the write is one undo step,
// and a sequence edited after its build, or not built by the tool, is never
// replaced. A motion check that fails stops the build before Studio changes.

import { McpClient, assert, runTest } from './lib/mcp-client.mjs';

const FOLDER_NAME = '__RoqerAnimationTest';
const PARENT = `game.ServerStorage.${FOLDER_NAME}`;

function wave(raise) {
  return {
    name: 'Wave',
    rig: 'R15',
    loop: true,
    keyframes: [
      { time: 0, joints: { RightShoulder: { rotation: [0, 0, 60] }, RightElbow: { rotation: [30, 0, 0] } } },
      { time: 0.5, easing: { style: 'CubicV2', direction: 'InOut' }, joints: { RightShoulder: { rotation: [0, 0, raise] }, RightElbow: { rotation: [60, 0, 0] } } },
      { time: 1, joints: { RightShoulder: { rotation: [0, 0, 60] }, RightElbow: { rotation: [30, 0, 0] } } },
    ],
  };
}

async function luau(client, code) {
  const result = await client.callTool('execute_luau', { code, target: 'edit' }, 60_000);
  if (result?.success !== true) throw new Error(`execute_luau failed: ${result?.error ?? JSON.stringify(result)}`);
  // A table comes back as JSON; a string comes back as itself.
  try {
    return JSON.parse(result.returnValue);
  } catch {
    return result.returnValue;
  }
}

const INSPECT = `
local folder = game:GetService("ServerStorage"):FindFirstChild(${JSON.stringify(FOLDER_NAME)})
local wave = folder and folder:FindFirstChild("Wave")
local keyframes = 0
if wave then
  for _, child in wave:GetChildren() do if child:IsA("Keyframe") then keyframes += 1 end end
end
return {
  className = wave and wave.ClassName or "none",
  revision = wave and wave:GetAttribute("RoqerAnimationRevision") or "none",
  keyframes = keyframes,
  previewLeft = workspace:FindFirstChild("__RoqerAnimationPreview") ~= nil,
  owl = folder and folder:FindFirstChild("Owl") ~= nil,
}
`;

const passed = await runTest('animation tool', async ({ track }) => {
  const client = track(new McpClient('animation'));
  await client.start();
  await client.initialize();

  await luau(client, `
    local existing = game:GetService("ServerStorage"):FindFirstChild(${JSON.stringify(FOLDER_NAME)})
    if existing then existing:Destroy() end
    local folder = Instance.new("Folder")
    folder.Name = ${JSON.stringify(FOLDER_NAME)}
    folder.Parent = game:GetService("ServerStorage")
    return true
  `);
  try {
    const checked = await client.callTool('animation', { action: 'check', animation: wave(100) });
    assert(checked.valid === true && checked.checks?.passed === true, `check passes a gentle wave (${JSON.stringify(checked.checks?.results?.filter((c) => c.status === 'fail'))})`);

    const first = await client.callTool('animation', { action: 'build', animation: wave(100), parent: PARENT }, 120_000);
    assert(first.built === true, `build writes the sequence (${first.error ?? 'ok'})`);
    assert(first.playback?.verified === true, `Studio played the preview as checked (within ${first.playback?.maxDegrees}°)`);
    assert(first.readBack?.matchesCompiled === true && first.replaced === false, 'the read-back matches what was compiled');
    let state = await luau(client, INSPECT);
    assert(state.className === 'KeyframeSequence' && state.keyframes === 3 && state.revision === first.revision, `Studio holds the stamped sequence (${JSON.stringify(state)})`);
    assert(state.previewLeft === false, 'the preview left nothing in Workspace');

    const unstated = await client.callTool('animation', { action: 'build', animation: wave(110), parent: PARENT }, 120_000);
    assert(unstated.errorCode === 'revision_required' && unstated.currentRevision === first.revision, `a rebuild without the revision is refused (${unstated.errorCode})`);
    const stale = await client.callTool('animation', { action: 'build', animation: wave(110), parent: PARENT, expected_revision: 'kr1:0:0000000000000000' }, 120_000);
    assert(stale.errorCode === 'revision_conflict', `a rebuild with a stale revision is refused (${stale.errorCode})`);

    const second = await client.callTool('animation', { action: 'build', animation: wave(110), parent: PARENT, expected_revision: first.revision }, 120_000);
    assert(second.built === true && second.replaced === true && second.revision !== first.revision, `a rebuild with the current revision replaces it (${second.error ?? 'ok'})`);

    const undone = await luau(client, `
      game:GetService("ChangeHistoryService"):Undo()
      local wave = game:GetService("ServerStorage")[${JSON.stringify(FOLDER_NAME)}]:FindFirstChild("Wave")
      return wave and wave:GetAttribute("RoqerAnimationRevision") or "none"
    `);
    assert(undone === first.revision, `one undo restores the first build (${undone})`);

    await luau(client, `
      local wave = game:GetService("ServerStorage")[${JSON.stringify(FOLDER_NAME)}].Wave
      local pose = wave:FindFirstChildWhichIsA("Keyframe"):FindFirstChild("RightUpperArm", true)
      pose.CFrame = pose.CFrame * CFrame.Angles(0.2, 0, 0)
      return true
    `);
    const edited = await client.callTool('animation', { action: 'build', animation: wave(110), parent: PARENT, expected_revision: first.revision }, 120_000);
    assert(edited.errorCode === 'animation_edited_since_build', `a sequence edited after its build is not replaced (${edited.errorCode})`);

    await luau(client, `
      local foreign = Instance.new("KeyframeSequence")
      foreign.Name = "Foreign"
      foreign.Parent = game:GetService("ServerStorage")[${JSON.stringify(FOLDER_NAME)}]
      return true
    `);
    const foreign = await client.callTool('animation', { action: 'build', animation: { ...wave(100), name: 'Foreign' }, parent: PARENT }, 120_000);
    assert(foreign.errorCode === 'target_not_built_here', `a sequence the tool did not build is not replaced (${foreign.errorCode})`);

    const owl = await client.callTool('animation', {
      action: 'build',
      animation: { name: 'Owl', rig: 'R15', keyframes: [{ time: 0, joints: { Neck: { rotation: [0, 150, 0] } } }] },
      parent: PARENT,
    });
    state = await luau(client, INSPECT);
    assert(typeof owl.error === 'string' && /jointLimits/.test(owl.error) && state.owl === false, 'a failing motion check stops the build before Studio changes');
  } finally {
    await luau(client, `
      local folder = game:GetService("ServerStorage"):FindFirstChild(${JSON.stringify(FOLDER_NAME)})
      if folder then folder:Destroy() end
      return true
    `).catch((error) => console.error(`  cleanup failed: ${error.message}`));
  }
});

process.exit(passed ? 0 : 1);
