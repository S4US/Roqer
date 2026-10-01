// `rig`'s build form: joining a model's pieces into a rig at the pivots the
// call gives (docs/creature-plan.md, "Building a rig"). The plugin reads the
// model's pieces (a PiecesReading); this checks the whole call against it and
// works out every change, which the plugin then makes in one undo step while
// the model is as it was read. Nothing here reaches Studio.
//
// A rig it builds hangs from an invisible HumanoidRootPart, and every joint's
// frame lines up with that root's axes at its pivot, so a pose's rotation is
// in the body's own axes with no conversion.

import { mergeDeclarations, planDeclarations, type BodyPlan, BODY_PLANS } from './body-plans.js';
import { limbReach } from './limb-reach.js';
import { frameFromComponents, multiply, pointToWorld, type Frame } from './motion.js';
import { MAX_RIG_JOINTS, rigFromModel, type ModelRigReading } from './model-rig.js';
import type { PartShape, Vec3 } from './rig.js';

/** The most parts a model `rig` builds on may have: Roqer's bound, so a reading stays small. */
export const MAX_PIECE_PARTS = 512;
/** How far outside a part's box a joint's pivot may lie and still join it, in studs. */
export const PIVOT_SLACK = 0.1;
/** The root `rig` makes, when the joints hang from none. */
export const ROOT_PART = 'HumanoidRootPart';
export const ROOT_JOINT = 'Root';

/** One BasePart in the model, as the plugin reads it. Names may repeat; indices do not. */
export interface PiecePart {
  name: string;
  /** Its CFrame in the world, as CFrame components. */
  cframe: number[];
  size: [number, number, number];
  shape?: PartShape;
  mesh?: string;
  hidden?: boolean;
  /** A root an earlier `rig` made, which a rebuild takes again. */
  madeRoot?: boolean;
}

/** A Motor6D or AnimationConstraint, or a weld, between two of the model's parts, by index. */
export interface PieceLink {
  name?: string;
  part0: number;
  part1: number;
  /** A weld an earlier `rig` made for a joint's `with`, which a rebuild takes out. */
  made?: boolean;
}

/**
 * What an importer left on a model: a rig, every piece hung from one part at
 * its own centre; or, on a skinned mesh, which needs no joints, only its
 * AnimationController and InitialPoses, with no root part.
 */
export interface ImporterRig {
  rootPart?: number;
  joints: number;
  initialPoses: number;
}

/** A skinned mesh's Bone, as the plugin reads it: a joint the model already has, which `rig` leaves as it is. */
export interface PieceBone {
  name: string;
  /** The bone or part it is in, by name. */
  parent: string;
  /** The part it is in, directly or through other bones, by index. */
  part: number;
  /** Its CFrame in its parent, as CFrame components. */
  cframe: number[];
}

/** The least a skinned creature's root measures along each axis, in studs, where its mesh allows. */
const MIN_SKINNED_ROOT = 1;
/** How far below its lowest top bone a bone may lie and still be of the body the root covers: a hip under a spine. */
const SKINNED_BODY_SLACK = 0.6;
/** The size a bone is read with, as the plugin's rig reading gives one. */
const BONE_SIZE: [number, number, number] = [0.1, 0.1, 0.1];

/** What the plugin reads from a model `rig` builds on. */
export interface PiecesReading {
  path: string;
  /** A digest of everything here, which the write compares. */
  revision: string;
  /** The model's pivot, whose heading the rig takes. */
  pivot: number[];
  parts: PiecePart[];
  /** Its Motor6Ds and AnimationConstraints between its own parts. */
  joints: PieceLink[];
  welds: PieceLink[];
  /** Its skinned meshes' Bones, parents before children. */
  bones?: PieceBone[];
  /** The Humanoids and AnimationControllers directly in it. */
  controllers: ('Humanoid' | 'AnimationController')[];
  importer?: ImporterRig;
  /**
   * Where the origin the model was made about now is, as CFrame components in
   * the world: kept by an earlier `rig`, from the importer's root or the
   * model's pivot, so a rebuild can still take pivots measured from it.
   */
  origin?: number[];
  /** When it has joints: the revision its rig reads with, and the one `rig` stamped when it built it. */
  rig?: { revision: string; builtRevision?: string };
  declarations?: string;
}

