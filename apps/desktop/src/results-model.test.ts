import assert from "node:assert/strict";
import test from "node:test";
import { ANIMATION_NAME_LABEL, ANIMATION_PREVIEW_TITLE, BLENDER_PREVIEW_TITLE, SCREENSHOT_VIEW_LABEL, SCREENSHOT_VIEW_PLAYTEST, type RunChange, type RunEvidence } from "../shared/run-events";
import { groupChangesByTarget } from "./diff-view";
import {
  arrivedTab, initialResultsView, openingTab, rememberResults, resultsSummary, runResults, settleFileDefaults, shownTab, uploadEntry,
  type ResultsTabInfo, type ResultsViewState,
} from "./results-model";

const image = "data:image/jpeg;base64,QUJD";

function script(id: string, target: string, added: number, removed: number): RunChange {
  return { id, kind: "script-source", target, summary: "Edited", diff: "+x", addedLines: added, removedLines: removed };
}

function upload(id: string, assetId: string, extra: Partial<RunChange> = {}): RunChange {
  return {
    id,
    kind: "asset",
    target: `rbxassetid://${assetId}`,
    summary: `Uploaded “Sword ${assetId}” to Roblox as asset ${assetId}. Moderation: Approved.`,
    assetId,
    assetUrl: `https://create.roblox.com/store/asset/${assetId}`,
    assetType: "Model",
    moderationState: "Approved",
    ...extra,
  };
}

function shot(id: string, extra: Partial<RunEvidence> = {}): RunEvidence {
  return { id, kind: "screenshot", title: "Studio screenshot", imageDataUrl: image, ...extra };
}

const tabIds = (tabs: readonly ResultsTabInfo[]) => tabs.map((tab) => tab.id);

test("a run with nothing to show has no tabs and opens on nothing", () => {
  const results = runResults([], [{ id: "check", kind: "verification", title: "Read back", passed: true }]);
  assert.deepEqual(results.tabs, []);
  assert.equal(openingTab(results.tabs), null);
  assert.equal(shownTab(results.tabs, "changes", "previews"), null);
});

test("uploads get their own tab, apart from the files the run changed", () => {
  const results = runResults([
    script("s1", "game.ServerScriptService.Main", 4, 1),
    upload("u1", "101"),
    { id: "i1", kind: "instance", target: "game.Workspace.Rack", summary: "Built Rack" },
    upload("u2", "102"),
  ], []);
  assert.deepEqual(tabIds(results.tabs), ["changes", "uploads"]);
  assert.deepEqual(results.files.map((group) => group.target), ["game.ServerScriptService.Main", "game.Workspace.Rack"]);
  assert.deepEqual(results.uploads.map((group) => group.target), ["rbxassetid://101", "rbxassetid://102"]);
  assert.equal(results.tabs[1].count, 2);
});

test("the Changes tab counts files and each file's latest write, not every write summed", () => {
  const results = runResults([
    script("a1", "game.A", 90, 0),
    script("a2", "game.A", 3, 2),
    script("b1", "game.B", 5, 1),
  ], []);
  assert.deepEqual(results.tabs[0], { id: "changes", count: 2, added: 8, removed: 3 });
});

function animation(id: string): RunEvidence {
  return shot(id, { title: ANIMATION_PREVIEW_TITLE, metadata: [{ label: ANIMATION_NAME_LABEL, value: "Slash" }] });
}

test("pictures are counted the way their panel shows them: an animation's versions are one", () => {
  const results = runResults([], [animation("v1"), animation("v2"), { id: "log", kind: "logs", title: "Output" }]);
  assert.deepEqual(results.tabs, [{ id: "previews", count: 1 }]);
});

test("screenshots and previews of what the run built get a tab each", () => {
  const playtest = shot("p1", { metadata: [{ label: SCREENSHOT_VIEW_LABEL, value: SCREENSHOT_VIEW_PLAYTEST }] });
  const blender = shot("b1", { title: BLENDER_PREVIEW_TITLE });
  const results = runResults([], [shot("s1"), blender, animation("v1"), playtest, animation("v2")]);
  assert.deepEqual(results.tabs, [{ id: "screenshots", count: 2 }, { id: "previews", count: 2 }]);
  assert.deepEqual(tabIds(runResults([], [shot("s1")]).tabs), ["screenshots"]);
  assert.deepEqual(tabIds(runResults([], [blender]).tabs), ["previews"]);
});

test("a finished run opens on its previews, then its screenshots, then its code, then its uploads", () => {
  const all = runResults([script("s", "game.A", 1, 0), upload("u", "1")], [shot("p"), animation("a")]).tabs;
  assert.deepEqual(tabIds(all), ["changes", "uploads", "screenshots", "previews"]);
  assert.equal(openingTab(all), "previews");
  assert.equal(openingTab(runResults([script("s", "game.A", 1, 0)], [shot("p")]).tabs), "screenshots");
  assert.equal(openingTab(runResults([script("s", "game.A", 1, 0), upload("u", "1")], []).tabs), "changes");
  assert.equal(openingTab(runResults([upload("u", "1")], []).tabs), "uploads");
});

