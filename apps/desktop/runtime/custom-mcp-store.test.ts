import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CustomMcpStore } from "./custom-mcp-store";
import type { SecretProtector } from "./secret-protector";

/** Models the OS boundary while keeping real filesystem persistence under test. */
function protector(available = true): SecretProtector {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString("hex")}`),
    decryptString: (value) => {
      const text = value.toString();
      if (!text.startsWith("enc:")) throw new Error("foreign ciphertext");
      return Buffer.from(text.slice(4), "hex").toString();
    },
  };
}

async function withStore(run: (store: CustomMcpStore, file: string) => Promise<void>, available = true): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-custom-mcp-"));
  try {
    const file = path.join(directory, "custom-mcp.json");
    await run(new CustomMcpStore({ file, protector: protector(available) }), file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const STDIO = { name: "Files", enabled: true, transport: "stdio", command: "node", args: ["server.js"] };
const HTTP = { name: "Remote", enabled: true, transport: "http", url: "https://mcp.example/tools" };

test("saved secrets are encrypted, redacted on reload and available only to the host", async () => {
  await withStore(async (store, file) => {
    const [saved] = await store.save({ ...STDIO, environment: { TOKEN: "stdio-secret" }, headers: { Authorization: "Bearer header-secret" } });
    assert.match(saved.id, /^mcp-[a-z0-9]{8}$/);
    assert.deepEqual(saved.environmentKeys, ["TOKEN"]);
    assert.deepEqual(saved.headerKeys, ["Authorization"]);
    assert.equal(JSON.stringify(saved).includes("secret"), false);
    const contents = await fs.readFile(file, "utf8");
    assert.equal(contents.includes("stdio-secret"), false);
    assert.equal(contents.includes("header-secret"), false);
    assert.equal(JSON.parse(contents).schemaVersion, 1);

    const reopened = new CustomMcpStore({ file, protector: protector() });
    assert.deepEqual(await reopened.list(), [saved]);
    assert.deepEqual(await reopened.resolve(saved.id), {
      connection: { id: saved.id, ...STDIO }, environment: { TOKEN: "stdio-secret" }, headers: { Authorization: "Bearer header-secret" },
    });
    const unavailable = new CustomMcpStore({ file, protector: protector(false) });
    assert.deepEqual(await unavailable.list(), [saved], "listing names does not decrypt");
    await assert.rejects(() => unavailable.resolve(saved.id), /unavailable|encrypted storage/i);
  });
});

test("secret updates preserve omission, replace maps and clear null", async () => {
  await withStore(async (store) => {
    const [saved] = await store.save({ ...STDIO, environment: { A: "one", B: "two" }, headers: { Authorization: "three" } });
    await store.save({ ...STDIO, id: saved.id, name: "Renamed", environment: { C: "four" } });
    assert.deepEqual((await store.resolve(saved.id))?.environment, { C: "four" });
    assert.deepEqual((await store.resolve(saved.id))?.headers, { Authorization: "three" });
    const [cleared] = await store.save({ ...STDIO, id: saved.id, environment: null, headers: {} });
    assert.deepEqual(cleared.environmentKeys, []);
    assert.deepEqual(cleared.headerKeys, []);
    assert.deepEqual((await store.resolve(saved.id))?.environment, {});
    assert.deepEqual((await store.resolve(saved.id))?.headers, {});
    assert.deepEqual(await store.remove(saved.id), []);
    assert.equal(await store.resolve(saved.id), undefined);
    await assert.rejects(() => store.save({ ...STDIO, id: saved.id }), /no longer exists/i);
  });
});

test("secrets never follow a changed command, arguments, transport or exact HTTP URL", async () => {
  for (const [initial, changed] of [
    [STDIO, { ...STDIO, command: "other" }],
    [STDIO, { ...STDIO, args: ["other.js"] }],
    [STDIO, HTTP],
    [HTTP, { ...HTTP, url: "https://mcp.example/other" }],
    [HTTP, { ...HTTP, url: "https://collector.example/tools" }],
    [HTTP, STDIO],
  ]) {
    await withStore(async (store) => {
      const [saved] = await store.save({ ...initial, environment: { TOKEN: "private" }, headers: { Authorization: "private" } });
      await assert.rejects(() => store.save({ ...changed, id: saved.id }), /changed|different|again/i);
      await assert.rejects(() => store.save({ ...changed, id: saved.id, environment: {} }), /changed|different|again/i);
      assert.equal((await store.resolve(saved.id))?.connection.transport, initial.transport);
      const [updated] = await store.save({ ...changed, id: saved.id, environment: null, headers: { Authorization: "replacement" } });
      assert.equal(updated.transport, changed.transport);
      assert.deepEqual((await store.resolve(saved.id))?.environment, {});
      assert.deepEqual((await store.resolve(saved.id))?.headers, { Authorization: "replacement" });
    });
  }
});

test("disabled connections are excluded from run snapshots but can be checked", async () => {
  await withStore(async (store) => {
    const [enabled] = await store.save(STDIO);
    const [, disabled] = await store.save({ ...HTTP, enabled: false });
    assert.equal((await store.resolve(disabled.id))?.connection.enabled, false);
    assert.deepEqual((await store.snapshot()).map((entry) => entry.connection.id), [enabled.id]);
    // Callers cannot mutate a returned view or snapshot to change the saved config.
    (enabled.args as string[]).push("injected.js");
    const snapshot = await store.snapshot();
    (snapshot[0].connection.args as string[]).push("also-injected.js");
    assert.deepEqual((await store.resolve(enabled.id))?.connection.args, ["server.js"]);
  });
});

test("without encrypted storage secret writes fail atomically while secretless connections work", async () => {
  await withStore(async (store, file) => {
    await assert.rejects(() => store.save({ ...STDIO, environment: { TOKEN: "private" } }), /encrypted storage/i);
    await assert.rejects(() => store.save({ ...HTTP, headers: { Authorization: "private" } }), /encrypted storage/i);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(() => fs.readFile(file), { code: "ENOENT" });
    const [saved] = await store.save({ ...STDIO, environment: {} });
    assert.deepEqual((await store.resolve(saved.id))?.environment, {});
  }, false);
});

test("damaged files are preserved once and are never partially loaded", async () => {
  for (const contents of ["{ not json", JSON.stringify({ schemaVersion: 2, connections: [] }), JSON.stringify({
    schemaVersion: 1, connections: [{ id: "mcp-abcd1234", ...STDIO, environmentKeys: ["TOKEN"], headerKeys: [], encryptedEnvironment: "not-base64" }],
  }), "x".repeat(512 * 1_024 + 1)]) {
    await withStore(async (store, file) => {
      await fs.writeFile(file, contents, "utf8");
      assert.deepEqual(await store.list(), []);
      const preserved = store.takeDamagedNotice();
      assert.ok(preserved !== undefined && preserved.startsWith(`${file}.damaged-`));
      assert.equal(await fs.readFile(preserved, "utf8"), contents);
      assert.equal(store.takeDamagedNotice(), undefined);
      await store.save(STDIO);
      assert.equal(await fs.readFile(preserved, "utf8"), contents);
    });
  }
});

test("foreign or altered encrypted secrets fail on use without exposing their contents", async () => {
  await withStore(async (store, file) => {
    const [saved] = await store.save({ ...HTTP, headers: { Authorization: "original" } });
    const written = JSON.parse(await fs.readFile(file, "utf8")) as { connections: Array<Record<string, unknown>> };
    written.connections[0].encryptedHeaders = protector().encryptString(JSON.stringify({ Authorization: "bad\r\ninjected" })).toString("base64");
    await fs.writeFile(file, JSON.stringify(written), "utf8");
    const reopened = new CustomMcpStore({ file, protector: protector() });
    assert.equal((await reopened.list())[0].id, saved.id);
    await assert.rejects(() => reopened.resolve(saved.id), (error: unknown) => {
      assert.match((error as Error).message, /decrypted|invalid|read/i);
      assert.equal((error as Error).message.includes("injected"), false);
      return true;
    });
  });
});

test("concurrent writes retain all connections and enforce the limit before writing", async () => {
  await withStore(async (store, file) => {
    await Promise.all(Array.from({ length: 16 }, (_, index) => store.save({ ...STDIO, name: `Server ${index}` })));
    const connections = await store.list();
    assert.equal(connections.length, 16);
    assert.equal(new Set(connections.map((connection) => connection.id)).size, 16);
    const before = await fs.readFile(file, "utf8");
    await assert.rejects(() => store.save(STDIO), /16/);
    await assert.rejects(() => store.save({ ...STDIO, command: " " }), /command/i);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), []);
  });
});
