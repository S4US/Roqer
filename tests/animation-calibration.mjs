#!/usr/bin/env node
// Live calibration for docs/animation-plan.md step 6. It checks the motion
// checks against Studio:
//
//   1. Which animations does Roblox's default R15 Animate script use? Read from
//      a playtest character, so the list follows Studio rather than a copy.
//   2. Does core's sampler move the joints as Studio does? Each animation is
//      played on a fresh in-memory dummy and stepped by hand, and every joint's
//      Transform is compared with core's sample at the same time. Each is also
//      played as a registered temporary clip, as a preview would be.
//   3. Does core ease as Studio does? Probes built by the pose compiler cover
//      every easing style and direction, Linear keys over several arcs, and a
//      Root offset.
//   4. Do Roblox's own animations pass the motion checks? They must, or the
//      limits are wrong.
//
// Only derived numbers belong in the repository. The report and the fetched
// sequences are written under tmp/animation-calibration/, which is ignored.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  McpClient,
  REPO_ROOT,
  assert,
  runTest,
  safeStopPlaytest,
  startPlaytestAndWait,
} from './lib/mcp-client.mjs';
import {
  compilePoseAnimation,
  POSE_EASING_DIRECTIONS,
  POSE_EASING_STYLES,
} from '../packages/core/dist/animation/pose-compiler.js';
import {
  buildTracks,
  degreesBetween,
  easeAlpha,
  frameFromComponents,
  sampleTrack,
} from '../packages/core/dist/animation/motion.js';
import { checkMotion } from '../packages/core/dist/animation/motion-checks.js';
import { R15_RIG } from '../packages/core/dist/animation/r15-rig.js';

const FOLDER = '__RoqerAnimationCalibration';
const LOCOMOTION = new Set(['walk', 'run']);
// Groups that move no body joint: "mood" is the face animation for dynamic
// heads, and never loads as a body track.
const SKIPPED_GROUPS = new Map([['mood', 'face animation, no body joints']]);
// Core's sampler must match Studio's joints this closely: well inside what any
// motion check can tell apart (its limits are hundreds of degrees a second and
// tenths of a stud). Two known differences stay inside it; the plan's "Live
// results" records them.
const MAX_DEGREES = 1;
const MAX_STUDS = 0.1;
// An easing curve must match to this, under slerp or a normalised lerp.
const MAX_CURVE_DEGREES = 0.05;

const reportDir = path.join(REPO_ROOT, 'tmp', 'animation-calibration');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `report-${stamp}.json`);
const sequencesPath = path.join(reportDir, `sequences-${stamp}.json`);

