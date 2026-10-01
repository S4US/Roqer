import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMATION_BOXES_LABEL, ANIMATION_NAME_LABEL, ANIMATION_PREVIEW_TITLE, ANIMATION_RIG_LABEL, BLENDER_MODEL_LABEL, BLENDER_PREVIEW_TITLE, RIG_RANGE_SHEET_TITLE, SCREENSHOT_VIEW_LABEL,
  SCREENSHOT_VIEW_PLAYTEST, type RunChange, type RunEvidence,
} from "../shared/run-events";
import {
  animationRigCaption, hasModelPreview, keptPreviewIds, previewBoxesNote, previewCaption, previewLayout, previewSource, previewSourceLabel, previewSubject, previewTileLabel,
  previewVersions, shortTarget,
} from "./preview-layout";

const image = "data:image/jpeg;base64,QUJD";

function shot(id: string, extra: Partial<RunEvidence> = {}): RunEvidence {
  return { id, kind: "screenshot", title: "Studio screenshot", passed: true, imageDataUrl: image, ...extra };
}

const shots = (count: number) => Array.from({ length: count }, (_, index) => shot(`shot-${index}`));

test("no pictures lay out as nothing, one alone and two side by side", () => {
  assert.equal(previewLayout([]), null);
  assert.deepEqual(previewLayout(shots(1)), { kind: "single", tiles: [{ index: 0, evidence: shots(1)[0] }] });
  const pair = previewLayout(shots(2));
  assert.equal(pair?.kind, "pair");
  assert.deepEqual(pair?.kind === "pair" ? pair.tiles.map((tile) => tile.index) : [], [0, 1]);
});

test("the newest picture leads and the earlier ones sit beside it, oldest first", () => {
  for (const count of [3, 4]) {
    const layout = previewLayout(shots(count));
    assert.equal(layout?.kind, "lead");
    if (layout?.kind !== "lead") return;
    assert.equal(layout.lead.index, count - 1);
    assert.deepEqual(layout.rail.map((tile) => tile.index), Array.from({ length: count - 1 }, (_, index) => index));
    assert.ok(layout.rail.every((tile) => tile.hidden === undefined));
  }
});

test("past four pictures the last rail tile counts what it stands for", () => {
  const five = previewLayout(shots(5));
  const six = previewLayout(shots(6));
  assert.ok(five?.kind === "lead" && six?.kind === "lead");
  if (five?.kind !== "lead" || six?.kind !== "lead") return;
  assert.equal(five.lead.index, 4);
  assert.deepEqual(five.rail.map((tile) => [tile.index, tile.hidden]), [[0, undefined], [1, undefined], [2, 2]]);
  assert.equal(six.lead.index, 5);
  assert.deepEqual(six.rail.map((tile) => [tile.index, tile.hidden]), [[0, undefined], [1, undefined], [2, 3]]);
  assert.equal(previewTileLabel(six.rail[2], 6), "Open image 3 of 6, Studio screenshot, and 2 more");
  assert.equal(previewTileLabel(six.lead, 6), "Open image 6 of 6, Studio screenshot");
});

test("a picture is labelled by where the host says it came from", () => {
  const blender: RunEvidence = { id: "b", kind: "inspection", title: BLENDER_PREVIEW_TITLE, imageDataUrl: image };
  const playtest = shot("p", { metadata: [{ label: SCREENSHOT_VIEW_LABEL, value: SCREENSHOT_VIEW_PLAYTEST }] });
  const other: RunEvidence = { id: "o", kind: "inspection", title: "Interface", imageDataUrl: image };
  assert.deepEqual([blender, playtest, shot("s"), other].map(previewSource), ["blender", "playtest", "studio", "other"]);
  assert.deepEqual([blender, playtest, shot("s"), other].map(previewSourceLabel), [
    "Blender · before upload", "Playtest", "Studio", "Interface",
  ]);
});

test("an animation's contact sheet is labelled with its rig, and opens in 3D when its model was kept", () => {
  const sheet: RunEvidence = { id: "a", kind: "inspection", title: ANIMATION_PREVIEW_TITLE, imageDataUrl: image };
  const on = (rig: string): RunEvidence => ({ ...sheet, metadata: [{ label: ANIMATION_RIG_LABEL, value: rig }] });
  assert.equal(previewSource(sheet), "animation");
  // A preview recorded before its rig was is labelled without one.
  assert.equal(previewSourceLabel(sheet), "Animation");
  assert.equal(previewSourceLabel(on("R15")), "Animation · R15");
  assert.equal(previewSourceLabel(on("R6")), "Animation · R6");
  // A model's own rig by the model's name.
  assert.equal(previewSourceLabel(on("game.Workspace.Dog")), "Animation · Dog");
  assert.deepEqual([sheet, on("R6"), on("game.Workspace.Dog")].map(animationRigCaption), ["its rig", "the R6 rig", "Dog's own rig"]);
  assert.equal(hasModelPreview(sheet), false);
  assert.equal(hasModelPreview({ ...sheet, modelPreviewId: "a1b2c3d4-0" }), true);
});

