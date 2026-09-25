import assert from "node:assert/strict";
import test from "node:test";

import { MAX_STEER_CHARS, normalizeSteer } from "./steer";

test("a note is trimmed and bounded, and multi-line text is content rather than control", () => {
  assert.equal(normalizeSteer("  Make it blue.  "), "Make it blue.");
  assert.equal(normalizeSteer("Two things:\n- blue\n- bigger\ttext\r\n"), "Two things:\n- blue\n- bigger\ttext");
  assert.equal(normalizeSteer("x".repeat(MAX_STEER_CHARS)), "x".repeat(MAX_STEER_CHARS));
});

test("nothing to queue is null, never an empty string the model would be sent", () => {
  assert.equal(normalizeSteer(""), null);
  assert.equal(normalizeSteer("   \n  "), null);
  assert.equal(normalizeSteer("x".repeat(MAX_STEER_CHARS + 1)), null);
  // The wire contract refuses control characters; better to refuse here,
  // where the person can be told, than at the gateway mid-turn.
  assert.equal(normalizeSteer("bad\u0000byte"), null);
  assert.equal(normalizeSteer("esc\u001b[0m"), null);
  assert.equal(normalizeSteer(42), null);
  assert.equal(normalizeSteer(undefined), null);
});
