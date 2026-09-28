import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RunEvidence } from "../shared/run-events";
import {
  inlineStoredPictures, PICTURE_DIRECTORY, PICTURE_GRACE_MS, pictureRefs, PictureStore, storeInlinePictures,
} from "./picture-store";

const JPEG_START = [0xff, 0xd8, 0xff, 0xe0];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function jpeg(tag: string): string {
  return `data:image/jpeg;base64,${Buffer.from([...JPEG_START, ...Buffer.from(tag)]).toString("base64")}`;
}

function png(tag: string): string {
  return `data:image/png;base64,${Buffer.from([...PNG_START, ...Buffer.from(tag)]).toString("base64")}`;
}

async function withStore(run: (store: PictureStore, root: string, clock: { now: number }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "roqer-pictures-"));
  const clock = { now: Date.now() };
  try {
    await run(new PictureStore(root, () => clock.now), root, clock);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Make a stored file look as old as `ms` before the clock. */
async function age(store: PictureStore, name: string, clock: { now: number }, ms: number): Promise<void> {
  const when = new Date(clock.now - ms);
  await utimes(join(store.directory, name), when, when);
}

test("a picture is stored once under the hash of its bytes and read back as it was", async () => withStore(async (store) => {
  const ref = await store.put(jpeg("sword"));
  assert.match(ref ?? "", /^[0-9a-f]{64}\.jpg$/);
  assert.equal(await store.put(jpeg("sword")), ref, "the same picture is the same file");
  assert.deepEqual(await store.read(ref), { ok: true, dataUrl: jpeg("sword") });
  const pngRef = await store.put(png("shield"));
  assert.match(pngRef ?? "", /\.png$/);
  assert.deepEqual(await store.read(pngRef), { ok: true, dataUrl: png("shield") });
  assert.equal((await readdir(store.directory)).length, 2);
}));

test("only a bounded PNG or JPEG, whose bytes are what its type says, is stored", async () => withStore(async (store) => {
  assert.equal(await store.put("https://example.com/shot.jpg"), undefined);
  assert.equal(await store.put(`data:image/jpeg;base64,${Buffer.from("not a jpeg").toString("base64")}`), undefined);
  assert.equal(await store.put(`data:image/jpeg;base64,${"A".repeat(200 * 1024)}`), undefined);
  assert.deepEqual(await readdir(store.directory).catch(() => []), []);
}));

test("a ref names a picture, never a path, and a file that is not the picture it names is refused", async () => withStore(async (store, root) => {
  const ref = await store.put(jpeg("sword"));
  assert.ok(ref);
  for (const bad of ["../workspace-manifest.json", `..\\${ref}`, ref.replace(".jpg", ".gif"), ref.toUpperCase(), "", 3, null]) {
    assert.deepEqual(await store.read(bad), { ok: false, reason: "invalid" }, String(bad));
  }
  // Another picture's bytes under this picture's name: damaged, not served.
  await writeFile(join(store.directory, ref), Buffer.from([...JPEG_START, ...Buffer.from("tampered")]));
  assert.deepEqual(await store.read(ref), { ok: false, reason: "invalid" });
  // Storing it again repairs it.
  assert.equal(await store.put(jpeg("sword")), ref);
  assert.equal((await store.read(ref)).ok, true);
  assert.deepEqual(await store.read("0".repeat(64) + ".jpg"), { ok: false, reason: "missing" });
  assert.equal(store.directory, join(root, PICTURE_DIRECTORY));
}));

test("clean-up removes a picture no chat refers to, once it is past the grace and no run holds it", async () => withStore(async (store, _root, clock) => {
  const kept = await store.put(jpeg("kept"));
  const orphan = await store.put(jpeg("orphan"));
  const fresh = await store.put(jpeg("fresh"));
  const held = await store.put(jpeg("held"));
  assert.ok(kept && orphan && fresh && held);
  for (const name of [kept, orphan, held]) await age(store, name, clock, PICTURE_GRACE_MS + 1_000);
  await writeFile(join(store.directory, `${orphan}.left-behind.tmp`), "half");
  await age(store, `${orphan}.left-behind.tmp`, clock, PICTURE_GRACE_MS + 1_000);
  await writeFile(join(store.directory, "notes.txt"), "not ours");
  await age(store, "notes.txt", clock, PICTURE_GRACE_MS + 1_000);
  store.hold([held]);

  assert.equal(await store.collect(new Set([kept])), 1);
  assert.deepEqual((await readdir(store.directory)).sort(), [kept, fresh, held, "notes.txt"].sort());

  // Released, it goes like any other; held twice, it needs releasing twice.
  store.hold([held]);
  store.release([held]);
  assert.equal(await store.collect(new Set([kept])), 0);
  store.release([held]);
  assert.equal(await store.collect(new Set([kept])), 1);
}));

test("storing a picture that is already there marks it fresh, so a clean-up running then keeps it", async () => withStore(async (store, _root, clock) => {
  const ref = await store.put(jpeg("again"));
  assert.ok(ref);
  await age(store, ref, clock, PICTURE_GRACE_MS + 1_000);
  assert.equal(await store.put(jpeg("again")), ref);
  assert.equal(await store.collect(new Set()), 0);
}));

function workspace(evidence: RunEvidence[]) {
  return {
    projects: [{ chats: [{ messages: [{ id: "m" }, { id: "r", run: { runId: "run", evidence } }] }] }],
  };
}

test("inline pictures move to the store and back, and a workspace with none is left the same object", async () => withStore(async (store) => {
  const shot: RunEvidence = { id: "s", kind: "screenshot", title: "Studio", imageDataUrl: jpeg("studio") };
  const log: RunEvidence = { id: "l", kind: "logs", title: "Output" };
  const state = workspace([shot, log]);

  const moved = await storeInlinePictures(state, store);
  const evidence = moved.projects[0].chats[0].messages[1].run?.evidence ?? [];
  assert.equal(evidence[0].imageDataUrl, undefined);
  assert.match(evidence[0].imageRef ?? "", /\.jpg$/);
  assert.equal(evidence[1], log, "evidence with no picture is untouched");
  assert.equal(moved.projects[0].chats[0].messages[0], state.projects[0].chats[0].messages[0]);
  assert.deepEqual([...pictureRefs(moved)], [evidence[0].imageRef]);
  assert.equal(await storeInlinePictures(moved, store), moved, "nothing left to move");

  const back = await inlineStoredPictures(moved, store);
  assert.deepEqual(back.projects[0].chats[0].messages[1].run?.evidence[0], shot);

  // A picture whose file is gone keeps its ref: one was taken.
  await rm(store.directory, { recursive: true, force: true });
  assert.equal(await inlineStoredPictures(moved, store), moved);
}));