test("a live run follows whatever arrived last", () => {
  const before = runResults([script("s", "game.A", 1, 0)], []).tabs;
  assert.equal(arrivedTab(before, before), null);
  assert.equal(arrivedTab(before, runResults([script("s", "game.A", 1, 0), upload("u", "1")], []).tabs), "uploads");
  assert.equal(arrivedTab(before, runResults([script("s", "game.A", 1, 0)], [shot("p")]).tabs), "screenshots");
  assert.equal(arrivedTab(before, runResults([script("s", "game.A", 1, 0)], [animation("a")]).tabs), "previews");
  // A second write to a file already listed adds no file, so nothing new arrived.
  assert.equal(arrivedTab(before, runResults([script("s", "game.A", 1, 0), script("s2", "game.A", 2, 0)], []).tabs), null);
  assert.equal(arrivedTab([], before), "changes");
});

test("the reader's tab wins over the followed one, and a tab that no longer exists gives way", () => {
  const tabs = runResults([script("s", "game.A", 1, 0), upload("u", "1")], [shot("p")]).tabs;
  assert.equal(shownTab(tabs, "uploads", "screenshots"), "uploads");
  assert.equal(shownTab(tabs, null, "changes"), "changes");
  const noPictures = runResults([script("s", "game.A", 1, 0)], []).tabs;
  assert.equal(shownTab(noPictures, "screenshots", "uploads"), "changes");
});

test("the card's summary counts each kind in words", () => {
  const tabs = runResults([script("s", "game.A", 1, 0), upload("u1", "1"), upload("u2", "2")], [shot("p"), animation("a")]).tabs;
  assert.equal(resultsSummary(tabs), "1 file, 2 uploads, 1 screenshot, 1 preview");
});

test("an upload tile reads its name from the host's summary and its state from moderation", () => {
  const [group] = groupChangesByTarget([upload("u", "555", { moderationState: "MODERATION_STATE_REVIEWING" })]);
  assert.deepEqual(uploadEntry(group), {
    key: "rbxassetid://555",
    name: "Sword 555",
    type: "Model",
    assetId: "555",
    assetUrl: "https://create.roblox.com/store/asset/555",
    moderation: { label: "Reviewing", tone: "pending" },
    writes: 1,
  });
});

test("an upload without a name, type or moderation still says what it is and nothing it does not know", () => {
  const [group] = groupChangesByTarget([{
    id: "u", kind: "asset", target: "rbxassetid://9", summary: "Uploaded the asset to Roblox as asset 9.", assetId: "9",
  }]);
  const entry = uploadEntry(group);
  assert.equal(entry.name, "Asset 9");
  assert.equal(entry.type, "Asset");
  assert.equal(entry.moderation, undefined);
  assert.equal(entry.assetUrl, undefined);
});

test("moderation reads the same whatever case or prefix Roblox used", () => {
  const tone = (state: string) => uploadEntry(groupChangesByTarget([upload("u", "1", { moderationState: state })])[0]).moderation;
  assert.deepEqual(tone("Approved"), { label: "Approved", tone: "approved" });
  assert.deepEqual(tone("MODERATION_STATE_REJECTED"), { label: "Rejected", tone: "rejected" });
  assert.deepEqual(tone("something_new"), { label: "Something new", tone: "unknown" });
});

test("uploading to the same asset twice is one tile that says so", () => {
  const groups = groupChangesByTarget([upload("u1", "7"), upload("u2", "7", { moderationState: "Rejected" })]);
  assert.equal(groups.length, 1);
  const entry = uploadEntry(groups[0]);
  assert.equal(entry.writes, 2);
  assert.equal(entry.moderation?.tone, "rejected");
});

test("a run's card is remembered by run id, newest last, and the oldest is forgotten past the bound", () => {
  const memory = new Map<string, ResultsViewState>();
  const view = (tab: "changes" | "previews") => ({ ...initialResultsView([], false), picked: tab });
  rememberResults(memory, "a", view("changes"), 2);
  rememberResults(memory, "b", view("changes"), 2);
  rememberResults(memory, "a", view("previews"), 2);
  rememberResults(memory, "c", view("changes"), 2);
  assert.deepEqual([...memory.keys()], ["a", "c"]);
  assert.equal(memory.get("a")?.picked, "previews");
});

test("a finished run's card starts where its tabs say, folded when it is an earlier run", () => {
  const tabs = runResults([script("s", "game.A", 1, 0)], [shot("p")]).tabs;
  assert.deepEqual(initialResultsView(tabs, true), {
    open: false, picked: null, following: "screenshots", visited: [], versions: {}, files: {},
  });
});

test("a lone file opens; a second file arriving starts folded and leaves the first open", () => {
  const first = settleFileDefaults({}, ["game.A"]);
  assert.deepEqual(first, { "game.A": true });
  const second = settleFileDefaults(first, ["game.A", "game.B"]);
  assert.deepEqual(second, { "game.A": true, "game.B": false });
  assert.equal(settleFileDefaults(second, ["game.A", "game.B"]), second);
  assert.deepEqual(settleFileDefaults({}, ["game.A", "game.B"]), { "game.A": false, "game.B": false });
  // A file the reader closed stays closed.
  assert.deepEqual(settleFileDefaults({ "game.A": false }, ["game.A"]), { "game.A": false });
});
