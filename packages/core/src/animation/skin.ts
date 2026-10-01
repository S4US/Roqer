// Skinning for the previews: a skinned MeshPart's vertices follow its bones,
// each by its weights, as Roblox bends the mesh (docs/creature-plan.md, step
// 7). The mesh is kept in its part's frame at rest; a bone carries a vertex
// from where the bone rested to where it is now.

import { SKIN_SLOTS, type MeshSkin, type PartMesh } from './box-rig.js';
import { multiply, type Frame } from './motion.js';

/** A rigid transform's inverse. */
export function invertFrame(frame: Frame): Frame {
  const r = frame.r;
  const t: Frame['r'] = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
  return {
    p: [
      -(t[0] * frame.p[0] + t[1] * frame.p[1] + t[2] * frame.p[2]),
      -(t[3] * frame.p[0] + t[4] * frame.p[1] + t[5] * frame.p[2]),
      -(t[6] * frame.p[0] + t[7] * frame.p[1] + t[8] * frame.p[2]),
    ],
    r: t,
  };
}

/**
 * For each of a skin's bones, the transform that carries a point of the mesh
 * at rest, in its part's frame, to where the bone now holds it, in the frame
 * `rest` and `posed` are in: the bone's frame now, times its inverse at rest,
 * times the part's at rest. A bone the pose does not hold has none, and its
 * weight moves with the part.
 */
export function skinFrames(skin: MeshSkin, part: string, rest: ReadonlyMap<string, Frame>, posed: ReadonlyMap<string, Frame>): (Frame | undefined)[] {
  const partRest = rest.get(part);
  return skin.bones.map((bone) => {
    const [from, to] = [rest.get(bone), posed.get(bone)];
    return partRest && from && to ? multiply(multiply(to, invertFrame(from)), partRest) : undefined;
  });
}

const apply = (frame: Frame, v: readonly number[], at: number, point: boolean): [number, number, number] => {
  const r = frame.r;
  const [x, y, z] = [v[at], v[at + 1], v[at + 2]];
  return [
    r[0] * x + r[1] * y + r[2] * z + (point ? frame.p[0] : 0),
    r[3] * x + r[4] * y + r[5] * z + (point ? frame.p[1] : 0),
    r[6] * x + r[7] * y + r[8] * z + (point ? frame.p[2] : 0),
  ];
};

/**
 * A skinned mesh's vertices and normals where its bones hold them: each
 * vertex the weighted blend of where each of its bones carries it, and
 * whatever weight it lacks, of where its part does.
 */
export function skinnedVertices(mesh: PartMesh, frames: readonly (Frame | undefined)[], partFrame: Frame): { positions: number[]; normals: number[] } {
  const skin = mesh.skin!;
  const positions: number[] = [];
  const normals: number[] = [];
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
    const at = vertex * 3;
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    let held = 0;
    for (let slot = 0; slot < SKIN_SLOTS; slot += 1) {
      const weight = skin.weights[vertex * SKIN_SLOTS + slot];
      const frame = weight > 0 ? frames[skin.joints[vertex * SKIN_SLOTS + slot]] : undefined;
      if (!frame) continue;
      held += weight;
      const [point, normal] = [apply(frame, mesh.positions, at, true), apply(frame, mesh.normals, at, false)];
      for (let axis = 0; axis < 3; axis += 1) {
        p[axis] += weight * point[axis];
        n[axis] += weight * normal[axis];
      }
    }
    const rigid = Math.max(0, 1 - held);
    if (rigid > 1e-6) {
      const [point, normal] = [apply(partFrame, mesh.positions, at, true), apply(partFrame, mesh.normals, at, false)];
      for (let axis = 0; axis < 3; axis += 1) {
        p[axis] += rigid * point[axis];
        n[axis] += rigid * normal[axis];
      }
    }
    const length = Math.hypot(n[0], n[1], n[2]);
    positions.push(p[0], p[1], p[2]);
    normals.push(...(length > 1e-9 ? [n[0] / length, n[1] / length, n[2] / length] : [0, 1, 0]));
  }
  return { positions, normals };
}
