// A rig read from a model in Studio: the plugin reads the model's joints and
// parts (a ModelRigReading), and this checks the reading and describes it as a
// Rig, which the compiler, the checks and the previews take like R15 and R6
// (docs/creature-plan.md, "Rigs read from Studio").
//
// The reading is the truth about the joints the Animator will drive. What
// geometry cannot say, such as which parts are feet or how far a joint may
// turn, comes only from the model's RoqerRig declarations
// (rig-declarations.ts); without them a rig can still be animated with
// `rotation`, and each check that needs them says it could not run.

import { drawnParts } from './box-rig.js';
import { frameFromComponents, multiply, poseRig, pointToWorld, type Frame } from './motion.js';
import { R15_RIG } from './r15-rig.js';
import { declareRig } from './rig-declarations.js';
import type { PartShape, Rig, RigAttachment, RigJoint, RigJointLimit, Rotation, Vec3 } from './rig.js';

/** The most joints a rig may have: a bound of Roqer's for summaries and previews, not the engine's. */
export const MAX_RIG_JOINTS = 64;
/** The most parts a rig reading may list. */
export const MAX_RIG_PARTS = 128;
/** The most welded parts a reading may list for the previews to draw. */
export const MAX_WELDED_PARTS = 256;

const SHAPES: readonly PartShape[] = ['Block', 'Wedge', 'Cylinder', 'Ball'];

export interface ModelRigPart {
  name: string;
  /** Studs, x, y and z. */
  size: [number, number, number];
  /** How it is drawn; a block when absent. */
  shape?: PartShape;
  /** A MeshPart's MeshId, which the previews draw it with once the mesh is read. */
  mesh?: string;
  /** Not drawn: fully transparent, as a HumanoidRootPart is. */
  hidden?: boolean;
}

/** A visible part no joint moves, welded to one that is, directly or through other welded parts. */
export interface ModelRigWeldedPart {
  name: string;
  /** The rig part it moves with. */
  to: string;
  /** Its CFrame in that part's frame, as CFrame components. */
  offset: number[];
  size: [number, number, number];
  shape?: PartShape;
  /** A MeshPart's MeshId. */
  mesh?: string;
}

export interface ModelRigJoint {
  /** The Motor6D's or AnimationConstraint's name. */
  name: string;
  /** The part it hangs from: Part0, or Attachment0's parent. */
  part0: string;
  /** The part it moves: Part1, or Attachment1's parent. */
  part1: string;
  /** C0 as CFrame components: the joint's frame in part0 (Attachment0.CFrame on a constraint). */
  c0: number[];
  /** C1 as CFrame components: the joint's frame in part1 (Attachment1.CFrame on a constraint). */
  c1: number[];
}

/** What the plugin reads from a rigged model. */
export interface ModelRigReading {
  /** The model's path, which names the rig. */
  path: string;
  /** A digest of the joints, parts and declarations as read, which a build compares. */
  revision: string;
  /** The part every joint hangs from: the Humanoid's root part, or the model's. */
  rootPart: string;
  controller: 'Humanoid' | 'AnimationController';
  /** A Humanoid's HipHeight. */
  hipHeight?: number;
  /** The root part and every part a joint moves. */
  parts: ModelRigPart[];
  joints: ModelRigJoint[];
  /** The model's RoqerRig attribute, as its JSON text, when it has one. */
  declarations?: string;
  /** The visible parts welded to the rig's parts, which the previews draw with them. */
  welded?: ModelRigWeldedPart[];
  /** How many more welded parts there were than a reading lists, the smallest left out. */
  weldedLeftOut?: number;
}

export type ModelRigResult = { ok: true; rig: Rig; notes: string[] } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 100;

/** A MeshId as a reading carries it: absent, or a string of at most 200 characters. */
const isMeshId = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && value !== '' && value.length <= 200);

function numbers(value: unknown, count: number): number[] | undefined {
  return Array.isArray(value) && value.length === count && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? value as number[]
    : undefined;
}

