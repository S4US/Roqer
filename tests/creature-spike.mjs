#!/usr/bin/env node
// Live spike for docs/creature-plan.md step 1. Before any creature work depends
// on it, it asks a real Studio what it does with a rig that is not a character:
//
//   1. Does a sequence keyed by part names drive Motor6Ds made on a model that
//      is not a character, under a Humanoid and under an AnimationController,
//      in edit mode and in a playtest? Does a client see what the server plays,
//      and can a client play on the model itself?
//   2. Under an AnimationController, must the top pose be named
//      HumanoidRootPart, or does the root part's own name work?
//   3. How deep a chain, and how many joints in one keyframe, does it drive?
//   4. Does a copy of a model preview as the stock dummy does?
//   5. Does an NPC made with CreateHumanoidModelFromDescription carry an
//      Animate script, and does it run outside a player's character?
//   6. Does Humanoid:MoveTo walk a four-legged Humanoid rig steadily, and does
//      Running report its speed?
//   7. Only with ROQER_SPIKE_UPLOAD=1, since it creates assets: an articulated
//      creature uploaded as one GLB, each piece a node with its origin at its
//      joint. Does it arrive as one MeshPart per piece, named, sized, placed,
//      pivoted and nested as modelled? Does insert_asset's position keep the
//      layout? Can EditableMesh read the meshes back? The dog's test animation
//      is published too, so question 1 can see a published animation replicate.
//   8. Only with ROQER_SPIKE_GENERATE=1: does generate_model, given
//      schema_groups, return a creature's pieces as separate, named parts?
//
// The answers are findings, not assertions: a "no" is a result to record in the
// plan, and the script still exits 0. It fails when a question could not be
// asked, or when it could not clean up after itself. The JSON report, and the
// GLB question 7 uploads, are written under tmp/creature-spike/.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { articulatedCreatureGlb, describeImport, judgeImport } from './lib/creature-glb.mjs';
import {
  McpClient,
  REPO_ROOT,
  assert,
  runTest,
  safeStopPlaytest,
  startPlaytestAndWait,
} from './lib/mcp-client.mjs';

const SPIKE_FOLDER = '__RoqerCreatureSpike';
const SPIKE_PATH = `game.Workspace.${SPIKE_FOLDER}`;
const UPLOAD = process.env.ROQER_SPIKE_UPLOAD === '1';
const GENERATE = process.env.ROQER_SPIKE_GENERATE === '1';
const UPLOAD_POLL_MS = 5_000;
const UPLOAD_TIMEOUT_MS = 180_000;
const CHAIN_LENGTHS = [24, 64, 128];
const STAR_SIZES = [48, 128, 256];
const MOVE_SPEEDS = [8, 16];
const GENERATED_GROUPS = ['Body', 'Head', 'FrontLeftLeg', 'FrontRightLeg', 'HindLeftLeg', 'HindRightLeg', 'Tail'];

const reportDir = path.join(REPO_ROOT, 'tmp', 'creature-spike');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `report-${stamp}.json`);
const glbPath = path.join(reportDir, `articulated-creature-${stamp}.glb`);
const rbxmPath = path.join(reportDir, `dog-hold-${stamp}.rbxm`);

// The place the runner opened, named on every Studio tool the test client does
// not route by itself, so a write never lands in another open place.
const PLACE = process.env.MCP_INSTANCE_ID ? { instance_id: process.env.MCP_INSTANCE_ID } : {};

/** A JavaScript string or number as a Luau literal, or nil. */
const lua = (value) => (value === null || value === undefined ? 'nil' : JSON.stringify(value));
const luaList = (values) => `{ ${values.map(lua).join(', ')} }`;

