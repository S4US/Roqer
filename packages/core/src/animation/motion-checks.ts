// Numeric checks on a compiled animation, so a run can be judged without
// looking at it. Each check measures the motion sampled at a fixed rate and
// compares it with a limit; the measurements are returned with the verdict, so
// a failure says by how much and where.
//
// The limits let Roblox's own R15 animations pass, with a margin. The live
// calibration run (tests/animation-calibration.mjs) measured the 26 animations
// of the default Animate script; each limit below notes Roblox's worst case,
// and the plan's "Live results" records the run.

import { R15_RIG, type Rig, type Vec3 } from './r15-rig.js';
import {
  buildTracks,
  degreesBetween,
  pointToWorld,
  poseRig,
  rotationDegrees,
  sequenceDuration,
  type Frame,
  type MotionSequence,
  type RigPose,
} from './motion.js';

export type MotionCheckId =
  | 'jointLimits'
  | 'velocity'
  | 'rootDrift'
  | 'loopContinuity'
  | 'groundContact'
  | 'footSliding'
  | 'gaitSymmetry';

export interface MotionCheckResult {
  id: MotionCheckId;
  status: 'pass' | 'fail' | 'skipped';
  /** One line: the worst measurement against its limit, or why it was skipped. */
  detail: string;
  /** The measurements behind the verdict, rounded. Bounded by the rig's joint count. */
  measured: Record<string, number>;
}

export interface MotionReport {
  passed: boolean;
  duration: number;
  sampleRate: number;
  checks: MotionCheckResult[];
}

export interface MotionCheckOptions {
  /** Walks, runs and other gaits: adds the ground, foot and symmetry checks. */
  locomotion?: boolean;
  /** Samples per second. Defaults to 60. */
  sampleRate?: number;
}

/** Joints that bend about their X axis only. */
interface HingeLimit {
  /** Signed bend about X, in degrees. */
  min: number;
  max: number;
  /** How far the hinge axis itself may turn, in degrees. */
  offAxis: number;
}

export const MOTION_LIMITS = {
  /**
   * Largest turn from rest, in degrees, for joints that turn freely. Root is
   * unlimited: it turns the whole body. Anatomical; Roblox's worst: shoulder
   * 160 (climb), hip 111 (laugh), wrist 64 and ankle 39 (swim), neck 56 (idle),
   * waist 45 (laugh).
   */
  turn: {
    Waist: 90,
    Neck: 90,
    LeftShoulder: 180,
    RightShoulder: 180,
    LeftWrist: 100,
    RightWrist: 100,
    LeftHip: 150,
    RightHip: 150,
    LeftAnkle: 80,
    RightAnkle: 80,
  } as Record<string, number>,
  /**
   * An elbow bends the forearm forward (+X); a knee bends the shin back (-X).
   * Roblox's worst: knees -143 to 4.3 (run, cheer), elbows -6.7 to 123 (jump,
   * swim), 17° off axis (dance3).
   */
  hinge: {
    LeftElbow: { min: -15, max: 160, offAxis: 35 },
    RightElbow: { min: -15, max: 160, offAxis: 35 },
    LeftKnee: { min: -160, max: 10, offAxis: 35 },
    RightKnee: { min: -160, max: 10, offAxis: 35 },
  } as Record<string, HingeLimit>,
  /** Degrees per second, any joint. Roblox's worst: 2098 (jump, knee). */
  angularSpeed: 2500,
  /** Studs the body may move sideways from the HumanoidRootPart while playing. Roblox's worst: 0.81 (climb). */
  rootExcursion: 2,
  /** Studs between where the body starts and where it ends. Roblox's worst: 0.04. */
  rootReturn: 0.5,
  /**
   * At a loop's seam a joint may jump seamDegrees, or seamRatio times its own
   * motion over one sample either side of the seam, whichever is larger. A
   * stroke that carries on through the seam is not a jump. Roblox's worst:
   * 4.4 times (swim, wrist; its shoulders jump 19° against 5° either side).
   */
  seamDegrees: 3,
  seamRatio: 6,
  /** Studs the body may jump at a loop's seam. */
  seamStuds: 0.1,
  /** Studs a foot may sink below the ground. Roblox's worst: 0.03 (walk). */
  groundPenetration: 0.1,
  /** Studs above the ground that count as touching it. */
  contactTolerance: 0.05,
  /** Share of a gait with at least one foot on the ground. Roblox's worst: 0.64 (run). */
  groundedShare: 0.5,
  /**
   * A foot corner is planted while it stays on the ground this many seconds
   * or more; a foot skimming the ground mid-swing is not planted.
   */
  plantedSeconds: 0.1,
  /** Studs a planted corner may wander forward or sideways. Roblox's worst: 0.13 (walk, sideways). */
  footSlide: 0.25,
  /**
   * Degrees the larger hip swing must reach; the smaller swing over the
   * larger; and the legs' phase offset in cycles. Roblox's worst: 0.73 and
   * 0.45 (walk).
   */
  gaitMinSwing: 5,
  gaitAmplitudeRatio: 0.6,
  gaitPhase: { min: 0.4, max: 0.6 },
};

