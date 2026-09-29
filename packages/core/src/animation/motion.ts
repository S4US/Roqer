// Samples a KeyframeSequence description over time and poses the rig from it.
//
// Each part's keyed poses (weight above 0) form its track. Between two keys a
// joint moves along the earlier key's easing: rotations are slerped and
// positions lerped, as Studio plays a published animation. Before a track's
// first key and after its last, the joint holds that key. A part with no keys
// rests at the identity. The live calibration run
// (tests/animation-calibration.mjs) compares these samples with the joint
// transforms Studio produces.
//
// Forward kinematics follows AnimationConstraint and Motor6D alike:
//   child = parent * C0 * Transform * C1^-1
// where C0 and C1 are the joint's frame in the parent and the child. On the
// stock R15 body they are pure offsets; R6 joints and the weapon grip turn
// them too. All positions are in the HumanoidRootPart's frame.

import {
  POSE_EASING_DIRECTIONS,
  POSE_EASING_STYLES,
  easeAlpha,
  type PoseEasingDirection,
  type PoseEasingStyle,
} from './easing.js';
import type { CFrameComponents } from './pose-compiler.js';

export { easeAlpha };
import { IDENTITY_ROTATION, R15_RIG, type Rig, type RigJoint, type Rotation, type Vec3 } from './r15-rig.js';

export interface MotionPose {
  part: string;
  weight: number;
  cframe: CFrameComponents | readonly number[];
  easingStyle: PoseEasingStyle;
  easingDirection: PoseEasingDirection;
  children: readonly MotionPose[];
}

export interface MotionKeyframe {
  time: number;
  root: MotionPose;
}

/** The part of a KeyframeSequence description the motion reads. */
export interface MotionSequence {
  loop: boolean;
  keyframes: readonly MotionKeyframe[];
}

/** A rigid transform: position and a row-major 3x3 rotation. */
export interface Frame {
  p: [number, number, number];
  r: [number, number, number, number, number, number, number, number, number];
}

type Quat = [number, number, number, number];

interface TrackKey {
  time: number;
  q: Quat;
  p: [number, number, number];
  style: PoseEasingStyle;
  direction: PoseEasingDirection;
}

export const IDENTITY_FRAME: Frame = { p: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] };

export function frameFromComponents(c: readonly number[]): Frame {
  return { p: [c[0], c[1], c[2]], r: [c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11]] };
}

