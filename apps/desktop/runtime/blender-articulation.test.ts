import assert from "node:assert/strict";
import test from "node:test";

import { articulationOf, describeArticulation, otherSidePiece, parseObjects, type InspectedObject } from "./blender-articulation";

/** A box-shaped piece in Blender coordinates (X, Y, Z up): its box, its origin, and what it hangs from. */
function piece(name: string, low: number[], high: number[], origin: number[], parent?: string, more: Partial<InspectedObject> = {}): InspectedObject {
  return {
    name,
    size: [high[0] - low[0], high[2] - low[2], high[1] - low[1]],
    origin, low, high, mesh: name, materials: 1,
    ...(parent === undefined ? {} : { parent }),
    ...more,
  };
}

/** A wolf facing -Y: a body, a head, a tail, and four legs of two pieces, each origin at its joint, each knee off its leg's line the way it folds. */
function wolf(): InspectedObject[] {
  const pieces = [
    piece("Body", [-0.6, -1.6, 1.5], [0.6, 1.6, 2.5], [0, 0, 2]),
    piece("Head", [-0.5, -2.6, 2.0], [0.5, -1.4, 3.0], [0, -1.5, 2.4], "Body"),
    piece("Tail", [-0.15, 1.5, 2.0], [0.15, 2.8, 2.3], [0, 1.55, 2.2], "Body"),
  ];
  for (const [end, y, knee] of [["Front", -1.2, -0.25], ["Hind", 1.2, 0.25]] as const) {
    for (const [side, x] of [["Left", 0.45], ["Right", -0.45]] as const) {
      // Blender +X is the model's left once it faces -Y: Roblox's -X.
      pieces.push(piece(`${end}${side}Upper`, [x - 0.2, y - 0.3, 0.7], [x + 0.2, y + 0.3, 1.7], [x, y, 1.6], "Body"));
      pieces.push(piece(`${end}${side}Lower`, [x - 0.18, y - 0.3, 0], [x + 0.18, y + 0.3, 0.85], [x, y + knee, 0.8], `${end}${side}Upper`));
    }
  }
  return pieces;
}