/** A rotation's columns are unit length and square to each other, as a CFrame's are. */
function orthonormal(r: readonly number[]): boolean {
  const column = (index: number) => [r[index], r[index + 3], r[index + 6]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [x, y, z] = [column(0), column(1), column(2)];
  return [dot(x, x), dot(y, y), dot(z, z)].every((length) => Math.abs(length - 1) < 1e-3)
    && [dot(x, y), dot(y, z), dot(z, x)].every((cross) => Math.abs(cross) < 1e-3);
}

function isIdentity(r: readonly number[]): boolean {
  return r.every((value, index) => Math.abs(value - (index % 4 === 0 ? 1 : 0)) < 1e-9);
}

/**
 * The lowest and highest point at rest, in the root part's frame, of some
 * parts' boxes and of the boxes of the parts welded to them.
 */
function restBounds(rig: Rig, parts: readonly string[]): { low: number; high: number } {
  const posed = poseRig(new Map(), 0, rig).parts;
  const boxes: { frame: Frame; size: Vec3 }[] = [];
  const drawn = new Set(parts);
  for (const [part, frame] of posed) {
    if (drawn.has(part)) boxes.push({ frame, size: rig.parts[part] });
    for (const piece of rig.attached?.[part] ?? []) boxes.push({ frame: multiply(frame, frameFromComponents(piece.offset)), size: piece.size });
  }
  let low = Infinity;
  let high = -Infinity;
  for (const { frame, size } of boxes) {
    const [x, y, z] = size.map((value) => value / 2);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const point = pointToWorld(frame, [sx * x, sy * y, sz * z]);
      low = Math.min(low, point[1]);
      high = Math.max(high, point[1]);
    }
  }
  return { low, high };
}

/** R15's height at rest, from the ground to the top of its head: what a body's height is scaled against. */
export const R15_REST_HEIGHT = (() => {
  const { high } = restBounds(R15_RIG, drawnParts(R15_RIG));
  return high - R15_RIG.ground;
})();

/**
 * Checks a reading and describes it as a Rig. Refuses, with every problem at
 * once, a reading whose joints do not form one tree from the root part, whose
 * names repeat, or that is too large to preview.
 */