// Shared by every snippet: each execute_luau call is a fresh chunk.
const PRELUDE = `
local Players = game:GetService("Players")
local SPIKE = ${lua(SPIKE_FOLDER)}
-- What the playtest's client must see stands 300 studs above the spawn, near
-- enough to stream, and every model is also marked to stream at any distance.
local BASE = Vector3.new(0, 300, 40)

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

local function tiltOf(part)
  return math.deg(math.acos(math.clamp(part.CFrame.UpVector.Y, -1, 1)))
end

local function newPart(name, size, cframe, parent, props)
  local part = Instance.new("Part")
  part.Name = name
  part.Size = size
  part.CFrame = cframe
  part.Anchored = false
  part.CanCollide = false
  part.CanTouch = false
  part.Massless = true
  part.TopSurface = Enum.SurfaceType.Smooth
  part.BottomSurface = Enum.SurfaceType.Smooth
  if props then
    for key, value in props do
      part[key] = value
    end
  end
  part.Parent = parent
  return part
end

-- A Motor6D whose frame sits at the pivot, lined up with the world's axes, as
-- the plan's rig action builds one.
local function newMotor(name, part0, part1, pivot)
  local motor = Instance.new("Motor6D")
  motor.Name = name
  local frame = CFrame.new(pivot)
  motor.C0 = part0.CFrame:Inverse() * frame
  motor.C1 = part1.CFrame:Inverse() * frame
  motor.Part0 = part0
  motor.Part1 = part1
  motor.Parent = part0
  return motor
end

local function addController(model, kind)
  local animator = Instance.new("Animator")
  if kind == "Humanoid" then
    local humanoid = Instance.new("Humanoid")
    humanoid.RigType = Enum.HumanoidRigType.R15
    -- The root's bottom stands this far above the ground: the legs' length.
    humanoid.HipHeight = 1.6
    -- A four-legged body has no R15 neck for the Humanoid to watch, and
    -- without this it may die at once.
    humanoid.RequiresNeck = false
    humanoid.BreakJointsOnDeath = false
    humanoid.Parent = model
    animator.Parent = humanoid
  else
    local controller = Instance.new("AnimationController")
    controller.Parent = model
    animator.Parent = controller
  end
  return animator
end

local LEGS = {
  FrontLeft = Vector3.new(-0.7, -1.4, -1.4),
  FrontRight = Vector3.new(0.7, -1.4, -1.4),
  HindLeft = Vector3.new(-0.7, -1.4, 1.4),
  HindRight = Vector3.new(0.7, -1.4, 1.4),
}

-- A four-legged dog: a hidden root box over the body, a body, a head, four
-- legs and a tail, each joined by a Motor6D at its pivot. It faces -Z with its
-- right at +X, as a character does, and its body's centre stands 2.2 studs
-- above the ground its feet touch.
local function buildDog(name, parent, at, controller, rootName, anchored)
  local model = Instance.new("Model")
  model.Name = name
  local frame = CFrame.new(at)
  local root = newPart(rootName or "HumanoidRootPart", Vector3.new(2, 1.2, 4), frame, model, {
    Transparency = 1, Massless = false, CanCollide = true, Anchored = anchored == true,
  })
  local body = newPart("Body", Vector3.new(2, 1.2, 4), frame, model)
  newMotor("Root", root, body, at)
  local head = newPart("Head", Vector3.new(1.2, 1.2, 1.4), frame * CFrame.new(0, 0.8, -2.6), model)
  newMotor("Neck", body, head, (frame * CFrame.new(0, 0.4, -2)).Position)
  for legName, offset in LEGS do
    local leg = newPart(legName, Vector3.new(0.5, 1.6, 0.5), frame * CFrame.new(offset), model)
    newMotor(legName, body, leg, (frame * CFrame.new(offset.X, -0.6, offset.Z)).Position)
  end
  local tail = newPart("Tail", Vector3.new(0.3, 0.3, 1.6), frame * CFrame.new(0, 0.3, 2.7), model)
  newMotor("Tail", body, tail, (frame * CFrame.new(0, 0.3, 1.9)).Position)
  model.PrimaryPart = root
  local animator = addController(model, controller)
  pcall(function()
    model.ModelStreamingMode = Enum.ModelStreamingMode.Persistent
  end)
  model.Parent = parent
  return model, animator
end

local function newPose(name, cframe, weight, parent)
  local pose = Instance.new("Pose")
  pose.Name = name
  pose.CFrame = cframe or CFrame.identity
  pose.Weight = weight
  pose.Parent = parent
  return pose
end

-- A hold: the same pose keyed at 0 and 1 s, looping, so any moment shows it.
-- chain names the weight-0 poses from the top down to the parent of the keyed
-- ones; keys maps a part's name to its pose.
local function holdSequence(name, chain, keys)
  local sequence = Instance.new("KeyframeSequence")
  sequence.Name = name
  sequence.Loop = true
  sequence.Priority = Enum.AnimationPriority.Action
  for _, time in { 0, 1 } do
    local keyframe = Instance.new("Keyframe")
    keyframe.Time = time
    local parentPose = keyframe
    for _, poseName in chain do
      parentPose = newPose(poseName, nil, 0, parentPose)
    end
    for partName, cframe in keys do
      newPose(partName, cframe, 1, parentPose)
    end
    keyframe.Parent = sequence
  end
  return sequence
end

-- The dog's hold: its head raised 40 degrees about X, its front left leg swung
-- -30 about X, its tail turned 35 about Y; every other joint at rest.
local DOG_KEYS = {
  Head = CFrame.Angles(math.rad(40), 0, 0),
  FrontLeft = CFrame.Angles(math.rad(-30), 0, 0),
  Tail = CFrame.Angles(0, math.rad(35), 0),
}
local DOG_EXPECTED = { Body = 0, Head = 40, FrontLeft = 30, FrontRight = 0, HindLeft = 0, HindRight = 0, Tail = 35 }

local function dogHold(chain)
  return holdSequence("DogHold", chain or { "HumanoidRootPart", "Body" }, DOG_KEYS)
end

local function register(sequence)
  local ok, id = pcall(function()
    return game:GetService("AnimationClipProvider"):RegisterAnimationClip(sequence)
  end)
  if not ok then return nil, tostring(id) end
  return tostring(id), nil
end

-- Each Motor6D's turn from rest in degrees, by the part it moves.
local function readJoints(model)
  local joints = {}
  for _, descendant in model:GetDescendants() do
    if descendant:IsA("Motor6D") and descendant.Part1 then
      joints[descendant.Part1.Name] = round(degreesOf(descendant.Transform), 2)
    end
  end
  return joints
end

-- A stopped track leaves its last pose on the joints, so each probe starts over from rest.
local function resetJoints(model)
  for _, descendant in model:GetDescendants() do
    if descendant:IsA("Motor6D") then descendant.Transform = CFrame.identity end
  end
end

local function compare(joints, expected)
  local worst, where = 0, nil
  for partName, degrees in expected do
    local measured = joints[partName]
    if typeof(measured) ~= "number" then return { matches = false, missing = partName } end
    local off = math.abs(measured - degrees)
    if off > worst then worst, where = off, partName end
  end
  return { matches = worst <= 1.5, worstDegrees = round(worst, 2), worstJoint = where }
end

-- Loads and plays an animation, waiting for it to load. In edit mode nothing
-- advances it, so there it is stepped by hand.
local function play(animator, id, stepSeconds, loadSeconds)
  local animation = Instance.new("Animation")
  animation.AnimationId = id
  local track = animator:LoadAnimation(animation)
  track:Play(0)
  local deadline = os.clock() + (loadSeconds or 5)
  while track.Length == 0 and os.clock() < deadline do task.wait(0.05) end
  if stepSeconds then
    animator:StepAnimations(0)
    animator:StepAnimations(stepSeconds)
  end
  return track, animation
end

local function stop(track, animation)
  pcall(function() track:Stop(0) end)
  pcall(function() track:Destroy() end)
  pcall(function() animation:Destroy() end)
end

-- Plays a sequence on a model in edit mode, half a second in, and reports how
-- its joints turned against what was expected.
local function probeEdit(model, animator, sequence, expected)
  local id, err = register(sequence)
  if not id then return { loaded = false, error = err } end
  local ok, result = pcall(function()
    local track, animation = play(animator, id, 0.5)
    local loaded = track.Length > 0
    local joints = readJoints(model)
    stop(track, animation)
    resetJoints(model)
    return { loaded = loaded, joints = joints, check = compare(joints, expected) }
  end)
  if not ok then return { loaded = false, error = tostring(result) } end
  return result
end
`;

