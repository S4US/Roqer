// Two skinned creatures as the plugin reads them: one MeshPart whose Bones are
// its joints, laid out as Blender exports an armature and as the skinned spike
// found an upload arrive (docs/creature-plan.md, "A skinned upload"). A bone's
// +Y runs along it, so no bone rests in the body's axes; a bone's joint has its
// frame in its parent as C0 and the identity as C1.
import type { ModelRigJoint, ModelRigPart, ModelRigReading } from '../../animation/model-rig.js';
import type { PiecesReading } from '../../animation/rig-build.js';
import { cf, inverse, motor, times, type CF, type V } from './parts-dog.js';

/** A bone whose +Y points toward -Z, forward: its X is the body's -X and its Z the body's -Y, as the spike read one. */
export const ALONG_FORWARD = [-1, 0, 0, 0, 0, -1, 0, -1, 0];
/** A bone whose +Y points toward +Z, back along a tail. */
export const ALONG_BACK = [1, 0, 0, 0, 0, -1, 0, 1, 0];
/** A bone whose +Y points down a leg. */
export const ALONG_DOWN = [1, 0, 0, 0, -1, 0, 0, 0, -1];

const BONE_SIZE: V = [0.1, 0.1, 0.1];

/** A bone as a joint: named after itself, from what it is in, at its own rest frame. */
export function bone(name: string, parent: [string, CF], world: CF): ModelRigJoint {
  const c0 = times(inverse(parent[1]), world);
  return { name, part0: parent[0], part1: name, c0: [...c0.p, ...c0.r], c1: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
}

const bonePart = (name: string): ModelRigPart => ({ name, size: BONE_SIZE, bone: true });

/** The snake's bones, tail end first, as the spike's GLB names them. */
export const SNAKE_BONES = Array.from({ length: 8 }, (_unused, index) => `Bone00${index}`);

/**
 * The spike's snake: a mesh 8 studs long under an AnimationController, its
 * root bone at the tail's end and each bone a stud further toward the head.
 */
export function skinnedSnake(declarations?: unknown): ModelRigReading {
  const mesh = cf([0, 0, 0]);
  const parts: ModelRigPart[] = [{ name: 'SnakeGeometry', size: [0.8, 0.8, 8], mesh: 'rbxassetid://1' }];
  const joints: ModelRigJoint[] = [];
  let parent: [string, CF] = ['SnakeGeometry', mesh];
  SNAKE_BONES.forEach((name, index) => {
    const world = cf([0, 0, 4 - index], ALONG_FORWARD);
    parts.push(bonePart(name));
    joints.push(bone(name, parent, world));
    parent = [name, world];
  });
  return {
    path: 'game.Workspace.SkinnedSnake',
    revision: 'r1',
    rootPart: 'SnakeGeometry',
    controller: 'AnimationController',
    parts,
    joints,
    ...(declarations === undefined ? {} : { declarations: JSON.stringify(declarations) }),
  };
}

/**
 * The wolf as it arrives from an upload, for `rig` to build on: one skinned
 * MeshPart standing with its paws on the ground at `at`, its bones inside it,
 * and what the importer left, an AnimationController and its InitialPoses.
 */
export function skinnedWolfPieces(at: V = [0, 2, 0]): PiecesReading {
  const wolf = skinnedWolf();
  return {
    path: 'game.Workspace.SkinnedWolf',
    revision: 'rp1:pieces',
    pivot: [at[0], at[1] - 2, at[2], 1, 0, 0, 0, 1, 0, 0, 0, 1],
    parts: [{ name: 'Wolf', cframe: [...at, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: [1.4, 4, 6], mesh: 'rbxassetid://2' }],
    joints: [],
    welds: [],
    bones: wolf.joints.filter((joint) => joint.name !== 'Root').map((joint) => ({ name: joint.name, parent: joint.part0, part: 0, cframe: joint.c0 })),
    controllers: ['AnimationController'],
    importer: { joints: 0, initialPoses: 1 },
  };
}

/** Where each of the wolf's legs hangs from, beside and under the mesh's centre. */
export const WOLF_HIPS: Record<string, V> = { FrontLeft: [-0.5, -0.2, -1.3], FrontRight: [0.5, -0.2, -1.3], HindLeft: [-0.5, -0.2, 1.3], HindRight: [0.5, -0.2, 1.3] };

/**
 * A skinned wolf that walks: a hidden root joined to the one mesh, whose
 * bones are a `Spine` from the hips forward, a `Head`, a `Tail` of two bones,
 * and four legs of an upper bone, a lower bone and a `Foot` bone at the paw,
 * named as the quadruped plan names a leg's pieces. The mesh's box is 4 studs
 * tall and its paws stand 2 studs below its centre. With `knee`, its legs are
 * modelled bent at rest, as a dog's are: each knee that many studs off the
 * line from hip to paw, a front knee forward and a hind knee back, the way
 * each already folds.
 */
export function skinnedWolf(declarations?: unknown, knee = 0): ModelRigReading {
  const mesh = cf([0, 0, 0]);
  const parts: ModelRigPart[] = [
    { name: 'HumanoidRootPart', size: [1.4, 1.2, 4], hidden: true },
    { name: 'Wolf', size: [1.4, 4, 6], mesh: 'rbxassetid://2' },
  ];
  const joints: ModelRigJoint[] = [motor('Root', ['HumanoidRootPart', mesh], ['Wolf', mesh], mesh)];
  const add = (name: string, parent: [string, CF], world: CF): [string, CF] => {
    parts.push(bonePart(name));
    joints.push(bone(name, parent, world));
    return [name, world];
  };
  const spine = add('Spine', ['Wolf', mesh], cf([0, 0.2, 1.5], ALONG_FORWARD));
  add('Head', spine, cf([0, 0.8, -1.8], ALONG_FORWARD));
  const tail = add('Tail', spine, cf([0, 0.4, 1.7], ALONG_BACK));
  add('Tail2', tail, cf([0, 0.2, 2.5], ALONG_BACK));
  for (const [leg, [x, y, z]] of Object.entries(WOLF_HIPS)) {
    const upper = add(`${leg}Upper`, spine, cf([x, y, z], ALONG_DOWN));
    const lower = add(`${leg}Lower`, upper, cf([x, y - 0.9, z + (leg.startsWith('Front') ? -knee : knee)], ALONG_DOWN));
    add(`${leg}Foot`, lower, cf([x, -2, z], ALONG_DOWN));
  }
  return {
    path: 'game.Workspace.SkinnedWolf',
    revision: 'r1',
    rootPart: 'HumanoidRootPart',
    controller: 'Humanoid',
    hipHeight: 1.4,
    parts,
    joints,
    ...(declarations === undefined ? {} : { declarations: JSON.stringify(declarations) }),
  };
}
