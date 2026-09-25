import assert from "node:assert/strict";
import test from "node:test";

import { createInitialWorkspace, type WorkspaceState } from "./model";
import { flushWorkspace, getStorageStatus, loadWorkspace, recoverWorkspace, saveWorkspace } from "./platform";

const STORAGE_KEY = "studio-workbench-workspace-v1";

class MemoryStorage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: storage,
    workbenchDesktop: undefined,
  },
});

async function resetBrowserStorage(): Promise<void> {
  storage.clear();
  storage.setItem(STORAGE_KEY, JSON.stringify(createInitialWorkspace()));
  await loadWorkspace();
  storage.clear();
}

test("malformed JSON remains untouched while autosave and flush stay locked until explicit recovery", async () => {
  await resetBrowserStorage();
  const malformed = "{not-json";
  storage.setItem(STORAGE_KEY, malformed);
  assert.equal(await loadWorkspace(), null);
  assert.equal((await getStorageStatus()).required, true);

  await assert.rejects(saveWorkspace(createInitialWorkspace()), /recover|read/i);
  flushWorkspace(createInitialWorkspace());
  assert.equal(storage.getItem(STORAGE_KEY), malformed);

  const recovered = await recoverWorkspace() as WorkspaceState;
  assert.equal((await getStorageStatus()).required, false);
  assert.equal(recovered.schemaVersion, 3);
  assert.notEqual(storage.getItem(STORAGE_KEY), malformed);
  assert.ok([...storage.values.entries()].some(([key, value]) => key.startsWith(`${STORAGE_KEY}-recovery-`) && value === malformed));
});

test("a future workspace schema remains original and refuses recovery", async () => {
  await resetBrowserStorage();
  const future = JSON.stringify({ ...createInitialWorkspace(), schemaVersion: 99 });
  storage.setItem(STORAGE_KEY, future);
  await loadWorkspace();
  assert.equal((await getStorageStatus()).required, true);
  await assert.rejects(recoverWorkspace(), /newer app/i);
  assert.equal(storage.getItem(STORAGE_KEY), future);
});

test("a malformed run is retained during load and stripped only after explicit recovery", async () => {
  await resetBrowserStorage();
  const state = createInitialWorkspace();
  state.projects[0].chats = [{
    id: "chat", title: "Chat", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    messages: [{ id: "message", role: "assistant", text: "Result", createdAt: "2026-01-01", run: { bad: true } as never }],
  }];
  const original = JSON.stringify(state);
  storage.setItem(STORAGE_KEY, original);

  const loaded = await loadWorkspace() as WorkspaceState;
  assert.deepEqual(loaded.projects[0].chats[0].messages[0].run, { bad: true });
  assert.equal((await getStorageStatus()).required, true);
  assert.equal(storage.getItem(STORAGE_KEY), original);

  const recovered = await recoverWorkspace() as WorkspaceState;
  assert.equal(recovered.projects[0].chats[0].messages[0].run, undefined);
  assert.equal((await getStorageStatus()).required, false);
  assert.ok([...storage.values.entries()].some(([key, value]) => key.startsWith(`${STORAGE_KEY}-recovery-`) && value === original));
});
