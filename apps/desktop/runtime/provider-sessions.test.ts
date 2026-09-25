import assert from "node:assert/strict";
import test from "node:test";

import { ProviderSessionStore } from "./provider-sessions";

function session(name: string, closed: string[]) {
  return { name, close: () => { closed.push(name); } };
}

test("a taken session belongs to the run that took it", () => {
  const closed: string[] = [];
  const store = new ProviderSessionStore<ReturnType<typeof session>>();
  const kept = session("a", closed);
  store.put("chat-1", kept);

  assert.equal(store.take("chat-1"), kept);
  assert.equal(store.take("chat-1"), undefined, "a second run in the chat cannot share it");
  assert.deepEqual(closed, []);
});

test("putting a new session for a chat closes the one it replaces", () => {
  const closed: string[] = [];
  const store = new ProviderSessionStore<ReturnType<typeof session>>();
  store.put("chat-1", session("old", closed));
  store.put("chat-1", session("new", closed));

  assert.deepEqual(closed, ["old"]);
  assert.equal(store.take("chat-1")?.name, "new");
});

test("a session nobody takes is closed once it has sat idle", async () => {
  const closed: string[] = [];
  const store = new ProviderSessionStore<ReturnType<typeof session>>({ idleMs: 20 });
  store.put("chat-1", session("a", closed));
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(closed, ["a"]);
  assert.equal(store.size, 0);
});

test("dropping and closing all release every session", async () => {
  const closed: string[] = [];
  const store = new ProviderSessionStore<ReturnType<typeof session>>();
  store.put("chat-1", session("a", closed));
  store.put("chat-2", session("b", closed));
  store.put("chat-3", { name: "c", close: () => { throw new Error("already gone"); } });

  store.drop("chat-1");
  store.drop("chat-unknown");
  await store.closeAll();

  assert.deepEqual(closed.sort(), ["a", "b"]);
  assert.equal(store.size, 0);
});
