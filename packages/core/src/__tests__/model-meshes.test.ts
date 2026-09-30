// The meshes of a model's MeshParts: read from Studio by mesh ID, kept on this
// machine, stretched onto each part's size as Studio stretches them, and drawn
// within a triangle budget, a part past it or unread drawn as its box.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { partMesh, type PartMesh } from '../animation/box-rig.js';
import {
  MAX_MODEL_MESH_TRIANGLES,
  MAX_PREVIEW_MESH_TRIANGLES,
  fittedMesh,
  meshRefusal,
  meshesToRead,
  modelMesh,
  normalizeModelMesh,
  resetModelMeshesForTests,
  rigMeshIds,
  storeModelMesh,
} from '../animation/model-meshes.js';
import { rigFromModel, type ModelRigReading } from '../animation/model-rig.js';
import { modelRigMeshes } from '../animation/rig-meshes.js';
import type { Rig } from '../animation/rig.js';
import { IDENTITY, partsDog } from './fixtures/parts-dog.js';

/** A mesh as Studio sends one: each triangle's corners in turn, in the mesh's own space, with its bounds. */
function sent(mesh: PartMesh, shift: [number, number, number] = [0, 0, 0]) {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const index of mesh.indices) {
    positions.push(...[0, 1, 2].map((axis) => mesh.positions[index * 3 + axis] + shift[axis]));
    normals.push(...mesh.normals.slice(index * 3, index * 3 + 3));
  }
  const bound = (pick: (a: number, b: number) => number) =>
    [0, 1, 2].map((axis) => positions.filter((_value, index) => index % 3 === axis).reduce((a, b) => pick(a, b)));
  return { positions, normals, min: bound(Math.min), max: bound(Math.max) };
}

