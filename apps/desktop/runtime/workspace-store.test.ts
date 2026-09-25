import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInitialWorkspace, normalizeWorkspace, type Chat, type WorkspaceState } from "../src/model";
import { workspaceNeedsRecovery } from "../shared/workspace-validation";
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
