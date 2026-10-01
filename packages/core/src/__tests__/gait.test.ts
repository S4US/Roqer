// The gait generator: a description's gait steps every leg of a rig, its
// planted feet travelling straight back along the ground, in the order its
// pattern gives; and what a gait cannot do is refused with its path.
import { describe, expect, test } from '@jest/globals';
import { prepareAnimation } from '../animation/animation-tool.js';
import { rigFromModel } from '../animation/model-rig.js';
import { buildTracks, pointToWorld, poseRig } from '../animation/motion.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import type { Rig } from '../animation/rig.js';
import { R15_RIG } from '../animation/r15-rig.js';
import { R6_RIG } from '../animation/r6-rig.js';
import { kneeDeclarations, partsDog } from './fixtures/parts-dog.js';

function dog(): Rig {
  const result = rigFromModel(partsDog({ knees: true, declarations: kneeDeclarations() }));
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.rig;
}

const LEGS = ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight'];

function prepared(rig: Rig, gait: Record<string, unknown>, more: Record<string, unknown> = {}) {
  const result = prepareAnimation({ name: 'Gait', rig: rig.name, loop: true, priority: 'Movement', duration: 1, gait, ...more }, { locomotion: true }, rig);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.value;
}

const errorsOf = (rig: Rig, input: Record<string, unknown>): string[] => {
  const result = compilePoseAnimation({ name: 'Gait', rig: rig.name, loop: true, duration: 1, ...input }, rig);
  return result.ok ? [] : result.errors;
};

/** Where a foot part's sole centre is at a time, in the root part's frame. */
function sole(sequence: KeyframeSequenceDescription, rig: Rig, part: string, time: number): [number, number, number] {
  const posed = poseRig(buildTracks(sequence), time, rig);
  return pointToWorld(posed.parts.get(part)!, [0, -rig.parts[part][1] / 2, 0]);
}

/** When in the cycle each leg's foot comes down: the first sample it is on the ground after being off it. */
function touchdowns(sequence: KeyframeSequenceDescription, rig: Rig): Record<string, number> {
  const samples = 200;
  const out: Record<string, number> = {};
  for (const leg of LEGS) {
    const down = Array.from({ length: samples }, (_unused, index) => sole(sequence, rig, `${leg}Lower`, (sequence.duration * index) / samples)[1] - rig.ground <= 0.02);
    const index = down.findIndex((on, at) => on && !down[(at + samples - 1) % samples]);
    out[leg] = (Math.round((index / samples) * 20) / 20) % 1;
  }
  return out;
}

