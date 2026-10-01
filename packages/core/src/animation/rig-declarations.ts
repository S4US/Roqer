// What a model's geometry cannot say about its rig, declared on the model as
// the RoqerRig attribute: JSON, version 1 (docs/creature-plan.md,
// "Declarations on the model"). Every read validates it, and a declaration
// that names a joint the rig lacks, or that cannot be what it says, refuses
// the whole rig: an unknown version or a malformed value is never guessed at.
//
//   {
//     "version": 1,
//     "feet": ["FrontLeft", ...] or { "FrontLeft": [[x, y, z], ...], ... },
//     "hips": ["LeftHip", "RightHip"],
//     "limbs": { "<joint>": { "hinge"?, "end"?, "foot"?, "axis"?, "fold"? }, ... },
//     "hinges": { "<joint>": { "axis": "X" | "Y" | "Z", "flex": 1 | -1 }, ... },
//     "limits": { "<joint>": "free" | { "turn": n } | { "min": n, "max": n, "offAxis"?: n }, ... }
//   }
//
// Joints are named as the rig names them; parts as the model does. Points
// are studs in the part's own frame; directions are the body's axes at rest,
// in Roblox's terms (-Z forward).

import { restPose, pointToWorld, type Frame } from './motion.js';
import type { Rig, RigHinge, RigJointLimit, RigLimb, Vec3 } from './rig.js';

export const RIG_ATTRIBUTE = 'RoqerRig';
export const RIG_DECLARATION_VERSION = 1;
/** The most points a declared foot may meet the ground at. */
const MAX_FOOT_POINTS = 8;
/** How far outside its part's box a declared point may lie, in studs. */
const POINT_SLACK = 0.5;
/** A hinge's off-axis limit when its range does not give one: R15's. */
const DEFAULT_OFF_AXIS = 35;

type V = [number, number, number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const length = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (v: readonly number[], k: number): V => [v[0] * k, v[1] * k, v[2] * k];
const minus = (a: readonly number[], b: readonly number[]): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const AXES: Record<RigHinge['axis'], V> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

function vector(value: unknown): V | undefined {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? [value[0], value[1], value[2]]
    : undefined;
}

/** `v` with its part along `axis` taken out, at unit length; undefined when little is left. */
function squareTo(v: readonly number[], axis: readonly number[]): V | undefined {
  const square = minus(v, scale(axis, dot(v, axis)));
  const size = length(square);
  return size > 1e-3 ? scale(square, 1 / size) : undefined;
}

/**
 * Where a part ends away from its joint: from the joint's pivot through the
 * part's centre, to the edge of its box. A leg hung from its top ends at the
 * middle of its sole; a tail hung from its front ends at its tip.
 */
function farEnd(size: Vec3, pivot: Vec3): V {
  const away = scale(pivot, -1);
  if (length(away) < 1e-6) return [0, -size[1] / 2, 0];
  let reach = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(away[axis]) > 1e-9) reach = Math.min(reach, (size[axis] / 2) / Math.abs(away[axis]));
  }
  // Adding 0 turns -0 to 0, so a declared end reads as written.
  return scale(away, reach).map((value) => value + 0) as V;
}

export type DeclaredRig = { ok: true; rig: Rig } | { ok: false; errors: string[] };

/**
 * Applies a model's RoqerRig declarations to the rig read from its joints.
 * Returns every problem at once when any declaration is malformed or names
 * what the rig lacks.
 */
