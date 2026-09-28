import {
  compilePoseAnimation,
  poseCFrame,
  POSE_LIMITS,
  type CompiledPose,
  type KeyframeSequenceDescription,
} from '../animation/pose-compiler.js';
import { R15_RIG } from '../animation/r15-rig.js';

function compiled(input: unknown): KeyframeSequenceDescription {
  const result = compilePoseAnimation(input);
  if (!result.ok) throw new Error(`expected success, got:\n${result.errors.join('\n')}`);
  return result.sequence;
}

function errors(input: unknown): string[] {
  const result = compilePoseAnimation(input);
  if (result.ok) throw new Error('expected validation errors');
  expect(result).not.toHaveProperty('sequence');
  return result.errors;
}

function flatten(pose: CompiledPose): CompiledPose[] {
  return [pose, ...pose.children.flatMap(flatten)];
}

function outline(pose: CompiledPose): string {
  const own = `${pose.part}${pose.weight === 0 ? '*' : ''}`;
  return pose.children.length ? `${own}(${pose.children.map(outline).join(' ')})` : own;
}

// The spike's stiff walk: arms and legs swing in opposite phase.
function swing(overrides: Record<string, unknown> = {}) {
  const keyframe = (time: number, angle: number) => ({
    time,
    joints: {
      RightShoulder: { rotation: [angle, 0, 0] },
      LeftShoulder: { rotation: [-angle, 0, 0] },
      RightHip: { rotation: [-angle, 0, 0] },
      LeftHip: { rotation: [angle, 0, 0] },
    },
  });
  return {
    name: 'SpikeSwing',
    rig: 'R15',
    loop: true,
    priority: 'Action',
    keyframes: [keyframe(0, 40), keyframe(0.5, -40), keyframe(1, 40)],
    ...overrides,
  };
}

describe('R15 rig', () => {
  test('matches the rest pose the spike measured', () => {
    expect(R15_RIG.joints).toHaveLength(15);
    expect(Object.keys(R15_RIG.parts)).toHaveLength(16);
    const reached = new Set([R15_RIG.rootPart]);
    for (const joint of R15_RIG.joints) {
      // Parents come first, so a pose tree can be built in one pass.
      expect(reached.has(joint.parentPart)).toBe(true);
      expect(reached.has(joint.childPart)).toBe(false);
      expect(R15_RIG.parts[joint.childPart]).toBeDefined();
      reached.add(joint.childPart);
    }
    expect(reached.size).toBe(16);
  });
});

describe('poseCFrame', () => {
  test('builds CFrame.Angles order: X after Y after Z', () => {
    // CFrame.Angles(0, math.rad(90), 0) turns +X to -Z.
    const yaw = poseCFrame([0, 90, 0]);
    expect([yaw[3], yaw[6], yaw[9]]).toEqual([0, 0, -1]);
    // Rx(90) * Ry(90) differs from Ry(90) * Rx(90), so this pins the order.
    expect(poseCFrame([90, 90, 0])).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]);
    expect(poseCFrame([0, 0, 90])).toEqual([0, 0, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1]);
  });

  test('carries a position and rounds away floating-point noise', () => {
    expect(poseCFrame([0, 0, 0], [0, -0.25, 0.5])).toEqual([0, -0.25, 0.5, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const pitch = poseCFrame([40, 0, 0]);
    expect(pitch[7]).toBe(0.766044);
    expect(pitch[8]).toBe(-0.642788);
    expect(pitch.every((value) => !Object.is(value, -0))).toBe(true);
  });
});

