import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInitialWorkspace, normalizeWorkspace, type Chat, type WorkspaceState } from "../src/model";
import { RUN_EVENT_SCHEMA_VERSION, type RunEvidence, type RunRecord } from "../shared/run-events";
import { workspaceNeedsRecovery } from "../shared/workspace-validation";
import { PICTURE_DIRECTORY, PICTURE_GRACE_MS, PictureStore } from "./picture-store";
import { WorkspaceStore } from "./workspace-store";

async function temporaryWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "roqer-workspace-store-"));
}

function workspaceWithChats(...chats: Chat[]): WorkspaceState {
  const state = createInitialWorkspace();
  state.projects[0].chats = chats;
  state.selectedChatId = chats[0]?.id ?? null;
  return state;
}

function chat(id: string, text = "hello"): Chat {
  const date = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: id,
    createdAt: date,
    updatedAt: date,
    messages: [{ id: `message-${id}`, role: "user", text, createdAt: date }],
  };
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await temporaryWorkspace();
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("migrates a valid legacy workspace while retaining the legacy file unchanged", async () => withDirectory(async (directory) => {
  const legacy = workspaceWithChats(chat("legacy"));
  const legacyText = JSON.stringify(legacy);
  const legacyPath = join(directory, "workspace-state.json");
  await writeFile(legacyPath, legacyText, "utf8");

  const store = new WorkspaceStore(directory);
  const normalizedLegacy = normalizeWorkspace(legacy);
  assert.deepEqual(await store.load(), normalizedLegacy);
  assert.deepEqual(store.status(), { required: false, message: null });
  await store.save(legacy);

  assert.equal(await readFile(legacyPath, "utf8"), legacyText);
  assert.equal((await stat(join(directory, "workspace-manifest.json"))).isFile(), true);
  assert.deepEqual(await new WorkspaceStore(directory).load(), normalizedLegacy);
}));

test("stores aggregate history larger than the old ten megabyte limit", async () => withDirectory(async (directory) => {
  const state = workspaceWithChats(chat("large-a", "a".repeat(6 * 1024 * 1024)), chat("large-b", "b".repeat(6 * 1024 * 1024)));
  const store = new WorkspaceStore(directory);
  await store.save(state);
  const loaded = await store.load() as WorkspaceState;
  assert.equal(loaded.projects[0].chats[0].messages[0].text.length, 6 * 1024 * 1024);
  assert.equal(loaded.projects[0].chats[1].messages[0].text.length, 6 * 1024 * 1024);
  assert.equal((await readdir(join(directory, "workspace-chats"))).length, 2);
}));

test("corrupt legacy JSON locks autosave and recovery preserves a backup", async () => withDirectory(async (directory) => {
  const legacyPath = join(directory, "workspace-state.json");
  await writeFile(legacyPath, "{broken", "utf8");
  const store = new WorkspaceStore(directory);
  const salvaged = await store.load();
  assert.equal(store.status().required, true);
  await assert.rejects(store.save(salvaged), /recovery|required|valid JSON/i);
  assert.equal(await readFile(legacyPath, "utf8"), "{broken");

  await store.recover();
  assert.equal(store.status().required, false);
  const recoveryRoots = await readdir(join(directory, "workspace-recovery"));
  assert.equal(await readFile(join(directory, "workspace-recovery", recoveryRoots[0], "workspace-state.json"), "utf8"), "{broken");
  assert.equal(await readFile(legacyPath, "utf8"), "{broken");
}));

test("malformed nested records are salvaged visibly and require recovery", async () => withDirectory(async (directory) => {
  const state = workspaceWithChats(chat("good"));
  (state.projects[0].chats as unknown[]).push({ id: "bad" });
  await writeFile(join(directory, "workspace-state.json"), JSON.stringify(state), "utf8");
  const store = new WorkspaceStore(directory);
  const loaded = await store.load() as WorkspaceState;
  assert.deepEqual(loaded.projects[0].chats.map((entry) => entry.id), ["good"]);
  assert.equal(store.status().required, true);
  await assert.rejects(store.save(loaded), /malformed|recovery/i);
}));

