import {
  compilePoseAnimation,
  poseCFrame,
  POSE_LIMITS,
  type CompiledPose,
  type KeyframeSequenceDescription,
} from '../animation/pose-compiler.js';
import { R15_RIG } from '../animation/r15-rig.js';
import { R6_RIG } from '../animation/r6-rig.js';
import { drawnParts } from '../animation/box-rig.js';
import { buildTracks, pointToWorld, poseRig } from '../animation/motion.js';
import { checkMotion } from '../animation/motion-checks.js';

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
    // The 15 body joints, and the optional props: a grip in each hand and a sheath at the hip.
    expect(R15_RIG.joints).toHaveLength(18);
    expect(Object.keys(R15_RIG.parts)).toHaveLength(19);
    expect(R15_RIG.joints.filter((joint) => joint.optional)).toEqual([
      expect.objectContaining({ name: 'Weapon', parentPart: 'RightHand', childPart: 'BodyAttach', attachment: 'RightGripAttachment' }),
      expect.objectContaining({ name: 'OffHand', parentPart: 'LeftHand', childPart: 'OffHandAttach', attachment: 'LeftGripAttachment' }),
      expect.objectContaining({ name: 'Sheath', parentPart: 'LowerTorso', childPart: 'SheathAttach' }),
    ]);
    const reached = new Set([R15_RIG.rootPart]);
    for (const joint of R15_RIG.joints) {
      // Parents come first, so a pose tree can be built in one pass.
      expect(reached.has(joint.parentPart)).toBe(true);
      expect(reached.has(joint.childPart)).toBe(false);
      expect(R15_RIG.parts[joint.childPart]).toBeDefined();
      reached.add(joint.childPart);
    }
    expect(reached.size).toBe(19);
  });
});