const ROOT_JOINT = 'Root';
const FEET = ['LeftFoot', 'RightFoot'] as const;
const HIPS = ['LeftHip', 'RightHip'] as const;

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function seconds(time: number): string {
  return `${round(time)} s`;
}

/** Signed rotation about X, in degrees, for a rotation that is mostly about X. */
function bendDegrees(r: Frame['r']): number {
  return (Math.atan2(r[7], r[8]) * 180) / Math.PI;
}

/** How far the X axis has turned, in degrees. */
function offAxisDegrees(r: Frame['r']): number {
  return (Math.acos(Math.min(1, Math.max(-1, r[0]))) * 180) / Math.PI;
}

interface Sampled {
  times: number[];
  poses: RigPose[];
}

function sample(sequence: MotionSequence, rate: number, rig: Rig): Sampled {
  const duration = sequenceDuration(sequence);
  const count = Math.max(1, Math.round(duration * rate));
  const tracks = buildTracks(sequence);
  const times = duration === 0 ? [0] : Array.from({ length: count + 1 }, (_unused, index) => (duration * index) / count);
  return { times, poses: times.map((time) => poseRig(tracks, time, rig)) };
}

function result(id: MotionCheckId, failed: boolean, detail: string, measured: Record<string, number>): MotionCheckResult {
  return { id, status: failed ? 'fail' : 'pass', detail, measured };
}

function skipped(id: MotionCheckId, detail: string): MotionCheckResult {
  return { id, status: 'skipped', detail, measured: {} };
}

function checkJointLimits(data: Sampled, rig: Rig): MotionCheckResult {
  const measured: Record<string, number> = {};
  const failures: { excess: number; text: string }[] = [];
  for (const joint of rig.joints) {
    const hinge = MOTION_LIMITS.hinge[joint.name];
    const turn = MOTION_LIMITS.turn[joint.name];
    if (!hinge && turn === undefined) continue;
    let low = { value: Infinity, time: 0 };
    let high = { value: -Infinity, time: 0 };
    let off = { value: 0, time: 0 };
    let most = { value: 0, time: 0 };
    data.poses.forEach((pose, index) => {
      const r = pose.transforms.get(joint.name)!.r;
      const time = data.times[index];
      if (hinge) {
        const bend = bendDegrees(r);
        if (bend < low.value) low = { value: bend, time };
        if (bend > high.value) high = { value: bend, time };
        const axis = offAxisDegrees(r);
        if (axis > off.value) off = { value: axis, time };
      } else {
        const angle = rotationDegrees(r);
        if (angle > most.value) most = { value: angle, time };
      }
    });
    if (hinge) {
      measured[`${joint.name}.bendMin`] = round(low.value, 1);
      measured[`${joint.name}.bendMax`] = round(high.value, 1);
      measured[`${joint.name}.offAxis`] = round(off.value, 1);
      if (low.value < hinge.min) {
        failures.push({ excess: hinge.min - low.value, text: `${joint.name} bends to ${round(low.value, 1)}° at ${seconds(low.time)}; limit ${hinge.min}°` });
      }
      if (high.value > hinge.max) {
        failures.push({ excess: high.value - hinge.max, text: `${joint.name} bends to ${round(high.value, 1)}° at ${seconds(high.time)}; limit ${hinge.max}°` });
      }
      if (off.value > hinge.offAxis) {
        failures.push({ excess: off.value - hinge.offAxis, text: `${joint.name} twists its hinge ${round(off.value, 1)}° off axis at ${seconds(off.time)}; limit ${hinge.offAxis}°` });
      }
    } else {
      measured[joint.name] = round(most.value, 1);
      if (most.value > turn) {
        failures.push({ excess: most.value - turn, text: `${joint.name} turns ${round(most.value, 1)}° at ${seconds(most.time)}; limit ${turn}°` });
      }
    }
  }
  failures.sort((a, b) => b.excess - a.excess);
  const detail = failures.length === 0
    ? 'every joint stays within its range'
    : failures.length === 1 ? failures[0].text : `${failures[0].text}, and ${failures.length - 1} more`;
  return result('jointLimits', failures.length > 0, detail, measured);
}