test("a future workspace version can be exported but cannot be recovered or overwritten", async () => withDirectory(async (directory) => {
  const future = { ...createInitialWorkspace(), schemaVersion: 99 };
  const source = JSON.stringify(future);
  const legacyPath = join(directory, "workspace-state.json");
  await writeFile(legacyPath, source, "utf8");
  const store = new WorkspaceStore(directory);
  await store.load();
  assert.equal(store.status().required, true);
  await assert.rejects(store.recover(), /newer app version/i);
  await assert.rejects(store.save(createInitialWorkspace()), /newer|schema|recovery/i);
  assert.equal(await readFile(legacyPath, "utf8"), source);
  const destination = join(directory, "salvage-export.json");
  await store.export(destination);
  assert.equal((JSON.parse(await readFile(destination, "utf8")) as { schemaVersion: number }).schemaVersion, 99);
}));

test("unsupported legacy schema values lock recovery instead of normalizing to an empty workspace", async () => {
  for (const schemaVersion of [0, "3", undefined]) await withDirectory(async (directory) => {
    const invalid = { ...createInitialWorkspace(), schemaVersion };
    await writeFile(join(directory, "workspace-state.json"), JSON.stringify(invalid), "utf8");
    const store = new WorkspaceStore(directory);
    await store.load();
    assert.equal(store.status().required, true);
    await assert.rejects(store.save(createInitialWorkspace()), /unsupported|recovery/i);
  });
});

test("shared browser validation detects unsupported schemas and duplicate record identifiers", () => {
  assert.equal(workspaceNeedsRecovery(createInitialWorkspace()), false);
  assert.equal(workspaceNeedsRecovery({ ...createInitialWorkspace(), schemaVersion: 0 }), true);
  const duplicate = workspaceWithChats(chat("duplicate"), chat("duplicate"));
  assert.equal(workspaceNeedsRecovery(duplicate), true);
});

test("save inspects existing storage first and cannot bypass a future-version lock", async () => withDirectory(async (directory) => {
  const source = JSON.stringify({ ...createInitialWorkspace(), schemaVersion: 99 });
  const legacyPath = join(directory, "workspace-state.json");
  await writeFile(legacyPath, source, "utf8");
  const store = new WorkspaceStore(directory);
  await assert.rejects(store.save(createInitialWorkspace()), /newer|schema/i);
  assert.equal(store.status().required, true);
  assert.equal(await readFile(legacyPath, "utf8"), source);
}));

test("a missing or corrupt content-addressed chat is retained as metadata and locks saving", async () => withDirectory(async (directory) => {
  const state = workspaceWithChats(chat("important"));
  const store = new WorkspaceStore(directory);
  await store.save(state);
  const files = await readdir(join(directory, "workspace-chats"));
  await writeFile(join(directory, "workspace-chats", files[0]), "corrupt", "utf8");

  const reopened = new WorkspaceStore(directory);
  const loaded = await reopened.load() as WorkspaceState;
  assert.equal(loaded.projects[0].chats[0].id, "important");
  assert.deepEqual(loaded.projects[0].chats[0].messages, []);
  assert.equal(reopened.status().required, true);
  await assert.rejects(reopened.save(loaded), /missing|corrupt|recovery/i);
  await reopened.recover();
  const repaired = new WorkspaceStore(directory);
  const repairedState = await repaired.load() as WorkspaceState;
  assert.equal(repaired.status().required, false);
  assert.equal(repairedState.projects[0].chats[0].id, "important");
}));

test("sequential saves retain only current and previous generated chat content", async () => withDirectory(async (directory) => {
  const store = new WorkspaceStore(directory);
  for (let index = 0; index < 5; index += 1) {
    await store.save(workspaceWithChats(chat("changing", `revision-${index}`)));
  }
  const generated = (await readdir(join(directory, "workspace-chats"))).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(generated.length, 2);
}));

test("export writes a portable monolithic workspace", async () => withDirectory(async (directory) => {
  const state = workspaceWithChats(chat("exported", "portable"));
  const store = new WorkspaceStore(directory);
  await store.save(state);
  const destination = join(directory, "exports", "workspace.json");
  const unsaved = workspaceWithChats(chat("exported", "new unsaved text"));
  await store.export(destination, unsaved);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), JSON.parse(JSON.stringify(normalizeWorkspace(unsaved))));
}));

