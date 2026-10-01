// Numeric checks on a compiled animation, so a run can be judged without
// looking at it. Each check measures the motion sampled at a fixed rate and
// compares it with a limit; the measurements are returned with the verdict, so
// a failure says by how much and where.
//
// The limits let Roblox's own R15 animations pass, with a margin. The live
// calibration run (tests/animation-calibration.mjs) measured the 26 animations
// of the default Animate script; each limit below notes Roblox's worst case,
// and the plan's "Live results" records the run. Each joint's own range is the
// rig's (R15_JOINT_LIMITS for R15).
//
// A rig read from a model is judged the same way, as far as it can be: its
// distance limits are R15's scaled to its size, and a check it lacks what to
// judge by for, such as feet or a joint's range, says so rather than passing.

import { R15_RIG } from './r15-rig.js';
import type { Rig, RigHinge, Vec3 } from './rig.js';
import {
  buildTracks,
  degreesBetween,
  pointToWorld,
  poseRig,
  restPose,
  rotationDegrees,
  sequenceDuration,
  transformInBody,
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
  /**
   * For a gait, the ground speed it was written for, in studs a second: how
   * fast its planted feet travel backward under the body. Absent when no foot
   * stays planted, or on a rig whose planted feet are not checked.
   */
  groundSpeed?: number;
}

export interface MotionCheckOptions {
  /** Walks, runs and other gaits: adds the ground, foot and symmetry checks. */
  locomotion?: boolean;
  /**
   * Any animation performed standing on the ground, such as a crouching
   * attack: adds the ground check's penetration limit, without asking a foot
   * to stay down, since a jump attack leaves the ground.
   */
  grounded?: boolean;
  /** Samples per second. Defaults to 60. */
  sampleRate?: number;
}

export const MOTION_LIMITS = {
  /** Degrees per second, any body joint. Roblox's worst: 2098 (jump, knee). */
  angularSpeed: 2500,
  /**
   * Degrees per second for a held prop's joint, such as the weapon grip. A
   * sword flicked through a quarter turn in two frames is meant; this only
   * catches a prop flipping round in a frame by mistake. Not calibrated: no
   * Roblox animation holds a prop through this joint.
   */
  propAngularSpeed: 7200,
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
  /** Degrees a joint with no declared range may turn and still count as still, so it needs no range. */
  stillDegrees: 0.1,
};

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function seconds(time: number): string {
  return `${round(time)} s`;
}

/** Signed rotation about an axis, in degrees, for a rotation that is mostly about it. */
function bendDegrees(r: Frame['r'], axis: RigHinge['axis'] = 'X'): number {
  if (axis === 'Y') return (Math.atan2(r[2], r[0]) * 180) / Math.PI;
  if (axis === 'Z') return (Math.atan2(r[3], r[0]) * 180) / Math.PI;
  return (Math.atan2(r[7], r[8]) * 180) / Math.PI;
}

/** How far the axis itself has turned, in degrees. */
function offAxisDegrees(r: Frame['r'], axis: RigHinge['axis'] = 'X'): number {
  const along = axis === 'Y' ? r[4] : axis === 'Z' ? r[8] : r[0];
  return (Math.acos(Math.min(1, Math.max(-1, along))) * 180) / Math.PI;
}

/** A list of names as prose: "Tail", "Head and Tail", "Head, Neck and Tail". */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A distance limit for this rig: its own on R15 and R6, and R15's scaled to
 * the body on any other, whose results say so.
 */
function scaled(rig: Rig, limit: number): number {
  return rig.scale ? limit * rig.scale.factor : limit;
}

/** How a distance limit reads in a result. */
function scaledText(rig: Rig, limit: number): string {
  return rig.scale ? `${round(limit * rig.scale.factor)}` : `${limit}`;
}

