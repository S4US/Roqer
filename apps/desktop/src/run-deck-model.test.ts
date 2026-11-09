import assert from "node:assert/strict";
import test from "node:test";
import { clampDeckWidth, DECK_MIN_WIDTH, deckTarget, targetLabel } from "./run-deck-model";

const base = { picked: null, offered: "run-2", closed: false, inline: true };

test("beside the chat, the deck shows the latest run until it is closed", () => {
  assert.equal(deckTarget(base), "run-2");
  assert.equal(deckTarget({ ...base, closed: true }), null);
  assert.equal(deckTarget({ ...base, offered: null }), null);
});

test("over the chat, the deck opens only when asked", () => {
  assert.equal(deckTarget({ ...base, inline: false }), null);
  assert.equal(deckTarget({ ...base, inline: false, picked: "run-1" }), "run-1");
});

test("a run the reader picked wins over the latest, even after closing the deck earlier", () => {
  assert.equal(deckTarget({ ...base, picked: "run-1" }), "run-1");
  assert.equal(deckTarget({ ...base, picked: "run-1", closed: true }), "run-1");
});

test("a dragged width stays between the narrowest deck and the room the chat can give up", () => {
  assert.equal(clampDeckWidth(500, 700), 500);
  assert.equal(clampDeckWidth(900, 700), 700);
  assert.equal(clampDeckWidth(100, 700), DECK_MIN_WIDTH);
  assert.equal(clampDeckWidth(500, 200), DECK_MIN_WIDTH, "a window with no room still gets a usable deck");
});

test("a file reads by its own name, with where it lives after it", () => {
  assert.deepEqual(targetLabel("game.ServerScriptService.Combat"), { name: "Combat", parent: "ServerScriptService" });
  assert.deepEqual(targetLabel("game.ReplicatedStorage.VFX.Slash"), { name: "Slash", parent: "ReplicatedStorage.VFX" });
  assert.deepEqual(targetLabel("game.Workspace"), { name: "Workspace" });
  assert.deepEqual(targetLabel("rbxassetid://123"), { name: "rbxassetid://123" });
});