test("a model whose objects hang from one another becomes rig's joints, pivots in Roblox's axes", () => {
  const articulation = articulationOf(wolf());
  assert.ok(articulation);
  assert.equal(articulation.root, "Body");
  assert.deepEqual(articulation.flags, []);
  assert.equal(articulation.joints.length, 10);
  // Blender (x, y, z) arrives at (-x, z, y); parents come before children.
  assert.deepEqual(articulation.joints[0], { part: "Head", parent: "Body", pivot: [0, 2.4, -1.5], name: "Neck" });
  assert.deepEqual(articulation.joints[1], { part: "Tail", parent: "Body", pivot: [0, 2.2, 1.55] });
  assert.deepEqual(articulation.joints[2], { part: "FrontLeftUpper", parent: "Body", pivot: [-0.45, 1.6, -1.2], name: "FrontLeft" });
  assert.deepEqual(articulation.joints[3], { part: "FrontLeftLower", parent: "FrontLeftUpper", pivot: [-0.45, 0.8, -1.45], name: "FrontLeftKnee" });
  assert.deepEqual(articulation.joints.map((joint) => joint.name ?? joint.part), [
    "Neck", "Tail", "FrontLeft", "FrontLeftKnee", "FrontRight", "FrontRightKnee", "HindLeft", "HindLeftKnee", "HindRight", "HindRightKnee",
  ]);

  const text = describeArticulation(articulation);
  assert.match(text, /moving pieces: 11 pieces in a tree from Body, each turning at its object's origin\./);
  assert.match(text, /replace: "importer" and pivot_space: "import"/);
  assert.ok(text.includes('{"part":"Head","parent":"Body","pivot":[0,2.4,-1.5],"name":"Neck"}'));
  assert.doesNotMatch(text, /Fix before uploading/);
});

test("a rigid model or a kit set, with nothing parented, has no articulation", () => {
  assert.equal(articulationOf([piece("Barrel", [-1, -1, 0], [1, 1, 4], [0, 0, 0])]), undefined);
  assert.equal(articulationOf(wolf().map((entry) => ({ ...entry, parent: undefined }))), undefined);
  assert.equal(describeArticulation(undefined), "");
});

test("it flags what would rig badly, naming the object and what to change", () => {
  const flagsOf = (change: (pieces: InspectedObject[]) => InspectedObject[]) => articulationOf(change(wolf()))!.flags;
  const swap = (name: string, more: Partial<InspectedObject>) => (pieces: InspectedObject[]) =>
    pieces.map((entry) => entry.name === name ? { ...entry, ...more } : entry);

  // An origin left at the piece's middle: the usual mistake.
  assert.match(flagsOf(swap("Tail", { origin: [0, 2.15, 2.15] }))[0], /^Tail's origin \(0\.00, 2\.15, 2\.15\) is at its own middle, so it would spin in place: move the origin to where it joins Body/);
  // An origin in neither piece.
  assert.match(flagsOf(swap("Head", { origin: [0, -4, 5] }))[0], /^Head's origin \(0\.00, -4\.00, 5\.00\) lies in neither it nor Body/);
  // A mesh named apart from its object, as a duplicated object's is.
  assert.match(flagsOf(swap("Head", { mesh: "Cube.004" }))[0], /^Head's mesh is named Cube\.004, and Roblox names the MeshPart after the mesh: set obj\.data\.name = obj\.name$/);
  // Two materials make two MeshParts.
  assert.match(flagsOf(swap("Body", { materials: 2 }))[0], /^Body has 2 materials, so it arrives as 2 MeshParts/);
  // A left leg whose origin does not mirror the right's.
  assert.match(
    flagsOf(swap("HindLeftUpper", { origin: [0.45, 1.2, 1.3] }))[0],
    /^HindLeftUpper's origin \(0\.45, 1\.20, 1\.30\) and HindRightUpper's \(-0\.45, 1\.20, 1\.60\) do not mirror across X = 0\.00/,
  );
  // Legs with their knees on the line from hip to foot have no slack to stride with.
  const straight = flagsOf((pieces) => pieces.map((entry) => entry.name.endsWith("Lower") ? { ...entry, origin: [entry.origin![0], entry.name.startsWith("Front") ? -1.2 : 1.2, 0.8] } : entry));
  assert.match(straight[0], /^FrontLeft, FrontRight, HindLeft, HindRight are modelled straight, so a gait can only stride by lowering the body/);
  // A piece parented to nothing is a second tree.
  const loose = flagsOf(swap("Tail", { parent: undefined }));
  assert.match(loose[0], /^2 objects hang from nothing \(Body, Tail\): a rig is one tree/);
  // Two objects sharing one mesh would arrive under one name.
  assert.match(flagsOf(swap("FrontRightLower", { mesh: "FrontLeftLower" })).join("\n"), /FrontLeftLower and FrontRightLower would all arrive named FrontLeftLower/);

  const text = describeArticulation(articulationOf(swap("Head", { mesh: "Cube.004" })(wolf())));
  assert.match(text, /Fix before uploading, since an upload cannot be changed: Head's mesh is named Cube\.004/);
  // The joints name the part as it will arrive.
  assert.ok(text.includes('"part":"Cube.004"'));
});

test("a piece's other side is found in both ways of naming it", () => {
  assert.equal(otherSidePiece("Ear_L"), "Ear_R");
  assert.equal(otherSidePiece("FrontLeftUpper"), "FrontRightUpper");
  assert.equal(otherSidePiece("RightWing"), "LeftWing");
  assert.equal(otherSidePiece("Leftover"), undefined);
  assert.equal(otherSidePiece("Body"), undefined);
  assert.equal(otherSidePiece("LeftRightBar"), undefined);
});

test("the inspection's objects are read as data, keeping only well-formed entries", () => {
  assert.equal(parseObjects("nope"), undefined);
  assert.deepEqual(parseObjects([
    { name: "Body", size: [1, 2, 3], origin: [0, 0, 1], low: [0, 0, 0], high: [1, 1, 1], mesh: "Body", materials: 1, parent: 7 },
    { name: "", size: [1, 2, 3] },
    { name: "Bad", size: [1, "2", 3] },
    { name: "Plain", size: [1, 1, 1], origin: [0, NaN, 0], low: [0, 0, 0] },
  ]), [
    { name: "Body", size: [1, 2, 3], origin: [0, 0, 1], low: [0, 0, 0], high: [1, 1, 1], mesh: "Body", materials: 1 },
    { name: "Plain", size: [1, 1, 1] },
  ]);
});