/** A joint as the call gives it: the piece it moves, the piece it hangs from, and where it turns. */
export interface RigBuildJoint {
  part: string;
  parent: string;
  pivot: Vec3;
  name?: string;
  /** Other parts that move with the piece, welded to it. */
  with?: string[];
}

export interface RigBuildRequest {
  joints: RigBuildJoint[];
  controller: 'Humanoid' | 'AnimationController';
  plan: BodyPlan;
  declarations?: Record<string, unknown>;
  replaceImporter: boolean;
  /**
   * What the joints' pivots are measured in: the world, or `import`, the
   * frame an upload was modelled in (Roblox's axes from the importer's root,
   * or from the model's pivot when it arrived without a rig), as the Blender
   * inspection gives them. Defaults to the world.
   */
  pivotSpace?: 'world' | 'import';
  expectedRevision?: string;
}

/** Every change the plugin makes, by part name, each name one part. */
export interface RigBuildPlan {
  model: string;
  revision: string;
  /** Take the importer's rig out first: its joints, its root part, its InitialPoses and its controller. */
  replaceImporter: boolean;
  /** Take the rig an earlier `rig` built out first: its joints and the welds it made. */
  rebuild: boolean;
  root: { name: string; make?: { cframe: number[]; size: number[] } };
  rootAnchored: boolean;
  joints: { name: string; part0: string; part1: string; c0: number[]; c1: number[] }[];
  welds: { part0: string; part1: string }[];
  controller: { className: 'Humanoid' | 'AnimationController'; hipHeight?: number };
  declarations: string;
  /** The model's origin in the world, to keep on the model for a rebuild; absent on a rig that kept none. */
  origin?: number[];
}

export type RigBuildResult =
  | { ok: true; plan: RigBuildPlan; expected: ModelRigReading; notes: string[] }
  | { ok: false; errors: string[]; errorCode: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 100;
const round = (value: number) => Math.round(value * 1e6) / 1e6 + 0;

function inverse(frame: Frame): Frame {
  const r = frame.r;
  const t: Frame['r'] = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
  const p = frame.p;
  return {
    p: [-(t[0] * p[0] + t[1] * p[1] + t[2] * p[2]), -(t[3] * p[0] + t[4] * p[1] + t[5] * p[2]), -(t[6] * p[0] + t[7] * p[1] + t[8] * p[2])],
    r: t,
  };
}

const components = (frame: Frame) => [...frame.p, ...frame.r].map(round);

/** The model's heading: its pivot turned about the vertical only, so the rig stands upright. */
function heading(pivot: readonly number[]): Frame['r'] {
  const back = [pivot[5], 0, pivot[11]];
  const size = Math.hypot(back[0], back[2]);
  if (size < 1e-6) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [bx, bz] = [back[0] / size, back[2] / size];
  return [bz, 0, bx, 0, 1, 0, -bx, 0, bz];
}

function corners(frame: Frame, size: readonly number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(pointToWorld(frame, [(sx * size[0]) / 2, (sy * size[1]) / 2, (sz * size[2]) / 2]));
  }
  return out;
}

/** Whether a point lies in a part's box, or within PIVOT_SLACK of it. */
function touches(frame: Frame, size: readonly number[], point: Vec3): boolean {
  const local = pointToWorld(inverse(frame), point);
  return local.every((value, axis) => Math.abs(value) <= size[axis] / 2 + PIVOT_SLACK);
}

function vector(value: unknown): Vec3 | undefined {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? [value[0], value[1], value[2]]
    : undefined;
}