const EDIT_SETUP = `${PRELUDE}
local storage = game:GetService("ServerStorage")
for _, container in { workspace, storage } do
  local old = container:FindFirstChild(SPIKE)
  if old then old:Destroy() end
end
local folder = Instance.new("Folder")
folder.Name = SPIKE
folder.Parent = workspace
local store = Instance.new("Folder")
store.Name = SPIKE
store.Parent = storage

buildDog("DogHumanoid", folder, BASE + Vector3.new(-12, 0, 0), "Humanoid", nil, true)
buildDog("DogController", folder, BASE, "AnimationController", nil, true)
buildDog("DogRootNamed", folder, BASE + Vector3.new(12, 0, 0), "AnimationController", "Root", true)

-- The model question 4 copies, kept outside Workspace as a template is, with
-- one part that cannot be copied: a collar welded to the head.
local template = buildDog("DogTemplate", store, BASE + Vector3.new(24, 0, 0), "AnimationController", nil, true)
local templateHead = template:FindFirstChild("Head")
local collar = newPart("Collar", Vector3.new(1.3, 0.3, 1.5), templateHead.CFrame * CFrame.new(0, -0.5, 0), template)
collar.Archivable = false
local weld = Instance.new("WeldConstraint")
weld.Part0 = templateHead
weld.Part1 = collar
weld.Parent = templateHead

-- A stock NPC for question 5, as CreateHumanoidModelFromDescription makes one.
local npc
local built, made = pcall(function()
  return Players:CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R15)
end)
if built and made then
  made.Name = "SpikeNpc"
  made:PivotTo(CFrame.new(BASE + Vector3.new(-26, 1, 0)))
  local root = made:FindFirstChild("HumanoidRootPart")
  if root then root.Anchored = true end
  pcall(function()
    made.ModelStreamingMode = Enum.ModelStreamingMode.Persistent
  end)
  made.Parent = folder
  local children = {}
  for _, child in made:GetChildren() do
    if #children < 40 then table.insert(children, { class = child.ClassName, name = child.Name }) end
  end
  local animate = made:FindFirstChild("Animate")
  local animateInfo = false
  if animate then
    animateInfo = { class = animate.ClassName, slots = {} }
    if animate:IsA("BaseScript") then
      animateInfo.enabled = animate.Enabled
      local hasContext, context = pcall(function() return animate.RunContext.Name end)
      if hasContext then animateInfo.runContext = context end
    end
    for _, slot in animate:GetChildren() do
      if #animateInfo.slots < 20 then table.insert(animateInfo.slots, slot.Name) end
    end
  end
  npc = { built = true, children = children, animate = animateInfo }
else
  npc = { built = false, error = tostring(made) }
end

return {
  studio = { version = version(), creatorType = game.CreatorType.Name, creatorId = game.CreatorId },
  streamingEnabled = workspace.StreamingEnabled,
  npc = npc,
}
`;

const probeDogs = (probes) => `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
local function probeDog(name, chain)
  local model = folder and folder:FindFirstChild(name)
  local animator = model and model:FindFirstChildWhichIsA("Animator", true)
  if not animator then return { error = name .. " has no Animator" } end
  local sequence = dogHold(chain)
  local result = probeEdit(model, animator, sequence, DOG_EXPECTED)
  sequence:Destroy()
  return result
end
return {
${probes}
}
`;

// Question 1 in edit mode: the dog under each controller, from the usual top pose.
const EDIT_DOGS = probeDogs(`  humanoid = probeDog("DogHumanoid"),
  controller = probeDog("DogController"),`);

// Question 2: the dog whose root part is named Root, with its sequence's top
// pose named after it, named HumanoidRootPart, and left out altogether.
const EDIT_ROOT_NAMES = probeDogs(`  topPoseRoot = probeDog("DogRootNamed", { "Root", "Body" }),
  topPoseHumanoidRootPart = probeDog("DogRootNamed", { "HumanoidRootPart", "Body" }),
  topPoseBody = probeDog("DogRootNamed", { "Body" }),`);

const EDIT_CHAINS = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)

-- A straight chain of n segments behind a fixed first one, each joined to the one before.
local function buildChain(n, at)
  local model = Instance.new("Model")
  model.Name = "Chain" .. n
  local previous = newPart("Seg0", Vector3.new(0.6, 0.6, 1), CFrame.new(at), model, { Anchored = true, Massless = false })
  model.PrimaryPart = previous
  for i = 1, n do
    local segment = newPart("Seg" .. i, Vector3.new(0.6, 0.6, 1), CFrame.new(at + Vector3.new(0, 0, i)), model)
    newMotor("Seg" .. i, previous, segment, at + Vector3.new(0, 0, i - 0.5))
    previous = segment
  end
  local animator = addController(model, "AnimationController")
  model.Parent = folder
  return model, animator
end

-- Poses nest down the whole chain, n + 1 deep; only the middle segment and the last are keyed.
local function chainSequence(n, middle)
  local sequence = Instance.new("KeyframeSequence")
  sequence.Name = "ChainHold" .. n
  sequence.Loop = true
  for _, time in { 0, 1 } do
    local keyframe = Instance.new("Keyframe")
    keyframe.Time = time
    local parentPose = newPose("Seg0", nil, 0, keyframe)
    for i = 1, n do
      if i == middle then
        parentPose = newPose("Seg" .. i, CFrame.Angles(0, math.rad(20), 0), 1, parentPose)
      elseif i == n then
        parentPose = newPose("Seg" .. i, CFrame.Angles(0, math.rad(30), 0), 1, parentPose)
      else
        parentPose = newPose("Seg" .. i, nil, 0, parentPose)
      end
    end
    keyframe.Parent = sequence
  end
  return sequence
end

local results = {}
for index, n in ${luaList(CHAIN_LENGTHS)} do
  local middle = math.floor(n / 2)
  local model, animator = buildChain(n, BASE + Vector3.new(40 + index * 4, 0, 0))
  local sequence = chainSequence(n, middle)
  local expected = { Seg1 = 0 }
  expected["Seg" .. middle] = 20
  expected["Seg" .. n] = 30
  local result = probeEdit(model, animator, sequence, expected)
  result.joints = nil
  result.depth = n + 1
  results["chain" .. n] = result
  sequence:Destroy()
  model:Destroy()