/** What a result that judged distances adds on a rig whose limits were scaled. */
function scaledNote(rig: Rig): string {
  return rig.scale ? `; its limits are R15's scaled by ${round(rig.scale.factor)} for ${rig.scale.basis}` : '';
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
  // Joints that turned with no range to judge them by.
  const unranged: string[] = [];
  let ranged = 0;
  for (const joint of rig.joints) {
    const limit = rig.limits[joint.name];
    if (limit === 'free') continue;
    const hinge = limit !== undefined && 'min' in limit ? limit : undefined;
    const turn = limit !== undefined && 'turn' in limit ? limit.turn : undefined;
    const bendAxis = rig.hinges[joint.name]?.axis ?? 'X';
    let low = { value: Infinity, time: 0 };
    let high = { value: -Infinity, time: 0 };
    let off = { value: 0, time: 0 };
    let most = { value: 0, time: 0 };
    data.poses.forEach((pose, index) => {
      const r = transformInBody(joint, pose.transforms.get(joint.name)!).r;
      const time = data.times[index];
      if (hinge) {
        const bend = bendDegrees(r, bendAxis);
        if (bend < low.value) low = { value: bend, time };
        if (bend > high.value) high = { value: bend, time };
        const axis = offAxisDegrees(r, bendAxis);
        if (axis > off.value) off = { value: axis, time };
      } else {
        const angle = rotationDegrees(r);
        if (angle > most.value) most = { value: angle, time };
      }
    });
    if (turn === undefined && !hinge) {
      if (most.value > MOTION_LIMITS.stillDegrees) {
        measured[joint.name] = round(most.value, 1);
        unranged.push(joint.name);
      }
      continue;
    }
    ranged += 1;
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
    } else if (turn !== undefined) {
      measured[joint.name] = round(most.value, 1);
      if (most.value > turn) {
        failures.push({ excess: most.value - turn, text: `${joint.name} turns ${round(most.value, 1)}° at ${seconds(most.time)}; limit ${turn}°` });
      }
    }
  }
  failures.sort((a, b) => b.excess - a.excess);
  const unchecked = unranged.length === 0
    ? ''
    : `${listed(unranged)} ${unranged.length === 1 ? 'turns' : 'turn'} with no declared range`;
  if (failures.length > 0) {
    const worst = failures.length === 1 ? failures[0].text : `${failures[0].text}, and ${failures.length - 1} more`;
    return result('jointLimits', true, unchecked ? `${worst}; not checked: ${unchecked}` : worst, measured);
  }
  if (unchecked) {
    return { id: 'jointLimits', status: 'skipped', detail: `not checked: ${unchecked}${ranged > 0 ? '; every other joint stays within its range' : ''}`, measured };
  }
  return result('jointLimits', false, 'every joint stays within its range', measured);
}

function checkVelocity(data: Sampled, rig: Rig): MotionCheckResult {
  const measured: Record<string, number> = {};
  // The worst joint is the one furthest past, or nearest, its own limit.
  let worst = { joint: '', speed: 0, time: 0, limit: MOTION_LIMITS.angularSpeed };
  for (const joint of rig.joints) {
    const limit = joint.optional ? MOTION_LIMITS.propAngularSpeed : MOTION_LIMITS.angularSpeed;
    let peak = 0;
    for (let index = 1; index < data.poses.length; index += 1) {
      const step = degreesBetween(
        data.poses[index - 1].transforms.get(joint.name)!.r,
        data.poses[index].transforms.get(joint.name)!.r,
      );
      // The actual gap: a short animation is sampled more coarsely than the rate.
      const speed = step / (data.times[index] - data.times[index - 1]);
      if (speed > peak) peak = speed;
      if (speed / limit > worst.speed / worst.limit) worst = { joint: joint.name, speed, time: data.times[index], limit };
    }
    measured[joint.name] = round(peak, 0);
  }
  return result(
    'velocity',
    worst.speed > worst.limit,
    worst.joint
      ? `fastest for its limit: ${worst.joint} at ${round(worst.speed, 0)}°/s around ${seconds(worst.time)}; limit ${worst.limit}°/s`
      : 'nothing moves',
    measured,
  );
}

/** The part the root joint moves, whose position is the body's. */
function rootBody(rig: Rig): string | undefined {
  return rig.joints.find((joint) => joint.name === rig.rootJoint)?.childPart;
}