/** A tool call's joints, checked for shape only. */
export function parseBuildJoints(value: unknown): { ok: true; joints: RigBuildJoint[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, errors: ['joints must list each joint: { part, parent, pivot: [x, y, z], name?, with? }'] };
  if (value.length > MAX_RIG_JOINTS) return { ok: false, errors: [`joints: a rig has at most ${MAX_RIG_JOINTS} joints, its root's included; this lists ${value.length}`] };
  const errors: string[] = [];
  const joints: RigBuildJoint[] = [];
  value.forEach((entry, index) => {
    const where = `joints[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${where}: must be { part, parent, pivot: [x, y, z], name?, with? }`);
      return;
    }
    const unknown = Object.keys(entry).filter((key) => !['part', 'parent', 'pivot', 'name', 'with'].includes(key));
    if (unknown.length > 0) errors.push(`${where}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not part of a joint; give part, parent, pivot, name or with`);
    const pivot = vector(entry.pivot);
    if (!isName(entry.part)) errors.push(`${where}.part: must name the piece the joint moves`);
    if (!isName(entry.parent)) errors.push(`${where}.parent: must name the piece it hangs from`);
    if (!pivot) errors.push(`${where}.pivot: must be [x, y, z] in the world, where the piece turns`);
    if (entry.name !== undefined && !isName(entry.name)) errors.push(`${where}.name: must be the joint's name, 1 to 100 characters`);
    const withParts = entry.with;
    if (withParts !== undefined && (!Array.isArray(withParts) || withParts.length === 0 || !withParts.every(isName))) {
      errors.push(`${where}.with: must list the names of parts that move with ${isName(entry.part) ? entry.part : 'the piece'}`);
    }
    if (isName(entry.part) && isName(entry.parent) && pivot) {
      joints.push({
        part: entry.part,
        parent: entry.parent,
        pivot,
        ...(isName(entry.name) ? { name: entry.name } : {}),
        ...(Array.isArray(withParts) && withParts.every(isName) ? { with: withParts as string[] } : {}),
      });
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, joints };
}

export function isBodyPlan(value: unknown): value is BodyPlan {
  return typeof value === 'string' && (BODY_PLANS as readonly string[]).includes(value);
}

/**
 * Checks a build against the model as read, and works out everything the
 * plugin changes. Refuses, with every problem at once, joints that are not one
 * tree of uniquely named pieces, a pivot that lies in neither piece it joins,
 * a part the rig would leave loose or a weld that would hold a joint still,
 * and a rig on the model that this call may not replace.
 */