// -- Pictures: saved runs' previews live beside the chats, not inside them ----

const JPEG_START = [0xff, 0xd8, 0xff, 0xe0];
const picture = (tag: string) => `data:image/jpeg;base64,${Buffer.from([...JPEG_START, ...Buffer.from(tag)]).toString("base64")}`;

function chatWithPictures(id: string, ...tags: string[]): Chat {
  const date = "2026-01-01T00:00:00.000Z";
  const evidence: RunEvidence[] = tags.map((tag, index) => ({ id: `${id}-shot-${index}`, kind: "screenshot", title: "Studio", imageDataUrl: picture(tag) }));
  const run: RunRecord = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION, runId: `${id}-run`, planner: "codex", approvalMode: "Ask first", outcome: "completed",
    startedAt: date, finishedAt: date, toolCalls: [], changes: [], evidence, failures: [],
  };
  return { ...chat(id), messages: [...chat(id).messages, { id: `reply-${id}`, role: "assistant", text: "done", createdAt: date, run }] };
}

const evidenceOf = (state: WorkspaceState, chatIndex = 0) => state.projects[0].chats[chatIndex].messages[1].run?.evidence ?? [];

async function chatFiles(directory: string): Promise<string[]> {
  const names = (await readdir(join(directory, "workspace-chats"))).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map((name) => readFile(join(directory, "workspace-chats", name), "utf8")));
}

async function storedPictures(directory: string): Promise<string[]> {
  return (await readdir(join(directory, PICTURE_DIRECTORY)).catch(() => [] as string[])).sort();
}

test("a saved run's pictures are kept as files beside its chat, and the chat keeps only their names", async () => withDirectory(async (directory) => {
  const store = new WorkspaceStore(directory);
  await store.save(workspaceWithChats(chatWithPictures("sword", "a", "b")));

  for (const file of await chatFiles(directory)) assert.equal(file.includes("data:image"), false);
  const loaded = await new WorkspaceStore(directory).load() as WorkspaceState;
  const refs = evidenceOf(loaded).map((item) => item.imageRef);
  assert.deepEqual((await storedPictures(directory)), [...refs].sort());
  assert.deepEqual(evidenceOf(loaded).map((item) => item.imageDataUrl), [undefined, undefined]);
  assert.deepEqual(await store.pictures.read(refs[0]), { ok: true, dataUrl: picture("a") });
}));

test("chats an earlier build saved with pictures inside are moved out on load, once", async () => withDirectory(async (directory) => {
  // What an earlier build wrote: pictures inline, and no picture store.
  await writeFile(join(directory, "workspace-state.json"), JSON.stringify(workspaceWithChats(chatWithPictures("old", "a"))), "utf8");

  const loaded = await new WorkspaceStore(directory).load() as WorkspaceState;
  const [ref] = evidenceOf(loaded).map((item) => item.imageRef);
  assert.ok(ref, "the renderer is handed the ref");
  assert.deepEqual(await storedPictures(directory), [ref]);
  for (const file of await chatFiles(directory)) assert.equal(file.includes("data:image"), false, "saved without the picture");

  const manifest = join(directory, "workspace-manifest.json");
  const before = await readFile(manifest, "utf8");
  const again = await new WorkspaceStore(directory).load() as WorkspaceState;
  assert.equal(evidenceOf(again)[0].imageRef, ref);
  assert.equal(await readFile(manifest, "utf8"), before, "the second load has nothing left to move");
}));

test("a picture the store cannot take stays inside the chat, so nothing is lost", async () => withDirectory(async (directory) => {
  class RefusingStore extends PictureStore {
    override async put(): Promise<string | undefined> { return undefined; }
  }
  const store = new WorkspaceStore(directory, { pictures: new RefusingStore(directory) });
  await store.save(workspaceWithChats(chatWithPictures("full-disk", "a")));
  const loaded = await new WorkspaceStore(directory, { pictures: new RefusingStore(directory) }).load() as WorkspaceState;
  assert.equal(evidenceOf(loaded)[0].imageDataUrl, picture("a"));
  assert.equal(evidenceOf(loaded)[0].imageRef, undefined);
}));

