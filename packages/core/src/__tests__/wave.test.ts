// The wave generator: a description's waves become rotation keys that send a
// sine down a chain of joints, each trailing the one before; a loop meets
// itself; and what a wave cannot do is refused with its path.
import { describe, expect, test } from '@jest/globals';
import { prepareAnimation } from '../animation/animation-tool.js';
import { rigFromModel } from '../animation/model-rig.js';
import { buildTracks, sampleTrack } from '../animation/motion.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import type { Rig } from '../animation/rig.js';
import { ARMS, armDeclarations, armJoints, partsOctopus } from './fixtures/parts-octopus.js';

function octopus(declarations?: unknown): Rig {
  const result = rigFromModel(partsOctopus({ declarations }));
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.rig;
}

function compiled(input: Record<string, unknown>, rig: Rig): KeyframeSequenceDescription {
  const result = compilePoseAnimation({ name: 'Sway', rig: rig.name, ...input }, rig);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.sequence;
}

const errorsOf = (input: Record<string, unknown>, rig: Rig): string[] => {
  const result = compilePoseAnimation({ name: 'Sway', rig: rig.name, ...input }, rig);
  return result.ok ? [] : result.errors;
};

/** A part's turn about X and about Z at a time, in degrees: its joint's frame is the body's. */
function turnOf(sequence: KeyframeSequenceDescription, part: string, time: number): { x: number; z: number } {
  const r = sampleTrack(buildTracks(sequence).get(part), time).r;
  const degrees = (radians: number) => (radians * 180) / Math.PI;
  // CFrame.Angles(x, 0, z) is Rx * Rz.
  return { x: degrees(Math.atan2(-r[5], r[8])), z: degrees(Math.atan2(-r[1], r[0])) };
}

describe('a wave sends a sine down a chain of joints', () => {
  const rig = octopus();
  const arm = armJoints(1);

  test('waves and a duration are a whole animation, keyed twelve times a cycle', () => {
    const sequence = compiled({ loop: true, duration: 2, waves: [{ joints: arm, axis: 'X', amplitude: 20, lag: 0.125 }] }, rig);
    expect(sequence.duration).toBe(2);
    expect(sequence.keyframes).toHaveLength(13);
    expect(sequence.joints).toEqual(arm);
    // Each joint is where the sine puts it, at a key and between keys.
    arm.forEach((name, index) => {
      for (const time of [0, 0.5, 1, 1.5]) {
        expect(turnOf(sequence, name, time).x).toBeCloseTo(20 * Math.sin(2 * Math.PI * (time / 2 - 0.125 * index)), 2);
      }
      const between = turnOf(sequence, name, 0.25).x;
      expect(Math.abs(between - 20 * Math.sin(2 * Math.PI * (0.125 - 0.125 * index)))).toBeLessThan(20 * 0.04);
    });
  });

  test('the wave runs from the first joint to the last: each peaks after the one before', () => {
    const sequence = compiled({ loop: true, duration: 2, waves: [{ joints: arm, axis: 'X', amplitude: 20, lag: 0.125 }] }, rig);
    const peaks = arm.map((name) => {
      let best = { time: 0, turn: -Infinity };
      for (let step = 0; step < 200; step += 1) {
        const time = (2 * step) / 200;
        const turn = turnOf(sequence, name, time).x;
        if (turn > best.turn) best = { time, turn };
      }
      return best.time;
    });
    // Within a key's spacing of where the sine peaks, and each later than the last.
    peaks.forEach((time, index) => {
      expect(Math.abs(time - (0.5 + 0.25 * index))).toBeLessThanOrEqual(2 / 12 / 2 + 0.01);
      if (index > 0) expect(time).toBeGreaterThan(peaks[index - 1]);
    });
  });

  test('a loop\'s last key is its first', () => {
    const sequence = compiled({ loop: true, duration: 1.7, waves: [{ joints: arm, axis: 'Z', amplitude: [5, 30], cycles: 3, lag: 0.2, phase: 0.3 }] }, rig);
    expect(sequence.keyframes).toHaveLength(37);
    expect(JSON.stringify(sequence.keyframes[36].root)).toBe(JSON.stringify(sequence.keyframes[0].root));
  });

  test('amplitude and offset run evenly from the first joint to the last', () => {
    const sequence = compiled({ duration: 1, waves: [{ joints: arm, axis: 'X', amplitude: [0, 30], offset: [10, -20], phase: 0.25 }] }, rig);
    // At phase 0.25 every joint is at its peak: offset + amplitude.
    expect(arm.map((name) => Math.round(turnOf(sequence, name, 0).x))).toEqual([10, 10, 10, 10]);
    expect(arm.map((name) => Math.round(turnOf(sequence, name, 0.5).x))).toEqual([10, -10, -30, -50]);
  });

  test('two waves share a joint about different axes', () => {
    const sequence = compiled({
      loop: true,
      duration: 2,
      waves: [
        { joints: arm, axis: 'X', amplitude: 15, phase: 0.25 },
        { joints: arm, axis: 'Z', amplitude: 8, cycles: 2, phase: 0.25 },
      ],
    }, rig);
    expect(sequence.keyframes).toHaveLength(25);
    const start = turnOf(sequence, arm[0], 0);
    expect(start.x).toBeCloseTo(15, 1);
    expect(start.z).toBeCloseTo(8, 1);
  });

  test('hand keyframes keep their place, and one beside a wave\'s key carries it', () => {
    const sequence = compiled({
      duration: 1.2,
      keyframes: [
        { time: 0, joints: { Arm2: { rotation: [0, 0, 20] } } },
        { time: 0.301, joints: { Arm2: { rotation: [0, 0, -20] } }, markers: [{ name: 'Flick' }] },
        { time: 0.75, joints: { Arm2: { rotation: [0, 0, 0] } } },
      ],
      waves: [{ joints: arm, axis: 'X', amplitude: 20 }],
    }, rig);
    // Twelve steps of 0.1 s: 0.3 is taken by the hand key at 0.301, 0.75 is its own.
    expect(sequence.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.1, 0.2, 0.301, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.2]);
    expect(sequence.markerCount).toBe(1);
    expect(sequence.joints).toEqual([...arm, 'Arm2']);
    expect(turnOf(sequence, 'Arm1', 0.301).x).toBeCloseTo(20 * Math.sin(2 * Math.PI * (0.301 / 1.2)), 2);
    expect(turnOf(sequence, 'Arm2', 0.301).z).toBeCloseTo(-20, 2);
  });

  test('without duration, the last keyframe is the length', () => {
    const sequence = compiled({
      keyframes: [{ time: 0, joints: { Arm2: { rotation: [0, 0, 10] } } }, { time: 1, joints: { Arm2: { rotation: [0, 0, 0] } } }],
      waves: [{ joints: arm, axis: 'X', amplitude: 20 }],
    }, rig);
    expect(sequence.duration).toBe(1);
    expect(sequence.keyframes).toHaveLength(13);
  });

  test('a wave works on R15 too', () => {
    const result = compilePoseAnimation({ name: 'Sway', rig: 'R15', loop: true, duration: 2, waves: [{ joints: ['Waist', 'Neck'], axis: 'Z', amplitude: [4, 8], lag: 0.2 }] });
    expect(result.ok && result.sequence.joints).toEqual(['Waist', 'Neck']);
  });

  test('an animation without waves compiles as it did', () => {
    const plain = { keyframes: [{ time: 0, joints: { Arm1: { rotation: [10, 0, 0] } } }, { time: 1, joints: { Arm1: { rotation: [0, 0, 0] } } }] };
    expect(compiled(plain, rig).keyframes).toHaveLength(2);
  });
});

