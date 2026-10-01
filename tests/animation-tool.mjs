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
// MoveTo and sees the loader play the walk, paced, and then the idle. Then
// the NPC's own Patrol script walks it back and forth, pausing at each end,
// and verify, given only the model, watches that patrol and passes it.
//
// And a model's own rig (docs/creature-plan.md step 3): a Parts dog rigged by
// hand with Motor6Ds and no declarations, as the creature spike built one.
// check reads its rig from Studio and says which checks it could not run;
// build previews the animation on a copy of the dog, which plays it as
// checked and leaves the dog where it was; a weld to a part outside the dog is
// refused before anything is copied; and in the playtest, verify plays it on
// the dog on the server as checked.
//
// And rig's build and adopt forms (docs/creature-plan.md step 4): rig joins a
// second dog's loose pieces at their pivots as a quadruped, in one undo step,
// and reads the rig back; a rebuild needs the rig's current revision, and a
// rig edited since is left alone; aim and aimAt move the rigged legs with
// every check passing, on a copy and in the playtest; adopting the first dog
// declares its legs and changes none of its joints; and a dog rigged as an
// upload arrives is re-rigged only when the call says to replace the
// importer's rig.

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
// A patrol as a game writes one, dormant until the test switches it on, so it
// does not fight verify's own walk to a position.
const ADD_PATROL = `
local guard = workspace:FindFirstChild(${JSON.stringify(GUARD_NAME)})
local patrol = Instance.new("Script")
patrol.Name = "Patrol"
patrol.Source = [[
local guard = script.Parent
local humanoid = guard:WaitForChild("Humanoid")
while guard:GetAttribute("Patrol") ~= true do
	guard:GetAttributeChangedSignal("Patrol"):Wait()
end
humanoid.WalkSpeed = 8
for _ = 1, 3 do
	for _, z in { 60, 90 } do
		humanoid:MoveTo(Vector3.new(60, 0, z))
		humanoid.MoveToFinished:Wait()
		task.wait(3)
	end
end
]]
patrol.Parent = guard
return true
`;
const DOG_NAME = '__RoqerAnimationTestDog';
const DOG = `game.Workspace.${DOG_NAME}`;
const OUTSIDE_NAME = '__RoqerAnimationTestPost';
// The creature spike's dog, under a Humanoid that neither needs a neck nor
// breaks its joints, its root anchored: a hidden root, a body, a head, four
// legs and a tail, each on a Motor6D at its pivot, and wedge ears and a ball
// nose welded to its head. A MeshPart collar is welded to its body when Studio
// can make one from its own classic head mesh.
const BUILD_DOG = `
local existing = workspace:FindFirstChild(${JSON.stringify(DOG_NAME)})
if existing then existing:Destroy() end
local dog = Instance.new("Model")
dog.Name = ${JSON.stringify(DOG_NAME)}
local frame = CFrame.new(-60, 2.2, 60)
local function newPart(name, size, cframe, props, class)
  local part = Instance.new(class or "Part")
  part.Name = name
  part.Size = size
  part.CFrame = cframe
  part.CanCollide = false
  part.Massless = true
  for key, value in props or {} do part[key] = value end
  part.Parent = dog
  return part
end
local function newMotor(name, part0, part1, pivot)
  local motor = Instance.new("Motor6D")
  motor.Name = name
  motor.C0 = part0.CFrame:Inverse() * CFrame.new(pivot)
  motor.C1 = part1.CFrame:Inverse() * CFrame.new(pivot)
  motor.Part0 = part0
  motor.Part1 = part1
  motor.Parent = part0
end
local function weld(part0, part1)
  local joint = Instance.new("WeldConstraint")
  joint.Part0 = part0
  joint.Part1 = part1
  joint.Parent = part1
end
local root = newPart("HumanoidRootPart", Vector3.new(2, 1.2, 4), frame, { Transparency = 1, Anchored = true, Massless = false })
local body = newPart("Body", Vector3.new(2, 1.2, 4), frame)
newMotor("Root", root, body, frame.Position)
local head = newPart("Head", Vector3.new(1.2, 1.2, 1.4), frame * CFrame.new(0, 0.8, -2.6))
newMotor("Neck", body, head, (frame * CFrame.new(0, 0.4, -2)).Position)
for name, offset in { FrontLeft = Vector3.new(-0.7, -1.4, -1.4), FrontRight = Vector3.new(0.7, -1.4, -1.4), HindLeft = Vector3.new(-0.7, -1.4, 1.4), HindRight = Vector3.new(0.7, -1.4, 1.4) } do
  local leg = newPart(name, Vector3.new(0.5, 1.6, 0.5), frame * CFrame.new(offset))
  newMotor(name, body, leg, (frame * CFrame.new(offset.X, -0.6, offset.Z)).Position)
end
local tail = newPart("Tail", Vector3.new(0.3, 0.3, 1.6), frame * CFrame.new(0, 0.3, 2.7))
newMotor("Tail", body, tail, (frame * CFrame.new(0, 0.3, 1.9)).Position)
for side, x in { LeftEar = -0.4, RightEar = 0.4 } do
  weld(head, newPart(side, Vector3.new(0.3, 0.5, 0.3), head.CFrame * CFrame.new(x, 0.85, 0.2), nil, "WedgePart"))
end
weld(head, newPart("Nose", Vector3.new(0.4, 0.4, 0.4), head.CFrame * CFrame.new(0, -0.1, -0.8), { Shape = Enum.PartType.Ball }))
local made, collar = pcall(function()
  return game:GetService("AssetService"):CreateMeshPartAsync(Content.fromUri("rbxasset://avatar/heads/head.mesh"))
end)
if made then
  collar.Name = "Collar"
  collar.Size = Vector3.new(1.4, 0.5, 0.5)
  collar.CFrame = body.CFrame * CFrame.new(0, 0.3, -1.9)
  collar.CanCollide = false
  collar.Massless = true
  collar.Parent = dog
  weld(body, collar)
end
local humanoid = Instance.new("Humanoid")
humanoid.HipHeight = 1.6
humanoid.RequiresNeck = false
humanoid.BreakJointsOnDeath = false
humanoid.Parent = dog
Instance.new("Animator").Parent = humanoid
dog.PrimaryPart = root
dog.Parent = workspace
return { collar = made, collarError = made and "" or tostring(collar) }
`;
const INSPECT_DOG = `
local dog = workspace:FindFirstChild(${JSON.stringify(DOG_NAME)})
local body = dog and dog:FindFirstChild("Body")
local post = workspace:FindFirstChild(${JSON.stringify(OUTSIDE_NAME)})
return {
  body = body and { body.Position.X, body.Position.Y, body.Position.Z } or false,
  post = post and { post.Position.X, post.Position.Y, post.Position.Z } or false,
  previewLeft = workspace:FindFirstChild("__RoqerAnimationPreview") ~= nil,
}
`;
const REMOVE_DOG = `
for _, name in { ${JSON.stringify(DOG_NAME)}, ${JSON.stringify(OUTSIDE_NAME)} } do
  local found = workspace:FindFirstChild(name)
  if found then found:Destroy() end
end
return true
`;