const PRELUDE = `
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local FOLDER = ${JSON.stringify(FOLDER)}

local function folder()
  local existing = workspace:FindFirstChild(FOLDER)
  if existing then return existing end
  local created = Instance.new("Folder")
  created.Name = FOLDER
  created.Parent = workspace
  return created
end

-- A fresh dummy for every track: a stopped track leaves its last pose on the
-- joints, which would stand in for any joint the next track does not key.
local function freshDummy()
  local old = folder():FindFirstChild("CalibrationDummy")
  if old then old:Destroy() end
  local rig = Players:CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R15)
  rig.Name = "CalibrationDummy"
  rig.Parent = folder()
  rig:PivotTo(CFrame.new(0, 500, 0))
  rig.HumanoidRootPart.Anchored = true
  return rig
end

-- Each joint, by the part it moves.
local function jointsByPart(rig)
  local joints = {}
  for _, d in rig:GetDescendants() do
    if d:IsA("AnimationConstraint") and d.Attachment1 and d.Attachment1.Parent then
      joints[d.Attachment1.Parent.Name] = d
    elseif d:IsA("Motor6D") and d.Part1 then
      joints[d.Part1.Name] = d
    end
  end
  return joints
end

local function components(cf)
  local out = { cf:GetComponents() }
  for i, v in out do out[i] = math.round(v * 1e6) / 1e6 end
  return out
end

-- Plays a track stepped by hand and records every joint's Transform, at most
-- 90 times over one pass of the track.
local function sampleEngine(animationId)
  local rig = freshDummy()
  local humanoid = rig:FindFirstChildOfClass("Humanoid")
  local animator = humanoid:FindFirstChildOfClass("Animator")
  if not animator then
    animator = Instance.new("Animator")
    animator.Parent = humanoid
  end
  local joints = jointsByPart(rig)
  local animation = Instance.new("Animation")
  animation.AnimationId = animationId
  local track = animator:LoadAnimation(animation)
  track:Play(0)
  local deadline = os.clock() + 15
  while track.Length == 0 and os.clock() < deadline do task.wait(0.1) end
  local length = track.Length
  if length == 0 or length > 30 then
    track:Stop(0)
    track:Destroy()
    animation:Destroy()
    return { error = length == 0 and "track never loaded" or "track longer than 30 s", length = length }
  end
  local step = math.max(1 / 30, length / 90)
  local count = math.floor((length - 1e-3) / step)
  local samples = {}
  local function record()
    local transforms = {}
    for part, joint in joints do transforms[part] = components(joint.Transform) end
    table.insert(samples, { time = track.TimePosition, transforms = transforms })
  end
  animator:StepAnimations(0)
  record()
  for _ = 1, count do
    animator:StepAnimations(step)
    record()
  end
  local looped = track.Looped
  track:Stop(0)
  track:Destroy()
  animation:Destroy()
  return { length = length, looped = looped, samples = samples }
end
`;

const READ_ANIMATE = `${PRELUDE}
local player = Players.LocalPlayer or Players:GetPlayers()[1]
local deadline = os.clock() + 15
while not player and os.clock() < deadline do
  task.wait(0.2)
  player = Players:GetPlayers()[1]
end
if not player then return { error = "no player joined" } end
local character = player.Character or player.CharacterAdded:Wait()
local humanoid = character:WaitForChild("Humanoid", 15)
local animate = character:WaitForChild("Animate", 15)
if not humanoid or not animate then return { error = "character has no Humanoid or no Animate script" } end
local animations = {}
for _, group in animate:GetChildren() do
  if group:IsA("StringValue") then
    for _, child in group:GetChildren() do
      if child:IsA("Animation") then
        table.insert(animations, { group = group.Name, name = child.Name, id = child.AnimationId })
      end
    end
  end
end
return { rigType = humanoid.RigType.Name, animations = animations }
`;

const fetchAnimation = (id) => `${PRELUDE}
local function serializePose(pose)
  local children = {}
  for _, child in pose:GetChildren() do
    if child:IsA("Pose") then table.insert(children, serializePose(child)) end
  end
  return {
    part = pose.Name,
    weight = pose.Weight,
    cframe = components(pose.CFrame),
    easingStyle = pose.EasingStyle.Name,
    easingDirection = pose.EasingDirection.Name,
    children = children,
  }
end

local result = { id = ${JSON.stringify(id)} }
local ok, sequence = pcall(function()
  return game:GetService("KeyframeSequenceProvider"):GetKeyframeSequenceAsync(${JSON.stringify(id)})
end)
result.engine = sampleEngine(${JSON.stringify(id)})
if ok then
  local keyframes = {}
  for _, keyframe in sequence:GetKeyframes() do
    local roots = {}
    for _, child in keyframe:GetChildren() do
      if child:IsA("Pose") then table.insert(roots, serializePose(child)) end
    end
    table.insert(keyframes, { time = keyframe.Time, roots = roots })
  end
  result.sequence = { loop = sequence.Loop, priority = sequence.Priority.Name, keyframes = keyframes }
  -- The same sequence as a temporary clip, as a preview would play it.
  sequence.Parent = folder()
  local registered, id = pcall(function()
    return game:GetService("AnimationClipProvider"):RegisterAnimationClip(sequence)
  end)
  result.registered = registered and sampleEngine(id) or { error = tostring(id) }
  sequence:Destroy()
else
  result.fetchError = tostring(sequence)
end
return result
`;