export function rigFromModel(input: unknown): ModelRigResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['the rig reading must be an object'] };
  const reading = input as Partial<ModelRigReading>;
  if (!isName(reading.path)) errors.push('path: must name the model');
  if (typeof reading.revision !== 'string' || reading.revision === '') errors.push('revision: must be the reading\'s revision');
  if (reading.controller !== 'Humanoid' && reading.controller !== 'AnimationController') {
    errors.push('controller: the model needs a Humanoid or an AnimationController to play animations');
  }
  if (reading.hipHeight !== undefined && (typeof reading.hipHeight !== 'number' || !Number.isFinite(reading.hipHeight))) {
    errors.push('hipHeight: must be a number');
  }
  if (reading.declarations !== undefined && typeof reading.declarations !== 'string') {
    errors.push('declarations: must be the RoqerRig attribute\'s text');
  }

  // Parts, each named once.
  const sizes = new Map<string, Vec3>();
  const shapes = new Map<string, PartShape>();
  const meshIds = new Map<string, string>();
  const hidden: string[] = [];
  const partList = Array.isArray(reading.parts) ? reading.parts : [];
  if (!Array.isArray(reading.parts)) errors.push('parts: must be a list');
  if (partList.length > MAX_RIG_PARTS) errors.push(`parts: a rig may have at most ${MAX_RIG_PARTS} parts; this one has ${partList.length}`);
  const repeatedParts = new Set<string>();
  for (const part of partList.slice(0, MAX_RIG_PARTS)) {
    const size = isRecord(part) ? numbers(part.size, 3) : undefined;
    if (!isRecord(part) || !isName(part.name) || !size || size.some((value) => value <= 0)) {
      errors.push(`parts: ${isRecord(part) && isName(part.name) ? part.name : 'an entry'} must have a name and a positive size`);
      continue;
    }
    if (part.shape !== undefined && !SHAPES.includes(part.shape as PartShape)) {
      errors.push(`parts: ${part.name}'s shape must be one of ${SHAPES.join(', ')}`);
    }
    if (!isMeshId(part.mesh)) errors.push(`parts: ${part.name}'s mesh must be its MeshId`);
    else if (part.mesh !== undefined) meshIds.set(part.name, part.mesh);
    if (sizes.has(part.name)) repeatedParts.add(part.name);
    sizes.set(part.name, [size[0], size[1], size[2]]);
    shapes.set(part.name, SHAPES.includes(part.shape as PartShape) ? part.shape as PartShape : 'Block');
    if (part.hidden === true) hidden.push(part.name);
  }
  if (repeatedParts.size > 0) {
    errors.push(`parts: a keyframe's poses find their parts by name, so each must be named once; these repeat: ${[...repeatedParts].join(', ')}`);
  }
  const root = reading.rootPart;
  if (!isName(root) || !sizes.has(root)) errors.push('rootPart: must be one of the parts');

  // Joints, each moving its own part.
  const jointList = Array.isArray(reading.joints) ? reading.joints : [];
  if (!Array.isArray(reading.joints) || jointList.length === 0) {
    errors.push('joints: the model has no Motor6D or AnimationConstraint joints to animate');
  }
  if (jointList.length > MAX_RIG_JOINTS) errors.push(`joints: a rig may have at most ${MAX_RIG_JOINTS} joints; this one has ${jointList.length}`);
  const joints: RigJoint[] = [];
  const mover = new Map<string, string>();
  for (const entry of jointList.slice(0, MAX_RIG_JOINTS)) {
    if (!isRecord(entry) || !isName(entry.name) || !isName(entry.part0) || !isName(entry.part1)) {
      errors.push('joints: each must name itself and the two parts it joins');
      continue;
    }
    const where = `joint ${entry.name} (${entry.part0} to ${entry.part1})`;
    const c0 = numbers(entry.c0, 12);
    const c1 = numbers(entry.c1, 12);
    if (!c0 || !c1) {
      errors.push(`${where}: C0 and C1 must be 12 finite numbers each`);
      continue;
    }
    if (!orthonormal(c0.slice(3)) || !orthonormal(c1.slice(3))) {
      errors.push(`${where}: C0 and C1 must be rotations without scale`);
      continue;
    }
    for (const part of [entry.part0, entry.part1]) {
      if (!sizes.has(part)) errors.push(`${where}: ${part} is not one of the rig's parts`);
    }
    if (entry.part1 === root) errors.push(`${where}: nothing may move the root part, ${root}; it is where the rig hangs from`);
    if (entry.part0 === entry.part1) errors.push(`${where}: joins a part to itself`);
    const other = mover.get(entry.part1);
    if (other !== undefined) errors.push(`${where}: ${entry.part1} is already moved by ${other}; a part may have one joint`);
    mover.set(entry.part1, entry.name);
    joints.push({
      name: entry.name,
      parentPart: entry.part0,
      childPart: entry.part1,
      parentOffset: [c0[0], c0[1], c0[2]],
      childOffset: [c1[0], c1[1], c1[2]],
      ...(isIdentity(c0.slice(3)) ? {} : { parentRotation: c0.slice(3) as unknown as Rotation }),
      ...(isIdentity(c1.slice(3)) ? {} : { childRotation: c1.slice(3) as unknown as Rotation }),
    });
  }
  const attached = weldedParts(reading, sizes, errors);
  if (errors.length > 0 || !isName(root)) return { ok: false, errors };

  // Name each joint once: a joint whose name another shares, as hand-made
  // rigs often have ("Motor6D"), is named after the part it moves instead.
  const notes: string[] = [];
  const count = new Map<string, number>();
  for (const joint of joints) count.set(joint.name, (count.get(joint.name) ?? 0) + 1);
  const renamed = joints.map((joint) => (count.get(joint.name)! > 1 ? { ...joint, name: joint.childPart } : joint));
  const shared = [...count].filter(([, times]) => times > 1).map(([name]) => name);
  if (shared.length > 0) notes.push(`joints named ${shared.join(', ')} more than once are named after the part each moves`);
  const names = new Map<string, number>();
  for (const joint of renamed) names.set(joint.name, (names.get(joint.name) ?? 0) + 1);
  const clashes = [...names].filter(([, times]) => times > 1).map(([name]) => name);
  if (clashes.length > 0) {
    return { ok: false, errors: [`joints: a pose names its joint, so each must be named once; these repeat: ${clashes.join(', ')}. Rename them after the parts they move`] };
  }

  // One tree from the root: every joint reached, parents before children.
  const ordered: RigJoint[] = [];
  const reached = new Set([root]);
  const visit = (part: string) => {
    for (const joint of renamed) {
      if (joint.parentPart !== part || reached.has(joint.childPart)) continue;
      reached.add(joint.childPart);
      ordered.push(joint);
      visit(joint.childPart);
    }
  };
  visit(root);
  const stray = renamed.filter((joint) => !ordered.includes(joint));
  if (stray.length > 0) {
    return {
      ok: false,
      errors: [`joints: ${stray.map((joint) => joint.name).join(', ')} ${stray.length === 1 ? 'does' : 'do'} not hang from ${root}, directly or through other joints; a rig is one tree of joints from its root part`],
    };
  }
  const unjointed = [...sizes.keys()].filter((part) => !reached.has(part));
  if (unjointed.length > 0) notes.push(`${unjointed.join(', ')} ${unjointed.length === 1 ? 'is' : 'are'} not moved by any joint and not drawn`);
  const loose = [...attached.keys()].filter((part) => !reached.has(part));
  if (loose.length > 0) {
    return { ok: false, errors: [`welded: parts are welded to ${loose.join(', ')}, which no joint moves; a welded part must move with a part of the rig`] };
  }
  const leftOut = typeof reading.weldedLeftOut === 'number' && reading.weldedLeftOut > 0 ? Math.floor(reading.weldedLeftOut) : 0;
  if (leftOut > 0) notes.push(`${leftOut} more welded part${leftOut === 1 ? ' is' : 's are'} not drawn: a preview draws the ${MAX_WELDED_PARTS} largest`);

  // The joint that moves the whole body: the root part's only joint.
  const fromRoot = ordered.filter((joint) => joint.parentPart === root);
  const rootJoint = fromRoot.length === 1 ? fromRoot[0].name : undefined;
  const parts = Object.fromEntries([...sizes].filter(([part]) => reached.has(part)));
  const limits: Record<string, RigJointLimit> = rootJoint ? { [rootJoint]: 'free' } : {};
  const draft: Rig = {
    name: reading.path!,
    revision: reading.revision!,
    rootPart: root,
    ...(rootJoint ? { rootJoint } : {}),
    hipHeight: reading.hipHeight ?? 0,
    ground: 0,
    feet: [],
    body: rootJoint ? fromRoot[0].childPart : root,
    limbs: {},
    hinges: {},
    limits,
    hidden: hidden.filter((part) => reached.has(part)),
    shapes: Object.fromEntries(Object.keys(parts).map((part) => [part, shapes.get(part)!])),
    ...([...meshIds.keys()].some((part) => reached.has(part))
      ? { meshIds: Object.fromEntries([...meshIds].filter(([part]) => reached.has(part))) }
      : {}),
    ...(attached.size > 0 ? { attached: Object.fromEntries(attached) } : {}),
    parts,
    joints: ordered,
  };

  // A pose is written in the body's axes at rest: each joint frame's
  // orientation there, where its parent part does not rest upright.
  const rest = poseRig(new Map(), 0, draft).parts;
  const withAxes = ordered.map((joint) => {
    const parent = rest.get(joint.parentPart)!;
    if (isIdentity(parent.r)) return joint;
    const frame: Frame = multiply(parent, { p: [0, 0, 0], r: [...(joint.parentRotation ?? [1, 0, 0, 0, 1, 0, 0, 0, 1])] as Frame['r'] });
    return { ...joint, restRotation: frame.r as unknown as Rotation };
  });
  let rig: Rig = { ...draft, joints: withAxes };
  if (reading.declarations !== undefined) {
    const declared = declareRig(rig, reading.declarations);
    if (!declared.ok) return declared;
    rig = declared.rig;
  }

  // Where the ground is: under the lowest drawn part at rest.
  const drawn = drawnParts(rig);
  const { low, high } = restBounds(rig, drawn.length > 0 ? drawn : Object.keys(parts));
  rig = { ...rig, ground: low };
  return { ok: true, rig: { ...rig, scale: bodyScale(rig, high - low) }, notes };
}

