// Turns a compact pose description into a KeyframeSequence description.
//
// The input names joints ("RightShoulder") and gives each keyed joint a
// rotation in degrees, or, for a limb, the direction it points (`aim`) or how
// far its elbow or knee flexes (`bend`). The output is keyed by part name, as a KeyframeSequence
// is: a pose on a joint moves the joint's child part. The second animation
// spike showed that a part-keyed sequence drives AnimationConstraint joints as
// it drives Motor6D ones, so nothing here writes joint objects.
//
// Every rig takes the same path: R15 and R6, and a rig read from a model,
// whose limbs and hinges are what it declares (rig.ts).
//
// The whole animation is validated before anything is compiled, and every
// problem is reported at once with its path, so a caller can fix them in one
// pass. Nothing here touches Studio.

import {
  POSE_EASING_DIRECTIONS,
  POSE_EASING_STYLES,
  easeAlpha,
  type PoseEasingDirection,
  type PoseEasingStyle,
} from './easing.js';
import { buildTracks, pointToWorld, poseRig, restTurn, slerpRotation, transformFromBody, transformInBody, type Frame } from './motion.js';
import { R15_RIG } from './r15-rig.js';
import type { Rig, RigHinge, RigJoint, RigLimb } from './rig.js';
import { RIGS } from './rigs.js';
import { expandWaves, type WaveSpec } from './wave.js';

export { POSE_EASING_DIRECTIONS, POSE_EASING_STYLES, type PoseEasingDirection, type PoseEasingStyle };

export const ANIMATION_PRIORITIES = ['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4'] as const;
export type AnimationPriority = (typeof ANIMATION_PRIORITIES)[number];

export const POSE_LIMITS = {
  maxKeyframes: 240,
  maxDurationSeconds: 60,
  maxNameLength: 100,
  maxRotationDegrees: 360,
  maxRootOffsetStuds: 20,
  /** How far from the root part an aimAt target may be, in studs. */
  maxAimAtStuds: 20,
  /** How far past a limb's reach an aimAt target may lie and still be reached. */
  aimAtToleranceStuds: 0.02,
  /** How far along the handle grip may hold, in studs either way. */
  maxGripStuds: 3,
  /** The widest bend aimAt gives an elbow or knee, in degrees. */
  maxAimAtBend: 150,
  /** How often a planted limb is solved again between its keys, in seconds. */
  plantedStepSeconds: 1 / 30,
  /** How often a grip is solved again between its keys: a swung handle moves fast. */
  gripStepSeconds: 1 / 60,
  maxMarkersPerKeyframe: 16,
  maxMarkerValueLength: 200,
  /**
   * Degrees a joint may turn between consecutive keys, unless the earlier key
   * snaps (Constant). Past 90° Studio's playback of Linear keys drifts from a
   * slerp, so a longer turn is split into in-between keys (see splitTurns).
   */
  maxTurnPerSegment: 90,
  /**
   * A turn this large or larger is never split: near half a turn the short
   * way round is as likely to be wrong as right, so the caller must say which
   * way with a key along it.
   */
  maxSplitTurn: 175,
  /** Degrees each in-between of an eased turn covers, so the easing's shape survives. */
  easedSplitDegrees: 30,
  maxErrors: 20,
} as const;


/**
 * How a pose moves toward the joint's next key. Each field falls back
 * separately: joint, then keyframe, then animation, then the engine's default
 * (Linear, In).
 */
export interface PoseEasing {
  style?: PoseEasingStyle;
  direction?: PoseEasingDirection;
}

/**
 * A joint's pose. Give at most one of `rotation`, `aim` or `bend`; none means
 * the rest pose.
 */
export interface JointPoseSpec {
  /**
   * Degrees about the body's X, Y and Z axes at rest, at the joint, applied
   * as CFrame.Angles does: on R15 and R6, the parent part's axes.
   */
  rotation?: [number, number, number];
  /**
   * Shoulders and hips, or a rig's declared limbs: the direction the limb
   * points, as [right, up, forward] in the body's axes at rest, carried by
   * the parent part (the character's, while the torso is upright).
   * [0, -1, 0] hangs an arm or leg at rest.
   */
  aim?: [number, number, number];
  /**
   * With `aim`: the way the elbow or knee folds, as [right, up, forward].
   * Defaults to forward for arms and back for legs, as they fold at rest.
   */
  bendToward?: [number, number, number];
  /** Elbows and knees, or a rig's declared hinges: how far the joint flexes, in degrees; 0 is straight. */
  bend?: number;
  /**
   * Shoulders and hips, or a rig's declared limbs: a point, in studs as
   * [right, up, forward] from the root part's centre, that the limb's end
   * reaches: the wrist or ankle on R15, which bends the elbow or knee to
   * reach it, or the far end of the block on R6. `bendToward` turns the elbow
   * or knee as with `aim`.
   */
  aimAt?: [number, number, number];
  /**
   * LeftShoulder only: holds the left hand on the weapon's handle, this many
   * studs from the right hand's grip toward the pommel, for a two-handed hold.
   * Kept there between two keys that both grip, as the weapon moves.
   */
  grip?: number;
  /** Studs. Only the root joint (Root on R15 and R6) takes one: it offsets the whole body. */
  position?: [number, number, number];
  easing?: PoseEasing;
}

/**
 * A named event at a keyframe's time, built as a KeyframeMarker, which
 * AnimationTrack:GetMarkerReachedSignal(name) fires with the value.
 */
export interface PoseMarkerSpec {
  name: string;
  /** Passed to the signal's handler; defaults to "". */
  value?: string;
}

export interface PoseKeyframeSpec {
  /** Seconds from the start. The first keyframe is at 0, and times increase. */
  time: number;
  /** Optional Keyframe name, which KeyframeReached reports. */
  name?: string;
  easing?: PoseEasing;
  /** Joints keyed here. May be empty only when the keyframe carries markers. */
  joints: Record<string, JointPoseSpec>;
  markers?: PoseMarkerSpec[];
}

export interface PoseAnimationSpec {
  name: string;
  /** R15, R6, or the path of a model whose rig was read from Studio. */
  rig: string;
  /** Defaults to false. */
  loop?: boolean;
  /** Defaults to Action, as a new KeyframeSequence does. */
  priority?: AnimationPriority;
  easing?: PoseEasing;
  /** May be left out when `waves` and `duration` describe the whole animation. */
  keyframes?: PoseKeyframeSpec[];
  /** Seconds. Only with `waves`: the animation's length, when the last keyframe is not at it. */
  duration?: number;
  /** Sines sent down chains of joints, written out as rotation keys (wave.ts). */
  waves?: WaveSpec[];
}

/** CFrame.new(x, y, z, R00, R01, R02, R10, R11, R12, R20, R21, R22) order. */
export type CFrameComponents = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface CompiledPose {
  /** The Pose's name: the part it moves. */
  part: string;
  /** The joint that moves the part; absent on the root part. */
  joint?: string;
  /**
   * 1 for a keyed pose. 0 for a placeholder that only keeps the hierarchy
   * from the root part down to a keyed part. The engine skips a weight-0
   * pose, so it does not key its joint (third animation spike run).
   */
  weight: 0 | 1;
  cframe: CFrameComponents;
  easingStyle: PoseEasingStyle;
  easingDirection: PoseEasingDirection;
  children: CompiledPose[];
}

export interface CompiledMarker {
  name: string;
  value: string;
}

export interface CompiledKeyframe {
  time: number;
  name?: string;
  /** KeyframeMarkers at this keyframe's time; absent when there are none. */
  markers?: CompiledMarker[];
  /** The root part's pose, with the rest nested beneath it. */
  root: CompiledPose;
}

