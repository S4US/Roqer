import assert from "node:assert/strict";
import test from "node:test";

import { COLOR_CASES, COLOR_PROBE_SEED, glbProblem, judgeColorCase, judgeColorProbe, readGlbSummary } from "./colors";

/** A GLB holding only a JSON chunk, as readGlbSummary reads it. */
function glb(document: object): Buffer {
  let json = Buffer.from(JSON.stringify(document), "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.write("JSON", 16, "latin1");
  return Buffer.concat([header, json]);
}

const [texture, vertex] = COLOR_CASES;

test("colour probe - a file is checked for its colour before anything is uploaded", () => {
  const textured = readGlbSummary(glb({
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
    images: [{ mimeType: "image/png" }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  }));
  assert.deepEqual(textured, { attributes: ["POSITION", "TEXCOORD_0"], images: 1, baseColorTextures: 1, meshes: 1, materials: 1 });
  assert.equal(glbProblem(texture, textured), undefined);
  assert.match(glbProblem(vertex, textured) ?? "", /no COLOR_0/);

  const flat = readGlbSummary(glb({ meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 2 } }] }], materials: [{}] }));
  assert.equal(glbProblem(vertex, flat), undefined);
  assert.match(glbProblem(texture, flat) ?? "", /no packed base-colour texture/);
  assert.throws(() => readGlbSummary(Buffer.from("not a glb at all, really")), /not a GLB/);
});

test("colour probe - a texture counts as kept on the MeshPart or in a SurfaceAppearance, and nowhere else", () => {
  const white = { class: "MeshPart", name: "TexturedCube", color: [255, 255, 255], textureId: "" };
  assert.equal(judgeColorCase("texture", [white]).result, "dropped");
  assert.equal(judgeColorCase("texture", [{ ...white, textureId: "rbxassetid://1" }]).result, "kept");
  const surface = { class: "SurfaceAppearance", parent: "TexturedCube", colorMap: "", colorMapContent: "rbxassetid://2" };
  assert.match(judgeColorCase("texture", [white, surface]).detail, /rbxassetid:\/\/2/);
  assert.equal(judgeColorCase("texture", [{ class: "Part" }]).result, "unknown");
});

test("colour probe - vertex colours are kept only when the mesh holds more than one", () => {
  const part = (vertexRead: object) => [{ class: "MeshPart", name: "VertexCube", vertex: vertexRead }];
  assert.equal(judgeColorCase("vertex", part({ total: 24, distinct: 4, sample: ["230,26,26"] })).result, "kept");
  assert.equal(judgeColorCase("vertex", part({ total: 0, distinct: 0, sample: [] })).result, "dropped");
  assert.equal(judgeColorCase("vertex", part({ total: 24, distinct: 1, sample: ["255,255,255"] })).result, "dropped");
  const refused = judgeColorCase("vertex", part({ error: "EditableMesh is not enabled" }));
  assert.equal(refused.result, "unknown");
  assert.match(refused.detail, /screenshot/);
});

test("colour probe - the readback is judged case by case, and the seed makes a holder for each", () => {
  const findings = judgeColorProbe({ found: true, cases: { texture: [{ class: "MeshPart", textureId: "rbxassetid://9" }] } });
  assert.deepEqual(findings.map((finding) => [finding.id, finding.result]), [["texture", "kept"], ["vertex", "unknown"]]);
  for (const colorCase of COLOR_CASES) assert.match(COLOR_PROBE_SEED, new RegExp(`Name = "${colorCase.id}"`));
});
