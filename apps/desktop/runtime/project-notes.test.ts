import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { notesVersion, ProjectNotesStore, runProjectNotesTool } from "./project-notes";

async function withStore(body: (store: ProjectNotesStore, directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-notes-"));
  try {
    await body(new ProjectNotesStore(directory), directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("a project's notes start empty and survive a new store", () => withStore(async (store, directory) => {
  assert.deepEqual(await store.get("p1"), { memories: [], plan: "", planUpdatedAt: null });
  await store.setPlan("p1", "# Plan");
  await store.addMemory("p1", "  R6 only.  ");
  const reopened = await new ProjectNotesStore(directory).get("p1");
  assert.equal(reopened.plan, "# Plan");
  assert.deepEqual(reopened.memories.map((memory) => memory.text), ["R6 only."]);
  assert.notEqual(reopened.planUpdatedAt, null);
}));

test("an edit must name exactly one passage of the plan", () => withStore(async (store) => {
  await store.setPlan("p1", "a status: idea\nb status: idea");
  await assert.rejects(() => store.editPlan("p1", "status: idea", "status: done"), /more than once/);
  await assert.rejects(() => store.editPlan("p1", "missing", "x"), /not found/);
  await store.editPlan("p1", "a status: idea", "a status: done");
  assert.equal((await store.get("p1")).plan, "a status: done\nb status: idea");
}));

test("memories can be updated and removed by id, and a wrong id is the model's to fix", () => withStore(async (store) => {
  const added = await runProjectNotesTool(store, "p1", "project_memory", { action: "add", text: "One." });
  const id = /mem-[0-9a-f]+/.exec(added)![0];
  await runProjectNotesTool(store, "p1", "project_memory", { action: "update", id, text: "One, revised." });
  assert.match(await runProjectNotesTool(store, "p1", "project_memory", { action: "list" }), /One, revised\./);
  await assert.rejects(() => runProjectNotesTool(store, "p1", "project_memory", { action: "remove", id: "mem-nope" }), /No memory/);
  await runProjectNotesTool(store, "p1", "project_memory", { action: "remove", id });
  assert.equal((await store.get("p1")).memories.length, 0);
}));

test("a project id that is not a plain id cannot name a file", () => withStore(async (store) => {
  await assert.rejects(() => store.get("../escape"), /cannot hold notes/);
}));

test("the notes version changes with what the agent would be told, not with timestamps", () => {
  const base = { memories: [{ id: "m1", text: "A", createdAt: "x" }], plan: "P", planUpdatedAt: "t1" };
  assert.equal(notesVersion(base), notesVersion({ ...base, planUpdatedAt: "t2" }));
  assert.notEqual(notesVersion(base), notesVersion({ ...base, plan: "Q" }));
});

test("notes that cannot be read are never replaced with nothing", () => withStore(async (store, directory) => {
  // Damaged: kept aside, and the project starts fresh.
  await fs.writeFile(path.join(directory, "p1.json"), "{ not json");
  assert.deepEqual(await store.get("p1"), { memories: [], plan: "", planUpdatedAt: null });
  assert.ok((await fs.readdir(directory)).some((name) => name.startsWith("p1.json.damaged-")));

  // Unreadable for now (here a folder where the file should be): refused, and
  // a write does not go through on an empty read.
  await fs.mkdir(path.join(directory, "p2.json"));
  await assert.rejects(() => store.get("p2"), /could not be read just now/);
  await assert.rejects(() => store.addMemory("p2", "One."), /could not be read just now/);
}));
