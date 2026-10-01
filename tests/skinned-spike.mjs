#!/usr/bin/env node
// Live spike for docs/creature-plan.md step 7. Before any skinned-creature work
// depends on it, it asks a real Studio what Roblox does with a skinned mesh
// uploaded through Open Cloud:
//
//   1. Does a Model upload keep the armature, the bones and the weights? How
//      does it arrive: what parts, what bones under what, named and nested how,
//      with what joints and controller?
//   2. How do a Blender bone's axes (+Y along the bone) arrive in a Bone?
//   3. How must a KeyframeSequence's poses be named and nested to drive bones,
//      in edit mode, and does the same sequence drive them on a playtest's
//      server?
//   4. Does EditableMesh hand over the bones and each vertex's weights?
//   5. What happens past Roblox's limits: a chain of 300 bones, and a mesh
//      whose every vertex is weighted to eight bones?
//
// All but one need an upload: with ROQER_SPIKE_UPLOAD=1 and an Open Cloud key
// the spike creates three Model assets. It writes the GLBs itself
// (tests/lib/skinned-glb.mjs): a snake, one mesh skinned to a chain of bones
// as Blender exports an armature. Without the upload it asks question 3 of
// Bone instances it makes itself under a plain Part.
//
// The answers are findings, not assertions: a "no" is a result to record in
// the plan, and the script still exits 0. It fails when a question could not
// be asked, or when it could not clean up after itself. The JSON report and
// the GLBs are written under tmp/skinned-spike/.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SNAKE_MESH, boneName, describeSkinnedImport, judgeBoneSequences, judgeSkinnedImport, skinnedSnake } from './lib/skinned-glb.mjs';
import {
  McpClient,
  REPO_ROOT,
  assert,
  runTest,
  safeStopPlaytest,
  startPlaytestAndWait,
} from './lib/mcp-client.mjs';

const SPIKE_FOLDER = '__RoqerSkinnedSpike';
const SPIKE_PATH = `game.Workspace.${SPIKE_FOLDER}`;
const UPLOAD = process.env.ROQER_SPIKE_UPLOAD === '1';
const UPLOAD_POLL_MS = 5_000;
const UPLOAD_TIMEOUT_MS = 180_000;
const MANY_BONES = 300;
const MANY_INFLUENCES = 8;
/** The bones the test sequences key, and the degrees each is turned. */
const KEYED = { [boneName(3)]: 40, [boneName(6)]: 25 };

const reportDir = path.join(REPO_ROOT, 'tmp', 'skinned-spike');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `report-${stamp}.json`);

// The place the runner opened, named on every Studio tool the test client does
// not route by itself, so a write never lands in another open place.
const PLACE = process.env.MCP_INSTANCE_ID ? { instance_id: process.env.MCP_INSTANCE_ID } : {};

const lua = (value) => (value === null || value === undefined ? 'nil' : JSON.stringify(value));