const easingProbes = (sequences) => `${PRELUDE}
local function buildPose(data, parent)
  local pose = Instance.new("Pose")
  pose.Name = data.part
  pose.Weight = data.weight
  pose.CFrame = CFrame.new(table.unpack(data.cframe))
  pose.EasingStyle = Enum.PoseEasingStyle[data.easingStyle]
  pose.EasingDirection = Enum.PoseEasingDirection[data.easingDirection]
  pose.Parent = parent
  for _, child in data.children do buildPose(child, pose) end
end

local results = {}
for _, data in HttpService:JSONDecode([==[${JSON.stringify(sequences)}]==]) do
  local sequence = Instance.new("KeyframeSequence")
  sequence.Name = data.name
  sequence.Loop = data.loop
  sequence.Priority = Enum.AnimationPriority[data.priority]
  for _, keyframe in data.keyframes do
    local instance = Instance.new("Keyframe")
    instance.Time = keyframe.time
    buildPose(keyframe.root, instance)
    instance.Parent = sequence
  end
  sequence.Parent = folder()
  local id = game:GetService("AnimationClipProvider"):RegisterAnimationClip(sequence)
  table.insert(results, { name = data.name, engine = sampleEngine(id) })
end
return results
`;

const CLEANUP = `
local folder = workspace:FindFirstChild(${JSON.stringify(FOLDER)})
if folder then folder:Destroy() end
return workspace:FindFirstChild(${JSON.stringify(FOLDER)}) == nil
`;

async function luau(client, code, target = 'edit') {
  const result = await client.callTool('execute_luau', { code, target }, 180_000);
  if (result?.success !== true) {
    return { error: result?.error ?? result?.message ?? JSON.stringify(result) };
  }
  try {
    return JSON.parse(result.returnValue);
  } catch {
    return { error: `unexpected return value: ${String(result.returnValue).slice(0, 200)}` };
  }
}

const IDENTITY = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

// A fetched sequence may have several top-level poses in a keyframe; they hang
// under one weight-0 root, which keys nothing.
function toMotionSequence(fetched) {
  return {
    loop: fetched.loop,
    keyframes: fetched.keyframes.map((keyframe) => ({
      time: keyframe.time,
      root: { part: '(keyframe)', weight: 0, cframe: IDENTITY, easingStyle: 'Linear', easingDirection: 'In', children: keyframe.roots },
    })),
  };
}

// When Studio will not hand over the sequence, the engine's own samples stand
// in for it: one linear key per sample for every joint.
function sequenceFromSamples(engine) {
  const seen = new Set();
  const samples = engine.samples
    .filter((sample) => !seen.has(sample.time) && seen.add(sample.time))
    .sort((a, b) => a.time - b.time);
  return {
    loop: engine.looped,
    keyframes: samples.map((sample) => ({
      time: sample.time,
      root: {
        part: '(keyframe)', weight: 0, cframe: IDENTITY, easingStyle: 'Linear', easingDirection: 'In',
        children: Object.entries(sample.transforms).map(([part, cframe]) => ({
          part, weight: 1, cframe, easingStyle: 'Linear', easingDirection: 'In', children: [],
        })),
      },
    })),
  };
}

// The largest difference between core's joints and Studio's, over every sample.
function samplerError(sequence, engine) {
  const tracks = buildTracks(sequence);
  let worst = { degrees: 0, studs: 0, part: '', time: 0 };
  for (const sample of engine.samples) {
    for (const joint of R15_RIG.joints) {
      const actual = sample.transforms[joint.childPart];
      if (!actual) continue;
      const ours = sampleTrack(tracks.get(joint.childPart), sample.time);
      const theirs = frameFromComponents(actual);
      const degrees = degreesBetween(ours.r, theirs.r);
      const studs = Math.hypot(ours.p[0] - theirs.p[0], ours.p[1] - theirs.p[1], ours.p[2] - theirs.p[2]);
      if (degrees > worst.degrees || studs > worst.studs) {
        worst = {
          degrees: Math.max(degrees, worst.degrees),
          studs: Math.max(studs, worst.studs),
          part: degrees > worst.degrees ? joint.childPart : worst.part,
          time: degrees > worst.degrees ? sample.time : worst.time,
        };
      }
    }
  }
  return {
    degrees: Math.round(worst.degrees * 1000) / 1000,
    studs: Math.round(worst.studs * 10000) / 10000,
    worstPart: worst.part,
    worstTime: Math.round(worst.time * 1000) / 1000,
  };
}

