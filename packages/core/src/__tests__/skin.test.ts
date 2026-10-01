// A skinned MeshPart in the previews (docs/creature-plan.md, step 7): its
// mesh is read with each corner's bones and weights, and the contact sheet and
// the 3D preview bend it by its bones as Roblox does, where a mesh without a
// skin moves with its part.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { prepareAnimation } from '../animation/animation-tool.js';
import { renderContactSheet } from '../animation/contact-sheet.js';
import { fittedMesh, modelMesh, normalizeModelMesh, resetModelMeshesForTests, storeModelMesh } from '../animation/model-meshes.js';
import { rigFromModel } from '../animation/model-rig.js';
import { buildTracks, poseRig, restPose } from '../animation/motion.js';
import { renderRigGlb } from '../animation/rig-glb.js';
import { modelRigMeshes } from '../animation/rig-meshes.js';
import type { Rig } from '../animation/rig.js';
import { skinFrames, skinnedVertices } from '../animation/skin.js';
import { skinnedSnake, SNAKE_BONES } from './fixtures/skinned.js';

const MESH_ID = 'rbxassetid://1';

/**
 * The snake's mesh as Studio sends it: a tube 0.8 square and 8 long, each
 * corner of each triangle in turn, and each corner weighted wholly to the
 * bone it lies along (`blend` instead halves it with the next).
 */
function tube(blend = false) {
  const positions: number[] = [];
  const normals: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const corner = (x: number, y: number, z: number, normal: number[]) => {
    positions.push(x, y, z);
    normals.push(...normal);
    const bone = Math.min(7, Math.max(0, Math.round(4 - z)));
    const next = Math.min(7, bone + 1);
    joints.push(bone, blend ? next : 0, 0, 0);
    weights.push(blend && next !== bone ? 0.5 : 1, blend && next !== bone ? 0.5 : 0, 0, 0);
  };
  for (let z = 4; z > -4; z -= 1) {
    for (const [normal, a, b] of [[[0, 1, 0], [-0.4, 0.4], [0.4, 0.4]], [[0, -1, 0], [0.4, -0.4], [-0.4, -0.4]], [[1, 0, 0], [0.4, 0.4], [0.4, -0.4]], [[-1, 0, 0], [-0.4, -0.4], [-0.4, 0.4]]] as const) {
      corner(a[0], a[1], z, [...normal]);
      corner(b[0], b[1], z, [...normal]);
      corner(b[0], b[1], z - 1, [...normal]);
      corner(a[0], a[1], z, [...normal]);
      corner(b[0], b[1], z - 1, [...normal]);
      corner(a[0], a[1], z - 1, [...normal]);
    }
  }
  return { positions, normals, min: [-0.4, -0.4, -4], max: [0.4, 0.4, 4], skin: { bones: [...SNAKE_BONES], joints, weights } };
}

const snakeLimits = { version: 1, limits: Object.fromEntries(SNAKE_BONES.slice(1).map((name) => [name, { turn: 60 }])) };

function snake(): Rig {
  const read = rigFromModel(skinnedSnake(snakeLimits));
  if (!read.ok) throw new Error(read.errors.join('\n'));
  return read.rig;
}

/** The snake bent 30° about Y at Bone004, which stands at the mesh's middle. */
function bend(rig: Rig) {
  const result = prepareAnimation({
    name: 'Bend', rig: rig.name, loop: false,
    keyframes: [{ time: 0, joints: { Bone004: { rotation: [0, 0, 0] } } }, { time: 1, joints: { Bone004: { rotation: [0, 30, 0] } } }],
  }, {}, rig);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.value.sequence;
}

let directory: string;
beforeEach(() => {
  resetModelMeshesForTests();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-skin-'));
});

describe('a skinned mesh as Studio sends it', () => {
  it('keeps each corner\'s bones and weights, through the fit and the disk', () => {
    const mesh = normalizeModelMesh(tube())!;
    expect(mesh.skin!.bones).toEqual(SNAKE_BONES);
    expect(mesh.skin!.joints).toHaveLength((mesh.positions.length / 3) * 4);
    expect(fittedMesh(mesh, [0.8, 0.8, 8]).skin).toBe(mesh.skin);
    storeModelMesh(MESH_ID, tube(), directory);
    resetModelMeshesForTests();
    expect(modelMesh(MESH_ID, directory)!.skin!.weights).toEqual(mesh.skin!.weights);
  });

  it('is refused whole when its skin is malformed', () => {
    const { skin } = tube();
    expect(normalizeModelMesh({ ...tube(), skin: { ...skin, joints: skin.joints.slice(4) } })).toBeUndefined();
    expect(normalizeModelMesh({ ...tube(), skin: { ...skin, joints: skin.joints.map(() => 8) } })).toBeUndefined();
    expect(normalizeModelMesh({ ...tube(), skin: { ...skin, weights: skin.weights.map(() => -1) } })).toBeUndefined();
    expect(normalizeModelMesh({ ...tube(), skin: { ...skin, bones: [] } })).toBeUndefined();
  });
});

