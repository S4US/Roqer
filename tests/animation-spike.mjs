#!/usr/bin/env node
// Live spike for docs/animation-plan.md step 2. It answers four questions on a
// real Studio before the animation work depends on them:
//
//   1. Can the stock R15 dummy be built in memory in edit mode?
//   2. Do temporary animation IDs play, in edit mode and in a playtest?
//   3. Does Open Cloud accept a KeyframeSequence exported from Studio as an
//      Animation asset? (Only with ROQER_SPIKE_UPLOAD=1: it creates a real asset.)
//   4. Can a just-published animation be read back and played?
//
// The answers are findings, not assertions: a "no" is a result to record in the
// plan, and the script still exits 0. It fails only when it could not ask a
// question at all, or could not clean up after itself. The JSON report, which
// also holds the dummy's R15 rest pose for the pose compiler, is written under
// tmp/animation-spike/.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  McpClient,
  REPO_ROOT,
  assert,
  runTest,
  safeStopPlaytest,
  startPlaytestAndWait,
} from './lib/mcp-client.mjs';

const SPIKE_FOLDER = '__RoqerAnimationSpike';
const SEQUENCE_PATH = `game.Workspace.${SPIKE_FOLDER}.SpikeSwing`;
const UPLOAD = process.env.ROQER_SPIKE_UPLOAD === '1';
const UPLOAD_POLL_MS = 5_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const READ_BACK_POLL_MS = 10_000;
const READ_BACK_TIMEOUT_MS = 180_000;

const reportDir = path.join(REPO_ROOT, 'tmp', 'animation-spike');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `report-${stamp}.json`);
const rbxmPath = path.join(reportDir, `spike-swing-${stamp}.rbxm`);

