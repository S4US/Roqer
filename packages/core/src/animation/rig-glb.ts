// The block rig with an animation baked in, as one self-contained GLB the
// desktop viewer can play: every part a rounded box, or its own shape on a
// model's rig, every joint a node whose rotation and translation are sampled
// from core's own sampler.
//
// Node layout, per part: a frame node, holding the part's mesh and its child
// joints; each joint node carries the joint's
// Transform on top of its frame in the parent part, C0, and holds the child
// part's frame, offset back by the joint's attachment in the child:
//   frame(parent) -> joint (offsetInParent + Transform) -> frame(child) (-offsetInChild)
// which is Roblox's parent * offsetInParent * Transform * offsetInChild^-1.
//
// Everything hangs under a root turned half a turn about Y. The viewer turns
// glTF models half a turn onto Roblox's axes, so the figure ends up facing -Z,
// as it does in Studio.

import { heldParts, meshParts, RIG_COLOR, SKIN_SLOTS, type MeshSkin } from './box-rig.js';
import { generatedRigMeshes, type RigMeshes } from './rig-meshes.js';
import { invertFrame } from './skin.js';
import {
  IDENTITY_FRAME,
  restPose,
  type Frame,
  buildTracks,
  jointChildFrameInverse,
  jointParentFrame,
  multiply,
  rotationQuaternion,
  sampleTrack,
  sequenceDuration,
  type MotionSequence,
} from './motion.js';
import { R15_RIG, type Rig, type RigJoint } from './r15-rig.js';

/** Samples a second: enough for eased motion to read smoothly. */
export const GLB_SAMPLE_RATE = 30;

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

class BinaryBuilder {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  readonly bufferViews: Record<string, unknown>[] = [];
  readonly accessors: Record<string, unknown>[] = [];

  private view(bytes: Buffer, target?: number): number {
    const padding = (4 - (this.length % 4)) % 4;
    if (padding > 0) {
      this.chunks.push(Buffer.alloc(padding));
      this.length += padding;
    }
    this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length, ...(target ? { target } : {}) });
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this.bufferViews.length - 1;
  }

  floats(values: number[], type: 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4', options: { target?: number; bounds?: boolean } = {}): number {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    const size = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : type === 'VEC4' ? 4 : 16;
    const accessor: Record<string, unknown> = {
      bufferView: this.view(bytes, options.target),
      componentType: FLOAT,
      count: values.length / size,
      type,
    };
    if (options.bounds) {
      const min = Array.from({ length: size }, (_unused, axis) => Math.min(...values.filter((_v, index) => index % size === axis)));
      const max = Array.from({ length: size }, (_unused, axis) => Math.max(...values.filter((_v, index) => index % size === axis)));
      accessor.min = min;
      accessor.max = max;
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  /** Two-byte whole numbers, as a skin's joint indices are. */
  shorts(values: number[], type: 'VEC4', target: number): number {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
    this.accessors.push({ bufferView: this.view(bytes, target), componentType: UNSIGNED_SHORT, count: values.length / 4, type });
    return this.accessors.length - 1;
  }

  /** Triangle corners, two bytes each unless a mesh has more vertices than two bytes count. */
  indices(values: number[]): number {
    const wide = values.some((value) => value > 0xffff);
    const bytes = Buffer.alloc(values.length * (wide ? 4 : 2));
    values.forEach((value, index) => (wide ? bytes.writeUInt32LE(value, index * 4) : bytes.writeUInt16LE(value, index * 2)));
    this.accessors.push({ bufferView: this.view(bytes, ELEMENT_ARRAY_BUFFER), componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, count: values.length, type: 'SCALAR' });
    return this.accessors.length - 1;
  }

  buffer(): Buffer {
    const padding = (4 - (this.length % 4)) % 4;
    return Buffer.concat([...this.chunks, Buffer.alloc(padding)]);
  }
}

function glb(json: Record<string, unknown>, binary: Buffer): Buffer {
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  const textPadding = (4 - (text.length % 4)) % 4;
  if (textPadding > 0) text = Buffer.concat([text, Buffer.alloc(textPadding, 0x20)]);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + text.length + 8 + binary.length;
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const textHeader = Buffer.alloc(8);
  textHeader.writeUInt32LE(text.length, 0);
  textHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, textHeader, text, binaryHeader, binary]);
}

