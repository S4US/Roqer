import assert from "node:assert/strict";
import test from "node:test";
import {
  describeRecording, formatSeconds, pickStudioSource, recordingMetadata, recordingOf, RECORDING_FIELD, sheetLabels, sheetTimes,
} from "./playtest-recording";

test("the Studio window is picked over Roqer's own and a multiplayer server's", () => {
  const sources = [
    { id: "w1", name: "Roqer" },
    { id: "w2", name: "Obby - Roblox Studio (Server)" },
    { id: "w3", name: "Obby - Roblox Studio" },
    { id: "w4", name: "Visual Studio Code" },
  ];
  assert.equal(pickStudioSource(sources)?.id, "w3");
  assert.equal(pickStudioSource(sources.filter((source) => source.id !== "w3"))?.id, "w2", "the server when it is the only Studio window");
  assert.equal(pickStudioSource([{ id: "w1", name: "Roqer" }, { id: "w4", name: "Notepad" }]), undefined);
  assert.equal(pickStudioSource([]), undefined);
});

test("sheet frames are spread over the recording, each in the middle of its share, and never more than four a second", () => {
  assert.deepEqual(sheetTimes(12, 4), [1.5, 4.5, 7.5, 10.5]);
  assert.equal(sheetTimes(60).length, 12);
  assert.deepEqual(sheetTimes(1), [0.13, 0.38, 0.63, 0.88]);
  assert.deepEqual(sheetTimes(0.3), [0.15]);
  assert.deepEqual(sheetTimes(0), []);
  assert.deepEqual(sheetTimes(Number.NaN), []);
  assert.deepEqual(sheetLabels([0.5, 12, 75]), ["1 · 0.5s", "2 · 12s", "3 · 1m 15s"]);
  assert.equal(formatSeconds(9.96), "10.0s");
});

test("a stop result's recording is read field by field, and described for the evidence and the model", () => {
  const summary = { path: "C:/roqer/playtest-recordings/run/playtest-1.webm", durationSeconds: 14.2, width: 1280, height: 720, bytes: 3 * 1024 * 1024, frames: [1, 5, 9, 13] };
  assert.deepEqual(recordingOf({ ok: true, [RECORDING_FIELD]: summary }), summary);
  assert.deepEqual(recordingOf({ [RECORDING_FIELD]: { skipped: "no-window" } }), { skipped: "no-window" });
  assert.equal(recordingOf({ [RECORDING_FIELD]: { skipped: "whatever" } }), undefined);
  assert.equal(recordingOf({ [RECORDING_FIELD]: { path: "", durationSeconds: 1, width: 1, height: 1, bytes: 1 } }), undefined);
  assert.equal(recordingOf({ [RECORDING_FIELD]: { path: "x", durationSeconds: "1", width: 1, height: 1, bytes: 1 } }), undefined);
  assert.equal(recordingOf({}), undefined);
  assert.equal(recordingOf("no"), undefined);
  assert.deepEqual(recordingMetadata(summary), { label: "Recording", value: "14s · 1280×720 · 3.0 MB" });
  assert.deepEqual(recordingMetadata({ skipped: "too-short" }), { label: "Recording", value: "Not recorded: the playtest stopped before half a second had been captured." });
  const described = describeRecording(summary, true);
  assert.match(described, /recorded the Studio window for 14s/);
  assert.match(described, /4 frames spread over the recording/);
  assert.match(described, /1\.0s, 5\.0s, 9\.0s, 13s/);
  assert.match(described, /not of what the code did/);
  assert.match(describeRecording(summary, false), /No frames could be read/);
  assert.match(describeRecording({ skipped: "capture-failed" }, false), /recorded nothing of this playtest/);
});
