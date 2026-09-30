#!/usr/bin/env node
// Live test for the `animation` tool (docs/animation-plan.md step 7).
//
// It checks and builds a small animation in a temporary ServerStorage folder,
// then exercises the safety rules on a real Studio: the preview leaves nothing
// behind, a rebuild needs the current revision, the write is one undo step,
// and a sequence edited after its build, or not built by the tool, is never
// replaced. A motion check that fails stops the build before Studio changes.

//
// Then it wires Roblox's own wave animation (a published asset, so nothing is
// uploaded) to the idle slot, starts a playtest, and verifies there: the
// built animation plays on the character as checked, and the idle slot holds
// the wired ID and plays it. Publishing is refused without an Open Cloud key;
// with ROQER_ANIMATION_UPLOAD=1 and a key, it uploads one real test animation,
// reads it back, and verifies the published copy in the playtest.
//
// Last, an NPC (docs/creature-plan.md step 2): rig makes a stock R15 body in
// Workspace as one undo step, with the model loader holding the idle, walk
// and run its Animate script carried; a state is replaced only when its
// current ID is named; and in the same playtest, verify walks the NPC with
// MoveTo and sees the loader play the walk, paced, and then the idle.

import { McpClient, assert, runTest, safeStopPlaytest, startPlaytestAndWait } from './lib/mcp-client.mjs';