test("deleting a chat removes its pictures, once no kept chat file refers to them and the grace has passed", async () => withDirectory(async (directory) => {
  const clock = { now: Date.now() };
  const store = new WorkspaceStore(directory, { pictures: new PictureStore(directory, () => clock.now) });
  await store.save(workspaceWithChats(chatWithPictures("deleted", "gone"), chatWithPictures("kept", "stays")));
  const saved = await store.load() as WorkspaceState;
  const [gone] = evidenceOf(saved, 0).map((item) => item.imageRef);
  const [stays] = evidenceOf(saved, 1).map((item) => item.imageRef);
  const later = () => { clock.now += PICTURE_GRACE_MS + 1_000; };

  // The chat is deleted, but the previous manifest still keeps its file, so its picture stays too.
  later();
  await store.save(workspaceWithChats(saved.projects[0].chats[1]));
  assert.deepEqual(await storedPictures(directory), [gone, stays].sort());

  // Once no manifest keeps it, its picture goes; the other chat's stays.
  later();
  await store.save(workspaceWithChats(saved.projects[0].chats[1]));
  assert.deepEqual(await storedPictures(directory), [stays]);
}));

test("export puts every stored picture back inline, so the copy stands on its own", async () => withDirectory(async (directory) => {
  const store = new WorkspaceStore(directory);
  await store.save(workspaceWithChats(chatWithPictures("exported", "a")));
  const destination = join(directory, "exports", "workspace.json");
  await store.export(destination);
  const exported = JSON.parse(await readFile(destination, "utf8")) as WorkspaceState;
  assert.equal(evidenceOf(exported)[0].imageDataUrl, picture("a"));
  assert.equal(evidenceOf(exported)[0].imageRef, undefined);
  assert.equal(workspaceNeedsRecovery(exported), false);
}));

test("a picture a recovery backup refers to is kept, so the damaged chat can still be looked into", async () => withDirectory(async (directory) => {
  const clock = { now: Date.now() };
  const pictures = new PictureStore(directory, () => clock.now);
  const store = new WorkspaceStore(directory, { pictures });
  await store.save(workspaceWithChats(chatWithPictures("damaged", "a")));
  const [ref] = await storedPictures(directory);
  for (const name of await readdir(join(directory, "workspace-chats"))) await writeFile(join(directory, "workspace-chats", name), "{broken", "utf8");
  // What recovery backs up is the chat as it was, picture ref and all.
  const backup = join(directory, "workspace-recovery", "2026-01-01-backup");
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, "chat.json"), JSON.stringify(chatWithPictures("damaged", "a")).replace(/"imageDataUrl":"[^"]+"/, `"imageRef":"${ref}"`), "utf8");
  await writeFile(join(directory, "workspace-recovery", "stray.txt"), "not a backup folder", "utf8");

  const reopened = new WorkspaceStore(directory, { pictures });
  await reopened.load();
  await reopened.recover();
  clock.now += PICTURE_GRACE_MS + 1_000;
  await reopened.save(workspaceWithChats(chat("fresh")));
  await reopened.save(workspaceWithChats(chat("fresh")));
  assert.deepEqual(await storedPictures(directory), [ref]);
}));

test("a workspace that needs recovery moves no pictures, and recovering removes none", async () => withDirectory(async (directory) => {
  const clock = { now: Date.now() };
  const pictures = new PictureStore(directory, () => clock.now);
  const store = new WorkspaceStore(directory, { pictures });
  await store.save(workspaceWithChats(chatWithPictures("damaged", "a")));
  const before = await storedPictures(directory);
  assert.equal(before.length, 1);
  // The chat file is damaged: nothing can say which pictures it refers to.
  for (const name of await readdir(join(directory, "workspace-chats"))) await writeFile(join(directory, "workspace-chats", name), "{broken", "utf8");

  clock.now += PICTURE_GRACE_MS + 1_000;
  const reopened = new WorkspaceStore(directory, { pictures });
  await reopened.load();
  assert.equal(reopened.status().required, true);
  await reopened.recover();
  assert.deepEqual(await storedPictures(directory), before);
}));
