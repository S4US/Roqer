import assert from "node:assert/strict";
import test from "node:test";
import { closeChatGrid, createChatGrid, nextChatGridId, placeGridChat } from "./chat-grids";

test("new grids reuse the first free number after grids are closed", () => {
  const grids = [createChatGrid(1), createChatGrid(2), createChatGrid(3)];
  assert.equal(nextChatGridId(grids), 4);
  assert.equal(nextChatGridId(closeChatGrid(grids, 2)), 2);
  assert.equal(nextChatGridId(closeChatGrid(closeChatGrid(grids, 2), 3)), 2);
  assert.equal(nextChatGridId([createChatGrid(3), createChatGrid(2)]), 1);
  assert.equal(nextChatGridId([]), 1);
});

test("each grid owns its positions and layout, and a chat may appear in several grids", () => {
  const first = { ...createChatGrid(1), size: 2 as const };
  const original = [first, createChatGrid(2)];
  const next = placeGridChat(placeGridChat(original, 1, 0, "a"), 2, 5, "a");
  assert.equal(next[0].slots[0], "a");
  assert.equal(next[1].slots[5], "a");
  assert.equal(next[0].size, 2);
  assert.equal(original[0].slots[0], null);
  const cleared = placeGridChat(next, 1, 0, null);
  assert.equal(cleared[0].slots[0], null);
  assert.equal(cleared[1].slots[5], "a");
});

test("closing a grid keeps other grids and always leaves one usable layout", () => {
  const first = createChatGrid(1);
  const second = createChatGrid(2);
  assert.deepEqual(closeChatGrid([first, second], 1), [second]);
  assert.deepEqual(closeChatGrid(placeGridChat([first], 1, 0, "a"), 1), [first]);
});