// The largest difference between two engine recordings of one animation,
// sample by sample. Both step from 0 by the same amount.
function engineDifference(a, b) {
  let degrees = 0;
  const count = Math.min(a.samples.length, b.samples.length);
  for (let index = 0; index < count; index += 1) {
    for (const [part, cframe] of Object.entries(a.samples[index].transforms)) {
      const other = b.samples[index].transforms[part];
      if (other) degrees = Math.max(degrees, degreesBetween(frameFromComponents(cframe).r, frameFromComponents(other).r));
    }
  }
  return Math.round(degrees * 1000) / 1000;
}

// A rotation probe turns the right shoulder `arc` degrees about X from rest,
// so the eased fraction fixes the angle. Slerp turns it by the arc times the
// fraction; a normalised lerp by less, away from the ends. The probe reports
// both, so the easing curve is judged apart from how the rotation is
// interpolated.
function probeError(probe, engine) {
  let slerp = 0;
  let nlerp = 0;
  const half = (probe.arc * Math.PI) / 360;
  for (const sample of engine.samples) {
    const r = frameFromComponents(sample.transforms.RightUpperArm).r;
    const angle = (Math.atan2(r[7], r[8]) * 180) / Math.PI;
    const alpha = easeAlpha(probe.style, probe.direction, Math.min(1, sample.time / probe.duration));
    slerp = Math.max(slerp, Math.abs(angle - probe.arc * alpha));
    const lerped = (2 * Math.atan2(alpha * Math.sin(half), 1 - alpha + alpha * Math.cos(half)) * 180) / Math.PI;
    nlerp = Math.max(nlerp, Math.abs(angle - lerped));
  }
  return { slerp: Math.round(slerp * 1000) / 1000, nlerp: Math.round(nlerp * 1000) / 1000 };
}

// A position probe moves the body 1 stud back (+Z) on Linear keys. Studio's
// offset over the keyed one is the scale it applied.
function positionScale(probe, engine) {
  const ratios = engine.samples
    .filter((sample) => sample.time > 0.05 && sample.time < probe.duration)
    .map((sample) => sample.transforms.LowerTorso[2] / (sample.time / probe.duration))
    .sort((a, b) => a - b);
  return ratios.length ? Math.round(ratios[ratios.length >> 1] * 10000) / 10000 : null;
}

function compileProbe(name, keyframes) {
  const compiled = compilePoseAnimation({ name, rig: 'R15', keyframes });
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return compiled.sequence;
}

function rotationProbe(kind, name, style, direction, arc, duration) {
  return {
    kind, name, style, direction, arc, duration,
    sequence: compileProbe(name, [
      { time: 0, easing: { style, direction }, joints: { RightShoulder: { rotation: [0, 0, 0] } } },
      { time: duration, joints: { RightShoulder: { rotation: [arc, 0, 0] } } },
    ]),
  };
}

function probeSpecs() {
  const probes = [];
  // Asserted: every easing curve, over 90° in 1 s.
  for (const style of POSE_EASING_STYLES) {
    for (const direction of POSE_EASING_DIRECTIONS) {
      probes.push(rotationProbe('easing', `Ease${style}${direction}`, style, direction, 90, 1));
    }
  }
  // Findings: which interpolation Studio uses, by arc and by segment length.
  for (const arc of [45, 85, 95, 135, 175]) probes.push(rotationProbe('interpolation', `LinearArc${arc}`, 'Linear', 'In', arc, 1));
  probes.push(rotationProbe('interpolation', 'LinearArc90Short', 'Linear', 'In', 90, 0.2));
  probes.push(rotationProbe('interpolation', 'CubicV2Arc135', 'CubicV2', 'In', 135, 1));
  // Asserted: a compiled Root offset plays as written. Some of Roblox's own
  // animations play theirs scaled (1.074 or 1.104), for no reason a script can see.
  probes.push({
    kind: 'position',
    name: 'RootOffset',
    duration: 1,
    sequence: compileProbe('RootOffset', [
      { time: 0, joints: { Root: { position: [0, 0, 0] } } },
      { time: 1, joints: { Root: { position: [0, 0, 1] } } },
    ]),
  });
  return probes;
}

