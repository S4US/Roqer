// A skinned mesh's Bones read as a rig (docs/creature-plan.md, step 7): each
// bone is a joint named after itself, never drawn, whose rest frame is not the
// body's axes. The compiler, the generators and the checks take it as they
// take a rig of parts, and its keyframes nest a pose for each bone as the
// bones nest, which is the only shape Roblox drives bones from.
import { describe, expect, test } from '@jest/globals';
import { prepareAnimation } from '../animation/animation-tool.js';
import { mergeDeclarations, planDeclarations } from '../animation/body-plans.js';
import { drawnParts } from '../animation/box-rig.js';
import { rigFromModel, type ModelRigReading } from '../animation/model-rig.js';
import { buildTracks, pointToWorld, poseRig, restPose } from '../animation/motion.js';
import { limbReach } from '../animation/limb-reach.js';
import { planRigAdopt, planRigBuild, type RigBuildRequest } from '../animation/rig-build.js';
import type { Rig } from '../animation/rig.js';
import { skinnedSnake, skinnedWolf, skinnedWolfPieces, SNAKE_BONES, WOLF_HIPS } from './fixtures/skinned.js';

function rigOf(reading: ModelRigReading): Rig {
  const result = rigFromModel(reading);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.rig;
}

/** The wolf as `rig` declares it: the quadruped plan read from its bones' names. */
function plannedWolf(given?: Record<string, unknown>): Rig {
  const bare = rigOf(skinnedWolf());
  return rigOf(skinnedWolf(mergeDeclarations(planDeclarations('quadruped', bare.joints), given)));
}

const snakeLimits = { version: 1, limits: Object.fromEntries(SNAKE_BONES.slice(1).map((name) => [name, { turn: 60 }])) };

describe('a skinned mesh\'s bones are a rig', () => {
  test('each bone is a joint named after itself, hung from the mesh, and only the mesh is drawn', () => {
    const rig = rigOf(skinnedSnake());
    expect(rig.rootPart).toBe('SnakeGeometry');
    expect(rig.joints.map((joint) => joint.name)).toEqual(SNAKE_BONES);
    expect(rig.joints.map((joint) => joint.childPart)).toEqual(SNAKE_BONES);
    expect(rig.joints[0].parentPart).toBe('SnakeGeometry');
    expect(rig.joints[3].parentPart).toBe('Bone002');
    expect(rig.bones).toEqual(SNAKE_BONES);
    expect(drawnParts(rig)).toEqual(['SnakeGeometry']);
    // The ground is under the mesh's box, not a bone's token one.
    expect(rig.ground).toBeCloseTo(-0.4, 6);
    // At rest each bone stands where it was modelled.
    const rest = restPose(rig);
    expect(rest.get('Bone000')!.p).toEqual([0, 0, 4]);
    expect(rest.get('Bone007')!.p.map((value) => Math.round(value * 1e6) / 1e6)).toEqual([0, 0, -3]);
  });

  test('a rotation is written in the body\'s axes, whatever way the bone lies', () => {
    const rig = rigOf(skinnedSnake(snakeLimits));
    // A yaw about the body's Y at one bone swings everything ahead of it sideways, and keeps it level.
    const result = prepareAnimation({
      name: 'Bend', rig: rig.name, loop: false,
      keyframes: [{ time: 0, joints: { Bone004: { rotation: [0, 0, 0] } } }, { time: 1, joints: { Bone004: { rotation: [0, 30, 0] } } }],
    }, {}, rig);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const parts = poseRig(buildTracks(result.value.sequence), 1, rig).parts;
    const pivot = parts.get('Bone004')!.p;
    const ahead = parts.get('Bone007')!.p;
    expect(pivot).toEqual(restPose(rig).get('Bone004')!.p);
    expect(ahead[1]).toBeCloseTo(0, 5);
    // Three studs ahead of the pivot, turned 30° about Y: left of the line it lay on.
    expect(ahead[0] - pivot[0]).toBeCloseTo(-3 * Math.sin(Math.PI / 6), 4);
    expect(ahead[2] - pivot[2]).toBeCloseTo(-3 * Math.cos(Math.PI / 6), 4);
  });

  test('its keyframes nest a pose for each bone as the bones nest, under the mesh', () => {
    const rig = rigOf(skinnedSnake(snakeLimits));
    const result = prepareAnimation({
      name: 'Slither', rig: rig.name, loop: true, duration: 2,
      waves: [{ joints: SNAKE_BONES.slice(1), axis: 'Y', amplitude: 20, lag: 0.14 }],
    }, {}, rig);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.value.report.checks.filter((check) => check.status === 'fail')).toEqual([]);
    // From the top pose down: the mesh, then each bone inside the one before.
    const chain: string[] = [];
    let poses = [result.value.sequence.keyframes[1].root];
    while (poses.length > 0) {
      expect(poses).toHaveLength(1);
      chain.push(poses[0].part);
      poses = poses[0].children;
    }
    expect(chain).toEqual(['SnakeGeometry', ...SNAKE_BONES]);
  });
});