describe('compilePoseAnimation', () => {
  test('compiles the spike swing into part-keyed poses with the hierarchy kept', () => {
    const sequence = compiled(swing());
    expect(sequence).toMatchObject({ name: 'SpikeSwing', rig: 'R15', loop: true, priority: 'Action', duration: 1 });
    expect(sequence.joints).toEqual(['LeftShoulder', 'RightShoulder', 'LeftHip', 'RightHip']);
    expect(sequence.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.5, 1]);
    // The spike's sequence also had 3 keyframes and 21 poses.
    expect(sequence.poseCount).toBe(21);
    expect(sequence.keyedPoseCount).toBe(12);
    expect(outline(sequence.keyframes[0].root)).toBe(
      'HumanoidRootPart*(LowerTorso*(UpperTorso*(LeftUpperArm RightUpperArm) LeftUpperLeg RightUpperLeg))',
    );

    const poses = flatten(sequence.keyframes[1].root);
    const arm = poses.find((pose) => pose.part === 'RightUpperArm')!;
    expect(arm).toMatchObject({ joint: 'RightShoulder', weight: 1, easingStyle: 'Linear', easingDirection: 'In' });
    expect(arm.cframe).toEqual(poseCFrame([-40, 0, 0]));
    const placeholder = poses.find((pose) => pose.part === 'UpperTorso')!;
    expect(placeholder).toMatchObject({ joint: 'Waist', weight: 0, cframe: poseCFrame([0, 0, 0]) });
    expect(poses[0]).not.toHaveProperty('joint');
  });

  test('keys only what each keyframe names, and an empty pose is the rest pose', () => {
    const sequence = compiled({
      name: 'Nod',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { Neck: {}, RightElbow: { rotation: [0, 0, 10] } } },
        { time: 0.4, name: 'Down', joints: { Neck: { rotation: [-20, 0, 0] } } },
      ],
    });
    expect(sequence).toMatchObject({ loop: false, priority: 'Action', duration: 0.4, joints: ['Neck', 'RightElbow'] });
    expect(outline(sequence.keyframes[0].root)).toBe(
      'HumanoidRootPart*(LowerTorso*(UpperTorso*(Head RightUpperArm*(RightLowerArm))))',
    );
    expect(outline(sequence.keyframes[1].root)).toBe('HumanoidRootPart*(LowerTorso*(UpperTorso*(Head)))');
    expect(sequence.keyframes[1].name).toBe('Down');
    expect(sequence.keyframes[0]).not.toHaveProperty('name');
    const head = flatten(sequence.keyframes[0].root).find((pose) => pose.part === 'Head')!;
    expect(head).toMatchObject({ weight: 1, cframe: poseCFrame([0, 0, 0]) });
  });

  test('resolves easing per field: joint, then keyframe, then animation', () => {
    const sequence = compiled({
      name: 'Eased',
      rig: 'R15',
      easing: { style: 'CubicV2', direction: 'InOut' },
      keyframes: [
        {
          time: 0,
          easing: { direction: 'Out' },
          joints: { Neck: {}, Waist: { easing: { style: 'Constant' } } },
        },
        { time: 1, joints: { Neck: {}, Waist: {} } },
      ],
    });
    const first = flatten(sequence.keyframes[0].root);
    expect(first.find((pose) => pose.joint === 'Neck')).toMatchObject({ easingStyle: 'CubicV2', easingDirection: 'Out' });
    expect(first.find((pose) => pose.joint === 'Waist')).toMatchObject({ easingStyle: 'Constant', easingDirection: 'Out' });
    const second = flatten(sequence.keyframes[1].root);
    expect(second.find((pose) => pose.joint === 'Neck')).toMatchObject({ easingStyle: 'CubicV2', easingDirection: 'InOut' });
  });

  test('lets Root offset the body and refuses a position on any other joint', () => {
    const sequence = compiled({
      name: 'Bob',
      rig: 'R15',
      keyframes: [{ time: 0, joints: { Root: { position: [0, -0.3, 0], rotation: [10, 0, 0] } } }],
    });
    const lower = sequence.keyframes[0].root.children[0];
    expect(lower).toMatchObject({ part: 'LowerTorso', joint: 'Root', weight: 1 });
    expect(lower.cframe).toEqual(poseCFrame([10, 0, 0], [0, -0.3, 0]));
    expect(sequence.duration).toBe(0);

    expect(errors({
      name: 'Stretch',
      rig: 'R15',
      keyframes: [{ time: 0, joints: { RightShoulder: { position: [0, 1, 0] } } }],
    })).toEqual(['keyframes[0].joints.RightShoulder.position: only Root takes a position; other joints only rotate']);
  });

  test('reports every problem at once, with its path', () => {
    const problems = errors({
      name: '',
      rig: 'R15',
      loop: 'yes',
      priority: 'High',
      speed: 2,
      keyframes: [
        { time: 0.1, joints: { RightUpperArm: { rotation: [10, 0, 0] }, Neck: { rotaton: [1, 2, 3] } } },
        { time: 0.1, joints: { Waist: { rotation: [0, 400, Number.NaN] } } },
        { time: 0.05, easing: { style: 'Sine' }, joints: {} },
      ],
    });
    expect(problems).toEqual([
      'animation: unknown field "speed"; expected name, rig, loop, priority, easing, keyframes',
      'name: must be a non-empty string',
      'loop: must be true or false',
      'priority: must be one of Core, Idle, Movement, Action, Action2, Action3, Action4',
      'keyframes[0].time: the first keyframe must be at time 0',
      'keyframes[0].joints.RightUpperArm: "RightUpperArm" is a part; key the joint that moves it, "RightShoulder"',
      'keyframes[0].joints.Neck: unknown field "rotaton"; expected rotation, aim, bendToward, bend, position, easing',
      'keyframes[1].time: must be later than the previous keyframe (0.1)',
      'keyframes[1].joints.Waist.rotation[1]: must be within ±360 degrees',
      'keyframes[1].joints.Waist.rotation[2]: must be a finite number',
      'keyframes[2].time: must be later than the previous keyframe (0.1)',
      'keyframes[2].easing.style: must be one of Linear, Constant, Elastic, Cubic, Bounce, CubicV2',
      'keyframes[2].joints: must key at least one joint',
      'keyframes[0].joints: "Waist" is keyed later, so it must be keyed in the first keyframe too',
    ]);
  });

  test('refuses a turn over 90° between one key and the next, unless the earlier key snaps', () => {
    const turn = (style?: string) => ({
      name: 'Swing',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { RightShoulder: { rotation: [-50, 0, 0], ...(style ? { easing: { style } } : {}) } } },
        { time: 0.5, joints: { RightShoulder: { rotation: [60, 0, 0] } } },
      ],
    });
    expect(errors(turn())).toEqual([
      'keyframes[1].joints.RightShoulder: turns 110° from its key at 0 s; split turns over 90° across more keyframes',
    ]);
    expect(errors(turn('CubicV2'))).toHaveLength(1);
    expect(compilePoseAnimation(turn('Constant')).ok).toBe(true);
    // Split across a middle key, the same swing is fine.
    expect(compilePoseAnimation({
      ...turn(),
      keyframes: [...turn().keyframes.slice(0, 1), { time: 0.25, joints: { RightShoulder: { rotation: [5, 0, 0] } } }, { time: 0.5, joints: { RightShoulder: { rotation: [60, 0, 0] } } }],
    }).ok).toBe(true);
  });

  test('aims a limb and bends a hinge, and refuses them where they do not apply', () => {
    // Upper arm straight out to the right, elbow folding up: the wave that rotation angles hide.
    const wave = compilePoseAnimation({
      name: 'Wave',
      rig: 'R15',
      keyframes: [{ time: 0, joints: { RightShoulder: { aim: [1, 0, 0], bendToward: [0, 1, 0] }, RightElbow: { bend: 90 } } }],
    });
    if (!wave.ok) throw new Error(wave.errors.join('\n'));
    const poses = (function flatten(pose: CompiledPose): CompiledPose[] { return [pose, ...pose.children.flatMap(flatten)]; })(wave.sequence.keyframes[0].root);
    expect(poses.find((pose) => pose.joint === 'RightShoulder')!.cframe).toEqual(poseCFrame([90, 0, 90]));
    expect(poses.find((pose) => pose.joint === 'RightElbow')!.cframe).toEqual(poseCFrame([90, 0, 0]));

    // At rest, an arm hangs and a leg stands: both aims come out as the identity.
    const rest = compilePoseAnimation({
      name: 'Rest',
      rig: 'R15',
      keyframes: [{ time: 0, joints: { LeftShoulder: { aim: [0, -1, 0] }, RightHip: { aim: [0, -1, 0] }, LeftKnee: { bend: 30 } } }],
    });
    if (!rest.ok) throw new Error(rest.errors.join('\n'));
    const restPoses = (function flatten(pose: CompiledPose): CompiledPose[] { return [pose, ...pose.children.flatMap(flatten)]; })(rest.sequence.keyframes[0].root);
    expect(restPoses.find((pose) => pose.joint === 'LeftShoulder')!.cframe).toEqual(poseCFrame([0, 0, 0]));
    expect(restPoses.find((pose) => pose.joint === 'RightHip')!.cframe).toEqual(poseCFrame([0, 0, 0]));
    // A knee flexes the shin back: negative about X.
    expect(restPoses.find((pose) => pose.joint === 'LeftKnee')!.cframe).toEqual(poseCFrame([-30, 0, 0]));

    expect(errors({
      name: 'Bad',
      rig: 'R15',
      keyframes: [{
        time: 0,
        joints: {
          Neck: { aim: [0, 1, 0] },
          Waist: { bend: 10 },
          LeftShoulder: { aim: [0, 0, 0] },
          RightShoulder: { aim: [1, 0, 0], rotation: [0, 0, 90] },
          LeftHip: { bendToward: [0, 0, 1] },
        },
      }],
    })).toEqual([
      'keyframes[0].joints.Neck: aim and bendToward work on shoulders and hips; use rotation here',
      'keyframes[0].joints.Waist.bend: works on elbows and knees; use rotation here',
      'keyframes[0].joints.LeftShoulder.aim: must point somewhere: [right, up, forward], not all zero',
      'keyframes[0].joints.RightShoulder: give one of rotation, aim or bend, not rotation and aim',
      'keyframes[0].joints.LeftHip.bendToward: goes with aim',
    ]);
  });

  test('refuses rigs it does not know, including inherited object keys', () => {
    for (const rig of ['R6', 'toString', '__proto__', undefined]) {
      expect(errors(swing({ rig }))).toEqual(['rig: must be one of R15']);
    }
  });

  test('refuses unknown joints and non-object input', () => {
    expect(errors(null)).toEqual(['animation: must be an object']);
    expect(errors([swing()])).toEqual(['animation: must be an object']);
    const [problem] = errors({ name: 'X', rig: 'R15', keyframes: [{ time: 0, joints: { Tail: {} } }] });
    expect(problem).toBe(`keyframes[0].joints.Tail: unknown joint; the rig's joints are ${R15_RIG.joints.map((joint) => joint.name).join(', ')}`);
  });

  test('bounds keyframes, duration, names and the error list', () => {
    const keyframes = Array.from({ length: POSE_LIMITS.maxKeyframes + 1 }, (_unused, index) => ({
      time: index / 30,
      joints: { Neck: {} },
    }));
    expect(errors(swing({ keyframes }))).toEqual([`keyframes: must have at most ${POSE_LIMITS.maxKeyframes} keyframes`]);
    expect(errors(swing({ keyframes: [] }))).toEqual(['keyframes: must be a non-empty array']);
    expect(errors(swing({
      keyframes: [{ time: 0, joints: { Neck: {} } }, { time: 61, joints: { Neck: {} } }],
    }))).toEqual([`keyframes[1].time: must be at most ${POSE_LIMITS.maxDurationSeconds} seconds`]);
    expect(errors(swing({ name: 'x'.repeat(101) }))).toEqual(['name: must be at most 100 characters']);
    expect(errors(swing({ name: 'Run\nFast' }))).toEqual(['name: must not contain control characters']);

    const noisy = Array.from({ length: 30 }, (_unused, index) => ({ time: index, joints: { [`Bad${index}`]: {} } }));
    const problems = errors(swing({ keyframes: noisy }));
    expect(problems).toHaveLength(POSE_LIMITS.maxErrors + 1);
    expect(problems[problems.length - 1]).toBe('...and 10 more');
  });
});
