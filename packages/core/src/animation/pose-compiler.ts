// Turns a compact pose description into a KeyframeSequence description.
//
// The input names joints ("RightShoulder") and gives each keyed joint a
// rotation in degrees. The output is keyed by part name, as a KeyframeSequence
// is: a pose on a joint moves the joint's child part. The second animation
// spike showed that a part-keyed sequence drives AnimationConstraint joints as
// it drives Motor6D ones, so nothing here writes joint objects.
//
// The whole animation is validated before anything is compiled, and every
// problem is reported at once with its path, so a caller can fix them in one
// pass. Nothing here touches Studio.

import { R15_RIG, type Rig, type RigJoint } from './r15-rig.js';

export const ANIMATION_PRIORITIES = ['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4'] as const;
export const POSE_EASING_STYLES = ['Linear', 'Constant', 'Elastic', 'Cubic', 'Bounce', 'CubicV2'] as const;
export const POSE_EASING_DIRECTIONS = ['In', 'Out', 'InOut'] as const;

export type AnimationPriority = (typeof ANIMATION_PRIORITIES)[number];
export type PoseEasingStyle = (typeof POSE_EASING_STYLES)[number];
export type PoseEasingDirection = (typeof POSE_EASING_DIRECTIONS)[number];

export const POSE_LIMITS = {
  maxKeyframes: 240,
  maxDurationSeconds: 60,
  maxNameLength: 100,
  maxRotationDegrees: 360,
  maxRootOffsetStuds: 20,
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

export interface JointPoseSpec {
  /** Degrees about the parent part's X, Y and Z axes, applied as CFrame.Angles does. Omitted means the rest pose. */
  rotation?: [number, number, number];
  /** Studs. Only the Root joint takes one: it offsets the whole body. */
  position?: [number, number, number];
  easing?: PoseEasing;
}

export interface PoseKeyframeSpec {
  /** Seconds from the start. The first keyframe is at 0, and times increase. */
  time: number;
  /** Optional Keyframe name, which KeyframeReached reports. */
  name?: string;
  easing?: PoseEasing;
  joints: Record<string, JointPoseSpec>;
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

export interface CompiledKeyframe {
  time: number;
  name?: string;
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
}

export type PoseCompileResult =
  | { ok: true; sequence: KeyframeSequenceDescription }
  | { ok: false; errors: string[] };

interface ParsedJoint {
  joint: RigJoint;
  rotation: readonly [number, number, number];
  position: readonly [number, number, number];
  easing: { style?: PoseEasingStyle; direction?: PoseEasingDirection };
}

interface ParsedKeyframe {
  time: number;
  name?: string;
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

function parseJoints(value: unknown, rig: Rig, path: string, issues: Issues): Map<string, ParsedJoint> {
  const joints = new Map<string, ParsedJoint>();
  if (!isRecord(value)) {
    issues.add(path, 'must be an object of joint name to pose');
    return joints;
  }
  const names = Object.keys(value);
  if (names.length === 0) issues.add(path, 'must key at least one joint');
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
      issues.add(jointPath, 'must be an object with rotation, position and/or easing');
      continue;
    }
    checkKeys(pose, ['rotation', 'position', 'easing'], jointPath, issues);
    const rotation = pose.rotation === undefined
      ? [0, 0, 0] as const
      : parseVector(pose.rotation, POSE_LIMITS.maxRotationDegrees, 'degrees', `${jointPath}.rotation`, issues);
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
    checkKeys(entry, ['time', 'name', 'easing', 'joints'], path, issues);
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
    keyframes.push({
      time: typeof time === 'number' ? time : 0,
      name: entry.name === undefined ? undefined : parseName(entry.name, `${path}.name`, issues),
      easing: parseEasing(entry.easing, `${path}.easing`, issues),
      joints: parseJoints(entry.joints, rig, `${path}.joints`, issues),
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

function round(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

/** The CFrame that CFrame.new(position) * CFrame.Angles(x, y, z) builds, with the angles in degrees. */
export function poseCFrame(
  rotationDegrees: readonly [number, number, number],
  position: readonly [number, number, number] = [0, 0, 0],
): CFrameComponents {
  const [x, y, z] = rotationDegrees.map((degrees) => (degrees * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  // Rx * Ry * Rz, row-major.
  return [
    position[0], position[1], position[2],
    cy * cz, -cy * sz, sy,
    sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy,
    -cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy,
  ].map(round) as unknown as CFrameComponents;
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
      cframe: poseCFrame(keyed.rotation, keyed.position),
      easingStyle: keyed.easing.style ?? keyframe.easing.style ?? animationEasing.style ?? 'Linear',
      easingDirection: keyed.easing.direction ?? keyframe.easing.direction ?? animationEasing.direction ?? 'In',
      children,
    };
  };

  return {
    keyframe: {
      time: keyframe.time,
      ...(keyframe.name !== undefined ? { name: keyframe.name } : {}),
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
  const keyframes = rig ? parseKeyframes(input.keyframes, rig, issues) : [];

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
    },
  };
}