describe('a leg modelled bent at rest has slack to stride with', () => {
  /** The wolf with each knee 0.3 studs off its leg's line, declared by the plan as rig declares it. */
  const bentWolf = (): Rig => {
    const result = planRigAdopt(skinnedWolf(undefined, 0.3), { plan: 'quadruped' });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return rigOf(skinnedWolf(JSON.parse(result.declarations), 0.3));
  };
  const trot = (rig: Rig, stride: number) => {
    const result = prepareAnimation({ name: 'Trot', rig: rig.name, loop: true, priority: 'Movement', duration: 0.6, gait: { pattern: 'trot', stride, bob: 0 } }, { locomotion: true }, rig);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return result.value;
  };
  /** How far the body rides below where it stands, at its lowest. */
  const lowest = (sequence: ReturnType<typeof trot>['sequence']) => Math.min(...sequence.keyframes.map((keyframe) => keyframe.root.children[0].cframe[1]));

  test('it reaches past its rest by straightening, and the plan lets its knee turn that far', () => {
    const rig = bentWolf();
    for (const leg of ['FrontLeftUpper', 'HindRightUpper']) {
      const reach = limbReach(rig, leg);
      // Two bones of 0.9 and a knee 0.3 off the line: 1.8 studs standing, 1.897 straight.
      expect(reach.length).toBeCloseTo(2 * Math.hypot(0.9, 0.3), 3);
      expect(reach.bend).toBeCloseTo(-2 * Math.atan2(0.3, 0.9) * (180 / Math.PI), 1);
    }
    // 37° to straighten, and 10° past it: a front knee folds back (-), a hind knee forward (+).
    expect(rig.limits.FrontLeftLower).toEqual({ min: -160, max: 47, offAxis: 35 });
    expect(rig.limits.HindLeftLower).toEqual({ min: -47, max: 160, offAxis: 35 });
    // A leg modelled straight has none, and keeps the plan's own range.
    const straight = plannedWolf();
    expect(limbReach(straight, 'FrontLeftUpper')).toEqual({ bend: 0, length: 1.8 });
    expect(straight.limits.FrontLeftLower).toEqual({ min: -160, max: 10, offAxis: 35 });
  });

  test('so a gait strides without lowering the body, where a straight leg must crouch', () => {
    const bent = trot(bentWolf(), 0.9);
    expect(bent.report.checks.filter((check) => check.status !== 'pass').map((check) => `${check.id}: ${check.detail}`)).toEqual([]);
    expect(lowest(bent.sequence)).toBeCloseTo(0, 6);
    const straight = trot(plannedWolf(), 0.9);
    expect(lowest(straight.sequence)).toBeLessThan(-0.08);
    // Its planted feet stay on the ground all the same.
    const rig = bentWolf();
    for (let step = 0; step < 36; step += 1) {
      const parts = poseRig(buildTracks(bent.sequence), (bent.sequence.duration * step) / 36, rig).parts;
      for (const foot of rig.feet) expect(parts.get(foot)!.p[1] - rig.ground).toBeGreaterThan(-0.02);
    }
  });

  test('a longer stride than its slack covers lowers it only by the rest', () => {
    expect(lowest(trot(bentWolf(), 1.6).sequence)).toBeGreaterThan(lowest(trot(plannedWolf(), 1.6).sequence) + 0.05);
  });
});