test("previews of one animation are versions of one picture, shown where the latest was taken", () => {
  const wave = (id: string) => ({
    id, kind: "inspection", title: ANIMATION_PREVIEW_TITLE, imageDataUrl: image,
    modelPreviewId: `a1b2c3d4-${id}`, metadata: [{ label: ANIMATION_NAME_LABEL, value: "Wave" }],
  }) satisfies RunEvidence;
  const walk: RunEvidence = { ...wave("w"), metadata: [{ label: ANIMATION_NAME_LABEL, value: "Walk" }] };
  const unnamed: RunEvidence = { id: "u", kind: "inspection", title: ANIMATION_PREVIEW_TITLE, imageDataUrl: image };
  const images = [wave("1"), shot("s"), wave("2"), walk, unnamed, wave("3")];
  const { shown, versions } = previewVersions(images);
  // The screenshot, then the walk and the unnamed preview, then the wave at its latest.
  assert.deepEqual(shown.map((item) => item.id), ["s", "w", "u", "3"]);
  assert.deepEqual(versions.get("3")?.map((item) => item.id), ["1", "2", "3"]);
  assert.equal(versions.size, 1);
  // The latest version leads the card, as the newest picture does.
  const layout = previewLayout(shown);
  assert.equal(layout?.kind === "lead" ? layout.lead.evidence.id : undefined, "3");
  assert.equal(
    previewTileLabel({ index: 3, evidence: shown[3] }, 4, 3),
    `Open image 4 of 4, ${ANIMATION_PREVIEW_TITLE}, 3 versions, with a 3D view`,
  );
  // A Blender result named like an animation is still its own picture.
  const blender: RunEvidence = { ...wave("b"), title: BLENDER_PREVIEW_TITLE };
  assert.equal(previewVersions([blender, wave("4")]).shown.length, 2);
});

test("previews of one Blender model, by the file it was written to, are versions of one picture", () => {
  const model = (id: string, file?: string): RunEvidence => ({
    id, kind: "inspection", title: BLENDER_PREVIEW_TITLE, imageDataUrl: image,
    ...(file === undefined ? {} : { metadata: [{ label: BLENDER_MODEL_LABEL, value: file }] }),
  });
  const images = [model("sword-1", "sword.glb"), model("shield", "shield.glb"), shot("s"), model("sword-2", "sword.glb"), model("old-a"), model("old-b")];
  const { shown, versions } = previewVersions(images);
  assert.deepEqual(shown.map((item) => item.id), ["shield", "s", "sword-2", "old-a", "old-b"]);
  assert.deepEqual(versions.get("sword-2")?.map((item) => item.id), ["sword-1", "sword-2"]);
  // Previews saved before models were named each stay a picture of their own.
  assert.equal(versions.size, 1);
  // A model and an animation of the same name are different things.
  const wave: RunEvidence = { id: "w", kind: "inspection", title: ANIMATION_PREVIEW_TITLE, imageDataUrl: image, metadata: [{ label: ANIMATION_NAME_LABEL, value: "sword.glb" }] };
  assert.equal(previewSubject(wave) === previewSubject(model("x", "sword.glb")), false);
});

test("the picture budget keeps the latest of every thing before any earlier version", () => {
  const wave = (id: string): RunEvidence => ({
    id, kind: "inspection", title: ANIMATION_PREVIEW_TITLE, imageDataUrl: image, metadata: [{ label: ANIMATION_NAME_LABEL, value: "Wave" }],
  });
  const images = [shot("a"), wave("w1"), shot("b"), wave("w2"), wave("w3"), wave("w4"), shot("c")];
  assert.deepEqual([...keptPreviewIds(images, 4)].sort(), ["a", "b", "c", "w4"]);
  // Room left over goes to the newest earlier versions.
  assert.deepEqual([...keptPreviewIds(images, 6)].sort(), ["a", "b", "c", "w2", "w3", "w4"]);
  // More distinct things than room: the newest things win.
  assert.deepEqual([...keptPreviewIds(images, 2)].sort(), ["c", "w4"]);
  assert.equal(keptPreviewIds(images, 0).size, 0);
  assert.equal(keptPreviewIds(images, 99).size, images.length);
});