describe('what a wave cannot do is refused', () => {
  const rig = octopus();
  const arm = armJoints(1);
  const wave = (changes: Record<string, unknown> = {}) => ({ joints: arm, axis: 'X', amplitude: 20, ...changes });

  test('a joint a wave drives is not keyed by hand', () => {
    expect(errorsOf({
      keyframes: [{ time: 0, joints: { Arm1B: { rotation: [5, 0, 0] } } }, { time: 1, joints: { Arm1B: { rotation: [0, 0, 0] } } }],
      waves: [wave()],
    }, rig)).toEqual([
      'keyframes[0].joints.Arm1B: waves[0] drives this joint; take it out of the wave or do not key it by hand',
      'keyframes[1].joints.Arm1B: waves[0] drives this joint; take it out of the wave or do not key it by hand',
    ]);
  });

  test('a loop needs whole cycles', () => {
    expect(errorsOf({ loop: true, duration: 1, waves: [wave({ cycles: 1.5 })] }, rig))
      .toEqual(['waves[0].cycles: must be a whole number in a loop, so the wave meets itself at the seam']);
    expect(errorsOf({ duration: 1, waves: [wave({ cycles: 1.5 })] }, rig)).toEqual([]);
  });

  test('two waves about one axis do not share a joint', () => {
    expect(errorsOf({ duration: 1, waves: [wave(), wave({ joints: ['Arm1D'] })] }, rig))
      .toEqual(['waves[1].joints: "Arm1D" already turns about X in waves[0]; two waves share a joint only about different axes']);
  });

  test('the chain names joints of the rig, each once', () => {
    const errors = errorsOf({ duration: 1, waves: [wave({ joints: ['Arm1', 'Arm1', 'Mantle', 'Fin'] })] }, rig);
    expect(errors[0]).toBe('waves[0].joints[1]: "Arm1" is in the chain twice');
    expect(errors[1]).toBe('waves[0].joints[2]: "Mantle" is a part; name the joint that moves it, "Root"');
    expect(errors[2]).toMatch(/^waves\[0\]\.joints\[3\]: unknown joint; the rig's joints are Root, Arm1, /);
  });

  test('each field says what it takes', () => {
    expect(errorsOf({ duration: 1, waves: [wave({ axis: 'up', amplitude: 200, lag: 2, offset: 'curl', speed: 2 })] }, rig)).toEqual([
      'waves[0]: unknown field "speed"; expected joints, axis, amplitude, cycles, lag, offset, phase',
      'waves[0].axis: must be X, Y or Z: the body axis at rest the joints turn about',
      'waves[0].amplitude: must be degrees within ±180, or [first, last] along the chain',
      'waves[0].offset: must be degrees within ±180, or [first, last] along the chain',
      'waves[0].lag: must be cycles within ±1',
    ]);
  });

  test('a wave needs a length, and a duration needs a wave', () => {
    expect(errorsOf({ waves: [wave()] }, rig)).toEqual(['duration: waves need the animation\'s length: give duration in seconds, or a last keyframe']);
    expect(errorsOf({ duration: 0.5, keyframes: [{ time: 0, joints: { Arm2: {} } }, { time: 1, joints: { Arm2: {} } }], waves: [wave()] }, rig))
      .toEqual(['duration: must not be before the last keyframe (1)']);
    expect(errorsOf({ duration: 1, keyframes: [{ time: 0, joints: { Arm2: {} } }] }, rig))
      .toEqual(['duration: goes with waves; without them the last keyframe\'s time is the animation\'s length']);
  });

  test('more keys than an animation may have are refused', () => {
    expect(errorsOf({ duration: 10, waves: [wave({ cycles: 20 })] }, rig))
      .toEqual(['waves: their keys make 241 keyframes, over the 240 an animation may have; use fewer cycles']);
  });
});

describe('an octopus sways and swims on waves alone', () => {
  const rig = octopus(armDeclarations());
  const all = (wave: (arm: number) => Record<string, unknown>[]) => Array.from({ length: ARMS }, (_unused, index) => wave(index + 1)).flat();

  test('an idle of eight arms swaying out of step passes every check it can run', () => {
    const idle = {
      name: 'Idle', rig: rig.name, loop: true, priority: 'Idle', duration: 4,
      waves: all((arm) => [
        { joints: armJoints(arm), axis: 'X', amplitude: [4, 14], lag: 0.12, phase: arm / ARMS },
        { joints: armJoints(arm), axis: 'Z', amplitude: [3, 10], lag: 0.12, phase: arm / ARMS + 0.25 },
      ]),
    };
    const prepared = prepareAnimation(idle, {}, rig);
    if (!prepared.ok) throw new Error(prepared.errors.join('; '));
    expect(prepared.value.failing).toEqual([]);
    expect(prepared.value.sequence.joints).toHaveLength(ARMS * 4);
    const status = Object.fromEntries(prepared.value.report.checks.map((check) => [check.id, check.status]));
    expect(status).toMatchObject({ jointLimits: 'pass', velocity: 'pass', loopContinuity: 'pass' });
  });

  test('a swim stroke curls every arm together, tips trailing', () => {
    const swim = {
      name: 'Swim', rig: rig.name, loop: true, priority: 'Movement', duration: 1.6,
      waves: all((arm) => {
        // Each arm opens away from the body's middle: about X for the arms fore and aft, about Z for those at the sides.
        const angle = ((arm - 1) / ARMS) * 2 * Math.PI;
        return [
          { joints: armJoints(arm), axis: 'X', amplitude: [18 * Math.cos(angle), 30 * Math.cos(angle)], lag: 0.1 },
          { joints: armJoints(arm), axis: 'Z', amplitude: [18 * Math.sin(angle), 30 * Math.sin(angle)], lag: 0.1 },
        ];
      }),
    };
    const prepared = prepareAnimation(swim, {}, rig);
    if (!prepared.ok) throw new Error(prepared.errors.join('; '));
    expect(prepared.value.failing).toEqual([]);
    // Every arm's base is at the same point of its stroke; each tip trails its base.
    const sequence = prepared.value.sequence;
    const reach = (name: string, time: number) => Math.hypot(turnOf(sequence, name, time).x, turnOf(sequence, name, time).z);
    // At the stroke's widest, each arm's first segment leans away from the body's middle.
    const tracks = buildTracks(sequence);
    for (let arm = 1; arm <= ARMS; arm += 1) {
      const angle = ((arm - 1) / ARMS) * 2 * Math.PI;
      const r = sampleTrack(tracks.get(`Arm${arm}`), 0.4).r;
      // Where the turn carries straight down, [0, -1, 0]: the frame's second column, reversed.
      const lean = [-r[1], -r[7]];
      expect(lean[0] * Math.sin(angle) - lean[1] * Math.cos(angle)).toBeCloseTo(Math.sin((18 * Math.PI) / 180), 1);
      expect(reach(`Arm${arm}`, 0.4)).toBeCloseTo(18, 0);
      expect(reach(`Arm${arm}D`, 0.4)).toBeLessThan(reach(`Arm${arm}D`, 0.88));
    }
  });
});
