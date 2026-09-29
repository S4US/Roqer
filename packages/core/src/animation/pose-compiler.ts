// Turns a compact pose description into a KeyframeSequence description.
//
// The input names joints ("RightShoulder") and gives each keyed joint a
// rotation in degrees, or, for a limb, the direction it points (`aim`) or how
// far its elbow or knee flexes (`bend`). The output is keyed by part name, as a KeyframeSequence
// is: a pose on a joint moves the joint's child part. The second animation
// spike showed that a part-keyed sequence drives AnimationConstraint joints as
// it drives Motor6D ones, so nothing here writes joint objects.
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
import { slerpRotation } from './motion.js';
import { R15_RIG, type Rig, type RigJoint } from './r15-rig.js';

export { POSE_EASING_DIRECTIONS, POSE_EASING_STYLES, type PoseEasingDirection, type PoseEasingStyle };

export const ANIMATION_PRIORITIES = ['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4'] as const;
export type AnimationPriority = (typeof ANIMATION_PRIORITIES)[number];

export const POSE_LIMITS = {
  maxKeyframes: 240,
  maxDurationSeconds: 60,
  maxNameLength: 100,
  maxRotationDegrees: 360,
  maxRootOffsetStuds: 20,
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

const RIGS: ReadonlyMap<string, Rig> = new Map([['R15', R15_RIG]]);

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
  /** Degrees about the parent part's X, Y and Z axes, applied as CFrame.Angles does. */
  rotation?: [number, number, number];
  /**
   * Shoulders and hips: the direction the limb points, as [right, up, forward]
   * in the parent part's frame (the character's, while the torso is upright).
   * [0, -1, 0] hangs it at rest.
   */
  aim?: [number, number, number];
  /**
   * With `aim`: the way the elbow or knee folds, as [right, up, forward].
   * Defaults to forward for arms and back for legs, as they fold at rest.
   */
  bendToward?: [number, number, number];
  /** Elbows and knees: how far the joint flexes, in degrees; 0 is straight. */
  bend?: number;
  /** Studs. Only the Root joint takes one: it offsets the whole body. */
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
  rig: 'R15';
  /** Defaults to false. */
  loop?: boolean;
  /** Defaults to Action, as a new KeyframeSequence does. */
  priority?: AnimationPriority;
  easing?: PoseEasing;
  keyframes: PoseKeyframeSpec[];
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
  rig: 'R15';
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
  /** Keys the compiler added to split turns over maxTurnPerSegment. */
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

/**
 * The limbs `aim` and `bend` understand. `fold` is where the limb's lower
 * half swings, in the upper part's own frame, when the elbow or knee flexes:
 * a forearm folds forward (-Z), a shin back (+Z). `defaultBend` is the fold
 * as [right, up, forward], used when a pose gives no `bendToward`.
 */
const LIMBS: Readonly<Record<string, { fold: Vec; defaultBend: Vec }>> = {
  LeftShoulder: { fold: [0, 0, -1], defaultBend: [0, 0, 1] },
  RightShoulder: { fold: [0, 0, -1], defaultBend: [0, 0, 1] },
  LeftHip: { fold: [0, 0, 1], defaultBend: [0, 0, -1] },
  RightHip: { fold: [0, 0, 1], defaultBend: [0, 0, -1] },
};
/** The hinges `bend` understands, and the sign of the X rotation that flexes each. */
const HINGES: Readonly<Record<string, 1 | -1>> ={ LeftElbow: 1, RightElbow: 1, LeftKnee: -1, RightKnee: -1 };

/**
 * The rotation that points a limb's long axis (-Y in its own frame) along
 * `aim` and turns its fold toward `bendToward`, both [right, up, forward] in
 * the parent part's frame. The fold is taken square to the aim; when the two
 * run together, the limb's usual fold is used, then up, then back.
 */
export function aimRotation(jointName: string, aim: readonly [number, number, number], bendToward?: readonly [number, number, number]): Matrix3 {
  const limb = LIMBS[jointName];
  if (!limb) throw new Error(`${jointName} cannot aim`);
  const d = scale3(robloxDirection(aim), 1 / length3(robloxDirection(aim)));
  const candidates: Vec[] = [
    ...(bendToward ? [robloxDirection(bendToward)] : []),
    robloxDirection(limb.defaultBend),
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
  const long: Vec = [0, -1, 0];
  const local = [long, limb.fold, cross3(long, limb.fold)];
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
        : `unknown joint; the rig's joints are ${rig.joints.map((candidate) => candidate.name).join(', ')}`);
      continue;
    }
    const pose = value[name];
    if (!isRecord(pose)) {
      issues.add(jointPath, 'must be an object with rotation, aim, bend, position and/or easing');
      continue;
    }
    checkKeys(pose, ['rotation', 'aim', 'bendToward', 'bend', 'position', 'easing'], jointPath, issues);
    const forms = (['rotation', 'aim', 'bend'] as const).filter((key) => pose[key] !== undefined);
    if (forms.length > 1) issues.add(jointPath, `give one of rotation, aim or bend, not ${forms.join(' and ')}`);
    let rotation: Matrix3 = IDENTITY_MATRIX;
    if (pose.rotation !== undefined) {
      rotation = eulerMatrix(parseVector(pose.rotation, POSE_LIMITS.maxRotationDegrees, 'degrees', `${jointPath}.rotation`, issues));
    }
    if (pose.aim !== undefined || pose.bendToward !== undefined) {
      if (!LIMBS[joint.name]) {
        issues.add(jointPath, 'aim and bendToward work on shoulders and hips; use rotation here');
      } else if (pose.aim === undefined) {
        issues.add(`${jointPath}.bendToward`, 'goes with aim');
      } else {
        const aim = parseVector(pose.aim, 1e6, 'units', `${jointPath}.aim`, issues);
        const toward = pose.bendToward === undefined ? undefined : parseVector(pose.bendToward, 1e6, 'units', `${jointPath}.bendToward`, issues);
        if (length3(aim) < 1e-6) issues.add(`${jointPath}.aim`, 'must point somewhere: [right, up, forward], not all zero');
        else if (toward !== undefined && length3(toward) < 1e-6) issues.add(`${jointPath}.bendToward`, 'must point somewhere: [right, up, forward], not all zero');
        else rotation = aimRotation(joint.name, aim, toward);
      }
    }
    if (pose.bend !== undefined) {
      const flex = HINGES[joint.name];
      if (!flex) {
        issues.add(`${jointPath}.bend`, 'works on elbows and knees; use rotation here');
      } else if (typeof pose.bend !== 'number' || !Number.isFinite(pose.bend) || Math.abs(pose.bend) > POSE_LIMITS.maxRotationDegrees) {
        issues.add(`${jointPath}.bend`, `must be degrees within ±${POSE_LIMITS.maxRotationDegrees}; 0 is straight`);
      } else {
        rotation = eulerMatrix([flex * pose.bend, 0, 0]);
      }
    }
    let position: readonly [number, number, number] = [0, 0, 0];
    if (pose.position !== undefined) {
      if (joint.name === rig.joints[0].name) {
        position = parseVector(pose.position, POSE_LIMITS.maxRootOffsetStuds, 'studs', `${jointPath}.position`, issues);
      } else {
        issues.add(`${jointPath}.position`, `only ${rig.joints[0].name} takes a position; other joints only rotate`);
      }
    }
    joints.set(joint.childPart, {
      joint,
      rotation,
      position,
      easing: parseEasing(pose.easing, `${jointPath}.easing`, issues),
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

  // A joint's motion must start from a stated pose, not from wherever its
  // first later key happens to put it.
  const first = keyframes.length === value.length ? keyframes[0] : undefined;
  if (first) {
    const late = rig.joints.filter((joint) => !first.joints.has(joint.childPart)
      && keyframes.some((keyframe) => keyframe.joints.has(joint.childPart)));
    for (const joint of late) {
      issues.add('keyframes[0].joints', `"${joint.name}" is keyed later, so it must be keyed in the first keyframe too`);
    }
  }
  return keyframes;
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
        issues.add(path, `turns ${Math.round(turn)}° from its key at ${from.keyframe.time} s, too near half a turn to tell which way round it goes; add a keyframe partway along the way it should turn`);
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
 */
export function compilePoseAnimation(input: unknown): PoseCompileResult {
  const issues = new Issues();
  if (!isRecord(input)) return { ok: false, errors: ['animation: must be an object'] };
  checkKeys(input, ['name', 'rig', 'loop', 'priority', 'easing', 'keyframes'], 'animation', issues);

  const name = parseName(input.name, 'name', issues);
  const rig = typeof input.rig === 'string' ? RIGS.get(input.rig) : undefined;
  if (!rig) issues.add('rig', `must be one of ${[...RIGS.keys()].join(', ')}`);
  if (input.loop !== undefined && typeof input.loop !== 'boolean') issues.add('loop', 'must be true or false');
  const priority = input.priority === undefined
    ? 'Action'
    : parseEnum(input.priority, ANIMATION_PRIORITIES, 'priority', issues);
  const easing = parseEasing(input.easing, 'easing', issues);
  let keyframes = rig ? parseKeyframes(input.keyframes, rig, issues) : [];
  let inBetweenCount = 0;
  if (rig && issues.count === 0) {
    const split = splitTurns(keyframes, easing, rig, issues);
    keyframes = split.keyframes;
    inBetweenCount = split.added;
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
      rig: 'R15',
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