/** The welded parts a reading lists, by the rig part each moves with. */
function weldedParts(reading: Partial<ModelRigReading>, sizes: ReadonlyMap<string, Vec3>, errors: string[]): Map<string, RigAttachment[]> {
  const attached = new Map<string, RigAttachment[]>();
  if (reading.welded === undefined) return attached;
  if (!Array.isArray(reading.welded)) {
    errors.push('welded: must be a list');
    return attached;
  }
  if (reading.welded.length > MAX_WELDED_PARTS) {
    errors.push(`welded: a reading lists at most ${MAX_WELDED_PARTS} welded parts; this one lists ${reading.welded.length}`);
    return attached;
  }
  for (const entry of reading.welded) {
    const name = isRecord(entry) && isName(entry.name) ? entry.name : 'an entry';
    const offset = isRecord(entry) ? numbers(entry.offset, 12) : undefined;
    const size = isRecord(entry) ? numbers(entry.size, 3) : undefined;
    if (!isRecord(entry) || !isName(entry.name) || !isName(entry.to) || !offset || !orthonormal(offset.slice(3)) || !size || size.some((value) => value <= 0)) {
      errors.push(`welded: ${name} must name itself and the part it moves with, with its offset as a CFrame's 12 components and a positive size`);
      continue;
    }
    if (entry.shape !== undefined && !SHAPES.includes(entry.shape as PartShape)) {
      errors.push(`welded: ${name}'s shape must be one of ${SHAPES.join(', ')}`);
      continue;
    }
    if (!isMeshId(entry.mesh)) {
      errors.push(`welded: ${name}'s mesh must be its MeshId`);
      continue;
    }
    if (!sizes.has(entry.to)) {
      errors.push(`welded: ${name} is welded to ${entry.to}, which is not one of the rig's parts`);
      continue;
    }
    const pieces = attached.get(entry.to) ?? [];
    pieces.push({
      part: entry.name,
      offset,
      size: [size[0], size[1], size[2]],
      shape: (entry.shape as PartShape | undefined) ?? 'Block',
      ...(entry.mesh === undefined ? {} : { mesh: entry.mesh }),
    });
    attached.set(entry.to, pieces);
  }
  return attached;
}

