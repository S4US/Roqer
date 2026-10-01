// Three more bodies built from Parts, as the plugin reads a rigged model, for
// the motions a dog and an octopus do not make: a six-legged beetle, a snake
// and a bird. Each faces -Z with its right at +X, every joint's frame lined up
// with the root, as `rig` builds them.
import type { ModelRigJoint, ModelRigPart, ModelRigReading } from '../../animation/model-rig.js';
import { cf, motor, type CF, type V } from './parts-dog.js';

function reading(path: string, controller: 'Humanoid' | 'AnimationController', parts: ModelRigPart[], joints: ModelRigJoint[], declarations: unknown, hipHeight?: number): ModelRigReading {
  return { path, revision: 'r1', rootPart: 'HumanoidRootPart', controller, ...(hipHeight === undefined ? {} : { hipHeight }), parts, joints, declarations: JSON.stringify(declarations) };
}

/** The beetle's legs, front to back on each side: `LeftFront`, `LeftMid`, `LeftHind`, and the right's. */
export const BEETLE_LEGS = ['LeftFront', 'RightFront', 'LeftMid', 'RightMid', 'LeftHind', 'RightHind'];

/**
 * A beetle: a low body on six legs, each an upper and a lower piece that bend
 * at a knee folding back, `<Leg>` at the body and `<Leg>Knee` below it.
 */
export function partsBeetle(): ModelRigReading {
  const body = cf([0, 0, 0]);
  const parts: ModelRigPart[] = [{ name: 'HumanoidRootPart', size: [2, 0.8, 4], hidden: true }, { name: 'Body', size: [2, 0.8, 4] }];
  const joints: ModelRigJoint[] = [motor('Root', ['HumanoidRootPart', body], ['Body', body], body)];
  for (const leg of BEETLE_LEGS) {
    const x = leg.startsWith('Left') ? -1.1 : 1.1;
    const z = leg.endsWith('Front') ? -1.4 : leg.endsWith('Mid') ? 0 : 1.4;
    const upper = cf([x, -0.7, z]);
    const lower = cf([x, -1.3, z]);
    parts.push({ name: `${leg}Upper`, size: [0.3, 0.6, 0.3] }, { name: `${leg}Lower`, size: [0.3, 0.6, 0.3] });
    joints.push(motor(leg, ['Body', body], [`${leg}Upper`, upper], cf([x, -0.4, z])));
    joints.push(motor(`${leg}Knee`, [`${leg}Upper`, upper], [`${leg}Lower`, lower], cf([x, -1, z])));
  }
  return reading('game.Workspace.Beetle', 'Humanoid', parts, joints, {
    version: 1,
    feet: BEETLE_LEGS.map((leg) => `${leg}Lower`),
    hinges: Object.fromEntries(BEETLE_LEGS.map((leg) => [`${leg}Knee`, { axis: 'X', flex: -1 }])),
    limbs: Object.fromEntries(BEETLE_LEGS.map((leg) => [leg, { hinge: `${leg}Knee` }])),
    limits: Object.fromEntries(BEETLE_LEGS.flatMap((leg) => [[leg, { turn: 120 }], [`${leg}Knee`, { min: -160, max: 10 }]])),
  }, 1.2);
}

/** The snake's joints, head to tail: `Neck`, then `Spine1` to `Spine7`. */
export const SNAKE_JOINTS = ['Neck', ...Array.from({ length: 7 }, (_unused, index) => `Spine${index + 1}`)];

/** A snake: a head and eight segments in a line, each hung from the one before at its front. */
export function partsSnake(): ModelRigReading {
  const head = cf([0, 0, 0]);
  const parts: ModelRigPart[] = [{ name: 'HumanoidRootPart', size: [0.8, 0.6, 1], hidden: true }, { name: 'Head', size: [0.8, 0.6, 1] }];
  const joints: ModelRigJoint[] = [motor('Root', ['HumanoidRootPart', head], ['Head', head], head)];
  let parent: [string, CF] = ['Head', head];
  SNAKE_JOINTS.forEach((name, index) => {
    const part: [string, CF] = [`Segment${index + 1}`, cf([0, 0, 1 + index])];
    parts.push({ name: part[0], size: [0.6, 0.5, 1] });
    joints.push(motor(name, parent, part, cf([0, 0, 0.5 + index])));
    parent = part;
  });
  return reading('game.Workspace.Snake', 'AnimationController', parts, joints, {
    version: 1,
    limits: Object.fromEntries(SNAKE_JOINTS.map((name) => [name, { turn: 60 }])),
  });
}

/** A bird: a body, two wings of an inner and an outer piece, and a tail. */
export function partsBird(): ModelRigReading {
  const body = cf([0, 0, 0]);
  const parts: ModelRigPart[] = [{ name: 'HumanoidRootPart', size: [1, 1, 2], hidden: true }, { name: 'Body', size: [1, 1, 2] }, { name: 'Tail', size: [0.6, 0.2, 1] }];
  const joints: ModelRigJoint[] = [
    motor('Root', ['HumanoidRootPart', body], ['Body', body], body),
    motor('Tail', ['Body', body], ['Tail', cf([0, 0, 1.5])], cf([0, 0, 1])),
  ];
  for (const [side, sign] of [['Left', -1], ['Right', 1]] as const) {
    const inner: V = [sign * 1.25, 0.3, 0];
    const outer: V = [sign * 2.75, 0.3, 0];
    parts.push({ name: `Wing${side}`, size: [1.5, 0.2, 1.2] }, { name: `Wing${side}Tip`, size: [1.5, 0.2, 1] });
    joints.push(motor(`Wing${side}`, ['Body', body], [`Wing${side}`, cf(inner)], cf([sign * 0.5, 0.3, 0])));
    joints.push(motor(`Wing${side}Tip`, [`Wing${side}`, cf(inner)], [`Wing${side}Tip`, cf(outer)], cf([sign * 2, 0.3, 0])));
  }
  return reading('game.Workspace.Bird', 'AnimationController', parts, joints, {
    version: 1,
    limits: { WingLeft: { turn: 80 }, WingRight: { turn: 80 }, WingLeftTip: { turn: 60 }, WingRightTip: { turn: 60 }, Tail: { turn: 45 } },
  });
}
