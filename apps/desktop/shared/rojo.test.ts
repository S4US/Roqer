import assert from "node:assert/strict";
import test from "node:test";

import { isPlaceInstanceId, isRojoResult, rojoPillState } from "./rojo";

test("isPlaceInstanceId only accepts published place ids", () => {
  assert.equal(isPlaceInstanceId("place:12345"), true);
  assert.equal(isPlaceInstanceId("anon:9f1c2e3a-b4d5-4e6f-8a9b-0c1d2e3f4a5b"), false);
  assert.equal(isPlaceInstanceId("place:"), false);
  assert.equal(isPlaceInstanceId("place:12a"), false);
});

test("rojoPillState picks every row of the design spec's table", () => {
  assert.equal(rojoPillState({ connected: false, linked: false, answering: false, errored: false }), "no-place");
  assert.equal(rojoPillState({ connected: false, linked: true, answering: true, errored: true }), "no-place", "no place beats everything else");
  assert.equal(rojoPillState({ connected: true, linked: false, answering: false, errored: false }), "not-linked");
  assert.equal(rojoPillState({ connected: true, linked: false, answering: true, errored: false }), "detected");
  assert.equal(rojoPillState({ connected: true, linked: true, answering: true, errored: false }), "linked-running");
  assert.equal(rojoPillState({ connected: true, linked: true, answering: false, errored: false }), "linked-stopped");
  assert.equal(rojoPillState({ connected: true, linked: true, answering: true, errored: true }), "error", "a failed attempt wins over a stale linked/answering memory");
});

test("isRojoResult accepts only well-formed results", () => {
  assert.equal(isRojoResult({ ok: false, message: "Rojo was not found." }), true);
  assert.equal(isRojoResult({
    ok: true,
    view: { instanceId: "place:1", published: true, state: "no-place", recent: [] },
  }), true);
  assert.equal(isRojoResult({
    ok: true,
    view: {
      instanceId: "place:1", published: true, state: "linked-running",
      project: { fileName: "default.project.json", folder: "/x", rojoVersion: "7.6.1", scripts: { file: 1, generated: 0, unsupported: 0 }, problems: [] },
      server: { port: 34872, answering: true, projectName: "X" },
      recent: [{ index: 0, fileName: "default.project.json", folder: "/x" }],
    },
  }), true);

  assert.equal(isRojoResult(null), false);
  assert.equal(isRojoResult({ ok: false }), false, "a false result needs a message");
  assert.equal(isRojoResult({ ok: true, view: { instanceId: 1, published: true, state: "no-place", recent: [] } }), false, "instanceId must be a string or null");
  assert.equal(isRojoResult({ ok: true, view: { instanceId: null, published: true, state: "sideways", recent: [] } }), false, "state must be one of the known kinds");
  assert.equal(isRojoResult({ ok: true, view: { instanceId: null, published: true, state: "no-place", recent: "none" } }), false, "recent must be an array");
  assert.equal(
    isRojoResult({ ok: true, view: { instanceId: null, published: true, state: "no-place", recent: [], project: { fileName: "a" } } }),
    false,
    "a project view still needs a folder",
  );
});