// Shared by every snippet: each execute_luau call is a fresh chunk.
const PRELUDE = `
local Players = game:GetService("Players")
local SPIKE = ${JSON.stringify(SPIKE_FOLDER)}

local function addPose(name, cframe, parent)
  local pose = Instance.new("Pose")
  pose.Name = name
  pose.CFrame = cframe or CFrame.identity
  pose.Weight = 1
  pose.Parent = parent
  return pose
end

-- Arms and legs swing in opposite phase, like a stiff walk.
local function addKeyframe(sequence, time, swing)
  local keyframe = Instance.new("Keyframe")
  keyframe.Time = time
  local root = addPose("HumanoidRootPart", nil, keyframe)
  local lower = addPose("LowerTorso", nil, root)
  local upper = addPose("UpperTorso", nil, lower)
  addPose("RightUpperArm", CFrame.Angles(math.rad(swing), 0, 0), upper)
  addPose("LeftUpperArm", CFrame.Angles(math.rad(-swing), 0, 0), upper)
  addPose("RightUpperLeg", CFrame.Angles(math.rad(-swing), 0, 0), lower)
  addPose("LeftUpperLeg", CFrame.Angles(math.rad(swing), 0, 0), lower)
  keyframe.Parent = sequence
end

local function buildSequence(parent)
  local sequence = Instance.new("KeyframeSequence")
  sequence.Name = "SpikeSwing"
  sequence.Loop = true
  sequence.Priority = Enum.AnimationPriority.Action
  addKeyframe(sequence, 0, 40)
  addKeyframe(sequence, 0.5, -40)
  addKeyframe(sequence, 1, 40)
  sequence.Parent = parent
  return sequence
end

-- What a registration returned, as the engine describes it. The first run
-- got a bare 32-digit hex string from both providers, with no scheme.
local function describeId(value)
  local info = { type = typeof(value), text = tostring(value) }
  local ok, uri = pcall(function() return value.Uri end)
  if ok and uri ~= nil then info.uri = tostring(uri) end
  return info
end

-- Every form of a temporary ID worth trying as an AnimationId, most direct first.
local function idCandidates(value)
  local list = {}
  local function add(text)
    if typeof(text) ~= "string" or text == "" then return end
    for _, existing in list do
      if existing == text then return end
    end
    table.insert(list, text)
  end
  if typeof(value) == "string" then add(value) end
  local ok, uri = pcall(function() return value.Uri end)
  if ok then add(uri) end
  local text = tostring(value)
  add(text)
  if not string.find(text, "://", 1, true) then add("active://" .. text) end
  return list
end

local function register(sequence)
  local attempts = {}
  local candidates = {}
  local ok, id = pcall(function()
    return game:GetService("AnimationClipProvider"):RegisterAnimationClip(sequence)
  end)
  attempts.animationClipProvider = ok and describeId(id) or { error = tostring(id) }
  if ok then candidates = idCandidates(id) end
  local ok2, id2 = pcall(function()
    return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(sequence)
  end)
  attempts.keyframeSequenceProvider = ok2 and describeId(id2) or { error = tostring(id2) }
  if #candidates == 0 and ok2 then candidates = idCandidates(id2) end
  return candidates, attempts
end

-- The joint that moves partName. Older R15 rigs use a Motor6D; newer ones use
-- an AnimationConstraint, whose Attachment1 sits in the part it moves. The
-- first run found no Motor6D at all, on the dummy or on the playtest character.
local function jointFor(rig, partName)
  for _, descendant in rig:GetDescendants() do
    if descendant:IsA("Motor6D") and descendant.Part1 and descendant.Part1.Name == partName then
      return descendant
    end
    if descendant:IsA("AnimationConstraint") then
      local attachment = descendant.Attachment1
      if attachment and attachment.Parent and attachment.Parent.Name == partName then
        return descendant
      end
    end
  end
  return nil
end

local function jointsOf(rig)
  local joints = {}
  for _, descendant in rig:GetDescendants() do
    if descendant:IsA("Motor6D") then
      table.insert(joints, {
        kind = "Motor6D",
        name = descendant.Name,
        part0 = descendant.Part0 and descendant.Part0.Name or "",
        part1 = descendant.Part1 and descendant.Part1.Name or "",
        c0 = { descendant.C0:GetComponents() },
        c1 = { descendant.C1:GetComponents() },
      })
    elseif descendant:IsA("AnimationConstraint") then
      local a0, a1 = descendant.Attachment0, descendant.Attachment1
      table.insert(joints, {
        kind = "AnimationConstraint",
        name = descendant.Name,
        part0 = a0 and a0.Parent and a0.Parent.Name or "",
        part1 = a1 and a1.Parent and a1.Parent.Name or "",
        c0 = a0 and { a0.CFrame:GetComponents() } or {},
        c1 = a1 and { a1.CFrame:GetComponents() } or {},
      })
    end
  end
  return joints
end

local function degreesBetween(a, b)
  local _, angle = (a:Inverse() * b):ToAxisAngle()
  return math.deg(angle)
end

-- Plays animationId on the rig and reports whether the right shoulder moved.
-- Edit mode has no animation clock, so there the track is stepped by hand.
local function probePlayback(rig, animationId, stepByHand)
  local result = { animationId = animationId }
  local humanoid = rig:FindFirstChildOfClass("Humanoid")
  local motor = jointFor(rig, "RightUpperArm")
  if not humanoid or not motor then
    result.error = "rig has no Humanoid or no RightUpperArm joint"
    result.plays = false
    return result
  end
  result.jointKind = motor.ClassName
  local animator = humanoid:FindFirstChildOfClass("Animator")
  if not animator then
    animator = Instance.new("Animator")
    animator.Parent = humanoid
  end
  local animation = Instance.new("Animation")
  local ok, err = pcall(function()
    animation.AnimationId = animationId
    local track = animator:LoadAnimation(animation)
    local rest = motor.Transform
    track:Play(0)
    local deadline = os.clock() + 10
    while track.Length == 0 and os.clock() < deadline do task.wait(0.1) end
    local furthest = 0
    for _ = 1, 8 do
      if stepByHand then animator:StepAnimations(0.1) else task.wait(0.1) end
      furthest = math.max(furthest, degreesBetween(rest, motor.Transform))
    end
    result.length = track.Length
    result.isPlaying = track.IsPlaying
    result.timePosition = track.TimePosition
    result.rightShoulderDegrees = furthest
    track:Stop(0)
    track:Destroy()
  end)
  animation:Destroy()
  if not ok then result.error = tostring(err) end
  result.plays = ok and (result.length or 0) > 0 and (result.rightShoulderDegrees or 0) > 5
  return result
end

-- Tries each form of a temporary ID until one plays; returns the best and all tries.
local function probeCandidates(rig, candidates, stepByHand)
  local tried = {}
  for _, candidate in candidates do
    local result = probePlayback(rig, candidate, stepByHand)
    table.insert(tried, result)
    if result.plays then return result, tried end
  end
  return tried[#tried] or { skipped = "no temporary ID" }, tried
end
`;