/** A 2-stud cube with square edges: 12 triangles, wound outward. */
function squareCube(): PartMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const axis of [0, 1, 2]) {
    for (const sign of [1, -1]) {
      const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
      const base = positions.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const corner = [0, 0, 0];
        corner[axis] = sign;
        corner[u] = a * sign;
        corner[v] = b;
        positions.push(...corner);
        normals.push(...[0, 1, 2].map((index) => (index === axis ? sign : 0)));
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { positions, normals, indices };
}

/** The cube as Studio sends it, off its own origin as a mesh often is. */
const cube = () => sent(squareCube(), [5, 0, 0]);

/** The dog with its head a MeshPart and a MeshPart collar welded to its body. */
function meshDog(): Rig {
  const reading: ModelRigReading = {
    ...partsDog(),
    parts: partsDog().parts.map((part) => (part.name === 'Head' ? { ...part, mesh: 'rbxassetid://11' } : part)),
    welded: [{ name: 'Collar', to: 'Body', offset: [0, 0.2, -1.9, ...IDENTITY], size: [1.4, 0.4, 0.4], mesh: 'rbxassetid://12' }],
  };
  const read = rigFromModel(reading);
  if (!read.ok) throw new Error(read.errors.join('\n'));
  return read.rig;
}

let directory: string;
beforeEach(() => {
  resetModelMeshesForTests();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-model-meshes-'));
});

describe('a MeshPart\'s mesh', () => {
  it('is checked when Studio sends it, and each triangle turned to face the way its normals do', () => {
    const mesh = normalizeModelMesh(cube())!;
    expect(mesh.indices).toHaveLength(36);
    expect(mesh.min).toEqual([4, -1, -1]);
    // Sent wound the other way, it is turned back.
    const backwards = cube();
    for (let corner = 0; corner < backwards.positions.length; corner += 9) {
      const second = backwards.positions.slice(corner + 3, corner + 6);
      backwards.positions.splice(corner + 3, 3, ...backwards.positions.slice(corner + 6, corner + 9));
      backwards.positions.splice(corner + 6, 3, ...second);
    }
    const turned = normalizeModelMesh(backwards)!;
    expect(turned.indices.slice(0, 3)).toEqual([0, 2, 1]);
    // Malformed, or too large to draw, it is refused.
    expect(normalizeModelMesh({ ...cube(), positions: cube().positions.slice(1) })).toBeUndefined();
    expect(normalizeModelMesh({ ...cube(), min: [9, 9, 9] })).toBeUndefined();
    expect(normalizeModelMesh({ ...cube(), normals: [Number.NaN, ...cube().normals.slice(1)] })).toBeUndefined();
    const huge = { positions: [] as number[], normals: [] as number[], min: [0, 0, 0], max: [1, 1, 1] };
    for (let triangle = 0; triangle <= MAX_MODEL_MESH_TRIANGLES; triangle += 1) {
      huge.positions.push(0, 0, 0, 1, 0, 0, 0, 1, 0);
      huge.normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
    }
    expect(normalizeModelMesh(huge)).toBeUndefined();
  });

  it('is stretched onto a part\'s size about its middle, its normals kept square to it', () => {
    const fitted = fittedMesh(normalizeModelMesh(cube())!, [4, 1, 2]);
    const along = (axis: number) => fitted.positions.filter((_value, index) => index % 3 === axis);
    expect([0, 1, 2].map((axis) => [Math.min(...along(axis)), Math.max(...along(axis))])).toEqual([[-2, 2], [-0.5, 0.5], [-1, 1]]);
    for (let index = 0; index < fitted.normals.length; index += 3) {
      expect(Math.hypot(...fitted.normals.slice(index, index + 3))).toBeCloseTo(1, 9);
    }
  });

  it('is kept on disk by its ID, read back by a later process, and a damaged or other mesh\'s file is ignored', () => {
    expect(storeModelMesh('rbxassetid://11', cube(), directory)).toBeDefined();
    resetModelMeshesForTests();
    expect(modelMesh('rbxassetid://11', directory)?.indices).toHaveLength(36);
    const [file] = fs.readdirSync(path.join(directory, 'model-meshes'));
    fs.writeFileSync(path.join(directory, 'model-meshes', file), JSON.stringify({ ...cube(), id: 'rbxassetid://99' }));
    resetModelMeshesForTests();
    expect(modelMesh('rbxassetid://11', directory)).toBeUndefined();
    fs.writeFileSync(path.join(directory, 'model-meshes', file), '{ not json');
    expect(modelMesh('rbxassetid://11', directory)).toBeUndefined();
  });

  it('that Studio would not hand over is remembered with why, and not asked for again this process', () => {
    const rig = meshDog();
    // In the order the parts are drawn: the body, with its collar, before the head.
    expect(rigMeshIds(rig)).toEqual(['rbxassetid://12', 'rbxassetid://11']);
    expect(meshesToRead(rig, directory)).toEqual(['rbxassetid://12', 'rbxassetid://11']);
    expect(storeModelMesh('rbxassetid://12', { error: 'Studio would not hand it over: not permitted' }, directory)).toBeUndefined();
    expect(meshRefusal('rbxassetid://12')).toBe('Studio would not hand it over: not permitted');
    storeModelMesh('rbxassetid://11', cube(), directory);
    expect(meshesToRead(rig, directory)).toEqual([]);
    // Nothing refused is kept on disk, so a later process asks again.
    resetModelMeshesForTests();
    expect(meshesToRead(rig, directory)).toEqual(['rbxassetid://12']);
  });
});

describe('a model drawn with its meshes', () => {
  it('draws each MeshPart read as its mesh, and names the rest drawn as boxes with why', () => {
    const rig = meshDog();
    expect(rig.meshIds).toEqual({ Head: 'rbxassetid://11' });
    expect(rig.attached?.Body?.[0].mesh).toBe('rbxassetid://12');
    const unread = modelRigMeshes(rig, directory);
    expect(unread.meshes.source).toBe('generated');
    expect(unread.boxes).toEqual([
      { part: 'Collar', reason: 'its mesh has not been read from Studio' },
      { part: 'Head', reason: 'its mesh has not been read from Studio' },
    ]);
    storeModelMesh('rbxassetid://11', cube(), directory);
    storeModelMesh('rbxassetid://12', { error: 'Studio would not hand it over: not permitted' }, directory);
    const read = modelRigMeshes(rig, directory);
    expect(read.meshes.source).toBe('studio');
    expect(read.boxes).toEqual([{ part: 'Collar', reason: 'Studio would not hand it over: not permitted' }]);
    // The head is the cube fitted to its box; the body carries its collar as a box.
    expect(read.meshes.parts.get('Head')!.indices).toHaveLength(36);
    expect(read.meshes.parts.get('Body')!.positions.length).toBe(partMesh('Body', rig).positions.length);
  });

  it('draws parts past the preview\'s triangle budget as their boxes', () => {
    // Spikes welded along the back, each showing one mesh of the most triangles a mesh may have.
    const spiked = (count: number) => {
      const welded = Array.from({ length: count }, (_unused, index) => ({
        name: `Spike${index}`, to: 'Body', offset: [0, 0.8, -1.8 + index * 0.25, ...IDENTITY], size: [0.2, 0.4, 0.2] as [number, number, number], mesh: 'rbxassetid://20',
      }));
      const read = rigFromModel({ ...partsDog(), welded });
      if (!read.ok) throw new Error(read.errors.join('\n'));
      return read.rig;
    };
    const big = { positions: [] as number[], normals: [] as number[], min: [0, 0, 0], max: [1, 1, 1] };
    for (let triangle = 0; triangle < MAX_MODEL_MESH_TRIANGLES; triangle += 1) {
      big.positions.push(0, 0, 0, 1, 0, 0, 0, 1, 0);
      big.normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
    }
    storeModelMesh('rbxassetid://20', big, directory);
    const fits = Math.floor(MAX_PREVIEW_MESH_TRIANGLES / MAX_MODEL_MESH_TRIANGLES);
    expect(modelRigMeshes(spiked(fits), directory).boxes).toEqual([]);
    // One more use is past the budget, and a mesh is drawn for all its parts or none.
    const past = modelRigMeshes(spiked(fits + 1), directory);
    expect(past.boxes).toHaveLength(fits + 1);
    expect(past.boxes[0]).toEqual({ part: 'Spike0', reason: `past the ${MAX_PREVIEW_MESH_TRIANGLES} triangles of meshes a preview draws` });
  });
});
