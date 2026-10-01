/**
 * An animation made in Blender, turned into the `animation` tool's pose
 * description (docs/creature-plan.md, step 8).
 *
 * A job's script calls `roqer.export_animation`, which samples the scene
 * frame by frame, constraints and inverse kinematics applied, and writes a
 * bake: for each joint at each moment, how it is turned from rest, as a
 * quaternion in Roblox's axes about the body's own axes, which is how a pose
 * is written. This reads the bake, keeps only the keys a joint needs to stay
 * within a tolerance of what was sampled, and writes the description. Linear
 * keys between samples replace Blender's own interpolation, so nothing about
 * its curves has to be converted.
 *
 * The bake is a script's output: data, not trusted structure.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
const numbers = (value: unknown, count: number): number[] | undefined =>
  Array.isArray(value) && value.length === count && value.every(isNumber) ? value as number[] : undefined;

/** The `animation` tool's own bounds. */
export const MAX_KEYFRAMES = 240;
export const MAX_SECONDS = 60;
/** How far a kept key's neighbours may leave a sampled pose: degrees of turn, studs of travel. */
export const TURN_TOLERANCE_DEGREES = 0.25;
export const TRAVEL_TOLERANCE_STUDS = 0.005;
/** A joint that never turns this far from rest, or travels this far, is left out. */
const STILL_DEGREES = 0.05;
const STILL_STUDS = 0.002;
const MAX_JOINTS = 64;
/** What a bake's file is named, and the description's. */
export const BAKE_SUFFIX = ".bake.json";
export const ANIMATION_SUFFIX = ".animation.json";

/** [x, y, z, w]. */
type Quaternion = [number, number, number, number];
type Vector = [number, number, number];

export type BakedJoint = Readonly<{ name: string; parent?: string; offset?: Vector }>;

export type Bake = Readonly<{
  name: string;
  rig: string;
  loop: boolean;
  joints: readonly BakedJoint[];
  /** The joint that takes the body's travel. */
  rootJoint: string;
  frames: ReadonlyArray<Readonly<{ time: number; rotations: Readonly<Record<string, Quaternion>>; travel?: Vector }>>;
}>;

/** A bake as its script wrote it, or why it cannot be read. */
export function parseBake(value: unknown): Bake | string {
  if (!isRecord(value)) return "it is not a JSON object";
  if (!isName(value.name)) return "it has no name";
  if (!isName(value.rig)) return "it does not name its rig, the model's path in Studio";
  if (!isName(value.rootJoint)) return "it does not name the joint that moves the whole body";
  if (!Array.isArray(value.joints) || value.joints.length === 0 || value.joints.length > MAX_JOINTS) return `it must list 1 to ${MAX_JOINTS} joints`;
  const joints: BakedJoint[] = [];
  for (const entry of value.joints) {
    if (!isRecord(entry) || !isName(entry.name)) return "a joint has no name";
    const offset = numbers(entry.offset, 3) as Vector | undefined;
    joints.push({ name: entry.name, ...(isName(entry.parent) && offset ? { parent: entry.parent, offset } : {}) });
  }
  if (new Set(joints.map((joint) => joint.name)).size !== joints.length) return "two joints share a name";
  if (!Array.isArray(value.frames) || value.frames.length < 2) return "it needs at least two frames";
  if (value.frames.length > MAX_KEYFRAMES) return `it has ${value.frames.length} frames; an animation has at most ${MAX_KEYFRAMES} keyframes`;
  const frames: Bake["frames"][number][] = [];
  let last = -1;
  for (const entry of value.frames) {
    if (!isRecord(entry) || !isNumber(entry.time) || !isRecord(entry.rotations)) return "a frame has no time or rotations";
    if (entry.time <= last) return "its frames' times do not rise";
    last = entry.time;
    const rotations: Record<string, Quaternion> = {};
    for (const joint of joints) {
      const q = numbers(entry.rotations[joint.name], 4);
      if (!q) return `a frame has no rotation for ${joint.name}`;
      const size = Math.hypot(q[0], q[1], q[2], q[3]);
      if (Math.abs(size - 1) > 1e-3) return `a rotation of ${joint.name} is not a unit quaternion`;
      rotations[joint.name] = [q[0] / size, q[1] / size, q[2] / size, q[3] / size];
    }
    const travel = numbers(entry.travel, 3) as Vector | undefined;
    frames.push({ time: entry.time, rotations, ...(travel ? { travel } : {}) });
  }
  if (Math.abs(frames[0].time) > 1e-9) return "its first frame is not at time 0";
  if (last > MAX_SECONDS) return `it lasts ${last.toFixed(2)} s; an animation lasts at most ${MAX_SECONDS}`;
  return { name: value.name, rig: value.rig, loop: value.loop === true, joints, rootJoint: value.rootJoint, frames };
}