describe('a skinned mesh drawn', () => {
  it('follows its bones: each vertex goes where the bone it is weighted to carries it', () => {
    const rig = snake();
    storeModelMesh(MESH_ID, tube(), directory);
    const mesh = modelRigMeshes(rig, directory).meshes.parts.get('SnakeGeometry')!;
    expect(mesh.skin).toBeDefined();
    const posed = poseRig(buildTracks(bend(rig)), 1, rig).parts;
    const frames = skinFrames(mesh.skin!, 'SnakeGeometry', restPose(rig), posed);
    const bent = skinnedVertices(mesh, frames, posed.get('SnakeGeometry')!);
    const [cos, sin] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    let checked = 0;
    for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
      const [x, y, z] = mesh.positions.slice(vertex * 3, vertex * 3 + 3);
      const [bx, by, bz] = bent.positions.slice(vertex * 3, vertex * 3 + 3);
      expect(by).toBeCloseTo(y, 6);
      if (z > 0.5) {
        // Behind the bend, on bones it does not move.
        expect([bx, bz]).toEqual([x, z]);
      } else {
        // On Bone004 or a bone ahead of it: turned 30° about the bend, at the mesh's middle.
        expect(bx).toBeCloseTo(x * cos + z * sin, 5);
        expect(bz).toBeCloseTo(-x * sin + z * cos, 5);
        checked += 1;
      }
      expect(Math.hypot(...bent.normals.slice(vertex * 3, vertex * 3 + 3))).toBeCloseTo(1, 6);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('blends a vertex between two bones, and leaves one with no weight on its part', () => {
    const rig = snake();
    const mesh = fittedMesh(normalizeModelMesh(tube(true))!, [0.8, 0.8, 8]);
    const posed = poseRig(buildTracks(bend(rig)), 1, rig).parts;
    const frames = skinFrames(mesh.skin!, 'SnakeGeometry', restPose(rig), posed);
    const bent = skinnedVertices(mesh, frames, posed.get('SnakeGeometry')!);
    // A corner at z = 1 is half on Bone003, which stays, and half on Bone004, which turns.
    const at = mesh.positions.findIndex((_value, index) => index % 3 === 2 && mesh.positions[index] === 1) - 2;
    const [x, , z] = mesh.positions.slice(at, at + 3);
    const turned = x * Math.cos(Math.PI / 6) + z * Math.sin(Math.PI / 6);
    expect(bent.positions[at]).toBeCloseTo((x + turned) / 2, 5);
    // With every weight taken away the mesh moves with its part alone.
    const rigid = { ...mesh, skin: { ...mesh.skin!, weights: mesh.skin!.weights.map(() => 0) } };
    expect(skinnedVertices(rigid, frames, posed.get('SnakeGeometry')!).positions).toEqual(mesh.positions);
  });

  it('bends in the contact sheet, and is drawn rigid without the skin', () => {
    const rig = snake();
    const sequence = bend(rig);
    storeModelMesh(MESH_ID, tube(), directory);
    const skinned = modelRigMeshes(rig, directory).meshes;
    const bentSheet = renderContactSheet(sequence, skinned, { rig });
    const { skin: _skin, ...bare } = skinned.parts.get('SnakeGeometry')!;
    const rigidSheet = renderContactSheet(sequence, { ...skinned, parts: new Map([['SnakeGeometry', bare]]) }, { rig });
    expect(bentSheet.png.equals(rigidSheet.png)).toBe(false);
  });

  it('carries its skin into the 3D preview: the part and each bone a joint of it', () => {
    const rig = snake();
    storeModelMesh(MESH_ID, tube(), directory);
    const glb = renderRigGlb(bend(rig), 'Bend', modelRigMeshes(rig, directory).meshes, rig);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    expect(json.skins).toHaveLength(1);
    expect(json.skins[0].joints).toHaveLength(SNAKE_BONES.length + 1);
    expect(json.skins[0].joints.map((node: number) => json.nodes[node].name)).toEqual(['SnakeGeometry', ...SNAKE_BONES]);
    const meshNode = json.nodes.find((node: { name: string }) => node.name === 'SnakeGeometry mesh');
    expect(meshNode.skin).toBe(0);
    const { attributes } = json.meshes[meshNode.mesh].primitives[0];
    expect(json.accessors[attributes.JOINTS_0].count).toBe(json.accessors[attributes.POSITION].count);
    expect(json.accessors[attributes.WEIGHTS_0].type).toBe('VEC4');
    expect(json.accessors[json.skins[0].inverseBindMatrices]).toMatchObject({ type: 'MAT4', count: SNAKE_BONES.length + 1 });
  });

  it('is drawn rigid on a rig that has none of its bones', () => {
    const read = rigFromModel({ ...skinnedSnake(), parts: skinnedSnake().parts.slice(0, 2), joints: skinnedSnake().joints.slice(0, 1) });
    if (!read.ok) throw new Error(read.errors.join('\n'));
    storeModelMesh(MESH_ID, { ...tube(), skin: { ...tube().skin, bones: SNAKE_BONES.map((name) => `Other${name}`) } }, directory);
    expect(modelRigMeshes(read.rig, directory).meshes.parts.get('SnakeGeometry')!.skin).toBeUndefined();
  });
});
