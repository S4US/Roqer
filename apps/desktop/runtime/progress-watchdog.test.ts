import assert from "node:assert/strict";
import test from "node:test";

import { describeStall, watchProgress } from "./progress-watchdog";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a model that says nothing is reported stalled", async () => {
  const watchdog = watchProgress(new AbortController().signal, 20);
  await wait(60);
  assert.equal(watchdog.signal.aborted, true);
  assert.equal(watchdog.stalled, true);
  watchdog.stop();
});

test("progress restarts the interval", async () => {
  const watchdog = watchProgress(new AbortController().signal, 40);
  for (let index = 0; index < 4; index += 1) {
    await wait(20);
    watchdog.progressed();
  }
  assert.equal(watchdog.signal.aborted, false);
  watchdog.stop();
});

/**
 * An approval, a question, or a playtest can keep a tool call open for as long
 * as the user takes. That is Roqer waiting, not the model being stuck.
 */
test("a held clock does not stall however long the hold lasts", async () => {
  const watchdog = watchProgress(new AbortController().signal, 20);
  const releaseOuter = watchdog.hold();
  const releaseInner = watchdog.hold();
  await wait(60);
  releaseInner();
  await wait(60);
  assert.equal(watchdog.signal.aborted, false, "one hold is still open");
  releaseOuter();
  releaseOuter();
  await wait(60);
  assert.equal(watchdog.stalled, true, "the interval restarts once nothing holds it");
  watchdog.stop();
});

test("a cancelled run aborts the signal without calling it a stall", () => {
  const run = new AbortController();
  const watchdog = watchProgress(run.signal, 1_000);
  run.abort();
  assert.equal(watchdog.signal.aborted, true);
  assert.equal(watchdog.stalled, false);
  watchdog.stop();
});

test("a stall after changes says they were left in place", () => {
  assert.match(describeStall(300, []), /Nothing was changed in Studio/);
  assert.match(
    describeStall(300, [{ id: "c1", kind: "properties", target: "game.Workspace.Part", summary: "s" }]),
    /1 change had already been applied and is left in place \(game\.Workspace\.Part\)/,
  );
});
