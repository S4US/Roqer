// rig's build and adopt forms, below Studio: a hand-built dog's pieces become
// one rig whose joints turn at their pivots in the body's axes, the quadruped
// plan declares its legs, and aim and aimAt move them with every check passing
// (docs/creature-plan.md, step 4). Every refusal names what is wrong and
// changes nothing.
import { describe, expect, test } from '@jest/globals';
import { prepareAnimation, rangeSheetAnimation } from '../animation/animation-tool.js';
import { mergeDeclarations, planDeclarations } from '../animation/body-plans.js';
import { frameFromComponents, multiply, pointToWorld } from '../animation/motion.js';
import { rigFromModel, type ModelRigReading } from '../animation/model-rig.js';
import { compilePoseAnimation } from '../animation/pose-compiler.js';
import {
  builtRigMismatches,
  parseBuildJoints,
  planRigAdopt,
  planRigBuild,
  type PiecesReading,
  type RigBuildRequest,
} from '../animation/rig-build.js';
import { dogJoints, dogPieces } from './fixtures/dog-pieces.js';
import { kneeDeclarations, partsDog, type V } from './fixtures/parts-dog.js';

const request = (overrides: Partial<RigBuildRequest> = {}, at?: V, turn?: number): RigBuildRequest => ({
  joints: dogJoints({ at, turn }),
  controller: 'Humanoid',
  plan: 'quadruped',
  replaceImporter: false,
  ...overrides,
});

function planned(reading: PiecesReading = dogPieces(), options: Partial<RigBuildRequest> = {}) {
  const result = planRigBuild(reading, request(options));
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result;
}