const FOLDER_NAME = '__RoqerAnimationTest';
const PARENT = `game.ServerStorage.${FOLDER_NAME}`;
const ROBLOX_WAVE = 'rbxassetid://507770239';
const UPLOAD = process.env.ROQER_ANIMATION_UPLOAD === '1';
const GUARD_NAME = '__RoqerAnimationTestGuard';
const GUARD = `game.Workspace.${GUARD_NAME}`;
const REMOVE_GUARD = `
local guard = workspace:FindFirstChild(${JSON.stringify(GUARD_NAME)})
if guard then guard:Destroy() end
return true
`;
const REMOVE_LOADER = `
local loader = game:GetService("ServerScriptService"):FindFirstChild("RoqerAnimate")
if loader then loader:Destroy() end
return true
`;

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

    // Aim posing compiles to rotations Studio plays as checked: the guidance's wave recipe.
    const aimed = await client.callTool('animation', {
      action: 'build',
      animation: {
        name: 'AimWave', rig: 'R15', loop: true, easing: { style: 'CubicV2', direction: 'InOut' },
        keyframes: [
          { time: 0, joints: { RightShoulder: { aim: [1, 0.3, 0.4], bendToward: [0, 1, 0] }, RightElbow: { bend: 70 } } },
          { time: 0.3, joints: { RightElbow: { bend: 115 } } },
          { time: 0.6, joints: { RightShoulder: { aim: [1, 0.3, 0.4], bendToward: [0, 1, 0] }, RightElbow: { bend: 70 } } },
        ],
      },
      parent: PARENT,
    }, 120_000);
    assert(aimed.built === true && aimed.playback?.verified === true, `an aim-posed wave builds and plays as checked (${aimed.error ?? `within ${aimed.playback?.maxDegrees}°`})`);
    assert(/straight at its front/.test(aimed.sheet?.reading ?? ''), 'a wave\'s contact sheet looks at the front below');

    // A swing over 90° is split into in-betweens that Studio plays as checked.
    const swung = await client.callTool('animation', {
      action: 'build',
      animation: {
        name: 'Swung', rig: 'R15',
        keyframes: [
          { time: 0, easing: { style: 'CubicV2', direction: 'Out' }, joints: { RightShoulder: { aim: [0, -1, 0] } } },
          // Raised up the front, the elbow folds back, as the guidance's slash does.
          { time: 0.3, joints: { RightShoulder: { aim: [0, 1, 0.5], bendToward: [0, 0, -1] } } },
        ],
      },
      parent: PARENT,
    }, 120_000);
    assert(swung.built === true && swung.animation?.inBetweens > 0 && swung.playback?.verified === true, `a split swing builds and plays as checked (${swung.error ?? `${swung.animation?.inBetweens} in-betweens, within ${swung.playback?.maxDegrees}°`})`);

    // The weapon grip: the rig table's RightGripAttachment is the dummy's, and
    // an animation that moves the weapon previews on a stand-in motor.
    const grip = await luau(client, `
      local rig = game:GetService("Players"):CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R15)
      local components = {
        right = { rig.RightHand.RightGripAttachment.CFrame:GetComponents() },
        left = { rig.LeftHand.LeftGripAttachment.CFrame:GetComponents() },
      }
      rig:Destroy()
      return components
    `);
    // Only the position is used: a prop motor's turn is the rig table's own.
    const expectedGrip = [0, -0.158, 0];
    for (const side of ['right', 'left']) {
      const found = grip?.[side];
      assert(Array.isArray(found) && expectedGrip.every((value, index) => Math.abs(found[index] - value) < 0.02), `the rig table's ${side} grip is at the dummy's attachment (${JSON.stringify(found)})`);
    }
    const flicked = await client.callTool('animation', {
      action: 'build',
      animation: {
        name: 'Flick', rig: 'R15',
        keyframes: [
          { time: 0, joints: { RightShoulder: { aim: [0, -1, 0.3] }, Weapon: { rotation: [0, 0, 0] } } },
          { time: 0.3, joints: { RightShoulder: { aim: [0, -1, 0.3] }, Weapon: { rotation: [-80, 20, 0] } } },
        ],
      },
      parent: PARENT,
    }, 120_000);
    assert(flicked.built === true && flicked.playback?.verified === true, `a weapon animation builds and plays as checked on the stand-in grip (${flicked.error ?? `within ${flicked.playback?.maxDegrees}°`})`);

    // R6: the rig table is an R6 dummy's, and an R6 animation plays as checked on one.
    const r6 = await luau(client, `
      local rig = game:GetService("Players"):CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R6)
      local found = {}
      for _, motor in rig:GetDescendants() do
        if motor:IsA("Motor6D") and motor.Part1 then
          found[motor.Part1.Name] = { c0 = { motor.C0:GetComponents() }, c1 = { motor.C1:GetComponents() } }
        end
      end
      local grip = rig["Right Arm"]:FindFirstChild("RightGripAttachment")
      found.grip = grip and { grip.CFrame:GetComponents() } or false
      local leftGrip = rig["Left Arm"]:FindFirstChild("LeftGripAttachment")
      found.leftGrip = leftGrip and { leftGrip.CFrame:GetComponents() } or false
      rig:Destroy()
      return found
    `);
    const TORSO_FRAME = [-1, 0, 0, 0, 0, 1, 0, 1, 0];
    const RIGHT_FRAME = [0, 0, 1, 0, 1, 0, -1, 0, 0];
    const LEFT_FRAME = [0, 0, -1, 0, 1, 0, 1, 0, 0];
    const expectedR6 = {
      Torso: [[0, 0, 0, ...TORSO_FRAME], [0, 0, 0, ...TORSO_FRAME]],
      Head: [[0, 1, 0, ...TORSO_FRAME], [0, -0.5, 0, ...TORSO_FRAME]],
      'Left Arm': [[-1, 0.5, 0, ...LEFT_FRAME], [0.5, 0.5, 0, ...LEFT_FRAME]],
      'Right Arm': [[1, 0.5, 0, ...RIGHT_FRAME], [-0.5, 0.5, 0, ...RIGHT_FRAME]],
      'Left Leg': [[-1, -1, 0, ...LEFT_FRAME], [-0.5, 1, 0, ...LEFT_FRAME]],
      'Right Leg': [[1, -1, 0, ...RIGHT_FRAME], [0.5, 1, 0, ...RIGHT_FRAME]],
    };
    const close = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < 0.02);
    const r6Matches = Object.entries(expectedR6).every(([part, [c0, c1]]) => close(r6[part]?.c0, c0) && close(r6[part]?.c1, c1));
    assert(r6Matches, `the R6 rig table matches an R6 dummy's Motor6Ds (${JSON.stringify(r6)})`);
    // R6's grip attachments are not turned as R15's are (measured 2026-09-29);
    // only their position is used, so only it is compared.
    assert(Array.isArray(r6.grip) && close(r6.grip.slice(0, 3), [0, -1, 0]), `the R6 grip is at the Right Arm's RightGripAttachment (${JSON.stringify(r6.grip)})`);
    assert(Array.isArray(r6.leftGrip) && close(r6.leftGrip.slice(0, 3), [0, -1, 0]), `the R6 left grip is at the Left Arm's LeftGripAttachment (${JSON.stringify(r6.leftGrip)})`);
    const drawn = await client.callTool('animation', {
      action: 'build',
      animation: {
        name: 'DrawR6', rig: 'R6',
        keyframes: [
          { time: 0, joints: { Sheath: { rotation: [0, 0, 0] }, OffHand: { rotation: [0, 0, 0] }, Weapon: { rotation: [0, 0, 0] } } },
          { time: 0.3, joints: { Sheath: { rotation: [-20, 15, 0] }, OffHand: { rotation: [-60, 0, 0] }, Weapon: { rotation: [-90, 0, 0] } } },
        ],
      },
      parent: PARENT,
    }, 120_000);
    assert(drawn.built === true && drawn.playback?.verified === true, `sheath and both hand props build and play as checked on R6 (${drawn.error ?? `within ${drawn.playback?.maxDegrees}°`})`);
    const marched = await client.callTool('animation', {
      action: 'build',
      animation: {
        name: 'MarchR6', rig: 'R6', loop: true,
        keyframes: [
          { time: 0, joints: { LeftHip: { aim: [0, -1, 0.4] }, RightHip: { aim: [0, -1, -0.4] }, Neck: { rotation: [10, 0, 0] } } },
          { time: 0.4, joints: { LeftHip: { aim: [0, -1, -0.4] }, RightHip: { aim: [0, -1, 0.4] }, Neck: { rotation: [-10, 0, 0] } } },
          { time: 0.8, joints: { LeftHip: { aim: [0, -1, 0.4] }, RightHip: { aim: [0, -1, -0.4] }, Neck: { rotation: [10, 0, 0] } } },
        ],
      },
      parent: PARENT,
      locomotion: true,
    }, 120_000);
    assert(marched.built === true && marched.playback?.verified === true, `an R6 animation builds and plays as checked on an R6 dummy (${marched.error ?? `within ${marched.playback?.maxDegrees}°`})`);

    // aimAt: a planted lunge builds, with its solved keys, and plays as checked.
    const lunged = await client.callTool('animation', {
      action: 'build',
      animation: {
        name: 'Planted', rig: 'R15',
        keyframes: [
          // A wide stance needs the knees bent: the body starts a little low.
          { time: 0, joints: { Root: { position: [0, -0.2, 0] }, LeftHip: { aimAt: [-0.6, -2.93, 0.4] }, RightHip: { aimAt: [0.6, -2.93, -0.5] } } },
          { time: 0.4, joints: { Root: { position: [0, -0.5, -0.3], rotation: [0, 15, 0] }, LeftHip: { aimAt: [-0.6, -2.93, 0.4] }, RightHip: { aimAt: [0.6, -2.93, -0.5] } } },
        ],
      },
      parent: PARENT,
      grounded: true,
    }, 120_000);
    assert(lunged.built === true && lunged.animation?.inBetweens > 0 && lunged.playback?.verified === true, `a planted lunge builds and plays as checked (${lunged.error ?? `${lunged.animation?.inBetweens} solved keys, within ${lunged.playback?.maxDegrees}°`})`);

    // grip: a two-handed swing builds, the left hand solved on the handle, and plays as checked.
    const gripKey = (time, at, turn) => ({ time, joints: { RightShoulder: { aimAt: at, bendToward: [0, 1, 0] }, Weapon: { rotation: [turn, 0, 0] }, LeftShoulder: { grip: 0.45 } } });
    const twoHanded = await client.callTool('animation', {
      action: 'build',
      animation: { name: 'TwoHanded', rig: 'R15', keyframes: [gripKey(0, [-0.2, 0.5, 0.8], 0), gripKey(0.3, [-0.2, 1.5, 0.5], 30), gripKey(0.42, [-0.2, 0, 0.8], -60)] },
      parent: PARENT,
    }, 120_000);
    assert(twoHanded.built === true && twoHanded.playback?.verified === true, `a two-handed swing builds and plays as checked (${twoHanded.error ?? `within ${twoHanded.playback?.maxDegrees}°`})`);

    // Markers become KeyframeMarkers a script's GetMarkerReachedSignal fires on.
    const marked = await client.callTool('animation', {
      action: 'build',
      animation: {
        name: 'Marked', rig: 'R15',
        keyframes: [
          { time: 0, joints: { RightShoulder: { aim: [0, -1, 0] } } },
          { time: 0.2, joints: {}, markers: [{ name: 'Hit', value: 'light' }] },
          { time: 0.4, joints: { RightShoulder: { aim: [0, -1, 0.6] } } },
        ],
      },
      parent: PARENT,
    }, 120_000);
    assert(marked.built === true && marked.readBack?.markers === 1 && marked.readBack?.matchesCompiled === true, `markers are built and read back (${marked.error ?? JSON.stringify(marked.readBack)})`);
    const markerState = await luau(client, `
      local marked = game:GetService("ServerStorage")[${JSON.stringify(FOLDER_NAME)}]:FindFirstChild("Marked")
      local found = {}
      for _, descendant in marked:GetDescendants() do
        if descendant:IsA("KeyframeMarker") then
          table.insert(found, { name = descendant.Name, value = descendant.Value, time = descendant.Parent.Time })
        end
      end
      return found
    `);
    assert(markerState.length === 1 && markerState[0].name === 'Hit' && markerState[0].value === 'light' && Math.abs(markerState[0].time - 0.2) < 1e-6, `Studio holds the marker at its keyframe (${JSON.stringify(markerState)})`);

    // -- Step 8: publish, wire, verify -------------------------------------
    // The hand-edited sequence stays refused; start it afresh to publish from.
    await luau(client, `game:GetService("ServerStorage")[${JSON.stringify(FOLDER_NAME)}].Wave:Destroy() return true`);
    const rebuiltAfterEdit = await client.callTool('animation', { action: 'build', animation: wave(100), parent: PARENT }, 120_000);
    assert(rebuiltAfterEdit.built === true, `a fresh build to publish from (${rebuiltAfterEdit.error ?? 'ok'})`);

    let publishedId;
    if (!process.env.ROBLOX_OPEN_CLOUD_API_KEY) {
      const refused = await client.callTool('animation', { action: 'publish', path: rebuiltAfterEdit.path }, 120_000);
      assert(refused.errorCode === 'open_cloud_not_configured', `publishing without a key uploads nothing and says why (${refused.errorCode})`);
    } else if (UPLOAD) {
      const published = await client.callTool('animation', { action: 'publish', path: rebuiltAfterEdit.path, display_name: 'Roqer animation tool test' }, 150_000);
      assert(published.published === true && published.readBack?.matches === true, `publishing uploads the build and reads it back (${published.error ?? `${published.animationId}, ${published.moderation}`})`);
      publishedId = published.animationId;
    } else {
      console.log('  (publish skipped: set ROQER_ANIMATION_UPLOAD=1 to upload a real test animation)');
    }

    await luau(client, REMOVE_LOADER);
    const wired = await client.callTool('animation', { action: 'wire', slot: 'idle', animation_id: ROBLOX_WAVE });
    assert(wired.wired === true && wired.installed === true && wired.readBackMatches === true, `wire installs the loader and sets the idle slot (${wired.error ?? 'ok'})`);
    const unnamed = await client.callTool('animation', { action: 'wire', slot: 'idle', animation_id: ROBLOX_WAVE });
    assert(unnamed.errorCode === 'expected_id_required', `replacing a slot needs its current ID (${unnamed.errorCode})`);
    const wrong = await client.callTool('animation', { action: 'wire', slot: 'idle', animation_id: ROBLOX_WAVE, expected_id: 'rbxassetid://1' });
    assert(wrong.errorCode === 'animation_id_changed', `a slot changed underneath is not overwritten (${wrong.errorCode})`);
    const same = await client.callTool('animation', { action: 'wire', slot: 'idle', animation_id: ROBLOX_WAVE, expected_id: ROBLOX_WAVE });
    assert(same.wired === true && same.installed === false, 'naming the current ID replaces it');

    // An NPC: a stock body whose loader stands in for its Animate script.
    await luau(client, REMOVE_GUARD);
    const rigged = await client.callTool('animation', { action: 'rig', model: GUARD, stock: 'R15', position: [60, 0, 60] }, 60_000);
    assert(rigged.rigged === true && rigged.rigType === 'R15' && rigged.readBackMatches === true, `rig makes a stock R15 NPC and reads it back (${rigged.error ?? `${rigged.parts} parts, ${rigged.joints} joints, feet at ${JSON.stringify(rigged.feet)}`})`);
    const defaults = rigged.states ?? {};
    assert(['idle', 'walk', 'run'].every((state) => /^rbxassetid:\/\/\d+$/.test(defaults[state] ?? '')) && rigged.animateRemoved === true, `its loader holds the idle, walk and run its Animate carried, and Animate is gone (${JSON.stringify(defaults)})`);
    const inspectGuard = `
      local guard = workspace:FindFirstChild(${JSON.stringify(GUARD_NAME)})
      local root = guard and guard:FindFirstChild("HumanoidRootPart")
      return {
        exists = guard ~= nil,
        loader = guard ~= nil and guard:FindFirstChild("RoqerModelAnimate") ~= nil,
        animate = guard ~= nil and guard:FindFirstChild("Animate") ~= nil,
        anchored = root ~= nil and root.Anchored,
      }
    `;
    const made = await luau(client, inspectGuard);
    assert(made.exists === true && made.loader === true && made.animate === false && made.anchored === false, `Studio holds the NPC with its loader, no Animate, and a root free to walk (${JSON.stringify(made)})`);
    const taken = await client.callTool('animation', { action: 'rig', model: GUARD, stock: 'R15' }, 60_000);
    assert(taken.errorCode === 'target_exists', `rig never replaces what a path already names (${taken.errorCode})`);
    const undoneRig = await luau(client, `game:GetService("ChangeHistoryService"):Undo() ${inspectGuard}`);
    assert(undoneRig.exists === false, 'one undo removes the NPC');
    const remade = await client.callTool('animation', { action: 'rig', model: GUARD, stock: 'R15', position: [60, 0, 60] }, 60_000);
    assert(remade.rigged === true && remade.readBackMatches === true, `rig makes it again (${remade.error ?? 'ok'})`);

    // Pacing the walk as written for 10 studs a second has the loader play it
    // 1.6 times as fast at the stock WalkSpeed of 16: a value chosen to see the
    // pacing work, not a measurement of Roblox's walk.
    const unnamedState = await client.callTool('animation', { action: 'wire', model: GUARD, slot: 'walk', animation_id: defaults.walk, ground_speed: 10 });
    assert(unnamedState.errorCode === 'expected_id_required', `replacing an NPC's state needs its current ID (${unnamedState.errorCode})`);
    const pacedWalk = await client.callTool('animation', { action: 'wire', model: GUARD, slot: 'walk', animation_id: defaults.walk, expected_id: defaults.walk, ground_speed: 10 });
    assert(pacedWalk.wired === true && pacedWalk.installed === false && pacedWalk.groundSpeed === 10 && pacedWalk.readBackMatches === true, `wire paces the NPC's walk (${pacedWalk.error ?? 'ok'})`);

    let playtestStarted = false;
    try {
      playtestStarted = true;
      await startPlaytestAndWait(client, { timeoutSec: 60 });
      const temporary = await client.callTool('animation', { action: 'verify', animation: wave(100) }, 60_000);
      assert(temporary.verified === true && temporary.played?.source === 'temporary clip', `verify plays the built animation on the character as checked (within ${temporary.played?.maxDegrees}°; ${temporary.error ?? temporary.played?.reason ?? 'ok'})`);
      const wiring = await client.callTool('animation', { action: 'verify', animation: wave(100), animation_id: ROBLOX_WAVE, slot: 'idle' }, 60_000);
      assert(wiring.wiring?.matches === true && wiring.wiring?.playingNow === true, `the idle slot holds the wired ID and plays it (${JSON.stringify(wiring.wiring ?? wiring.error)})`);
      if (publishedId) {
        const published = await client.callTool('animation', { action: 'verify', animation: wave(100), animation_id: publishedId }, 60_000);
        assert(published.verified === true && published.played?.source === 'published', `the published copy plays as checked (within ${published.played?.maxDegrees}°)`);
      }
      const walked = await client.callTool('animation', { action: 'verify', model: GUARD, position: [60, 0, 90], slot: 'walk', animation_id: defaults.walk }, 90_000);
      const movement = walked.movement ?? {};
      assert(movement.reached === true && movement.moving?.played?.walk > 0 && movement.standing?.played?.idle > 0, `the NPC walked there, playing its walk and then its idle (${walked.error ?? JSON.stringify({ moving: movement.moving, standing: movement.standing })})`);
      assert(movement.pace?.state === 'walk' && movement.pace.kept === true, `its loader paced the walk to its speed (${JSON.stringify(movement.pace ?? movement.reason)})`);
      assert(walked.verified === true && walked.wiring?.matches === true, `verify passes the NPC on the playtest server (${walked.error ?? movement.reason ?? 'ok'})`);
    } finally {
      if (playtestStarted) await safeStopPlaytest(client);
    }

    const handEdited = await luau(client, `
      local loader = game:GetService("ServerScriptService").RoqerAnimate
      loader.Source = loader.Source .. "\\n-- edited"
      return true
    `);
    assert(handEdited === true, 'the loader was edited by hand');
    const modified = await client.callTool('animation', { action: 'wire', slot: 'run', animation_id: ROBLOX_WAVE });
    assert(modified.errorCode === 'loader_modified', `an edited loader is left alone (${modified.errorCode})`);
  } finally {
    await luau(client, REMOVE_GUARD).catch((error) => console.error(`  NPC cleanup failed: ${error.message}`));
    await luau(client, REMOVE_LOADER).catch((error) => console.error(`  loader cleanup failed: ${error.message}`));
    await luau(client, `
      local folder = game:GetService("ServerStorage"):FindFirstChild(${JSON.stringify(FOLDER_NAME)})
      if folder then folder:Destroy() end
      return true
    `).catch((error) => console.error(`  cleanup failed: ${error.message}`));
  }
});

process.exit(passed ? 0 : 1);
