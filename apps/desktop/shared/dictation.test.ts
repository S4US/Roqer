import assert from "node:assert/strict";
import test from "node:test";
import { DICTATION_MODEL, isDictationModelState, isDictationResult, withDictation } from "./dictation";

test("dictated words go after what is written, one space apart", () => {
  assert.equal(withDictation("", "Bonjour."), "Bonjour.");
  assert.equal(withDictation("Make the sign bigger.", "  Et plus rouge.  "), "Make the sign bigger. Et plus rouge.");
  assert.equal(withDictation("First line\n", "second line"), "First line\nsecond line");
  assert.equal(withDictation("Ends with a space ", "then this"), "Ends with a space then this");
  // A recording with no words in it changes nothing.
  assert.equal(withDictation("Kept", "   "), "Kept");
});

test("only well-formed model states and results are taken from the main process", () => {
  assert.equal(isDictationModelState({ kind: "missing" }), true);
  assert.equal(isDictationModelState({ kind: "ready" }), true);
  assert.equal(isDictationModelState({ kind: "failed", message: "no" }), true);
  assert.equal(isDictationModelState({ kind: "downloading", receivedBytes: 10, totalBytes: 100 }), true);
  assert.equal(isDictationModelState({ kind: "downloading", receivedBytes: 10, totalBytes: 0 }), false);
  assert.equal(isDictationModelState({ kind: "downloading", receivedBytes: -1, totalBytes: 100 }), false);
  assert.equal(isDictationModelState({ kind: "failed" }), false);
  assert.equal(isDictationModelState({ kind: "paused" }), false);
  assert.equal(isDictationModelState(null), false);

  assert.equal(isDictationResult({ ok: true, text: "" }), true);
  assert.equal(isDictationResult({ ok: false, message: "no" }), true);
  assert.equal(isDictationResult({ ok: true }), false);
  assert.equal(isDictationResult({ ok: false }), false);
  assert.equal(isDictationResult("text"), false);
});

test("the speech model is pinned to one published file", () => {
  assert.match(DICTATION_MODEL.url, /^https:\/\/huggingface\.co\//);
  assert.ok(DICTATION_MODEL.url.endsWith(DICTATION_MODEL.file));
  assert.match(DICTATION_MODEL.sha256, /^[0-9a-f]{64}$/);
  assert.ok(DICTATION_MODEL.bytes > 100_000_000);
});