/** A rigid transform as glTF writes a matrix: 16 numbers, column by column. */
function matrix(frame: Frame): number[] {
  const { p, r } = frame;
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, p[0], p[1], p[2], 1];
}

/** The sample times: GLB_SAMPLE_RATE a second across one pass, both ends included. */
export function glbSampleTimes(sequence: MotionSequence): number[] {
  const duration = sequenceDuration(sequence);
  if (duration === 0) return [0];
  const count = Math.max(1, Math.ceil(duration * GLB_SAMPLE_RATE));
  return Array.from({ length: count + 1 }, (_unused, index) => (duration * index) / count);
}

export function renderRigGlb(
  sequence: MotionSequence,
  name: string,
  rigMeshes?: RigMeshes,
  rig: Rig = R15_RIG,
): Buffer {
  const partMeshes = rigMeshes ?? generatedRigMeshes(rig);
  const tracks = buildTracks(sequence);
  // A weapon appears only in an animation that moves it.
  const joints = rig.joints.filter((joint) => !joint.optional || tracks.has(joint.childPart));
  const builder = new BinaryBuilder();

  // One material for the whole rig, and one mesh per part, each already at its
  // part's size.
  const materials: Record<string, unknown>[] = [{
    pbrMetallicRoughness: { baseColorFactor: [...RIG_COLOR.map((value) => (value / 255) ** 2.2), 1], metallicFactor: 0, roughnessFactor: 0.72 },
  }];
  const meshes: Record<string, unknown>[] = [];
  // A skinned part's mesh, to be given its skin once every bone has a node.
  const skinned: { part: string; node: number; skin: MeshSkin }[] = [];
  const meshFor = (part: string): number => {
    const mesh = partMeshes.parts.get(part);
    if (!mesh) throw new Error(`no mesh for ${part}`);
    const attributes: Record<string, number> = {
      POSITION: builder.floats(mesh.positions, 'VEC3', { target: ARRAY_BUFFER, bounds: true }),
      NORMAL: builder.floats(mesh.normals, 'VEC3', { target: ARRAY_BUFFER }),
    };
    if (mesh.skin) {
      // Joint 0 is the part itself, which takes whatever weight a vertex's bones do not.
      const joints: number[] = [];
      const weights: number[] = [];
      for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
        const slots: [number, number][] = [];
        for (let slot = 0; slot < SKIN_SLOTS; slot += 1) {
          const weight = mesh.skin.weights[vertex * SKIN_SLOTS + slot];
          const bone = mesh.skin.bones[mesh.skin.joints[vertex * SKIN_SLOTS + slot]];
          if (weight > 0 && rig.bones?.includes(bone)) slots.push([mesh.skin.joints[vertex * SKIN_SLOTS + slot] + 1, weight]);
        }
        const held = slots.reduce((sum, [, weight]) => sum + weight, 0);
        if (held < 1 - 1e-3 && slots.length < SKIN_SLOTS) slots.push([0, 1 - held]);
        // glTF wants each vertex's weights to sum to 1.
        const total = slots.reduce((sum, [, weight]) => sum + weight, 0);
        for (let slot = 0; slot < SKIN_SLOTS; slot += 1) {
          joints.push(slots[slot]?.[0] ?? 0);
          weights.push(slots[slot] ? slots[slot][1] / total : 0);
        }
      }
      attributes.JOINTS_0 = builder.shorts(joints, 'VEC4', ARRAY_BUFFER);
      attributes.WEIGHTS_0 = builder.floats(weights, 'VEC4', { target: ARRAY_BUFFER });
    }
    meshes.push({ name: part, primitives: [{ attributes, indices: builder.indices(mesh.indices), material: 0 }] });
    return meshes.length - 1;
  };

  const nodes: Record<string, unknown>[] = [];
  const jointNodes = new Map<string, number>();
  const frameNodes = new Map<string, number>();
  const drawn = new Set([...meshParts(rig), ...heldParts(rig).filter((part) => tracks.has(part))]);
  const addNode = (node: Record<string, unknown>): number => {
    nodes.push(node);
    return nodes.length - 1;
  };
  // A part's node sits at C1^-1 under its joint's node, which sits at C0 and
  // carries the Transform: child = parent * C0 * Transform * C1^-1.
  const frame = (part: string, joint?: RigJoint): number => {
    const inverse = joint ? jointChildFrameInverse(joint) : undefined;
    const index = addNode({
      name: part,
      ...(inverse ? { translation: inverse.p } : {}),
      ...(joint?.childRotation ? { rotation: rotationQuaternion(inverse!.r) } : {}),
    });
    frameNodes.set(part, index);
    const children: number[] = [];
    if (drawn.has(part)) {
      const node = addNode({ name: `${part} mesh`, mesh: meshFor(part) });
      const skin = partMeshes.parts.get(part)?.skin;
      if (skin) skinned.push({ part, node, skin });
      children.push(node);
    }
    for (const child of joints.filter((candidate) => candidate.parentPart === part)) {
      // At rest the node holds C0 with the Transform left out, so the file's
      // own pose is the rig standing, as a viewer measures it before it plays:
      // R6's joints and a weapon's grip are turned, and C0 without its turn
      // would lay the figure on its back.
      const jointIndex = addNode({
        name: child.name,
        translation: [...child.parentOffset],
        ...(child.parentRotation ? { rotation: rotationQuaternion(jointParentFrame(child).r) } : {}),
      });
      jointNodes.set(child.name, jointIndex);
      nodes[jointIndex].children = [frame(child.childPart, child)];
      children.push(jointIndex);
    }
    if (children.length > 0) nodes[index].children = children;
    return index;
  };
  const root = addNode({ name: name || 'Animation', rotation: [0, 1, 0, 0] });
  nodes[root].children = [frame(rig.rootPart)];

  // Each skinned mesh's skin: its part, then its bones, each with the
  // transform that carries the mesh at rest into the joint's own frame.
  const skins: Record<string, unknown>[] = [];
  if (skinned.length > 0) {
    const rest = restPose(rig);
    for (const { part, node, skin } of skinned) {
      const partRest = rest.get(part)!;
      const joints = [frameNodes.get(part)!];
      const inverseBind = [...matrix(IDENTITY_FRAME)];
      for (const bone of skin.bones) {
        const boneRest = rest.get(bone);
        const boneNode = frameNodes.get(bone);
        // A bone the rig lacks keeps its place in the list, standing in as the part.
        joints.push(boneRest && boneNode !== undefined ? boneNode : frameNodes.get(part)!);
        inverseBind.push(...matrix(boneRest && boneNode !== undefined ? multiply(invertFrame(boneRest), partRest) : IDENTITY_FRAME));
      }
      skins.push({ name: part, joints, inverseBindMatrices: builder.floats(inverseBind, 'MAT4') });
      nodes[node].skin = skins.length - 1;
    }
  }

  const times = glbSampleTimes(sequence);
  const input = builder.floats(times, 'SCALAR', { bounds: true });
  const samplers: Record<string, unknown>[] = [];
  const channels: Record<string, unknown>[] = [];
  for (const joint of joints) {
    const c0 = jointParentFrame(joint);
    const rotations: number[] = [];
    const translations: number[] = [];
    let previous: number[] | undefined;
    for (const time of times) {
      // The joint node carries C0 * Transform.
      const transform = multiply(c0, sampleTrack(tracks.get(joint.childPart), time));
      let q = rotationQuaternion(transform.r);
      // Keep neighbouring quaternions in one hemisphere, so the viewer turns the short way.
      if (previous && q[0] * previous[0] + q[1] * previous[1] + q[2] * previous[2] + q[3] * previous[3] < 0) {
        q = [-q[0], -q[1], -q[2], -q[3]];
      }
      previous = q;
      rotations.push(...q);
      translations.push(...transform.p);
    }
    const target = jointNodes.get(joint.name)!;
    samplers.push({ input, output: builder.floats(rotations, 'VEC4'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: target, path: 'rotation' } });
    samplers.push({ input, output: builder.floats(translations, 'VEC3'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: target, path: 'translation' } });
  }

  const binary = builder.buffer();
  return glb({
    asset: { version: '2.0', generator: 'Roqer box rig' },
    scene: 0,
    scenes: [{ nodes: [root] }],
    nodes,
    meshes,
    materials,
    ...(skins.length > 0 ? { skins } : {}),
    animations: [{ name: name || 'Animation', samplers, channels }],
    accessors: builder.accessors,
    bufferViews: builder.bufferViews,
    buffers: [{ byteLength: binary.length }],
  }, binary);
}