test("an animation's preview or a rig's range sheet that drew parts as boxes says so, and nothing else does", () => {
  const boxes = { label: ANIMATION_BOXES_LABEL, value: "Octopus (it has 30000 triangles; a preview draws a mesh of at most 20000)" };
  const animation: RunEvidence = { id: "a", kind: "inspection", title: ANIMATION_PREVIEW_TITLE, imageDataUrl: image, metadata: [boxes] };
  const range: RunEvidence = { id: "b", kind: "inspection", title: RIG_RANGE_SHEET_TITLE, imageDataUrl: image, metadata: [boxes] };
  const note = "Drawn as boxes, not their meshes: Octopus (it has 30000 triangles; a preview draws a mesh of at most 20000)";
  assert.equal(previewBoxesNote(animation), note);
  assert.equal(previewBoxesNote(range), note);
  // Every part drawn as itself, or a preview recorded before boxes were noted.
  assert.equal(previewBoxesNote({ ...animation, metadata: [] }), undefined);
  assert.equal(previewBoxesNote({ ...animation, metadata: undefined }), undefined);
  // Only an animation's or a rig's preview is drawn by the MCP from a rig.
  assert.equal(previewBoxesNote(shot("c", { metadata: [boxes] })), undefined);
  assert.equal(previewBoxesNote({ ...animation, title: BLENDER_PREVIEW_TITLE }), undefined);
});

test("a rig's range sheet is its own source, labelled by the model, and each model's sheets are versions of one", () => {
  const sheet = (id: string, model: string): RunEvidence => ({
    id, kind: "inspection", title: RIG_RANGE_SHEET_TITLE, imageDataUrl: image, subject: model,
    metadata: [{ label: ANIMATION_RIG_LABEL, value: model }],
  });
  const first = sheet("a", "game.Workspace.Dog");
  assert.equal(previewSource(first), "rig");
  assert.equal(previewSourceLabel(first), "Range sheet · Dog");
  const again = sheet("b", "game.Workspace.Dog");
  const other = sheet("c", "game.Workspace.Wolf");
  const { shown, versions } = previewVersions([first, again, other]);
  assert.deepEqual(shown.map((item) => item.id), ["b", "c"]);
  assert.deepEqual(versions.get("b")?.map((item) => item.id), ["a", "b"]);
});

test("only a Blender result with a kept model opens in 3D, and its tile says so", () => {
  const blender: RunEvidence = { id: "b", kind: "inspection", title: BLENDER_PREVIEW_TITLE, imageDataUrl: image };
  const withModel = { ...blender, modelPreviewId: "a1b2c3d4-0" };
  assert.equal(hasModelPreview(blender), false);
  assert.equal(hasModelPreview(withModel), true);
  // The id alone is not enough: a 3D view belongs to a Blender result.
  assert.equal(hasModelPreview(shot("s", { modelPreviewId: "a1b2c3d4-0" })), false);
  assert.equal(previewTileLabel({ index: 0, evidence: withModel }, 2), `Open image 1 of 2, ${BLENDER_PREVIEW_TITLE}, with a 3D view`);
  assert.equal(previewTileLabel({ index: 0, evidence: blender }, 2), `Open image 1 of 2, ${BLENDER_PREVIEW_TITLE}`);
  // A tile standing for several pictures is labelled by its count alone.
  assert.equal(previewTileLabel({ index: 2, evidence: withModel, hidden: 3 }, 6), `Open image 3 of 6, ${BLENDER_PREVIEW_TITLE}, and 2 more`);
});

test("the caption says when a picture was taken, from what the host recorded", () => {
  const changes: RunChange[] = [
    { id: "c1", kind: "instance", target: "game.Workspace.Handcart", summary: "Built" },
    { id: "c2", kind: "asset", target: "rbxassetid://123", summary: "Uploaded", assetId: "123" },
    { id: "c3", kind: "script-source", target: "game.ServerScriptService.Main", summary: "Edited" },
    { id: "c4", kind: "properties", target: "game.Workspace.Part", summary: "Set" },
  ];
  const playtest = [{ label: SCREENSHOT_VIEW_LABEL, value: SCREENSHOT_VIEW_PLAYTEST }];
  assert.equal(previewCaption(shot("a"), changes), undefined);
  assert.equal(previewCaption(shot("a", { metadata: playtest }), changes), "Taken during the playtest");
  assert.equal(previewCaption(shot("a", { afterChangeId: "c1" }), changes), "Taken after building Workspace.Handcart");
  assert.equal(
    previewCaption(shot("a", { afterChangeId: "c1", metadata: playtest }), changes),
    "Taken during the playtest, after building Workspace.Handcart",
  );
  assert.equal(previewCaption(shot("a", { afterChangeId: "c2" }), changes), "Taken after uploading asset 123");
  assert.equal(previewCaption(shot("a", { afterChangeId: "c3" }), changes), "Taken after editing ServerScriptService.Main");
  assert.equal(previewCaption(shot("a", { afterChangeId: "c4" }), changes), "Taken after setting properties on Workspace.Part");
  // A change the record no longer holds is not guessed at.
  assert.equal(previewCaption(shot("a", { afterChangeId: "gone" }), changes), undefined);
});

test("long targets keep their last two parts", () => {
  assert.equal(shortTarget("game.Workspace.Handcart"), "Workspace.Handcart");
  assert.equal(shortTarget("rbxassetid://123"), "rbxassetid://123");
  assert.equal(
    shortTarget("game.Workspace.Village.Market.Stalls.NorthRow.FruitStall.Awning"),
    "…FruitStall.Awning",
  );
});