export function declareRig(rig: Rig, text: string): DeclaredRig {
  const errors: string[] = [];
  const at = (path: string, message: string) => errors.push(`${RIG_ATTRIBUTE}${path}: ${message}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: [`${RIG_ATTRIBUTE}: must be JSON`] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: [`${RIG_ATTRIBUTE}: must be a JSON object`] };
  if (parsed.version !== RIG_DECLARATION_VERSION) {
    return { ok: false, errors: [`${RIG_ATTRIBUTE}.version: must be ${RIG_DECLARATION_VERSION}; this Roqer reads version ${RIG_DECLARATION_VERSION} only`] };
  }
  for (const key of Object.keys(parsed)) {
    if (!['version', 'feet', 'hips', 'limbs', 'hinges', 'limits'].includes(key)) at(`.${key}`, 'is not a version 1 declaration; expected feet, hips, limbs, hinges or limits');
  }

  const joints = new Map(rig.joints.map((joint) => [joint.name, joint]));
  const moved = new Set(rig.joints.map((joint) => joint.childPart));
  const jointNamed = (name: string, path: string) => {
    if (!joints.has(name)) at(path, `names no joint of the rig; its joints are ${rig.joints.map((joint) => joint.name).join(', ')}`);
    return joints.get(name);
  };
  const rest = restPose(rig);
  const restFrame = (part: string): Frame => rest.get(part)!;

  // Hinges first: limbs and limits refer to them.
  const hinges: Record<string, RigHinge> = {};
  if (parsed.hinges !== undefined) {
    if (!isRecord(parsed.hinges)) at('.hinges', 'must be an object of joint name to { axis, flex }');
    else {
      for (const [name, value] of Object.entries(parsed.hinges)) {
        const path = `.hinges.${name}`;
        if (!jointNamed(name, path)) continue;
        if (!isRecord(value) || !['X', 'Y', 'Z'].includes(value.axis as string) || (value.flex !== 1 && value.flex !== -1)) {
          at(path, 'must be { axis: "X", "Y" or "Z" (the body axis it bends about), flex: 1 or -1 (the sign of the turn that flexes it) }');
          continue;
        }
        hinges[name] = { axis: value.axis as RigHinge['axis'], flex: value.flex };
      }
    }
  }

  const limbs: Record<string, RigLimb> = {};
  if (parsed.limbs !== undefined) {
    if (!isRecord(parsed.limbs)) at('.limbs', 'must be an object of the joint at each limb\'s root to its declaration');
    else {
      for (const [name, value] of Object.entries(parsed.limbs)) {
        const path = `.limbs.${name}`;
        const root = jointNamed(name, path);
        if (!root) continue;
        if (!isRecord(value)) {
          at(path, 'must be an object: { hinge?, end?, foot?, axis?, fold? }');
          continue;
        }
        for (const key of Object.keys(value)) {
          if (!['hinge', 'end', 'foot', 'axis', 'fold'].includes(key)) at(`${path}.${key}`, 'is not a limb declaration; expected hinge, end, foot, axis or fold');
        }
        // The hinge moves the part the root joint moves; the foot, the part the hinge moves.
        let last = root.childPart;
        let hinge: RigHinge | undefined;
        let hingeName: string | undefined;
        if (value.hinge !== undefined) {
          const joint = typeof value.hinge === 'string' ? jointNamed(value.hinge, `${path}.hinge`) : undefined;
          if (typeof value.hinge !== 'string') at(`${path}.hinge`, 'must name a joint');
          else if (joint && joint.parentPart !== root.childPart) at(`${path}.hinge`, `${value.hinge} does not hang from ${root.childPart}, the part ${name} moves`);
          else if (joint && !hinges[joint.name]) at(`${path}.hinge`, `${value.hinge} must be declared in hinges, with the axis it bends about`);
          else if (joint) {
            hinge = hinges[joint.name];
            hingeName = joint.name;
            last = joint.childPart;
          }
        }
        let footName: string | undefined;
        let footPivot: Vec3 | undefined;
        if (value.foot !== undefined) {
          const joint = typeof value.foot === 'string' ? jointNamed(value.foot, `${path}.foot`) : undefined;
          if (typeof value.foot !== 'string') at(`${path}.foot`, 'must name a joint');
          else if (!hingeName) at(`${path}.foot`, 'goes with a hinge: a foot is laid flat below a bent knee');
          else if (joint && joint.parentPart !== last) at(`${path}.foot`, `${value.foot} does not hang from ${last}, the part ${hingeName} moves`);
          else if (joint) {
            footName = joint.name;
            footPivot = joint.parentOffset;
          }
        }
        const ownJoint = hingeName ? joints.get(hingeName)! : root;
        let end: V;
        if (value.end !== undefined) {
          const point = vector(value.end);
          const size = rig.parts[last];
          if (!point) {
            at(`${path}.end`, 'must be [x, y, z] in studs, in the frame of the limb\'s last part');
            continue;
          }
          if (point.some((component, axis) => Math.abs(component) > size[axis] / 2 + POINT_SLACK)) {
            at(`${path}.end`, `lies outside ${last}, whose size is [${size.join(', ')}]; give it in ${last}'s own frame`);
            continue;
          }
          end = point;
        } else {
          end = footPivot ? [...footPivot] as V : farEnd(rig.parts[last], ownJoint.childOffset);
        }

        // The limb's axis runs from its root's pivot to its end at rest.
        const pivot = pointToWorld(restFrame(root.parentPart), root.parentOffset);
        const tip = pointToWorld(restFrame(last), end);
        const reach = minus(tip, pivot);
        let axis: V;
        if (value.axis !== undefined) {
          const given = vector(value.axis);
          if (!given || length(given) < 1e-6) {
            at(`${path}.axis`, 'must be a direction [x, y, z], not all zero');
            continue;
          }
          axis = scale(given, 1 / length(given));
        } else if (length(reach) < 1e-3) {
          at(path, `its end is at its root's pivot, so it points nowhere; give end or axis`);
          continue;
        } else {
          axis = scale(reach, 1 / length(reach));
        }

        // It folds where its hinge swings its end, or back, square to its axis.
        let fold: V | undefined;
        if (value.fold !== undefined) {
          const given = vector(value.fold);
          fold = given ? squareTo(given, axis) : undefined;
          if (!fold) {
            at(`${path}.fold`, 'must be a direction [x, y, z] that does not run along the limb\'s axis');
            continue;
          }
        } else if (hinge && hingeName) {
          const hingePivot = pointToWorld(restFrame(joints.get(hingeName)!.parentPart), joints.get(hingeName)!.parentOffset);
          const swing = scale(cross(AXES[hinge.axis], minus(tip, hingePivot)), hinge.flex);
          fold = squareTo(swing, axis);
          if (!fold) {
            at(`${path}.fold`, `${hingeName} bends about ${hinge.axis}, along the limb, so it cannot fold it; give fold, or declare the hinge's axis square to the limb`);
            continue;
          }
        } else {
          fold = squareTo([0, 0, 1], axis) ?? squareTo([0, 1, 0], axis)!;
        }
        limbs[name] = {
          ...(hingeName ? { hinge: hingeName } : {}),
          end,
          ...(footName ? { foot: footName } : {}),
          axis,
          fold,
        };
      }
    }
  }

  const limits: Record<string, RigJointLimit> = { ...rig.limits };
  if (parsed.limits !== undefined) {
    if (!isRecord(parsed.limits)) at('.limits', 'must be an object of joint name to "free", { turn } or { min, max, offAxis? }');
    else {
      for (const [name, value] of Object.entries(parsed.limits)) {
        const path = `.limits.${name}`;
        if (!jointNamed(name, path)) continue;
        if (value === 'free') {
          limits[name] = 'free';
        } else if (isRecord(value) && Object.keys(value).length === 1 && typeof value.turn === 'number') {
          if (!(value.turn > 0 && value.turn <= 360)) at(`${path}.turn`, 'must be degrees above 0, at most 360');
          else limits[name] = { turn: value.turn };
        } else if (isRecord(value) && typeof value.min === 'number' && typeof value.max === 'number') {
          const offAxis = value.offAxis ?? DEFAULT_OFF_AXIS;
          if (!hinges[name]) at(path, `a range goes on a hinge; declare ${name} in hinges, or give { turn }`);
          else if (!(value.min < value.max) || Math.abs(value.min) > 360 || Math.abs(value.max) > 360) at(path, 'min must be below max, both degrees within ±360, signed about the hinge\'s axis');
          else if (typeof offAxis !== 'number' || !(offAxis > 0 && offAxis <= 180)) at(`${path}.offAxis`, 'must be degrees above 0, at most 180');
          else if (Object.keys(value).some((key) => !['min', 'max', 'offAxis'].includes(key))) at(path, 'a range is { min, max, offAxis? }');
          else limits[name] = { min: value.min, max: value.max, offAxis };
        } else {
          at(path, 'must be "free", { turn } or, on a hinge, { min, max, offAxis? }');
        }
      }
    }
  }

  const feet: string[] = [];
  const footPoints: Record<string, Vec3[]> = {};
  if (parsed.feet !== undefined) {
    const entries: [string, unknown][] | undefined = Array.isArray(parsed.feet)
      ? parsed.feet.map((part) => [part as string, undefined])
      : isRecord(parsed.feet) ? Object.entries(parsed.feet) : undefined;
    if (!entries) at('.feet', 'must list the parts that stand on the ground, or map each to the points that do');
    for (const [part, points] of entries ?? []) {
      const path = `.feet.${part}`;
      if (typeof part !== 'string' || !moved.has(part)) {
        at(path, 'must be a part a joint moves');
        continue;
      }
      if (feet.includes(part)) {
        at(path, 'is listed twice');
        continue;
      }
      if (points !== undefined) {
        const list = Array.isArray(points) ? points.map(vector) : [];
        const size = rig.parts[part];
        if (list.length === 0 || list.length > MAX_FOOT_POINTS || list.some((point) => !point)) {
          at(path, `must be 1 to ${MAX_FOOT_POINTS} points [x, y, z] in the part's frame`);
          continue;
        }
        if (list.some((point) => point!.some((component, axis) => Math.abs(component) > size[axis] / 2 + POINT_SLACK))) {
          at(path, `has a point outside ${part}, whose size is [${size.join(', ')}]`);
          continue;
        }
        footPoints[part] = list as V[];
      }
      feet.push(part);
    }
  }
  // A leg with no ankle cannot lay its last part flat: it stands on its end,
  // and its box's corners dip under the ground whenever it leans. So a foot
  // that is such a limb's last part meets the ground at the limb's end,
  // unless its points were given.
  for (const [name, limb] of Object.entries(limbs)) {
    const last = joints.get(limb.hinge ?? name)?.childPart;
    if (!limb.foot && last !== undefined && feet.includes(last) && !footPoints[last]) footPoints[last] = [limb.end];
  }

  let hips: [string, string] | undefined;
  if (parsed.hips !== undefined) {
    const pair = parsed.hips;
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || pair[0] === pair[1]) {
      at('.hips', 'must be two joints, left then right, whose swing a biped\'s gait compares');
    } else if (jointNamed(pair[0], '.hips[0]') && jointNamed(pair[1], '.hips[1]')) {
      hips = [pair[0], pair[1]];
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    rig: {
      ...rig,
      feet,
      ...(Object.keys(footPoints).length > 0 ? { footPoints } : {}),
      ...(hips ? { hips } : {}),
      limbs,
      hinges,
      limits,
    },
  };
}
