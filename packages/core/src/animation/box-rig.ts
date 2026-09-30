// A stand-in for the R15 rig, drawn until a build has read the stock rig's
// real meshes from Studio (see rig-meshes.ts): every part a box with rounded
// edges, sized as the stock rig's parts are, in a light grey. Both the contact
// sheet and the 3D preview draw whichever rig is current, so the model sees
// the same figure the user plays back.
//
// A rig read from a model is drawn the same way, each part as its shape
// (a block, wedge, cylinder or ball) with the parts welded to it.

import { R15_RIG } from './r15-rig.js';
import type { PartShape, Rig, RigAttachment, Vec3 } from './rig.js';

export type Rgb = readonly [number, number, number];

/** One light grey for the whole rig, as a plain R15 dummy is. */
export const RIG_COLOR: Rgb = [214, 217, 222];

/**
 * The body's parts, drawn in every preview: every part but the hidden ones
 * (on a character, the HumanoidRootPart, which Roblox hides) and a held
 * weapon's.
 */
export function drawnParts(rig: Rig = R15_RIG): string[] {
  const held = new Set(heldParts(rig));
  const hidden = new Set(rig.hidden ?? [rig.rootPart]);
  return Object.keys(rig.parts).filter((part) => !hidden.has(part) && !held.has(part));
}

/**
 * The parts a preview has a mesh for: the drawn parts, and a hidden one that
 * visible parts are welded to, drawn as those parts alone.
 */
export function meshParts(rig: Rig = R15_RIG): string[] {
  const held = new Set(heldParts(rig));
  const hidden = new Set(rig.hidden ?? [rig.rootPart]);
  return Object.keys(rig.parts).filter((part) => !held.has(part) && (!hidden.has(part) || (rig.attached?.[part]?.length ?? 0) > 0));
}

/** The parts of optional joints, such as the weapon: drawn only when an animation moves them. */
export function heldParts(rig: Rig = R15_RIG): string[] {
  return rig.joints.filter((joint) => joint.optional).map((joint) => joint.childPart);
}

/** Where the ground is, in the root part's frame. */
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

/**
 * A Ball part: the ellipsoid its box holds, which Roblox keeps a sphere. Rings
 * run from the top down and segments round the vertical.
 */
export function ball(size: Vec3, rings = 10, segments = 16): PartMesh {
  const half = size.map((value) => value / 2);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const down = (ring * Math.PI) / rings;
    for (let segment = 0; segment <= segments; segment += 1) {
      const round = (segment * 2 * Math.PI) / segments;
      const unit = [Math.sin(down) * Math.cos(round), Math.cos(down), Math.sin(down) * Math.sin(round)];
      positions.push(...unit.map((value, axis) => value * half[axis]));
      const gradient = unit.map((value, axis) => value / half[axis]);
      const length = Math.hypot(gradient[0], gradient[1], gradient[2]);
      normals.push(...gradient.map((value) => value / length));
    }
  }
  const row = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * row + segment;
      // The rings at the poles are single points: one triangle a step there.
      if (ring > 0) indices.push(a, a + 1, a + row);
      if (ring < rings - 1) indices.push(a + 1, a + row + 1, a + row);
    }
  }
  return { positions, normals, indices };
}

/**
 * A Cylinder part as Roblox draws one: its length along X, round across Y
 * and Z, and as wide as the smaller of the two.
 */
export function cylinder(size: Vec3, segments = 20): PartMesh {
  const length = size[0] / 2;
  const radius = Math.min(size[1], size[2]) / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const angle = (step: number) => (step * 2 * Math.PI) / segments;
  for (let step = 0; step <= segments; step += 1) {
    const [c, s] = [Math.cos(angle(step)), Math.sin(angle(step))];
    positions.push(-length, radius * c, radius * s, length, radius * c, radius * s);
    normals.push(0, c, s, 0, c, s);
  }
  for (let step = 0; step < segments; step += 1) {
    const a = step * 2;
    indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
  }
  for (const side of [-1, 1]) {
    const centre = positions.length / 3;
    positions.push(side * length, 0, 0);
    normals.push(side, 0, 0);
    for (let step = 0; step <= segments; step += 1) {
      positions.push(side * length, radius * Math.cos(angle(step)), radius * Math.sin(angle(step)));
      normals.push(side, 0, 0);
    }
    for (let step = 0; step < segments; step += 1) {
      const a = centre + 1 + step;
      indices.push(...(side > 0 ? [centre, a, a + 1] : [centre, a + 1, a]));
    }
  }
  return { positions, normals, indices };
}

