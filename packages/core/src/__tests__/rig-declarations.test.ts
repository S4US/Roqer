// A model's RoqerRig declarations: what its joints cannot say. The Parts dog
// with knees declares its legs, knees, feet and ranges, and then aim, aimAt,
// bend and the checks that need feet and ranges work on it as on R15.
import { checkMotion } from '../animation/motion-checks.js';
import { buildTracks, pointToWorld, poseRig } from '../animation/motion.js';
import { rigFromModel } from '../animation/model-rig.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import type { Rig } from '../animation/rig.js';
import { kneeDeclarations, LEG_ROOTS, partsDog } from './fixtures/parts-dog.js';

function rigOf(declarations: unknown = kneeDeclarations()): Rig {
  const result = rigFromModel(partsDog({ knees: true, declarations }));
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.rig;
}

function errorsOf(declarations: unknown): string[] {
  const reading = partsDog({ knees: true });
  const result = rigFromModel({ ...reading, declarations: typeof declarations === 'string' ? declarations : JSON.stringify(declarations) });
  if (result.ok) throw new Error('the declarations were accepted');
  return result.errors;
}

function compiled(input: Record<string, unknown>, rig: Rig): KeyframeSequenceDescription {
  const result = compilePoseAnimation({ name: 'Test', rig: rig.name, ...input }, rig);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.sequence;
}

/** Rounded to a billionth, -0 as 0. */
const tidy = (value: number) => Math.round(value * 1e9) / 1e9 + 0;

/** Where a leg's sole is at a time: the middle of its lower part's bottom. */
function sole(sequence: KeyframeSequenceDescription, rig: Rig, leg: string, time: number): number[] {
  return [...pointToWorld(poseRig(buildTracks(sequence), time, rig).parts.get(`${leg}Lower`)!, [0, -0.4, 0])];
}

