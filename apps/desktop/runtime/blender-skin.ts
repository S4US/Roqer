/**
 * What Roqer's inspection says about a skinned model: one mesh that follows an
 * armature's bones. A Roblox upload keeps the bones and the weights (the
 * skinned spike, docs/creature-plan.md), so the model arrives ready for the
 * `animation` tool's `rig` action with no joints to give; what it cannot keep,
 * or what would rig badly, is said here while the model can still be changed.
 *
 * Everything is measured by the inspection itself from the exported file, in
 * Blender coordinates.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 3 && value.every(isNumber);
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const whole = (value: unknown) => isNumber(value) && value >= 0 ? Math.floor(value) : 0;

/** The most bones a vertex keeps in Roblox, and the most joints Roqer animates, a walker's root among them. */
export const MAX_SKIN_INFLUENCES = 4;
export const MAX_RIG_JOINTS = 64;
const MAX_LISTED_BONES = 96;
const MAX_NAMED_BONES = 24;
const MAX_FLAGS = 8;
/** How far above the model's lowest point a foot bone may begin and still stand on the ground, in studs. */
const FOOT_SLACK = 0.15;

export type SkinBone = Readonly<{ name: string; parent?: string; head: readonly number[]; tail: readonly number[] }>;

export type SkinnedMesh = Readonly<{
  name: string;
  /** Its mesh data's name, which Roblox names the MeshPart after. */
  mesh?: string;
  vertices: number;
  /** Vertices no bone holds. */
  unweighted: number;
  /** Vertices more than four bones hold. */
  overFour: number;
  mostInfluences: number;
  materials: number;
}>;

export type InspectedSkin = Readonly<{
  armature: string;
  boneCount: number;
  bones: readonly SkinBone[];
  meshes: readonly SkinnedMesh[];
}>;

/** The inspection's skins, keeping only well-formed entries: its output is data, not trusted structure. */
export function parseSkins(value: unknown): InspectedSkin[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skins = value.slice(0, 4).flatMap((entry): InspectedSkin[] => {
    if (!isRecord(entry) || !isName(entry.armature) || !Array.isArray(entry.bones) || !Array.isArray(entry.meshes)) return [];
    const bones = entry.bones.slice(0, MAX_LISTED_BONES).flatMap((bone): SkinBone[] => isRecord(bone) && isName(bone.name) && isVector(bone.head) && isVector(bone.tail)
      ? [{ name: bone.name, head: bone.head, tail: bone.tail, ...(isName(bone.parent) ? { parent: bone.parent } : {}) }]
      : []);
    const meshes = entry.meshes.slice(0, 8).flatMap((mesh): SkinnedMesh[] => isRecord(mesh) && isName(mesh.name)
      ? [{
        name: mesh.name,
        ...(isName(mesh.mesh) ? { mesh: mesh.mesh } : {}),
        vertices: whole(mesh.vertices),
        unweighted: whole(mesh.unweighted),
        overFour: whole(mesh.overFour),
        mostInfluences: whole(mesh.mostInfluences),
        materials: whole(mesh.materials),
      }]
      : []);
    return [{ armature: entry.armature, boneCount: Math.max(whole(entry.boneCount), bones.length), bones, meshes }];
  });
  return skins.length > 0 ? skins : undefined;
}

/** A quadruped's legs as the body plan names their bones: `<Leg>Upper`, `<Leg>Lower`, `<Leg>Foot`, or `<Leg>` alone. */
const LEGS = ["FrontLeft", "FrontRight", "HindLeft", "HindRight"] as const;