export interface KeyframeSequenceDescription {
  name: string;
  rig: string;
  loop: boolean;
  priority: AnimationPriority;
  /** The last keyframe's time, in seconds. */
  duration: number;
  /** The joints the animation moves, in rig order. */
  joints: string[];
  keyframes: CompiledKeyframe[];
  /** Every Pose instance, placeholders included. */
  poseCount: number;
  keyedPoseCount: number;
  /** Every KeyframeMarker, across all keyframes. */
  markerCount: number;
  /** Keys the compiler added: to split turns over maxTurnPerSegment, and to keep planted limbs on their points. */
  inBetweenCount: number;
}

export type PoseCompileResult =
  | { ok: true; sequence: KeyframeSequenceDescription }
  | { ok: false; errors: string[] };

/** A rotation, row-major. */
type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

interface ParsedJoint {
  joint: RigJoint;
  rotation: Matrix3;
  position: readonly [number, number, number];
  easing: { style?: PoseEasingStyle; direction?: PoseEasingDirection };
  /** An aimAt still to solve, once the body around it is posed; Roblox axes. */
  aimAt?: { target: Vec; toward?: Vec; path: string };
  /** A two-handed hold still to solve, once the weapon is posed. */
  grip?: { along: number; toward?: Vec; path: string };
}

const IDENTITY_MATRIX: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** CFrame.Angles(x, y, z) in degrees, as a matrix: Rx * Ry * Rz. */
function eulerMatrix(degrees: readonly [number, number, number]): Matrix3 {
  const [x, y, z] = degrees.map((value) => (value * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  return [
    cy * cz, -cy * sz, sy,
    sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy,
    -cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy,
  ];
}

type Vec = [number, number, number];
const dot3 = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale3 = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const length3 = (a: Vec) => Math.hypot(a[0], a[1], a[2]);

/** [right, up, forward] in the character's terms, as Roblox's axes: forward is -Z. */
function robloxDirection(value: readonly [number, number, number]): Vec {
  return [value[0], value[1], -value[2]];
}

/** How errors name the limbs `aim` and `aimAt` work on. */
function limbWords(rig: Rig): string {
  if (rig.words) return rig.words.limbs;
  const names = Object.keys(rig.limbs);
  return names.length > 0 ? `the limbs this rig declares, ${names.join(', ')}` : 'declared limbs, and this rig declares none';
}

/** How errors name the hinges `bend` works on. */
function hingeWords(rig: Rig): string {
  if (rig.words) return rig.words.hinges;
  const names = Object.keys(rig.hinges);
  return names.length > 0 ? `the hinges this rig declares, ${names.join(', ')}` : 'declared hinges, and this rig declares none';
}

/** The turn that flexes a hinge by `degrees`, about its axis in the body's axes. */
function hingeMatrix(hinge: RigHinge, degrees: number): Matrix3 {
  const turn = hinge.flex * degrees;
  return eulerMatrix(hinge.axis === 'X' ? [turn, 0, 0] : hinge.axis === 'Y' ? [0, turn, 0] : [0, 0, turn]);
}

/**
 * The rotation that points a limb's long axis along `aim` and turns its fold
 * toward `bendToward`, both [right, up, forward] in the body's axes. The fold
 * is taken square to the aim; when the two run together, the limb's usual
 * fold is used, then up, then back.
 */
export function aimRotation(limb: RigLimb, aim: readonly [number, number, number], bendToward?: readonly [number, number, number]): Matrix3 {
  const d = scale3(robloxDirection(aim), 1 / length3(robloxDirection(aim)));
  const candidates: Vec[] = [
    ...(bendToward ? [robloxDirection(bendToward)] : []),
    [...limb.fold] as Vec,
    [0, 1, 0],
    [0, 0, 1],
  ];
  let fold: Vec = [0, 0, 0];
  for (const candidate of candidates) {
    const square: Vec = [0, 1, 2].map((axis) => candidate[axis] - dot3(candidate, d) * d[axis]) as Vec;
    if (length3(square) > 1e-3 * Math.max(1, length3(candidate))) {
      fold = scale3(square, 1 / length3(square));
      break;
    }
  }
  // Map the limb's own axes (long axis, fold, and their cross) onto the aim's.
  const long = [...limb.axis] as Vec;
  const folds = [...limb.fold] as Vec;
  const local = [long, folds, cross3(long, folds)];
  const target = [d, fold, cross3(d, fold)];
  const matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 3; k += 1) {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) matrix[i * 3 + j] += target[k][i] * local[k][j];
    }
  }
  return matrix as unknown as Matrix3;
}

interface ParsedKeyframe {
  time: number;
  name?: string;
  markers: CompiledMarker[];
  easing: { style?: PoseEasingStyle; direction?: PoseEasingDirection };
  joints: Map<string, ParsedJoint>;
}

class Issues {
  readonly list: string[] = [];
  private dropped = 0;

  add(path: string, message: string): void {
    if (this.list.length < POSE_LIMITS.maxErrors) this.list.push(`${path}: ${message}`);
    else this.dropped += 1;
  }

  get count(): number {
    return this.list.length + this.dropped;
  }

  report(): string[] {
    return this.dropped > 0 ? [...this.list, `...and ${this.dropped} more`] : [...this.list];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: Issues): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.add(path, `unknown field "${key}"; expected ${allowed.join(', ')}`);
  }
}

function parseName(value: unknown, path: string, issues: Issues): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.add(path, 'must be a non-empty string');
    return undefined;
  }
  if (value.length > POSE_LIMITS.maxNameLength) {
    issues.add(path, `must be at most ${POSE_LIMITS.maxNameLength} characters`);
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    issues.add(path, 'must not contain control characters');
    return undefined;
  }
  return value;
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], path: string, issues: Issues): T | undefined {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  issues.add(path, `must be one of ${allowed.join(', ')}`);
  return undefined;
}

function parseEasing(value: unknown, path: string, issues: Issues): ParsedJoint['easing'] {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.add(path, 'must be an object with style and/or direction');
    return {};
  }
  checkKeys(value, ['style', 'direction'], path, issues);
  return {
    style: value.style === undefined ? undefined : parseEnum(value.style, POSE_EASING_STYLES, `${path}.style`, issues),
    direction: value.direction === undefined
      ? undefined
      : parseEnum(value.direction, POSE_EASING_DIRECTIONS, `${path}.direction`, issues),
  };
}

function parseVector(value: unknown, limit: number, unit: string, path: string, issues: Issues): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.add(path, `must be [x, y, z] in ${unit}`);
    return [0, 0, 0];
  }
  value.forEach((component, index) => {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      issues.add(`${path}[${index}]`, 'must be a finite number');
    } else if (Math.abs(component) > limit) {
      issues.add(`${path}[${index}]`, `must be within ±${limit} ${unit}`);
    }
  });
  return value.every((component) => typeof component === 'number' && Number.isFinite(component))
    ? [value[0], value[1], value[2]]
    : [0, 0, 0];
}

