import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import {
  buildTracks,
  easeAlpha,
  pointToWorld,
  poseRig,
  sampleTrack,
  type MotionSequence,
} from '../animation/motion.js';
import { checkMotion, type MotionCheckId, type MotionReport } from '../animation/motion-checks.js';

type Joints = Record<string, { rotation?: [number, number, number]; position?: [number, number, number] }>;

function animation(keyframes: { time: number; joints: Joints }[], loop = false): KeyframeSequenceDescription {
  const result = compilePoseAnimation({ name: 'Test', rig: 'R15', loop, keyframes });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.sequence;
}

function check(report: MotionReport, id: MotionCheckId) {
  const found = report.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

function close(actual: readonly number[], expected: readonly number[], digits = 6) {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], digits));
}

// Hips swing in opposite phase, knees bend on the forward swing.
function walk(swing = 25, rightSwing = -swing): KeyframeSequenceDescription {
  const pose = (s: number, r: number) => ({
    LeftHip: { rotation: [s, 0, 0] as [number, number, number] },
    RightHip: { rotation: [r, 0, 0] as [number, number, number] },
  });
  return animation([
    { time: 0, joints: pose(swing, rightSwing) },
    { time: 0.5, joints: pose(-swing, -rightSwing) },
    { time: 1, joints: pose(swing, rightSwing) },
  ], true);
}

describe('easing', () => {
  // Measured against Studio by tests/animation-calibration.mjs.
  test('follows Studio: TweenService shapes, legacy Cubic swapped, and its Constant, Elastic and Bounce quirks', () => {
    expect(easeAlpha('Linear', 'In', 0.3)).toBeCloseTo(0.3);
    expect(easeAlpha('CubicV2', 'In', 0.5)).toBeCloseTo(0.125);
    expect(easeAlpha('CubicV2', 'Out', 0.5)).toBeCloseTo(0.875);
    expect(easeAlpha('CubicV2', 'InOut', 0.25)).toBeCloseTo(0.0625);
    expect(easeAlpha('CubicV2', 'InOut', 0.75)).toBeCloseTo(0.9375);
    expect(easeAlpha('Cubic', 'In', 0.5)).toBeCloseTo(0.875);
    expect(easeAlpha('Cubic', 'Out', 0.5)).toBeCloseTo(0.125);
    // Constant snaps to the next key: at once, halfway, or at the key.
    expect([0, 0.01, 0.49, 0.5, 0.99].map((t) => easeAlpha('Constant', 'In', t))).toEqual([0, 1, 1, 1, 1]);
    expect([0, 0.49, 0.5, 0.99].map((t) => easeAlpha('Constant', 'InOut', t))).toEqual([0, 0, 1, 1]);
    expect([0, 0.5, 0.99].map((t) => easeAlpha('Constant', 'Out', t))).toEqual([0, 0, 0]);
    // Elastic InOut uses a 0.45 period, where In and Out use 0.3. With 0.3 this
    // sample read 0.0547: 12.006° short of Studio on a 90° move.
    expect(easeAlpha('Elastic', 'InOut', 14 / 30)).toBeCloseTo(0.18809, 4);
    // Bounce InOut: the In shape in both halves. Studio read 0.0799 and 0.5799.
    expect(easeAlpha('Bounce', 'InOut', 10 / 30)).toBeCloseTo(0.0799, 4);
    expect(easeAlpha('Bounce', 'InOut', 25 / 30)).toBeCloseTo(0.5799, 4);
    for (const style of ['Linear', 'Cubic', 'CubicV2', 'Bounce', 'Elastic'] as const) {
      for (const direction of ['In', 'Out', 'InOut'] as const) {
        expect(easeAlpha(style, direction, 0)).toBeCloseTo(0);
        expect(easeAlpha(style, direction, 1)).toBeCloseTo(1);
      }
    }
  });
});