/**
 * How much bigger than R15 a body is, for its distance limits: how high the
 * roots of the limbs that stand on its feet are above the ground at rest,
 * over R15's hips' 2.19 studs; or, with no legs declared, its height at rest
 * over R15's.
 */
function bodyScale(rig: Rig, height: number): NonNullable<Rig['scale']> {
  const feet = new Set(rig.feet);
  const rest = poseRig(new Map(), 0, rig).parts;
  const hips = Object.entries(rig.limbs)
    .filter(([name, limb]) => {
      const root = rig.joints.find((joint) => joint.name === name)!;
      const last = limb.hinge ? rig.joints.find((joint) => joint.name === limb.hinge)!.childPart : root.childPart;
      const foot = limb.foot ? rig.joints.find((joint) => joint.name === limb.foot)!.childPart : undefined;
      return feet.has(last) || (foot !== undefined && feet.has(foot));
    })
    .map(([name]) => {
      const root = rig.joints.find((joint) => joint.name === name)!;
      return pointToWorld(rest.get(root.parentPart)!, root.parentOffset)[1] - rig.ground;
    })
    .filter((above) => above > 0);
  if (hips.length > 0) {
    const mean = hips.reduce((sum, above) => sum + above, 0) / hips.length;
    return { factor: mean / R15_RIG.hipHeight, basis: 'its hips\' height at rest' };
  }
  return { factor: height / R15_REST_HEIGHT, basis: 'its height at rest' };
}
