// Generators write what would otherwise be dozens of hand-written keys: a
// description's `waves` (wave.ts) and its `gait` (gait.ts). Each is written
// out as ordinary poses, among any hand keyframes, before anything else reads
// the description, so the compiler, the checks, the previews and Studio see
// only keyframes.
//
// A joint a generator drives may not also be keyed by hand or driven by the
// other generator; the error names the joint.

import { parseGait } from './gait.js';
import type { Rig } from './rig.js';
import { parseWaves } from './wave.js';

/** A hand keyframe this close to a generated key carries it, so no two keyframes crowd. */
export const GENERATOR_SNAP_SECONDS = 1 / 240;

export interface Generator {
  /** The description's field: `waves` or `gait`. */
  name: string;
  /** The joints it writes a pose for at each of its keys. */
  joints: readonly string[];
  /** Every joint nothing else may key, those it sets by solving included, with why. */
  owners: ReadonlyMap<string, string>;
  /** How many even steps its keys divide the animation into. */
  steps(duration: number): number;
  /** What to change when its keys are too many. */
  tooMany: string;
  /** A joint's pose at a time, as a hand-written pose would be. */
  pose(joint: string, time: number, duration: number): Record<string, unknown>;
}

type AddIssue = (path: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Writes a description's waves and gait out as poses. Returns the keyframes
 * to compile: the hand keyframes with the generated keys among them. Every
 * problem is reported through `add`; with any, the hand keyframes come back
 * as they were given, and `failed` is true.
 */
export function expandGenerators(
  input: Record<string, unknown>,
  rig: Rig,
  maxKeyframes: number,
  maxDurationSeconds: number,
  add: AddIssue,
): { keyframes: unknown; failed: boolean } {
  let failed = false;
  const fail = (path: string, message: string) => { failed = true; add(path, message); };
  const given = input.keyframes;
  if (input.waves === undefined && input.gait === undefined) {
    fail('duration', 'goes with waves or gait; without them the last keyframe\'s time is the animation\'s length');
    return { keyframes: given, failed };
  }
  const generators: Generator[] = [];
  if (input.gait !== undefined) {
    const gait = parseGait(input.gait, rig, fail);
    if (gait) generators.push(gait);
  }
  if (input.waves !== undefined) {
    const waves = parseWaves(input.waves, rig, input.loop === true, fail);
    if (waves) {
      for (const name of waves.joints) {
        if (generators[0]?.owners.has(name)) fail('waves', `"${name}" is the gait's: ${generators[0].owners.get(name)}`);
      }
      generators.push(waves);
    }
  }

  // The hand keyframes, as far as they can be read; the compiler reports what
  // is wrong with them.
  if (given !== undefined && !Array.isArray(given)) return { keyframes: given, failed };
  const hand = (given ?? []) as unknown[];
  let lastTime = 0;
  hand.forEach((keyframe, index) => {
    if (!isRecord(keyframe)) return;
    if (finite(keyframe.time)) lastTime = Math.max(lastTime, keyframe.time);
    if (!isRecord(keyframe.joints)) return;
    for (const name of Object.keys(keyframe.joints)) {
      const why = generators.map((generator) => generator.owners.get(name)).find((owner) => owner !== undefined);
      if (why !== undefined) fail(`keyframes[${index}].joints.${name}`, why);
    }
  });
  const what = [input.waves !== undefined ? 'waves' : undefined, input.gait !== undefined ? 'a gait' : undefined].filter(Boolean).join(' and ');
  let duration = lastTime;
  if (input.duration !== undefined) {
    if (!finite(input.duration) || input.duration <= 0 || input.duration > maxDurationSeconds) {
      fail('duration', `must be seconds, more than 0 and at most ${maxDurationSeconds}`);
    } else if (input.duration < lastTime) {
      fail('duration', `must not be before the last keyframe (${lastTime})`);
    } else {
      duration = input.duration;
    }
  } else if (lastTime <= 0) {
    fail('duration', `${what} ${what === 'a gait' ? 'needs' : 'need'} the animation's length: give duration in seconds, or a last keyframe`);
  }
  if (failed) return { keyframes: given, failed };

  const keyframes: Array<Record<string, unknown>> = hand.map((keyframe) => (isRecord(keyframe)
    ? { ...keyframe, joints: isRecord(keyframe.joints) ? { ...keyframe.joints } : keyframe.joints }
    : keyframe as Record<string, unknown>));
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const written: Array<{ generator: Generator; keyframes: Array<Record<string, unknown>> }> = [];
  for (const generator of generators) {
    const steps = generator.steps(duration);
    const sampled: Array<Record<string, unknown>> = [];
    for (let step = 0; step <= steps; step += 1) {
      const time = step === steps ? duration : round((duration * step) / steps);
      let keyframe = keyframes.find((candidate) => isRecord(candidate) && finite(candidate.time) && Math.abs(candidate.time - time) <= GENERATOR_SNAP_SECONDS);
      if (!keyframe) {
        keyframe = { time, joints: {} };
        keyframes.push(keyframe);
      }
      if (!sampled.includes(keyframe)) sampled.push(keyframe);
    }
    if (keyframes.length > maxKeyframes) {
      fail(generator.name, `${generator.name === 'gait' ? 'its' : 'their'} keys make ${keyframes.length} keyframes, over the ${maxKeyframes} an animation may have; ${generator.tooMany}`);
      return { keyframes: given, failed };
    }
    written.push({ generator, keyframes: sampled });
  }
  for (const { generator, keyframes: sampled } of written) {
    for (const keyframe of sampled) {
      if (!isRecord(keyframe.joints)) continue;
      // A loop's last key is its first, exactly.
      const time = input.loop === true && keyframe.time === duration ? 0 : keyframe.time as number;
      for (const name of generator.joints) keyframe.joints[name] = generator.pose(name, time, duration);
    }
  }
  keyframes.sort((a, b) => (isRecord(a) && isRecord(b) && finite(a.time) && finite(b.time) ? a.time - b.time : 0));
  return { keyframes, failed };
}