end
return results
`;

const EDIT_STARS = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)

-- A hub with m arms round it, each joined straight to the hub.
local function buildStar(m, at)
  local model = Instance.new("Model")
  model.Name = "Star" .. m
  local hub = newPart("Hub", Vector3.new(2, 2, 2), CFrame.new(at), model, { Anchored = true, Massless = false })
  model.PrimaryPart = hub
  for k = 1, m do
    local angle = 2 * math.pi * k / m
    local direction = Vector3.new(math.cos(angle), 0, math.sin(angle))
    local arm = newPart("Arm" .. k, Vector3.new(0.4, 0.4, 0.4), CFrame.new(at + direction * 2), model)
    newMotor("Arm" .. k, hub, arm, at + direction * 1.2)
  end
  local animator = addController(model, "AnimationController")
  model.Parent = folder
  return model, animator
end

-- Every arm keyed in each keyframe: m + 1 poses in one keyframe.
local function starSequence(m)
  local sequence = Instance.new("KeyframeSequence")
  sequence.Name = "StarHold" .. m
  sequence.Loop = true
  for _, time in { 0, 1 } do
    local keyframe = Instance.new("Keyframe")
    keyframe.Time = time
    local hubPose = newPose("Hub", nil, 0, keyframe)
    for k = 1, m do
      newPose("Arm" .. k, CFrame.Angles(math.rad(25), 0, 0), 1, hubPose)
    end
    keyframe.Parent = sequence
  end
  return sequence
end

local results = {}
for index, m in ${luaList(STAR_SIZES)} do
  local model, animator = buildStar(m, BASE + Vector3.new(40 + index * 8, 0, -30))
  local sequence = starSequence(m)
  local expected = {}
  for k = 1, m do expected["Arm" .. k] = 25 end
  local result = probeEdit(model, animator, sequence, expected)
  local moved = 0
  for _, degrees in result.joints or {} do
    if typeof(degrees) == "number" and math.abs(degrees - 25) <= 1.5 then moved += 1 end
  end
  result.joints = nil
  result.arms = m
  result.armsMoved = moved
  results["star" .. m] = result
  sequence:Destroy()
  model:Destroy()
end
return results
`;

const EDIT_CLONE = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
local store = game:GetService("ServerStorage"):FindFirstChild(SPIKE)
local template = store and store:FindFirstChild("DogTemplate")
if not template then return { error = "the template is missing" } end
local clone = template:Clone()
if not clone then return { cloned = false } end
local head = clone:FindFirstChild("Head")
local weld = head and head:FindFirstChildOfClass("WeldConstraint")
local report = {
  cloned = true,
  -- A part that cannot be archived should be left out of the copy, and its
  -- weld should come without it: a preview must refuse such a model.
  collarCopied = clone:FindFirstChild("Collar") ~= nil,
  collarWeld = weld and (weld.Part1 and weld.Part1.Name or "no Part1") or "no weld",
}
-- A preview folder as the animation tool's is: not archivable, far from the place.
local preview = Instance.new("Folder")
preview.Name = "__RoqerCreaturePreview"
preview.Archivable = false
preview.Parent = folder
clone:PivotTo(CFrame.new(0, 100000, 0))
clone.Parent = preview
local animator = clone:FindFirstChildWhichIsA("Animator", true)
local sequence = dogHold()
report.playback = animator and probeEdit(clone, animator, sequence, DOG_EXPECTED) or { error = "the copy has no Animator" }
sequence:Destroy()
report.templateUntouched = compare(readJoints(template), { Head = 0, FrontLeft = 0, Tail = 0 }).matches
preview:Destroy()
report.previewRemoved = folder:FindFirstChild("__RoqerCreaturePreview") == nil
return report
`;

// The dog's hold, kept where export_rbxm can reach it, for publishing.
const EDIT_HOLD_FOR_EXPORT = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
local old = folder:FindFirstChild("DogHold")
if old then old:Destroy() end
dogHold().Parent = folder
return true
`;

const EDIT_IMPORT_FOLDERS = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
for _, name in { "ImportPlain", "ImportPositioned" } do
  local holder = Instance.new("Folder")
  holder.Name = name
  holder.Parent = folder
end
return true
`;

// Once read, the inserted creatures go before the playtest: without a position
// they may sit at the spawn, in the way of the playtest's character.
const EDIT_DROP_IMPORTS = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
for _, name in { "ImportPlain", "ImportPositioned" } do
  local holder = folder:FindFirstChild(name)
  if holder then holder:Destroy() end
end
return true
`;

// Everything an insert put in the holder: its children, and each descendant
// with its parent, and for a part its size, place, pivot and axes.
const readImport = (holder) => `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
local holder = folder and folder:FindFirstChild(${lua(holder)})
if not holder then return { error = ${lua(`no ${holder}`)} } end
local top = {}
for _, child in holder:GetChildren() do
  if #top < 20 then table.insert(top, { class = child.ClassName, name = child.Name }) end
end
local items = {}
for _, descendant in holder:GetDescendants() do
  if #items >= 60 then break end
  local parent = descendant.Parent
  local entry = { class = descendant.ClassName, name = descendant.Name, parent = parent.Name, parentClass = parent.ClassName }
  if descendant:IsA("BasePart") then
    entry.size = vec(descendant.Size)
    entry.position = vec(descendant.Position)
    entry.pivot = vec(descendant:GetPivot().Position)
    entry.pivotOffset = vec(descendant.PivotOffset.Position)
    entry.look = vec(descendant.CFrame.LookVector)
    entry.up = vec(descendant.CFrame.UpVector)
  end
  if descendant:IsA("MeshPart") then
    entry.meshId = descendant.MeshId
    entry.meshSize = vec(descendant.MeshSize)
  end
  if descendant:IsA("Model") then entry.pivot = vec(descendant:GetPivot().Position) end
  table.insert(items, entry)
end
return { top = top, items = items }
`;

// Whether the plugin can read the uploaded meshes, as previews of a creature would.
const readEditableMeshes = (holder) => `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
local holder = folder and folder:FindFirstChild(${lua(holder)})
if not holder then return { error = ${lua(`no ${holder}`)} } end
local AssetService = game:GetService("AssetService")
local results = {}
for _, descendant in holder:GetDescendants() do
  if descendant:IsA("MeshPart") and #results < 12 then
    local entry = { name = descendant.Name }
    local ok, mesh = pcall(function()
      return AssetService:CreateEditableMeshAsync(Content.fromUri(descendant.MeshId))
    end)
    if ok and mesh then
      local count = 0
      local low = Vector3.new(math.huge, math.huge, math.huge)
      local high = -low
      for _, vertex in mesh:GetVertices() do
        count += 1
        local position = mesh:GetPosition(vertex)
        low = low:Min(position)
        high = high:Max(position)
      end
      entry.readable = true
      entry.vertices = count
      if count > 0 then entry.size = vec(high - low) end
      mesh:Destroy()
    else
      entry.readable = false
      entry.error = tostring(mesh)
    end
    table.insert(results, entry)
  end
end
return results
`;

const GENERATED_FOLDER_EXISTS = `
return game:GetService("ServerStorage"):FindFirstChild("__MCPGeneratedModels") ~= nil
`;