/** What would rig or animate badly, each naming the thing and what to change. */
export function skinFlags(skins: readonly InspectedSkin[], bottom: number | undefined): string[] {
  const flags: string[] = [];
  if (skins.length > 1) {
    flags.push(`${skins.length} armatures (${skins.map((skin) => skin.armature).join(", ")}): rig builds around one skinned mesh, so make one armature of them`);
  }
  for (const skin of skins) {
    if (skin.meshes.length === 0) {
      flags.push(`no mesh follows ${skin.armature}: skin the creature to it with roqer.skin, or leave the armature out`);
    }
    if (skin.meshes.length > 1) {
      flags.push(`${skin.meshes.length} meshes follow ${skin.armature} (${skin.meshes.map((mesh) => mesh.name).join(", ")}): each would arrive as a MeshPart with bones of its own, and rig builds around one, so join them into one object before skinning`);
    }
    for (const mesh of skin.meshes) {
      if (mesh.unweighted > 0) {
        flags.push(`${mesh.unweighted} of ${mesh.name}'s ${mesh.vertices} vertices follow no bone, so they would stay where they are while the rest moves: weight every vertex (roqer.skin does)`);
      }
      if (mesh.overFour > 0) {
        flags.push(`${mesh.overFour} of ${mesh.name}'s vertices follow more than ${MAX_SKIN_INFLUENCES} bones (up to ${mesh.mostInfluences}); Roblox keeps the ${MAX_SKIN_INFLUENCES} largest, which changes how it bends: limit each vertex to ${MAX_SKIN_INFLUENCES}`);
      }
      if (mesh.materials > 1) {
        flags.push(`${mesh.name} has ${mesh.materials} materials, so it arrives as ${mesh.materials} MeshParts: give it one material (vertex colours can carry several colours)`);
      }
      const arrives = mesh.mesh ?? mesh.name;
      if (skin.bones.some((bone) => bone.name === arrives)) {
        flags.push(`a bone and the mesh are both named ${arrives}, and a keyframe's poses find each by its name: rename one`);
      }
    }
    if (skin.boneCount > MAX_RIG_JOINTS - 1) {
      flags.push(`${skin.armature} has ${skin.boneCount} bones; Roqer animates a rig of at most ${MAX_RIG_JOINTS} joints, a walker's root among them: use ${MAX_RIG_JOINTS - 1} bones or fewer`);
    }
    const reserved = skin.bones.filter((bone) => bone.name === "Root" || bone.name === "HumanoidRootPart").map((bone) => bone.name);
    if (reserved.length > 0) {
      flags.push(`a bone is named ${reserved.join(" and ")}, which rig names the root it makes and its joint: name the bone apart, such as Spine`);
    }
    // A leg the quadruped plan would find: its foot bone is where it stands.
    const named = new Map(skin.bones.map((bone) => [bone.name, bone]));
    for (const leg of LEGS) {
      if (!named.has(`${leg}Upper`) && !named.has(leg)) continue;
      const foot = named.get(`${leg}Foot`);
      if (named.has(`${leg}Upper`) && named.has(`${leg}Lower`) && !foot) {
        flags.push(`${leg}Lower has no ${leg}Foot bone below it, so the quadruped plan cannot tell where the leg ends: add ${leg}Foot at the paw's sole, parented to ${leg}Lower`);
      } else if (foot && bottom !== undefined && foot.head[2] - bottom > FOOT_SLACK) {
        flags.push(`${leg}Foot begins ${(foot.head[2] - bottom).toFixed(2)} above the model's lowest point, and a foot bone meets the ground where it begins: put its head at the sole`);
      }
    }
  }
  return flags;
}

/** The skin as the job's result says it: what follows what, what to fix first, then how to rig it. */
export function describeSkins(skins: readonly InspectedSkin[] | undefined, bottom?: number): string {
  if (skins === undefined || skins.length === 0) return "";
  const flags = skinFlags(skins, bottom);
  const first = skins[0];
  const mesh = first.meshes[0];
  const names = first.bones.slice(0, MAX_NAMED_BONES).map((bone) => bone.name).join(", ");
  const lines = [
    `\n  skinned: ${mesh === undefined ? "no mesh" : mesh.mesh ?? mesh.name} follows ${first.boneCount} bone${first.boneCount === 1 ? "" : "s"} of ${first.armature} (${names}${first.boneCount > MAX_NAMED_BONES ? `, and ${first.boneCount - MAX_NAMED_BONES} more` : ""})${mesh === undefined ? "" : `, each vertex weighted to at most ${mesh.mostInfluences}`}.`,
  ];
  if (flags.length > 0) {
    const shown = flags.slice(0, MAX_FLAGS);
    lines.push(` Fix before uploading, since an upload cannot be changed: ${shown.join("; ")}${flags.length > shown.length ? `; and ${flags.length - shown.length} more` : ""}.`);
  }
  lines.push(
    " The upload keeps the bones and the weights: it arrives as one MeshPart holding the bones as Bones, each a joint named after itself. After insert_asset, rig it with no joints: animation {action: \"rig\", model, controller, plan, replace: \"importer\"} makes the root and the controller around the mesh and declares its legs from the bones' names; then animate the bones by name.",
  );
  return lines.join("");
}
