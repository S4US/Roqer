// How far a limb reaches, and what its hinge must turn to for it to reach
// that far. On R15 and R6 a limb hangs straight at rest, so its rest is its
// longest. A creature's leg is often modelled bent at rest, as a dog's is:
// then it has slack, and reaches past its rest by straightening, which is a
// bend below 0. A leg with no slack cannot stride without the body sinking
// (gait.ts), so the solver and the gait both ask here.

import { restTurn } from './motion.js';
import type { Rig, RigHinge, RigJoint } from './rig.js';
import { RIGS } from './rigs.js';

type Vec = [number, number, number];

/** How far past its rest a hinge is looked at for the limb's straightest, in degrees. */
const MAX_EXTENSION = 120;
/** The share of its rest length a limb must gain by straightening for it to count as bent at rest. */
const MIN_SLACK = 0.002;

const length3 = (a: Vec) => Math.hypot(a[0], a[1], a[2]);

/** The turn a hinge flexes by about its axis, as rows: Rx(degrees) for an elbow or knee. */
export function hingeTurn(axis: RigHinge['axis'], degrees: number): Vec[] {
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians), s = Math.sin(radians);
  if (axis === 'Y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  if (axis === 'Z') return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

export function applyRows(rows: Vec[], v: Vec): Vec {
  return [0, 1, 2].map((row) => rows[row][0] * v[0] + rows[row][1] * v[1] + rows[row][2] * v[2]) as Vec;
}

/** A vector turned by a part's rest turn, or as it is when the part rests upright. */
export function turned(rest: readonly number[] | undefined, v: Vec): Vec {
  return rest ? applyRows([[rest[0], rest[1], rest[2]], [rest[3], rest[4], rest[5]], [rest[6], rest[7], rest[8]]], v) : v;
}

/**
 * Where a limb's `end` is from its root's pivot, in the body's axes, with its
 * hinge bent by a number of degrees from rest: each part's offsets turned as
 * the part rests, which on R15 and R6, whose limbs hang in their parents'
 * orientation, is not at all.
 */
export function limbEndAt(rig: Rig, joint: RigJoint, end: readonly number[]): (bend: number) => Vec {
  const limb = rig.limbs[joint.name];
  const hinge = limb.hinge ? rig.joints.find((candidate) => candidate.name === limb.hinge) : undefined;
  const bending = limb.hinge ? rig.hinges[limb.hinge] : undefined;
  const pivotInLimb = joint.childOffset;
  const upperRest = restTurn(rig, joint.childPart);
  if (!hinge || !bending) {
    const whole = turned(upperRest, [0, 1, 2].map((axis) => end[axis] - pivotInLimb[axis]) as Vec);
    return () => whole;
  }
  const upper = turned(upperRest, [0, 1, 2].map((axis) => hinge.parentOffset[axis] - pivotInLimb[axis]) as Vec);
  const lower = turned(restTurn(rig, hinge.childPart), [0, 1, 2].map((axis) => end[axis] - hinge.childOffset[axis]) as Vec);
  return (bend) => {
    const swung = applyRows(hingeTurn(bending.axis, bending.flex * bend), lower);
    return [upper[0] + swung[0], upper[1] + swung[1], upper[2] + swung[2]];
  };
}

/**
 * The bend at which a limb is longest, 0 or below, and how long it is there.
 * 0 on R15 and R6, on a limb with no hinge, and on one that rests straight.
 */
export function straightest(rig: Rig, endAt: (bend: number) => Vec): { bend: number; length: number } {
  const rest = length3(endAt(0));
  if (RIGS.get(rig.name) === rig) return { bend: 0, length: rest };
  let best = { bend: 0, length: rest };
  for (let bend = -1; bend >= -MAX_EXTENSION; bend -= 1) {
    const length = length3(endAt(bend));
    if (length > best.length) best = { bend, length };
  }
  // Within the degree either side of the best whole one.
  let [low, high] = [Math.max(best.bend - 1, -MAX_EXTENSION), Math.min(best.bend + 1, 0)];
  for (let step = 0; step < 40; step += 1) {
    const [a, b] = [low + (high - low) / 3, high - (high - low) / 3];
    if (length3(endAt(a)) < length3(endAt(b))) low = a;
    else high = b;
  }
  const bend = (low + high) / 2;
  const length = length3(endAt(bend));
  return length > rest * (1 + MIN_SLACK) ? { bend, length } : { bend: 0, length: rest };
}

/** A declared limb's straightest: the bend that straightens it, 0 or below, and its full length. */
export function limbReach(rig: Rig, jointName: string): { bend: number; length: number } {
  const joint = rig.joints.find((candidate) => candidate.name === jointName)!;
  return straightest(rig, limbEndAt(rig, joint, rig.limbs[jointName].end));
}
