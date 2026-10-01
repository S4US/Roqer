import assert from "node:assert/strict";
import test from "node:test";

import { describeSkins, parseSkins, skinFlags, type InspectedSkin, type SkinBone } from "./blender-skin";

const bone = (name: string, head: number[], tail: number[], parent?: string): SkinBone => ({ name, head, tail, ...(parent === undefined ? {} : { parent }) });

/** A wolf facing -Y, standing on Z 0: a spine, a head, a tail, and four legs of an upper, a lower and a foot bone. */
function wolf(change: (skin: InspectedSkin) => InspectedSkin = (skin) => skin): InspectedSkin[] {
  const bones = [
    bone("Spine", [0, 1.4, 2.3], [0, -1.4, 2.3]),
    bone("Head", [0, -1.5, 2.7], [0, -2.9, 2.8], "Spine"),
    bone("Tail", [0, 1.6, 2.5], [0, 3.1, 1.96], "Spine"),
  ];
  for (const [end, y] of [["Front", -1.1], ["Hind", 1.3]] as const) {
    for (const [side, x] of [["Left", 0.45], ["Right", -0.45]] as const) {
      const leg = `${end}${side}`;
      bones.push(bone(`${leg}Upper`, [x, y, 1.9], [x, y, 0.95], "Spine"));
      bones.push(bone(`${leg}Lower`, [x, y, 0.95], [x, y, 0], `${leg}Upper`));
      bones.push(bone(`${leg}Foot`, [x, y, 0], [x, y - 0.3, 0], `${leg}Lower`));
    }
  }
  return [change({
    armature: "Armature",
    boneCount: bones.length,
    bones,
    meshes: [{ name: "Wolf", mesh: "Wolf", vertices: 152, unweighted: 0, overFour: 0, mostInfluences: 2, materials: 1 }],
  })];
}

test("a mesh weighted whole to one armature is described with how to rig it, and nothing to fix", () => {
  assert.deepEqual(skinFlags(wolf(), 0), []);
  const text = describeSkins(wolf(), 0);
  assert.match(text, /skinned: Wolf follows 15 bones of Armature \(Spine, Head, Tail, FrontLeftUpper, /);
  assert.match(text, /each vertex weighted to at most 2\./);
  assert.match(text, /rig it with no joints: animation \{action: "rig", model, controller, plan, replace: "importer"\}/);
  assert.doesNotMatch(text, /Fix before uploading/);
  assert.equal(describeSkins(undefined), "");
});

test("it flags what Roblox would not keep, naming the thing and what to change", () => {
  const flagsOf = (change: (skin: InspectedSkin) => InspectedSkin, bottom = 0) => skinFlags(wolf(change), bottom);
  const mesh = (more: Partial<InspectedSkin["meshes"][number]>) => (skin: InspectedSkin) => ({ ...skin, meshes: [{ ...skin.meshes[0], ...more }] });

  assert.match(flagsOf(mesh({ unweighted: 12 }))[0], /^12 of Wolf's 152 vertices follow no bone, so they would stay where they are/);
  assert.match(flagsOf(mesh({ overFour: 30, mostInfluences: 7 }))[0], /^30 of Wolf's vertices follow more than 4 bones \(up to 7\); Roblox keeps the 4 largest/);
  assert.match(flagsOf(mesh({ materials: 2 }))[0], /^Wolf has 2 materials, so it arrives as 2 MeshParts/);
  // The mesh arrives named after its data, and a pose finds a bone and a part alike by name.
  assert.match(flagsOf(mesh({ mesh: "Spine" }))[0], /^a bone and the mesh are both named Spine/);
  assert.match(flagsOf((skin) => ({ ...skin, meshes: [...skin.meshes, { ...skin.meshes[0], name: "Collar" }] }))[0], /^2 meshes follow Armature \(Wolf, Collar\)/);
  assert.match(flagsOf((skin) => ({ ...skin, meshes: [] }))[0], /^no mesh follows Armature/);
  assert.match(flagsOf((skin) => ({ ...skin, boneCount: 80 }))[0], /^Armature has 80 bones; Roqer animates a rig of at most 64 joints/);
  assert.match(flagsOf((skin) => ({ ...skin, bones: skin.bones.map((entry) => entry.name === "Spine" ? { ...entry, name: "Root" } : entry) }))[0], /^a bone is named Root, which rig names the root it makes/);
  // A leg with no foot bone, and a foot bone off the ground.
  assert.match(flagsOf((skin) => ({ ...skin, bones: skin.bones.filter((entry) => entry.name !== "HindLeftFoot") }))[0], /^HindLeftLower has no HindLeftFoot bone below it/);
  assert.match(flagsOf((skin) => skin, -0.5)[0], /^FrontLeftFoot begins 0\.50 above the model's lowest point/);
  assert.match(skinFlags([...wolf(), ...wolf((skin) => ({ ...skin, armature: "Second" }))], 0)[0], /^2 armatures \(Armature, Second\)/);

  const text = describeSkins(wolf(mesh({ unweighted: 12 })), 0);
  assert.match(text, /Fix before uploading, since an upload cannot be changed: 12 of Wolf's 152 vertices follow no bone/);
});

test("the inspection's skins are read as data, keeping only well-formed entries", () => {
  assert.equal(parseSkins("nope"), undefined);
  assert.equal(parseSkins([{ armature: "A" }]), undefined);
  assert.deepEqual(parseSkins([{
    armature: "Armature",
    boneCount: 2,
    bones: [{ name: "Spine", head: [0, 0, 1], tail: [0, 1, 1], parent: 7 }, { name: "", head: [0, 0, 0], tail: [0, 0, 1] }, { name: "Bad", head: [0, NaN, 0], tail: [0, 0, 1] }],
    meshes: [{ name: "Wolf", mesh: "Wolf", vertices: 10, unweighted: -3, overFour: "2", mostInfluences: 2.9, materials: 1 }, { vertices: 4 }],
  }]), [{
    armature: "Armature",
    boneCount: 2,
    bones: [{ name: "Spine", head: [0, 0, 1], tail: [0, 1, 1] }],
    meshes: [{ name: "Wolf", mesh: "Wolf", vertices: 10, unweighted: 0, overFour: 0, mostInfluences: 2, materials: 1 }],
  }]);
});