export function planRigBuild(reading: PiecesReading, request: RigBuildRequest): RigBuildResult {
  const refuse = (errorCode: string, errors: string[]): RigBuildResult => ({ ok: false, errors, errorCode });

  // What is on the model already, and whether this call may replace it.
  const importer = reading.importer;
  let rebuild = false;
  if (importer) {
    if (!request.replaceImporter) {
      return refuse('importer_rig', [
        importer.rootPart === undefined
          ? `${reading.path} has what an importer left on a skinned mesh: an AnimationController and its InitialPoses. Pass replace: "importer" to take them out and build this rig in their place`
          : `${reading.path} has an importer's rig: ${importer.joints} Motor6D${importer.joints === 1 ? '' : 's'} from ${reading.parts[importer.rootPart]?.name ?? 'its root'}, each turning a piece about its own centre. Pass replace: "importer" to take it out and build this rig in its place`,
      ]);
    }
  } else if (request.replaceImporter && reading.joints.length > 0) {
    // An upload can arrive with no rig at all, and replace then has nothing to
    // take out; joints that are not an importer's are another matter.
    return refuse('no_importer_rig', [`${reading.path}'s ${reading.joints.length} joint${reading.joints.length === 1 ? ' is' : 's are'} not an importer's rig, so replace: "importer" does not cover ${reading.joints.length === 1 ? 'it' : 'them'}; leave replace out`]);
  } else if (reading.joints.length > 0) {
    const current = reading.rig;
    if (!current?.builtRevision) {
      return refuse('rig_not_built_here', [`${reading.path} already has ${reading.joints.length} joint${reading.joints.length === 1 ? '' : 's'} that rig did not build, so it leaves them alone. To declare what they are, call rig with model and plan or declarations and no joints`]);
    }
    if (current.builtRevision !== current.revision) {
      return refuse('rig_edited_since_build', [`${reading.path}'s rig has changed since rig built it, so rig leaves it alone`]);
    }
    if (request.expectedRevision === undefined) {
      return refuse('revision_required', [`${reading.path} already has the rig rig built, revision ${current.revision}. Pass it as expected_revision to replace it`]);
    }
    if (request.expectedRevision !== current.revision) {
      return refuse('revision_conflict', [`${reading.path}'s rig is revision ${current.revision}, not ${request.expectedRevision}; read it again before replacing it`]);
    }
    rebuild = true;
  }
  if (!rebuild && request.expectedRevision !== undefined && !importer && reading.joints.length === 0) {
    return refuse('revision_conflict', [`${reading.path} has no rig, so there is no revision ${request.expectedRevision} to replace`]);
  }

  const errors: string[] = [];
  const removed = new Set<number>(importer?.rootPart !== undefined ? [importer.rootPart] : []);
  const byName = new Map<string, number[]>();
  reading.parts.forEach((part, index) => {
    if (removed.has(index)) return;
    byName.set(part.name, [...(byName.get(part.name) ?? []), index]);
  });
  const find = (name: string, what: string): number | undefined => {
    const found = byName.get(name) ?? [];
    if (found.length === 0) errors.push(`${what}: ${reading.path} has no part named ${name}`);
    else if (found.length > 1) errors.push(`${what}: ${reading.path} has ${found.length} parts named ${name}; a keyframe's poses find their parts by name, so rename them apart`);
    return found.length === 1 ? found[0] : undefined;
  };
  const frameOf = (index: number) => frameFromComponents(reading.parts[index].cframe);

  // Where an upload was modelled about: the importer's root, or what an
  // earlier rig kept of it, or, on a model with no joints yet, its own pivot,
  // which an upload that arrives without a rig has at that origin. Pivots
  // given in the import's frame are placed by it.
  const origin = importer?.rootPart !== undefined
    ? reading.parts[importer.rootPart]?.cframe
    : reading.origin ?? (reading.joints.length === 0 ? reading.pivot : undefined);
  if (request.pivotSpace === 'import' && !origin) {
    return refuse('no_import_origin', [`${reading.path} has a rig that kept no origin, so pivots cannot be measured from an import's origin; give them in the world and leave pivot_space out`]);
  }
  const placed = request.pivotSpace === 'import' && origin
    ? request.joints.map((joint) => ({ ...joint, pivot: pointToWorld(frameFromComponents(origin), joint.pivot) as Vec3 }))
    : request.joints;

  // The tree: each piece moved by one joint, all hanging from one root.
  const joints = placed;
  const children = new Map<string, number>();
  const jointNames = new Map<string, number>();
  const tops = new Set<string>();
  joints.forEach((joint, index) => {
    const where = `joints[${index}] (${joint.part})`;
    if (joint.part === joint.parent) errors.push(`${where}: joins ${joint.part} to itself`);
    if (children.has(joint.part)) errors.push(`${where}: ${joint.part} is already moved by joints[${children.get(joint.part)}]; a piece has one joint`);
    children.set(joint.part, index);
    const name = joint.name ?? joint.part;
    if (jointNames.has(name)) errors.push(`${where}: another joint is named ${name}; a pose names its joint, so each is named once`);
    jointNames.set(name, index);
  });
  for (const joint of joints) if (!children.has(joint.parent)) tops.add(joint.parent);
  // A skinned mesh's bones are its joints already: with none given, the rig
  // hangs from the one part that holds them.
  const bones = reading.bones ?? [];
  if (joints.length === 0) {
    const holders = [...new Set(bones.map((bone) => bone.part))].filter((index) => !removed.has(index));
    if (holders.length === 0) {
      return refuse('invalid_arguments', [`${reading.path} has no Bones, so its rig is the joints the call gives: joints must list each joint as { part, parent, pivot: [x, y, z], name?, with? }`]);
    }
    if (holders.length > 1) {
      return refuse('invalid_rig', [`${reading.path}'s Bones are in ${holders.length} parts (${holders.map((index) => reading.parts[index].name).join(', ')}); give the joints that join those parts, or skin one mesh to the whole armature`]);
    }
    tops.add(reading.parts[holders[0]].name);
  }
  if (tops.size !== 1) {
    errors.push(tops.size === 0
      ? 'joints: every piece is moved by a joint, so nothing is left for the rig to hang from; they must form a tree from one piece'
      : `joints: they hang from ${tops.size} pieces that no joint moves (${[...tops].join(', ')}); a rig is one tree from one piece`);
  }
  // A cycle: a piece that is its own ancestor.
  for (const joint of joints) {
    const seen = new Set<string>();
    let at: string | undefined = joint.part;
    while (at !== undefined && children.has(at)) {
      if (seen.has(at)) {
        errors.push(`joints: ${joint.part} hangs from itself through ${[...seen].join(', ')}; a rig is a tree`);
        break;
      }
      seen.add(at);
      at = joints[children.get(at)!].parent;
    }
  }
  if (errors.length > 0) return refuse('invalid_rig', errors);

  const top = [...tops][0];
  const makeRoot = top !== ROOT_PART;
  if (makeRoot && jointNames.has(ROOT_JOINT)) errors.push(`joints: ${ROOT_JOINT} is the joint rig makes from ${ROOT_PART} to ${top}; name the other joint apart`);
  if (makeRoot && (joints.length + 1) > MAX_RIG_JOINTS) errors.push(`joints: a rig has at most ${MAX_RIG_JOINTS} joints, and rig adds ${ROOT_JOINT} to these ${joints.length}`);

  // Resolve every piece, each name one part.
  const indexOf = new Map<string, number>();
  for (const name of new Set([...joints.map((joint) => joint.part), top])) {
    if (name === ROOT_PART && makeRoot) continue;
    const found = find(name, `the piece ${name}`);
    if (found !== undefined) indexOf.set(name, found);
  }
  // A root an earlier rig made is taken again; any other part of that name is in the way.
  const madeRoot = makeRoot ? byName.get(ROOT_PART) : undefined;
  if (makeRoot && madeRoot && madeRoot.length > 0) {
    if (madeRoot.length > 1 || !reading.parts[madeRoot[0]].madeRoot || !rebuild) {
      errors.push(`${reading.path} has a part named ${ROOT_PART} that is not in the joints; hang the rig from it (make it the parent of ${top}), or rename it`);
    }
  }
  const welds: { part0: string; part1: string }[] = [];
  const weldedTo = new Map<number, string>();
  joints.forEach((joint) => {
    for (const extra of joint.with ?? []) {
      const found = find(extra, `${joint.part}'s with`);
      if (found === undefined) continue;
      if (indexOf.has(extra) || extra === ROOT_PART) errors.push(`${joint.part}'s with: ${extra} is a piece of the rig; a joint moves it, not a weld`);
      else if (weldedTo.has(found)) errors.push(`${joint.part}'s with: ${extra} is already welded to ${weldedTo.get(found)}`);
      else {
        weldedTo.set(found, joint.part);
        welds.push({ part0: joint.part, part1: extra });
      }
    }
  });
  if (errors.length > 0) return refuse('invalid_rig', errors);

  // The root: its heading is the model's, and it covers the piece it holds.
  const turn = heading(reading.pivot);
  const axes: Frame = { p: [0, 0, 0], r: turn };
  const topIndex = makeRoot ? indexOf.get(top)! : indexOf.get(ROOT_PART)!;
  let rootFrame: Frame;
  let rootSize: [number, number, number];
  if (makeRoot) {
    const local = corners(frameOf(topIndex), reading.parts[topIndex].size).map((point) => pointToWorld(inverse(axes), point));
    const low = [0, 1, 2].map((axis) => Math.min(...local.map((point) => point[axis])));
    const high = [0, 1, 2].map((axis) => Math.max(...local.map((point) => point[axis])));
    // A skinned mesh is the whole creature, legs and all, and a root that
    // size reaches the ground, where a Humanoid cannot hold it up. Its root
    // covers its body instead: from the lowest bone that is directly in the
    // mesh up, around the bones at that height or above.
    const inTop = bones.filter((bone) => bone.part === topIndex);
    if (inTop.length > 0) {
      const world = new Map<string, Frame>();
      const points = inTop.map((bone) => {
        const parent = world.get(bone.parent) ?? frameOf(topIndex);
        const frame = multiply(parent, frameFromComponents(bone.cframe));
        world.set(bone.name, frame);
        return { top: !world.has(bone.parent), at: pointToWorld(inverse(axes), frame.p) };
      });
      const floor = Math.min(...points.filter((point) => point.top).map((point) => point.at[1]));
      const body = points.filter((point) => point.at[1] >= floor - SKINNED_BODY_SLACK).map((point) => point.at);
      for (const axis of [0, 2]) {
        const [from, to] = [Math.min(...body.map((point) => point[axis])), Math.max(...body.map((point) => point[axis]))];
        const half = Math.max(to - from, MIN_SKINNED_ROOT) / 2;
        const middle = (from + to) / 2;
        [low[axis], high[axis]] = [Math.max(low[axis], middle - half), Math.min(high[axis], middle + half)];
      }
      const bottom = Math.min(Math.max(floor, low[1]), high[1] - MIN_SKINNED_ROOT / 2);
      const top = Math.max(...body.map((point) => point[1]));
      [low[1], high[1]] = [bottom, Math.min(high[1], Math.max(top, bottom + MIN_SKINNED_ROOT))];
    }
    const middle = pointToWorld(axes, [0, 1, 2].map((axis) => (low[axis] + high[axis]) / 2) as unknown as Vec3);
    rootFrame = { p: middle, r: turn };
    rootSize = [0, 1, 2].map((axis) => round(high[axis] - low[axis])) as [number, number, number];
  } else {
    rootFrame = frameOf(topIndex);
    rootSize = reading.parts[topIndex].size;
  }
  const frames = new Map<string, Frame>([[ROOT_PART, rootFrame]]);
  for (const [name, index] of indexOf) frames.set(name, frameOf(index));
  const sizes = new Map<string, readonly number[]>([[ROOT_PART, rootSize]]);
  for (const [name, index] of indexOf) sizes.set(name, reading.parts[index].size);

  // Each joint's frame sits at its pivot, lined up with the root's axes.
  const planned: RigBuildPlan['joints'] = [];
  const addJoint = (name: string, part0: string, part1: string, pivot: Vec3) => {
    const frame: Frame = { p: [pivot[0], pivot[1], pivot[2]], r: turn };
    planned.push({
      name,
      part0,
      part1,
      c0: components(multiply(inverse(frames.get(part0)!), frame)),
      c1: components(multiply(inverse(frames.get(part1)!), frame)),
    });
  };
  if (makeRoot) addJoint(ROOT_JOINT, ROOT_PART, top, frames.get(top)!.p);
  // Parents before children, as the tree runs from the root.
  const ordered: RigBuildJoint[] = [];
  const visit = (parent: string) => {
    for (const joint of joints) {
      if (joint.parent !== parent) continue;
      ordered.push(joint);
      visit(joint.part);
    }
  };
  visit(top);
  for (const joint of ordered) {
    const outside = [joint.parent, joint.part].filter((part) => !touches(frames.get(part)!, sizes.get(part)!, joint.pivot));
    if (outside.length > 0) {
      const given = request.joints.find((candidate) => candidate.part === joint.part)!.pivot;
      const where = request.pivotSpace === 'import' ? `[${given.map(round).join(', ')}], at [${joint.pivot.map(round).join(', ')}] in the world,` : `[${joint.pivot.map(round).join(', ')}]`;
      errors.push(`${joint.name ?? joint.part}: its pivot ${where} lies outside ${outside.join(' and ')}; a joint turns where the two pieces meet, such as the top of a leg, not a piece's middle`);
      continue;
    }
    addJoint(joint.name ?? joint.part, joint.parent, joint.part, joint.pivot);
  }

  // Every other part must move with the rig: welded, directly or through
  // others, to one piece; and no weld may hold two pieces, or one of them
  // could not turn.
  const pieceIndices = new Set(indexOf.values());
  const union = new Map<number, number>();
  const findSet = (index: number): number => {
    const parent = union.get(index) ?? index;
    if (parent === index) return index;
    const rootIndex = findSet(parent);
    union.set(index, rootIndex);
    return rootIndex;
  };
  const link = (a: number, b: number) => union.set(findSet(a), findSet(b));
  for (const weld of reading.welds) {
    if (removed.has(weld.part0) || removed.has(weld.part1) || (rebuild && weld.made)) continue;
    link(weld.part0, weld.part1);
  }
  for (const weld of welds) link(indexOf.get(weld.part0)!, byName.get(weld.part1)![0]);
  const groups = new Map<number, number[]>();
  for (const piece of pieceIndices) groups.set(findSet(piece), [...(groups.get(findSet(piece)) ?? []), piece]);
  for (const held of groups.values()) {
    if (held.length > 1) {
      errors.push(`${held.map((index) => reading.parts[index].name).join(' and ')} are welded together, which would hold their joints still; remove the weld, or make one piece of them`);
    }
  }
  const loose: string[] = [];
  reading.parts.forEach((part, index) => {
    if (removed.has(index) || pieceIndices.has(index) || (makeRoot && part.madeRoot)) return;
    if (!groups.has(findSet(index))) loose.push(part.name);
  });
  if (loose.length > 0) {
    const shown = loose.slice(0, 8).join(', ');
    errors.push(`${shown}${loose.length > 8 ? `, and ${loose.length - 8} more,` : ''} would be left loose: weld each to the piece it moves with (a joint's with), or take it out of the model`);
  }
  if (errors.length > 0) return refuse('invalid_rig', errors);

  // A Humanoid holds its root's bottom this far above the ground: the lowest part's.
  let lowest = Infinity;
  reading.parts.forEach((part, index) => {
    if (removed.has(index) || (makeRoot && part.madeRoot)) return;
    for (const corner of corners(frameOf(index), part.size)) lowest = Math.min(lowest, corner[1]);
  });
  const rootBottom = Math.min(...corners(rootFrame, rootSize).map((corner) => corner[1]));
  const hipHeight = request.controller === 'Humanoid' ? round(Math.max(0, rootBottom - lowest)) : undefined;

  // The bones of the rig's pieces: joints the model has already, each from the
  // bone or part it is in to itself, which the rig reads back beside its own.
  const pieceNames = new Map([...indexOf].map(([name, index]) => [index, name]));
  const kept = bones.filter((bone) => pieceNames.has(bone.part));
  const strayBones = bones.filter((bone) => !pieceNames.has(bone.part) && !removed.has(bone.part));
  if (strayBones.length > 0) {
    const holders = [...new Set(strayBones.map((bone) => reading.parts[bone.part].name))];
    return refuse('invalid_rig', [`${holders.join(', ')} ${holders.length === 1 ? 'holds' : 'hold'} Bones but ${holders.length === 1 ? 'is' : 'are'} not a piece of the rig, so nothing would move them; make ${holders.length === 1 ? 'it' : 'each'} a piece with a joint of its own`]);
  }
  const boneJoints = kept.map((bone) => ({ name: bone.name, part0: bone.parent, part1: bone.name, c0: bone.cframe.map(round), c1: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }));


  // The rig the model will read back as, checked as any rig read from a model is.
  const partEntry = (name: string) => {
    if (name === ROOT_PART && makeRoot) return { name, size: rootSize, shape: 'Block' as PartShape, hidden: true };
    const part = reading.parts[indexOf.get(name)!];
    return { name, size: part.size, ...(part.shape ? { shape: part.shape } : {}), ...(part.mesh ? { mesh: part.mesh } : {}), ...(part.hidden ? { hidden: true } : {}) };
  };
  const undeclared: ModelRigReading = {
    path: reading.path,
    revision: 'planned',
    rootPart: ROOT_PART,
    controller: request.controller,
    ...(hipHeight !== undefined ? { hipHeight } : {}),
    parts: [
      ...[ROOT_PART, ...planned.map((joint) => joint.part1)].map(partEntry),
      ...kept.map((bone) => ({ name: bone.name, size: BONE_SIZE, shape: 'Block' as PartShape, bone: true })),
    ],
    joints: [...planned, ...boneJoints],
  };
  // Declarations: the plan's, with the call's over them.
  const declarations = declarationsFor(undeclared, request.plan, request.declarations);
  const expected: ModelRigReading = { ...undeclared, declarations };
  const checked = rigFromModel(expected);
  if (!checked.ok) return refuse('invalid_rig', checked.errors);

  const conflicting = reading.controllers.filter((kind) => kind !== request.controller);
  if (!importer && reading.controllers.length > 1) errors.push(`${reading.path} has ${reading.controllers.length} controllers; leave it one`);
  else if (!importer && conflicting.length > 0) errors.push(`${reading.path} has an ${conflicting[0]}; pass controller ${conflicting[0]}, or take it out`);
  if (errors.length > 0) return refuse('controller_conflict', errors);

  return {
    ok: true,
    plan: {
      model: reading.path,
      revision: reading.revision,
      replaceImporter: importer !== undefined,
      rebuild,
      root: makeRoot ? { name: ROOT_PART, make: { cframe: components(rootFrame), size: rootSize.map(round) } } : { name: ROOT_PART },
      // A walker's root moves; anything else stays where its game puts it.
      rootAnchored: request.controller === 'AnimationController',
      joints: planned,
      welds,
      controller: { className: request.controller, ...(hipHeight !== undefined ? { hipHeight } : {}) },
      declarations,
      ...(origin ? { origin: origin.map(round) } : {}),
    },
    expected,
    notes: checked.notes,
  };
}

