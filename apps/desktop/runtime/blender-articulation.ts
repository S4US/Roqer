/**
 * What Roqer's inspection says about a model built of moving pieces: objects
 * parented to one another, each with its origin where it turns. An upload
 * keeps every piece where it was modelled but loses every pivot (the importer
 * hangs each piece from one root at the piece's own centre), so the pivots
 * leave Blender here, as the joints the `animation` tool's `rig` action takes.
 *
 * Everything is measured by the inspection itself from the exported file, in
 * Blender coordinates; a point at Blender (x, y, z) arrives in Roblox at
 * (-x, z, y) from the model's own origin.
 */

import { LEGS, legShapeFlags, type LegShape } from "./blender-skin";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 3 && value.every(isNumber);
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/** How many objects one file lists by name, and how many an articulated model may have and still be turned into joints. */
export const MAX_LISTED_OBJECTS = 16;
export const MAX_ARTICULATED_OBJECTS = 48;
/** How far outside a piece's box its origin may lie and still join it, in studs: the `rig` action's own slack. */
const PIVOT_SLACK = 0.1;
const MAX_FLAGS = 8;

/** One mesh object of an exported model, as the inspection measured it. */
export type InspectedObject = Readonly<{
  name: string;
  /** In studs, in Roblox's axes. */
  size: readonly number[];
  /** The object's origin, and its box's corners, in Blender coordinates. */
  origin?: readonly number[];
  low?: readonly number[];
  high?: readonly number[];
  /** The mesh object it is parented to, through any empties between. */
  parent?: string;
  /** Its mesh data's name, which Roblox names the MeshPart after. */
  mesh?: string;
  materials?: number;
}>;

/** A joint as the `rig` action takes it; its pivot is in Roblox's axes from the model's own origin. */
export type ArticulationJoint = Readonly<{ part: string; parent: string; pivot: readonly [number, number, number]; name?: string }>;

export type Articulation = Readonly<{
  /** The piece every other hangs from. */
  root: string;
  joints: readonly ArticulationJoint[];
  /** What would rig badly, each naming the object and what to change. */
  flags: readonly string[];
  flagCount: number;
}>;

/** The inspection's object list, keeping only well-formed entries: its output is data, not trusted structure. */
export function parseObjects(value: unknown): InspectedObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_ARTICULATED_OBJECTS).flatMap((entry): InspectedObject[] => {
    if (!isRecord(entry) || !isName(entry.name) || !isVector(entry.size)) return [];
    return [{
      name: entry.name,
      size: entry.size,
      ...(isVector(entry.origin) ? { origin: entry.origin } : {}),
      ...(isVector(entry.low) && isVector(entry.high) ? { low: entry.low, high: entry.high } : {}),
      ...(isName(entry.parent) ? { parent: entry.parent } : {}),
      ...(isName(entry.mesh) ? { mesh: entry.mesh } : {}),
      ...(isNumber(entry.materials) && entry.materials >= 0 ? { materials: Math.floor(entry.materials) } : {}),
    }];
  });
}

const SIDES: ReadonlyMap<string, string> = new Map([
  ["L", "R"], ["R", "L"], ["l", "r"], ["r", "l"],
  ["Left", "Right"], ["Right", "Left"], ["left", "right"], ["right", "left"],
]);

/**
 * The name of the piece on the other side: `Ear_L` and `Ear_R`, or, as the
 * body plans name legs, `FrontLeftUpper` and `FrontRightUpper`. A name that
 * marks no side, or more than one, has no other side.
 */
export function otherSidePiece(name: string): string | undefined {
  const words = name.split(/([_.\-\s]+)/);
  const marked = words.flatMap((word, index) => index % 2 === 0 && SIDES.has(word) ? [index] : []);
  if (marked.length === 1) return words.map((word, index) => index === marked[0] ? SIDES.get(word) : word).join("");
  if (marked.length > 1) return undefined;
  // A side written into a camel-case name: Left or Right as a word of its own.
  const inside = [...name.matchAll(/(Left|Right)(?![a-z])/g)];
  if (inside.length !== 1) return undefined;
  const at = inside[0].index;
  return `${name.slice(0, at)}${inside[0][1] === "Left" ? "Right" : "Left"}${name.slice(at + inside[0][1].length)}`;
}