describe('R6 rig', () => {
  test('stands as the classic R6 character does, feet on its ground', () => {
    const rest = poseRig(new Map(), 0, R6_RIG).parts;
    const at = (part: string) => rest.get(part)!.p.map((value) => Math.round(value * 1e6) / 1e6 + 0);
    expect(at('Torso')).toEqual([0, 0, 0]);
    expect(at('Head')).toEqual([0, 1.5, 0]);
    expect(at('Right Arm')).toEqual([1.5, 0, 0]);
    expect(at('Left Arm')).toEqual([-1.5, 0, 0]);
    expect(at('Right Leg')).toEqual([0.5, -2, 0]);
    expect(at('Left Leg')).toEqual([-0.5, -2, 0]);
    // Every part stands upright at rest, and the legs end on the ground.
    for (const part of drawnParts(R6_RIG)) {
      rest.get(part)!.r.forEach((value, index) => expect(value).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][index], 6));
    }
    expect(at('Left Leg')[1] - R6_RIG.parts['Left Leg'][1] / 2).toBe(R6_RIG.ground);
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
      'animation: unknown field "speed"; expected name, rig, loop, priority, easing, keyframes, duration, waves, gait, skeleton',
      'name: must be a non-empty string',
      'loop: must be true or false',
      'priority: must be one of Core, Idle, Movement, Action, Action2, Action3, Action4',
      'keyframes[0].time: the first keyframe must be at time 0',
      'keyframes[0].joints.RightUpperArm: "RightUpperArm" is a part; key the joint that moves it, "RightShoulder"',
      'keyframes[0].joints.Neck: unknown field "rotaton"; expected rotation, aim, aimAt, grip, bendToward, bend, position, easing',
      'keyframes[1].time: must be later than the previous keyframe (0.1)',
      'keyframes[1].joints.Waist.rotation[1]: must be within ±360 degrees',
      'keyframes[1].joints.Waist.rotation[2]: must be a finite number',
      'keyframes[2].time: must be later than the previous keyframe (0.1)',
      'keyframes[2].easing.style: must be one of Linear, Constant, Elastic, Cubic, Bounce, CubicV2',
      'keyframes[2].joints: must key at least one joint, or carry markers',
      'keyframes[0].joints: "Waist" is keyed later, so it must be keyed in the first keyframe too',
    ]);
  });

  test('splits a turn over 90° into in-betweens of that joint, keeping its easing\'s timing', () => {
    const turn = (style?: string, direction?: string) => ({
      name: 'Swing',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { RightShoulder: { rotation: [-50, 0, 0], ...(style ? { easing: { style, ...(direction ? { direction } : {}) } } : {}) }, Neck: {} } },
        { time: 0.5, joints: { RightShoulder: { rotation: [60, 0, 0] }, Neck: {} } },
      ],
    });
    // Linear: one in-between halfway in time and in angle, keying only the shoulder.
    const linear = compiled(turn());
    expect(linear.inBetweenCount).toBe(1);
    expect(linear.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.25, 0.5]);
    const middle = flatten(linear.keyframes[1].root).filter((pose) => pose.weight === 1);
    expect(middle.map((pose) => pose.joint)).toEqual(['RightShoulder']);
    middle[0].cframe.forEach((value, index) => expect(value).toBeCloseTo(poseCFrame([5, 0, 0])[index], 6));
    expect(middle[0]).toMatchObject({ easingStyle: 'Linear', easingDirection: 'In' });

    // Eased: an in-between every 30° or less, each where the easing reaches it.
    const eased = compiled(turn('CubicV2', 'In'));
    expect(eased.inBetweenCount).toBe(3);
    const times = eased.keyframes.map((keyframe) => keyframe.time);
    expect(times).toHaveLength(5);
    [0.25, 0.5, 0.75].forEach((progress, index) => expect(times[index + 1]).toBeCloseTo(0.5 * Math.cbrt(progress), 5));
    const first = flatten(eased.keyframes[0].root).find((pose) => pose.joint === 'RightShoulder')!;
    expect(first).toMatchObject({ easingStyle: 'Linear' });

    // Every compiled segment is within the limit.
    for (const sequence of [linear, eased]) {
      const keys = sequence.keyframes
        .map((keyframe) => flatten(keyframe.root).find((pose) => pose.joint === 'RightShoulder' && pose.weight === 1))
        .filter((pose): pose is CompiledPose => pose !== undefined);
      for (let index = 1; index < keys.length; index += 1) {
        let trace = 0;
        for (let component = 3; component < 12; component += 1) trace += keys[index - 1].cframe[component] * keys[index].cframe[component];
        expect((Math.acos(Math.min(1, (trace - 1) / 2)) * 180) / Math.PI).toBeLessThanOrEqual(POSE_LIMITS.maxTurnPerSegment + 1e-6);
      }
    }

    // A snapping key may turn any amount, and adds nothing.
    expect(compiled(turn('Constant')).inBetweenCount).toBe(0);
    // Elastic and Bounce overshoot, which in-betweens would lose.
    expect(errors(turn('Elastic'))).toEqual([
      'keyframes[1].joints.RightShoulder: turns 110° from its key at 0 s with Elastic easing, whose overshoot in-betweens cannot keep; split turns over 90° across more keyframes',
    ]);
    // Near half a turn the way round is unclear.
    expect(errors({
      name: 'Flip',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { RightShoulder: { rotation: [-89, 0, 0] } } },
        { time: 0.5, joints: { RightShoulder: { rotation: [89, 0, 0] } } },
      ],
    })).toEqual([
      'keyframes[1].joints.RightShoulder: turns 178° from its key at 0 s, too near half a turn to tell which way round it goes; add a keyframe partway along the way it should turn',
    ]);
  });

  test('says when a near half-turn is a limb twisting, and bendToward fixes it', () => {
    const raise = (raised: Record<string, unknown>) => compilePoseAnimation({
      name: 'Raise',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { RightShoulder: { aim: [0, -1, 0] } } },
        { time: 0.3, joints: { RightShoulder: { aim: [0, 1, 0.5], ...raised } } },
      ],
    });
    const twisted = raise({});
    expect(twisted.ok).toBe(false);
    if (!twisted.ok) {
      expect(twisted.errors).toEqual([
        'keyframes[1].joints.RightShoulder: turns 180° from its key at 0 s: the limb swings 153° but also twists about itself, too near half a turn to tell which way round; give bendToward so the elbow or knee keeps folding the same side (a raised arm: [0, 0, -1]), or add a keyframe partway',
      ]);
    }
    const swung = raise({ bendToward: [0, 0, -1] });
    expect(swung.ok && swung.sequence.inBetweenCount).toBeGreaterThan(0);
  });

  test('keeps the keyframe limit after adding in-betweens', () => {
    const keyframes = Array.from({ length: POSE_LIMITS.maxKeyframes }, (_unused, index) => ({
      time: index / 10,
      joints: { RightShoulder: { rotation: [index % 2 === 0 ? -60 : 60, 0, 0] } },
    }));
    expect(errors({ name: 'Flail', rig: 'R15', keyframes })).toEqual([
      `keyframes: with the in-betweens its turns over 90° need, it would have ${POSE_LIMITS.maxKeyframes * 2 - 1} keyframes; at most ${POSE_LIMITS.maxKeyframes}`,
    ]);
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
      'keyframes[0].joints.RightShoulder: give one of rotation, aim, aimAt, grip or bend, not rotation and aim',
      'keyframes[0].joints.LeftHip.bendToward: goes with aim, aimAt or grip',
    ]);
  });

  test('compiles markers, and lets a keyframe that carries them key no joint', () => {
    const sequence = compiled({
      name: 'Slash',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { RightShoulder: { aim: [0, -1, 0] } } },
        { time: 0.2, joints: {}, markers: [{ name: 'Hit', value: 'heavy' }, { name: 'Swoosh' }] },
        { time: 0.4, joints: { RightShoulder: { aim: [0, -1, 0.5] } } },
      ],
    });
    expect(sequence.keyframes[1]).toMatchObject({ time: 0.2, markers: [{ name: 'Hit', value: 'heavy' }, { name: 'Swoosh', value: '' }] });
    expect(outline(sequence.keyframes[1].root)).toBe('HumanoidRootPart*');
    expect(sequence.keyframes[0]).not.toHaveProperty('markers');
    expect(sequence.markerCount).toBe(2);

    expect(errors({
      name: 'Bad',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { Neck: {} }, markers: [{ name: '' }, { name: 'Hit', value: 3 }, { name: 'Hit', when: 1 }, 'Hit'] },
        { time: 0.1, joints: { Neck: {} }, markers: Array.from({ length: POSE_LIMITS.maxMarkersPerKeyframe + 1 }, () => ({ name: 'Hit' })) },
        { time: 0.2, joints: { Neck: {} }, markers: [{ name: 'Hit', value: 'x'.repeat(POSE_LIMITS.maxMarkerValueLength + 1) }] },
        { time: 0.3, joints: {}, markers: [] },
      ],
    })).toEqual([
      'keyframes[0].markers[0].name: must be a non-empty string',
      'keyframes[0].markers[1].value: must be a string',
      'keyframes[0].markers[2]: unknown field "when"; expected name, value',
      'keyframes[0].markers[3]: must be an object with name and optional value',
      `keyframes[1].markers: must hold at most ${POSE_LIMITS.maxMarkersPerKeyframe} markers`,
      `keyframes[2].markers[0].value: must be at most ${POSE_LIMITS.maxMarkerValueLength} characters`,
      'keyframes[3].joints: must key at least one joint, or carry markers',
    ]);
  });

  test('turns the weapon about the hand\'s axes, and only by rotation', () => {
    const weapon = (rotation: number[]) => compiled({
      name: 'Twirl',
      rig: 'R15',
      keyframes: [{ time: 0, joints: { Weapon: { rotation } } }],
    });
    const pose = (sequence: KeyframeSequenceDescription) => flatten(sequence.keyframes[0].root).find((candidate) => candidate.joint === 'Weapon')!;
    expect(outline(weapon([0, 0, 0]).keyframes[0].root)).toBe(
      'HumanoidRootPart*(LowerTorso*(UpperTorso*(RightUpperArm*(RightLowerArm*(RightHand*(BodyAttach))))))',
    );
    // The grip's frame is the hand's turned -90° about X: a turn about the
    // hand's X stays about X, and one about the hand's Y (up the forearm) is
    // about the grip's Z.
    pose(weapon([30, 0, 0])).cframe.forEach((value, index) => expect(value).toBeCloseTo(poseCFrame([30, 0, 0])[index], 6));
    pose(weapon([0, 30, 0])).cframe.forEach((value, index) => expect(value).toBeCloseTo(poseCFrame([0, 0, 30])[index], 6));

    expect(errors({
      name: 'Bad',
      rig: 'R15',
      keyframes: [{ time: 0, joints: { Weapon: { aim: [0, 1, 0] } } }, { time: 1, joints: { Weapon: { position: [0, 1, 0] } } }],
    })).toEqual([
      'keyframes[0].joints.Weapon: aim and bendToward work on shoulders and hips; use rotation here',
      'keyframes[1].joints.Weapon.position: only Root takes a position; other joints only rotate',
    ]);
  });

  test('poses R6 in the same body-space terms as R15, and says which R15 joints it lacks', () => {
    const pose = (rig: string) => compiled({
      name: 'Reach',
      rig,
      keyframes: [{ time: 0, joints: { RightShoulder: { aim: [0, 0, 1] }, LeftHip: { aim: [0, -1, 0.5] }, Neck: { rotation: [30, 0, 0] } } }],
    });
    const r6 = pose('R6');
    expect(r6.rig).toBe('R6');
    expect(outline(r6.keyframes[0].root)).toBe('HumanoidRootPart*(Torso*(Head Right Arm Left Leg))');
    const r6Parts = poseRig(buildTracks(r6), 0, R6_RIG).parts;
    const r15Parts = poseRig(buildTracks(pose('R15')), 0, R15_RIG).parts;
    // The arm points forward (-Z) and the thigh swings forward on both rigs,
    // and a +X neck turn tips the head back (+Z) on both.
    const forward = (frame: { r: number[] }) => [frame.r[1], frame.r[4], frame.r[7]].map((value) => -value);
    for (const [r6Part, r15Part] of [['Right Arm', 'RightUpperArm'], ['Left Leg', 'LeftUpperLeg'], ['Head', 'Head']]) {
      const down = forward(r6Parts.get(r6Part)!);
      const r15Down = forward(r15Parts.get(r15Part)!);
      down.forEach((value, axis) => expect(value).toBeCloseTo(r15Down[axis], 6));
    }

    expect(errors({ name: 'Bad', rig: 'R6', keyframes: [{ time: 0, joints: { RightElbow: { bend: 30 }, Waist: {} } }] })).toEqual([
      'keyframes[0].joints.RightElbow: R6 has no RightElbow: its arms and legs are single blocks, and it has no waist; its joints are Root, Neck, LeftShoulder, RightShoulder, LeftHip, RightHip, Weapon, OffHand, Sheath',
      'keyframes[0].joints.Waist: R6 has no Waist: its arms and legs are single blocks, and it has no waist; its joints are Root, Neck, LeftShoulder, RightShoulder, LeftHip, RightHip, Weapon, OffHand, Sheath',
    ]);
  });

  test('aimAt lands an R15 wrist and ankle on their targets, and keeps a foot planted as the body moves', () => {
    const foot = [-0.6, -2.7, 0.6];
    const hand = [0.6, 0.3, 1.2];
    const lunge = compiled({
      name: 'Lunge',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { Root: { position: [0, 0, 0] }, LeftHip: { aimAt: foot }, RightShoulder: { aimAt: hand, bendToward: [0, 1, 0] } } },
        { time: 0.5, joints: { Root: { position: [0, -0.3, 0], rotation: [0, 20, 0] }, LeftHip: { aimAt: foot }, RightShoulder: { aimAt: hand, bendToward: [0, 1, 0] } } },
      ],
    });
    // aimAt keys the elbow and knee it bends, and the ankle that lays the foot flat.
    expect(lunge.joints).toEqual(['Root', 'RightShoulder', 'RightElbow', 'LeftHip', 'LeftKnee', 'LeftAnkle']);
    // Held on one point from one key to the next, the foot is planted: solved
    // again every thirtieth of a second, so it stays put between the keys too.
    // The hand is held on its point too: 14 solved keys for each limb over 0.5 s.
    expect(lunge.inBetweenCount).toBe(28);
    const tracks = buildTracks(lunge);
    for (const time of [0, 0.123, 0.25, 0.41, 0.5]) {
      const parts = poseRig(tracks, time, R15_RIG).parts;
      pointToWorld(parts.get('LeftLowerLeg')!, [0, -0.596, 0]).forEach((value, axis) => expect(value).toBeCloseTo([-0.6, -2.7, -0.6][axis], 2));
      // Flat: the foot's up is the world's up, and it keeps its heading.
      const foot = parts.get('LeftFoot')!.r;
      expect(foot[4]).toBeCloseTo(1, 3);
      expect(foot[8]).toBeCloseTo(1, 3);
    }
    for (const time of [0, 0.5]) {
      const parts = poseRig(tracks, time, R15_RIG).parts;
      // [right, up, forward] in the character's terms; Roblox's forward is -Z.
      pointToWorld(parts.get('LeftLowerLeg')!, [0, -0.596, 0]).forEach((value, axis) => expect(value).toBeCloseTo([-0.6, -2.7, -0.6][axis], 4));
      pointToWorld(parts.get('RightLowerArm')!, [0, -0.532, 0]).forEach((value, axis) => expect(value).toBeCloseTo([0.6, 0.3, -1.2][axis], 4));
    }
    // The knee folds more as the body drops toward the planted foot.
    const knee = (index: number) => flatten(lunge.keyframes[index].root).find((pose) => pose.joint === 'LeftKnee')!;
    // A knee turns about X, so its R11 (component 7) is the cosine of its bend.
    expect(Math.acos(knee(1).cframe[7])).toBeGreaterThan(Math.acos(knee(0).cframe[7]));
  });

  test('aimAt points an R6 block through its target, and refuses what a limb cannot reach', () => {
    const r6 = compiled({ name: 'Point', rig: 'R6', keyframes: [{ time: 0, joints: { RightShoulder: { aimAt: [1.2, 0.5, 1] } } }] });
    const arm = poseRig(buildTracks(r6), 0, R6_RIG).parts.get('Right Arm')!;
    const pivot = [1, 0.5, 0];
    const end = pointToWorld(arm, [0, -1, 0]);
    const target = [1.2, 0.5, -1];
    // Pivot, target and the arm's far end in one line, the end beyond the target.
    const along = [0, 1, 2].map((axis) => end[axis] - pivot[axis]);
    const toward = [0, 1, 2].map((axis) => target[axis] - pivot[axis]);
    const cosine = along.reduce((sum, value, axis) => sum + value * toward[axis], 0) / (Math.hypot(...along) * Math.hypot(...toward));
    expect(cosine).toBeCloseTo(1, 4);
    expect(Math.hypot(...along)).toBeGreaterThan(Math.hypot(...toward));

    expect(errors({
      name: 'Bad',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { RightShoulder: { aimAt: [5, 0.5, 0] }, Neck: { aimAt: [0, 2, 0] } } },
      ],
    })).toEqual([
      'keyframes[0].joints.Neck: aimAt works on shoulders and hips; use rotation here',
    ]);
    const one = (joints: Record<string, unknown>) => errors({ name: 'Bad', rig: 'R15', keyframes: [{ time: 0, joints }] });
    expect(one({ RightShoulder: { aimAt: [5, 0.5, 0] } })).toEqual([
      expect.stringMatching(/^keyframes\[0\]\.joints\.RightShoulder\.aimAt: is 4\.\d+ studs from RightShoulder; the arm reaches 1\.\d+ at most at 0 s$/),
    ]);
    expect(one({ LeftShoulder: { aimAt: [-0.97, 0.3, 0] } })).toEqual([
      expect.stringMatching(/^keyframes\[0\]\.joints\.LeftShoulder\.aimAt: is 0\.\d+ studs from LeftShoulder; the arm cannot fold nearer than 0\.\d+ at 0 s$/),
    ]);
    expect(one({ LeftShoulder: { aimAt: [-1, -0.5, 0.5] }, LeftElbow: { bend: 20 } })).toEqual([
      'keyframes[0].joints.LeftShoulder.aimAt: sets LeftElbow too; leave LeftElbow out of this keyframe',
    ]);
    expect(errors({
      name: 'Late',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { RightShoulder: { aim: [0, -1, 0] } } },
        { time: 0.5, joints: { RightShoulder: { aimAt: [0.6, 0, 1] } } },
      ],
    })).toEqual(['keyframes[0].joints: "RightElbow" is set later by RightShoulder\'s aimAt or grip, so key it, or use aimAt or grip on RightShoulder, in the first keyframe too']);
  });

  test('grip keeps the left hand on the weapon\'s handle through a fast two-handed swing', () => {
    const key = (time: number, at: number[], turn: number) => ({
      time,
      joints: { RightShoulder: { aimAt: at, bendToward: [0, 1, 0] }, Weapon: { rotation: [turn, 0, 0] }, LeftShoulder: { grip: 0.45 } },
    });
    const swing = compiled({
      name: 'TwoHanded',
      rig: 'R15',
      keyframes: [key(0, [-0.2, 0.5, 0.8], 0), key(0.3, [-0.2, 1.5, 0.5], 30), key(0.42, [-0.2, 0, 0.8], -60)],
    });
    expect(swing.joints).toEqual(['LeftShoulder', 'LeftElbow', 'RightShoulder', 'RightElbow', 'Weapon']);
    // Solved again every sixtieth of a second between the grip keys.
    expect(swing.inBetweenCount).toBe(24);
    const tracks = buildTracks(swing);
    let worst = 0;
    for (let time = 0; time <= 0.42 + 1e-9; time += 1 / 240) {
      const parts = poseRig(tracks, time, R15_RIG).parts;
      const handle = pointToWorld(parts.get('BodyAttach')!, [0, -0.45, 0]);
      const hand = pointToWorld(parts.get('LeftLowerArm')!, [0, -0.664, 0]);
      worst = Math.max(worst, Math.hypot(...hand.map((value, axis) => value - handle[axis])));
    }
    expect(worst).toBeLessThan(0.05);
    // The elbow never flips between solves: nothing moves faster than a body may.
    expect(checkMotion(swing).checks.filter((entry) => entry.status === 'fail')).toEqual([]);

    // R6 grips too, its rigid arm pointed through the handle.
    expect(compilePoseAnimation({
      name: 'TwoHandedR6',
      rig: 'R6',
      keyframes: [key(0, [-0.2, 0.5, 0.8], 0), key(0.3, [-0.2, 1, 0.5], 30)],
    }).ok).toBe(true);
  });

  test('refuses a grip it cannot make, saying why', () => {
    const one = (joints: Record<string, unknown>) => errors({ name: 'Bad', rig: 'R15', keyframes: [{ time: 0, joints }] });
    expect(one({ RightShoulder: { grip: 0.4 } })).toEqual([
      'keyframes[0].joints.RightShoulder: grip works on LeftShoulder, holding the weapon two-handed; use aimAt or rotation here',
    ]);
    expect(one({ LeftShoulder: { grip: 5 } })).toEqual([
      'keyframes[0].joints.LeftShoulder.grip: must be studs along the handle from the right hand, within ±3',
    ]);
    expect(one({ LeftShoulder: { grip: 0.4 }, LeftElbow: { bend: 10 } })).toEqual([
      'keyframes[0].joints.LeftShoulder.grip: sets LeftElbow too; leave LeftElbow out of this keyframe',
    ]);
    // A right hand held out to its side puts the handle beyond the left arm.
    expect(one({ RightShoulder: { aim: [1, 0, 0] }, LeftShoulder: { grip: 0.4 } })).toEqual([
      expect.stringMatching(/^keyframes\[0\]\.joints\.LeftShoulder\.grip: cannot hold the handle: it is \d+\.\d+ studs from LeftShoulder; the arm reaches 1\.78 at most at 0 s$/),
    ]);
  });

  test('refuses rigs it does not know, including inherited object keys', () => {
    for (const rig of ['R16', 'r6', 'toString', '__proto__', undefined]) {
      expect(errors(swing({ rig }))).toEqual(['rig: must be R15 or R6, or the path of a rigged Model in Studio']);
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
