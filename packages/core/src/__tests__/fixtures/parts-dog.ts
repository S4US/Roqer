// A four-legged dog built from Parts and rigged by hand with Motor6Ds, as the
// creature spike built one (tests/creature-spike.mjs), in the form the plugin
// reads a rigged model: a hidden root over the body, a head, four legs and a
// tail, each on a Motor6D whose frame sits at its pivot. It faces -Z with its
// right at +X, and its soles stand 2.2 studs below the root.
import type { ModelRigJoint, ModelRigPart, ModelRigReading } from '../../animation/model-rig.js';

export type V = [number, number, number];
export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A CFrame: a position and a row-major rotation. */
export interface CF { p: V; r: number[] }
export const cf = (p: V, r: number[] = IDENTITY): CF => ({ p, r });
const rotate = (r: number[], v: number[]): V => [0, 1, 2].map((row) => r[row * 3] * v[0] + r[row * 3 + 1] * v[1] + r[row * 3 + 2] * v[2]) as V;
const transpose = (r: number[]) => [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
const inverse = (a: CF): CF => ({ p: rotate(transpose(a.r), a.p).map((value) => -value) as V, r: transpose(a.r) });
const times = (a: CF, b: CF): CF => ({
  p: rotate(a.r, b.p).map((value, axis) => value + a.p[axis]) as V,
  r: Array.from({ length: 9 }, (_unused, index) => [0, 1, 2].reduce((sum, k) => sum + a.r[Math.floor(index / 3) * 3 + k] * b.r[k * 3 + (index % 3)], 0)),
});

/** A Motor6D made as a script makes one: C0 and C1 put its frame at the pivot, from each part's CFrame. */
export function motor(name: string, part0: [string, CF], part1: [string, CF], pivot: CF): ModelRigJoint {
  const c0 = times(inverse(part0[1]), pivot);
  const c1 = times(inverse(part1[1]), pivot);
  return { name, part0: part0[0], part1: part1[0], c0: [...c0.p, ...c0.r], c1: [...c1.p, ...c1.r] };
}

/** Where each leg's top stands, beside and under the body's centre. */
export const LEG_ROOTS: Record<string, V> = { FrontLeft: [-0.7, -0.6, -1.4], FrontRight: [0.7, -0.6, -1.4], HindLeft: [-0.7, -0.6, 1.4], HindRight: [0.7, -0.6, 1.4] };

/**
 * The dog. With `knees`, each leg is two parts, `<Leg>Upper` hung from the
 * body by `<Leg>` and `<Leg>Lower` hung from it by `<Leg>Knee`; otherwise each
 * leg is one part, `<Leg>`, on a joint of the same name.
 */
export function partsDog(options: { knees?: boolean; declarations?: unknown } = {}): ModelRigReading {
  const body = cf([0, 0, 0]);
  const parts: ModelRigPart[] = [
    { name: 'HumanoidRootPart', size: [2, 1.2, 4], hidden: true },
    { name: 'Body', size: [2, 1.2, 4] },
    { name: 'Head', size: [1.2, 1.2, 1.4] },
    { name: 'Tail', size: [0.3, 0.3, 1.6] },
  ];
  const joints: ModelRigJoint[] = [
    motor('Root', ['HumanoidRootPart', body], ['Body', body], body),
    motor('Neck', ['Body', body], ['Head', cf([0, 0.8, -2.6])], cf([0, 0.4, -2])),
  ];
  for (const [leg, [x, y, z]] of Object.entries(LEG_ROOTS)) {
    if (options.knees) {
      const upper = cf([x, y - 0.4, z]);
      const lower = cf([x, y - 1.2, z]);
      parts.push({ name: `${leg}Upper`, size: [0.5, 0.8, 0.5] }, { name: `${leg}Lower`, size: [0.5, 0.8, 0.5] });
      joints.push(motor(leg, ['Body', body], [`${leg}Upper`, upper], cf([x, y, z])));
      joints.push(motor(`${leg}Knee`, [`${leg}Upper`, upper], [`${leg}Lower`, lower], cf([x, y - 0.8, z])));
    } else {
      parts.push({ name: leg, size: [0.5, 1.6, 0.5] });
      joints.push(motor(leg, ['Body', body], [leg, cf([x, y - 0.8, z])], cf([x, y, z])));
    }
  }
  joints.push(motor('Tail', ['Body', body], ['Tail', cf([0, 0.3, 2.7])], cf([0, 0.3, 1.9])));
  return {
    path: 'game.Workspace.Dog',
    revision: 'r1',
    rootPart: 'HumanoidRootPart',
    controller: 'Humanoid',
    hipHeight: 1.6,
    parts,
    joints,
    ...(options.declarations === undefined ? {} : { declarations: JSON.stringify(options.declarations) }),
  };
}

/**
 * Declarations for the dog with knees: four legs whose knees fold as a dog's
 * do, the front back and the hind forward, the lower parts as its feet, and
 * ranges on the legs.
 */
export function kneeDeclarations(): Record<string, unknown> {
  const legs = Object.keys(LEG_ROOTS);
  return {
    version: 1,
    feet: legs.map((leg) => `${leg}Lower`),
    hinges: Object.fromEntries(legs.map((leg) => [`${leg}Knee`, { axis: 'X', flex: leg.startsWith('Front') ? -1 : 1 }])),
    limbs: Object.fromEntries(legs.map((leg) => [leg, { hinge: `${leg}Knee` }])),
    limits: {
      ...Object.fromEntries(legs.map((leg) => [leg, { turn: 120 }])),
      ...Object.fromEntries(legs.map((leg) => [`${leg}Knee`, leg.startsWith('Front') ? { min: -150, max: 10 } : { min: -10, max: 150 }])),
    },
  };
}