function refused(reading: PiecesReading, options: Partial<RigBuildRequest> = {}) {
  const result = planRigBuild(reading, { ...request(), ...options });
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

const close = (a: readonly number[], b: readonly number[], tolerance = 1e-6) =>
  a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

describe('rig builds a rig from a model\'s pieces', () => {
  test.each([
    ['standing at the origin', [0, 2.2, 0] as V, 0],
    ['turned and moved', [12, 7.2, -30] as V, 90],
    ['turned an odd angle', [-4, 2.2, 5] as V, 37],
  ])('each joint turns at its pivot, lined up with the root, %s', (_label, at, turn) => {
    const pieces = dogPieces({ at, turn });
    const result = planRigBuild(pieces, request({}, at, turn));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { plan } = result;
    const frames = new Map(pieces.parts.map((part) => [part.name, frameFromComponents(part.cframe)]));
    frames.set('HumanoidRootPart', frameFromComponents(plan.root.make!.cframe));
    const heading = frameFromComponents(pieces.pivot).r;

    // The root it makes covers the body, turned as the model is, and holds it by Root at its centre.
    expect(plan.root.make!.size).toEqual([2, 1.2, 4]);
    expect(close(plan.root.make!.cframe, pieces.parts[0].cframe, 1e-5)).toBe(true);
    expect(plan.joints[0]).toMatchObject({ name: 'Root', part0: 'HumanoidRootPart', part1: 'Body' });
    expect(plan.joints.map((joint) => joint.name)).toEqual([
      'Root', 'Neck', 'FrontLeft', 'FrontLeftKnee', 'FrontRight', 'FrontRightKnee', 'HindLeft', 'HindLeftKnee', 'HindRight', 'HindRightKnee', 'Tail',
    ]);
    const pivots = new Map(dogJoints({ at, turn }).map((joint) => [joint.name ?? joint.part, joint.pivot]));
    for (const joint of plan.joints) {
      // Both frames land on the pivot, in the root's axes.
      for (const [part, c] of [[joint.part0, joint.c0], [joint.part1, joint.c1]] as const) {
        const frame = multiply(frames.get(part)!, frameFromComponents(c));
        expect(close(frame.r, heading, 1e-5)).toBe(true);
        const expected = joint.name === 'Root' ? frames.get('Body')!.p : pivots.get(joint.name)!;
        expect(close(frame.p, expected, 1e-5)).toBe(true);
      }
    }
    expect(plan.welds).toEqual([
      { part0: 'Head', part1: 'LeftEar' },
      { part0: 'Head', part1: 'RightEar' },
      { part0: 'Head', part1: 'Nose' },
    ]);
    // A walker's root bottom stands its legs' length above the ground, and moves.
    expect(plan.controller).toEqual({ className: 'Humanoid', hipHeight: 1.6 });
    expect(plan.rootAnchored).toBe(false);
  });

  test('the rig it plans reads as the dog, with the quadruped plan\'s legs', () => {
    const { expected, plan } = planned();
    const read = rigFromModel(expected);
    if (!read.ok) throw new Error(read.errors.join('\n'));
    const { rig } = read;
    expect(rig.rootJoint).toBe('Root');
    expect(rig.feet).toEqual(['FrontLeftLower', 'FrontRightLower', 'HindLeftLower', 'HindRightLower']);
    expect(Object.keys(rig.limbs)).toEqual(['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight']);
    expect(rig.hinges.FrontLeftKnee).toEqual({ axis: 'X', flex: -1 });
    expect(rig.hinges.HindLeftKnee).toEqual({ axis: 'X', flex: 1 });
    // Every joint but the root's has a range, so nothing it moves goes unchecked.
    expect(rig.joints.filter((joint) => rig.limits[joint.name] === undefined)).toEqual([]);
    // A pose is in the body's axes: no joint frame is turned from them.
    expect(rig.joints.every((joint) => joint.restRotation === undefined)).toBe(true);
    expect(JSON.parse(plan.declarations).limits.Neck).toEqual({ turn: 90 });
  });

  test('aim and aimAt move its legs, and every check passes', () => {
    const read = rigFromModel(planned({ ...dogPieces({ at: [3, 2.2, 3], turn: 90 }) }, { joints: dogJoints({ at: [3, 2.2, 3], turn: 90 }) }).expected);
    if (!read.ok) throw new Error(read.errors.join('\n'));
    // The paw at rest, under the hip: [right, up, forward] from the root's centre.
    const rest = { FrontLeft: { aimAt: [-0.7, -2.2, 1.4] }, HindRight: { rotation: [0, 0, 0] }, Neck: { rotation: [0, 0, 0] } };
    const animation = {
      name: 'PawLift',
      rig: read.rig.name,
      loop: true,
      keyframes: [
        { time: 0, joints: rest },
        { time: 0.6, joints: { FrontLeft: { aimAt: [-0.7, -1.7, 1.9] }, HindRight: { aim: [0, -1, 0.3] }, Neck: { rotation: [20, 0, 0] } } },
        { time: 1.2, joints: rest },
      ],
    };
    const prepared = prepareAnimation(animation, { grounded: true }, read.rig);
    if (!prepared.ok) throw new Error(prepared.errors.join('\n'));
    const { report, failing } = prepared.value;
    expect(failing).toEqual([]);
    expect(report.checks.filter((check) => check.status === 'fail')).toEqual([]);
    const limits = report.checks.find((check) => check.id === 'jointLimits')!;
    expect(limits.status).toBe('pass');
    // aimAt bent the knee: it keyed FrontLeftKnee, which the hand-written poses never named.
    expect(JSON.stringify(prepared.value.sequence.keyframes[1].root)).toContain('FrontLeftLower');
  });

  test('a creature that swims keeps its root anchored and has no hip height', () => {
    const { plan } = planned(dogPieces(), { controller: 'AnimationController' });
    expect(plan.controller).toEqual({ className: 'AnimationController' });
    expect(plan.rootAnchored).toBe(true);
  });

  test('a rig hung from the model\'s own HumanoidRootPart takes it as the root', () => {
    const pieces = dogPieces();
    pieces.parts.push({ name: 'HumanoidRootPart', cframe: pieces.parts[0].cframe, size: [2, 1.2, 4], hidden: true });
    const joints = [{ part: 'Body', parent: 'HumanoidRootPart', pivot: [0, 2.2, 0] as V, name: 'Root' }, ...dogJoints()];
    const { plan } = planned(pieces, { joints });
    expect(plan.root).toEqual({ name: 'HumanoidRootPart' });
    expect(plan.joints.filter((joint) => joint.name === 'Root')).toHaveLength(1);
  });

  test('declarations given win over the plan\'s, joint by joint', () => {
    const merged = mergeDeclarations(planDeclarations('quadruped', [{ name: 'Neck', parentPart: 'Body', childPart: 'Head' }]), {
      limits: { Tail: { turn: 45 } },
    });
    expect(merged.limits).toEqual({ Neck: { turn: 90 }, Tail: { turn: 45 } });
    const { plan } = planned(dogPieces(), { declarations: { limits: { Neck: { turn: 30 } } } });
    expect(JSON.parse(plan.declarations).limits.Neck).toEqual({ turn: 30 });
    expect(JSON.parse(plan.declarations).limits.FrontLeft).toEqual({ turn: 120 });
  });

  test('custom declares nothing it is not given', () => {
    const { plan } = planned(dogPieces(), { plan: 'custom' });
    expect(JSON.parse(plan.declarations)).toEqual({ version: 1 });
  });

  test('the range sheet turns every joint but the root\'s, and compiles on the rig', () => {
    const read = rigFromModel(planned().expected);
    if (!read.ok) throw new Error(read.errors.join('\n'));
    const sheet = rangeSheetAnimation(read.rig);
    expect(Object.keys(sheet.keyframes[1].joints)).not.toContain('Root');
    expect(Object.keys(sheet.keyframes[1].joints)).toHaveLength(10);
    const compiled = compilePoseAnimation(sheet, read.rig);
    expect(compiled.ok).toBe(true);
  });
});

describe('rig refuses a build that would not make one sound rig', () => {
  test('two pieces nothing moves', () => {
    const joints = dogJoints().filter((joint) => joint.part !== 'Tail');
    joints.push({ part: 'Tail', parent: 'Nose', pivot: [0, 0.7, -3.4] });
    const result = refused(dogPieces(), { joints });
    expect(result.errorCode).toBe('invalid_rig');
    expect(result.errors.join(' ')).toContain('hang from 2 pieces that no joint moves (Body, Nose)');
  });

  test('a cycle', () => {
    const joints = [
      { part: 'Head', parent: 'Tail', pivot: [0, 0, 0] as V },
      { part: 'Tail', parent: 'Head', pivot: [0, 0, 0] as V },
    ];
    expect(refused(dogPieces(), { joints }).errors.join(' ')).toContain('every piece is moved by a joint');
  });

  test('a piece with two joints, and two joints of one name', () => {
    const joints = [...dogJoints(), { part: 'Tail', parent: 'HindLeftUpper', pivot: [0, 0, 0] as V, name: 'Neck' }];
    const errors = refused(dogPieces(), { joints }).errors.join(' ');
    expect(errors).toContain('Tail is already moved by');
    expect(errors).toContain('another joint is named Neck');
  });

  test('a part that is missing, or named twice in the model', () => {
    const pieces = dogPieces();
    pieces.parts.push({ ...pieces.parts.find((part) => part.name === 'Tail')!, cframe: pieces.parts[2].cframe });
    const joints = [...dogJoints(), { part: 'Jaw', parent: 'Head', pivot: [0, 0.8, -3] as V }];
    const errors = refused(pieces, { joints }).errors.join(' ');
    expect(errors).toContain('has no part named Jaw');
    expect(errors).toContain('has 2 parts named Tail');
  });

  test('a pivot in neither piece it joins, as at a leg\'s middle is not', () => {
    const joints = dogJoints().map((joint) => (joint.part === 'Tail' ? { ...joint, pivot: [0, 0.3, 4] as V } : joint));
    expect(refused(dogPieces(), { joints }).errors.join(' ')).toContain('Tail: its pivot [0, 0.3, 4] lies outside Body');
  });

  test('a part left loose, and a weld that would hold a joint still', () => {
    const loose = dogPieces();
    const joints = dogJoints().map((joint) => (joint.part === 'Head' ? { ...joint, with: ['LeftEar', 'RightEar'] } : joint));
    expect(refused(loose, { joints }).errors.join(' ')).toContain('Nose would be left loose');

    const welded = dogPieces();
    welded.welds.push({ part0: 0, part1: 1 });
    expect(refused(welded).errors.join(' ')).toContain('Head and Body are welded together');
  });

  test('a joint named Root beside the one rig makes', () => {
    const joints = dogJoints().map((joint) => (joint.part === 'Tail' ? { ...joint, name: 'Root' } : joint));
    expect(refused(dogPieces(), { joints }).errors.join(' ')).toContain('Root is the joint rig makes');
  });

  test('a model whose controller is the other kind', () => {
    const pieces = { ...dogPieces(), controllers: ['AnimationController' as const] };
    expect(refused(pieces).errorCode).toBe('controller_conflict');
  });
});

describe('rig replaces a rig only when it may', () => {
  const importer = (): PiecesReading => {
    const pieces = dogPieces();
    pieces.parts.push({ name: 'RootPart', cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: [0.1, 0.1, 0.1], hidden: true });
    const root = pieces.parts.length - 1;
    pieces.joints = pieces.parts.slice(0, root).map((_part, index) => ({ name: 'Motor6D', part0: root, part1: index }));
    return { ...pieces, controllers: ['AnimationController'], importer: { rootPart: root, joints: root, initialPoses: 48 } };
  };

  test('an importer\'s rig, only when the call says replace', () => {
    expect(refused(importer()).errorCode).toBe('importer_rig');
    const { plan } = planned(importer(), { replaceImporter: true });
    expect(plan.replaceImporter).toBe(true);
    // Its RootPart goes, so it is neither a piece nor left loose.
    expect(plan.joints.some((joint) => joint.part0 === 'RootPart')).toBe(false);
    expect(refused(dogPieces(), { replaceImporter: true }).errorCode).toBe('no_importer_rig');
  });

  test('joints rig did not build are left alone', () => {
    const pieces = { ...dogPieces(), joints: [{ name: 'Neck', part0: 0, part1: 1 }], controllers: ['Humanoid' as const], rig: { revision: 'rr1:a' } };
    expect(refused(pieces).errorCode).toBe('rig_not_built_here');
  });

  test('its own rig, at the revision the caller read and only while unedited', () => {
    const built = (builtRevision: string): PiecesReading => {
      const pieces = dogPieces();
      pieces.parts.push({ name: 'HumanoidRootPart', cframe: pieces.parts[0].cframe, size: [2, 1.2, 4], hidden: true, madeRoot: true });
      return {
        ...pieces,
        joints: [{ name: 'Root', part0: pieces.parts.length - 1, part1: 0 }],
        welds: [{ part0: 1, part1: 3, made: true }],
        controllers: ['Humanoid'],
        rig: { revision: 'rr1:now', builtRevision },
      };
    };
    expect(refused(built('rr1:now')).errorCode).toBe('revision_required');
    expect(refused(built('rr1:now'), { expectedRevision: 'rr1:old' }).errorCode).toBe('revision_conflict');
    expect(refused(built('rr1:then'), { expectedRevision: 'rr1:now' }).errorCode).toBe('rig_edited_since_build');
    const { plan } = planned(built('rr1:now'), { expectedRevision: 'rr1:now' });
    expect(plan.rebuild).toBe(true);
    // It takes its own root again, and its old weld of the ear is not a second one.
    expect(plan.root.make).toBeDefined();
  });
});

describe('rig adopts a rig made some other way', () => {
  test('a plan declares a hand-rigged dog\'s legs from its part names, as a hand-written declaration would', () => {
    const adopted = planRigAdopt(partsDog({ knees: true }), { plan: 'quadruped' });
    if (!adopted.ok) throw new Error(adopted.errors.join('\n'));
    const byPlan = rigFromModel({ ...partsDog({ knees: true }), declarations: adopted.declarations });
    const byHand = rigFromModel(partsDog({ knees: true, declarations: kneeDeclarations() }));
    if (!byPlan.ok || !byHand.ok) throw new Error('both must read');
    expect(byPlan.rig.feet).toEqual(byHand.rig.feet);
    expect(byPlan.rig.hinges).toEqual(byHand.rig.hinges);
    expect(byPlan.rig.limbs).toEqual(byHand.rig.limbs);
  });

  test('declarations it has are replaced only at the revision the caller read', () => {
    const declared = partsDog({ knees: true, declarations: kneeDeclarations() });
    expect(planRigAdopt(declared, { plan: 'quadruped' })).toMatchObject({ ok: false, errorCode: 'revision_required' });
    expect(planRigAdopt(declared, { plan: 'quadruped', expectedRevision: 'r0' })).toMatchObject({ ok: false, errorCode: 'revision_conflict' });
    expect(planRigAdopt(declared, { plan: 'quadruped', expectedRevision: declared.revision }).ok).toBe(true);
  });

  test('a declaration that names what the rig lacks is refused', () => {
    const adopted = planRigAdopt(partsDog(), { plan: 'custom', declarations: { feet: ['Paw'] } });
    expect(adopted).toMatchObject({ ok: false, errorCode: 'invalid_declarations' });
  });
});

describe('the build\'s read-back and arguments', () => {
  test('a read-back as planned matches; a moved joint or a lost declaration does not', () => {
    const { expected } = planned();
    expect(builtRigMismatches(expected, expected)).toEqual([]);
    const moved: ModelRigReading = {
      ...expected,
      declarations: undefined,
      joints: expected.joints.map((joint) => (joint.name === 'Tail' ? { ...joint, c0: [joint.c0[0] + 0.5, ...joint.c0.slice(1)] } : joint)),
    };
    expect(builtRigMismatches(expected, moved)).toEqual([
      'its RoqerRig is not the declarations written',
      'Tail\'s C0 or C1 is not where it was put',
    ]);
  });

  test('joints are checked for shape before Studio is asked', () => {
    expect(parseBuildJoints([])).toMatchObject({ ok: false });
    const bad = parseBuildJoints([{ part: 'Head', parent: 'Body', pivot: [0, 1] , elbow: true }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/elbow is not part of a joint.*pivot: must be \[x, y, z\]/);
    expect(parseBuildJoints(dogJoints()).ok).toBe(true);
    expect(pointToWorld({ p: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, [1, 2, 3])).toEqual([1, 2, 3]);
  });
});