const readGenerated = (name) => `${PRELUDE}
local generated = game:GetService("ServerStorage"):FindFirstChild("__MCPGeneratedModels")
local model = generated and generated:FindFirstChild(${lua(name)})
if not model then return { error = "the generated model is missing" } end
local items = {}
for _, descendant in model:GetDescendants() do
  if #items >= 60 then break end
  local entry = { class = descendant.ClassName, name = descendant.Name, parent = descendant.Parent.Name }
  if descendant:IsA("BasePart") then
    entry.size = vec(descendant.Size)
    entry.position = vec(descendant.Position)
  end
  table.insert(items, entry)
end
local _, size = model:GetBoundingBox()
return { name = model.Name, size = vec(size), items = items }
`;

// Question 5 in the playtest: whether the NPC's Animate plays anything, on either peer.
const PLAY_NPC = `${PRELUDE}
local folder = workspace:WaitForChild(SPIKE, 5)
local npc = folder and folder:WaitForChild("SpikeNpc", 5)
if not npc then return { found = false } end
-- Animate starts the idle as soon as it runs; give it a moment.
task.wait(2)
local humanoid = npc:FindFirstChildOfClass("Humanoid")
local animator = humanoid and humanoid:FindFirstChildOfClass("Animator")
local ids = {}
local playing = 0
if animator then
  for _, track in animator:GetPlayingAnimationTracks() do
    playing += 1
    if #ids < 10 then table.insert(ids, track.Animation and track.Animation.AnimationId or "") end
  end
end
return { found = true, hasAnimator = animator ~= nil, playing = playing, animationIds = ids }
`;

// The client registers the same clip the server is about to play, in case the
// temporary ID it gets back is the one the server's replicates under.
const PLAY_CLIENT_REGISTER = `${PRELUDE}
local holder = Instance.new("Folder")
holder.Name = "__RoqerCreatureClientClips"
holder.Parent = workspace
local sequence = dogHold()
sequence.Parent = holder
local id, err = register(sequence)
return { id = id, registrationError = err }
`;

// Plays the hold on both dogs on the server, as a creature's loader would, and
// leaves it playing, looped, for the client to read.
const playServerHold = (assetId) => `${PRELUDE}
local folder = workspace:WaitForChild(SPIKE, 5)
if not folder then return { error = "the spike folder did not reach the playtest" } end
local published = ${lua(assetId ? `rbxassetid://${assetId}` : null)}
-- Kept for the rest of the playtest, in case a registration needs its sequence alive.
local clips = game:GetService("ServerStorage"):FindFirstChild(SPIKE)
local results = {}
for _, name in { "DogHumanoid", "DogController" } do
  local model = folder:FindFirstChild(name)
  local animator = model and model:FindFirstChildWhichIsA("Animator", true)
  if not animator then
    results[name] = { error = name .. " has no Animator in the playtest" }
    continue
  end
  local id = published
  if not id then
    local sequence = dogHold()
    sequence.Parent = clips
    local registered, err = register(sequence)
    if not registered then
      results[name] = { error = err }
      continue
    end
    id = registered
  end
  local track = play(animator, id, nil, published and 8 or 5)
  task.wait(0.6)
  local joints = readJoints(model)
  results[name] = { id = id, loaded = track.Length > 0, joints = joints, check = compare(joints, DOG_EXPECTED) }
end
return results
`;

const PLAY_CLIENT_READ = `${PRELUDE}
local folder = workspace:WaitForChild(SPIKE, 5)
if not folder then return { error = "the spike folder never reached the client" } end
-- What the server plays reaches the client over the network; give it a moment.
task.wait(1)
local results = {}
for _, name in { "DogHumanoid", "DogController" } do
  local model = folder:WaitForChild(name, 5)
  local animator = model and model:FindFirstChildWhichIsA("Animator", true)
  if not animator then
    results[name] = { error = name .. " has no Animator on the client" }
    continue
  end
  local playing = {}
  for _, track in animator:GetPlayingAnimationTracks() do
    if #playing < 5 then table.insert(playing, track.Animation and track.Animation.AnimationId or "") end
  end
  local joints = readJoints(model)
  results[name] = { playing = playing, joints = joints, check = compare(joints, DOG_EXPECTED) }
end
return results
`;

const PLAY_SERVER_STOP = `${PRELUDE}
local folder = workspace:FindFirstChild(SPIKE)
local stopped = 0
for _, name in { "DogHumanoid", "DogController" } do
  local model = folder and folder:FindFirstChild(name)
  local animator = model and model:FindFirstChildWhichIsA("Animator", true)
  if animator then
    for _, track in animator:GetPlayingAnimationTracks() do
      track:Stop(0)
      stopped += 1
    end
    resetJoints(model)
  end
end
return { stopped = stopped }
`;

// The client plays the hold on the dogs itself, as a loader running on each
// client would, rather than reading what the server plays.
const PLAY_CLIENT_LOCAL = `${PRELUDE}
local folder = workspace:WaitForChild(SPIKE, 5)
if not folder then return { error = "the spike folder never reached the client" } end
-- Long enough for the server's stop to reach the client first.
task.wait(1)
local results = {}
for _, name in { "DogHumanoid", "DogController" } do
  local model = folder:FindFirstChild(name)
  local animator = model and model:FindFirstChildWhichIsA("Animator", true)
  if not animator then
    results[name] = { error = name .. " has no Animator on the client" }
    continue
  end
  local sequence = dogHold()
  local id, err = register(sequence)
  if not id then
    sequence:Destroy()
    results[name] = { error = err }
    continue
  end
  local ok, result = pcall(function()
    local track, animation = play(animator, id, nil)
    task.wait(0.6)
    local joints = readJoints(model)
    local loaded = track.Length > 0
    stop(track, animation)
    return { loaded = loaded, joints = joints, check = compare(joints, DOG_EXPECTED) }
  end)
  sequence:Destroy()
  results[name] = ok and result or { error = tostring(result) }
end
return results
`;

// Question 6: an unanchored dog with a Humanoid, on its own ground far from the
// spawn, told to walk 24 studs forward at the given speed.
const playMoveTo = (speed) => `${PRELUDE}
local speed = ${lua(speed)}
local folder = workspace:FindFirstChild(SPIKE)
if not folder then return { error = "the spike folder did not reach the playtest" } end
for _, name in { "MoveGround", "MoverDog" } do
  local old = folder:FindFirstChild(name)
  if old then old:Destroy() end