export function translation(v: Vec3): Frame {
  return { p: [v[0], v[1], v[2]], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
}

export function multiply(a: Frame, b: Frame): Frame {
  const r = a.r, s = b.r;
  return {
    p: [
      a.p[0] + r[0] * b.p[0] + r[1] * b.p[1] + r[2] * b.p[2],
      a.p[1] + r[3] * b.p[0] + r[4] * b.p[1] + r[5] * b.p[2],
      a.p[2] + r[6] * b.p[0] + r[7] * b.p[1] + r[8] * b.p[2],
    ],
    r: [
      r[0] * s[0] + r[1] * s[3] + r[2] * s[6], r[0] * s[1] + r[1] * s[4] + r[2] * s[7], r[0] * s[2] + r[1] * s[5] + r[2] * s[8],
      r[3] * s[0] + r[4] * s[3] + r[5] * s[6], r[3] * s[1] + r[4] * s[4] + r[5] * s[7], r[3] * s[2] + r[4] * s[5] + r[5] * s[8],
      r[6] * s[0] + r[7] * s[3] + r[8] * s[6], r[6] * s[1] + r[7] * s[4] + r[8] * s[7], r[6] * s[2] + r[7] * s[5] + r[8] * s[8],
    ],
  };
}

function rotationFrame(r: Rotation): Frame {
  return { p: [0, 0, 0], r: [...r] as Frame['r'] };
}

function transpose(r: Rotation): Rotation {
  return [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
}

/** The joint's frame in its parent part: Motor6D.C0. */
export function jointParentFrame(joint: RigJoint): Frame {
  return { p: [...joint.parentOffset], r: [...(joint.parentRotation ?? IDENTITY_ROTATION)] as Frame['r'] };
}

/** The inverse of the joint's frame in its child part: Motor6D.C1^-1. */
export function jointChildFrameInverse(joint: RigJoint): Frame {
  const inverse = transpose(joint.childRotation ?? IDENTITY_ROTATION);
  return multiply(rotationFrame(inverse), translation([-joint.childOffset[0], -joint.childOffset[1], -joint.childOffset[2]]));
}

/**
 * A joint's Transform as a turn in its parent part's own axes, about the
 * joint: what the pose format's rotation, aim and bend describe. The same as
 * the Transform on a joint whose frame is not turned.
 */
export function transformInParent(joint: RigJoint, transform: Frame): Frame {
  const turn = joint.parentRotation;
  if (!turn) return transform;
  const frame = rotationFrame(turn);
  return multiply(multiply(frame, transform), rotationFrame(transpose(turn)));
}

/** The Transform that turns and moves a joint as `inParent` does in its parent's axes. */
export function transformFromParent(joint: RigJoint, inParent: Frame): Frame {
  const turn = joint.parentRotation;
  if (!turn) return inParent;
  return multiply(multiply(rotationFrame(transpose(turn)), inParent), rotationFrame(turn));
}

export function pointToWorld(frame: Frame, v: Vec3): [number, number, number] {
  return multiply(frame, translation(v)).p;
}

/** The rotation's angle in degrees, 0 to 180. */
export function rotationDegrees(r: Frame['r']): number {
  const cos = Math.min(1, Math.max(-1, (r[0] + r[4] + r[8] - 1) / 2));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** The angle in degrees between two rotations, 0 to 180. */
export function degreesBetween(a: Frame['r'], b: Frame['r']): number {
  // trace(a^T b)
  const trace = a[0] * b[0] + a[3] * b[3] + a[6] * b[6]
    + a[1] * b[1] + a[4] * b[4] + a[7] * b[7]
    + a[2] * b[2] + a[5] * b[5] + a[8] * b[8];
  const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** A rotation as a unit quaternion, [x, y, z, w]. */
export function rotationQuaternion(r: Frame['r']): [number, number, number, number] {
  return quatFromMatrix(r);
}

function quatFromMatrix(r: Frame['r']): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = r;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const length = Math.hypot(...q);
  return q.map((value) => value / length) as Quat;
}

function matrixFromQuat([x, y, z, w]: Quat): Frame['r'] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function nlerp(a: Quat, b: Quat, t: number): Quat {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const end = dot < 0 ? b.map((value) => -value) as Quat : b;
  const mixed = a.map((value, index) => value + (end[index] - value) * t) as Quat;
  const length = Math.hypot(...mixed);
  return mixed.map((value) => value / length) as Quat;
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let end = b;
  if (dot < 0) {
    dot = -dot;
    end = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (dot > 0.9995) return nlerp(a, end, t);
  const theta = Math.acos(dot);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return a.map((value, index) => value * wa + end[index] * wb) as Quat;
}

/** The rotation fraction t of the short way from a to b. */
export function slerpRotation(a: readonly number[], b: readonly number[], t: number): Frame['r'] {
  return matrixFromQuat(slerp(quatFromMatrix(a as Frame['r']), quatFromMatrix(b as Frame['r']), t));
}

/** Each part's keys, in time order. */
export type MotionTracks = ReadonlyMap<string, readonly TrackKey[]>;

export function buildTracks(sequence: MotionSequence): MotionTracks {
  const tracks = new Map<string, TrackKey[]>();
  const visit = (pose: MotionPose, time: number) => {
    if (pose.weight > 0) {
      if (!POSE_EASING_STYLES.includes(pose.easingStyle) || !POSE_EASING_DIRECTIONS.includes(pose.easingDirection)) {
        throw new Error(`${pose.part} at ${time} s has an unknown easing: ${pose.easingStyle} ${pose.easingDirection}`);
      }
      if (pose.cframe.length !== 12 || !pose.cframe.every(Number.isFinite)) {
        throw new Error(`${pose.part} at ${time} s has a malformed CFrame`);
      }
      const frame = frameFromComponents(pose.cframe);
      const keys = tracks.get(pose.part) ?? [];
      keys.push({
        time,
        q: quatFromMatrix(frame.r),
        p: frame.p,
        style: pose.easingStyle,
        direction: pose.easingDirection,
      });
      tracks.set(pose.part, keys);
    }
    for (const child of pose.children) visit(child, time);
  };
  for (const keyframe of sequence.keyframes) visit(keyframe.root, keyframe.time);
  for (const keys of tracks.values()) keys.sort((a, b) => a.time - b.time);
  return tracks;
}

/** The joint Transform that moves `part` at time t. */
export function sampleTrack(keys: readonly TrackKey[] | undefined, t: number): Frame {
  if (!keys || keys.length === 0) return IDENTITY_FRAME;
  let index = keys.length - 1;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].time > t) {
      index = i - 1;
      break;
    }
  }
  if (index < 0) return { p: [...keys[0].p], r: matrixFromQuat(keys[0].q) };
  const from = keys[index];
  const to = keys[index + 1];
  if (!to) return { p: [...from.p], r: matrixFromQuat(from.q) };
  const alpha = easeAlpha(from.style, from.direction, (t - from.time) / (to.time - from.time));
  return {
    p: [0, 1, 2].map((axis) => from.p[axis] + (to.p[axis] - from.p[axis]) * alpha) as Frame['p'],
    r: matrixFromQuat(slerp(from.q, to.q, alpha)),
  };
}

export interface RigPose {
  /** Each joint's Transform, by joint name. */
  transforms: Map<string, Frame>;
  /** Each part's frame in the HumanoidRootPart's frame, by part name. */
  parts: Map<string, Frame>;
}

export function poseRig(tracks: MotionTracks, t: number, rig: Rig = R15_RIG): RigPose {
  const transforms = new Map<string, Frame>();
  const parts = new Map<string, Frame>([[rig.rootPart, IDENTITY_FRAME]]);
  for (const joint of rig.joints) {
    const transform = sampleTrack(tracks.get(joint.childPart), t);
    transforms.set(joint.name, transform);
    const parent = parts.get(joint.parentPart) ?? IDENTITY_FRAME;
    parts.set(
      joint.childPart,
      multiply(multiply(multiply(parent, jointParentFrame(joint)), transform), jointChildFrameInverse(joint)),
    );
  }
  return { transforms, parts };
}

export function sequenceDuration(sequence: MotionSequence): number {
  return sequence.keyframes.reduce((latest, keyframe) => Math.max(latest, keyframe.time), 0);
}
