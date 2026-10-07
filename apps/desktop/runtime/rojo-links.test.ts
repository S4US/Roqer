import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RojoLinksStore } from "./rojo-links";

async function withFile(run: (file: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-rojo-links-"));
  try {
    await run(path.join(directory, "rojo-links.json"), directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("a remembered link and recent project round-trip through a reopened store", async () => {
  await withFile(async (file) => {
    const store = new RojoLinksStore({ file });
    await store.remember("place:111", "/projects/one/default.project.json");
    await store.touchRecent("/projects/one/default.project.json");
    const saved = await store.get();
    assert.equal(saved.links.length, 1);
    assert.equal(saved.links[0].instanceId, "place:111");
    assert.equal(saved.links[0].projectFile, "/projects/one/default.project.json");
    assert.equal(typeof saved.links[0].linkedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(saved.links[0].linkedAt)));
    assert.deepEqual(saved.recent, ["/projects/one/default.project.json"]);

    const reopened = new RojoLinksStore({ file });
    assert.deepEqual(await reopened.get(), saved);

    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600, "the links file is written mode 0o600");
  });
});

test("only place:<id> instance ids are ever remembered", async () => {
  await withFile(async (file) => {
    const store = new RojoLinksStore({ file });
    await store.remember("anon:9f1c2e3a-b4d5-4e6f-8a9b-0c1d2e3f4a5b", "/projects/anon/default.project.json");
    assert.deepEqual((await store.get()).links, []);
  });
});

test("remembering an instance id again replaces its earlier link", async () => {
  await withFile(async (file) => {
    const store = new RojoLinksStore({ file });
    await store.remember("place:1", "/projects/old/default.project.json");
    await store.remember("place:1", "/projects/new/default.project.json");
    const saved = await store.get();
    assert.equal(saved.links.length, 1);
    assert.equal(saved.links[0].projectFile, "/projects/new/default.project.json");
  });
});

test("remembering a project under a new instance drops that project's entry under its old instance", async () => {
  await withFile(async (file) => {
    const store = new RojoLinksStore({ file });
    await store.remember("place:1", "/projects/one/default.project.json");
    await store.remember("place:2", "/projects/one/default.project.json");
    const saved = await store.get();
    assert.equal(saved.links.length, 1, "one project cannot be stored as linked to two places");
    assert.equal(saved.links[0].instanceId, "place:2");
    assert.equal(saved.links[0].projectFile, "/projects/one/default.project.json");
  });
});

test("at most 200 links and 5 recent projects are kept, newest kept over oldest", async () => {
  await withFile(async (file) => {
    const store = new RojoLinksStore({ file });
    for (let i = 0; i < 201; i += 1) await store.remember(`place:${i}`, `/projects/${i}/default.project.json`);
    const links = (await store.get()).links;
    assert.equal(links.length, 200);
    assert.equal(links.some((link) => link.instanceId === "place:0"), false, "the oldest link was dropped");
    assert.equal(links.some((link) => link.instanceId === "place:200"), true);

    for (let i = 0; i < 6; i += 1) await store.touchRecent(`/projects/${i}/default.project.json`);
    assert.deepEqual((await store.get()).recent, [
      "/projects/5/default.project.json",
      "/projects/4/default.project.json",
      "/projects/3/default.project.json",
      "/projects/2/default.project.json",
      "/projects/1/default.project.json",
    ]);
  });
});

test("touching a recent project already in the list moves it to the front instead of duplicating it", async () => {
  await withFile(async (file) => {
    const store = new RojoLinksStore({ file });
    await store.touchRecent("/projects/a/default.project.json");
    await store.touchRecent("/projects/b/default.project.json");
    await store.touchRecent("/projects/a/default.project.json");
    assert.deepEqual((await store.get()).recent, [
      "/projects/a/default.project.json",
      "/projects/b/default.project.json",
    ]);
  });
});

test("forgetting an instance removes its link and is a no-op for one that was never linked", async () => {
  await withFile(async (file) => {
    const store = new RojoLinksStore({ file });
    await store.remember("place:1", "/projects/one/default.project.json");
    await store.forget("place:1");
    assert.deepEqual((await store.get()).links, []);
    await store.forget("place:never-linked"); // never throws
  });
});

test("a damaged file is renamed aside and the store starts empty, without touching other remembered data", async () => {
  await withFile(async (file, directory) => {
    await fs.writeFile(file, "{not json", "utf8");
    const store = new RojoLinksStore({ file });
    assert.deepEqual(await store.get(), { links: [], recent: [] });

    const entries = await fs.readdir(directory);
    const damaged = entries.find((name) => name.startsWith("rojo-links.json.damaged-"));
    assert.ok(damaged, `expected a damaged-aside file among ${entries.join(", ")}`);
    const damagedContents = await fs.readFile(path.join(directory, damaged!), "utf8");
    assert.equal(damagedContents, "{not json");

    // The store still works and writes a fresh file from here.
    await store.remember("place:1", "/projects/one/default.project.json");
    assert.equal((await store.get()).links.length, 1);
  });
});

test("a structurally wrong file (wrong version, bad shapes) is also treated as damaged", async () => {
  await withFile(async (file, directory) => {
    await fs.writeFile(file, JSON.stringify({ version: 2, links: [], recent: [] }), "utf8");
    const store = new RojoLinksStore({ file });
    assert.deepEqual(await store.get(), { links: [], recent: [] });
    const entries = await fs.readdir(directory);
    assert.ok(entries.some((name) => name.startsWith("rojo-links.json.damaged-")));
  });
});

test("a missing file starts empty with no damaged file produced", async () => {
  await withFile(async (file, directory) => {
    const store = new RojoLinksStore({ file });
    assert.deepEqual(await store.get(), { links: [], recent: [] });
    const entries = await fs.readdir(directory).catch(() => []);
    assert.equal(entries.length, 0);
  });
});