// A second dog, of loose pieces for rig to join (docs/creature-plan.md step 4):
// a body, a head with wedge ears and a ball nose, legs of an upper and a lower
// piece, and a tail, with no joint, weld or controller. IMPORTED_NAME is the
// same pieces as an upload arrives: each hung from a RootPart at the model's
// origin by a Motor6D at its own centre, under an AnimationController with no
// Animator, beside an InitialPoses folder.
const PUP_NAME = '__RoqerAnimationTestPup';
const PUP = `game.Workspace.${PUP_NAME}`;
const IMPORTED_NAME = '__RoqerAnimationTestImported';
const IMPORTED = `game.Workspace.${IMPORTED_NAME}`;
const PUP_LEGS = { FrontLeft: [-0.7, -0.6, -1.4], FrontRight: [0.7, -0.6, -1.4], HindLeft: [-0.7, -0.6, 1.4], HindRight: [0.7, -0.6, 1.4] };
/** Each piece: its name, size, centre from the body's, and shape. */
function pupPieces() {
  const pieces = [
    ['Body', [2, 1.2, 4], [0, 0, 0]],
    ['Head', [1.2, 1.2, 1.4], [0, 0.8, -2.6]],
    ['Tail', [0.3, 0.3, 1.6], [0, 0.3, 2.7]],
    ['LeftEar', [0.3, 0.5, 0.3], [-0.4, 1.65, -2.4], 'Wedge'],
    ['RightEar', [0.3, 0.5, 0.3], [0.4, 1.65, -2.4], 'Wedge'],
    ['Nose', [0.4, 0.4, 0.4], [0, 0.7, -3.4], 'Ball'],
  ];
  for (const [leg, [x, y, z]] of Object.entries(PUP_LEGS)) {
    pieces.push([`${leg}Upper`, [0.5, 0.8, 0.5], [x, y - 0.4, z]], [`${leg}Lower`, [0.5, 0.8, 0.5], [x, y - 1.2, z]]);
  }
  return pieces;
}
/** The rig call's joints for a pup whose body's centre stands at `at`: neck, hips, knees and tail at their pivots. */
function pupJoints(at) {
  const place = ([x, y, z]) => [at[0] + x, at[1] + y, at[2] + z];
  const joints = [{ part: 'Head', parent: 'Body', pivot: place([0, 0.4, -2]), name: 'Neck', with: ['LeftEar', 'RightEar', 'Nose'] }];
  for (const [leg, [x, y, z]] of Object.entries(PUP_LEGS)) {
    joints.push({ part: `${leg}Upper`, parent: 'Body', pivot: place([x, y, z]), name: leg });
    joints.push({ part: `${leg}Lower`, parent: `${leg}Upper`, pivot: place([x, y - 0.8, z]), name: `${leg}Knee` });
  }
  joints.push({ part: 'Tail', parent: 'Body', pivot: place([0, 0.3, 1.9]) });
  return joints;
}
const PUP_AT = [-60, 2.2, 90];
const IMPORTED_AT = [-60, 2.2, 120];
function buildPieces(name, at, imported) {
  const pieces = pupPieces().map(([piece, size, centre, shape]) => `{ ${JSON.stringify(piece)}, Vector3.new(${size.join(', ')}), Vector3.new(${centre.join(', ')}), ${shape ? JSON.stringify(shape) : 'nil'} }`);
  return `
local existing = workspace:FindFirstChild(${JSON.stringify(name)})
if existing then existing:Destroy() end
local model = Instance.new("Model")
model.Name = ${JSON.stringify(name)}
local at = Vector3.new(${at.join(', ')})
local made = {}
for _, piece in { ${pieces.join(', ')} } do
  local part = Instance.new(piece[4] == "Wedge" and "WedgePart" or "Part")
  part.Name = piece[1]
  part.Size = piece[2]
  part.CFrame = CFrame.new(at + piece[3])
  if piece[4] == "Ball" then part.Shape = Enum.PartType.Ball end
  part.Anchored = true
  part.Parent = model
  table.insert(made, part)
end
${imported ? `
local root = Instance.new("Part")
root.Name = "RootPart"
root.Size = Vector3.new(0.1, 0.1, 0.1)
root.Transparency = 1
root.CFrame = CFrame.new(at.X, 0, at.Z)
root.Anchored = true
root.Parent = model
local poses = Instance.new("Folder")
poses.Name = "InitialPoses"
poses.Parent = model
for _, part in made do
  local motor = Instance.new("Motor6D")
  motor.Name = part.Name
  motor.Part0 = root
  motor.Part1 = part
  motor.C0 = root.CFrame:Inverse() * part.CFrame
  motor.C1 = CFrame.identity
  motor.Parent = root
  local pose = Instance.new("CFrameValue")
  pose.Name = part.Name .. "_Initial"
  pose.Value = motor.C0
  pose.Parent = poses
  part.Anchored = false
end
Instance.new("AnimationController").Parent = model
model.PrimaryPart = root` : ''}
model.Parent = workspace
-- Its own undo step: Studio would otherwise undo the pieces with the rig.
game:GetService("ChangeHistoryService"):SetWaypoint("Roqer test pieces")
return true
`;
}
function inspectPieces(name) {
  return `
local model = workspace:FindFirstChild(${JSON.stringify(name)})
if not model then return { exists = false } end
local motors, welds, c0s = 0, 0, {}
for _, descendant in model:GetDescendants() do
  if descendant:IsA("Motor6D") then
    motors += 1
    c0s[descendant.Name] = { descendant.C0:GetComponents() }
  elseif descendant:IsA("WeldConstraint") then
    welds += 1
  end
end
local root = model:FindFirstChild("HumanoidRootPart")
local humanoid = model:FindFirstChildOfClass("Humanoid")
local controller = model:FindFirstChildOfClass("AnimationController")
local body = model:FindFirstChild("Body")
return {
  exists = true,
  motors = motors,
  welds = welds,
  c0s = c0s,
  root = root ~= nil,
  roots = #model:GetChildren() > 0 and (function() local n = 0 for _, c in model:GetChildren() do if c.Name == "HumanoidRootPart" then n += 1 end end return n end)() or 0,
  rootHidden = root ~= nil and root.Transparency == 1,
  rootAnchored = root ~= nil and root.Anchored,
  primary = model.PrimaryPart and model.PrimaryPart.Name or false,
  controller = humanoid and "Humanoid" or controller and "AnimationController" or false,
  animator = (humanoid or controller) ~= nil and (humanoid or controller):FindFirstChildOfClass("Animator") ~= nil,
  hipHeight = humanoid and math.round(humanoid.HipHeight * 1000) / 1000 or false,
  declared = model:GetAttribute("RoqerRig") ~= nil,
  stamp = model:GetAttribute("RoqerRigRevision") or false,
  importerRoot = model:FindFirstChild("RootPart") ~= nil,
  initialPoses = model:FindFirstChild("InitialPoses") ~= nil,
  body = body and { math.round(body.Position.X * 100) / 100, math.round(body.Position.Y * 100) / 100, math.round(body.Position.Z * 100) / 100 } or false,
}
`;
}
const REMOVE_PUPS = `
for _, name in { ${JSON.stringify(PUP_NAME)}, ${JSON.stringify(IMPORTED_NAME)} } do
  local model = workspace:FindFirstChild(name)
  if model then model:Destroy() end
end
return true
`;
/** A front paw lifted by aimAt and a hind leg swung by aim, on the pup's own rig: the quadruped plan declared both. */
function pawLift() {
  // The paw at rest, under its hip: [right, up, forward] from the root's centre.
  const rest = { FrontLeft: { aimAt: [-0.7, -2.2, 1.4] }, HindRight: { rotation: [0, 0, 0] }, Neck: { rotation: [0, 0, 0] } };
  return {
    name: 'PupPawLift',
    rig: PUP,
    loop: true,
    keyframes: [
      { time: 0, joints: rest },
      { time: 0.6, joints: { FrontLeft: { aimAt: [-0.7, -1.7, 1.9] }, HindRight: { aim: [0, -1, 0.3] }, Neck: { rotation: [20, 0, 0] } } },
      { time: 1.2, joints: rest },
    ],
  };
}

