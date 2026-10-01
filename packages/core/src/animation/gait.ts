// The gait generator: a pose description's `gait` walks every leg of a rig
// from a few numbers. One cycle fills the animation. Each leg's end is placed
// with `aimAt`, every 1/30 s: while its foot is down it travels straight back
// along the ground under the body, as the ground does under a body that
// walks in place, and while it is up it swings forward along an arc. The body
// rides just low enough for the legs to reach the stride, and bobs twice a
// cycle. A leg modelled straight has no slack, so any stride lowers the body
// and bends its knees; a leg modelled bent at rest strides by straightening,
// and the body stays where it stands.
//
// The legs are the rig's limbs that end in one of its feet. Which leg steps
// when comes from the pattern and from where each leg stands at rest: its
// side, and its place from front to back.

import type { Generator } from './generators.js';
import { limbReach } from './limb-reach.js';
import { pointToWorld, restPose } from './motion.js';
import type { Rig } from './rig.js';

export const GAIT_PATTERNS = ['walk', 'trot', 'pace', 'bound', 'gallop'] as const;
export type GaitPattern = (typeof GAIT_PATTERNS)[number];

export const GAIT_LIMITS = {
  /** How often every leg is placed again, in seconds. */
  stepSeconds: 1 / 30,
  maxStrideStuds: 20,
  /** The share of a straight leg's length it may be asked to reach. */
  reach: 0.985,
  /** The share of its legs' height the body may sink to reach a stride. */
  maxDrop: 0.5,
  /** The share of the cycle a foot is down, by pattern, unless `duty` says. */
  duty: { walk: 0.65, trot: 0.5, pace: 0.5, bound: 0.4, gallop: 0.35 },
  /** A foot's lift and the body's bob, as shares of the legs' height, unless given. */
  lift: 0.18,
  bob: 0.03,
} as const;

/** A gait, one cycle long. */
export interface GaitSpec {
  /**
   * walk: one foot after another, each side's from back to front. trot:
   * diagonal feet together. pace: each side's feet together. bound: hind feet
   * together, then front. gallop: a bound with the right feet just after the
   * left. On two legs, walk, trot and pace all alternate them.
   */
  pattern: GaitPattern;
  /** Studs a foot travels on the ground each cycle; negative walks backward. */
  stride: number;
  /** Studs a foot rises at the top of its swing. */
  lift?: number;
  /** The share of the cycle a foot is down, 0.1 to 0.9. */
  duty?: number;
  /** Studs the body rises and falls, twice a cycle. */
  bob?: number;
  /** Studs lower the body rides throughout, for a stalk or a sneak. */
  crouch?: number;
  /** When each leg's foot comes down, as a share of the cycle, by limb joint: overrides the pattern. */
  phases?: Record<string, number>;
  /** The limb joints that step, when not every limb ending in a foot. */
  limbs?: string[];
}

type AddIssue = (path: string, message: string) => void;
type Vec = [number, number, number];

