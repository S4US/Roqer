import assert from "node:assert/strict";
import test from "node:test";

import type { RojoPickOutcome, RojoView } from "../shared/rojo";
import { linkRojoProject } from "./link-rojo-project";

const LINKED_VIEW: RojoView = {
  instanceId: "place:1",
  published: true,
  state: "linked-running",
  project: { fileName: "default.project.json", folder: "C:\\Games\\CreatorEmpire", rojoVersion: "7.7.0" },
  server: { port: 34872, answering: true },
  recent: [],
};

test("no place connected: refused before any dialog opens", async () => {
  let called = false;
  const outcome = await linkRojoProject(null, async () => { called = true; return { cancelled: true }; });
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /no place is connected/i);
  assert.equal(called, false);
});

test("the user cancels the picker: reported to the model as cancelled, not a failure", async () => {
  const pick = async (instanceId: string): Promise<RojoPickOutcome> => {
    assert.equal(instanceId, "place:1");
    return { cancelled: true };
  };
  const outcome = await linkRojoProject("place:1", pick);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.data, { cancelled: true });
});

test("a successful link summarises the project and whether Rojo is serving it", async () => {
  const outcome = await linkRojoProject("place:1", async () => ({ ok: true, view: LINKED_VIEW }));
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /default\.project\.json/);
  assert.match(outcome.text, /serving it on port 34872/);
  assert.deepEqual(outcome.data, { view: LINKED_VIEW });
});

test("a project that links but is not yet served says so without failing", async () => {
  const view: RojoView = { ...LINKED_VIEW, state: "linked-stopped", server: undefined };
  const outcome = await linkRojoProject("place:1", async () => ({ ok: true, view }));
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /not running yet/);
});

test("a failed link is an ok:false outcome carrying the connection's own message", async () => {
  const outcome = await linkRojoProject("place:1", async () => ({ ok: false, message: "rojo not found" }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.text, "rojo not found");
});