// Shared by every snippet: each execute_luau call is a fresh chunk.
const PRELUDE = `
local SPIKE = ${lua(SPIKE_FOLDER)}

-- A number fit for JSON: rounded, and never NaN or infinite, which would fail
-- the whole return value's encoding.
local function round(value, places)
  if typeof(value) ~= "number" then return nil end
  if value ~= value or value == math.huge or value == -math.huge then return tostring(value) end
  local factor = 10 ^ (places or 3)
  local rounded = math.floor(value * factor + 0.5) / factor
  if rounded == 0 then return 0 end
  return rounded
end

local function vec(v)
  return { round(v.X), round(v.Y), round(v.Z) }
end

-- A rotation's angle in degrees, from its matrix: 0 at rest.
local function degreesOf(cframe)
  local _, _, _, r00, _, _, _, r11, _, _, _, r22 = cframe:GetComponents()
  return math.deg(math.acos(math.clamp((r00 + r11 + r22 - 1) / 2, -1, 1)))
end

local function holderNamed(name)
  local folder = workspace:FindFirstChild(SPIKE)
  return folder and folder:FindFirstChild(name)
end

local function newPose(name, cframe, weight, parent)
  local pose = Instance.new("Pose")
  pose.Name = name
  pose.CFrame = cframe or CFrame.identity
  pose.Weight = weight
  pose.Parent = parent
  return pose
end

-- The bones the sequences key, each about an axis of its own.
local KEYS = {
  [${lua(boneName(3))}] = CFrame.Angles(0, 0, math.rad(${KEYED[boneName(3)]})),
  [${lua(boneName(6))}] = CFrame.Angles(math.rad(${KEYED[boneName(6)]}), 0, 0),
}
local CHAIN = {}
for index = 0, 7 do
  table.insert(CHAIN, string.format("Bone%03d", index))
end

-- A hold: the same pose keyed at 0 and 1 s, looping, so any moment shows it.
-- top names the weight-0 poses above the bones; nested hangs each bone's pose
-- from the pose of the bone before it, where flat puts the keyed bones' poses
-- side by side.
local function boneSequence(top, nested)
  local sequence = Instance.new("KeyframeSequence")
  sequence.Name = "SnakeHold"
  sequence.Loop = true
  sequence.Priority = Enum.AnimationPriority.Action
  for _, time in { 0, 1 } do
    local keyframe = Instance.new("Keyframe")
    keyframe.Time = time
    local parentPose = keyframe
    for _, poseName in top do
      parentPose = newPose(poseName, nil, 0, parentPose)
    end
    if nested then
      for _, bone in CHAIN do
        parentPose = newPose(bone, KEYS[bone], KEYS[bone] and 1 or 0, parentPose)
      end
    else
      for bone, cframe in KEYS do
        newPose(bone, cframe, 1, parentPose)
      end
    end
    keyframe.Parent = sequence
  end
  return sequence
end

-- What plays on the snake: its mesh, and an Animator, made here with an
-- AnimationController when the import came with none.
local function snakeRig(holder)
  local bone = holder:FindFirstChildWhichIsA("Bone", true)
  local mesh = bone and bone:FindFirstAncestorWhichIsA("BasePart") or holder:FindFirstChildWhichIsA("MeshPart", true)
  if not mesh then return nil, "no part with bones, and no MeshPart" end
  local made = {}
  local model = mesh:FindFirstAncestorWhichIsA("Model")
  if not model or not model:IsDescendantOf(holder) then
    model = Instance.new("Model")
    model.Name = "SnakeModel"
    model.Parent = holder
    mesh.Parent = model
    table.insert(made, "Model")
  end
  local animator = holder:FindFirstChildWhichIsA("Animator", true)
  if not animator then
    local controller = holder:FindFirstChildWhichIsA("Humanoid", true) or holder:FindFirstChildWhichIsA("AnimationController", true)
    if not controller then
      controller = Instance.new("AnimationController")
      controller.Parent = model
      table.insert(made, "AnimationController")
    end
    animator = Instance.new("Animator")
    animator.Parent = controller
    table.insert(made, "Animator")
  end
  return { mesh = mesh, model = model, animator = animator, made = made }
end

local function readBones(holder)
  local bones = {}
  for _, descendant in holder:GetDescendants() do
    if descendant:IsA("Bone") then bones[descendant.Name] = round(degreesOf(descendant.Transform), 2) end
  end
  return bones
end

local function resetBones(holder)
  for _, descendant in holder:GetDescendants() do
    if descendant:IsA("Bone") then descendant.Transform = CFrame.identity end
  end
end

-- Registers a sequence, plays it on the snake and reads each bone's turn. In
-- edit mode nothing advances an animation, so it is stepped by hand; in a
-- playtest it is given a moment to run.
local function probe(holder, rig, sequence, stepped)
  local registered, id = pcall(function()
    return game:GetService("AnimationClipProvider"):RegisterAnimationClip(sequence)
  end)
  if not registered then return { loaded = false, error = tostring(id) } end
  local ok, result = pcall(function()
    local animation = Instance.new("Animation")
    animation.AnimationId = tostring(id)
    local track = rig.animator:LoadAnimation(animation)
    track:Play(0)
    local deadline = os.clock() + 5
    while track.Length == 0 and os.clock() < deadline do task.wait(0.05) end
    if stepped then
      rig.animator:StepAnimations(0)
      rig.animator:StepAnimations(0.5)
    else
      task.wait(0.4)
    end
    local reading = { loaded = track.Length > 0, bones = readBones(holder) }
    pcall(function() track:Stop(0) end)
    pcall(function() track:Destroy() end)
    animation:Destroy()
    if not stepped then task.wait(0.1) end
    resetBones(holder)
    return reading
  end)
  if not ok then return { loaded = false, error = tostring(result) } end
  return result
end

-- Every shape of sequence the spike tries, by name.
local function shapesFor(rig)
  local mesh = rig.mesh.Name
  local shapes = {
    { "nested under HumanoidRootPart and the mesh", { "HumanoidRootPart", mesh }, true },
    { "nested under the mesh", { mesh }, true },
    { "nested, bones only", {}, true },
    { "flat under the mesh", { mesh }, false },
    { "flat, bones only", {}, false },
  }
  -- An importer's root, when the import came with one.
  local root = rig.model:FindFirstChild("RootPart")
  if root then
    table.insert(shapes, 1, { "nested under RootPart and the mesh", { "RootPart", mesh }, true })
  end
  return shapes
end

local function probeShapes(holder, stepped)
  local rig, why = snakeRig(holder)
  if not rig then return { error = why } end
  local results = {}
  for _, shape in shapesFor(rig) do
    local sequence = boneSequence(shape[2], shape[3])
    results[shape[1]] = probe(holder, rig, sequence, stepped)
    sequence:Destroy()
  end
  return { made = rig.made, mesh = rig.mesh.Name, results = results }
end
`;

