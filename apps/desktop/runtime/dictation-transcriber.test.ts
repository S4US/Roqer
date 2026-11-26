import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DICTATION_SAMPLES } from "../shared/dictation";
import { DictationTranscriber, type DictationProcess } from "./dictation-transcriber";

/** A transcribing process that records what it is sent and answers when told to. */
function fakeProcess() {
  const sent: Array<{ id: number; modelPath: string; pcm: ArrayBuffer }> = [];
  let message: (value: unknown) => void = () => undefined;
  let exit: () => void = () => undefined;
  let killed = false;
  const process: DictationProcess = {
    postMessage: (value) => { sent.push(value as (typeof sent)[number]); },
    kill: () => { killed = true; },
    onMessage: (listener) => { message = listener; },
    onExit: (listener) => { exit = listener; },
  };
  return { process, sent, answer: (value: unknown) => message(value), die: () => exit(), get killed() { return killed; } };
}

/** Timers that fire only when told to. */
function fakeTimers() {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    setTimeout: (callback: () => void, ms: number) => { timers.set(next, { callback, ms }); return next++; },
    clearTimeout: (handle: unknown) => { timers.delete(handle as number); },
    fire: (ms: number) => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); } },
    pending: () => [...timers.values()].map((timer) => timer.ms).sort((a, b) => a - b),
  };
}

function setup() {
  const processes: Array<ReturnType<typeof fakeProcess>> = [];
  const timers = fakeTimers();
  const transcriber = new DictationTranscriber({
    start: () => { const started = fakeProcess(); processes.push(started); return started.process; },
    idleMs: 1_000, timeoutMs: 50, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  return { transcriber, processes, timers };
}

test("a recording starts the process once, and its words come back", async () => {
  const { transcriber, processes, timers } = setup();
  assert.equal(transcriber.running, false);
  // A view into a larger buffer: only its own samples are sent.
  const backing = new Float32Array([9, 0.25, -0.5, 9]);
  const first = transcriber.transcribe("model.gguf", backing.subarray(1, 3));
  assert.equal(processes.length, 1);
  assert.equal(transcriber.running, true);
  assert.equal(processes[0].sent[0].modelPath, "model.gguf");
  assert.deepEqual([...new Float32Array(processes[0].sent[0].pcm)], [0.25, -0.5]);

  processes[0].answer({ id: processes[0].sent[0].id, ok: true, text: "Bonjour." });
  assert.deepEqual(await first, { ok: true, text: "Bonjour." });

  const second = transcriber.transcribe("model.gguf", new Float32Array([0.1]));
  assert.equal(processes.length, 1, "the same process takes the next recording");
  processes[0].answer({ id: processes[0].sent[1].id, ok: false, message: "bad audio" });
  assert.deepEqual(await second, { ok: false, message: "The recording could not be transcribed: bad audio" });
  // An answer nobody waits for is ignored.
  processes[0].answer({ id: 999, ok: true, text: "late" });
  processes[0].answer("nonsense");
  assert.deepEqual(timers.pending(), [1_000], "only the idle timer is left");
});

test("the process is stopped after a while without a recording, and started again for the next", async () => {
  const { transcriber, processes, timers } = setup();
  const first = transcriber.transcribe("model.gguf", new Float32Array([0.1]));
  processes[0].answer({ id: processes[0].sent[0].id, ok: true, text: "one" });
  await first;
  timers.fire(1_000);
  assert.equal(processes[0].killed, true);
  assert.equal(transcriber.running, false);

  const second = transcriber.transcribe("model.gguf", new Float32Array([0.1]));
  assert.equal(processes.length, 2);
  processes[1].answer({ id: processes[1].sent[0].id, ok: true, text: "two" });
  assert.deepEqual(await second, { ok: true, text: "two" });
});

test("a process that dies or hangs fails the recordings waiting on it", async () => {
  const { transcriber, processes, timers } = setup();
  const dying = transcriber.transcribe("model.gguf", new Float32Array([0.1]));
  processes[0].die();
  assert.deepEqual(await dying, { ok: false, message: "The dictation process stopped unexpectedly. Try again." });
  assert.equal(transcriber.running, false);

  const hanging = transcriber.transcribe("model.gguf", new Float32Array([0.1]));
  timers.fire(50);
  assert.deepEqual(await hanging, { ok: false, message: "Transcribing took too long and was stopped." });
  assert.equal(processes[1].killed, true);
  // The dead process's late words go nowhere.
  processes[1].answer({ id: processes[1].sent[0].id, ok: true, text: "too late" });
  assert.deepEqual(timers.pending(), []);
});

test("nothing recorded, too much recorded, and a process that cannot start are refused plainly", async () => {
  const { transcriber, processes } = setup();
  assert.deepEqual(await transcriber.transcribe("model.gguf", new Float32Array(0)), { ok: false, message: "Nothing was recorded." });
  assert.deepEqual(await transcriber.transcribe("model.gguf", new Float32Array(MAX_DICTATION_SAMPLES + 1)), { ok: false, message: "The recording is too long to transcribe." });
  assert.equal(processes.length, 0);

  const broken = new DictationTranscriber({ start: () => { throw new Error("no such file"); } });
  assert.deepEqual(await broken.transcribe("model.gguf", new Float32Array([0.1])), { ok: false, message: "Dictation could not start: no such file" });
});