const dot = (a: Quaternion, b: Quaternion) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const IDENTITY: Quaternion = [0, 0, 0, 1];

/** The angle between two rotations, in degrees. */
export function degreesBetween(a: Quaternion, b: Quaternion): number {
  return (2 * Math.acos(Math.min(1, Math.abs(dot(a, b)))) * 180) / Math.PI;
}

function slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  let cos = dot(a, b);
  const to: Quaternion = cos < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  cos = Math.abs(cos);
  if (cos > 0.9995) {
    const mixed = a.map((value, index) => value + (to[index] - value) * t) as Quaternion;
    const size = Math.hypot(...mixed);
    return mixed.map((value) => value / size) as Quaternion;
  }
  const angle = Math.acos(cos);
  const [from, toward] = [Math.sin((1 - t) * angle) / Math.sin(angle), Math.sin(t * angle) / Math.sin(angle)];
  return a.map((value, index) => value * from + to[index] * toward) as Quaternion;
}

/**
 * A rotation as the degrees a pose's `rotation` gives: about X, then Y, then
 * Z, applied as CFrame.Angles(x, y, z) is, which is Rx * Ry * Rz.
 */
export function eulerDegrees(q: Quaternion): Vector {
  const [x, y, z, w] = q;
  // The matrix's first row, and its last column.
  const m00 = 1 - 2 * (y * y + z * z);
  const m01 = 2 * (x * y - z * w);
  const m02 = 2 * (x * z + y * w);
  const m12 = 2 * (y * z - x * w);
  const m22 = 1 - 2 * (x * x + y * y);
  const degrees = (radians: number) => Math.round(((radians * 180) / Math.PI) * 100) / 100 + 0;
  if (Math.abs(m02) > 0.999999) {
    // Looking straight along X: the turn about Z folds into the one about X.
    const m10 = 2 * (x * y + z * w);
    const m11 = 1 - 2 * (x * x + z * z);
    return [degrees(Math.atan2(m10, m11) * Math.sign(m02)), degrees((Math.PI / 2) * Math.sign(m02)), 0];
  }
  return [degrees(Math.atan2(-m12, m22)), degrees(Math.asin(m02)), degrees(Math.atan2(-m01, m00))];
}

/**
 * The samples to keep so that straight runs between them stay within
 * `tolerance` of every sample: the first and last, and wherever a run strays
 * furthest, again on each side of it.
 */
export function keptSamples(count: number, error: (from: number, to: number, at: number) => number, tolerance: number): number[] {
  const kept = new Set([0, count - 1]);
  const spans: [number, number][] = [[0, count - 1]];
  while (spans.length > 0) {
    const [from, to] = spans.pop()!;
    let worst = { at: -1, error: tolerance };
    for (let at = from + 1; at < to; at += 1) {
      const off = error(from, to, at);
      if (off > worst.error) worst = { at, error: off };
    }
    if (worst.at < 0) continue;
    kept.add(worst.at);
    spans.push([from, worst.at], [worst.at, to]);
  }
  return [...kept].sort((a, b) => a - b);
}

export type BakedDescription = Readonly<{
  description: Record<string, unknown>;
  /** The joints it moves, how many keyframes and poses it has, and how many samples it was baked from. */
  joints: number;
  keyframes: number;
  poses: number;
  samples: number;
  seconds: number;
}>;