function checkVelocity(data: Sampled, rig: Rig): MotionCheckResult {
  const measured: Record<string, number> = {};
  let worst = { joint: '', speed: 0, time: 0 };
  for (const joint of rig.joints) {
    let peak = 0;
    for (let index = 1; index < data.poses.length; index += 1) {
      const step = degreesBetween(
        data.poses[index - 1].transforms.get(joint.name)!.r,
        data.poses[index].transforms.get(joint.name)!.r,
      );
      // The actual gap: a short animation is sampled more coarsely than the rate.
      const speed = step / (data.times[index] - data.times[index - 1]);
      if (speed > peak) peak = speed;
      if (speed > worst.speed) worst = { joint: joint.name, speed, time: data.times[index] };
    }
    measured[joint.name] = round(peak, 0);
  }
  const limit = MOTION_LIMITS.angularSpeed;
  return result(
    'velocity',
    worst.speed > limit,
    worst.joint
      ? `fastest: ${worst.joint} at ${round(worst.speed, 0)}°/s around ${seconds(worst.time)}; limit ${limit}°/s`
      : 'nothing moves',
    measured,
  );
}

function rootPosition(pose: RigPose, rig: Rig): [number, number, number] {
  const root = rig.joints.find((joint) => joint.name === ROOT_JOINT)!;
  return pose.parts.get(root.childPart)!.p;
}

function checkRootDrift(data: Sampled, rig: Rig): MotionCheckResult {
  const root = rig.joints.find((joint) => joint.name === ROOT_JOINT)!;
  // Where the root joint's child sits at rest.
  const rest = [
    root.parentOffset[0] - root.childOffset[0],
    root.parentOffset[1] - root.childOffset[1],
    root.parentOffset[2] - root.childOffset[2],
  ];
  let excursion = { value: 0, time: 0 };
  data.poses.forEach((pose, index) => {
    const p = rootPosition(pose, rig);
    const away = Math.hypot(p[0] - rest[0], p[2] - rest[2]);
    if (away > excursion.value) excursion = { value: away, time: data.times[index] };
  });
  const start = rootPosition(data.poses[0], rig);
  const end = rootPosition(data.poses[data.poses.length - 1], rig);
  const gap = Math.hypot(end[0] - start[0], end[2] - start[2]);
  const measured = { excursion: round(excursion.value), returnGap: round(gap) };
  if (excursion.value > MOTION_LIMITS.rootExcursion) {
    return result('rootDrift', true, `the body moves ${round(excursion.value)} studs from the HumanoidRootPart at ${seconds(excursion.time)}; limit ${MOTION_LIMITS.rootExcursion}`, measured);
  }
  if (gap > MOTION_LIMITS.rootReturn) {
    return result('rootDrift', true, `the body ends ${round(gap)} studs from where it started, so it snaps back when the animation stops; limit ${MOTION_LIMITS.rootReturn}`, measured);
  }
  return result('rootDrift', false, `the body stays within ${round(excursion.value)} studs of the HumanoidRootPart and returns within ${round(gap)}`, measured);
}