/**
 * A rig's declarations: its plan's, read from its joints' names, with those
 * given laid over them. A leg modelled bent at rest straightens to stride, so
 * the plan's range for its knee is widened by as far as it straightens,
 * measured on the rig the declarations make.
 */
function declarationsFor(reading: ModelRigReading, plan: BodyPlan, given: Record<string, unknown> | undefined): string {
  const joints = reading.joints.map((joint) => ({ name: joint.name, parentPart: joint.part0, childPart: joint.part1 }));
  const first = JSON.stringify(mergeDeclarations(planDeclarations(plan, joints), given));
  const read = rigFromModel({ ...reading, declarations: first });
  // What is wrong with them is said where the rig they make is checked.
  if (!read.ok) return first;
  const slack: Record<string, number> = {};
  for (const [name, limb] of Object.entries(read.rig.limbs)) {
    const straightens = limb.hinge ? -limbReach(read.rig, name).bend : 0;
    if (limb.hinge && straightens > 0.5) slack[limb.hinge] = Math.ceil(straightens);
  }
  return Object.keys(slack).length === 0 ? first : JSON.stringify(mergeDeclarations(planDeclarations(plan, joints, slack), given));
}

export type RigAdoptResult =
  | { ok: true; declarations: string; notes: string[] }
  | { ok: false; errors: string[]; errorCode: string };

