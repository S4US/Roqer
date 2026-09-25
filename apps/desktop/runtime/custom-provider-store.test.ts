import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CustomProviderStore } from "./custom-provider-store";
import type { SecretProtector } from "./secret-protector";

/** Reversible and visibly not plaintext, so a test can tell whether a key reached the file. */
function protector(available = true): SecretProtector {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString("hex")}`),
    decryptString: (value) => {
      const text = value.toString();
      if (!text.startsWith("enc:")) throw new Error("not ours");
      return Buffer.from(text.slice(4), "hex").toString();
    },
  };
}

async function withStore(run: (store: CustomProviderStore, file: string) => Promise<void>, available = true): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-custom-providers-"));
  try {
    const file = path.join(directory, "custom-providers.json");
    await run(new CustomProviderStore({ file, protector: protector(available) }), file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const OPENROUTER = {
  name: "OpenRouter",
  format: "openai" as const,
  baseUrl: "https://openrouter.ai/api/v1",
  models: [{ id: "deepseek/deepseek-chat", displayName: "DeepSeek", images: false, reasoning: false }],
};

test("a saved key is encrypted on disk, hidden from the view, and decrypted only to run", async () => {
  await withStore(async (store, file) => {
    const [saved] = await store.save({ ...OPENROUTER, apiKey: "sk-or-secret-123" });
    assert.match(saved.id, /^conn-[a-z0-9]{8}$/);
    assert.equal(saved.hasKey, true);
    assert.equal(JSON.stringify(saved).includes("sk-or-secret-123"), false);

    const contents = await fs.readFile(file, "utf8");
    assert.equal(contents.includes("sk-or-secret-123"), false, "the key never reaches disk in plaintext");

    const resolved = await store.resolve(saved.id);
    assert.equal(resolved?.apiKey, "sk-or-secret-123");
    assert.equal(resolved?.connection.baseUrl, "https://openrouter.ai/api/v1");

    // A fresh process reads the same file back.
    const reopened = new CustomProviderStore({ file, protector: protector() });
    assert.deepEqual(await reopened.list(), [saved]);
  });
});

test("an edit that leaves the key out keeps it, and null removes it", async () => {
  await withStore(async (store) => {
    const [saved] = await store.save({ ...OPENROUTER, apiKey: "sk-or-secret-123" });
    const [renamed] = await store.save({ ...OPENROUTER, id: saved.id, name: "My router" });
    assert.equal(renamed.name, "My router");
    assert.equal((await store.resolve(saved.id))?.apiKey, "sk-or-secret-123");

    const [keyless] = await store.save({ ...OPENROUTER, id: saved.id, apiKey: null });
    assert.equal(keyless.hasKey, false);
    assert.equal((await store.resolve(saved.id))?.apiKey, null);

    // A saved key never follows the connection to a different server.
    const [rekeyed] = await store.save({ ...OPENROUTER, id: saved.id, apiKey: "sk-or-secret-123" });
    await assert.rejects(
      () => store.save({ ...OPENROUTER, id: saved.id, baseUrl: "https://collector.example.com/v1" }),
      /different server/,
    );
    assert.equal((await store.resolve(saved.id))?.connection.baseUrl, "https://openrouter.ai/api/v1");
    // A path change on the same server keeps it.
    const [moved] = await store.save({ ...OPENROUTER, id: rekeyed.id, baseUrl: "https://openrouter.ai/api/v2" });
    assert.equal(moved.hasKey, true);

    assert.deepEqual(await store.remove(saved.id), []);
    assert.equal(await store.resolve(saved.id), undefined);
    await assert.rejects(() => store.save({ ...OPENROUTER, id: saved.id }), /no longer exists/);
  });
});

test("without encrypted storage a key is refused, but a local server needs none", async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.save({ ...OPENROUTER, apiKey: "sk-or-secret-123" }), /no encrypted storage/);
    const [local] = await store.save({
      name: "Ollama", format: "openai", baseUrl: "http://localhost:11434/v1",
      models: [{ id: "qwen2.5-coder:32b", displayName: "Qwen", images: false, reasoning: false }],
    });
    assert.equal(local.hasKey, false);
    assert.equal((await store.resolve(local.id))?.apiKey, null);
  }, false);
});

test("a damaged file is set aside for diagnosis rather than overwritten", async () => {
  await withStore(async (store, file) => {
    await fs.writeFile(file, "{ not json", "utf8");
    assert.deepEqual(await store.list(), []);
    const preserved = store.takeDamagedNotice();
    assert.ok(preserved !== undefined && preserved.startsWith(`${file}.damaged-`));
    assert.equal(await fs.readFile(preserved, "utf8"), "{ not json");
    assert.equal(store.takeDamagedNotice(), undefined, "reported once");

    // A file with a key that is not ours fails to decrypt on use, not on load.
    await store.save(OPENROUTER);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { connections: Array<Record<string, unknown>> };
    parsed.connections[0].encryptedApiKey = Buffer.from("foreign").toString("base64");
    await fs.writeFile(file, JSON.stringify(parsed), "utf8");
    const reopened = new CustomProviderStore({ file, protector: protector() });
    const [entry] = await reopened.list();
    assert.equal(entry.hasKey, true);
    await assert.rejects(() => reopened.resolve(entry.id), /could not be decrypted/);
  });
});