function checkRootDrift(data: Sampled, rig: Rig): MotionCheckResult {
  const body = rootBody(rig);
  if (!body) return skipped('rootDrift', `not checked: no one joint moves the whole body; its ${rig.rootPart} holds each piece by its own joint`);
  // Where the root joint's child sits at rest.
  const rest = restPose(rig).get(body)!.p;
  let excursion = { value: 0, time: 0 };
  data.poses.forEach((pose, index) => {
    const p = pose.parts.get(body)!.p;
    const away = Math.hypot(p[0] - rest[0], p[2] - rest[2]);
    if (away > excursion.value) excursion = { value: away, time: data.times[index] };
  });
  const start = data.poses[0].parts.get(body)!.p;
  const end = data.poses[data.poses.length - 1].parts.get(body)!.p;
  const gap = Math.hypot(end[0] - start[0], end[2] - start[2]);
  const measured = { excursion: round(excursion.value), returnGap: round(gap) };
  if (excursion.value > scaled(rig, MOTION_LIMITS.rootExcursion)) {
    return result('rootDrift', true, `the body moves ${round(excursion.value)} studs from the ${rig.rootPart} at ${seconds(excursion.time)}; limit ${scaledText(rig, MOTION_LIMITS.rootExcursion)}${scaledNote(rig)}`, measured);
  }
  if (gap > scaled(rig, MOTION_LIMITS.rootReturn)) {
    return result('rootDrift', true, `the body ends ${round(gap)} studs from where it started, so it snaps back when the animation stops; limit ${scaledText(rig, MOTION_LIMITS.rootReturn)}${scaledNote(rig)}`, measured);
  }
  return result('rootDrift', false, `the body stays within ${round(excursion.value)} studs of the ${rig.rootPart} and returns within ${round(gap)}${scaledNote(rig)}`, measured);
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
  const body = rootBody(rig);
  const a = body ? first.parts.get(body)!.p : [0, 0, 0];
  const b = body ? last.parts.get(body)!.p : [0, 0, 0];
  const jump = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const measured = { jointDegrees: round(worst.degrees, 1), jointLocalDegrees: round(worst.local, 1), rootStuds: round(jump) };
  if (worst.degrees > worst.allowed) {
    return result(
      'loopContinuity',
      true,
      `${worst.joint} jumps ${round(worst.degrees, 1)}° where the loop restarts, against ${round(worst.local, 1)}° per sample either side; limit ${round(worst.allowed, 1)}°`,
      measured,
    );
  }
  if (jump > scaled(rig, MOTION_LIMITS.seamStuds)) {
    return result('loopContinuity', true, `the body jumps ${round(jump)} studs where the loop restarts; limit ${scaledText(rig, MOTION_LIMITS.seamStuds)}${scaledNote(rig)}`, measured);
  }
  return result('loopContinuity', false, `the last pose meets the first${body ? scaledNote(rig) : ''}`, measured);
}

function footCorners(rig: Rig, foot: string): readonly Vec3[] {
  const declared = rig.footPoints?.[foot];
  if (declared) return declared;
  // A bone has no box: it meets the ground where it is.
  if (rig.bones?.includes(foot)) return [[0, 0, 0]];
  const [x, y, z] = rig.parts[foot].map((size) => size / 2);
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx * x, sy * y, sz * z]);
  return corners;
}

/** Each foot's corners over time, in the root part's frame, as heights above the ground. */
function footPoints(data: Sampled, rig: Rig): Map<string, [number, number, number][][]> {
  const ground = rig.ground;
  const points = new Map<string, [number, number, number][][]>();
  for (const foot of rig.feet) {
    const corners = footCorners(rig, foot);
    points.set(foot, data.poses.map((pose) => corners.map((corner) => {
      const p = pointToWorld(pose.parts.get(foot)!, corner);
      return [p[0], p[1] - ground, p[2]] as [number, number, number];
    })));
  }
  return points;
}

function checkGroundContact(data: Sampled, rig: Rig, gait: boolean): MotionCheckResult {
  if (rig.feet.length === 0) return skipped('groundContact', 'not checked: the rig declares no feet');
  const points = footPoints(data, rig);
  const contact = scaled(rig, MOTION_LIMITS.contactTolerance);
  let deepest = { value: 0, time: 0, foot: '' };
  let grounded = 0;
  data.times.forEach((time, index) => {
    let lowest = Infinity;
    for (const foot of rig.feet) {
      const low = Math.min(...points.get(foot)![index].map((p) => p[1]));
      lowest = Math.min(lowest, low);
      if (-low > deepest.value) deepest = { value: -low, time, foot };
    }
    if (lowest <= contact) grounded += 1;
  });
  const share = grounded / data.times.length;
  const measured = { penetration: round(deepest.value), groundedShare: round(share) };
  const note = scaledNote(rig);
  if (deepest.value > scaled(rig, MOTION_LIMITS.groundPenetration)) {
    return result('groundContact', true, `${deepest.foot} sinks ${round(deepest.value)} studs into the ground at ${seconds(deepest.time)}; limit ${scaledText(rig, MOTION_LIMITS.groundPenetration)}${note}`, measured);
  }
  if (!gait) {
    return result('groundContact', false, `no foot sinks more than ${round(deepest.value)} studs into the ground; a foot is down for ${Math.round(share * 100)}% of it${note}`, measured);
  }
  if (share < MOTION_LIMITS.groundedShare) {
    return result('groundContact', true, `a foot touches the ground for only ${Math.round(share * 100)}% of the gait; needs ${Math.round(MOTION_LIMITS.groundedShare * 100)}%${note}`, measured);
  }
  return result('groundContact', false, `a foot is on the ground for ${Math.round(share * 100)}% of the gait${note}`, measured);
}