/**
 * `rig`'s adopt form: declarations for a model rigged some other way, from a
 * plan and those given, checked against its joints as read. Its joints are
 * never changed. Declarations it already has are replaced only at the
 * revision the caller read.
 */
export function planRigAdopt(
  reading: ModelRigReading,
  request: { plan: BodyPlan; declarations?: Record<string, unknown>; expectedRevision?: string },
): RigAdoptResult {
  if (reading.declarations !== undefined) {
    if (request.expectedRevision === undefined) {
      return { ok: false, errorCode: 'revision_required', errors: [`${reading.path} already declares its rig; pass its revision, ${reading.revision}, as expected_revision to replace the declarations`] };
    }
    if (request.expectedRevision !== reading.revision) {
      return { ok: false, errorCode: 'revision_conflict', errors: [`${reading.path}'s rig is revision ${reading.revision}, not ${request.expectedRevision}; read it again before replacing its declarations`] };
    }
  }
  const bare = rigFromModel({ ...reading, declarations: undefined });
  if (!bare.ok) return { ok: false, errorCode: 'invalid_rig', errors: bare.errors };
  const declarations = declarationsFor({ ...reading, declarations: undefined }, request.plan, request.declarations);
  const checked = rigFromModel({ ...reading, declarations });
  if (!checked.ok) return { ok: false, errorCode: 'invalid_declarations', errors: checked.errors };
  return { ok: true, declarations, notes: checked.notes };
}
/** How far a read-back joint frame may sit from the planned one: Studio keeps CFrames in single precision. */
const READ_BACK_TOLERANCE = 1e-3;