function parseMarkers(value: unknown, path: string, issues: Issues): CompiledMarker[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.add(path, 'must be an array of { name, value? }');
    return [];
  }
  if (value.length > POSE_LIMITS.maxMarkersPerKeyframe) {
    issues.add(path, `must hold at most ${POSE_LIMITS.maxMarkersPerKeyframe} markers`);
    return [];
  }
  const markers: CompiledMarker[] = [];
  value.forEach((entry, index) => {
    const markerPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.add(markerPath, 'must be an object with name and optional value');
      return;
    }
    checkKeys(entry, ['name', 'value'], markerPath, issues);
    const name = parseName(entry.name, `${markerPath}.name`, issues);
    let text = '';
    if (entry.value !== undefined) {
      if (typeof entry.value !== 'string') {
        issues.add(`${markerPath}.value`, 'must be a string');
      } else if (entry.value.length > POSE_LIMITS.maxMarkerValueLength) {
        issues.add(`${markerPath}.value`, `must be at most ${POSE_LIMITS.maxMarkerValueLength} characters`);
      } else {
        text = entry.value;
      }
    }
    if (name !== undefined) markers.push({ name, value: text });
  });
  return markers;
}

function parseJoints(value: unknown, rig: Rig, path: string, issues: Issues, allowEmpty: boolean): Map<string, ParsedJoint> {
  const joints = new Map<string, ParsedJoint>();
  if (!isRecord(value)) {
    issues.add(path, 'must be an object of joint name to pose');
    return joints;
  }
  const names = Object.keys(value);
  if (names.length === 0 && !allowEmpty) issues.add(path, 'must key at least one joint, or carry markers');
  for (const name of names) {
    const jointPath = `${path}.${name}`;
    const joint = rig.joints.find((candidate) => candidate.name === name);
    if (!joint) {
      const byPart = rig.joints.find((candidate) => candidate.childPart === name);
      issues.add(jointPath, byPart
        ? `"${name}" is a part; key the joint that moves it, "${byPart.name}"`
        : rig.name === 'R6' && R15_RIG.joints.some((candidate) => candidate.name === name)
          ? `R6 has no ${name}: its arms and legs are single blocks, and it has no waist; its joints are ${rig.joints.map((candidate) => candidate.name).join(', ')}`
          : `unknown joint; the rig's joints are ${rig.joints.map((candidate) => candidate.name).join(', ')}`);
      continue;
    }
    const pose = value[name];
    if (!isRecord(pose)) {
      issues.add(jointPath, 'must be an object with rotation, aim, bend, position and/or easing');
      continue;
    }
    checkKeys(pose, ['rotation', 'aim', 'aimAt', 'grip', 'bendToward', 'bend', 'position', 'easing'], jointPath, issues);
    const forms = (['rotation', 'aim', 'aimAt', 'grip', 'bend'] as const).filter((key) => pose[key] !== undefined);
    if (forms.length > 1) issues.add(jointPath, `give one of rotation, aim, aimAt, grip or bend, not ${forms.join(' and ')}`);
    let aimAt: ParsedJoint['aimAt'];
    let grip: ParsedJoint['grip'];
    let rotation: Matrix3 = IDENTITY_MATRIX;
    if (pose.rotation !== undefined) {
      rotation = eulerMatrix(parseVector(pose.rotation, POSE_LIMITS.maxRotationDegrees, 'degrees', `${jointPath}.rotation`, issues));
    }
    if (pose.grip !== undefined) {
      const toward = pose.bendToward === undefined ? undefined : parseVector(pose.bendToward, 1e6, 'units', `${jointPath}.bendToward`, issues);
      if (joint.name !== 'LeftShoulder' || !rig.joints.some((candidate) => candidate.name === 'Weapon')) {
        issues.add(jointPath, 'grip works on LeftShoulder, holding the weapon two-handed; use aimAt or rotation here');
      } else if (typeof pose.grip !== 'number' || !Number.isFinite(pose.grip) || Math.abs(pose.grip) > POSE_LIMITS.maxGripStuds) {
        issues.add(`${jointPath}.grip`, `must be studs along the handle from the right hand, within ±${POSE_LIMITS.maxGripStuds}`);
      } else if (toward !== undefined && length3(toward) < 1e-6) {
        issues.add(`${jointPath}.bendToward`, 'must point somewhere: [right, up, forward], not all zero');
      } else {
        grip = { along: pose.grip, ...(toward ? { toward: robloxDirection(toward) } : {}), path: `${jointPath}.grip` };
      }
    } else if (pose.aimAt !== undefined) {
      if (!rig.limbs[joint.name]) {
        issues.add(jointPath, `aimAt works on ${limbWords(rig)}; use rotation here`);
      } else {
        const target = parseVector(pose.aimAt, POSE_LIMITS.maxAimAtStuds, 'studs', `${jointPath}.aimAt`, issues);
        const toward = pose.bendToward === undefined ? undefined : parseVector(pose.bendToward, 1e6, 'units', `${jointPath}.bendToward`, issues);
        if (toward !== undefined && length3(toward) < 1e-6) issues.add(`${jointPath}.bendToward`, 'must point somewhere: [right, up, forward], not all zero');
        else aimAt = { target: robloxDirection(target), ...(toward ? { toward: robloxDirection(toward) } : {}), path: `${jointPath}.aimAt` };
      }
    } else if (pose.aim !== undefined || pose.bendToward !== undefined) {
      const limb = rig.limbs[joint.name];
      if (!limb) {
        issues.add(jointPath, `aim and bendToward work on ${limbWords(rig)}; use rotation here`);
      } else if (pose.aim === undefined) {
        issues.add(`${jointPath}.bendToward`, 'goes with aim, aimAt or grip');
      } else {
        const aim = parseVector(pose.aim, 1e6, 'units', `${jointPath}.aim`, issues);
        const toward = pose.bendToward === undefined ? undefined : parseVector(pose.bendToward, 1e6, 'units', `${jointPath}.bendToward`, issues);
        if (length3(aim) < 1e-6) issues.add(`${jointPath}.aim`, 'must point somewhere: [right, up, forward], not all zero');
        else if (toward !== undefined && length3(toward) < 1e-6) issues.add(`${jointPath}.bendToward`, 'must point somewhere: [right, up, forward], not all zero');
        else rotation = aimRotation(limb, aim, toward);
      }
    }
    if (pose.bend !== undefined) {
      const hinge = rig.hinges[joint.name];
      if (!hinge) {
        issues.add(`${jointPath}.bend`, `works on ${hingeWords(rig)}; use rotation here`);
      } else if (typeof pose.bend !== 'number' || !Number.isFinite(pose.bend) || Math.abs(pose.bend) > POSE_LIMITS.maxRotationDegrees) {
        issues.add(`${jointPath}.bend`, `must be degrees within ±${POSE_LIMITS.maxRotationDegrees}; 0 is straight`);
      } else {
        rotation = hingeMatrix(hinge, pose.bend);
      }
    }
    let position: readonly [number, number, number] = [0, 0, 0];
    if (pose.position !== undefined) {
      if (joint.name === rig.rootJoint) {
        position = parseVector(pose.position, POSE_LIMITS.maxRootOffsetStuds, 'studs', `${jointPath}.position`, issues);
      } else {
        issues.add(`${jointPath}.position`, rig.rootJoint
          ? `only ${rig.rootJoint} takes a position; other joints only rotate`
          : `no one joint moves this rig's whole body (its ${rig.rootPart} holds several), so none takes a position; joints only rotate`);
      }
    }
    // The pose is written in the body's axes at rest; a joint whose frame is
    // turned there (R6, the weapon grip, a model's own) takes it in its own.
    const transform = transformFromBody(joint, { p: [...position], r: [...rotation] as [number, number, number, number, number, number, number, number, number] });
    joints.set(joint.childPart, {
      joint,
      rotation: transform.r,
      position: transform.p,
      easing: parseEasing(pose.easing, `${jointPath}.easing`, issues),
      ...(aimAt ? { aimAt } : {}),
      ...(grip ? { grip } : {}),
    });
  }
  return joints;
}