const BUILD_DUMMY = `${PRELUDE}
local existing = workspace:FindFirstChild(SPIKE)
if existing then existing:Destroy() end
local folder = Instance.new("Folder")
folder.Name = SPIKE
folder.Parent = workspace

local studio = { version = version(), creatorType = game.CreatorType.Name, creatorId = game.CreatorId }
local ok, rig = pcall(function()
  return Players:CreateHumanoidModelFromDescription(
    Instance.new("HumanoidDescription"),
    Enum.HumanoidRigType.R15
  )
end)
if not ok then return { studio = studio, built = false, error = tostring(rig) } end
rig.Name = "SpikeDummy"
rig.Parent = folder
rig:PivotTo(CFrame.new(0, 500, 0))
-- Anchored so the copy a playtest makes does not fall; animation still moves the limbs.
rig.HumanoidRootPart.Anchored = true

local parts = {}
for _, descendant in rig:GetDescendants() do
  if descendant:IsA("BasePart") and not descendant:FindFirstAncestorOfClass("Accessory") then
    parts[descendant.Name] = { descendant.Size.X, descendant.Size.Y, descendant.Size.Z }
  end
end
-- Scanned again after a moment, in case the rig builds its joints late.
local joints = jointsOf(rig)
local immediateJoints = #joints
if immediateJoints == 0 then
  task.wait(1)
  joints = jointsOf(rig)
end
local kinds = {}
for _, joint in joints do kinds[joint.kind] = (kinds[joint.kind] or 0) + 1 end
local humanoid = rig:FindFirstChildOfClass("Humanoid")
local partCount = 0
for _ in parts do partCount += 1 end
return {
  studio = studio,
  built = true,
  rigType = humanoid and humanoid.RigType.Name or "none",
  hipHeight = humanoid and humanoid.HipHeight or 0,
  hasAnimator = humanoid ~= nil and humanoid:FindFirstChildOfClass("Animator") ~= nil,
  partCount = partCount,
  jointCount = #joints,
  immediateJointCount = immediateJoints,
  jointKinds = kinds,
  parts = parts,
  joints = joints,
}
`;

const EDIT_TEMP_PLAYBACK = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
local sequence = buildSequence(folder)
local candidates, attempts = register(sequence)
local rig = folder:FindFirstChild("SpikeDummy")
local playback, tried = { skipped = "no dummy" }, {}
if rig then playback, tried = probeCandidates(rig, candidates, true) end
return { registrations = attempts, candidates = candidates, playback = playback, tried = tried }
`;

const readBack = (assetId) => `${PRELUDE}
local ok, sequence = pcall(function()
  return game:GetService("KeyframeSequenceProvider"):GetKeyframeSequenceAsync("rbxassetid://${assetId}")
end)
if not ok then return { readable = false, error = tostring(sequence) } end
local keyframes, poses = 0, 0
for _, descendant in sequence:GetDescendants() do
  if descendant:IsA("Keyframe") then keyframes += 1 elseif descendant:IsA("Pose") then poses += 1 end
