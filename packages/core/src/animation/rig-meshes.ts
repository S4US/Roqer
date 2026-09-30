// The meshes the animation preview draws: the stock R15 rig's real body
// meshes and Roblox's classic head, read once from a connected Studio and
// kept on this machine, or, until then, the generated block rig.
//
// Nothing here ships Roblox's meshes. They are read from the user's own Studio
// by the plugin, validated, and cached under the MCP's own data folder; a
// missing or damaged cache falls back to the generated rig.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { drawnParts, heldParts, meshParts, partMesh, type MeshLibrary, type PartMesh } from './box-rig.js';
import { MAX_PREVIEW_MESH_TRIANGLES, meshRefusal, modelMesh, type ModelMesh } from './model-meshes.js';
import { R15_RIG } from './r15-rig.js';
import type { Rig } from './rig.js';
import { RIGS } from './rigs.js';

export interface RigMeshes {
  /** Where the meshes came from. */
  source: 'studio' | 'generated';
  parts: ReadonlyMap<string, PartMesh>;
}

const CACHE_FILE = 'r15-rig-meshes-v1.json';
const MAX_TRIANGLES_PER_PART = 4000;

export function rigMeshCacheDirectory(): string {
  return process.env.ROBLOXSTUDIO_MCP_CACHE_DIR ?? path.join(os.homedir(), '.robloxstudio-mcp', 'cache');
}

const generated = new Map<string, RigMeshes>();
let loaded: RigMeshes | undefined;

/**
 * The block rig: every body part, and a held weapon's stand-in, as rounded
 * boxes, or on a model's rig as each part's shape, or its MeshPart's mesh from
 * `library`, with what is welded to it. R15's and R6's are kept; a model's rig
 * may change between calls.
 */
export function generatedRigMeshes(rig: Rig = R15_RIG, library?: MeshLibrary): RigMeshes {
  const builtIn = RIGS.get(rig.name) === rig;
  let meshes = builtIn ? generated.get(rig.name) : undefined;
  if (!meshes) {
    const parts = [...meshParts(rig), ...heldParts(rig)];
    meshes = { source: 'generated', parts: new Map(parts.map((part) => [part, partMesh(part, rig, library)])) };
    if (builtIn) generated.set(rig.name, meshes);
  }
  return meshes;
}

/** A MeshPart drawn as its box, and why. */
export interface BoxedMeshPart {
  part: string;
  reason: string;
}

/**
 * What a model's rig is drawn with: each MeshPart as its mesh where Studio
 * handed it over and the preview's triangle budget holds it, as its box
 * otherwise, and which were boxes and why. A mesh several parts show counts
 * for each.
 */
