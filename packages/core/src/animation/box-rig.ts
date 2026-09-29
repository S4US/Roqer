// A stand-in for the R15 rig, drawn until a build has read the stock rig's
// real meshes from Studio (see rig-meshes.ts): every part a box with rounded
// edges, sized as the stock rig's parts are, in a light grey. Both the contact
// sheet and the 3D preview draw whichever rig is current, so the model sees
// the same figure the user plays back.

import { R15_RIG, type Rig, type Vec3 } from './r15-rig.js';

export type Rgb = readonly [number, number, number];

/** One light grey for the whole rig, as a plain R15 dummy is. */
export const RIG_COLOR: Rgb = [214, 217, 222];

/**
 * The body's parts, drawn in every preview: every part but the
 * HumanoidRootPart, which Roblox hides, and a held weapon's.
 */
export function drawnParts(rig: Rig = R15_RIG): string[] {
  const held = new Set(heldParts(rig));
  return Object.keys(rig.parts).filter((part) => part !== rig.rootPart && !held.has(part));
}

/** The parts of optional joints, such as the weapon: drawn only when an animation moves them. */
export function heldParts(rig: Rig = R15_RIG): string[] {
  return rig.joints.filter((joint) => joint.optional).map((joint) => joint.childPart);
}

/** Where the ground is, in the HumanoidRootPart's frame. */
export function groundHeight(rig: Rig = R15_RIG): number {
  return rig.ground;
}

export interface PartMesh {
  positions: number[];
  normals: number[];
  /** Counter-clockwise seen from outside. */
  indices: number[];
}

/** How round a part's edges are: the head most, thin parts no more than they allow. */
function edgeRadius(part: string, size: Vec3): number {
  const wanted = part === 'Head' ? 0.3 : part.endsWith('Torso') ? 0.14 : 0.11;
  return Math.min(wanted, Math.min(...size) * 0.45);
}

// Each face: its outward normal and two tangents whose cross product is it,
// so a grid walked along them winds counter-clockwise seen from outside.
const FACES: { normal: number; sign: number; u: number; v: number }[] = [
  { normal: 0, sign: 1, u: 1, v: 2 },
  { normal: 0, sign: -1, u: 2, v: 1 },
  { normal: 1, sign: 1, u: 2, v: 0 },
  { normal: 1, sign: -1, u: 0, v: 2 },
  { normal: 2, sign: 1, u: 0, v: 1 },
  { normal: 2, sign: -1, u: 1, v: 0 },
];

/**
 * A box of the given size with rounded edges, centred on the origin. Each
 * face is a grid whose outer rows are spaced so that, pushed out onto the
 * rounded shell, they step evenly round the edge: faces meet with matching
 * vertices and normals, and the shading is smooth across them.
 */
export function roundedBox(size: Vec3, radius: number, steps = 3): PartMesh {
  const half = size.map((value) => value / 2);
  const inner = half.map((value) => Math.max(value - radius, 0));
  const coordinates = half.map((_value, axis) => {
    const edge = Array.from({ length: steps + 1 }, (_unused, index) => inner[axis] + radius * Math.tan((index * Math.PI) / 4 / steps));
    return [...edge.slice().reverse().map((value) => -value), ...edge];
  });
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const face of FACES) {
    const us = coordinates[face.u];
    const vs = coordinates[face.v];
    const base = positions.length / 3;
    for (const v of vs) {
      for (const u of us) {
        const point = [0, 0, 0];
        point[face.normal] = face.sign * half[face.normal];
        point[face.u] = u;
        point[face.v] = v;
        const core = point.map((value, axis) => Math.max(-inner[axis], Math.min(inner[axis], value)));
        const offset = point.map((value, axis) => value - core[axis]);
        const length = Math.hypot(offset[0], offset[1], offset[2]);
        const normal = length > 1e-9 ? offset.map((value) => value / length) : [0, 0, 0].map((_v, axis) => (axis === face.normal ? face.sign : 0));
        positions.push(...core.map((value, axis) => value + normal[axis] * radius));
        normals.push(...normal);
      }
    }
    const row = us.length;
    for (let j = 0; j + 1 < vs.length; j += 1) {
      for (let i = 0; i + 1 < us.length; i += 1) {
        const a = base + j * row + i;
        indices.push(a, a + 1, a + row + 1, a, a + row + 1, a + row);
      }
    }
  }
  return { positions, normals, indices };
}

/** A part's mesh, in the part's own frame. */
export function partMesh(part: string, rig: Rig = R15_RIG): PartMesh {
  const size = rig.parts[part];
  const mesh = roundedBox(size, edgeRadius(part, size));
  const offset = rig.drawOffsets?.[part];
  if (offset) mesh.positions = mesh.positions.map((value, index) => value + offset[index % 3]);
  return mesh;
}