/** The joint a body plan's recipes key for a piece: a leg's joint is named for the leg, its knee and ankle after it. */
function jointName(part: string): string | undefined {
  if (part === "Head") return "Neck";
  const leg = /^(.+)(Upper|Lower|Foot)$/.exec(part);
  if (!leg) return undefined;
  return leg[2] === "Upper" ? leg[1] : `${leg[1]}${leg[2] === "Lower" ? "Knee" : "Ankle"}`;
}

const round = (value: number) => Math.round(value * 1000) / 1000 + 0;
const toRoblox = (point: readonly number[]): [number, number, number] => [round(-point[0]), round(point[2]), round(point[1])];
const at = (point: readonly number[]) => `(${point.map((value) => value.toFixed(2)).join(", ")})`;
const inBox = (point: readonly number[], object: InspectedObject) => object.low !== undefined && object.high !== undefined &&
  point.every((value, axis) => value >= object.low![axis] - PIVOT_SLACK && value <= object.high![axis] + PIVOT_SLACK);

/**
 * A model's pieces as joints, when its objects hang from one another, with
 * whatever would rig badly. Undefined for a model with no parented mesh, which
 * is one rigid thing or a kit set.
 */
export function articulationOf(objects: readonly InspectedObject[]): Articulation | undefined {
  const byName = new Map(objects.map((object) => [object.name, object]));
  const children = objects.filter((object) => object.parent !== undefined && byName.has(object.parent) && object.origin !== undefined);
  if (children.length === 0) return undefined;
  const flags: string[] = [];
  const roots = objects.filter((object) => object.parent === undefined || !byName.has(object.parent));
  if (roots.length > 1) {
    flags.push(`${roots.length} objects hang from nothing (${roots.slice(0, 6).map((object) => object.name).join(", ")}${roots.length > 6 ? ", and more" : ""}): a rig is one tree, so parent every piece but the body to the piece it hangs from, or join what never moves into its piece`);
  }
  // Roblox names each MeshPart after its mesh, not its object.
  const partName = (object: InspectedObject) => object.mesh ?? object.name;
  for (const object of objects) {
    if (object.mesh !== undefined && object.mesh !== object.name) {
      flags.push(`${object.name}'s mesh is named ${object.mesh}, and Roblox names the MeshPart after the mesh: set obj.data.name = obj.name`);
    }
    if ((object.materials ?? 1) > 1) {
      flags.push(`${object.name} has ${object.materials} materials, so it arrives as ${object.materials} MeshParts, and rig would find the extra ones loose: give it one material (vertex colours can carry several colours)`);
    }
  }
  const meshNames = new Map<string, string[]>();
  for (const object of objects) meshNames.set(partName(object), [...(meshNames.get(partName(object)) ?? []), object.name]);
  for (const [mesh, users] of meshNames) {
    if (users.length > 1) flags.push(`${users.join(" and ")} would all arrive named ${mesh}, and rig finds each piece by its name: give each its own mesh, named after its object`);
  }

  for (const child of children) {
    const parent = byName.get(child.parent!)!;
    const origin = child.origin!;
    if (!inBox(origin, child) && !inBox(origin, parent)) {
      flags.push(`${child.name}'s origin ${at(origin)} lies in neither it nor ${parent.name}: a piece turns at its origin, so put it where the two meet`);
    } else if (child.low !== undefined && child.high !== undefined) {
      const centre = child.low.map((low, axis) => (low + child.high![axis]) / 2);
      const longest = Math.max(...child.high.map((high, axis) => high - child.low![axis]));
      if (Math.hypot(...origin.map((value, axis) => value - centre[axis])) < 0.1 * longest) {
        flags.push(`${child.name}'s origin ${at(origin)} is at its own middle, so it would spin in place: move the origin to where it joins ${parent.name}, such as the top of a leg`);
      }
    }
  }

  // Left and right pieces turn at mirrored origins, across the plane most pairs share.
  const pairs = children.flatMap((child): Array<[InspectedObject, InspectedObject]> => {
    const other = otherSidePiece(child.name);
    const partner = other === undefined ? undefined : children.find((candidate) => candidate.name === other);
    return partner !== undefined && child.name < partner.name ? [[child, partner]] : [];
  });
  if (pairs.length > 0) {
    const middles = pairs.map(([first, second]) => (first.origin![0] + second.origin![0]) / 2).sort((a, b) => a - b);
    const plane = middles[Math.floor(middles.length / 2)];
    for (const [first, second] of pairs) {
      const a = first.origin!;
      const b = second.origin!;
      const mirrored = Math.abs(a[0] + b[0] - 2 * plane) <= 0.05 && Math.abs(a[1] - b[1]) <= 0.05 && Math.abs(a[2] - b[2]) <= 0.05 && Math.abs(a[0] - b[0]) > 0.05;
      if (!mirrored) flags.push(`${first.name}'s origin ${at(a)} and ${second.name}'s ${at(b)} do not mirror across X = ${plane.toFixed(2)}, so the two sides would turn differently`);
    }
  }

  // A leg of an upper and a lower piece turns at their origins and ends at
  // its foot piece's origin, or at the bottom of its lower piece.
  flags.push(...legShapeFlags(LEGS.flatMap((leg): LegShape[] => {
    const [upper, lower, foot] = [byName.get(`${leg}Upper`), byName.get(`${leg}Lower`), byName.get(`${leg}Foot`)];
    if (!upper?.origin || !lower?.origin || lower.parent !== upper.name) return [];
    const end = foot?.origin ?? (lower.low && lower.high ? [(lower.low[0] + lower.high[0]) / 2, (lower.low[1] + lower.high[1]) / 2, lower.low[2]] : undefined);
    return end ? [{ leg, hip: upper.origin, knee: lower.origin, foot: end }] : [];
  }), "moving its knee, the lower piece's pivot,"));

  // Parents before children, as the tree runs from the root.
  const joints: ArticulationJoint[] = [];
  const visit = (parent: InspectedObject) => {
    for (const child of children) {
      if (child.parent !== parent.name) continue;
      const name = jointName(partName(child));
      joints.push({ part: partName(child), parent: partName(parent), pivot: toRoblox(child.origin!), ...(name === undefined ? {} : { name }) });
      visit(child);
    }
  };
  // A parent chain that loops has no root to start from; Blender does not allow one.
  for (const root of roots) visit(root);
  return { root: partName(roots[0] ?? objects[0]), joints, flags: flags.slice(0, MAX_FLAGS), flagCount: flags.length };
}

/** The articulation as the job's result says it: what to fix first, then the joints to pass on. */
export function describeArticulation(articulation: Articulation | undefined): string {
  if (articulation === undefined) return "";
  const lines = [
    `\n  moving pieces: ${articulation.joints.length + 1} pieces in a tree from ${articulation.root}, each turning at its object's origin.`,
  ];
  if (articulation.flagCount > 0) {
    const hidden = articulation.flagCount - articulation.flags.length;
    lines.push(` Fix before uploading, since an upload cannot be changed: ${articulation.flags.join("; ")}${hidden > 0 ? `; and ${hidden} more` : ""}.`);
  }
  lines.push(
    ` The upload keeps where each piece is but not where it turns, so after insert_asset pass these to animation's rig action with replace: "importer" and pivot_space: "import" (pivots are in Roblox's axes from the model's own origin; the call is the same whether or not the upload arrives with a rig), and a controller and plan: joints: ${JSON.stringify(articulation.joints)}`,
  );
  return lines.join("");
}