describe('RoqerRig declarations', () => {
  it('declare a dog\'s legs: each limb runs down to its sole and folds as its knee swings it', () => {
    const rig = rigOf();
    expect(rig.feet).toEqual(['FrontLeftLower', 'FrontRightLower', 'HindLeftLower', 'HindRightLower']);
    expect(rig.hinges.FrontLeftKnee).toEqual({ axis: 'X', flex: -1 });
    const front = rig.limbs.FrontLeft;
    expect(front.hinge).toBe('FrontLeftKnee');
    expect(front.end).toEqual([0, -0.4, 0]);
    expect(front.axis.map(tidy)).toEqual([0, -1, 0]);
    // A front knee folds the shin back, a hind one forward.
    expect(front.fold.map(tidy)).toEqual([0, 0, 1]);
    expect(rig.limbs.HindLeft.fold.map(tidy)).toEqual([0, 0, -1]);
    expect(rig.limits.FrontLeftKnee).toEqual({ min: -150, max: 10, offAxis: 35 });
    expect(rig.limits.Root).toBe('free');
    // Its hips stand 1.6 studs above the ground, against R15's 2.19.
    expect(rig.scale).toEqual({ factor: expect.closeTo(1.6 / 2.19, 9), basis: 'its hips\' height at rest' });
  });

  it('let aim point a leg and bend fold its knee', () => {
    const rig = rigOf();
    const sequence = compiled({ keyframes: [{ time: 0, joints: { FrontLeft: { aim: [0, -1, 1] }, HindLeftKnee: { bend: 40 } } }] }, rig);
    // Aimed forward and down: the sole ends in front of the hip, as far down as forward.
    const [x, y, z] = sole(sequence, rig, 'FrontLeft', 0);
    const [hx, hy, hz] = LEG_ROOTS.FrontLeft;
    expect(x).toBeCloseTo(hx, 6);
    expect(hz - z).toBeCloseTo(hy - y, 6);
    expect(Math.hypot(hy - y, hz - z)).toBeCloseTo(1.6, 6);
    // The hind knee folds forward: its sole swings toward the front (-Z) and up.
    const hind = sole(sequence, rig, 'HindLeft', 0);
    expect(hind[2]).toBeLessThan(LEG_ROOTS.HindLeft[2] - 0.2);
    expect(hind[1]).toBeGreaterThan(-2.2 + 0.05);
  });

  it('let aimAt plant a sole on the ground while the body moves, bending its knee', () => {
    const rig = rigOf();
    // On the ground 1.3 studs ahead of the root: [right, up, forward].
    const target = [-0.7, -2.2, 1.3];
    const planted = compiled({
      keyframes: [
        { time: 0, joints: { Root: { position: [0, -0.1, 0] }, FrontLeft: { aimAt: target } } },
        { time: 0.5, joints: { Root: { position: [0, -0.3, -0.2] }, FrontLeft: { aimAt: target } } },
      ],
    }, rig);
    expect(planted.joints).toEqual(['Root', 'FrontLeft', 'FrontLeftKnee']);
    expect(planted.inBetweenCount).toBeGreaterThan(0);
    // aimAt's target is where the end lands: [right, up, forward], so forward is -Z.
    const want = [target[0], target[1], -target[2]];
    for (let time = 0; time <= 0.5; time += 1 / 60) {
      sole(planted, rig, 'FrontLeft', time).forEach((value, axis) => expect(Math.abs(value - want[axis])).toBeLessThan(0.05));
    }
    // And it bends the knee the way the knee folds, not backward.
    const knee = poseRig(buildTracks(planted), 0.5, rig).transforms.get('FrontLeftKnee')!.r;
    expect(Math.atan2(knee[7], knee[8])).toBeLessThan(0);
  });

  it('check the legs as they are declared, and say what is left unchecked', () => {
    const rig = rigOf();
    const over = compiled({
      loop: true,
      keyframes: [
        { time: 0, joints: { FrontLeftKnee: { bend: 0 }, Neck: { rotation: [0, 0, 0] } } },
        { time: 0.5, joints: { FrontLeftKnee: { bend: 160 }, Neck: { rotation: [20, 0, 0] } } },
        { time: 1, joints: { FrontLeftKnee: { bend: 0 }, Neck: { rotation: [0, 0, 0] } } },
      ],
    }, rig);
    const checks = Object.fromEntries(checkMotion(over, { grounded: true }, rig).checks.map((check) => [check.id, check]));
    // The knee folds 160°, past its declared 150; the neck turns with no range to judge it by.
    expect(checks.jointLimits.status).toBe('fail');
    expect(checks.jointLimits.detail).toBe('FrontLeftKnee bends to -160° at 0.5 s; limit -150°; not checked: Neck turns with no declared range');
    // With feet declared, the ground check runs, its limits scaled to the dog's hips.
    expect(checks.groundContact.status).toBe('pass');
    expect(checks.groundContact.detail).toMatch(/; its limits are R15's scaled by 0\.73 for its hips' height at rest$/);
    expect(checkMotion(over, { locomotion: true }, rig).checks.find((check) => check.id === 'gaitSymmetry')!.detail)
      .toBe('not checked: the rig declares no pair of hips to compare');
  });

  it('measure the ground under declared foot points, not the box', () => {
    const declarations = { ...kneeDeclarations(), feet: Object.fromEntries(Object.keys(LEG_ROOTS).map((leg) => [`${leg}Lower`, [[0, -0.4, -0.2], [0, -0.4, 0.2]]])) };
    const rig = rigOf(declarations);
    expect(rig.footPoints?.FrontLeftLower).toEqual([[0, -0.4, -0.2], [0, -0.4, 0.2]]);
    // Sinking the body 0.1 studs puts every point 0.1 under the ground, past the scaled limit.
    const sunk = compiled({ keyframes: [{ time: 0, joints: { Root: { position: [0, -0.1, 0] } } }] }, rig);
    const ground = checkMotion(sunk, { grounded: true }, rig).checks.find((check) => check.id === 'groundContact')!;
    expect(ground.status).toBe('fail');
    expect(ground.detail).toMatch(/^FrontLeftLower sinks 0\.1 studs into the ground at 0 s; limit 0\.07/);
  });

  it('refuse the whole rig when any declaration is wrong, naming each', () => {
    expect(errorsOf('{ not json')).toEqual(['RoqerRig: must be JSON']);
    expect(errorsOf({ version: 2 })).toEqual(['RoqerRig.version: must be 1; this Roqer reads version 1 only']);
    expect(errorsOf({ version: 1, gaits: {} })).toEqual(['RoqerRig.gaits: is not a version 1 declaration; expected feet, hips, limbs, hinges or limits']);
    expect(errorsOf({ version: 1, limbs: { Paw: {} } })[0]).toMatch(/^RoqerRig\.limbs\.Paw: names no joint of the rig; its joints are Root, Neck, FrontLeft, FrontLeftKnee/);
    expect(errorsOf({ version: 1, hinges: { FrontLeftKnee: { axis: 'X', flex: -1 } }, limbs: { FrontRight: { hinge: 'FrontLeftKnee' } } }))
      .toEqual(['RoqerRig.limbs.FrontRight.hinge: FrontLeftKnee does not hang from FrontRightUpper, the part FrontRight moves']);
    expect(errorsOf({ version: 1, limbs: { FrontLeft: { hinge: 'FrontLeftKnee' } } }))
      .toEqual(['RoqerRig.limbs.FrontLeft.hinge: FrontLeftKnee must be declared in hinges, with the axis it bends about']);
    expect(errorsOf({ version: 1, limbs: { FrontLeft: { foot: 'FrontLeftKnee' } } }))
      .toEqual(['RoqerRig.limbs.FrontLeft.foot: goes with a hinge: a foot is laid flat below a bent knee']);
    expect(errorsOf({ version: 1, hinges: { FrontLeftKnee: { axis: 'W', flex: 2 } } }))
      .toEqual(['RoqerRig.hinges.FrontLeftKnee: must be { axis: "X", "Y" or "Z" (the body axis it bends about), flex: 1 or -1 (the sign of the turn that flexes it) }']);
    expect(errorsOf({ version: 1, limits: { Neck: { min: -10, max: 10 } } }))
      .toEqual(['RoqerRig.limits.Neck: a range goes on a hinge; declare Neck in hinges, or give { turn }']);
    expect(errorsOf({ version: 1, limits: { Neck: { turn: 0 } } })).toEqual(['RoqerRig.limits.Neck.turn: must be degrees above 0, at most 360']);
    expect(errorsOf({ version: 1, feet: ['HumanoidRootPart'] })).toEqual(['RoqerRig.feet.HumanoidRootPart: must be a part a joint moves']);
    expect(errorsOf({ version: 1, limbs: { Tail: { end: [0, 0, 5] } } }))
      .toEqual(['RoqerRig.limbs.Tail.end: lies outside Tail, whose size is [0.3, 0.3, 1.6]; give it in Tail\'s own frame']);
    expect(errorsOf({ version: 1, limbs: { Tail: { fold: [0, 0, 1] } } }))
      .toEqual(['RoqerRig.limbs.Tail.fold: must be a direction [x, y, z] that does not run along the limb\'s axis']);
    expect(errorsOf({ version: 1, hinges: { FrontLeftKnee: { axis: 'Y', flex: 1 } }, limbs: { FrontLeft: { hinge: 'FrontLeftKnee' } } }))
      .toEqual(['RoqerRig.limbs.FrontLeft.fold: FrontLeftKnee bends about Y, along the limb, so it cannot fold it; give fold, or declare the hinge\'s axis square to the limb']);
    expect(errorsOf({ version: 1, hips: ['FrontLeft'] })).toEqual(['RoqerRig.hips: must be two joints, left then right, whose swing a biped\'s gait compares']);
  });

  it('let a tail be a limb that aim points, running back from the body', () => {
    const result = rigFromModel(partsDog({ declarations: { version: 1, limbs: { Tail: {} } } }));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const rig = result.rig;
    expect(rig.limbs.Tail.end).toEqual([0, 0, 0.8]);
    expect(rig.limbs.Tail.axis.map(tidy)).toEqual([0, 0, 1]);
    // Aimed up and back, the tip rises behind the body.
    const up = compiled({ keyframes: [{ time: 0, joints: { Tail: { aim: [0, 1, -1] } } }] }, rig);
    const tip = pointToWorld(poseRig(buildTracks(up), 0, rig).parts.get('Tail')!, [0, 0, 0.8]);
    expect(tip[1] - 0.3).toBeCloseTo(tip[2] - 1.9, 6);
    expect(tip[1]).toBeGreaterThan(1);
  });
});