const EDIT_SETUP = `${PRELUDE}
local old = workspace:FindFirstChild(SPIKE)
if old then old:Destroy() end
local folder = Instance.new("Folder")
folder.Name = SPIKE
folder.Parent = workspace
for _, name in { "Made", "Base", "ManyBones", "ManyInfluences" } do
  local holder = Instance.new("Folder")
  holder.Name = name
  holder.Parent = folder
end

-- Bones made by hand under a plain Part, as a skinned import's are expected to
-- nest: no skin, but a Bone's Transform is what an Animator drives either way,
-- so the question of a sequence's shape can be asked without an upload.
local model = Instance.new("Model")
model.Name = "MadeSnake"
local part = Instance.new("Part")
part.Name = ${lua(SNAKE_MESH)}
part.Size = Vector3.new(0.8, 0.8, 8)
part.CFrame = CFrame.new(-20, 300, 40)
part.Anchored = true
part.Parent = model
local above = part
for index, name in CHAIN do
  local bone = Instance.new("Bone")
  bone.Name = name
  bone.CFrame = index == 1 and CFrame.new(0, 0, 4) or CFrame.new(0, 0, -1)
  bone.Parent = above
  above = bone
end
model.PrimaryPart = part
local controller = Instance.new("AnimationController")
controller.Parent = model
Instance.new("Animator").Parent = controller
model.Parent = folder.Made
return { studio = { version = version(), creatorType = game.CreatorType.Name } }
`;