describe('a gait steps every leg of a four-legged body', () => {
  const rig = dog();

  test('a walk keeps planted feet on a straight line, moving back at one speed', () => {
    const walk = prepared(rig, { pattern: 'walk', stride: 1.2 });
    expect(walk.failing).toEqual([]);
    const status = Object.fromEntries(walk.report.checks.map((check) => [check.id, check.status]));
    expect(status).toMatchObject({ jointLimits: 'pass', velocity: 'pass', rootDrift: 'pass', loopContinuity: 'pass', groundContact: 'pass', footSliding: 'pass' });
    const pattern = walk.report.checks.find((check) => check.id === 'gaitSymmetry')!;
    expect(pattern.status).toBe('pass');
    expect(pattern.detail).toMatch(/^4 feet step, each down 6\d% to 6\d% of the cycle, landing HindLeftLower, then FrontLeftLower, then HindRightLower, then FrontRightLower$/);
    // Stride over the time a foot is down: 1.2 studs in 0.65 s.
    expect(walk.report.groundSpeed).toBeCloseTo(1.2 / 0.65, 1);
    // A planted foot stays within 0.05 studs of its line: on the ground, under its hip.
    for (const leg of LEGS) {
      const rest = sole(walk.sequence, rig, `${leg}Lower`, 0)[0];
      for (let step = 0; step < 100; step += 1) {
        const [x, y] = sole(walk.sequence, rig, `${leg}Lower`, step / 100);
        expect(Math.abs(x - rest)).toBeLessThan(0.05);
        expect(y - rig.ground).toBeGreaterThan(-0.05);
      }
    }
  });

  test('each pattern brings the feet down in its order', () => {
    expect(touchdowns(prepared(rig, { pattern: 'walk', stride: 1.2 }).sequence, rig)).toEqual({ HindLeft: 0, FrontLeft: 0.25, HindRight: 0.5, FrontRight: 0.75 });
    expect(touchdowns(prepared(rig, { pattern: 'trot', stride: 1.4 }, { duration: 0.6 }).sequence, rig)).toEqual({ FrontLeft: 0, HindRight: 0, FrontRight: 0.5, HindLeft: 0.5 });
    expect(touchdowns(prepared(rig, { pattern: 'pace', stride: 1.2 }, { duration: 0.6 }).sequence, rig)).toEqual({ FrontLeft: 0, HindLeft: 0, FrontRight: 0.5, HindRight: 0.5 });
    expect(touchdowns(prepared(rig, { pattern: 'bound', stride: 1.6 }, { duration: 0.5 }).sequence, rig)).toEqual({ HindLeft: 0, HindRight: 0, FrontLeft: 0.5, FrontRight: 0.5 });
    expect(touchdowns(prepared(rig, { pattern: 'gallop', stride: 1.6 }, { duration: 0.5 }).sequence, rig)).toEqual({ HindLeft: 0, HindRight: 0.1, FrontLeft: 0.5, FrontRight: 0.6 });
  });

  test('a trot and a run pass their checks, and report the speed they were written for', () => {
    const trot = prepared(rig, { pattern: 'trot', stride: 1.4 }, { duration: 0.6 });
    expect(trot.failing).toEqual([]);
    expect(trot.report.groundSpeed).toBeCloseTo(1.4 / 0.3, 0);
    const run = prepared(rig, { pattern: 'gallop', stride: 1.8, duty: 0.4 }, { duration: 0.45 });
    expect(run.failing).toEqual([]);
    expect(run.report.groundSpeed).toBeGreaterThan(trot.report.groundSpeed!);
  });

  test('the body rides low enough to reach the stride, and lower with crouch', () => {
    const height = (gait: Record<string, unknown>) => {
      const { sequence } = prepared(rig, gait);
      return poseRig(buildTracks(sequence), 0, rig).parts.get('Body')!.p[1];
    };
    const short = height({ pattern: 'walk', stride: 0.6, bob: 0 });
    const long = height({ pattern: 'walk', stride: 1.4, bob: 0 });
    expect(short).toBeLessThan(0);
    expect(long).toBeLessThan(short);
    expect(height({ pattern: 'walk', stride: 0.6, bob: 0, crouch: 0.3 })).toBeCloseTo(short - 0.3, 3);
  });

  test('other joints are keyed by hand or by a wave beside the gait', () => {
    const walk = prepared(rig, { pattern: 'walk', stride: 1.2 }, {
      keyframes: [{ time: 0, joints: { Neck: { rotation: [5, 0, 0] } } }, { time: 0.5, joints: { Neck: { rotation: [-5, 0, 0] } } }, { time: 1, joints: { Neck: { rotation: [5, 0, 0] } } }],
      waves: [{ joints: ['Tail'], axis: 'Y', amplitude: 20, cycles: 2 }],
    });
    expect(walk.failing).toEqual([]);
    expect(walk.sequence.joints).toEqual(expect.arrayContaining(['Root', 'Neck', 'Tail', 'FrontLeft', 'FrontLeftKnee']));
  });
});

describe('the gait check on a body that is not a biped', () => {
  const rig = dog();
  const check = (keyframes: unknown[]) => {
    const result = prepareAnimation({ name: 'Hand', rig: rig.name, loop: true, keyframes }, { locomotion: true }, rig);
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.value.report.checks.find((entry) => entry.id === 'gaitSymmetry')!;
  };
  const stand = Object.fromEntries(LEGS.map((leg) => [leg, { aim: [0, -1, 0] }]));

  test('a foot that never leaves the ground fails it', () => {
    const lifted = { ...stand, FrontLeft: { aim: [0, -1, 0.6] } };
    const result = check([{ time: 0, joints: stand }, { time: 0.5, joints: lifted }, { time: 1, joints: stand }]);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('FrontRightLower, HindLeftLower and HindRightLower never leave the ground; in a gait every foot steps');
  });

  test('a trot reports its diagonal pairs landing together', () => {
    const trot = prepared(rig, { pattern: 'trot', stride: 1.4 }, { duration: 0.6 });
    const result = trot.report.checks.find((entry) => entry.id === 'gaitSymmetry')!;
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/landing FrontLeftLower with HindRightLower, then FrontRightLower with HindLeftLower$/);
  });
});

describe('legs of one piece', () => {
  test('swing from the hip, pointing at where the foot would be', () => {
    const feet = ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight'];
    const result = rigFromModel(partsDog({ declarations: { version: 1, feet, limbs: Object.fromEntries(feet.map((leg) => [leg, {}])) } }));
    if (!result.ok) throw new Error(result.errors.join('; '));
    const walk = prepared(result.rig, { pattern: 'walk', stride: 1 });
    expect(walk.sequence.joints).toEqual(['Root', ...feet]);
    // The body does not sink or bob: nothing bends to take it up.
    const body = poseRig(buildTracks(walk.sequence), 0.3, result.rig).parts.get('Body')!.p[1];
    expect(body).toBeCloseTo(0, 5);
    // A foot swings a stride's width under its hip.
    const reach = Array.from({ length: 50 }, (_unused, index) => sole(walk.sequence, result.rig, 'FrontLeft', index / 50)[2]);
    expect(Math.max(...reach) - Math.min(...reach)).toBeGreaterThan(0.8);
    expect(walk.report.checks.find((entry) => entry.id === 'groundContact')!.status).toBe('pass');
  });

  test('on R6 a walk passes the checks R6 has', () => {
    const walk = prepared(R6_RIG, { pattern: 'walk', stride: 1.6 }, { rig: 'R6', duration: 0.8 });
    expect(walk.failing).toEqual([]);
  });
});

