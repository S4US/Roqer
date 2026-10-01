// The wave generator: a pose description's `waves` send a sine down a chain
// of joints (a tail, a spine, a tentacle, a pair of wings), each joint lagging
// the one before it. A wave is written out as ordinary `rotation` keys before
// anything else reads the description, so the checks, the previews and Studio
// see only keyframes.
//
// A joint a wave drives may not also be keyed by hand. Two waves may share a
// joint only about different axes, which is how an arm sways two ways at once.

import type { Generator } from './generators.js';
import type { Rig } from './rig.js';

export const WAVE_LIMITS = {
  maxWaves: 16,
  /** Keys written for each cycle of the fastest wave; between them Studio turns the joint evenly. */
  samplesPerCycle: 12,
  maxAmplitudeDegrees: 180,
  maxCycles: 20,
} as const;

const AXES = ['X', 'Y', 'Z'] as const;
type Axis = (typeof AXES)[number];

/**
 * One wave. Each joint turns about `axis`, a body axis at rest, by
 * offset + amplitude * sin(2π(cycles * t / duration - lag * index + phase)).
 */
export interface WaveSpec {
  /** The chain, from where the wave starts: joint names, each once. */
  joints: string[];
  axis: Axis;
  /** Degrees each way; [first, last] grows or fades evenly along the chain. */
  amplitude: number | [number, number];
  /** Cycles over the animation; a whole number in a loop. Defaults to 1. */
  cycles?: number;
  /** Cycles each joint trails the one before it. Defaults to 0: all together. */
  lag?: number;
  /** Degrees every joint is turned throughout, such as a curl; [first, last] as amplitude. */
  offset?: number | [number, number];
  /** Cycles the wave has already run at time 0. Defaults to 0. */
  phase?: number;
}

interface ParsedWave {
  joints: string[];
  axis: number;
  amplitude: [number, number];
  cycles: number;
  lag: number;
  offset: [number, number];
  phase: number;
}

type AddIssue = (path: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseSpan(value: unknown, limit: number, path: string, what: string, add: AddIssue): [number, number] | undefined {
  const pair = finite(value) ? [value, value] : Array.isArray(value) && value.length === 2 && value.every(finite) ? value as number[] : undefined;
  if (!pair || pair.some((entry) => Math.abs(entry) > limit)) {
    add(path, `must be ${what} within ±${limit}, or [first, last] along the chain`);
    return undefined;
  }
  return [pair[0], pair[1]];
}

function parseWave(value: unknown, rig: Rig, loop: boolean, path: string, add: AddIssue): ParsedWave | undefined {
  if (!isRecord(value)) {
    add(path, 'must be { joints, axis, amplitude, cycles?, lag?, offset?, phase? }');
    return undefined;
  }
  let ok = true;
  const fail = (at: string, message: string) => { ok = false; add(at, message); };
  const allowed = ['joints', 'axis', 'amplitude', 'cycles', 'lag', 'offset', 'phase'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `unknown field "${key}"; expected ${allowed.join(', ')}`);
  }
  const joints: string[] = [];
  if (!Array.isArray(value.joints) || value.joints.length === 0) {
    fail(`${path}.joints`, 'must list the chain\'s joints, from where the wave starts');
  } else {
    value.joints.forEach((name, index) => {
      if (typeof name !== 'string' || !rig.joints.some((joint) => joint.name === name)) {
        const byPart = rig.joints.find((joint) => joint.childPart === name);
        fail(`${path}.joints[${index}]`, byPart
          ? `"${String(name)}" is a part; name the joint that moves it, "${byPart.name}"`
          : `unknown joint; the rig's joints are ${rig.joints.map((joint) => joint.name).join(', ')}`);
      } else if (joints.includes(name)) {
        fail(`${path}.joints[${index}]`, `"${name}" is in the chain twice`);
      } else {
        joints.push(name);
      }
    });
  }
  const axis = AXES.indexOf(value.axis as Axis);
  if (axis < 0) fail(`${path}.axis`, 'must be X, Y or Z: the body axis at rest the joints turn about');
  const amplitude = parseSpan(value.amplitude, WAVE_LIMITS.maxAmplitudeDegrees, `${path}.amplitude`, 'degrees', add);
  const offset = value.offset === undefined ? [0, 0] as [number, number] : parseSpan(value.offset, WAVE_LIMITS.maxAmplitudeDegrees, `${path}.offset`, 'degrees', add);
  if (!amplitude || !offset) ok = false;
  let cycles = 1;
  if (value.cycles !== undefined) {
    if (!finite(value.cycles) || value.cycles <= 0 || value.cycles > WAVE_LIMITS.maxCycles) {
      fail(`${path}.cycles`, `must be more than 0 and at most ${WAVE_LIMITS.maxCycles}`);
    } else if (loop && !Number.isInteger(value.cycles)) {
      fail(`${path}.cycles`, 'must be a whole number in a loop, so the wave meets itself at the seam');
    } else {
      cycles = value.cycles;
    }
  }
  // A phase past one cycle is the same wave, so any is taken; a lag is not.
  const fraction = (key: 'lag' | 'phase', limit: number): number => {
    const given = value[key];
    if (given === undefined) return 0;
    if (!finite(given) || Math.abs(given) > limit) {
      fail(`${path}.${key}`, `must be cycles within ±${limit}`);
      return 0;
    }
    return given;
  };
  const lag = fraction('lag', 1);
  const phase = fraction('phase', 100);
  return ok && amplitude && offset ? { joints, axis, amplitude, cycles, lag, offset, phase } : undefined;
}