end
-- Far from the spawn, so no player's client takes over the dog's physics.
local centre = Vector3.new(2000, 100, 2000)
newPart("MoveGround", Vector3.new(200, 2, 200), CFrame.new(centre), folder, { Anchored = true, CanCollide = true, Massless = false })
local dog = buildDog("MoverDog", folder, centre + Vector3.new(0, 1 + 2.2, 40), "Humanoid", nil, false)
local humanoid = dog:FindFirstChildOfClass("Humanoid")
local root = dog.PrimaryPart
pcall(function() root:SetNetworkOwner(nil) end)
humanoid.WalkSpeed = speed
task.wait(1)
local settled = {
  -- The root's centre above the ground: the hip height plus half the root, 2.2, when it stands as built.
  height = round(root.Position.Y - centre.Y - 1, 2),
  tilt = round(tiltOf(root), 1),
  state = humanoid:GetState().Name,
  health = round(humanoid.Health, 1),
}
local runningSpeeds = {}
local statesSeen = {}
local reached = nil
local connections = {
  humanoid.Running:Connect(function(value) table.insert(runningSpeeds, value) end),
  humanoid.StateChanged:Connect(function(_, state) statesSeen[state.Name] = true end),
  humanoid.MoveToFinished:Connect(function(value) reached = value end),
}
local from = root.Position
local lowest, highest, maxTilt = from.Y, from.Y, 0
local started = os.clock()
humanoid:MoveTo(from + Vector3.new(0, 0, -24))
while reached == nil and os.clock() - started < 7 do
  task.wait(0.1)
  maxTilt = math.max(maxTilt, tiltOf(root))
  lowest = math.min(lowest, root.Position.Y)
  highest = math.max(highest, root.Position.Y)
end
local elapsed = os.clock() - started
for _, connection in connections do connection:Disconnect() end
local moved = (root.Position - from) * Vector3.new(1, 0, 1)
local states = {}
for name in statesSeen do table.insert(states, name) end
local fastest, total = 0, 0
for _, value in runningSpeeds do
  fastest = math.max(fastest, value)
  total += value