describe('a gait on R15', () => {
  test('a walk alternates the legs, and passes every locomotion check', () => {
    const walk = prepared(R15_RIG, { pattern: 'walk', stride: 2.4 }, { rig: 'R15', duration: 0.8 });
    expect(walk.failing).toEqual([]);
    const symmetry = walk.report.checks.find((check) => check.id === 'gaitSymmetry')!;
    expect(symmetry.status).toBe('pass');
    expect(walk.report.groundSpeed).toBeCloseTo(2.4 / (0.65 * 0.8), 0);
  });
});

describe('what a gait cannot do is refused', () => {
  const rig = dog();

  test('each field says what it takes', () => {
    expect(errorsOf(rig, { gait: { pattern: 'amble', lift: -1, duty: 1, speed: 3 } })).toEqual([
      'gait: unknown field "speed"; expected pattern, stride, lift, duty, bob, crouch, phases, limbs',
      'gait.pattern: must be one of walk, trot, pace, bound, gallop',
      'gait.stride: must be the studs a foot travels on the ground each cycle, and not 0',
      'gait.lift: must be studs, 0 to 10',
      'gait.duty: must be the share of the cycle a foot is down, 0.1 to 0.9',
    ]);
    expect(errorsOf(rig, { gait: 'walk' })).toEqual(['gait: must be { pattern, stride, lift?, duty?, bob?, crouch?, phases?, limbs? }']);
  });

  test('a stride past the legs\' reach says how long it may be', () => {
    const errors = errorsOf(rig, { gait: { pattern: 'walk', stride: 4 } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^gait\.stride: 4 studs is further than its legs reach, even with the body riding low; at most \d+(\.\d+)?$/);
    const most = Number(errors[0].split('at most ')[1]);
    expect(errorsOf(rig, { gait: { pattern: 'walk', stride: most } })).toEqual([]);
  });

  test('a joint the gait drives is not keyed by hand or by a wave', () => {
    expect(errorsOf(rig, {
      gait: { pattern: 'walk', stride: 1 },
      keyframes: [{ time: 0, joints: { Root: { position: [0, 0.2, 0] }, HindLeftKnee: { bend: 10 }, FrontLeft: { aim: [0, -1, 0] } } }],
      waves: [{ joints: ['HindRight'], axis: 'X', amplitude: 10 }],
    })).toEqual([
      'waves: "HindRight" is the gait\'s: the gait steps this leg; do not key it by hand, or leave it out of gait.limbs',
      'keyframes[0].joints.Root: the gait sets how high the body rides on this joint; do not key it by hand',
      'keyframes[0].joints.HindLeftKnee: the gait sets this joint to place HindLeft\'s foot; do not key it by hand',
      'keyframes[0].joints.FrontLeft: the gait steps this leg; do not key it by hand, or leave it out of gait.limbs',
    ]);
  });

  test('a body with no declared legs cannot be walked', () => {
    const bare = rigFromModel(partsDog({ knees: true }));
    if (!bare.ok) throw new Error(bare.errors.join('; '));
    expect(errorsOf(bare.rig, { gait: { pattern: 'walk', stride: 1 } }))
      .toEqual(['gait: needs legs, and this rig declares no limbs; declare them, or key the joints by hand']);
  });

  test('phases and limbs name the gait\'s own legs', () => {
    expect(errorsOf(rig, { gait: { pattern: 'walk', stride: 1, limbs: ['FrontLeft', 'Tail'], phases: { HindLeft: 0.5 } } }))
      .toEqual(['gait.limbs[1]: is not a limb; the rig\'s limbs are FrontLeft, FrontRight, HindLeft, HindRight']);
    expect(errorsOf(rig, { gait: { pattern: 'walk', stride: 1, limbs: ['FrontLeft', 'FrontRight'], phases: { HindLeft: 0.5 } } }))
      .toEqual(['gait.phases.HindLeft: is not one of the gait\'s legs: FrontLeft, FrontRight']);
  });

  test('a gait needs a length', () => {
    const result = compilePoseAnimation({ name: 'Gait', rig: rig.name, gait: { pattern: 'walk', stride: 1 } }, rig);
    expect(result.ok ? [] : result.errors).toEqual(['duration: a gait needs the animation\'s length: give duration in seconds, or a last keyframe']);
  });
});
