import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImageSettings, normalizeImageBaseUrl } from "./image-settings";
import type { SecretProtector } from "./secret-protector";

const protector: SecretProtector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`),
  decryptString: (value) => value.toString().replace(/^enc:/, ""),
};

async function withStore(run: (store: ImageSettings, file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "roqer-image-settings-"));
  try {
    await run(new ImageSettings({ file: join(root, "image-generation.json"), protector }), join(root, "image-generation.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("OpenAI needs a key before the tool can be on; a compatible server does not", async () => withStore(async (store, file) => {
  const fresh = await store.get();
  assert.equal(fresh.state, "missing");
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.source, "openai");
  assert.equal(fresh.model, "gpt-image-1");
  const turnedOn = await store.save({ enabled: true });
  assert.equal(turnedOn.state, "missing", "on without a key is still missing");
  assert.equal(await store.ready(), undefined);
  const keyed = await store.save({ apiKey: "sk-test-1234567890" });
  assert.equal(keyed.state, "ready");
  assert.equal(keyed.hasKey, true);
  assert.match(keyed.message, /On: the agent can ask OpenAI/);
  const resolved = await store.ready();
  assert.deepEqual(resolved, { source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", quality: "medium", apiKey: "sk-test-1234567890" });
  const saved = await readFile(file, "utf8");
  assert.doesNotMatch(saved, /sk-test-1234567890/, "the key never touches disk in the clear");
  const local = await store.save({ source: "openai-compatible", baseUrl: "http://localhost:7860/v1/", model: "flux-schnell", apiKey: null, quality: "low" });
  assert.equal(local.state, "ready");
  assert.equal(local.hasKey, false);
  assert.equal(local.baseUrl, "http://localhost:7860/v1");
  assert.equal((await store.ready())?.apiKey, null);
  const off = await store.save({ enabled: false });
  assert.equal(off.state, "off");
  assert.equal(await store.ready(), undefined);
}));

test("a bad address or an empty model is refused, and a damaged file is set aside", async () => withStore(async (store, file) => {
  await assert.rejects(store.save({ baseUrl: "ftp://x" }), /must be an http or https address/);
  await assert.rejects(store.save({ baseUrl: "https://api.openai.com/v1?x=1" }), /must be an http or https address/);
  await assert.rejects(store.save({ model: "  " }), /Name the image model/);
  await assert.rejects(store.save({ apiKey: "has spaces in it" }), /not a valid API key/);
  assert.equal(normalizeImageBaseUrl(" https://api.openai.com/v1/// "), "https://api.openai.com/v1");
  assert.equal(normalizeImageBaseUrl("https://user:pw@host/v1"), undefined);
  await writeFile(file, "{ broken");
  const again = new ImageSettings({ file, protector });
  assert.equal((await again.get()).state, "missing");
  assert.match(again.takeDamagedNotice() ?? "", /damaged-/);
  assert.equal(again.takeDamagedNotice(), undefined);
  assert.ok((await readdir(join(file, ".."))).some((name) => name.includes(".damaged-")));
}));

test("without encrypted storage a key cannot be kept, and the setting says so", async () => {
  const root = await mkdtemp(join(tmpdir(), "roqer-image-settings-noenc-"));
  try {
    const store = new ImageSettings({ file: join(root, "s.json"), protector: { ...protector, isEncryptionAvailable: () => false } });
    await assert.rejects(store.save({ apiKey: "sk-x" }), /no encrypted storage/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenRouter takes its own address when chosen, needs a key, and a compatible server keeps the address it had", async () => withStore(async (store) => {
  const chosen = await store.save({ source: "openrouter", model: "openai/gpt-image-1" });
  assert.equal(chosen.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(chosen.state, "missing");
  assert.match(chosen.message, /OpenRouter needs an API key/);
  const keyed = await store.save({ apiKey: "sk-or-test-1234567890", enabled: true });
  assert.equal(keyed.state, "ready");
  assert.match(keyed.message, /ask OpenRouter for images with openai\/gpt-image-1/);
  assert.deepEqual(await store.ready(), { source: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-image-1", quality: "medium", apiKey: "sk-or-test-1234567890" });
  // Back to a compatible server: the address stays to be edited, and the key is not needed.
  const local = await store.save({ source: "openai-compatible", apiKey: null });
  assert.equal(local.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(local.state, "ready");
  // And to OpenAI: its own address, no key again.
  const openai = await store.save({ source: "openai" });
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.state, "missing");
}));