/**
 * A wedge as Roblox draws one: full faces underneath and at the back (+Z),
 * and its slope rising from the front's bottom edge to the back's top edge.
 */
export function wedge(size: Vec3): PartMesh {
  const [w, h, d] = size.map((value) => value / 2);
  const faces: Vec3[][] = [
    [[-w, -h, -d], [w, -h, -d], [w, -h, d], [-w, -h, d]],
    [[-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d]],
    [[-w, -h, -d], [w, -h, -d], [w, h, d], [-w, h, d]],
    [[-w, -h, -d], [-w, -h, d], [-w, h, d]],
    [[w, -h, -d], [w, -h, d], [w, h, d]],
  ];
  // A point inside: the centre of the wedge's triangular cross-section.
  const inside: Vec3 = [0, -h / 3, d / 3];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const [a, b, c] = face;
    const u = b.map((value, axis) => value - a[axis]);
    const v = c.map((value, axis) => value - a[axis]);
    let normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const middle = [0, 1, 2].map((axis) => face.reduce((sum, point) => sum + point[axis], 0) / face.length);
    // Wound to face away from the inside, whichever way the corners were listed.
    const outward = normal.reduce((sum, value, axis) => sum + value * (middle[axis] - inside[axis]), 0) > 0;
    const corners = outward ? face : [...face].reverse();
    if (!outward) normal = normal.map((value) => -value);
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    const base = positions.length / 3;
    for (const corner of corners) {
      positions.push(...corner);
      normals.push(...normal.map((value) => value / length));
    }
    for (let index = 1; index + 1 < corners.length; index += 1) indices.push(base, base + index, base + index + 1);
  }
  return { positions, normals, indices };
}

/** A part of the given shape and size, centred on the origin; a block's edges are rounded by `radius`. */
export function shapeMesh(shape: PartShape, size: Vec3, radius: number): PartMesh {
  if (shape === 'Ball') return ball(size);
  if (shape === 'Cylinder') return cylinder(size);
  if (shape === 'Wedge') return wedge(size);
  return roundedBox(size, radius);
}

/** A block's rounding on a rig read from a model: a slight bevel, less on a thin part. */
function modelEdgeRadius(size: Vec3): number {
  return Math.min(0.06, Math.min(...size) * 0.2);
}

/** A mesh moved by a CFrame's components: turned by its rotation, then moved by its position. */
function placed(mesh: PartMesh, offset: RigAttachment['offset']): PartMesh {
  const turn = (v: number[]) => [0, 1, 2].map((row) => offset[3 + row * 3] * v[0] + offset[4 + row * 3] * v[1] + offset[5 + row * 3] * v[2]);
  const positions: number[] = [];
  const normals: number[] = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    positions.push(...turn(mesh.positions.slice(index, index + 3)).map((value, axis) => value + offset[axis]));
    normals.push(...turn(mesh.normals.slice(index, index + 3)));
  }
  return { positions, normals, indices: mesh.indices };
}

/** Several meshes as one. */
function merged(meshes: readonly PartMesh[]): PartMesh {
  const result: PartMesh = { positions: [], normals: [], indices: [] };
  for (const mesh of meshes) {
    const base = result.positions.length / 3;
    result.positions.push(...mesh.positions);
    result.normals.push(...mesh.normals);
    result.indices.push(...mesh.indices.map((index) => index + base));
  }
  return result;
}

/** A part's mesh, in the part's own frame, with the parts welded to it. */
export function partMesh(part: string, rig: Rig = R15_RIG): PartMesh {
  const size = rig.parts[part];
  const shape = rig.shapes?.[part];
  const own = shape === undefined
    ? roundedBox(size, edgeRadius(part, size))
    : shapeMesh(shape, size, modelEdgeRadius(size));
  const offset = rig.drawOffsets?.[part];
  if (offset) own.positions = own.positions.map((value, index) => value + offset[index % 3]);
  const attached = rig.attached?.[part] ?? [];
  if (attached.length === 0) return own;
  const hidden = !drawnParts(rig).includes(part) && !heldParts(rig).includes(part);
  return merged([
    ...(hidden ? [] : [own]),
    ...attached.map((piece) => placed(shapeMesh(piece.shape, piece.size, modelEdgeRadius(piece.size)), piece.offset)),
  ]);
}