describe('rig builds around a skinned mesh', () => {
  const build = (overrides: Partial<RigBuildRequest> = {}, reading = skinnedWolfPieces()) =>
    planRigBuild(reading, { joints: [], controller: 'Humanoid', plan: 'quadruped', replaceImporter: true, ...overrides });

  test('with no joints given, it makes the root and the controller, and leaves the bones as they are', () => {
    const result = build();
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { plan, expected } = result;
    // One joint to make: the root's, to the mesh. The bones are not the plugin's to make.
    expect(plan.joints.map((joint) => [joint.name, joint.part0, joint.part1])).toEqual([['Root', 'HumanoidRootPart', 'Wolf']]);
    // The root covers the body, not the legs: from the spine up, around the bones at that height
    // (the hips' width, the head to the tail's end), where the mesh's own box is 1.4 by 4 by 6.
    expect(plan.root.make?.size).toEqual([1, 1, 4.3]);
    expect(plan.root.make?.cframe.slice(0, 3)).toEqual([0, 2.7, 0.35]);
    expect(plan.replaceImporter).toBe(true);
    expect(plan.rootAnchored).toBe(false);
    // So a Humanoid holds its bottom the spine's height above the ground the paws stand on.
    expect(plan.controller).toEqual({ className: 'Humanoid', hipHeight: 2.2 });
    // The root's joint is still at the mesh's centre.
    expect(plan.joints[0].c1.slice(0, 3)).toEqual([0, 0, 0]);
    // The rig it will read back as has every bone, and the plan's declarations from their names.
    expect(expected.joints).toHaveLength(1 + 16);
    expect(expected.parts.filter((part) => part.bone).map((part) => part.name)).toContain('HindRightFoot');
    const declared = JSON.parse(plan.declarations) as { feet: string[]; limbs: Record<string, unknown> };
    expect(declared.feet).toEqual(['FrontLeftFoot', 'FrontRightFoot', 'HindLeftFoot', 'HindRightFoot']);
    expect(declared.limbs.FrontLeftUpper).toEqual({ hinge: 'FrontLeftLower', foot: 'FrontLeftFoot' });
    // Its origin is kept, as any upload's is.
    expect(plan.origin).toEqual(skinnedWolfPieces().pivot);
  });

  test('what the importer left is replaced only when the call says so', () => {
    const kept = build({ replaceImporter: false });
    expect(kept.ok).toBe(false);
    if (!kept.ok) {
      expect(kept.errorCode).toBe('importer_rig');
      expect(kept.errors[0]).toMatch(/has what an importer left on a skinned mesh: an AnimationController and its InitialPoses/);
    }
    // Under an AnimationController the root is anchored, for a script to move.
    const swimmer = build({ controller: 'AnimationController' });
    if (!swimmer.ok) throw new Error(swimmer.errors.join('\n'));
    expect(swimmer.plan.rootAnchored).toBe(true);
  });

  test('a model with no bones still needs its joints, and bones in two parts need them joined', () => {
    const boneless = build({}, { ...skinnedWolfPieces(), bones: [], importer: undefined, controllers: [] });
    expect(boneless.ok).toBe(false);
    if (!boneless.ok) expect(boneless.errors[0]).toMatch(/has no Bones, so its rig is the joints the call gives/);
    const pieces = skinnedWolfPieces();
    const two = build({}, {
      ...pieces,
      parts: [...pieces.parts, { name: 'Rider', cframe: [0, 5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: [1, 2, 1] }],
      bones: [...pieces.bones!, { name: 'RiderSpine', parent: 'Rider', part: 1, cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }],
    });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.errors[0]).toMatch(/Bones are in 2 parts \(Wolf, Rider\)/);
  });
});