/** A bake as a pose description, each joint keyed only where it needs to be. */
export function describeBake(bake: Bake): BakedDescription {
  const times = bake.frames.map((frame) => frame.time);
  const share = (from: number, to: number, at: number) => (times[at] - times[from]) / (times[to] - times[from]);
  // time index -> joint -> pose
  const keyed = new Map<number, Record<string, { rotation?: Vector; position?: Vector }>>();
  const key = (at: number, joint: string) => {
    const frame = keyed.get(at) ?? {};
    keyed.set(at, frame);
    frame[joint] = frame[joint] ?? {};
    return frame[joint];
  };
  let poses = 0;
  const moved = new Set<string>();
  const turnKeys = (turns: Quaternion[]) =>
    keptSamples(turns.length, (from, to, at) => degreesBetween(slerp(turns[from], turns[to], share(from, to, at)), turns[at]), TURN_TOLERANCE_DEGREES);
  const turning = (turns: Quaternion[]) => turns.some((turn) => degreesBetween(turn, IDENTITY) >= STILL_DEGREES);
  // Sample 0 is always kept, so every joint the animation moves is keyed in its first keyframe.
  for (const joint of bake.joints) {
    if (joint.name === bake.rootJoint) continue;
    const turns = bake.frames.map((frame) => frame.rotations[joint.name]);
    if (!turning(turns)) continue;
    moved.add(joint.name);
    const kept = turnKeys(turns);
    for (const at of kept) key(at, joint.name).rotation = eulerDegrees(turns[at]);
    poses += kept.length;
  }
  // The joint that moves the whole body takes its travel as well as its turn,
  // and a pose with a position has a rotation too: it is keyed wherever either needs a key.
  const rootTurns = bake.frames.map((frame) => frame.rotations[bake.rootJoint] ?? IDENTITY);
  const travels = bake.frames.map((frame) => frame.travel ?? [0, 0, 0] as Vector);
  const travelling = travels.some((travel) => Math.hypot(...travel) > STILL_STUDS);
  if (travelling || turning(rootTurns)) {
    moved.add(bake.rootJoint);
    const kept = new Set(turning(rootTurns) ? turnKeys(rootTurns) : []);
    if (travelling) {
      for (const at of keptSamples(travels.length, (from, to, at) => {
        const t = share(from, to, at);
        return Math.hypot(...travels[at].map((value, axis) => value - (travels[from][axis] + (travels[to][axis] - travels[from][axis]) * t)));
      }, TRAVEL_TOLERANCE_STUDS)) kept.add(at);
    }
    for (const at of kept) {
      const pose = key(at, bake.rootJoint);
      pose.rotation = eulerDegrees(rootTurns[at]);
      if (travelling) pose.position = travels[at].map((value) => Math.round(value * 1000) / 1000 + 0) as Vector;
    }
    poses += kept.size;
  }
  const skeleton = Object.fromEntries(bake.joints.filter((joint) => moved.has(joint.name) || joint.parent !== undefined)
    .map((joint) => [joint.name, joint.parent !== undefined && joint.offset ? { parent: joint.parent, offset: joint.offset.map((value) => Math.round(value * 1000) / 1000 + 0) } : {}]));
  const keyframes = [...keyed.keys()].sort((a, b) => a - b).map((at) => ({ time: Math.round(times[at] * 10000) / 10000, joints: keyed.get(at)! }));
  return {
    description: { name: bake.name, rig: bake.rig, loop: bake.loop, easing: { style: "Linear" }, keyframes, skeleton },
    joints: moved.size,
    keyframes: keyframes.length,
    poses,
    samples: bake.frames.length,
    seconds: times[times.length - 1],
  };
}

/** One line for the job's result: what was baked, and how to use it. */
export function describeBakedFile(path: string, baked: BakedDescription): string {
  const name = String(baked.description.name);
  return `- ${path}: ${name}, ${baked.seconds.toFixed(2)} s for ${String(baked.description.rig)}, ${baked.description.loop === true ? "looping, " : ""}${baked.joints} joint${baked.joints === 1 ? "" : "s"} moving, ${baked.samples} samples kept as ${baked.keyframes} keyframes and ${baked.poses} poses`;
}