function parseKeyframes(value: unknown, rig: Rig, issues: Issues): ParsedKeyframe[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.add('keyframes', 'must be a non-empty array');
    return [];
  }
  if (value.length > POSE_LIMITS.maxKeyframes) {
    issues.add('keyframes', `must have at most ${POSE_LIMITS.maxKeyframes} keyframes`);
    return [];
  }
  const keyframes: ParsedKeyframe[] = [];
  let previousTime: number | undefined;
  value.forEach((entry, index) => {
    const path = `keyframes[${index}]`;
    if (!isRecord(entry)) {
      issues.add(path, 'must be an object with time and joints');
      return;
    }
    checkKeys(entry, ['time', 'name', 'easing', 'joints', 'markers'], path, issues);
    const time = entry.time;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
      issues.add(`${path}.time`, 'must be a finite number of seconds, 0 or more');
    } else {
      if (index === 0 && time !== 0) issues.add(`${path}.time`, 'the first keyframe must be at time 0');
      if (previousTime !== undefined && time <= previousTime) {
        issues.add(`${path}.time`, `must be later than the previous keyframe (${previousTime})`);
      }
      if (time > POSE_LIMITS.maxDurationSeconds) {
        issues.add(`${path}.time`, `must be at most ${POSE_LIMITS.maxDurationSeconds} seconds`);
      }
      previousTime = time;
    }
    const markers = parseMarkers(entry.markers, `${path}.markers`, issues);
    keyframes.push({
      time: typeof time === 'number' ? time : 0,
      name: entry.name === undefined ? undefined : parseName(entry.name, `${path}.name`, issues),
      markers,
      easing: parseEasing(entry.easing, `${path}.easing`, issues),
      joints: parseJoints(entry.joints, rig, `${path}.joints`, issues, markers.length > 0),
    });
  });

  return keyframes;
}

// A joint's motion must start from a stated pose, not from wherever its
// first later key happens to put it.
function checkFirstKeys(keyframes: ParsedKeyframe[], complete: boolean, rig: Rig, issues: Issues, solvedBy: ReadonlyMap<string, string>): void {
  const first = complete ? keyframes[0] : undefined;
  if (!first) return;
  const late = rig.joints.filter((joint) => !first.joints.has(joint.childPart)
    && keyframes.some((keyframe) => keyframe.joints.has(joint.childPart)));
  const failed = issues.count > 0;
  for (const joint of late) {
    const by = solvedBy.get(joint.name);
    // A limb whose aimAt or grip already failed at some key has said why.
    if (by && failed) continue;
    issues.add('keyframes[0].joints', by
      ? `"${joint.name}" is set later by ${by}'s aimAt or grip, so key it, or use aimAt or grip on ${by}, in the first keyframe too`
      : `"${joint.name}" is keyed later, so it must be keyed in the first keyframe too`);
  }
}

/** The turn a hinge flexes by about its axis, as rows: Rx(degrees) for an elbow or knee. */
function hingeTurn(axis: RigHinge['axis'], degrees: number): Vec[] {
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians), s = Math.sin(radians);
  if (axis === 'Y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  if (axis === 'Z') return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

function apply(rows: Vec[], v: Vec): Vec {
  return [dot3(rows[0], v), dot3(rows[1], v), dot3(rows[2], v)];
}

type Solved = {
  rotation: Matrix3;
  /** The way the elbow or knee was turned, in the parent's axes: the next solve's preference. */
  fold: Vec;
  hinge?: { joint: RigJoint; rotation: Matrix3 };
  foot?: { joint: RigJoint; rotation: Matrix3 };
};

/** The way the body faces at a time, flat on the ground: the forward a foot is laid along. */
function heading(posed: ReturnType<typeof poseRig>, rig: Rig): Vec {
  // The body part's -Z, unless the part rests turned in the body.
  const rest = restTurn(rig, rig.body);
  const posedBody = posed.parts.get(rig.body)!.r;
  const r = rest ? multiplyRotation(posedBody, transposeRotation(rest)) : posedBody;
  const forward: Vec = [-r[2], 0, -r[8]];
  return length3(forward) > 1e-6 ? scale3(forward, 1 / length3(forward)) : [0, 0, -1];
}

/** A rotation facing `forward` along the ground, upright: a foot laid flat. */
function flatFacing(forward: Vec): Matrix3 {
  const z = scale3(forward, -1);
  const x = cross3([0, 1, 0], z);
  return [x[0], 0, z[0], x[1], 1, z[1], x[2], 0, z[2]];
}

function multiplyRotation(a: readonly number[], b: readonly number[]): Matrix3 {
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      for (let k = 0; k < 3; k += 1) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    }
  }
  return out as unknown as Matrix3;
}