describe('sampling', () => {
  test('interpolates between keys and holds before the first and after the last', () => {
    const tracks = buildTracks(animation([
      { time: 0, joints: { RightShoulder: { rotation: [0, 0, 0] } } },
      { time: 1, joints: { RightShoulder: { rotation: [90, 0, 0] } } },
    ]));
    const angle = (t: number) => {
      const r = sampleTrack(tracks.get('RightUpperArm'), t).r;
      return (Math.atan2(r[7], r[8]) * 180) / Math.PI;
    };
    expect(angle(0.5)).toBeCloseTo(45);
    expect(angle(0.1)).toBeCloseTo(9);
    expect(angle(-1)).toBeCloseTo(0);
    expect(angle(5)).toBeCloseTo(90);
    // A part with no keys rests.
    close(sampleTrack(tracks.get('Head'), 0.5).r, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test('refuses an easing it does not know instead of guessing', () => {
    // Data read from Studio arrives untyped.
    const broken = JSON.parse(JSON.stringify({
      loop: false,
      keyframes: [{
        time: 0,
        root: { part: 'Head', weight: 1, cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], easingStyle: 'Sine', easingDirection: 'In', children: [] },
      }],
    })) as MotionSequence;
    expect(() => buildTracks(broken)).toThrow('Head at 0 s has an unknown easing: Sine In');
  });

  test('stands the rest pose on the ground and swings the arm forward for +X', () => {
    const rest = poseRig(buildTracks({ loop: false, keyframes: [] }), 0);
    close(rest.parts.get('LowerTorso')!.p, [0, -0.8, 0]);
    // The foot's sole is on the ground, HipHeight below the root part's base.
    close(pointToWorld(rest.parts.get('RightFoot')!, [0, -0.155, 0]), [0.5, -3.19, 0]);

    const raised = poseRig(buildTracks(animation([{ time: 0, joints: { RightShoulder: { rotation: [90, 0, 0] } } }])), 0);
    const hand = raised.parts.get('RightHand')!.p;
    const shoulder = raised.parts.get('RightUpperArm')!.p;
    expect(hand[2]).toBeLessThan(-1.5);
    expect(hand[1]).toBeCloseTo(shoulder[1], 0);
  });
});

describe('checkMotion', () => {
  test('passes a still pose, and runs the gait checks only for locomotion', () => {
    const still = animation([{ time: 0, joints: { Neck: {} } }, { time: 1, joints: { Neck: {} } }], true);
    const report = checkMotion(still);
    expect(report.passed).toBe(true);
    expect(report.checks.map((entry) => [entry.id, entry.status])).toEqual([
      ['jointLimits', 'pass'],
      ['velocity', 'pass'],
      ['rootDrift', 'pass'],
      ['loopContinuity', 'pass'],
      ['groundContact', 'skipped'],
      ['footSliding', 'skipped'],
      ['gaitSymmetry', 'skipped'],
    ]);
    const asGait = checkMotion(still, { locomotion: true });
    expect(check(asGait, 'groundContact')).toMatchObject({ status: 'pass', measured: { penetration: 0, groundedShare: 1 } });
    expect(check(asGait, 'footSliding').status).toBe('pass');
    expect(check(asGait, 'gaitSymmetry')).toMatchObject({ status: 'fail', detail: 'the hips barely swing (0°); a gait needs at least 5°' });
  });

  test('fails a knee bent the wrong way and a twisted hinge', () => {
    const report = checkMotion(animation([{ time: 0, joints: { RightKnee: { rotation: [30, 0, 0] }, LeftKnee: { rotation: [-20, 50, 0] } } }]));
    const limits = check(report, 'jointLimits');
    expect(limits.status).toBe('fail');
    // The worst excess leads: 20° past the knee's forward limit, then 15° off axis.
    expect(limits.detail).toBe('RightKnee bends to 30° at 0 s; limit 10°, and 1 more');
    expect(limits.measured['LeftKnee.offAxis']).toBe(50);
    expect(limits.measured['RightKnee.bendMax']).toBe(30);
    expect(report.passed).toBe(false);
  });

  test('fails a turn past a joint range', () => {
    const limits = check(checkMotion(animation([{ time: 0, joints: { Neck: { rotation: [0, 120, 0] } } }])), 'jointLimits');
    expect(limits).toMatchObject({ status: 'fail', detail: 'Neck turns 120° at 0 s; limit 90°' });
  });

  test('fails a joint that moves faster than the speed limit', () => {
    // 90° in 0.03 s: 3000°/s, sampled over two uneven steps.
    const report = checkMotion(animation([
      { time: 0, joints: { RightShoulder: { rotation: [0, 0, 0] } } },
      { time: 0.03, joints: { RightShoulder: { rotation: [90, 0, 0] } } },
    ]));
    const velocity = check(report, 'velocity');
    expect(velocity.status).toBe('fail');
    expect(velocity.measured.RightShoulder).toBe(3000);
    expect(velocity.detail).toBe('fastest: RightShoulder at 3000°/s around 0.02 s; limit 2500°/s');
  });

  test('fails a loop whose last pose does not meet its first', () => {
    const seam = check(checkMotion(animation([
      { time: 0, joints: { Waist: { rotation: [0, 0, 0] } } },
      { time: 1, joints: { Waist: { rotation: [0, 20, 0] } } },
    ], true)), 'loopContinuity');
    expect(seam).toMatchObject({
      status: 'fail',
      detail: 'Waist jumps 20° where the loop restarts, against 0.3° per sample either side; limit 3°',
    });
  });

  test('passes a loop whose motion carries on through the seam', () => {
    // 8° short of closing the loop, but the waist is turning 1.7° a sample there.
    const seam = check(checkMotion(animation([
      { time: 0, joints: { Waist: { rotation: [0, 0, 0] } } },
      { time: 0.5, joints: { Waist: { rotation: [0, 60, 0] } } },
      { time: 1, joints: { Waist: { rotation: [0, 8, 0] } } },
    ], true)), 'loopContinuity');
    expect(seam).toMatchObject({ status: 'pass', measured: { jointDegrees: 8, jointLocalDegrees: 2 } });
  });

  test('fails a body that wanders from the root part or does not come back', () => {
    const far = check(checkMotion(animation([
      { time: 0, joints: { Root: { position: [0, 0, 0] } } },
      { time: 0.5, joints: { Root: { position: [3, 0, 0] } } },
      { time: 1, joints: { Root: { position: [0, 0, 0] } } },
    ])), 'rootDrift');
    expect(far).toMatchObject({ status: 'fail', measured: { excursion: 3, returnGap: 0 } });
    const gone = check(checkMotion(animation([
      { time: 0, joints: { Root: { position: [0, 0, 0] } } },
      { time: 1, joints: { Root: { position: [0, 0, 1] } } },
    ])), 'rootDrift');
    expect(gone).toMatchObject({ status: 'fail', measured: { excursion: 1, returnGap: 1 } });
  });

  test('fails feet that sink into the ground or slide forward while planted', () => {
    const sunk = check(checkMotion(animation([{ time: 0, joints: { Root: { position: [0, -0.5, 0] } } }]), { locomotion: true }), 'groundContact');
    expect(sunk).toMatchObject({ status: 'fail', measured: { penetration: 0.5 } });
    expect(sunk.detail).toBe('LeftFoot sinks 0.5 studs into the ground at 0 s; limit 0.1');

    const forward = animation([
      { time: 0, joints: { Root: { position: [0, 0, 0] } } },
      { time: 0.5, joints: { Root: { position: [0, 0, -1] } } },
    ]);
    const sliding = check(checkMotion(forward, { locomotion: true }), 'footSliding');
    expect(sliding).toMatchObject({ status: 'fail', measured: { slide: 1 } });
    expect(sliding.detail).toBe('LeftFoot slides 1 studs while planted, by 0.5 s; limit 0.25');
    // Planted feet moving back with the ground are how an in-place gait walks.
    const backward = animation([
      { time: 0, joints: { Root: { position: [0, 0, 0] } } },
      { time: 0.5, joints: { Root: { position: [0, 0, 1] } } },
    ]);
    expect(check(checkMotion(backward, { locomotion: true }), 'footSliding')).toMatchObject({ status: 'pass', measured: { slide: 0 } });
  });

  test('measures the legs half a cycle apart in a gait, and flags legs in step or uneven', () => {
    const even = check(checkMotion(walk(), { locomotion: true }), 'gaitSymmetry');
    expect(even).toMatchObject({ status: 'pass', measured: { amplitudeLeft: 25, amplitudeRight: 25, amplitudeRatio: 1, phase: 0.5 } });

    const together = check(checkMotion(walk(25, 25), { locomotion: true }), 'gaitSymmetry');
    expect(together).toMatchObject({ status: 'fail', measured: { phase: 0 } });
    expect(together.detail).toBe('the legs are 0 of a cycle apart; a gait needs 0.4 to 0.6');

    const limping = check(checkMotion(walk(25, -10), { locomotion: true }), 'gaitSymmetry');
    expect(limping).toMatchObject({ status: 'fail', measured: { amplitudeRatio: 0.4 } });
  });
});
