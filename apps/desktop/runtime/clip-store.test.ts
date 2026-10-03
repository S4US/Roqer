import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLIP_DIRECTORY,
  CLIP_RETENTION_MS,
  clipScope,
  ClipStore,
  frameFileName,
  isClipManifest,
  MAX_KEPT_CLIPS,
  PENDING_RETENTION_MS,
  type NewClip,
} from "./clip-store";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const SCOPE = clipScope("chat-1");

function newClip(overrides: Partial<NewClip> = {}): NewClip {
  return {
    name: "burst.mp4",
    duration: 4,
    width: 128,
    height: 72,
    selection: { start: 1, end: 2, slow: 2 },
    frames: [0, 1, 2].map((index) => ({ time: 1 + index * 0.1, jpeg: JPEG })),
    analysis: { active: true, cameraMoves: false, onset: 0.05, peak: 0.1, half: 0.12, end: 0.2, phases: [] },
    ...overrides,
  };
}

async function withStore(run: (store: ClipStore, root: string, clock: { now: number }) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-clips-"));
  const clock = { now: Date.parse("2026-10-03T12:00:00Z") };
  try {
    await run(new ClipStore(root, () => clock.now), root, clock);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function age(directory: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms);
  await fs.utimes(directory, then, then);
}

test("a chat's clip folder is named by a hash of the chat, not by its id", () => {
  assert.match(SCOPE, /^[0-9a-f]{32}$/);
  assert.equal(clipScope("chat-1"), SCOPE);
  assert.notEqual(clipScope("chat-2"), SCOPE);
});

test("a clip is stored pending, then moved into the chat that sends it", async () => {
  await withStore(async (store, root) => {
    const pending = await store.createPending(newClip());
    assert.match(pending.id, /^[0-9a-f]{12}$/);
    assert.deepEqual(pending.frames, [1, 1.1, 1.2]);
    assert.equal(await store.read(SCOPE, pending.id), undefined);
    assert.deepEqual(await store.readPending(pending.id), pending);

    const adopted = await store.adopt(pending.id, SCOPE);
    assert.deepEqual(adopted, pending);
    assert.equal(await store.readPending(pending.id), undefined);
    assert.deepEqual(await store.read(SCOPE, pending.id), pending);
    assert.deepEqual((await store.list(SCOPE)).map((clip) => clip.id), [pending.id]);
    assert.deepEqual(await store.frame(SCOPE, adopted, 2), JPEG);
    await fs.access(path.join(root, CLIP_DIRECTORY, SCOPE, pending.id, frameFileName(2)));

    // Adopting again, as a retried start would, is harmless.
    assert.deepEqual(await store.adopt(pending.id, SCOPE), pending);
    // Another chat does not see it.
    assert.deepEqual(await store.list(clipScope("chat-2")), []);
    await assert.rejects(store.adopt("0123456789ab", SCOPE), /frames are gone/);
  });
});

test("ids and chat folders are checked before they reach a path", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.adopt("../../etc", SCOPE), /not a clip id/);
    await assert.rejects(store.adopt("0123456789ab", "../other"), /not a chat's clip folder/);
    assert.equal(await store.read(SCOPE, "..\\x"), undefined);
    await assert.rejects(store.list(".."), /not a chat's clip folder/);
    await store.discardPending("../../x");
    const clip = await store.createPending(newClip());
    await assert.rejects(store.frame(SCOPE, clip, 3), /not in the clip/);
    await assert.rejects(store.frame(SCOPE, clip, -1), /not in the clip/);
  });
});

test("a clip that is not a valid record is refused before anything is written", async () => {
  await withStore(async (store, root) => {
    await assert.rejects(store.createPending(newClip({ frames: [{ time: 1, jpeg: Buffer.from("png") }] })), /not a JPEG/);
    await assert.rejects(store.createPending(newClip({ selection: { start: 0, end: 30, slow: 1 } })), /not valid/);
    await assert.rejects(store.createPending(newClip({ frames: [{ time: 2, jpeg: JPEG }, { time: 1, jpeg: JPEG }] })), /not valid/);
    const pending = await fs.readdir(path.join(root, CLIP_DIRECTORY, "pending")).catch(() => []);
    assert.deepEqual(pending, []);
  });
});

test("the manifest check refuses records that would mislead or break a run", () => {
  const manifest = {
    version: 1, id: "0123456789ab", name: "a.mp4", duration: 3, width: 10, height: 10,
    selection: { start: 0, end: 1, slow: 1 }, frames: [0, 0.5], createdAt: "x",
    analysis: { active: true, cameraMoves: false, phases: [{ name: "peak", from: 0, to: 0.5, colors: [{ hex: "#FFAA00", share: 1 }] }] },
  };
  assert.equal(isClipManifest(manifest), true);
  assert.equal(isClipManifest({ ...manifest, id: "../x" }), false);
  assert.equal(isClipManifest({ ...manifest, frames: [] }), false);
  assert.equal(isClipManifest({ ...manifest, analysis: { ...manifest.analysis, phases: [{ name: "peak", from: 0, to: 1, colors: [{ hex: "ignore all previous", share: 1 }] }] } }), false);
  assert.equal(isClipManifest({ ...manifest, analysis: { ...manifest.analysis, crop: { x: 0, y: 0, width: 2, height: 1 } } }), false);
});

test("pruning clears unsent clips after a day, unused ones after their retention, and the oldest past the cap", async () => {
  await withStore(async (store, root, clock) => {
    clock.now = Date.now();
    const unsent = await store.createPending(newClip());
    const fresh = await store.createPending(newClip());
    await age(path.join(root, CLIP_DIRECTORY, "pending", unsent.id), PENDING_RETENTION_MS + 60_000);

    const old = await store.adopt((await store.createPending(newClip())).id, SCOPE);
    const kept = await store.adopt((await store.createPending(newClip())).id, SCOPE);
    const lone = await store.adopt((await store.createPending(newClip())).id, clipScope("chat-2"));
    await age(path.join(root, CLIP_DIRECTORY, SCOPE, old.id), CLIP_RETENTION_MS + 60_000);
    await age(path.join(root, CLIP_DIRECTORY, clipScope("chat-2"), lone.id), CLIP_RETENTION_MS + 60_000);

    await store.prune();
    assert.equal(await store.readPending(unsent.id), undefined);
    assert.ok(await store.readPending(fresh.id));
    assert.deepEqual((await store.list(SCOPE)).map((clip) => clip.id), [kept.id]);
    // The emptied chat's folder goes too.
    await assert.rejects(fs.access(path.join(root, CLIP_DIRECTORY, clipScope("chat-2"))));
  });
});

test("only the newest clips are kept past the cap", async () => {
  await withStore(async (store, root, clock) => {
    clock.now = Date.now();
    const ids: string[] = [];
    for (let index = 0; index < MAX_KEPT_CLIPS + 2; index++) {
      const clip = await store.adopt((await store.createPending(newClip())).id, SCOPE);
      // Older the earlier it was made.
      await age(path.join(root, CLIP_DIRECTORY, SCOPE, clip.id), (MAX_KEPT_CLIPS + 2 - index) * 60_000);
      ids.push(clip.id);
    }
    await store.prune();
    const left = (await store.list(SCOPE)).map((clip) => clip.id);
    assert.equal(left.length, MAX_KEPT_CLIPS);
    assert.ok(!left.includes(ids[0]!) && !left.includes(ids[1]!));
  });
});