// What an insert put in the holder, as judgeSkinnedImport reads it.
const readImport = (holder) => `${PRELUDE}
local holder = holderNamed(${lua(holder)})
if not holder then return { error = ${lua(`no ${holder}`)} } end
local top = {}
for _, child in holder:GetChildren() do
  if #top < 20 then table.insert(top, { class = child.ClassName, name = child.Name }) end
end
local meshParts, joints, controllers, listed, others = {}, {}, {}, {}, {}
local count, depth = 0, 0
for _, descendant in holder:GetDescendants() do
  local parent = descendant.Parent
  if descendant:IsA("Bone") then
    count += 1
    local nesting, above = 1, parent
    while above and above:IsA("Bone") do
      nesting += 1
      above = above.Parent
    end
    depth = math.max(depth, nesting)
    if #listed < 16 then
      table.insert(listed, {
        name = descendant.Name,
        parent = parent.Name,
        parentClass = parent.ClassName,
        at = vec(descendant.WorldPosition),
        offset = vec(descendant.Position),
        up = vec(descendant.WorldCFrame.UpVector),
        right = vec(descendant.WorldCFrame.RightVector),
      })
    end
  elseif descendant:IsA("BasePart") then
    local entry = {
      class = descendant.ClassName, name = descendant.Name, parent = parent.Name, parentClass = parent.ClassName,
      size = vec(descendant.Size), position = vec(descendant.Position), anchored = descendant.Anchored,
    }
    if descendant:IsA("MeshPart") then
      local ok, skinned = pcall(function() return descendant.HasSkinnedMesh end)
      if ok then entry.skinned = skinned else entry.skinnedError = tostring(skinned) end
      entry.meshId = descendant.MeshId
      if #meshParts < 8 then table.insert(meshParts, entry) end
    elseif #others < 8 then
      table.insert(others, entry)
    end
  elseif descendant:IsA("JointInstance") or descendant:IsA("WeldConstraint") then
    if #joints < 20 then
      local ok, part0, part1 = pcall(function() return descendant.Part0, descendant.Part1 end)
      table.insert(joints, { class = descendant.ClassName, name = descendant.Name, part0 = ok and part0 and part0.Name or nil, part1 = ok and part1 and part1.Name or nil })
    end
  elseif descendant:IsA("Humanoid") or descendant:IsA("AnimationController") then
    table.insert(controllers, descendant.ClassName)
  elseif #others < 8 then
    table.insert(others, { class = descendant.ClassName, name = descendant.Name, parent = parent.Name })
  end
end
return {
  top = top, meshParts = meshParts, joints = joints, controllers = controllers, others = others,
  bones = { count = count, depth = depth, listed = listed },
}
`;

// What EditableMesh says of the mesh's skin. Each call is tried on its own,
// since which of them exist is part of the question.
const readEditableSkin = (holder) => `${PRELUDE}
local holder = holderNamed(${lua(holder)})
local part = holder and holder:FindFirstChildWhichIsA("MeshPart", true)
if not part then return { error = ${lua(`no MeshPart in ${holder}`)} } end
local opened, mesh = pcall(function()
  return game:GetService("AssetService"):CreateEditableMeshAsync(Content.fromUri(part.MeshId))
end)
if not opened or not mesh then return { readable = false, why = tostring(mesh) } end
local out = { readable = true, calls = {} }
local function try(name, call)
  local ok, value = pcall(call)
  out.calls[name] = ok and "works" or tostring(value)
  if ok then return value end
  return nil
end
local vertices = try("GetVertices", function() return mesh:GetVertices() end) or {}
out.vertices = #vertices
local bones = try("GetBones", function() return mesh:GetBones() end)
if bones then
  out.bones = #bones
  out.boneNames = {}
  for index = 1, math.min(#bones, 8) do
    local name = try("GetBoneName", function() return mesh:GetBoneName(bones[index]) end)
    table.insert(out.boneNames, name or "?")
  end
  if bones[1] then
    local cframe = try("GetBoneCFrame", function() return mesh:GetBoneCFrame(bones[1]) end)
    if typeof(cframe) == "CFrame" then out.firstBoneAt = vec(cframe.Position) end
  end
end
local most, least, lowSum, highSum = 0, math.huge, math.huge, -math.huge
local read = 0
for _, vertex in vertices do
  local onVertex = try("GetVertexBones", function() return mesh:GetVertexBones(vertex) end)
  local weights = try("GetVertexBoneWeights", function() return mesh:GetVertexBoneWeights(vertex) end)
  if not onVertex or not weights then break end
  read += 1
  local sum, weighted = 0, 0
  for _, weight in weights do
    sum += weight
    if weight > 0 then weighted += 1 end
  end
  most = math.max(most, weighted)
  least = math.min(least, weighted)
  lowSum = math.min(lowSum, sum)
  highSum = math.max(highSum, sum)
  if read == 1 then
    out.firstVertex = { bones = #onVertex, weights = {} }
    for index = 1, math.min(#weights, 8) do
      table.insert(out.firstVertex.weights, round(weights[index]))
    end
  end
end
if read > 0 then
  out.weights = { verticesRead = read, mostInfluences = most, leastInfluences = least, lowestSum = round(lowSum), highestSum = round(highSum) }
end
pcall(function() mesh:Destroy() end)
return out
`;

const editShapes = (holder) => `${PRELUDE}
local holder = holderNamed(${lua(holder)})
if not holder then return { error = ${lua(`no ${holder}`)} } end
return probeShapes(holder, true)
`;