end
sequence:Destroy()
local rig = workspace:FindFirstChild(SPIKE) and workspace[SPIKE]:FindFirstChild("SpikeDummy")
local playback = rig and probePlayback(rig, "rbxassetid://${assetId}", true) or { skipped = "no dummy" }
return { readable = true, keyframes = keyframes, poses = poses, editPlayback = playback }
`;

const playtestProbe = (side, assetId) => `${PRELUDE}
local player = ${side === 'client' ? 'Players.LocalPlayer' : 'Players:GetPlayers()[1]'}
local deadline = os.clock() + 15
while not player and os.clock() < deadline do
  task.wait(0.2)
  player = Players:GetPlayers()[1]
end
if not player then return { error = "no player joined" } end
local character = player.Character or player.CharacterAdded:Wait()
local humanoid = character:WaitForChild("Humanoid", 15)
if not humanoid then return { error = "character has no Humanoid" } end
local sequence = buildSequence(nil)
local candidates, attempts = register(sequence)
local temporary, tried = probeCandidates(character, candidates, false)
local joint = jointFor(character, "RightUpperArm")
local result = {
  rigType = humanoid.RigType.Name,
  jointKind = joint and joint.ClassName or "none",
  registrations = attempts,
  candidates = candidates,
  temporary = temporary,
  tried = tried,
}
sequence:Destroy()
${assetId ? `result.published = probePlayback(character, "rbxassetid://${assetId}", false)` : ''}
return result
`;

const CLEANUP = `
local folder = workspace:FindFirstChild(${JSON.stringify(SPIKE_FOLDER)})
if folder then folder:Destroy() end
return workspace:FindFirstChild(${JSON.stringify(SPIKE_FOLDER)}) == nil
`;

// Runs a snippet and returns its decoded value, or { error } when the Luau
// itself failed. A tool that cannot be reached still throws.
async function luau(client, code, target = 'edit') {
  const result = await client.callTool('execute_luau', { code, target }, 180_000);
  if (result?.success !== true) {
    return { error: result?.error ?? result?.message ?? JSON.stringify(result) };
  }
  try {
    return JSON.parse(result.returnValue);
  } catch {
    return { error: `unexpected return value: ${result.returnValue}` };
  }
}

async function callToolFinding(client, name, args) {
  try {
    return await client.callTool(name, args);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function uploadSequence(client) {
  const exported = await callToolFinding(client, 'export_rbxm', {
    instance_paths: [SEQUENCE_PATH],
    output_path: rbxmPath,
  });
  if (exported.error) return { exported, accepted: false };

  const started = await callToolFinding(client, 'upload_asset', {
    action: 'upload',
    filePath: rbxmPath,
    assetType: 'Animation',
    displayName: 'Roqer animation spike',
    description: 'Test asset from tests/animation-spike.mjs. Safe to archive.',
  });
  const polls = [started];
  let latest = started;
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (!latest.error && latest.status === 'processing' && latest.operation_id && Date.now() < deadline) {
    await delay(UPLOAD_POLL_MS);
    latest = await callToolFinding(client, 'upload_asset', {
      action: 'status',
      operationId: latest.operation_id,
    });
    polls.push(latest);
  }
  return {
    exported,
    accepted: !latest.error && latest.status === 'complete' && Boolean(latest.asset_id),
    assetId: latest.asset_id ?? null,
    moderationState: latest.moderation_state ?? null,
    finalStatus: latest.error ? 'error' : latest.status,
    polls,
  };
}

// Moderation can hold a new animation back, so read-back is retried.
async function readBackPublished(client, assetId) {
  const attempts = [];
  const deadline = Date.now() + READ_BACK_TIMEOUT_MS;
  for (;;) {
    const attempt = await luau(client, readBack(assetId));
    attempts.push({ at: new Date().toISOString(), ...attempt });
    if (attempt.readable || Date.now() >= deadline) return { attempts, last: attempt };
    await delay(READ_BACK_POLL_MS);
  }
}

const answer = (yes, evidence) => ({ answer: yes ? 'yes' : 'no', evidence });

const report = {
  startedAt: new Date().toISOString(),
  upload: UPLOAD ? 'enabled' : 'skipped (set ROQER_SPIKE_UPLOAD=1 to upload a real test asset)',
  questions: {},
};

const passed = await runTest('animation spike', async ({ track }) => {
  const client = track(new McpClient('spike'));
  await client.start();
  await client.initialize();
  mkdirSync(reportDir, { recursive: true });

  let playtestStarted = false;
  let cleaned;
  try {
    const dummy = await luau(client, BUILD_DUMMY);
    assert(!dummy.error || dummy.built === false, `edit-mode setup ran (${dummy.error ?? 'ok'})`);
    report.studio = dummy.studio;
    report.restPose = dummy.built ? { parts: dummy.parts, joints: dummy.joints, hipHeight: dummy.hipHeight } : null;
    report.questions.dummyInEditMode = answer(dummy.built === true && dummy.jointCount >= 15, {
      built: dummy.built,
      error: dummy.error,
      rigType: dummy.rigType,
      partCount: dummy.partCount,
      jointCount: dummy.jointCount,
      immediateJointCount: dummy.immediateJointCount,
      jointKinds: dummy.jointKinds,
      hasAnimator: dummy.hasAnimator,
    });

    const editTemp = await luau(client, EDIT_TEMP_PLAYBACK);
    assert(!editTemp.error, `temporary ID probe ran in edit mode (${editTemp.error ?? 'ok'})`);

    let upload = { skipped: true };
    let published = null;
    if (UPLOAD) {
      upload = await uploadSequence(client);
      report.questions.openCloudAcceptsAnimation = answer(upload.accepted, upload);
      if (upload.assetId) {
        published = await readBackPublished(client, upload.assetId);
      }
    } else {
      report.questions.openCloudAcceptsAnimation = { answer: 'skipped', evidence: report.upload };
    }

    playtestStarted = true;
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    const assetId = published?.last?.readable ? upload.assetId : null;
    const clientProbe = await luau(client, playtestProbe('client', assetId), 'client-1');
    const serverProbe = await luau(client, playtestProbe('server', assetId), 'server');
    await safeStopPlaytest(client);
    playtestStarted = false;

    report.questions.temporaryIdsPlay = {
      answer: editTemp.playback?.plays && clientProbe.temporary?.plays ? 'yes'
        : editTemp.playback?.plays || clientProbe.temporary?.plays ? 'partly' : 'no',
      evidence: {
        editMode: editTemp,
        playtestClient: clientProbe.error ? clientProbe : {
          rigType: clientProbe.rigType, jointKind: clientProbe.jointKind, registrations: clientProbe.registrations,
          candidates: clientProbe.candidates, playback: clientProbe.temporary, tried: clientProbe.tried,
        },
        playtestServer: serverProbe.error ? serverProbe : {
          jointKind: serverProbe.jointKind, registrations: serverProbe.registrations,
          candidates: serverProbe.candidates, playback: serverProbe.temporary, tried: serverProbe.tried,
        },
      },
    };

    if (UPLOAD && upload.assetId) {
      report.questions.publishedReadBack = answer(
        Boolean(published?.last?.readable && published.last.editPlayback?.plays && clientProbe.published?.plays),
        { readBack: published, playtestClient: clientProbe.published, playtestServer: serverProbe.published },
      );
    } else {
      report.questions.publishedReadBack = { answer: 'skipped', evidence: UPLOAD ? 'upload did not produce an asset ID' : report.upload };
    }
  } finally {
    if (playtestStarted) await safeStopPlaytest(client);
    // Recorded rather than thrown here, so a cleanup failure cannot hide the
    // error that got us here; it is asserted below once the questions ran.
    try {
      cleaned = await luau(client, CLEANUP);
    } catch (error) {
      cleaned = { error: error instanceof Error ? error.message : String(error) };
    }
    rmSync(rbxmPath, { force: true });
    report.cleanup = cleaned === true ? 'spike folder removed' : cleaned;
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nReport: ${reportPath}`);
    for (const [question, finding] of Object.entries(report.questions)) {
      console.log(`  ${question}: ${finding.answer}`);
    }
    if (cleaned !== true) console.error(`  Cleanup failed: ${JSON.stringify(cleaned)}`);
  }
  assert(cleaned === true, 'spike folder removed from the place');
});

process.exit(passed ? 0 : 1);
