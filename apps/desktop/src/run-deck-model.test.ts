import assert from "node:assert/strict";
import test from "node:test";
import { deckTarget, finishedDeckStatus } from "./run-deck-model";

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

test("the heading says how a run really ended, not only that it did", () => {
  assert.deepEqual(finishedDeckStatus("completed", true, false), { label: "Done", detail: "Applied and verified in Studio", tone: "done" });
  assert.deepEqual(finishedDeckStatus("completed", false, false), { label: "Done", tone: "done" });
  assert.equal(finishedDeckStatus("completed", false, true).tone, "warning");
  assert.equal(finishedDeckStatus("failed", false, false).label, "Failed");
  assert.equal(finishedDeckStatus("cancelled", false, false).label, "Stopped");
});