// Before the playtest: every snake held in the air, and the two that only
// answered a limit taken out of the way.
const EDIT_HOLD = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
if not folder then return { error = "no spike folder" } end
for _, name in { "ManyBones", "ManyInfluences" } do
  local holder = folder:FindFirstChild(name)
  if holder then holder:Destroy() end
end
for _, descendant in folder:GetDescendants() do
  if descendant:IsA("BasePart") then descendant.Anchored = true end
  if descendant:IsA("Model") then
    pcall(function() descendant.ModelStreamingMode = Enum.ModelStreamingMode.Persistent end)
  end
end
return true
`;

const playShapes = (holder) => `${PRELUDE}
local holder = holderNamed(${lua(holder)})
if not holder then return { error = ${lua(`${holder} did not reach the playtest`)} } end
return probeShapes(holder, false)
`;

const CLEANUP = `
local SPIKE = ${lua(SPIKE_FOLDER)}
local folder = workspace:FindFirstChild(SPIKE)
if folder then folder:Destroy() end
return { spikeFolderRemoved = workspace:FindFirstChild(SPIKE) == nil }
`;

const notAsked = { answer: 'not asked', evidence: 'the spike stopped before this question' };
const skipped = { answer: 'skipped', evidence: 'set ROQER_SPIKE_UPLOAD=1, with an Open Cloud key, to upload three test models' };
const report = {
  startedAt: new Date().toISOString(),
  upload: UPLOAD ? 'enabled' : skipped.evidence,
  // In question order; each is replaced by its finding as it is asked.
  questions: {
    madeBonesSequenceShapes: notAsked,
    madeBonesServerPlayback: notAsked,
    skinnedUpload: notAsked,
    boneAxes: notAsked,
    sequenceShapes: notAsked,
    serverPlayback: notAsked,
    editableMeshSkin: notAsked,
    boneLimit: notAsked,
    influenceLimit: notAsked,
  },
};

const UPLOAD_QUESTIONS = ['skinnedUpload', 'boneAxes', 'sequenceShapes', 'serverPlayback', 'editableMeshSkin', 'boneLimit', 'influenceLimit'];

// Every step that could not ask its question, which fails the run once the
// report is written.
const problems = [];

/** Calls a tool. A failure is a problem unless `finding`, where the failure is itself the answer. */
async function tool(client, step, name, args, timeoutMs = 30_000, finding = false) {
  try {
    const result = await client.callTool(name, args, timeoutMs);
    if (result?.error && !finding) problems.push({ step, error: String(result.error) });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!finding) problems.push({ step, error: message });
    return { error: message };
  }
}

// Runs a snippet and returns its decoded value, or { error } when the Luau
// failed, or returned an error of its own at the top level.
async function luau(client, step, code, target = 'edit') {
  const result = await tool(client, step, 'execute_luau', { code, target }, 90_000);
  if (result?.error) return { error: String(result.error) };
  if (result?.success !== true) {
    const error = result?.message ?? JSON.stringify(result);
    problems.push({ step, error });
    return { error };
  }
  let value;
  try {
    value = JSON.parse(result.returnValue);
  } catch {
    const error = `unexpected return value: ${String(result.returnValue).slice(0, 200)}`;
    problems.push({ step, error });
    return { error };
  }
  if (typeof value?.error === 'string') problems.push({ step, error: value.error });
  return value;
}

async function uploadModel(client, step, filePath, displayName, finding = false) {
  const started = await tool(client, step, 'upload_asset', {
    action: 'upload',
    filePath,
    assetType: 'Model',
    displayName,
    description: 'Test asset from tests/skinned-spike.mjs. Safe to archive.',
    ...PLACE,
  }, 120_000, finding);
  const polls = [started];
  let latest = started;
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (!latest.error && latest.status === 'processing' && latest.operation_id && Date.now() < deadline) {
    await delay(UPLOAD_POLL_MS);
    latest = await tool(client, `${step} (status)`, 'upload_asset', { action: 'status', operationId: latest.operation_id, ...PLACE }, 30_000, finding);
    polls.push(latest);
  }
  const assetId = !latest.error && latest.status === 'complete' && latest.asset_id ? String(latest.asset_id) : null;
  if (assetId === null && !latest.error && !finding) problems.push({ step, error: `the upload ended ${latest.status ?? 'without a status'}` });
  return { assetId, moderationState: latest.moderation_state ?? null, finalStatus: latest.error ? 'error' : latest.status, polls };
}

/** Writes a snake, uploads it and inserts it into its holder, and reads what arrived. */
async function importSnake(client, holder, label, options, finding) {
  const snake = skinnedSnake(options);
  const glbPath = path.join(reportDir, `snake-${label}-${stamp}.glb`);
  writeFileSync(glbPath, snake.glb);
  const asked = { glb: glbPath, modelled: { bones: snake.bones.length, vertices: snake.vertices, influences: snake.influences } };
  asked.upload = await uploadModel(client, `uploading the ${label} snake`, glbPath, `Roqer skinned spike: ${label}`, finding);
  if (!asked.upload.assetId) return { snake, asked };
  asked.insert = await tool(client, `inserting the ${label} snake`, 'insert_asset', {
    assetId: Number(asked.upload.assetId), parentPath: `${SPIKE_PATH}.${holder}`, position: { x: 0, y: 300, z: 40 }, ...PLACE,
  }, 60_000, finding);
  asked.readback = await luau(client, `reading the ${label} snake`, readImport(holder));
  return { snake, asked, finding: asked.readback?.error ? undefined : judgeSkinnedImport(asked.readback, snake) };
}

const couldNotAsk = (evidence) => ({ answer: 'could not be asked', evidence });

function judgeEditable(skin, modelled) {
  if (!skin || skin.error) return couldNotAsk(skin);
  if (skin.readable !== true) return { answer: 'no: the mesh could not be opened', evidence: skin };
  const bones = typeof skin.bones === 'number' ? `${skin.bones} bones` : 'no bones';
  const weights = skin.weights
    ? `each vertex's weights, ${skin.weights.leastInfluences} to ${skin.weights.mostInfluences} bones a vertex`
    : 'no weights';
  return {
    answer: skin.weights && typeof skin.bones === 'number' ? `yes: ${bones} and ${weights}` : `partly: ${bones}, ${weights}`,
    evidence: { modelled, skin },
  };
}