const round = (value: number, places: number) => {
  const scale = 10 ** places;
  const rounded = Math.round(value * scale) / scale;
  return rounded === 0 ? 0 : rounded;
};


/**
 * Reads a description's waves as a generator of rotation keys. Every problem
 * is reported through `fail`; undefined means the waves cannot be written.
 */
export function parseWaves(value: unknown, rig: Rig, loop: boolean, fail: AddIssue): Generator | undefined {
  const waves: ParsedWave[] = [];
  let ok = true;
  const add: AddIssue = (path, message) => { ok = false; fail(path, message); };
  if (!Array.isArray(value) || value.length === 0 || value.length > WAVE_LIMITS.maxWaves) {
    add('waves', `must list 1 to ${WAVE_LIMITS.maxWaves} waves: { joints, axis, amplitude, cycles?, lag?, offset?, phase? }`);
    return undefined;
  }
  value.forEach((entry, index) => {
    const wave = parseWave(entry, rig, loop, `waves[${index}]`, add);
    if (!wave) return;
    for (const name of wave.joints) {
      const other = waves.findIndex((earlier) => earlier.axis === wave.axis && earlier.joints.includes(name));
      if (other >= 0) add(`waves[${index}].joints`, `"${name}" already turns about ${AXES[wave.axis]} in waves[${other}]; two waves share a joint only about different axes`);
    }
    waves.push(wave);
  });
  if (!ok) return undefined;
  const owners = new Map<string, string>();
  waves.forEach((wave, index) => wave.joints.forEach((name) => {
    if (!owners.has(name)) owners.set(name, `waves[${index}] drives this joint; take it out of the wave or do not key it by hand`);
  }));
  return {
    name: 'waves',
    joints: [...owners.keys()],
    owners,
    steps: () => Math.ceil(WAVE_LIMITS.samplesPerCycle * Math.max(...waves.map((wave) => wave.cycles))),
    tooMany: 'use fewer cycles',
    pose: (name, time, duration) => {
      const rotation = [0, 0, 0];
      for (const wave of waves) {
        const index = wave.joints.indexOf(name);
        if (index < 0) continue;
        const along = wave.joints.length > 1 ? index / (wave.joints.length - 1) : 0;
        const amplitude = wave.amplitude[0] + (wave.amplitude[1] - wave.amplitude[0]) * along;
        const offset = wave.offset[0] + (wave.offset[1] - wave.offset[0]) * along;
        rotation[wave.axis] += offset + amplitude * Math.sin(2 * Math.PI * ((wave.cycles * time) / duration - wave.lag * index + wave.phase));
      }
      return { rotation: rotation.map((degrees) => round(degrees, 3)), easing: { style: 'Linear' } };
    },
  };
}