function transposeRotation(a: readonly number[]): Matrix3 {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

/** A vector turned by a part's rest turn, or as it is when the part rests upright. */
function turned(rest: readonly number[] | undefined, v: Vec): Vec {
  return rest ? apply([[rest[0], rest[1], rest[2]], [rest[3], rest[4], rest[5]], [rest[6], rest[7], rest[8]]], v) : v;
}

/**
 * A joint's child part's orientation, from its parent part's and the joint's
 * Transform: parent * C0 * Transform * C1^-1, rotations only.
 */
function childTurn(parent: readonly number[], joint: RigJoint, transform: readonly number[]): Matrix3 {
  const framed = joint.parentRotation ? multiplyRotation(parent, joint.parentRotation) : parent;
  const moved = multiplyRotation(framed, transform);
  return joint.childRotation ? multiplyRotation(moved, transposeRotation(joint.childRotation)) : moved;
}

/**
 * Turns a shoulder or hip, or a declared limb's root, and bends its hinge
 * where it has one, so the limb's end lands on `target` with the body posed
 * as `posed`. Returns why not when the target is out of the limb's reach.
 */
function solveLimb(
  joint: RigJoint,
  rig: Rig,
  posed: ReturnType<typeof poseRig>,
  target: Vec,
  toward: Vec | undefined,
  time: number,
  footForward: Vec,
  hand = false,
): Solved | string {
  const limb = rig.limbs[joint.name];
  const end = (hand ? limb.hand : undefined) ?? limb.end;
  const hinge = limb.hinge ? rig.joints.find((candidate) => candidate.name === limb.hinge)! : undefined;
  const bending = limb.hinge ? rig.hinges[limb.hinge] : undefined;
  const parent = posed.parts.get(joint.parentPart)!;
  const pivot = pointToWorld(parent, joint.parentOffset);
  const away: Vec = [0, 1, 2].map((axis) => target[axis] - pivot[axis]) as Vec;
  // The target in the parent part's axes, then the body's axes at rest,
  // which the pose is written in: the same on R15 and R6.
  const r = parent.r;
  const reach = turned(restTurn(rig, joint.parentPart), [
    r[0] * away[0] + r[3] * away[1] + r[6] * away[2],
    r[1] * away[0] + r[4] * away[1] + r[7] * away[2],
    r[2] * away[0] + r[5] * away[1] + r[8] * away[2],
  ]);
  const distance = length3(reach);

  // The limb's end from its pivot, in the body's axes, as a bend puts it:
  // each part's offsets turned as the part rests, which on R15 and R6, whose
  // limbs hang in their parents' orientation, is not at all.
  const pivotInLimb = joint.childOffset as Vec;
  const upperRest = restTurn(rig, joint.childPart);
  const lowerRest = hinge ? restTurn(rig, hinge.childPart) : undefined;
  const endAt = (bend: number): Vec => {
    if (!hinge || !bending) return turned(upperRest, [0, 1, 2].map((axis) => end[axis] - pivotInLimb[axis]) as Vec);
    const upper = turned(upperRest, [0, 1, 2].map((axis) => hinge.parentOffset[axis] - pivotInLimb[axis]) as Vec);
    const lower = apply(hingeTurn(bending.axis, bending.flex * bend), turned(lowerRest, [0, 1, 2].map((axis) => end[axis] - hinge.childOffset[axis]) as Vec));
    return [0, 1, 2].map((axis) => upper[axis] + lower[axis]) as Vec;
  };
  const longest = length3(endAt(0));
  const shortest = hinge && bending ? length3(endAt(POSE_LIMITS.maxAimAtBend)) : 0;
  const what = !rig.words ? 'limb' : joint.name.endsWith('Hip') ? 'leg' : 'arm';
  const studs = (value: number) => Math.round(value * 100) / 100;
  if (distance > longest + POSE_LIMITS.aimAtToleranceStuds) {
    return `is ${studs(distance)} studs from ${joint.name}; the ${what} reaches ${studs(longest)} at most at ${studs(time)} s`;
  }
  if (distance < Math.max(shortest - POSE_LIMITS.aimAtToleranceStuds, 1e-3)) {
    return `is ${studs(distance)} studs from ${joint.name}; the ${what} cannot fold nearer than ${studs(shortest)} at ${studs(time)} s`;
  }
  // The bend whose reach is the distance: reach shrinks as the hinge folds.
  let bend = 0;
  if (hinge && bending && distance < longest) {
    let low = 0;
    let high: number = POSE_LIMITS.maxAimAtBend;
    for (let step = 0; step < 60; step += 1) {
      const middle = (low + high) / 2;
      if (length3(endAt(middle)) > distance) low = middle;
      else high = middle;
    }
    bend = (low + high) / 2;
    // A declared hinge whose reach does not shrink steadily as it folds may
    // have no bend that reaches the distance: say so rather than miss.
    if (Math.abs(length3(endAt(bend)) - distance) > POSE_LIMITS.aimAtToleranceStuds) {
      return `is ${studs(distance)} studs from ${joint.name}; the ${what} cannot bend to reach that far at ${studs(time)} s`;
    }
  }

  // Turn the limb so its end points at the target, and its fold toward
  // bendToward (or the limb's usual fold) as far as the aim allows.
  const local = endAt(bend);
  const a = scale3(local, 1 / length3(local));
  const d = scale3(reach, 1 / distance);
  const fold = [...limb.fold] as Vec;
  const square = (candidate: Vec, axis: Vec): Vec | undefined => {
    const v: Vec = [0, 1, 2].map((index) => candidate[index] - dot3(candidate, axis) * axis[index]) as Vec;
    return length3(v) > 1e-3 ? scale3(v, 1 / length3(v)) : undefined;
  };
  const p = square(fold, a) ?? square([0, 1, 0], a) ?? square([0, 0, 1], a)!;
  const f = [toward, [...limb.fold] as Vec, [0, 1, 0] as Vec, [0, 0, 1] as Vec]
    .filter((candidate): candidate is Vec => candidate !== undefined)
    .map((candidate) => square(candidate, d))
    .find((candidate) => candidate !== undefined)!;
  const localAxes = [a, p, cross3(a, p)];
  const targetAxes = [d, f, cross3(d, f)];
  const turn = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 3; k += 1) {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) turn[i * 3 + j] += targetAxes[k][i] * localAxes[k][j];
    }
  }
  const rotation = transformFromBody(joint, { p: [0, 0, 0], r: turn as Frame['r'] }).r;
  const hingeRotation = hinge && bending ? transformFromBody(hinge, { p: [0, 0, 0], r: [...hingeMatrix(bending, bend)] as Frame['r'] }).r : undefined;

  // Lay the foot flat, facing footForward: the ankle turns the foot from the
  // shin's orientation to the foot's at rest, turned to face footForward.
  // Every R15 leg joint's frame is unturned, and every R15 part rests upright.
  let foot: Solved['foot'];
  if (limb.foot && hinge && hingeRotation) {
    const ankle = rig.joints.find((candidate) => candidate.name === limb.foot)!;
    const shin = childTurn(childTurn(parent.r, joint, rotation), hinge, hingeRotation);
    const footRest = restTurn(rig, ankle.childPart);
    const flat = footRest ? multiplyRotation(flatFacing(footForward), footRest) : flatFacing(footForward);
    const inShin = multiplyRotation(transposeRotation(shin), flat);
    // The ankle's Transform, in its own frame: C0^-1 * that * C1.
    const framed = ankle.parentRotation ? multiplyRotation(transposeRotation(ankle.parentRotation), inShin) : inShin;
    foot = { joint: ankle, rotation: ankle.childRotation ? multiplyRotation(framed, ankle.childRotation) : framed };
  }
  return {
    rotation,
    fold: f,
    ...(hinge && hingeRotation ? { hinge: { joint: hinge, rotation: hingeRotation } } : {}),
    ...(foot ? { foot } : {}),
  };
}

/**
 * Solves every grip: the left hand held on the weapon's handle. The weapon is
 * posed as it plays, after every aimAt, so a right arm placed by aimAt
 * carries the grip with it. Between two keys that both grip, the handle
 * moves, so the arm is solved again every plantedStepSeconds. Returns how
 * many keys that added.
 */
function resolveGrips(
  keyframes: ParsedKeyframe[],
  animationEasing: ParsedJoint['easing'],
  rig: Rig,
  issues: Issues,
  solvedBy: Map<string, string>,
): number {
  const joint = rig.joints.find((candidate) => candidate.name === 'LeftShoulder');
  const weapon = rig.joints.find((candidate) => candidate.name === 'Weapon');
  if (!joint || !weapon || issues.count > 0) return 0;
  const grips = keyframes
    .filter((keyframe) => keyframe.joints.get(joint.childPart)?.grip)
    .map((keyframe) => ({ keyframe, grip: keyframe.joints.get(joint.childPart)!.grip! }));
  if (grips.length === 0) return 0;
  const limb = rig.limbs[joint.name];
  const hinge = limb.hinge ? rig.joints.find((candidate) => candidate.name === limb.hinge) : undefined;
  const tracks = buildTracks({ loop: false, keyframes: keyframes.map((keyframe) => compileKeyframe(keyframe, animationEasing, rig).keyframe) });
  const LINEAR = { style: 'Linear', direction: 'In' } as const;
  const solveAt = (time: number, grip: NonNullable<ParsedJoint['grip']>, previousFold?: Vec) => {
    const posed = poseRig(tracks, time, rig);
    const handle = pointToWorld(posed.parts.get(weapon.childPart)!, [0, -grip.along, 0]);
    // Without a bendToward, keep the elbow turned as it just was, so it never
    // flips round between two solves a sixtieth of a second apart.
    return solveLimb(joint, rig, posed, handle, grip.toward ?? previousFold, time, [0, 0, -1], true);
  };
  const place = (keyframe: ParsedKeyframe, solved: Solved, easing: ParsedJoint['easing']) => {
    keyframe.joints.set(joint.childPart, { joint, rotation: solved.rotation, position: [0, 0, 0], easing });
    if (solved.hinge) {
      keyframe.joints.set(solved.hinge.joint.childPart, { joint: solved.hinge.joint, rotation: solved.hinge.rotation, position: [0, 0, 0], easing });
      solvedBy.set(solved.hinge.joint.name, joint.name);
    }
  };

  for (const { keyframe, grip } of grips) {
    if (hinge && keyframe.joints.has(hinge.childPart)) issues.add(grip.path, `sets ${hinge.name} too; leave ${hinge.name} out of this keyframe`);
  }
  if (issues.count > 0) return 0;

  // One pass through time, each solve preferring the last one's elbow, so the
  // arm never flips between a key and the solves either side of it.
  const keyed = keyframes.filter((keyframe) => keyframe.joints.has(joint.childPart));
  const extra: ParsedKeyframe[] = [];
  let added = 0;
  let fold: Vec | undefined;
  for (let index = 0; index < grips.length; index += 1) {
    const { keyframe, grip } = grips[index];
    const before = grips[index - 1];
    if (before && keyed[keyed.indexOf(before.keyframe) + 1] === keyframe) {
      const span = keyframe.time - before.keyframe.time;
      const steps = Math.ceil(span / POSE_LIMITS.gripStepSeconds - 1e-9);
      for (let step = 1; step < steps; step += 1) {
        const time = round(before.keyframe.time + (span * step) / steps);
        // The grip eases from one hold to the next along the handle.
        const along = before.grip.along + ((grip.along - before.grip.along) * step) / steps;
        const solved = solveAt(time, { ...grip, along }, fold);
        if (typeof solved === 'string') {
          issues.add(grip.path, `holds the handle from ${before.keyframe.time} s, but the handle then ${solved}`);
          return 0;
        }
        const target = keyframes.find((candidate) => Math.abs(candidate.time - time) < 1e-9)
          ?? extra.find((candidate) => Math.abs(candidate.time - time) < 1e-9)
          ?? (() => {
            const created: ParsedKeyframe = { time, markers: [], easing: {}, joints: new Map() };
            extra.push(created);
            return created;
          })();
        place(target, solved, LINEAR);
        fold = solved.fold;
        added += 1;
      }
      for (const part of [joint.childPart, hinge?.childPart]) {
        const start = part ? before.keyframe.joints.get(part) : undefined;
        if (part && start) before.keyframe.joints.set(part, { ...start, easing: LINEAR });
      }
    }
    const solved = solveAt(keyframe.time, grip, fold);
    if (typeof solved === 'string') {
      issues.add(grip.path, `cannot hold the handle: it ${solved}`);
      return 0;
    }
    place(keyframe, solved, keyframe.joints.get(joint.childPart)!.easing);
    fold = solved.fold;
  }
  keyframes.push(...extra);
  keyframes.sort((a, b) => a.time - b.time);
  return added;
}