/**
 * How the rig Studio read back after a build differs from the one planned, if
 * it does: each joint by name, its parts and frames, the controller, its hip
 * height and the declarations.
 */
export function builtRigMismatches(expected: ModelRigReading, actual: ModelRigReading): string[] {
  const mismatches: string[] = [];
  if (actual.controller !== expected.controller) mismatches.push(`its controller is ${actual.controller}, not ${expected.controller}`);
  if (actual.rootPart !== expected.rootPart) mismatches.push(`its rig hangs from ${actual.rootPart}, not ${expected.rootPart}`);
  if (expected.hipHeight !== undefined && Math.abs((actual.hipHeight ?? 0) - expected.hipHeight) > READ_BACK_TOLERANCE) {
    mismatches.push(`its HipHeight is ${actual.hipHeight}, not ${expected.hipHeight}`);
  }
  if (actual.declarations !== expected.declarations) mismatches.push('its RoqerRig is not the declarations written');
  const found = new Map(actual.joints.map((joint) => [joint.name, joint]));
  for (const joint of expected.joints) {
    const got = found.get(joint.name);
    if (!got) {
      mismatches.push(`it has no joint ${joint.name}`);
      continue;
    }
    if (got.part0 !== joint.part0 || got.part1 !== joint.part1) mismatches.push(`${joint.name} joins ${got.part0} to ${got.part1}, not ${joint.part0} to ${joint.part1}`);
    const off = [...joint.c0.map((value, index) => Math.abs(value - got.c0[index])), ...joint.c1.map((value, index) => Math.abs(value - got.c1[index]))];
    if (Math.max(...off) > READ_BACK_TOLERANCE) mismatches.push(`${joint.name}'s C0 or C1 is not where it was put`);
    found.delete(joint.name);
  }
  if (found.size > 0) mismatches.push(`it has joints the rig does not: ${[...found.keys()].join(', ')}`);
  return mismatches;
}