/** The dog's head nodding and tail wagging, written with rotation only: no declarations needed. */
function wag() {
  return {
    name: 'DogWag',
    rig: DOG,
    loop: true,
    keyframes: [
      { time: 0, joints: { Neck: { rotation: [0, 0, 0] }, Tail: { rotation: [0, -30, 0] } } },
      { time: 0.4, joints: { Neck: { rotation: [15, 0, 0] }, Tail: { rotation: [0, 30, 0] } } },
      { time: 0.8, joints: { Neck: { rotation: [0, 0, 0] }, Tail: { rotation: [0, -30, 0] } } },
    ],
  };
}

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

    // -- A model's own rig, read from Studio --------------------------------
    const dogMade = await luau(client, BUILD_DOG);
    console.log(`  (the dog's MeshPart collar: ${dogMade.collar ? 'made' : `not made, ${dogMade.collarError}`})`);
    const dogChecked = await client.callTool('animation', { action: 'check', animation: wag() }, 120_000);
    const dogRig = dogChecked.rig ?? {};
    assert(dogChecked.valid === true && dogRig.path === DOG && dogRig.position === 'Root', `check reads the dog's rig from Studio (${dogChecked.error ?? JSON.stringify(dogChecked.errors ?? dogRig)})`);
    assert(['Root', 'Neck', 'FrontLeft', 'FrontRight', 'HindLeft', 'HindRight', 'Tail'].every((joint) => dogRig.joints?.includes(joint)), `the result names the dog's joints (${JSON.stringify(dogRig.joints)})`);
    const unranged = dogChecked.checks?.results?.find((check) => check.id === 'jointLimits');
    assert(unranged?.status === 'skipped' && /^not checked: /.test(unranged.detail), `a check it has no declarations for says it was not checked (${JSON.stringify(unranged)})`);
    assert(dogChecked.checks?.passed === true && dogChecked.checks.results.every((check) => check.status !== 'fail'), 'nothing fails, and nothing passes that could not be judged');
    if (dogMade.collar) {
      // Studio reads its own classic head mesh, as it does for the stock rig.
      assert(dogChecked.sheet?.boxes === undefined, `the collar is drawn from its mesh (${dogChecked.sheet?.boxes ?? 'ok'})`);
    }
    const dogBefore = await luau(client, INSPECT_DOG);
    const dogBuilt = await client.callTool('animation', { action: 'build', animation: wag(), parent: PARENT }, 120_000);
    assert(dogBuilt.built === true && dogBuilt.readBack?.matchesCompiled === true, `build writes the dog's animation (${dogBuilt.error ?? 'ok'})`);
    assert(dogBuilt.playback?.verified === true, `a copy of the dog played it as checked (within ${dogBuilt.playback?.maxDegrees}°; ${dogBuilt.playback?.reason ?? 'ok'})`);
    const dogAfter = await luau(client, INSPECT_DOG);
    assert(JSON.stringify(dogAfter.body) === JSON.stringify(dogBefore.body) && dogAfter.previewLeft === false, `the dog stayed where it was, and the copy left nothing (${JSON.stringify(dogAfter)})`);

    // A weld to a part outside the dog would still hold that part in a copy,
    // which moving the copy would move: the build is refused before a copy.
    await luau(client, `
      local post = Instance.new("Part")
      post.Name = ${JSON.stringify(OUTSIDE_NAME)}
      post.Anchored = true
      post.Position = Vector3.new(-60, 2, 70)
      post.Parent = workspace
      local leash = Instance.new("WeldConstraint")
      leash.Name = "Leash"
      leash.Part0 = workspace[${JSON.stringify(DOG_NAME)}].Tail
      leash.Part1 = post
      leash.Parent = workspace[${JSON.stringify(DOG_NAME)}].Tail
      return true
    `);
    const postBefore = await luau(client, INSPECT_DOG);
    const leashed = await client.callTool('animation', { action: 'build', animation: wag(), parent: PARENT, expected_revision: dogBuilt.revision }, 120_000);
    assert(leashed.errorCode === 'model_not_copyable' && /Leash/.test(leashed.error ?? ''), `a weld reaching outside the dog is refused, naming it (${leashed.errorCode}: ${leashed.error})`);
    const postAfter = await luau(client, INSPECT_DOG);
    assert(JSON.stringify(postAfter.post) === JSON.stringify(postBefore.post), 'the part outside the dog did not move');
    await luau(client, `workspace[${JSON.stringify(DOG_NAME)}].Tail.Leash:Destroy() workspace[${JSON.stringify(OUTSIDE_NAME)}]:Destroy() return true`);

    // -- Step 4: rig builds a rig from loose pieces --------------------------
    assert(await luau(client, buildPieces(PUP_NAME, PUP_AT, false)) === true, 'a dog of loose pieces is in Workspace');
    const pupArgs = { action: 'rig', model: PUP, joints: pupJoints(PUP_AT), controller: 'Humanoid', plan: 'quadruped' };
    const pupRigged = await client.callTool('animation', pupArgs, 120_000);
    assert(pupRigged.rigged === true && pupRigged.readBack?.matches === true && pupRigged.undoable === true, `rig joins the pieces and reads the rig back as built (${pupRigged.error ?? JSON.stringify(pupRigged.readBack ?? pupRigged.errors)})`);
    assert(pupRigged.rig?.feet?.length === 4 && pupRigged.rig?.limbs?.length === 4 && pupRigged.rangeSheet?.reading !== undefined, `the quadruped plan declares its legs, and the result draws its range sheet (${JSON.stringify(pupRigged.rig)})`);
    const pupMade = await luau(client, inspectPieces(PUP_NAME));
    assert(
      pupMade.motors === 11 && pupMade.welds === 3 && pupMade.rootHidden === true && pupMade.primary === 'HumanoidRootPart' && pupMade.rootAnchored === false
        && pupMade.controller === 'Humanoid' && pupMade.animator === true && Math.abs(pupMade.hipHeight - 1.6) < 0.01 && pupMade.declared === true
        && pupMade.stamp === pupRigged.revision && JSON.stringify(pupMade.body) === JSON.stringify(PUP_AT),
      `Studio holds the rig: 11 Motor6Ds, the ears and nose welded, a hidden root free to walk, a Humanoid standing 1.6 studs up, its declarations and its stamp (${JSON.stringify({ ...pupMade, c0s: undefined })})`,
    );
    const pupUndone = await luau(client, `game:GetService("ChangeHistoryService"):Undo() ${inspectPieces(PUP_NAME)}`);
    assert(pupUndone.motors === 0 && pupUndone.welds === 0 && pupUndone.root === false && pupUndone.controller === false && pupUndone.declared === false, `one undo takes the whole rig out (${JSON.stringify({ ...pupUndone, c0s: undefined })})`);
    const pupAgain = await client.callTool('animation', pupArgs, 120_000);
    assert(pupAgain.rigged === true && pupAgain.readBack?.matches === true, `rig joins it again (${pupAgain.error ?? 'ok'})`);
    const pupUnnamed = await client.callTool('animation', pupArgs, 120_000);
    assert(pupUnnamed.errorCode === 'revision_required', `rigging it again needs the rig's revision (${pupUnnamed.errorCode})`);
    const pupStale = await client.callTool('animation', { ...pupArgs, expected_revision: 'rr1:0:0000000000000000' }, 120_000);
    assert(pupStale.errorCode === 'revision_conflict', `a stale revision is refused (${pupStale.errorCode})`);
    const pupRebuilt = await client.callTool('animation', { ...pupArgs, expected_revision: pupAgain.revision }, 120_000);
    const pupAfterRebuild = await luau(client, inspectPieces(PUP_NAME));
    assert(pupRebuilt.rigged === true && pupRebuilt.readBack?.matches === true && pupAfterRebuild.motors === 11 && pupAfterRebuild.welds === 3 && pupAfterRebuild.roots === 1, `the current revision rebuilds it in place, its own root and welds taken again (${pupRebuilt.error ?? JSON.stringify({ motors: pupAfterRebuild.motors, welds: pupAfterRebuild.welds, roots: pupAfterRebuild.roots })})`);
    const badPivot = pupJoints(PUP_AT).map((joint) => (joint.part === 'Tail' ? { ...joint, pivot: [PUP_AT[0], PUP_AT[1] + 0.3, PUP_AT[2] + 4] } : joint));
    const pupPivot = await client.callTool('animation', { ...pupArgs, joints: badPivot, expected_revision: pupRebuilt.revision }, 120_000);
    assert(pupPivot.errorCode === 'invalid_rig' && /Tail: its pivot/.test(pupPivot.errors?.join(' ') ?? ''), `a pivot outside the pieces it joins is refused, naming the joint (${pupPivot.errorCode})`);

    // aim and aimAt move its legs, every check passes, and a copy plays it.
    const pupLift = await client.callTool('animation', { action: 'build', animation: pawLift(), parent: PARENT, grounded: true }, 120_000);
    const pupLimits = pupLift.checks?.results?.find((check) => check.id === 'jointLimits');
    assert(pupLift.built === true && pupLift.checks?.passed === true && pupLift.checks.results.every((check) => check.status !== 'fail') && pupLimits?.status === 'pass', `aim and aimAt move the rigged legs with every check passing (${pupLift.error ?? JSON.stringify(pupLift.checks?.results)})`);
    assert(pupLift.playback?.verified === true, `a copy of the rigged dog played it as checked (within ${pupLift.playback?.maxDegrees}°; ${pupLift.playback?.reason ?? 'ok'})`);
    // Step 5: waves alone are a whole animation, written out as keys Studio plays as checked.
    const pupSway = await client.callTool('animation', {
      action: 'build',
      animation: { name: 'PupSway', rig: PUP, loop: true, duration: 1.2, waves: [{ joints: ['Tail', 'Neck'], axis: 'Y', amplitude: [25, 10], cycles: 2, lag: 0.25 }] },
      parent: PARENT,
    }, 120_000);
    assert(pupSway.built === true && pupSway.animation?.keyframes === 25 && pupSway.checks?.passed === true, `a wave down the tail and neck builds as 25 keys with its checks passing (${pupSway.error ?? JSON.stringify(pupSway.errors ?? pupSway.animation)})`);
    assert(pupSway.playback?.verified === true, `a copy of the rigged dog played the wave as checked (within ${pupSway.playback?.maxDegrees}°; ${pupSway.playback?.reason ?? 'ok'})`);
    // A gait steps all four legs: every locomotion check passes on the pup, the feet land as a trot's do, and a copy plays it.
    const pupTrot = await client.callTool('animation', {
      action: 'build',
      animation: { name: 'PupTrot', rig: PUP, loop: true, priority: 'Movement', duration: 0.6, gait: { pattern: 'trot', stride: 1.2 }, waves: [{ joints: ['Tail'], axis: 'Y', amplitude: 12, cycles: 2 }] },
      parent: PARENT,
      locomotion: true,
    }, 120_000);
    const trotPattern = pupTrot.checks?.results?.find((check) => check.id === 'gaitSymmetry');
    assert(
      pupTrot.built === true && pupTrot.checks?.passed === true && pupTrot.checks.results.every((check) => check.status === 'pass') && pupTrot.groundSpeed > 0,
      `a trot written by gait builds with every check passing, none skipped, at ${pupTrot.groundSpeed} studs a second (${pupTrot.error ?? JSON.stringify(pupTrot.errors ?? pupTrot.checks?.results?.filter((check) => check.status !== 'pass'))})`,
    );
    assert(/FrontLeftLower with HindRightLower, then FrontRightLower with HindLeftLower$/.test(trotPattern?.detail ?? ''), `its diagonal feet land together (${trotPattern?.detail})`);
    assert(pupTrot.playback?.verified === true, `a copy of the rigged dog played the trot as checked (within ${pupTrot.playback?.maxDegrees}°; ${pupTrot.playback?.reason ?? 'ok'})`);
    await luau(client, `local motor = workspace[${JSON.stringify(PUP_NAME)}].Tail.Tail motor.C0 = motor.C0 * CFrame.new(0, 0.05, 0) return true`);
    const pupEdited = await client.callTool('animation', { ...pupArgs, expected_revision: pupRebuilt.revision }, 120_000);
    assert(pupEdited.errorCode === 'rig_edited_since_build', `a rig edited since rig built it is left alone (${pupEdited.errorCode})`);

    // Adopting the hand-rigged dog's own joints: declarations only.
    const dogJointsBefore = await luau(client, inspectPieces(DOG_NAME));
    const adopted = await client.callTool('animation', { action: 'rig', model: DOG, plan: 'quadruped' }, 120_000);
    const dogJointsAfter = await luau(client, inspectPieces(DOG_NAME));
    assert(adopted.declared === true && adopted.readBack?.matches === true && adopted.rig?.feet?.length === 4, `rig adopts the hand-rigged dog as a quadruped (${adopted.error ?? JSON.stringify(adopted.rig)})`);
    assert(JSON.stringify(dogJointsAfter.c0s) === JSON.stringify(dogJointsBefore.c0s) && dogJointsAfter.declared === true, 'adopting changed none of its joints');
    const adoptedAgain = await client.callTool('animation', { action: 'rig', model: DOG, plan: 'quadruped' }, 120_000);
    assert(adoptedAgain.errorCode === 'revision_required', `replacing its declarations needs their revision (${adoptedAgain.errorCode})`);

    // An upload's rig is replaced only when the call says so.
    assert(await luau(client, buildPieces(IMPORTED_NAME, IMPORTED_AT, true)) === true, 'a dog rigged as an upload arrives is in Workspace');
    const importedArgs = { action: 'rig', model: IMPORTED, joints: pupJoints(IMPORTED_AT), controller: 'AnimationController', plan: 'quadruped' };
    const importedKept = await client.callTool('animation', importedArgs, 120_000);
    assert(importedKept.errorCode === 'importer_rig', `an importer's rig is left alone unless replace says so (${importedKept.errorCode})`);
    const replaced = await client.callTool('animation', { ...importedArgs, replace: 'importer' }, 120_000);
    const importedMade = await luau(client, inspectPieces(IMPORTED_NAME));
    assert(replaced.rigged === true && replaced.readBack?.matches === true && replaced.removed?.includes('RootPart') && replaced.removed?.includes('InitialPoses'), `replace takes the importer's rig out and builds the new one (${replaced.error ?? JSON.stringify(replaced.removed)})`);
    assert(
      importedMade.importerRoot === false && importedMade.initialPoses === false && importedMade.motors === 11 && importedMade.controller === 'AnimationController'
        && importedMade.animator === true && importedMade.rootAnchored === true && JSON.stringify(importedMade.body) === JSON.stringify(IMPORTED_AT),
      `Studio holds the new rig under an AnimationController, its root anchored, and nothing of the importer's (${JSON.stringify({ ...importedMade, c0s: undefined })})`,
    );

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
    assert(await luau(client, ADD_PATROL) === true, 'the NPC has a patrol script, waiting to be switched on');

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

      // Its own patrol, at a WalkSpeed of 8 over 30 studs, pausing 3 s at each end.
      const started = await client.callTool('execute_luau', {
        code: `workspace:FindFirstChild(${JSON.stringify(GUARD_NAME)}):SetAttribute("Patrol", true) return true`,
        target: 'server',
      }, 60_000);
      assert(started?.success === true, `the NPC's patrol is switched on in the playtest (${started?.error ?? 'ok'})`);
      const watched = await client.callTool('animation', { action: 'verify', model: GUARD }, 90_000);
      const seen = watched.movement ?? {};
      assert(seen.mode === 'watched' && seen.moving?.played?.walk > 0 && seen.standing?.played?.idle > 0, `verify watched the patrol walk and then pause (${watched.error ?? JSON.stringify({ moving: seen.moving, standing: seen.standing })})`);
      assert(watched.verified === true && seen.pace?.kept === true, `verify passes the NPC's own patrol, its walk paced to it (${watched.error ?? seen.reason ?? JSON.stringify(seen.pace)})`);

      // The dog's own animation, played on the dog on the playtest server and compared on its own rig.
      const dogPlayed = await client.callTool('animation', { action: 'verify', model: DOG, animation: wag() }, 90_000);
      assert(dogPlayed.verified === true && dogPlayed.played?.source === 'temporary clip', `verify plays the dog's animation on the dog as checked (${dogPlayed.error ?? `within ${dogPlayed.played?.maxDegrees}°; ${dogPlayed.played?.reason ?? 'ok'}`})`);
      // The rig rig built, on the playtest server.
      const pupPlayed = await client.callTool('animation', { action: 'verify', model: PUP, animation: pawLift() }, 90_000);
      assert(pupPlayed.verified === true, `verify plays the paw lift on the rigged dog as checked (${pupPlayed.error ?? `within ${pupPlayed.played?.maxDegrees}°; ${pupPlayed.played?.reason ?? 'ok'}`})`);
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
    await luau(client, REMOVE_DOG).catch((error) => console.error(`  dog cleanup failed: ${error.message}`));
    await luau(client, REMOVE_PUPS).catch((error) => console.error(`  rigged dog cleanup failed: ${error.message}`));
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