/**
 * Solves every aimAt: turns each shoulder or hip, and bends its elbow or
 * knee on R15, so the limb's end lands on the target at that keyframe's time.
 *
 * The body around the limb (Root, and the Waist on R15) is posed as it plays
 * at that time, from its own keys. No limb's parent is another limb, so the
 * order of solving does not matter.
 *
 * A limb aimed at the same point in consecutive keys is planted there: the
 * body moves between the keys, and joints interpolated on their own would let
 * a planted foot slide or sink, so the limb is solved again every
 * plantedStepSeconds between them, in keys of its own that run Linear.
 * Returns the hinges aimAt keyed, by the limb that bends them, and how many
 * keys planting added.
 */
function resolveAimAt(
  keyframes: ParsedKeyframe[],
  animationEasing: ParsedJoint['easing'],
  rig: Rig,
  issues: Issues,
): { keyframes: ParsedKeyframe[]; solvedBy: Map<string, string>; planted: number } {
  const solvedBy = new Map<string, string>();
  const pending = keyframes.some((keyframe) => [...keyframe.joints.values()].some((pose) => pose.aimAt));
  if (!pending) return { keyframes, solvedBy, planted: 0 };
  const tracks = buildTracks({ loop: false, keyframes: keyframes.map((keyframe) => compileKeyframe(keyframe, animationEasing, rig).keyframe) });
  const poses = new Map<number, ReturnType<typeof poseRig>>();
  const posedAt = (time: number) => {
    let posed = poses.get(time);
    if (!posed) {
      posed = poseRig(tracks, time, rig);
      poses.set(time, posed);
    }
    return posed;
  };
  const LINEAR = { style: 'Linear', direction: 'In' } as const;

  // Every aimAt, by limb, in time order, before any is replaced by its solution.
  const aims = new Map<string, { keyframe: ParsedKeyframe; target: Vec; toward?: Vec; path: string }[]>();
  for (const keyframe of keyframes) {
    for (const joint of rig.joints) {
      const aim = keyframe.joints.get(joint.childPart)?.aimAt;
      if (aim) aims.set(joint.name, [...(aims.get(joint.name) ?? []), { keyframe, ...aim }]);
    }
  }

  const place = (keyframe: ParsedKeyframe, joint: RigJoint, solved: Solved, easing: ParsedJoint['easing']) => {
    const pose = keyframe.joints.get(joint.childPart);
    keyframe.joints.set(joint.childPart, { joint, rotation: solved.rotation, position: [0, 0, 0], easing: pose?.easing ?? easing });
    for (const extra of [solved.hinge, solved.foot]) {
      if (!extra) continue;
      keyframe.joints.set(extra.joint.childPart, { joint: extra.joint, rotation: extra.rotation, position: [0, 0, 0], easing: pose?.easing ?? easing });
      solvedBy.set(extra.joint.name, joint.name);
    }
  };

  // A planted foot keeps the heading it was planted with; any other faces the
  // way the body does at its key.
  const headings = new Map<object, Vec>();
  for (const joint of rig.joints) {
    const list = aims.get(joint.name);
    if (!list) continue;
    const keyed = keyframes.filter((keyframe) => keyframe.joints.has(joint.childPart));
    list.forEach((aim, index) => {
      const before = list[index - 1];
      const planted = before
        && keyed[keyed.indexOf(before.keyframe) + 1] === aim.keyframe
        && [0, 1, 2].every((axis) => Math.abs(before.target[axis] - aim.target[axis]) < 1e-6);
      headings.set(aim, planted ? headings.get(before)! : heading(posedAt(aim.keyframe.time), rig));
    });
  }

  for (const joint of rig.joints) {
    const list = aims.get(joint.name);
    if (!list) continue;
    const limb = rig.limbs[joint.name];
    for (const aim of list) {
      const taken = [limb.hinge, limb.foot].find((name) => {
        const other = name ? rig.joints.find((candidate) => candidate.name === name) : undefined;
        return other !== undefined && aim.keyframe.joints.has(other.childPart);
      });
      if (taken) {
        issues.add(aim.path, `sets ${taken} too; leave ${taken} out of this keyframe`);
        continue;
      }
      const solved = solveLimb(joint, rig, posedAt(aim.keyframe.time), aim.target, aim.toward, aim.keyframe.time, headings.get(aim)!);
      if (typeof solved === 'string') {
        issues.add(aim.path, solved);
        continue;
      }
      place(aim.keyframe, joint, solved, {});
    }
  }
  if (issues.count > 0) return { keyframes, solvedBy, planted: 0 };

  // Plant limbs held on one point from one of their keys to the next.
  const extra: ParsedKeyframe[] = [];
  const at = (time: number): ParsedKeyframe => {
    const found = keyframes.find((keyframe) => Math.abs(keyframe.time - time) < 1e-9)
      ?? extra.find((keyframe) => Math.abs(keyframe.time - time) < 1e-9);
    if (found) return found;
    const created: ParsedKeyframe = { time, markers: [], easing: {}, joints: new Map() };
    extra.push(created);
    return created;
  };
  let planted = 0;
  for (const joint of rig.joints) {
    const list = aims.get(joint.name);
    if (!list) continue;
    const limb = rig.limbs[joint.name];
    const keyed = keyframes.filter((keyframe) => keyframe.joints.has(joint.childPart));
    for (let index = 1; index < list.length; index += 1) {
      const from = list[index - 1];
      const to = list[index];
      const sameKeyNext = keyed[keyed.indexOf(from.keyframe) + 1] === to.keyframe;
      const same = [0, 1, 2].every((axis) => Math.abs(from.target[axis] - to.target[axis]) < 1e-6);
      if (!sameKeyNext || !same) continue;
      const span = to.keyframe.time - from.keyframe.time;
      const steps = Math.ceil(span / POSE_LIMITS.plantedStepSeconds - 1e-9);
      for (let step = 1; step < steps; step += 1) {
        const time = round(from.keyframe.time + (span * step) / steps);
        const solved = solveLimb(joint, rig, posedAt(time), to.target, to.toward, time, headings.get(to)!);
        if (typeof solved === 'string') {
          issues.add(to.path, `holds its point from ${from.keyframe.time} s, but ${solved}`);
          break;
        }
        place(at(time), joint, solved, LINEAR);
        planted += 1;
      }
      // The key before the planted stretch runs straight to its first planted key.
      for (const name of [joint.name, limb.hinge, limb.foot]) {
        const part = rig.joints.find((candidate) => candidate.name === name)?.childPart;
        const start = part ? from.keyframe.joints.get(part) : undefined;
        if (part && start) from.keyframe.joints.set(part, { ...start, easing: LINEAR });
      }
    }
  }
  return { keyframes: [...keyframes, ...extra].sort((a, b) => a.time - b.time), solvedBy, planted };
}

