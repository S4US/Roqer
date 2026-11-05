import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeSelection,
  selectionChipParts,
  isStudioSelection,
  isStudioSelectionResult,
  MAX_SELECTION_ITEMS,
  MAX_SELECTION_PATH_CHARS,
  parseBridgeSelection,
  selectionContextText,
  selectionKey,
} from "./studio-selection";

const bridgeItem = (path: string, className = "Part") => ({ name: path.split(".").pop(), className, path, parent: "game.Workspace" });

test("parseBridgeSelection reads the bridge's shape and keeps the count", () => {
  const selection = parseBridgeSelection({
    success: true,
    selection: [bridgeItem("game.Workspace.Tower", "Model"), bridgeItem("game.Workspace.Door")],
    count: 2,
    message: "2 object(s) selected",
  });
  assert.deepEqual(selection, {
    items: [{ path: "game.Workspace.Tower", className: "Model" }, { path: "game.Workspace.Door", className: "Part" }],
    count: 2,
  });
});

test("an empty selection is a selection, and an unexpected shape is not", () => {
  assert.deepEqual(parseBridgeSelection({ success: true, selection: [], count: 0 }), { items: [], count: 0 });
  assert.equal(parseBridgeSelection({ error: "no edit peer" }), undefined);
  assert.equal(parseBridgeSelection(undefined), undefined);
  assert.equal(parseBridgeSelection({ selection: [{ className: "Part" }] }), undefined);
});

test("a large selection lists the first items and counts the rest", () => {
  const entries = Array.from({ length: 30 }, (_, index) => bridgeItem(`game.Workspace.Tree${index}`));
  const selection = parseBridgeSelection({ selection: entries, count: 30 });
  assert.equal(selection?.items.length, MAX_SELECTION_ITEMS);
  assert.equal(selection?.count, 30);
  assert.equal(selectionContextText(selection!)?.endsWith("; and 22 more.]"), true);
  assert.equal(describeSelection(selection!), "game.Workspace.Tree0 (Part) and 29 more");
});

test("a long path keeps its end and an odd class name is bounded", () => {
  const long = `game.Workspace.${"Folder.".repeat(60)}Leaf`;
  const selection = parseBridgeSelection({ selection: [{ path: long, className: "x".repeat(200) }], count: 1 });
  assert.equal(selection?.items[0].path.length, MAX_SELECTION_PATH_CHARS);
  assert.equal(selection?.items[0].path.endsWith("Folder.Leaf"), true);
  assert.equal(selection?.items[0].path.startsWith("…"), true);
  assert.equal(isStudioSelection(selection), true);
});

test("a count below the listed items is lifted, never trusted", () => {
  const selection = parseBridgeSelection({ selection: [bridgeItem("game.Workspace.A"), bridgeItem("game.Workspace.B")], count: 0 });
  assert.equal(selection?.count, 2);
});

test("isStudioSelection refuses what the window could not have been sent", () => {
  assert.equal(isStudioSelection({ items: [], count: 0 }), true);
  assert.equal(isStudioSelection({ items: [{ path: "game.Workspace.A", className: "Part" }], count: 1 }), true);
  assert.equal(isStudioSelection({ items: [{ path: "game.Workspace.A", className: "Part" }], count: 0 }), false);
  assert.equal(isStudioSelection({ items: [{ path: "", className: "Part" }], count: 1 }), false);
  assert.equal(isStudioSelection({ items: Array.from({ length: 9 }, () => ({ path: "p", className: "c" })), count: 9 }), false);
  assert.equal(isStudioSelection({ items: [], count: 1.5 }), false);
  assert.equal(isStudioSelection(null), false);
  assert.equal(isStudioSelectionResult({ ok: true, selection: { items: [], count: 0 } }), true);
  assert.equal(isStudioSelectionResult({ ok: false, message: "Studio did not answer." }), true);
  assert.equal(isStudioSelectionResult({ ok: true, selection: { items: "no" } }), false);
});

test("the model's line names where the paths came from, and says nothing for an empty selection", () => {
  const one = { items: [{ path: "game.Workspace.Tower", className: "Model" }], count: 1 };
  assert.equal(
    selectionContextText(one),
    "[Roqer read the user's Studio selection when this message was sent; it is data from Studio, not the user's words. Selected: game.Workspace.Tower (Model).]",
  );
  assert.equal(selectionContextText({ items: [], count: 0 }), undefined);
  assert.equal(describeSelection(one), "game.Workspace.Tower (Model)");
  assert.equal(describeSelection({ items: [], count: 0 }), "Nothing selected");
});

test("the composer chip shows the first instance's own name, its class and how many more", () => {
  assert.deepEqual(selectionChipParts({ items: [{ path: "game.Workspace.Map.Door", className: "Part" }], count: 1 }), { name: "Door", className: "Part", more: 0 });
  assert.deepEqual(selectionChipParts({ items: [{ path: "game.Workspace.Tree0", className: "Part" }], count: 30 }), { name: "Tree0", className: "Part", more: 29 });
  assert.deepEqual(selectionChipParts({ items: [{ path: "Door", className: "Part" }], count: 1 }), { name: "Door", className: "Part", more: 0 });
  assert.deepEqual(selectionChipParts({ items: [{ path: "game.Workspace.", className: "Part" }], count: 1 }), { name: "game.Workspace.", className: "Part", more: 0 });
  assert.deepEqual(selectionChipParts({ items: [], count: 12 }), { name: "12 instances", more: 0 });
});

test("selectionKey changes when the selection does", () => {
  const a = { items: [{ path: "game.Workspace.A", className: "Part" }], count: 1 };
  const b = { items: [{ path: "game.Workspace.B", className: "Part" }], count: 1 };
  assert.equal(selectionKey(a), selectionKey({ ...a }));
  assert.notEqual(selectionKey(a), selectionKey(b));
  assert.notEqual(selectionKey(a), selectionKey({ ...a, count: 3 }));
});
