import assert from "node:assert/strict";
import test from "node:test";

import { boundedMessage, createLogGate, watchEventLoop } from "./window-diagnostics";

test("a long console line is kept to a bounded length and says how much was cut", () => {
  assert.equal(boundedMessage("short"), "short");
  assert.equal(boundedMessage("x".repeat(12), 10), `${"x".repeat(10)}… (2 more characters)`);
});

test("errors are written up to a limit each minute, and the rest are counted", () => {
  let clock = 0;
  const gate = createLogGate(2, () => clock);
  assert.deepEqual(gate("one"), ["one"]);
  assert.deepEqual(gate("two"), ["two"]);
  assert.deepEqual(gate("three"), []);
  assert.deepEqual(gate("four"), []);
  clock = 60_000;
  assert.deepEqual(gate("five"), ["2 more errors were not logged in the last minute", "five"]);
  clock = 120_000;
  // Nothing was held back in that minute, so nothing is reported.
  assert.deepEqual(gate("six"), ["six"]);
  gate("seven");
  gate("eight");
  clock = 180_000;
  assert.deepEqual(gate("nine"), ["1 more error was not logged in the last minute", "nine"]);
});

test("a main process blocked past the threshold is reported with how long it was blocked", () => {
  let clock = 0;
  let tick: () => void = () => undefined;
  const stalls: number[] = [];
  const stop = watchEventLoop({
    onStall: (blocked) => stalls.push(blocked),
    now: () => clock,
    schedule: (callback) => {
      tick = callback;
      return { stop: () => { tick = () => undefined; } };
    },
  });
  clock = 1_000; tick();
  clock = 2_050; tick();
  assert.deepEqual(stalls, []);
  // The timer was due at 3,050 and arrived at 8,050: blocked for five seconds.
  clock = 8_050; tick();
  assert.deepEqual(stalls, [5_000]);
  stop();
  clock = 20_000; tick();
  assert.deepEqual(stalls, [5_000]);
});