/** The angle in degrees between two rotations, from their CFrame components. */
function turnDegrees(a: CFrameComponents, b: CFrameComponents): number {
  let trace = 0;
  for (let index = 3; index < 12; index += 1) trace += a[index] * b[index];
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}

/** The segment fraction at which an eased joint has come `progress` of the way. */
function easedTime(style: PoseEasingStyle, direction: PoseEasingDirection, progress: number): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 50; step += 1) {
    const middle = (low + high) / 2;
    if (easeAlpha(style, direction, middle) < progress) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * Splits every turn over maxTurnPerSegment into in-between keys of the same
 * joint, so the author writes the swing and not its arithmetic.
 *
 * The in-betweens divide the turn evenly along the short way round, and each
 * runs Linear to the next. A Linear turn splits exactly. An eased turn gets an
 * in-between every easedSplitDegrees, placed at the time its easing reaches
 * that point, so the joint still passes each at the moment the easing meant.
 * Elastic and Bounce overshoot between keys, which in-betweens cannot keep,
 * and a turn near half a turn has no clear way round: both are refused.
 *
 * An in-between keys only its own joint, so every other joint moves as
 * written. Returns the keyframes with the in-betweens merged in, and how many
 * it added.
 */
function splitTurns(
  keyframes: ParsedKeyframe[],
  animationEasing: ParsedJoint['easing'],
  rig: Rig,
  issues: Issues,
): { keyframes: ParsedKeyframe[]; added: number } {
  const extra: ParsedKeyframe[] = [];
  let added = 0;
  const at = (time: number): ParsedKeyframe => {
    const found = keyframes.find((keyframe) => Math.abs(keyframe.time - time) < 1e-9)
      ?? extra.find((keyframe) => Math.abs(keyframe.time - time) < 1e-9);
    if (found) return found;
    const created: ParsedKeyframe = { time, markers: [], easing: {}, joints: new Map() };
    extra.push(created);
    return created;
  };
  const LINEAR = { style: 'Linear', direction: 'In' } as const;

  for (const joint of rig.joints) {
    const keyed = keyframes
      .map((keyframe, index) => ({ keyframe, index }))
      .filter(({ keyframe }) => keyframe.joints.has(joint.childPart));
    for (let i = 1; i < keyed.length; i += 1) {
      const from = keyed[i - 1];
      const to = keyed[i];
      const start = from.keyframe.joints.get(joint.childPart)!;
      const end = to.keyframe.joints.get(joint.childPart)!;
      const style = start.easing.style ?? from.keyframe.easing.style ?? animationEasing.style ?? 'Linear';
      const direction = start.easing.direction ?? from.keyframe.easing.direction ?? animationEasing.direction ?? 'In';
      if (style === 'Constant') continue;
      const turn = turnDegrees(matrixCFrame(start.rotation), matrixCFrame(end.rotation));
      if (turn <= POSE_LIMITS.maxTurnPerSegment + 1e-6) continue;
      const path = `keyframes[${to.index}].joints.${joint.name}`;
      if (turn >= POSE_LIMITS.maxSplitTurn) {
        // For an arm or leg, say when most of the turn is the limb twisting
        // about itself: the usual cause is a raised arm left to fold its
        // elbow forward, which bendToward puts right.
        const limb = rig.limbs[joint.name];
        const along = (rotation: Matrix3): Vec => {
          const body = transformInBody(joint, { p: [0, 0, 0], r: [...rotation] as Frame['r'] }).r;
          return apply([[body[0], body[1], body[2]], [body[3], body[4], body[5]], [body[6], body[7], body[8]]], [...limb.axis] as Vec);
        };
        const swing = limb
          ? (Math.acos(Math.min(1, Math.max(-1, dot3(along(start.rotation), along(end.rotation))))) * 180) / Math.PI
          : undefined;
        issues.add(path, swing !== undefined && swing < POSE_LIMITS.maxSplitTurn - 10
          ? `turns ${Math.round(turn)}° from its key at ${from.keyframe.time} s: the limb swings ${Math.round(swing)}° but also twists about itself, too near half a turn to tell which way round; give bendToward so the elbow or knee keeps folding the same side (a raised arm: [0, 0, -1]), or add a keyframe partway`
          : `turns ${Math.round(turn)}° from its key at ${from.keyframe.time} s, too near half a turn to tell which way round it goes; add a keyframe partway along the way it should turn`);
        continue;
      }
      if (style === 'Elastic' || style === 'Bounce') {
        issues.add(path, `turns ${Math.round(turn)}° from its key at ${from.keyframe.time} s with ${style} easing, whose overshoot in-betweens cannot keep; split turns over ${POSE_LIMITS.maxTurnPerSegment}° across more keyframes`);
        continue;
      }
      const pieces = Math.max(
        Math.ceil(turn / POSE_LIMITS.maxTurnPerSegment),
        style === 'Linear' ? 1 : Math.ceil(turn / POSE_LIMITS.easedSplitDegrees),
      );
      const span = to.keyframe.time - from.keyframe.time;
      for (let piece = 1; piece < pieces; piece += 1) {
        const fraction = piece / pieces;
        const exact = from.keyframe.time + span * (style === 'Linear' ? fraction : easedTime(style, direction, fraction));
        const rounded = round(exact);
        const time = rounded > from.keyframe.time && rounded < to.keyframe.time ? rounded : exact;
        at(time).joints.set(joint.childPart, {
          joint,
          rotation: slerpRotation(start.rotation, end.rotation, fraction),
          position: [0, 1, 2].map((axis) => start.position[axis] + (end.position[axis] - start.position[axis]) * fraction) as [number, number, number],
          easing: LINEAR,
        });
        added += 1;
      }
      // The first key now runs straight to the first in-between.
      from.keyframe.joints.set(joint.childPart, { ...start, easing: LINEAR });
    }
  }
  const merged = [...keyframes, ...extra].sort((a, b) => a.time - b.time);
  if (merged.length > POSE_LIMITS.maxKeyframes) {
    issues.add('keyframes', `with the in-betweens its turns over ${POSE_LIMITS.maxTurnPerSegment}° need, it would have ${merged.length} keyframes; at most ${POSE_LIMITS.maxKeyframes}`);
  }
  return { keyframes: merged, added };
}

// Each joint's turn from one of its keys to the next, measured on the
// rotations as compiled.
function checkTurns(keyframes: ParsedKeyframe[], animationEasing: ParsedJoint['easing'], rig: Rig, issues: Issues): void {
  for (const joint of rig.joints) {
    let previous: { cframe: CFrameComponents; time: number; style: PoseEasingStyle } | undefined;
    keyframes.forEach((keyframe, index) => {
      const pose = keyframe.joints.get(joint.childPart);
      if (!pose) return;
      const cframe = matrixCFrame(pose.rotation);
      if (previous && previous.style !== 'Constant') {
        const turn = turnDegrees(previous.cframe, cframe);
        if (turn > POSE_LIMITS.maxTurnPerSegment + 1e-6) {
          issues.add(
            `keyframes[${index}].joints.${joint.name}`,
            `turns ${Math.round(turn)}° from its key at ${previous.time} s; split turns over ${POSE_LIMITS.maxTurnPerSegment}° across more keyframes`,
          );
        }
      }
      previous = { cframe, time: keyframe.time, style: pose.easing.style ?? keyframe.easing.style ?? animationEasing.style ?? 'Linear' };
    });
  }
}

function round(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

/** The CFrame that CFrame.new(position) * CFrame.Angles(x, y, z) builds, with the angles in degrees. */
export function poseCFrame(
  rotationDegrees: readonly [number, number, number],
  position: readonly [number, number, number] = [0, 0, 0],
): CFrameComponents {
  return matrixCFrame(eulerMatrix(rotationDegrees), position);
}

/** CFrame components from a rotation matrix and a position, rounded. */
function matrixCFrame(rotation: Matrix3, position: readonly [number, number, number] = [0, 0, 0]): CFrameComponents {
  return [position[0], position[1], position[2], ...rotation].map(round) as unknown as CFrameComponents;
}

const IDENTITY = poseCFrame([0, 0, 0]);

function compileKeyframe(
  keyframe: ParsedKeyframe,
  animationEasing: ParsedJoint['easing'],
  rig: Rig,
): { keyframe: CompiledKeyframe; poses: number } {
  const needed = new Set<string>();
  for (const part of keyframe.joints.keys()) {
    let current: string | undefined = part;
    while (current && current !== rig.rootPart && !needed.has(current)) {
      needed.add(current);
      current = rig.joints.find((joint) => joint.childPart === current)?.parentPart;
    }
  }

  let poses = 0;
  const build = (part: string, joint?: RigJoint): CompiledPose => {
    poses += 1;
    const keyed = keyframe.joints.get(part);
    const children = rig.joints
      .filter((child) => child.parentPart === part && needed.has(child.childPart))
      .map((child) => build(child.childPart, child));
    if (!keyed) {
      return {
        part,
        ...(joint ? { joint: joint.name } : {}),
        weight: 0,
        cframe: IDENTITY,
        easingStyle: 'Linear',
        easingDirection: 'In',
        children,
      };
    }
    return {
      part,
      joint: keyed.joint.name,
      weight: 1,
      cframe: matrixCFrame(keyed.rotation, keyed.position),
      easingStyle: keyed.easing.style ?? keyframe.easing.style ?? animationEasing.style ?? 'Linear',
      easingDirection: keyed.easing.direction ?? keyframe.easing.direction ?? animationEasing.direction ?? 'In',
      children,
    };
  };

  return {
    keyframe: {
      time: keyframe.time,
      ...(keyframe.name !== undefined ? { name: keyframe.name } : {}),
      ...(keyframe.markers.length > 0 ? { markers: keyframe.markers } : {}),
      root: build(rig.rootPart),
    },
    poses,
  };
}

/**
 * Validates a pose description and compiles it. Returns every problem found
 * when it is invalid; never returns a partial sequence.
 *
 * `rig` is R15 or R6, or, given `model`, that rig read from a model in
 * Studio, which the description names by the model's path.
 */
export function compilePoseAnimation(input: unknown, model?: Rig): PoseCompileResult {
  const issues = new Issues();
  if (!isRecord(input)) return { ok: false, errors: ['animation: must be an object'] };
  checkKeys(input, ['name', 'rig', 'loop', 'priority', 'easing', 'keyframes', 'duration', 'waves'], 'animation', issues);

  const name = parseName(input.name, 'name', issues);
  const rig = typeof input.rig !== 'string' ? undefined : model?.name === input.rig ? model : RIGS.get(input.rig);
  if (!rig) issues.add('rig', `must be ${[...RIGS.keys()].join(' or ')}, or the path of a rigged Model in Studio`);
  if (input.loop !== undefined && typeof input.loop !== 'boolean') issues.add('loop', 'must be true or false');
  const priority = input.priority === undefined
    ? 'Action'
    : parseEnum(input.priority, ANIMATION_PRIORITIES, 'priority', issues);
  const easing = parseEasing(input.easing, 'easing', issues);
  // Waves are written out as rotation keys first, so everything below reads
  // only keyframes.
  let described = input.keyframes;
  let unread = false;
  if (rig && (input.waves !== undefined || input.duration !== undefined)) {
    const expanded = expandWaves(input, rig, POSE_LIMITS.maxKeyframes, POSE_LIMITS.maxDurationSeconds, (path, message) => issues.add(path, message));
    described = expanded.keyframes;
    // With no hand keyframes, a wave that failed leaves nothing to read.
    unread = expanded.failed && input.keyframes === undefined;
  }
  let keyframes = rig && !unread ? parseKeyframes(described, rig, issues) : [];
  const complete = Array.isArray(described) && keyframes.length === described.length;
  let solvedBy = new Map<string, string>();
  let inBetweenCount = 0;
  if (rig && issues.count === 0) {
    const resolved = resolveAimAt(keyframes, easing, rig, issues);
    keyframes = resolved.keyframes;
    solvedBy = resolved.solvedBy;
    inBetweenCount += resolved.planted;
    inBetweenCount += resolveGrips(keyframes, easing, rig, issues, solvedBy);
  }
  if (rig) checkFirstKeys(keyframes, complete, rig, issues, solvedBy);
  if (rig && issues.count === 0) {
    const split = splitTurns(keyframes, easing, rig, issues);
    keyframes = split.keyframes;
    inBetweenCount += split.added;
    // Every turn left over the limit snaps; this only guards the split.
    if (issues.count === 0) checkTurns(keyframes, easing, rig, issues);
  }

  if (issues.count > 0 || !rig || name === undefined || priority === undefined) {
    return { ok: false, errors: issues.report() };
  }

  let poseCount = 0;
  let keyedPoseCount = 0;
  const compiled = keyframes.map((keyframe) => {
    const result = compileKeyframe(keyframe, easing, rig);
    poseCount += result.poses;
    keyedPoseCount += keyframe.joints.size;
    return result.keyframe;
  });
  const moved = new Set(keyframes.flatMap((keyframe) => [...keyframe.joints.values()].map((pose) => pose.joint.name)));

  return {
    ok: true,
    sequence: {
      name,
      rig: rig.name,
      loop: input.loop === true,
      priority,
      duration: keyframes[keyframes.length - 1].time,
      joints: rig.joints.filter((joint) => moved.has(joint.name)).map((joint) => joint.name),
      keyframes: compiled,
      poseCount,
      keyedPoseCount,
      markerCount: keyframes.reduce((total, keyframe) => total + keyframe.markers.length, 0),
      inBetweenCount,
    },
  };
}