end
local report = {
  speed = speed,
  settled = settled,
  reached = reached == true,
  timedOut = reached == nil,
  seconds = round(elapsed, 2),
  travelled = round(moved.Magnitude, 2),
  averageSpeed = round(moved.Magnitude / math.max(elapsed, 0.001), 2),
  maxTilt = round(maxTilt, 1),
  bob = round(highest - lowest, 2),
  statesSeen = states,
  finalState = humanoid:GetState().Name,
  health = round(humanoid.Health, 1),
  running = { reports = #runningSpeeds, fastest = round(fastest, 2), average = round(total / math.max(#runningSpeeds, 1), 2) },
}
dog:Destroy()
return report
`;

const cleanup = (generated) => `
local SPIKE = ${lua(SPIKE_FOLDER)}
local storage = game:GetService("ServerStorage")
local generatedName = ${lua(generated?.name)}
if generatedName then
  local generatedFolder = storage:FindFirstChild("__MCPGeneratedModels")
  local model = generatedFolder and generatedFolder:FindFirstChild(generatedName)
  if model then model:Destroy() end
  -- The folder goes too only if generate_model made it for this spike.
  if generatedFolder and ${generated?.folderExisted === false ? 'true' : 'false'} and #generatedFolder:GetChildren() == 0 then
    generatedFolder:Destroy()
  end
end
for _, container in { workspace, storage } do
  local folder = container:FindFirstChild(SPIKE)
  if folder then folder:Destroy() end
end
return workspace:FindFirstChild(SPIKE) == nil and storage:FindFirstChild(SPIKE) == nil
`;

const notAsked = { answer: 'not asked', evidence: 'the spike stopped before this question' };
const report = {
  startedAt: new Date().toISOString(),
  upload: UPLOAD ? 'enabled' : 'skipped (set ROQER_SPIKE_UPLOAD=1 to upload a test model and a test animation)',
  generate: GENERATE ? 'enabled' : 'skipped (set ROQER_SPIKE_GENERATE=1 to try generate_model)',
  // In question order; each is replaced by its finding as it is asked.
  questions: {
    motor6dOnModels: notAsked,
    clientSeesServerTrack: notAsked,
    clientPlaysOnModel: notAsked,
    rootPoseName: notAsked,
    rigSizeLimits: notAsked,
    previewOnClone: notAsked,
    stockNpcAnimate: notAsked,
    humanoidQuadrupedMoveTo: notAsked,
    articulatedUpload: notAsked,
    insertWithPositionKeepsLayout: notAsked,
    generateModelGroups: notAsked,
  },
};

// Every step that could not ask its question, which fails the run once the
// report is written.
const problems = [];

async function tool(client, step, name, args, timeoutMs = 30_000) {
  try {
    const result = await client.callTool(name, args, timeoutMs);
    if (result?.error) problems.push({ step, error: String(result.error) });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push({ step, error: message });
    return { error: message };
  }
}

// Runs a snippet and returns its decoded value, or { error } when the Luau
// failed, or returned an error of its own at the top level.
async function luau(client, step, code, target = 'edit') {
  const result = await tool(client, step, 'execute_luau', { code, target }, 60_000);
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

async function uploadFile(client, step, filePath, assetType, displayName) {
  const started = await tool(client, step, 'upload_asset', {
    action: 'upload',
    filePath,
    assetType,
    displayName,
    description: 'Test asset from tests/creature-spike.mjs. Safe to archive.',
    ...PLACE,
  }, 120_000);
  const polls = [started];
  let latest = started;
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (!latest.error && latest.status === 'processing' && latest.operation_id && Date.now() < deadline) {
    await delay(UPLOAD_POLL_MS);
    latest = await tool(client, `${step} (status)`, 'upload_asset', { action: 'status', operationId: latest.operation_id, ...PLACE });
    polls.push(latest);
  }
  const assetId = !latest.error && latest.status === 'complete' && latest.asset_id ? String(latest.asset_id) : null;
  if (assetId === null && !latest.error) problems.push({ step, error: `the upload ended ${latest.status ?? 'without a status'}` });
  return { assetId, moderationState: latest.moderation_state ?? null, finalStatus: latest.error ? 'error' : latest.status, polls };
}

const plays = (result) => result?.check?.matches === true;
const bothPlay = (results) => plays(results?.DogHumanoid) && plays(results?.DogController);
const couldNotAsk = (evidence) => ({ answer: 'could not be asked', evidence });

function judgeModels(dogs, serverHold) {
  if (dogs?.error || serverHold?.error) return couldNotAsk({ editMode: dogs, playtestServer: serverHold });
  const edit = plays(dogs.humanoid) && plays(dogs.controller);
  const server = bothPlay(serverHold);
  return {
    answer: edit && server ? 'yes' : edit || server ? 'partly' : 'no',
    evidence: { editMode: dogs, playtestServer: serverHold },
  };
}

function judgeReplication(temporary, published) {
  if (published) {
    return {
      answer: published.server?.error || published.client?.error ? 'could not be asked'
        : bothPlay(published.client) ? 'yes' : 'no',
      evidence: { published, temporaryClip: temporary },
    };
  }
  return {
    // A temporary clip is registered on each peer on its own, so a client may
    // never resolve one the server plays: only a published animation settles it.
    answer: bothPlay(temporary.client) ? 'yes' : 'inconclusive without a published animation',
    evidence: { published: UPLOAD ? 'the test animation was not published' : report.upload, temporaryClip: temporary },
  };
}

function judgeRootNames(names) {
  if (names?.error) return couldNotAsk(names);
  const own = plays(names.topPoseRoot);
  const humanoidName = plays(names.topPoseHumanoidRootPart);
  return {
    answer: own && humanoidName ? 'either name' : own ? "the root part's own name" : humanoidName ? 'HumanoidRootPart only' : 'neither',
    evidence: { ...names, posesMayStartBelowTheRoot: plays(names.topPoseBody) },
  };
}

function judgeSizes(chains, stars) {
  if (chains?.error || stars?.error) return couldNotAsk({ chains, stars });
  // The largest size that played, and the smallest that did not.
  const reach = (results, prefix, sizes) => {
    const played = sizes.filter((size) => plays(results[`${prefix}${size}`]));
    const refused = sizes.filter((size) => !played.includes(size));
    return `${played.length > 0 ? Math.max(...played) : 0}${refused.length > 0 ? ` (not ${Math.min(...refused)})` : ''}`;
  };
  return {
    answer: `chains played ${reach(chains, 'chain', CHAIN_LENGTHS)} joints deep, and ${reach(stars, 'star', STAR_SIZES)} joints in one keyframe`,
    evidence: { chains, stars },
  };
}

function judgeClone(clone) {
  if (clone?.error) return couldNotAsk(clone);
  return { answer: plays(clone.playback) && clone.previewRemoved === true ? 'yes' : 'no', evidence: clone };
}

function judgeNpc(npc, server, clientSide) {
  if (!npc?.built) return { answer: 'no NPC was built', evidence: npc };
  const where = [
    ...((server?.playing ?? 0) > 0 ? ['on the server'] : []),
    ...((clientSide?.playing ?? 0) > 0 ? ['on the client'] : []),
  ];
  return {
    answer: !npc.animate ? 'no Animate script'
      : where.length > 0 ? `Animate plays ${where.join(' and ')}`
        : server?.error || clientSide?.error ? 'could not be asked' : 'Animate is there but plays nothing',
    evidence: { npc, playtestServer: server, playtestClient: clientSide },
  };
}

// States a body that walks steadily never enters.
const UNSTEADY_STATES = ['FallingDown', 'Ragdoll', 'Dead', 'Physics', 'PlatformStanding'];

function judgeMoveTo(moves) {
  const runs = MOVE_SPEEDS.map((speed) => moves[speed]);
  const evidence = Object.fromEntries(MOVE_SPEEDS.map((speed) => [`speed${speed}`, moves[speed]]));
  if (runs.some((run) => run?.error)) return couldNotAsk(evidence);
  const steady = (run) => run?.reached === true && run.maxTilt <= 15 && run.health > 0
    && !(run.statesSeen ?? []).some((state) => UNSTEADY_STATES.includes(state));
  const count = runs.filter(steady).length;
  return {
    answer: count === runs.length ? 'yes' : count > 0 ? 'partly' : 'no',
    evidence: { ...evidence, runningReportsSpeed: runs.every((run) => (run?.running?.reports ?? 0) > 0) },
  };
}

function judgeUpload(asked) {
  if (!asked.upload?.assetId) {
    return { articulated: couldNotAsk(asked), insert: couldNotAsk('the model was not uploaded') };
  }
  const plain = judgeImport(asked.plainRaw);
  const positioned = judgeImport(asked.positionedRaw);
  const meshes = Array.isArray(asked.editableMesh) ? asked.editableMesh : [];
  return {
    articulated: {
      answer: `${describeImport(plain)}; EditableMesh read ${meshes.filter((entry) => entry.readable).length} of ${meshes.length}`,
      evidence: {
        assetId: asked.upload.assetId,
        moderation: asked.upload.moderationState,
        glb: glbPath,
        finding: plain,
        editableMesh: asked.editableMesh,
        insert: asked.plainInsert,
        readback: asked.plainRaw,
      },
    },
    insert: {
      answer: plain.layout === 'unknown' || positioned.layout === 'unknown' ? 'could not be asked'
        : positioned.layout === plain.layout ? 'yes'
          : `no: ${positioned.layout} with a position, ${plain.layout} without`,
      evidence: { withoutPosition: plain.layout, withPosition: positioned.layout, finding: positioned, insert: asked.positionedInsert, readback: asked.positionedRaw },
    },
  };
}

function judgeGenerated(made, readback) {
  if (!made || made.error || made.success !== true) return couldNotAsk(made);
  const names = new Set((readback?.items ?? []).map((item) => item.name));
  const named = GENERATED_GROUPS.filter((group) => names.has(group));
  return {
    answer: named.length === GENERATED_GROUPS.length ? 'separate, named pieces'
      : named.length > 0 ? `${named.length} of ${GENERATED_GROUPS.length} groups came back as named parts`
        : 'no group came back as a named part',
    evidence: { groups: GENERATED_GROUPS, named, made, readback },
  };
}

const passed = await runTest('creature spike', async ({ track }) => {
  const client = track(new McpClient('spike'));
  await client.start();
  await client.initialize();
  mkdirSync(reportDir, { recursive: true });

  let playtestStarted = false;
  let generated;
  let cleaned;
  try {
    const setup = await luau(client, 'setting up edit mode', EDIT_SETUP);
    assert(!setup.error, `edit-mode setup ran (${setup.error ?? 'ok'})`);
    report.studio = setup.studio;
    report.streamingEnabled = setup.streamingEnabled;

    const dogs = await luau(client, 'playing the dogs in edit mode', EDIT_DOGS);
    const names = await luau(client, 'naming the top pose', EDIT_ROOT_NAMES);
    const chains = await luau(client, 'playing the chains', EDIT_CHAINS);
    const stars = await luau(client, 'playing the stars', EDIT_STARS);
    const clone = await luau(client, 'previewing a copy', EDIT_CLONE);
    report.questions.rootPoseName = judgeRootNames(names);
    report.questions.rigSizeLimits = judgeSizes(chains, stars);
    report.questions.previewOnClone = judgeClone(clone);

    let publishedAnimation = null;
    if (UPLOAD) {
      writeFileSync(glbPath, articulatedCreatureGlb());
      const asked = { upload: await uploadFile(client, 'uploading the articulated creature', glbPath, 'Model', 'Roqer creature spike: model') };
      if (asked.upload.assetId) {
        await luau(client, 'making the import folders', EDIT_IMPORT_FOLDERS);
        const assetId = Number(asked.upload.assetId);
        asked.plainInsert = await tool(client, 'inserting the creature', 'insert_asset', {
          assetId, parentPath: `${SPIKE_PATH}.ImportPlain`, ...PLACE,
        }, 60_000);
        asked.positionedInsert = await tool(client, 'inserting the creature at a position', 'insert_asset', {
          assetId, parentPath: `${SPIKE_PATH}.ImportPositioned`, position: { x: 60, y: 300, z: 40 }, ...PLACE,
        }, 60_000);
        asked.plainRaw = await luau(client, 'reading the inserted creature', readImport('ImportPlain'));
        asked.positionedRaw = await luau(client, 'reading the positioned creature', readImport('ImportPositioned'));
        asked.editableMesh = await luau(client, 'reading the meshes back', readEditableMeshes('ImportPlain'));
        await luau(client, 'removing the inserted creatures', EDIT_DROP_IMPORTS);
      }
      const judged = judgeUpload(asked);
      report.questions.articulatedUpload = judged.articulated;
      report.questions.insertWithPositionKeepsLayout = judged.insert;

      await luau(client, 'keeping the test animation for export', EDIT_HOLD_FOR_EXPORT);
      const exported = await tool(client, 'exporting the test animation', 'export_rbxm', {
        instance_paths: [`${SPIKE_PATH}.DogHold`],
        output_path: rbxmPath,
        ...PLACE,
      }, 60_000);
      if (!exported.error) {
        publishedAnimation = await uploadFile(client, 'publishing the test animation', rbxmPath, 'Animation', 'Roqer creature spike: dog hold');
      }
    } else {
      report.questions.articulatedUpload = { answer: 'skipped', evidence: report.upload };
      report.questions.insertWithPositionKeepsLayout = { answer: 'skipped', evidence: report.upload };
    }

    if (GENERATE) {
      const existed = await luau(client, 'looking for generated models', GENERATED_FOLDER_EXISTS);
      const made = await tool(client, 'generating a creature', 'generate_model', {
        prompt: 'a low-poly wolf standing on four legs, with a tail',
        schema_groups: GENERATED_GROUPS,
        name: 'SpikeWolf',
        size: { x: 2, y: 3, z: 5 },
        timeout_ms: 180_000,
      }, 200_000);
      const name = typeof made?.modelPath === 'string' ? made.modelPath.split('.').pop() : undefined;
      generated = { name, folderExisted: existed === true };
      const readback = name ? await luau(client, 'reading the generated creature', readGenerated(name)) : null;
      report.questions.generateModelGroups = judgeGenerated(made, readback);
    } else {
      report.questions.generateModelGroups = { answer: 'skipped', evidence: report.generate };
    }

    // What edit mode showed, kept if the playtest never runs; replaced after it.
    report.questions.motor6dOnModels = couldNotAsk({ editMode: dogs, playtestServer: 'the playtest did not run' });
    report.questions.stockNpcAnimate = couldNotAsk({ npc: setup.npc, playtest: 'the playtest did not run' });

    playtestStarted = true;
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    const npcServer = await luau(client, 'reading the NPC on the server', PLAY_NPC, 'server');
    const npcClient = await luau(client, 'reading the NPC on the client', PLAY_NPC, 'client-1');
    const clientRegistration = await luau(client, 'registering the clip on the client', PLAY_CLIENT_REGISTER, 'client-1');
    const serverHold = await luau(client, 'playing the dogs on the server', playServerHold(null), 'server');
    const clientReplicated = await luau(client, 'reading the dogs on the client', PLAY_CLIENT_READ, 'client-1');
    await luau(client, 'stopping the dogs', PLAY_SERVER_STOP, 'server');
    const clientLocal = await luau(client, 'playing the dogs on the client', PLAY_CLIENT_LOCAL, 'client-1');
    let published = null;
    if (publishedAnimation?.assetId) {
      published = {
        assetId: publishedAnimation.assetId,
        server: await luau(client, 'playing the published animation on the server', playServerHold(publishedAnimation.assetId), 'server'),
        client: await luau(client, 'reading the published animation on the client', PLAY_CLIENT_READ, 'client-1'),
      };
      await luau(client, 'stopping the published animation', PLAY_SERVER_STOP, 'server');
    }
    const moves = {};
    for (const speed of MOVE_SPEEDS) {
      moves[speed] = await luau(client, `walking the dog at ${speed} studs a second`, playMoveTo(speed), 'server');
    }
    await safeStopPlaytest(client);
    playtestStarted = false;

    report.questions.motor6dOnModels = judgeModels(dogs, serverHold);
    report.questions.clientSeesServerTrack = judgeReplication({
      client: clientReplicated,
      clientRegistration,
      sameIdOnBothPeers: typeof clientRegistration?.id === 'string' && clientRegistration.id === serverHold?.DogController?.id,
    }, published);
    report.questions.clientPlaysOnModel = clientLocal?.error ? couldNotAsk(clientLocal)
      : { answer: bothPlay(clientLocal) ? 'yes' : 'no', evidence: clientLocal };
    report.questions.stockNpcAnimate = judgeNpc(setup.npc, npcServer, npcClient);
    report.questions.humanoidQuadrupedMoveTo = judgeMoveTo(moves);
  } finally {
    if (playtestStarted) await safeStopPlaytest(client);
    // Recorded rather than thrown here, so a cleanup failure cannot hide the
    // error that got us here; it is asserted below once the questions ran.
    cleaned = await luau(client, 'cleaning up', cleanup(generated));
    rmSync(rbxmPath, { force: true });
    report.cleanup = cleaned === true ? 'spike folders removed' : cleaned;
    report.problems = problems;
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nReport: ${reportPath}`);
    for (const [question, finding] of Object.entries(report.questions)) {
      console.log(`  ${question}: ${finding.answer}`);
    }
    for (const problem of problems) console.error(`  Could not ask (${problem.step}): ${problem.error}`);
  }
  assert(cleaned === true, 'spike folders removed from the place');
  assert(problems.length === 0, 'every question could be asked');
});

process.exit(passed ? 0 : 1);