interface Leg {
  joint: string;
  hinged: boolean;
  /** The limb's end and its root's pivot at rest, in the root part's frame. */
  end: Vec;
  pivot: Vec;
  length: number;
  phase: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const round = (value: number, places = 4) => {
  const scale = 10 ** places;
  const rounded = Math.round(value * scale) / scale;
  return rounded === 0 ? 0 : rounded;
};

/** When each leg's foot comes down, from the pattern and where the legs stand. */
function patternPhases(pattern: GaitPattern, legs: readonly { end: Vec }[]): number[] {
  // Side 0 is the left (and the middle), 1 the right; rank counts from the front.
  const side = legs.map((leg) => (leg.end[0] > 1e-3 ? 1 : 0));
  const rank = legs.map((leg, index) => legs.filter((other, at) => side[at] === side[index] && other.end[2] < leg.end[2] - 1e-3).length);
  const pairs = Math.max(...rank) + 1;
  return legs.map((_leg, index) => {
    const fromBack = pairs - 1 - rank[index];
    const bound = pairs > 1 ? (0.5 * fromBack) / (pairs - 1) : 0;
    switch (pattern) {
      case 'walk': return side[index] * 0.5 + fromBack / (2 * pairs);
      case 'trot': return ((rank[index] + side[index]) % 2) * 0.5;
      case 'pace': return side[index] * 0.5;
      case 'bound': return bound;
      default: return bound + side[index] * 0.1;
    }
  });
}

/**
 * Reads a description's gait as a generator of aimAt keys. Every problem is
 * reported through `fail`; undefined means the gait cannot be written.
 */
export function parseGait(value: unknown, rig: Rig, fail: AddIssue): Generator | undefined {
  const fields = ['pattern', 'stride', 'lift', 'duty', 'bob', 'crouch', 'phases', 'limbs'];
  if (!isRecord(value)) {
    fail('gait', `must be { ${fields.map((field, index) => (index < 2 ? field : `${field}?`)).join(', ')} }`);
    return undefined;
  }
  let ok = true;
  const add: AddIssue = (path, message) => { ok = false; fail(path, message); };
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) add('gait', `unknown field "${key}"; expected ${fields.join(', ')}`);
  }
  const pattern = GAIT_PATTERNS.includes(value.pattern as GaitPattern) ? value.pattern as GaitPattern : undefined;
  if (!pattern) add('gait.pattern', `must be one of ${GAIT_PATTERNS.join(', ')}`);
  const number = (key: string, low: number, high: number, what: string): number | undefined => {
    const given = value[key];
    if (given === undefined) return undefined;
    if (typeof given !== 'number' || !Number.isFinite(given) || given < low || given > high) {
      add(`gait.${key}`, `must be ${what}, ${low} to ${high}`);
      return undefined;
    }
    return given;
  };
  const stride = value.stride === undefined ? undefined : number('stride', -GAIT_LIMITS.maxStrideStuds, GAIT_LIMITS.maxStrideStuds, 'studs');
  if (value.stride === undefined || stride === 0) add('gait.stride', 'must be the studs a foot travels on the ground each cycle, and not 0');
  const lift = number('lift', 0, 10, 'studs');
  const duty = number('duty', 0.1, 0.9, 'the share of the cycle a foot is down');
  const bob = number('bob', 0, 5, 'studs');
  const crouch = number('crouch', 0, 10, 'studs') ?? 0;

  // The legs: the limbs named, or every limb that ends in a foot.
  const root = rig.joints.find((joint) => joint.name === rig.rootJoint);
  if (!root) add('gait', `needs one joint that moves the whole body, to set how high it rides; this rig's ${rig.rootPart} holds several parts`);
  const jointNamed = (name: string | undefined) => rig.joints.find((joint) => joint.name === name);
  const endPart = (name: string) => jointNamed(rig.limbs[name].hinge)?.childPart ?? jointNamed(name)!.childPart;
  let names = Object.keys(rig.limbs).filter((name) => {
    const foot = jointNamed(rig.limbs[name].foot)?.childPart;
    return rig.feet.includes(endPart(name)) || (foot !== undefined && rig.feet.includes(foot));
  });
  if (value.limbs !== undefined) {
    if (!Array.isArray(value.limbs) || value.limbs.length === 0) {
      add('gait.limbs', 'must list the limb joints that step');
    } else {
      const given: string[] = [];
      value.limbs.forEach((name, index) => {
        if (typeof name !== 'string' || !rig.limbs[name]) add(`gait.limbs[${index}]`, `is not a limb; the rig's limbs are ${Object.keys(rig.limbs).join(', ') || 'none'}`);
        else if (given.includes(name)) add(`gait.limbs[${index}]`, `"${name}" is listed twice`);
        else given.push(name);
      });
      names = given;
    }
  } else if (names.length === 0) {
    add('gait', Object.keys(rig.limbs).length === 0
      ? 'needs legs, and this rig declares no limbs; declare them, or key the joints by hand'
      : 'needs legs: limbs that end in one of the rig\'s feet; name them in gait.limbs, or declare the feet');
  }
  if (!ok || !pattern || stride === undefined || !root) return undefined;

  // In rig order, so the same description always writes the same keys.
  const rest = restPose(rig);
  const measured = rig.joints.filter((joint) => names.includes(joint.name)).map((joint) => {
    const limb = rig.limbs[joint.name];
    const end = pointToWorld(rest.get(endPart(joint.name))!, limb.end);
    const pivot = pointToWorld(rest.get(joint.parentPart)!, joint.parentOffset);
    // A leg modelled bent at rest reaches further than it stands: its length is its straightest.
    return { joint: joint.name, hinged: limb.hinge !== undefined, end, pivot, length: limbReach(rig, joint.name).length };
  });
  const phases = patternPhases(pattern, measured);
  if (value.phases !== undefined) {
    if (!isRecord(value.phases)) {
      add('gait.phases', 'must be an object of limb joint to the share of the cycle its foot comes down at');
    } else {
      for (const [name, phase] of Object.entries(value.phases)) {
        const index = measured.findIndex((leg) => leg.joint === name);
        if (index < 0) add(`gait.phases.${name}`, `is not one of the gait's legs: ${measured.map((leg) => leg.joint).join(', ')}`);
        else if (typeof phase !== 'number' || !Number.isFinite(phase) || Math.abs(phase) > 100) add(`gait.phases.${name}`, 'must be a share of the cycle');
        else phases[index] = phase;
      }
    }
  }
  const legs: Leg[] = measured.map((leg, index) => ({ ...leg, phase: phases[index] }));

  // How low the body must ride for every bending leg to reach both ends of
  // its stride. A leg of one piece only points at its foot's place.
  const half = Math.abs(stride) / 2;
  const height = Math.min(...legs.map((leg) => leg.pivot[1] - leg.end[1]));
  if (height <= 0) add('gait', 'needs legs that hang below their hips at rest');
  let drop = 0;
  const limit = GAIT_LIMITS.maxDrop * height;
  let longest = Infinity;
  for (const leg of legs.filter((candidate) => candidate.hinged)) {
    const reach = GAIT_LIMITS.reach * leg.length;
    const sideways = leg.end[0] - leg.pivot[0];
    const ahead = Math.abs(leg.end[2] - leg.pivot[2]);
    const flat = reach ** 2 - sideways ** 2 - (ahead + half) ** 2;
    const tall = leg.pivot[1] - leg.end[1];
    drop = Math.max(drop, flat > 0 ? tall - Math.sqrt(flat) : Infinity);
    // The longest stride it reaches with the body as low as it may ride.
    longest = Math.min(longest, 2 * (Math.sqrt(Math.max(0, reach ** 2 - (tall - limit) ** 2 - sideways ** 2)) - ahead));
  }
  if (ok && drop > limit) add('gait.stride', `${Math.abs(stride)} studs is further than its legs reach, even with the body riding low; at most ${Math.floor(Math.max(0, longest) * 100) / 100}`);
  if (!ok) return undefined;

  const share = duty ?? GAIT_LIMITS.duty[pattern];
  const rise = lift ?? round(GAIT_LIMITS.lift * height, 3);
  // A body on legs of one piece does not bob: nothing bends to take it up.
  const dip = bob ?? (legs.some((leg) => leg.hinged) ? round(GAIT_LIMITS.bob * height, 3) : 0);
  const ride = (time: number, duration: number) => -(drop + crouch + (dip * (1 - Math.cos(4 * Math.PI * (time / duration)))) / 2);
  const owners = new Map<string, string>([[root.name, 'the gait sets how high the body rides on this joint; do not key it by hand']]);
  for (const leg of legs) {
    const limb = rig.limbs[leg.joint];
    owners.set(leg.joint, 'the gait steps this leg; do not key it by hand, or leave it out of gait.limbs');
    for (const name of [limb.hinge, limb.foot]) {
      if (name) owners.set(name, `the gait sets this joint to place ${leg.joint}'s foot; do not key it by hand`);
    }
  }
  return {
    name: 'gait',
    joints: [root.name, ...legs.map((leg) => leg.joint)],
    owners,
    steps: (duration) => Math.max(2, Math.ceil(duration / GAIT_LIMITS.stepSeconds - 1e-9)),
    tooMany: 'use a shorter duration',
    pose: (name, time, duration) => {
      const easing = { style: 'Linear' };
      if (name === root.name) return { position: [0, round(ride(time, duration)), 0], easing };
      const leg = legs.find((candidate) => candidate.joint === name)!;
      const cycle = time / duration - leg.phase;
      const at = cycle - Math.floor(cycle);
      let forward: number;
      let up = 0;
      if (at < share) {
        forward = stride / 2 - (stride * at) / share;
      } else {
        const swing = (at - share) / (1 - share);
        forward = -stride / 2 + (stride * (1 - Math.cos(Math.PI * swing))) / 2;
        up = rise * Math.sin(Math.PI * swing);
      }
      // [right, up, forward] from the root part's centre; Roblox's forward is -Z.
      const target = [leg.end[0], leg.end[1] + up, -leg.end[2] + forward];
      if (leg.hinged) return { aimAt: target.map((value) => round(value)), easing };
      // A leg of one piece cannot reach: it points from its hip at its foot's place.
      const hip = [leg.pivot[0], leg.pivot[1] + ride(time, duration), -leg.pivot[2]];
      return { aim: target.map((value, axis) => round(value - hip[axis])), easing };
    },
  };
}
