import assert from "node:assert/strict";
import test from "node:test";

import { connectedStudios, defaultInstanceId, resolveInstanceId, type StudioStatus } from "./studio-status";

function status(instances: StudioStatus["instances"]): StudioStatus {
  return { kind: "connected", endpoint: "http://127.0.0.1:58741", message: "Studio connected", instances };
}

test("one Studio in a playtest is one connection, not three", () => {
  // The bridge reports a session per plugin, so a playtest arrives as an edit
  // session, a server and a client under one instance id.
  const studios = connectedStudios(status([
    { instanceId: "place:1", role: "edit", placeName: "Tower Defense", isRunning: false },
    { instanceId: "place:1", role: "server", placeName: "Tower Defense", isRunning: true },
    { instanceId: "place:1", role: "client-1", placeName: "Tower Defense", isRunning: true },
  ]));

  assert.equal(studios.length, 1);
  assert.equal(studios[0].name, "Tower Defense");
  assert.deepEqual([...studios[0].roles], ["edit", "server", "client-1"]);
  // Any session playtesting makes the place a playtest, whatever the edit
  // session says about itself.
  assert.equal(studios[0].isRunning, true);
  assert.equal(studios[0].isTarget, true);
});

test("two places are two connections, and only the first is the target", () => {
  const studios = connectedStudios(status([
    { instanceId: "place:1", role: "edit", placeName: "Tower Defense", isRunning: false },
    { instanceId: "place:2", role: "edit", placeName: "Obby", isRunning: false },
  ]));

  assert.deepEqual(studios.map((studio) => studio.name), ["Tower Defense", "Obby"]);
  // Whichever plugin connected first is where a run goes, which is exactly the
  // thing a customer with two places open cannot otherwise see.
  assert.deepEqual(studios.map((studio) => studio.isTarget), [true, false]);
  assert.equal(defaultInstanceId(status([
    { instanceId: "place:1", role: "edit", isRunning: false },
    { instanceId: "place:2", role: "edit", isRunning: false },
  ])), "place:1");
});

test("an unsaved place is still named something a person can read", () => {
  const studios = connectedStudios(status([
    { instanceId: "session-a", role: "edit", isRunning: false },
    { instanceId: "session-a", role: "server", placeName: "  Draft  ", isRunning: false },
  ]));

  assert.equal(studios.length, 1);
  // The name arrives on whichever session has one, not necessarily the first.
  assert.equal(studios[0].name, "Draft");
});

test("a chosen place wins over connection order, and the list agrees", () => {
  const open = status([
    { instanceId: "place:1", role: "edit", placeName: "Tower Defense", isRunning: false },
    { instanceId: "place:2", role: "edit", placeName: "Obby", isRunning: false },
  ]);

  assert.equal(resolveInstanceId(open, "place:2"), "place:2");
  const studios = connectedStudios(open, "place:2");
  assert.deepEqual(studios.map((studio) => studio.isTarget), [false, true]);
});

test("a chosen place that is not open falls back without being forgotten", () => {
  const open = status([
    { instanceId: "place:1", role: "edit", placeName: "Tower Defense", isRunning: false },
  ]);

  // The choice is remembered across restarts, so it routinely names a window
  // that is not open yet. Failing the run over that would be useless.
  assert.equal(resolveInstanceId(open, "place:9"), "place:1");
  assert.deepEqual(connectedStudios(open, "place:9").map((studio) => studio.isTarget), [true]);
  // With nothing connected there is nothing to fall back to either.
  assert.equal(resolveInstanceId(status([]), "place:9"), null);
  // And no choice still means the first to connect.
  assert.equal(resolveInstanceId(open, null), "place:1");
});

test("nothing connected is an empty list rather than a placeholder row", () => {
  assert.deepEqual(connectedStudios(status([])), []);
  assert.deepEqual(connectedStudios({
    kind: "offline",
    endpoint: "http://127.0.0.1:58741",
    message: "MCP is not running",
  }), []);
});
