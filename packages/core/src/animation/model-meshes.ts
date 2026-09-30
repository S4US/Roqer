// The meshes of a model's MeshParts, which the previews draw those parts with:
// read from Studio through EditableMesh, by mesh ID, and kept on this machine
// as the stock R15 meshes are (rig-meshes.ts). Each is kept in its own space
// with its bounds, and stretched onto a part's size as Studio stretches it, so
// one mesh serves every part that shows it at any size.
//
// A mesh Studio will not hand over, or one too large to draw, is remembered
// for this process with why, and its part is drawn as its box; the result says
// which and why. Nothing here ships a mesh: they come from the user's Studio.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PartMesh } from './box-rig.js';
import type { Rig, Vec3 } from './rig.js';

/** The most triangles in one mesh a preview draws; Studio refuses larger ones before sending them. */
export const MAX_MODEL_MESH_TRIANGLES = 3000;
/** The most meshes one read from Studio asks for. */
export const MAX_MESHES_PER_READ = 8;
/** The most triangles of meshes one preview draws; past it, parts are drawn as their boxes. */
export const MAX_PREVIEW_MESH_TRIANGLES = 40_000;
/** The most meshes kept on disk; past it, new ones are kept for this process only. */
const MAX_CACHED_MESHES = 256;

/** A mesh in its own space. */
export interface ModelMesh {
  /** Triangle corners, three numbers each, three corners a triangle. */
  positions: number[];
  normals: number[];
  /** Counter-clockwise seen from outside. */
  indices: number[];
  /** Its bounds, which a MeshPart's size stretches onto the part's box. */
  min: Vec3;
  max: Vec3;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

/**
 * A mesh Studio sent, checked and made ready to draw, or undefined when it is
 * malformed or too large. Every triangle is turned to face the way its
 * corners' normals do, whatever winding the source used.
 */
export function normalizeModelMesh(raw: unknown): ModelMesh | undefined {
  if (!isRecord(raw) || !finiteList(raw.positions) || !finiteList(raw.normals) || !finiteList(raw.min) || !finiteList(raw.max)) return undefined;
  const { positions, normals, min, max } = raw;
  const triangles = positions.length / 9;
  if (positions.length === 0 || positions.length % 9 !== 0 || normals.length !== positions.length || triangles > MAX_MODEL_MESH_TRIANGLES) return undefined;
  if (min.length !== 3 || max.length !== 3 || min.some((value, axis) => value > max[axis])) return undefined;
  // Every corner inside its bounds, give or take the rounding it was sent with.
  for (let index = 0; index < positions.length; index += 1) {
    const axis = index % 3;
    if (positions[index] < min[axis] - 0.01 || positions[index] > max[axis] + 0.01) return undefined;
  }
  const indices: number[] = [];
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const [a, b, c] = [triangle * 3, triangle * 3 + 1, triangle * 3 + 2];
    const edge1 = [0, 1, 2].map((axis) => positions[b * 3 + axis] - positions[a * 3 + axis]);
    const edge2 = [0, 1, 2].map((axis) => positions[c * 3 + axis] - positions[a * 3 + axis]);
    const face = [
      edge1[1] * edge2[2] - edge1[2] * edge2[1],
      edge1[2] * edge2[0] - edge1[0] * edge2[2],
      edge1[0] * edge2[1] - edge1[1] * edge2[0],
    ];
    const average = [0, 1, 2].map((axis) => normals[a * 3 + axis] + normals[b * 3 + axis] + normals[c * 3 + axis]);
    const agrees = face[0] * average[0] + face[1] * average[1] + face[2] * average[2] >= 0;
    indices.push(...(agrees ? [a, b, c] : [a, c, b]));
  }
  return { positions, normals, indices, min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

/**
 * A mesh stretched onto a part's box as Studio stretches a MeshPart's: its
 * bounds onto the part's size, about their middle. Normals are turned to stay
 * square to the stretched surface.
 */
export function fittedMesh(mesh: ModelMesh, size: Vec3): PartMesh {
  const middle = [0, 1, 2].map((axis) => (mesh.min[axis] + mesh.max[axis]) / 2);
  const stretch = [0, 1, 2].map((axis) => {
    const extent = mesh.max[axis] - mesh.min[axis];
    return extent > 1e-6 ? size[axis] / extent : 1;
  });
  const positions = mesh.positions.map((value, index) => (value - middle[index % 3]) * stretch[index % 3]);
  const normals: number[] = [];
  for (let index = 0; index < mesh.normals.length; index += 3) {
    const n = [0, 1, 2].map((axis) => mesh.normals[index + axis] / stretch[axis]);
    const length = Math.hypot(n[0], n[1], n[2]);
    normals.push(...(length > 1e-9 ? n.map((value) => value / length) : [0, 1, 0]));
  }
  return { positions, normals, indices: mesh.indices };
}

const known = new Map<string, ModelMesh>();
const refused = new Map<string, string>();

function meshFile(directory: string, id: string): string {
  return path.join(directory, 'model-meshes', `${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32)}.json`);
}

/** A mesh already read: from this process, or from the disk cache when it is sound and is this mesh's. */
export function modelMesh(id: string, directory: string): ModelMesh | undefined {
  const held = known.get(id);
  if (held) return held;
  try {
    const stored = JSON.parse(fs.readFileSync(meshFile(directory, id), 'utf8'));
    if (!isRecord(stored) || stored.id !== id) return undefined;
    const mesh = normalizeModelMesh(stored);
    if (mesh) known.set(id, mesh);
    return mesh;
  } catch {
    return undefined;
  }
}

/** Why Studio would not hand a mesh over this process, if it would not. */
export function meshRefusal(id: string): string | undefined {
  return refused.get(id);
}

/**
 * Keep what Studio answered for a mesh: the mesh, for this process and later
 * ones, or why it could not be read, for this process only, so a later one
 * asks again. Returns the mesh ready to draw.
 */
export function storeModelMesh(id: string, raw: unknown, directory: string): ModelMesh | undefined {
  const mesh = normalizeModelMesh(raw);
  if (!mesh) {
    const reason = isRecord(raw) && typeof raw.error === 'string' && raw.error !== '' ? raw.error.slice(0, 200) : 'Studio sent a mesh that is malformed or too large';
    refused.set(id, reason);
    return undefined;
  }
  known.set(id, mesh);
  refused.delete(id);
  try {
    const folder = path.dirname(meshFile(directory, id));
    fs.mkdirSync(folder, { recursive: true });
    if (fs.readdirSync(folder).length < MAX_CACHED_MESHES) {
      const file = meshFile(directory, id);
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ id, positions: mesh.positions, normals: mesh.normals, min: mesh.min, max: mesh.max }));
      fs.renameSync(temporary, file);
    }
  } catch {
    // The mesh still serves this process; a later one reads it from Studio again.
  }
  return mesh;
}

/** Every mesh a rig's parts and welded parts show, each once, in the order they are drawn. */
export function rigMeshIds(rig: Rig): string[] {
  const ids: string[] = [];
  for (const part of Object.keys(rig.parts)) {
    const own = rig.meshIds?.[part];
    if (own !== undefined) ids.push(own);
    for (const piece of rig.attached?.[part] ?? []) if (piece.mesh !== undefined) ids.push(piece.mesh);
  }
  return [...new Set(ids)];
}

/** The meshes of a rig still to read: neither held nor refused this process. */
export function meshesToRead(rig: Rig, directory: string): string[] {
  return rigMeshIds(rig).filter((id) => !refused.has(id) && !modelMesh(id, directory));
}

/** Forget what this process has read and been refused; for tests. */
export function resetModelMeshesForTests(): void {
  known.clear();
  refused.clear();
}