export function modelRigMeshes(rig: Rig, directory = rigMeshCacheDirectory()): { meshes: RigMeshes; boxes: BoxedMeshPart[] } {
  const uses: { part: string; id: string }[] = [];
  const drawn = new Set(drawnParts(rig));
  for (const part of meshParts(rig)) {
    const own = rig.meshIds?.[part];
    if (own !== undefined && drawn.has(part)) uses.push({ part, id: own });
    for (const piece of rig.attached?.[part] ?? []) if (piece.mesh !== undefined) uses.push({ part: piece.part, id: piece.mesh });
  }
  const library = new Map<string, ModelMesh>();
  const over = new Set<string>();
  let triangles = 0;
  for (const { id } of uses) {
    if (library.has(id) || over.has(id)) continue;
    const mesh = modelMesh(id, directory);
    if (!mesh) continue;
    const needed = (mesh.indices.length / 3) * uses.filter((use) => use.id === id).length;
    if (triangles + needed > MAX_PREVIEW_MESH_TRIANGLES) {
      over.add(id);
      continue;
    }
    triangles += needed;
    library.set(id, mesh);
  }
  const boxes = uses
    .filter(({ id }) => !library.has(id))
    .map(({ part, id }) => ({
      part,
      reason: over.has(id)
        ? `past the ${MAX_PREVIEW_MESH_TRIANGLES} triangles of meshes a preview draws`
        : meshRefusal(id) ?? 'its mesh has not been read from Studio',
    }));
  const meshes = generatedRigMeshes(rig, library);
  return { meshes: library.size > 0 ? { ...meshes, source: 'studio' } : meshes, boxes };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The meshes a plugin sent, checked and made ready to draw, or undefined when
 * any part is missing or malformed. Every triangle is turned to face the way
 * its corners' normals do, whatever winding the source used.
 */
export function normalizeRigMeshes(raw: unknown): RigMeshes | undefined {
  if (!isRecord(raw) || !isRecord(raw.parts)) return undefined;
  const parts = new Map<string, PartMesh>();
  for (const part of drawnParts()) {
    const entry = raw.parts[part];
    if (!isRecord(entry) || !Array.isArray(entry.positions) || !Array.isArray(entry.normals)) return undefined;
    const positions = entry.positions as unknown[];
    const normals = entry.normals as unknown[];
    const triangles = positions.length / 9;
    if (positions.length === 0 || positions.length % 9 !== 0 || normals.length !== positions.length || triangles > MAX_TRIANGLES_PER_PART) return undefined;
    if (![...positions, ...normals].every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
    // Stretched onto the part's size about its centre, so nothing lies far outside it.
    const half = R15_RIG.parts[part].map((size) => size / 2 + 0.25);
    for (let index = 0; index < positions.length; index += 1) {
      if (Math.abs(positions[index] as number) > half[index % 3]) return undefined;
    }
    const p = positions as number[];
    const n = normals as number[];
    const indices: number[] = [];
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      const [a, b, c] = [triangle * 3, triangle * 3 + 1, triangle * 3 + 2];
      const edge1 = [0, 1, 2].map((axis) => p[b * 3 + axis] - p[a * 3 + axis]);
      const edge2 = [0, 1, 2].map((axis) => p[c * 3 + axis] - p[a * 3 + axis]);
      const face = [
        edge1[1] * edge2[2] - edge1[2] * edge2[1],
        edge1[2] * edge2[0] - edge1[0] * edge2[2],
        edge1[0] * edge2[1] - edge1[1] * edge2[0],
      ];
      const average = [0, 1, 2].map((axis) => n[a * 3 + axis] + n[b * 3 + axis] + n[c * 3 + axis]);
      const agrees = face[0] * average[0] + face[1] * average[1] + face[2] * average[2] >= 0;
      indices.push(...(agrees ? [a, b, c] : [a, c, b]));
    }
    parts.set(part, { positions: p, normals: n, indices });
  }
  return { source: 'studio', parts };
}

/** Keep meshes a plugin sent, for this process and later ones. Returns them ready to draw. */
export function storeRigMeshes(raw: unknown, directory = rigMeshCacheDirectory()): RigMeshes | undefined {
  const meshes = normalizeRigMeshes(raw);
  if (!meshes || !isRecord(raw)) return undefined;
  loaded = meshes;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, CACHE_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ parts: raw.parts }));
    fs.renameSync(temporary, file);
  } catch {
    // The meshes still serve this process; a later one reads them from Studio again.
  }
  return meshes;
}

/** The cached real meshes, if a Studio has sent them before and the cache is sound. */
export function cachedRigMeshes(directory = rigMeshCacheDirectory()): RigMeshes | undefined {
  if (loaded) return loaded;
  try {
    const meshes = normalizeRigMeshes(JSON.parse(fs.readFileSync(path.join(directory, CACHE_FILE), 'utf8')));
    if (meshes) loaded = meshes;
    return meshes;
  } catch {
    return undefined;
  }
}

/**
 * What the preview draws now: the stock R15 rig's real meshes when known, the
 * generated rig otherwise. A held weapon is always the generated stand-in,
 * and R6 is always blocks, as its parts are. A model's rig is drawn as
 * modelRigMeshes draws it.
 */
export function currentRigMeshes(rig: Rig = R15_RIG): RigMeshes {
  if (RIGS.get(rig.name) !== rig) return modelRigMeshes(rig).meshes;
  const cached = rig.name === 'R15' ? cachedRigMeshes() : undefined;
  if (!cached) return generatedRigMeshes(rig);
  const standIns = generatedRigMeshes(rig).parts;
  return {
    source: 'studio',
    parts: new Map([...cached.parts, ...heldParts(rig).map((part) => [part, standIns.get(part)!] as const)]),
  };
}

/** Forget what this process has loaded; for tests. */
export function resetRigMeshesForTests(): void {
  loaded = undefined;
}
