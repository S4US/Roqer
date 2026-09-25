import assert from "node:assert/strict";
import test from "node:test";

import {
  judgeKitProbe, judgeKitVariant, KIT_PIECES, KIT_PROBE_SEED, KIT_VARIANTS, kitFileProblem, kitProbeAnswer,
} from "./kits";

/** One MeshPart per piece, where Roblox put it, as the readback reports them. */
const arrived = (offsetX = 0, overrides: (piece: (typeof KIT_PIECES)[number]) => object = () => ({})) => [
  { class: "Model", name: "Roqer kit probe" },
  ...KIT_PIECES.map((piece) => ({
    class: "MeshPart",
    name: piece.name,
    size: [...piece.size],
    position: [piece.x + offsetX, 8, 90],
    color: [255, 255, 255],
    vertex: { total: 36, distinct: 2, sample: [] },
    ...overrides(piece),
  })),
];

test("kit probe - three pieces arriving as three coloured, full-size MeshParts in their layout is a working kit set", () => {
  const finding = judgeKitVariant("shared", arrived(25));
  assert.equal(finding.result, "separate");
  assert.equal(finding.layoutKept, true, "a shift of the whole set still keeps the layout");
  assert.ok(finding.pieces.every((piece) => piece.matchedBy === "name" && piece.coloured === "yes" && piece.sizeMatches));
  assert.equal(kitProbeAnswer([finding]), "One upload carries a whole kit set, even with one shared material.");
});

test("kit probe - pieces Roblox renamed are still recognised by their size", () => {
  const finding = judgeKitVariant("separate", arrived(0, (piece) => ({ name: `${piece.name}Paint`.replace("Kit", "Mesh") })));
  assert.equal(finding.result, "separate");
  assert.deepEqual(finding.pieces.map((piece) => piece.matchedBy), ["size", "size", "size"]);
});

test("kit probe - one merged MeshPart, lost colours or a wrong size are not a working kit set", () => {
  const merged = judgeKitVariant("shared", [{ class: "MeshPart", name: "KitCliff", size: [22.4, 9.25, 4.4], position: [0, 8, 90] }]);
  assert.equal(merged.result, "merged");
  assert.match(merged.detail, /1 MeshPart\(s\) for 3 pieces/);

  const white = judgeKitVariant("shared", arrived(0, () => ({ vertex: { total: 36, distinct: 1, sample: [] } })));
  const shrunk = judgeKitVariant("separate", arrived(0, (piece) => (piece.name === "KitTree" ? { size: [1, 2.3, 1] } : {})));
  assert.equal(white.pieces[0].coloured, "no");
  assert.equal(shrunk.pieces[1].sizeMatches, false);
  assert.equal(kitProbeAnswer([white, shrunk]), "One upload does not carry a kit set intact; upload each piece on its own.");
  assert.equal(kitProbeAnswer([merged, judgeKitVariant("separate", arrived())]),
    "One upload carries a whole kit set if each piece has its own material.");
});

test("kit probe - a piece moved out of its place in the set breaks the layout", () => {
  const finding = judgeKitVariant("shared", arrived(0, (piece) => (piece.name === "KitRock" ? { position: [0, 8, 90] } : {})));
  assert.equal(finding.result, "separate");
  assert.equal(finding.layoutKept, false);
});

test("kit probe - files are checked before upload, and the seed makes a holder for each upload", () => {
  const good = { attributes: ["COLOR_0", "POSITION"], images: 0, baseColorTextures: 0, meshes: 3 };
  assert.equal(kitFileProblem(KIT_VARIANTS[0], { ...good, materials: 1 }), undefined);
  assert.equal(kitFileProblem(KIT_VARIANTS[1], { ...good, materials: 3 }), undefined);
  assert.match(kitFileProblem(KIT_VARIANTS[1], { ...good, materials: 1 }) ?? "", /1 materials, not 3/);
  assert.match(kitFileProblem(KIT_VARIANTS[0], { ...good, meshes: 1, materials: 1 }) ?? "", /1 meshes/);
  assert.match(kitFileProblem(KIT_VARIANTS[0], { ...good, attributes: ["POSITION"], materials: 1 }) ?? "", /no COLOR_0/);
  for (const variant of KIT_VARIANTS) assert.match(KIT_PROBE_SEED, new RegExp(`Name = "${variant.id}"`));
  assert.deepEqual(judgeKitProbe({ found: false }).map((finding) => finding.result), ["other", "other"]);
});
