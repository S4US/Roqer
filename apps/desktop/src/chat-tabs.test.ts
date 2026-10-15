import assert from "node:assert/strict";
import test from "node:test";
import { reconcileChatTabs, closeChatTab, placeChat } from "./chat-tabs";

test("layout placement fills, replaces, clears and swaps without duplicating chats", () => {
  assert.deepEqual(placeChat(["a", null, "b"], 1, "c"), ["a", "c", "b"]);
  assert.deepEqual(placeChat(["a", null, "b"], 2, "a"), ["b", null, "a"]);
  assert.deepEqual(placeChat(["a", null, "b"], 1, "a"), [null, "a", "b"]);
  assert.deepEqual(placeChat(["a", null], 0, "c"), ["c", null]);
  assert.deepEqual(placeChat(["a", "b"], 0, null), [null, "b"]);
  assert.deepEqual(placeChat(["a", "b"], 0, "a"), ["a", "b"]);
  assert.deepEqual(placeChat(["a"], 6, "b"), ["a"]);
});

test("tabs keep their order, open the selection once and discard deleted chats", () => {
  assert.deepEqual(reconcileChatTabs(["a", "b"], new Set(["a", "b", "c"]), "c"), ["a", "b", "c"]);
  assert.deepEqual(reconcileChatTabs(["a", "b"], new Set(["b"]), "b"), ["b"]);
  const tabs = ["a", "b"];
  assert.equal(reconcileChatTabs(tabs, new Set(tabs), "a"), tabs);
  assert.deepEqual(reconcileChatTabs(tabs, new Set(tabs), null), tabs);
});

test("closing a tab picks its neighbour only when it was selected", () => {
  assert.deepEqual(closeChatTab(["a", "b", "c"], "b", "b"), { tabs: ["a", "c"], selected: "c" });
  assert.deepEqual(closeChatTab(["a", "b"], "b", "a"), { tabs: ["a"], selected: "a" });
  assert.deepEqual(closeChatTab(["a", "b"], "a", "b"), { tabs: ["b"], selected: "b" });
  assert.deepEqual(closeChatTab(["a"], "a", "a"), { tabs: [], selected: null });
});