// In an in-place gait a planted foot moves backward (+Z) with the ground.
// Wandering sideways, or forward (-Z) from the furthest back it has been,
// while planted is sliding. Each corner of a foot is followed on its own, so a
// foot rolling from heel to toe is not mistaken for one that moves.
function checkFootSliding(data: Sampled, rate: number, rig: Rig): MotionCheckResult {
  if (rig.feet.length === 0) return skipped('footSliding', 'not checked: the rig declares no feet');
  const points = footPoints(data, rig);
  const minimum = Math.ceil(MOTION_LIMITS.plantedSeconds * rate);
  const contact = scaled(rig, MOTION_LIMITS.contactTolerance);
  let worst = { studs: 0, time: 0, foot: '' };
  let planted = 0;
  for (const foot of rig.feet) {
    const series = points.get(foot)!;
    for (let corner = 0; corner < series[0].length; corner += 1) {
      let start = -1;
      for (let index = 0; index <= series.length; index += 1) {
        const down = index < series.length && series[index][corner][1] <= contact;
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
  if (worst.studs > scaled(rig, MOTION_LIMITS.footSlide)) {
    return result('footSliding', true, `${worst.foot} slides ${round(worst.studs)} studs while planted, by ${seconds(worst.time)}; limit ${scaledText(rig, MOTION_LIMITS.footSlide)}${scaledNote(rig)}`, measured);
  }
  return result('footSliding', false, `${planted ? `planted feet wander at most ${round(worst.studs)} studs` : 'no foot stays planted'}${scaledNote(rig)}`, measured);
}

/**
 * How fast the ground passes under an in-place gait: the median speed at which
 * its planted foot corners travel backward (+Z). A body moving at this speed
 * keeps its feet from sliding, so a loader plays the gait at the body's speed
 * over this one. The median, rather than a stretch's whole travel, leaves out
 * a foot's first and last moments in the contact band, when it is still
 * swinging forward onto the ground or already swinging off it.
 */
function measureGroundSpeed(data: Sampled, rate: number, rig: Rig): number | undefined {
  const points = footPoints(data, rig);
  const minimum = Math.ceil(MOTION_LIMITS.plantedSeconds * rate);
  const contact = scaled(rig, MOTION_LIMITS.contactTolerance);
  const speeds: number[] = [];
  for (const foot of rig.feet) {
    const series = points.get(foot)!;
    for (let corner = 0; corner < series[0].length; corner += 1) {
      let start = -1;
      for (let index = 0; index <= series.length; index += 1) {
        const down = index < series.length && series[index][corner][1] <= contact;
        if (down && start < 0) start = index;
        if (down || start < 0) continue;
        if (index - start >= minimum) {
          // Central differences inside the stretch, index - 1 being its last sample.
          for (let k = start + 1; k < index - 1; k += 1) {
            speeds.push((series[k + 1][corner][2] - series[k - 1][corner][2]) / (data.times[k + 1] - data.times[k - 1]));
          }
        }
        start = -1;
      }
    }
  }
  if (speeds.length === 0) return undefined;
  speeds.sort((a, b) => a - b);
  const middle = Math.floor(speeds.length / 2);
  return speeds.length % 2 === 1 ? speeds[middle] : (speeds[middle - 1] + speeds[middle]) / 2;
}

/**
 * A gait on a body that is not a biped: every declared foot must take a step
 * each cycle, and the feet must share the ground evenly. Reports the share of
 * the cycle each foot is down and the order they come down in.
 */
function checkGaitPattern(sequence: MotionSequence, data: Sampled, rig: Rig): MotionCheckResult {
  if (!sequence.loop) return skipped('gaitSymmetry', 'a gait loops; this animation does not');
  // One cycle, without the last sample, which repeats the first.
  const count = data.poses.length - 1;
  if (count < 4) return skipped('gaitSymmetry', 'the animation is too short to compare the feet');
  const points = footPoints(data, rig);
  const contact = scaled(rig, MOTION_LIMITS.contactTolerance);
  const measured: Record<string, number> = {};
  const feet = rig.feet.map((foot) => {
    const down = points.get(foot)!.slice(0, count).map((corners) => Math.min(...corners.map((p) => p[1])) <= contact);
    const share = down.filter(Boolean).length / count;
    const landing = down.findIndex((on, index) => on && !down[(index + count - 1) % count]);
    measured[`${foot}.down`] = round(share);
    // A landing in the cycle's last moments belongs with those at its start.
    const at = landing / count;
    if (landing >= 0) measured[`${foot}.lands`] = round(at > 0.95 ? 0 : at);
    return { foot, share, landing: landing < 0 ? undefined : at > 0.95 ? at - 1 : at };
  });
  const held = feet.filter((entry) => entry.share === 1).map((entry) => entry.foot);
  if (held.length > 0) {
    return result('gaitSymmetry', true, `${listed(held)} never ${held.length === 1 ? 'leaves' : 'leave'} the ground; in a gait every foot steps`, measured);
  }
  const lifted = feet.filter((entry) => entry.share === 0).map((entry) => entry.foot);
  if (lifted.length > 0) {
    return result('gaitSymmetry', true, `${listed(lifted)} never ${lifted.length === 1 ? 'touches' : 'touch'} the ground; in a gait every foot steps`, measured);
  }
  const least = feet.reduce((a, b) => (b.share < a.share ? b : a));
  const most = feet.reduce((a, b) => (b.share > a.share ? b : a));
  const percent = (share: number) => `${Math.round(share * 100)}%`;
  if (least.share / most.share < MOTION_LIMITS.gaitAmplitudeRatio) {
    return result('gaitSymmetry', true, `the feet share the ground unevenly: ${least.foot} is down ${percent(least.share)} of the cycle and ${most.foot} ${percent(most.share)}; the least must be at least ${Math.round(MOTION_LIMITS.gaitAmplitudeRatio * 100)}% of the most`, measured);
  }
  // Feet that land within a twentieth of a cycle of each other land together.
  const order = [...feet].sort((a, b) => a.landing! - b.landing!);
  const groups: string[][] = [];
  let last = -Infinity;
  for (const entry of order) {
    if (entry.landing! - last <= 0.05) groups[groups.length - 1].push(entry.foot);
    else groups.push([entry.foot]);
    last = entry.landing!;
  }
  const down = least.share === most.share ? percent(most.share) : `${percent(least.share)} to ${percent(most.share)}`;
  return result('gaitSymmetry', false, `${feet.length} feet step, each down ${down} of the cycle, landing ${groups.map((group) => group.join(' with ')).join(', then ')}`, measured);
}

function checkGaitSymmetry(sequence: MotionSequence, data: Sampled, rig: Rig): MotionCheckResult {
  const hips = rig.hips;
  if (!hips && rig.feet.length >= 2) return checkGaitPattern(sequence, data, rig);
  if (!hips) return skipped('gaitSymmetry', 'not checked: the rig declares no pair of hips to compare');
  if (!sequence.loop) return skipped('gaitSymmetry', 'a gait loops; this animation does not');
  // One cycle, without the last sample, which repeats the first.
  const count = data.poses.length - 1;
  if (count < 4) return skipped('gaitSymmetry', 'the animation is too short to compare the legs');
  const [left, right] = hips.map((name) => {
    const hip = rig.joints.find((joint) => joint.name === name)!;
    return data.poses.slice(0, count).map((pose) => bendDegrees(transformInBody(hip, pose.transforms.get(name)!).r));
  });
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
    checks.push(checkGroundContact(data, rig, true), checkFootSliding(data, rate, rig), checkGaitSymmetry(sequence, data, rig));
  } else {
    checks.push(options.grounded ? checkGroundContact(data, rig, false) : skipped('groundContact', 'only for locomotion or grounded'));
    for (const id of ['footSliding', 'gaitSymmetry'] as const) {
      checks.push(skipped(id, 'only for locomotion'));
    }
  }
  const unchecked = rig.uncheckedChecks ?? {};
  for (const [index, check] of checks.entries()) {
    const why = unchecked[check.id];
    if (why !== undefined && check.status !== 'skipped') checks[index] = skipped(check.id, `not checked: ${why}`);
  }
  // Measured from planted feet, so only where planted feet are checked.
  const groundSpeed = options.locomotion && unchecked.footSliding === undefined
    ? measureGroundSpeed(data, rate, rig)
    : undefined;
  return {
    passed: checks.every((check) => check.status !== 'fail'),
    duration: sequenceDuration(sequence),
    sampleRate: rate,
    checks,
    ...(groundSpeed === undefined ? {} : { groundSpeed: round(groundSpeed) }),
  };
}
