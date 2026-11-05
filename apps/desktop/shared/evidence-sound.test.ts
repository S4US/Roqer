import assert from "node:assert/strict";
import test from "node:test";
import { isEvidenceSound, isEvidenceSoundResult, MAX_EVIDENCE_SOUND_CHARACTERS } from "./evidence-sound";

test("a sound is a bounded data URL in one of the stored formats", () => {
  assert.equal(isEvidenceSound("data:audio/mpeg;base64,QUJD"), true);
  assert.equal(isEvidenceSound("data:audio/ogg;base64,QUJD"), true);
  assert.equal(isEvidenceSound("data:audio/wav;base64,QUJD"), true);
  assert.equal(isEvidenceSound("data:audio/flac;base64,QUJD"), true);
  assert.equal(isEvidenceSound("data:audio/midi;base64,QUJD"), false);
  assert.equal(isEvidenceSound("data:image/png;base64,QUJD"), false);
  assert.equal(isEvidenceSound(`data:audio/mpeg;base64,${"A".repeat(MAX_EVIDENCE_SOUND_CHARACTERS)}`), false);
  assert.equal(isEvidenceSound(42), false);
});

test("a sound result is a sound or a named failure", () => {
  assert.equal(isEvidenceSoundResult({ ok: true, dataUrl: "data:audio/wav;base64,QUJD" }), true);
  assert.equal(isEvidenceSoundResult({ ok: true, dataUrl: "data:image/png;base64,QUJD" }), false);
  assert.equal(isEvidenceSoundResult({ ok: false, reason: "missing" }), true);
  assert.equal(isEvidenceSoundResult({ ok: false, reason: "gone" }), false);
  assert.equal(isEvidenceSoundResult(null), false);
});