function checkLoopContinuity(sequence: MotionSequence, data: Sampled, rig: Rig): MotionCheckResult {
  if (!sequence.loop) return skipped('loopContinuity', 'the animation does not loop');
  if (data.poses.length < 2) return skipped('loopContinuity', 'the animation has no length');
  const count = data.poses.length;
  const first = data.poses[0];
  const last = data.poses[count - 1];
  // The worst joint by how far its jump exceeds what it may do there.
  let worst = { joint: '', degrees: 0, local: 0, allowed: MOTION_LIMITS.seamDegrees };
  for (const joint of rig.joints) {
    const at = (index: number) => data.poses[index].transforms.get(joint.name)!.r;
    const jump = degreesBetween(first.transforms.get(joint.name)!.r, last.transforms.get(joint.name)!.r);
    const local = count > 2 ? Math.max(degreesBetween(at(count - 2), at(count - 1)), degreesBetween(at(0), at(1))) : 0;
    const allowed = Math.max(MOTION_LIMITS.seamDegrees, MOTION_LIMITS.seamRatio * local);
    if (jump / allowed > worst.degrees / worst.allowed) worst = { joint: joint.name, degrees: jump, local, allowed };
  }
  const a = rootPosition(first, rig);
  const b = rootPosition(last, rig);
  const studs = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const measured = { jointDegrees: round(worst.degrees, 1), jointLocalDegrees: round(worst.local, 1), rootStuds: round(studs) };
  if (worst.degrees > worst.allowed) {
    return result(
      'loopContinuity',
      true,
      `${worst.joint} jumps ${round(worst.degrees, 1)}° where the loop restarts, against ${round(worst.local, 1)}° per sample either side; limit ${round(worst.allowed, 1)}°`,
      measured,
    );
  }
  if (studs > MOTION_LIMITS.seamStuds) {
    return result('loopContinuity', true, `the body jumps ${round(studs)} studs where the loop restarts; limit ${MOTION_LIMITS.seamStuds}`, measured);
  }
  return result('loopContinuity', false, 'the last pose meets the first', measured);
}

function footCorners(rig: Rig, foot: string): Vec3[] {
  const [x, y, z] = rig.parts[foot].map((size) => size / 2);
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx * x, sy * y, sz * z]);
  return corners;
}

function groundHeight(rig: Rig): number {
  return -(rig.hipHeight + rig.parts[rig.rootPart][1] / 2);
}

/** Each foot's corners over time, in the HumanoidRootPart's frame, as heights above the ground. */
function footPoints(data: Sampled, rig: Rig): Map<string, [number, number, number][][]> {
  const ground = groundHeight(rig);
  const points = new Map<string, [number, number, number][][]>();
  for (const foot of FEET) {
    const corners = footCorners(rig, foot);
    points.set(foot, data.poses.map((pose) => corners.map((corner) => {
      const p = pointToWorld(pose.parts.get(foot)!, corner);
      return [p[0], p[1] - ground, p[2]] as [number, number, number];
    })));
  }
  return points;
}

function checkGroundContact(data: Sampled, rig: Rig): MotionCheckResult {
  const points = footPoints(data, rig);
  let deepest = { value: 0, time: 0, foot: '' };
  let grounded = 0;
  data.times.forEach((time, index) => {
    let lowest = Infinity;
    for (const foot of FEET) {
      const low = Math.min(...points.get(foot)![index].map((p) => p[1]));
      lowest = Math.min(lowest, low);
      if (-low > deepest.value) deepest = { value: -low, time, foot };
    }
    if (lowest <= MOTION_LIMITS.contactTolerance) grounded += 1;
  });
  const share = grounded / data.times.length;
  const measured = { penetration: round(deepest.value), groundedShare: round(share) };
  if (deepest.value > MOTION_LIMITS.groundPenetration) {
    return result('groundContact', true, `${deepest.foot} sinks ${round(deepest.value)} studs into the ground at ${seconds(deepest.time)}; limit ${MOTION_LIMITS.groundPenetration}`, measured);
  }
  if (share < MOTION_LIMITS.groundedShare) {
    return result('groundContact', true, `a foot touches the ground for only ${Math.round(share * 100)}% of the gait; needs ${Math.round(MOTION_LIMITS.groundedShare * 100)}%`, measured);
  }
  return result('groundContact', false, `a foot is on the ground for ${Math.round(share * 100)}% of the gait`, measured);
}

// In an in-place gait a planted foot moves backward (+Z) with the ground.
// Wandering sideways, or forward (-Z) from the furthest back it has been,
// while planted is sliding. Each corner of a foot is followed on its own, so a
// foot rolling from heel to toe is not mistaken for one that moves.
function checkFootSliding(data: Sampled, rate: number, rig: Rig): MotionCheckResult {
  const points = footPoints(data, rig);
  const minimum = Math.ceil(MOTION_LIMITS.plantedSeconds * rate);
  let worst = { studs: 0, time: 0, foot: '' };
  let planted = 0;
  for (const foot of FEET) {
    const series = points.get(foot)!;
    for (let corner = 0; corner < series[0].length; corner += 1) {
      let start = -1;
      for (let index = 0; index <= series.length; index += 1) {
        const down = index < series.length && series[index][corner][1] <= MOTION_LIMITS.contactTolerance;
        if (down && start < 0) start = index;
        if (down || start < 0) continue;
        if (index - start >= minimum) {
          planted += 1;
          const x0 = series[start][corner][0];
          let furthestBack = -Infinity;
          for (let k = start; k < index; k += 1) {
            const [x, , z] = series[k][corner];
            furthestBack = Math.max(furthestBack, z);
            const studs = Math.hypot(x - x0, furthestBack - z);
            if (studs > worst.studs) worst = { studs, time: data.times[k], foot };
          }
        }
        start = -1;
      }
    }
  }
  const measured = { slide: round(worst.studs), plantedStretches: planted };
  if (worst.studs > MOTION_LIMITS.footSlide) {
    return result('footSliding', true, `${worst.foot} slides ${round(worst.studs)} studs while planted, by ${seconds(worst.time)}; limit ${MOTION_LIMITS.footSlide}`, measured);
  }
  return result('footSliding', false, planted ? `planted feet wander at most ${round(worst.studs)} studs` : 'no foot stays planted', measured);
}