/** A limit's answer: whether the upload went through, and how much of what was modelled arrived. */
function judgeLimit(imported, what, skin) {
  const { asked, finding } = imported;
  if (!asked.upload.assetId) {
    const last = asked.upload.polls.at(-1);
    return { answer: `the upload was refused: ${String(last?.error ?? last?.status ?? 'no status').slice(0, 200)}`, evidence: asked };
  }
  if (!finding) return couldNotAsk(asked);
  const arrived = what === 'bones'
    ? `${finding.bonesArrived} of ${finding.bonesModelled} bones arrived, nested ${finding.deepestNesting} deep`
    : skin?.weights
      ? `EditableMesh reads up to ${skin.weights.mostInfluences} bones a vertex of the ${asked.modelled.influences} modelled, their weights summing ${skin.weights.lowestSum} to ${skin.weights.highestSum}`
      : 'the mesh arrived, and its weights could not be read back';
  return {
    answer: `the upload went through${finding.skinned ? ', skinned' : ''}; ${arrived}`,
    evidence: { finding, ...(skin ? { skin } : {}), asked },
  };
}

const passed = await runTest('skinned spike', async ({ track }) => {
  const client = track(new McpClient('spike'));
  await client.start();
  await client.initialize();
  mkdirSync(reportDir, { recursive: true });

  let playtestStarted = false;
  let cleaned;
  try {
    const setup = await luau(client, 'setting up edit mode', EDIT_SETUP);
    assert(!setup.error, `edit-mode setup ran (${setup.error ?? 'ok'})`);
    report.studio = setup.studio;

    // Question 3 on bones made by hand, which needs no upload.
    const madeShapes = await luau(client, 'playing each shape of sequence on made bones', editShapes('Made'));
    report.questions.madeBonesSequenceShapes = madeShapes.error ? couldNotAsk(madeShapes)
      : { ...judgeBoneSequences(madeShapes.results, KEYED), evidence: madeShapes };

    let base;
    if (!UPLOAD) {
      for (const question of UPLOAD_QUESTIONS) report.questions[question] = skipped;
    } else {
      // Questions 1 and 2: the snake as Blender would export it.
      base = await importSnake(client, 'Base', 'base', {}, false);
      if (!base.finding) {
        for (const question of ['skinnedUpload', 'boneAxes', 'sequenceShapes', 'serverPlayback', 'editableMeshSkin']) {
          report.questions[question] = couldNotAsk(base.asked);
        }
      } else {
        report.questions.skinnedUpload = { answer: describeSkinnedImport(base.finding), evidence: { finding: base.finding, asked: base.asked } };
        report.questions.boneAxes = {
          answer: base.finding.axes,
          evidence: { rootBoneUp: base.finding.rootBoneUp ?? null, rootBoneRight: base.finding.rootBoneRight ?? null, positions: base.finding.positions },
        };

        // Question 4, before anything is added to the model.
        const skin = await luau(client, 'reading the skin through EditableMesh', readEditableSkin('Base'));
        report.questions.editableMeshSkin = judgeEditable(skin, base.asked.modelled);

        // Question 3 in edit mode.
        const shapes = await luau(client, 'playing each shape of sequence in edit mode', editShapes('Base'));
        report.questions.sequenceShapes = shapes.error ? couldNotAsk(shapes)
          : { ...judgeBoneSequences(shapes.results, KEYED), evidence: shapes };
      }

      // Question 5: past the limits. A refused upload is an answer here.
      const manyBones = await importSnake(client, 'ManyBones', 'many-bones', { bones: MANY_BONES }, true);
      report.questions.boneLimit = judgeLimit(manyBones, 'bones');
      const manyInfluences = await importSnake(client, 'ManyInfluences', 'many-influences', { influences: MANY_INFLUENCES }, true);
      const influenceSkin = manyInfluences.finding
        ? await luau(client, 'reading the eight-influence skin', readEditableSkin('ManyInfluences'))
        : undefined;
      report.questions.influenceLimit = judgeLimit(manyInfluences, 'influences', influenceSkin);
    }

    // Question 3 on a playtest's server.
    report.questions.madeBonesServerPlayback = couldNotAsk('the playtest did not run');
    if (base?.finding) report.questions.serverPlayback = couldNotAsk('the playtest did not run');
    const held = await luau(client, 'holding the snakes for the playtest', EDIT_HOLD);
    if (held === true) {
      playtestStarted = true;
      await startPlaytestAndWait(client, { timeoutSec: 60 });
      const servedMade = await luau(client, 'playing each shape of sequence on made bones on the server', playShapes('Made'), 'server');
      const served = base?.finding
        ? await luau(client, 'playing each shape of sequence on the server', playShapes('Base'), 'server')
        : undefined;
      await safeStopPlaytest(client);
      playtestStarted = false;
      report.questions.madeBonesServerPlayback = servedMade.error ? couldNotAsk(servedMade)
        : { ...judgeBoneSequences(servedMade.results, KEYED), evidence: servedMade };
      if (served) {
        report.questions.serverPlayback = served.error ? couldNotAsk(served)
          : { ...judgeBoneSequences(served.results, KEYED), evidence: served };
      }
    }
  } finally {
    if (playtestStarted) await safeStopPlaytest(client);
    // Recorded rather than thrown here, so a cleanup failure cannot hide the
    // error that got us here; it is asserted below once the questions ran.
    cleaned = await luau(client, 'cleaning up', CLEANUP);
    report.cleanup = cleaned?.spikeFolderRemoved === true ? 'spike folder removed' : cleaned;
    report.problems = problems;
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nReport: ${reportPath}`);
    for (const [question, finding] of Object.entries(report.questions)) {
      console.log(`  ${question}: ${finding.answer}`);
    }
    for (const problem of problems) console.error(`  Could not ask (${problem.step}): ${problem.error}`);
  }
  assert(cleaned?.spikeFolderRemoved === true, 'spike folder removed from the place');
  assert(problems.length === 0, 'every question could be asked');
});

process.exit(passed ? 0 : 1);