const report = { startedAt: new Date().toISOString(), animations: [], easing: [], probes: [] };
const fetchedSequences = {};

const passed = await runTest('animation calibration', async ({ track }) => {
  const client = track(new McpClient('calibration'));
  await client.start();
  await client.initialize();
  mkdirSync(reportDir, { recursive: true });

  let playtestStarted = false;
  let cleaned;
  try {
    playtestStarted = true;
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    let animate = await luau(client, READ_ANIMATE, 'server');
    if (animate.error || !animate.animations?.length) animate = await luau(client, READ_ANIMATE, 'client-1');
    await safeStopPlaytest(client);
    playtestStarted = false;
    report.animate = animate;
    assert(!animate.error && animate.animations?.length > 0, `read the default Animate script (${animate.error ?? `${animate.animations?.length} animations`})`);

    report.skipped = animate.animations
      .filter((entry) => SKIPPED_GROUPS.has(entry.group))
      .map((entry) => ({ group: entry.group, name: entry.name, id: entry.id, reason: SKIPPED_GROUPS.get(entry.group) }));
    const unique = [...new Map(animate.animations
      .filter((entry) => !SKIPPED_GROUPS.has(entry.group))
      .map((entry) => [entry.id, entry])).values()];
    for (const entry of unique) {
      const fetched = await luau(client, fetchAnimation(entry.id));
      const record = { group: entry.group, name: entry.name, id: entry.id };
      if (fetched.error || fetched.engine?.error) {
        record.error = fetched.error ?? fetched.engine.error;
        report.animations.push(record);
        continue;
      }
      const sequence = fetched.sequence ? toMotionSequence(fetched.sequence) : sequenceFromSamples(fetched.engine);
      fetchedSequences[entry.id] = { ...record, source: fetched.sequence ? 'keyframes' : 'engine samples', sequence, engine: fetched.engine };
      record.source = fetched.sequence ? 'keyframes' : `engine samples (${fetched.fetchError})`;
      record.length = fetched.engine.length;
      record.loop = sequence.loop;
      record.keyframes = sequence.keyframes.length;
      if (fetched.sequence) record.sampler = samplerError(sequence, fetched.engine);
      if (fetched.registered) {
        fetchedSequences[entry.id].registered = fetched.registered;
        record.registeredClip = fetched.registered.error
          ? { error: fetched.registered.error }
          : { degreesFromPublished: engineDifference(fetched.engine, fetched.registered) };
      }
      record.checks = checkMotion(sequence, { locomotion: LOCOMOTION.has(entry.group) });
      report.animations.push(record);
    }

    const probes = probeSpecs();
    const engineProbes = await luau(client, easingProbes(probes.map((probe) => probe.sequence)));
    assert(Array.isArray(engineProbes), `probes ran (${engineProbes.error ?? 'ok'})`);
    for (const result of engineProbes) {
      const probe = probes.find((entry) => entry.sequence.name === result.name);
      fetchedSequences[result.name] = { group: probe.kind, name: result.name, source: 'pose compiler', sequence: probe.sequence, engine: result.engine };
      const target = probe.kind === 'easing' ? report.easing : report.probes;
      if (result.engine.error) {
        target.push({ kind: probe.kind, name: result.name, error: result.engine.error });
      } else if (probe.kind === 'position') {
        target.push({ kind: probe.kind, name: result.name, scale: positionScale(probe, result.engine) });
      } else {
        const error = probeError(probe, result.engine);
        const matches = error.slerp <= MAX_CURVE_DEGREES ? 'slerp' : error.nlerp <= MAX_CURVE_DEGREES ? 'nlerp' : 'neither';
        target.push({ kind: probe.kind, name: result.name, arc: probe.arc, duration: probe.duration, ...error, matches });
      }
    }
  } finally {
    if (playtestStarted) await safeStopPlaytest(client);
    try {
      cleaned = await luau(client, CLEANUP);
    } catch (error) {
      cleaned = { error: error instanceof Error ? error.message : String(error) };
    }
    report.cleanup = cleaned === true ? 'calibration folder removed' : cleaned;
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(sequencesPath, `${JSON.stringify(fetchedSequences)}\n`);
    console.log(`\nReport: ${reportPath}`);
    for (const entry of report.animations) {
      if (entry.error) {
        console.log(`  ${entry.group}/${entry.name}: ${entry.error}`);
        continue;
      }
      const failures = entry.checks.checks.filter((check) => check.status === 'fail');
      const sampler = entry.sampler ? `, sampler within ${entry.sampler.degrees}°` : `, ${entry.source}`;
      const clip = entry.registeredClip
        ? `, registered clip ${entry.registeredClip.error ?? `${entry.registeredClip.degreesFromPublished}° from published`}`
        : '';
      console.log(`  ${entry.group}/${entry.name}: ${failures.length ? 'FAIL' : 'pass'}${sampler}${clip}`);
      for (const failure of failures) console.log(`    ${failure.id}: ${failure.detail}`);
    }
    for (const entry of report.skipped ?? []) console.log(`  ${entry.group}/${entry.name}: skipped, ${entry.reason}`);
    for (const entry of [...report.easing, ...report.probes]) {
      const finding = entry.kind === 'position'
        ? `plays at ${entry.scale}×`
        : `${entry.matches} (slerp off ${entry.slerp}°, normalised lerp off ${entry.nlerp}°)`;
      console.log(`  ${entry.kind} ${entry.name}: ${entry.error ?? finding}`);
    }
    for (const entry of report.animations.filter((item) => item.sampler)) {
      if (entry.sampler.degrees > MAX_DEGREES || entry.sampler.studs > MAX_STUDS) {
        console.log(`  sampler ${entry.group}/${entry.name}: ${entry.sampler.degrees}°, ${entry.sampler.studs} studs`);
      }
    }
    if (cleaned !== true) console.error(`  Cleanup failed: ${JSON.stringify(cleaned)}`);
  }

  const measured = report.animations.filter((entry) => !entry.error);
  assert(measured.length === report.animations.length, `every default animation loaded (${report.animations.filter((entry) => entry.error).map((entry) => entry.name).join(', ') || 'all'})`);
  // The easing curve is right when either interpolation reproduces Studio.
  const easingOff = report.easing.filter((entry) => entry.error || entry.matches === 'neither');
  assert(easingOff.length === 0, `core eases every style and direction as Studio does (${easingOff.map((entry) => entry.name).join(', ') || 'all'})`);
  const offset = report.probes.find((entry) => entry.name === 'RootOffset');
  assert(typeof offset?.scale === 'number' && Math.abs(offset.scale - 1) <= 0.005, `a compiled Root offset plays as written (${offset?.error ?? `${offset?.scale}×`})`);
  const samplerOff = measured.filter((entry) => entry.sampler && (entry.sampler.degrees > MAX_DEGREES || entry.sampler.studs > MAX_STUDS));
  assert(samplerOff.length === 0, `core samples Roblox's animations as Studio plays them (${samplerOff.map((entry) => entry.name).join(', ') || 'all'})`);
  const failing = measured.filter((entry) => !entry.checks.passed);
  assert(failing.length === 0, `Roblox's animations pass the motion checks (${failing.map((entry) => entry.name).join(', ') || 'all'})`);
  assert(cleaned === true, 'calibration folder removed from the place');
});

process.exit(passed ? 0 : 1);