function checkGaitSymmetry(sequence: MotionSequence, data: Sampled): MotionCheckResult {
  if (!sequence.loop) return skipped('gaitSymmetry', 'a gait loops; this animation does not');
  // One cycle, without the last sample, which repeats the first.
  const count = data.poses.length - 1;
  if (count < 4) return skipped('gaitSymmetry', 'the animation is too short to compare the legs');
  const [left, right] = HIPS.map((hip) => data.poses.slice(0, count).map((pose) => bendDegrees(pose.transforms.get(hip)!.r)));
  const amplitude = (series: number[]) => (Math.max(...series) - Math.min(...series)) / 2;
  const ampLeft = amplitude(left);
  const ampRight = amplitude(right);
  const ratio = Math.max(ampLeft, ampRight) === 0 ? 0 : Math.min(ampLeft, ampRight) / Math.max(ampLeft, ampRight);
  const centre = (series: number[]) => {
    const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
    return series.map((value) => value - mean);
  };
  const a = centre(left);
  const b = centre(right);
  let best = { lag: 0, score: -Infinity };
  for (let lag = 0; lag < count; lag += 1) {
    let score = 0;
    for (let index = 0; index < count; index += 1) score += a[index] * b[(index + lag) % count];
    if (score > best.score) best = { lag, score };
  }
  const phase = best.lag / count;
  const measured = { amplitudeLeft: round(ampLeft, 1), amplitudeRight: round(ampRight, 1), amplitudeRatio: round(ratio), phase: round(phase) };
  if (Math.max(ampLeft, ampRight) < MOTION_LIMITS.gaitMinSwing) {
    return result('gaitSymmetry', true, `the hips barely swing (${round(Math.max(ampLeft, ampRight), 1)}°); a gait needs at least ${MOTION_LIMITS.gaitMinSwing}°`, measured);
  }
  if (ratio < MOTION_LIMITS.gaitAmplitudeRatio) {
    return result('gaitSymmetry', true, `the hips swing unevenly: ${round(ampLeft, 1)}° left and ${round(ampRight, 1)}° right; the smaller must be at least ${Math.round(MOTION_LIMITS.gaitAmplitudeRatio * 100)}% of the larger`, measured);
  }
  const { min, max } = MOTION_LIMITS.gaitPhase;
  if (phase < min || phase > max) {
    return result('gaitSymmetry', true, `the legs are ${round(phase)} of a cycle apart; a gait needs ${min} to ${max}`, measured);
  }
  return result('gaitSymmetry', false, `the legs swing evenly, ${round(phase)} of a cycle apart`, measured);
}

/** Runs every check that applies to the animation. */
export function checkMotion(sequence: MotionSequence, options: MotionCheckOptions = {}, rig: Rig = R15_RIG): MotionReport {
  const rate = options.sampleRate ?? 60;
  const data = sample(sequence, rate, rig);
  const checks: MotionCheckResult[] = [
    checkJointLimits(data, rig),
    checkVelocity(data, rig),
    checkRootDrift(data, rig),
    checkLoopContinuity(sequence, data, rig),
  ];
  if (options.locomotion) {
    checks.push(checkGroundContact(data, rig), checkFootSliding(data, rate, rig), checkGaitSymmetry(sequence, data));
  } else {
    for (const id of ['groundContact', 'footSliding', 'gaitSymmetry'] as const) {
      checks.push(skipped(id, 'only for locomotion'));
    }
  }
  return {
    passed: checks.every((check) => check.status !== 'fail'),
    duration: sequenceDuration(sequence),
    sampleRate: rate,
    checks,
  };
}
