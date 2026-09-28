import assert from "node:assert/strict";
import test from "node:test";
import {
  BLENDER_PREVIEW_TITLE, SCREENSHOT_VIEW_LABEL, SCREENSHOT_VIEW_PLAYTEST, type RunChange, type RunEvidence,
} from "../shared/run-events";
import {
  previewCaption, previewLayout, previewSource, previewSourceLabel, previewTileLabel, shortTarget,
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