describe('a skinned quadruped is declared from its bones\' names', () => {
  test('the plan finds legs of an upper bone, a lower bone and a foot bone', () => {
    const rig = plannedWolf();
    expect(rig.feet).toEqual(['FrontLeftFoot', 'FrontRightFoot', 'HindLeftFoot', 'HindRightFoot']);
    expect(Object.keys(rig.limbs)).toEqual(['FrontLeftUpper', 'FrontRightUpper', 'HindLeftUpper', 'HindRightUpper']);
    expect(rig.limbs.FrontLeftUpper).toMatchObject({ hinge: 'FrontLeftLower', foot: 'FrontLeftFoot' });
    // A leg ends where its foot bone begins, in its lower bone's frame: 0.9 studs along it.
    expect(rig.limbs.FrontLeftUpper.end.map((value) => Math.round(value * 1e6) / 1e6)).toEqual([0, 0.9, 0]);
    // It points down in the body's axes, though its bones' own axes do not.
    expect(rig.limbs.FrontLeftUpper.axis.map((value) => Math.round(value * 1e6) / 1e6)).toEqual([0, -1, 0]);
    // The feet stand on the ground under the mesh.
    const rest = restPose(rig);
    for (const foot of rig.feet) expect(pointToWorld(rest.get(foot)!, [0, 0, 0])[1]).toBeCloseTo(rig.ground, 6);
    expect(rig.scale?.basis).toBe('its hips\' height at rest');
    expect(rig.scale!.factor).toBeCloseTo((WOLF_HIPS.FrontLeft[1] + 2) / 2.19, 1);
  });

  test('a bone with no bone below it needs its end given', () => {
    const bare = rigOf(skinnedWolf());
    const planned = planDeclarations('quadruped', bare.joints);
    // Taking a leg's foot out of the plan leaves its lower bone ending at the one bone below it.
    const withoutFoot = mergeDeclarations(planned, { limbs: { FrontLeftUpper: { hinge: 'FrontLeftLower' } } });
    expect(rigOf(skinnedWolf(withoutFoot)).limbs.FrontLeftUpper.end.map((value) => Math.round(value * 1e6) / 1e6)).toEqual([0, 0.9, 0]);
    // The tail's last bone has none below it.
    const tail = rigFromModel(skinnedWolf(mergeDeclarations(planned, { limbs: { Tail2: {} } })));
    expect(tail.ok).toBe(false);
    if (!tail.ok) expect(tail.errors.join('\n')).toMatch(/Tail2 is a bone with no bone below it, so where it ends cannot be read; give end/);
    // Given, it may lie anywhere: a bone has no box to hold it in.
    expect(rigOf(skinnedWolf(mergeDeclarations(planned, { limbs: { Tail2: { end: [0, 1.2, 0] } } }))).limbs.Tail2.end).toEqual([0, 1.2, 0]);
  });

  test('a gait walks it with every check passing, its feet planted', () => {
    const rig = plannedWolf();
    const result = prepareAnimation({
      name: 'WolfTrot', rig: rig.name, loop: true, priority: 'Movement', duration: 0.6,
      gait: { pattern: 'trot', stride: 1.2 },
      waves: [{ joints: ['Tail', 'Tail2'], axis: 'Y', amplitude: [8, 14], lag: 0.15, cycles: 2 }],
    }, { locomotion: true }, rig);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { report, sequence } = result.value;
    expect(report.checks.filter((check) => check.status !== 'pass').map((check) => `${check.id}: ${check.detail}`)).toEqual([]);
    expect(report.checks.find((check) => check.id === 'gaitSymmetry')!.detail).toMatch(/landing FrontLeftFoot with HindRightFoot, then FrontRightFoot with HindLeftFoot$/);
    expect(report.groundSpeed).toBeCloseTo(4, 1);
    // No foot bone dips under the ground at any moment.
    for (let step = 0; step < 36; step += 1) {
      const parts = poseRig(buildTracks(sequence), (sequence.duration * step) / 36, rig).parts;
      for (const foot of rig.feet) expect(parts.get(foot)!.p[1] - rig.ground).toBeGreaterThan(-0.02);
    }
  });
});
