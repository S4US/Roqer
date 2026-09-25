import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseOpenCloudSave } from "../shared/open-cloud";
import { bridgeEnvironment, checkOpenCloudKey, INTROSPECT_URL } from "./open-cloud";
import { OpenCloudStore } from "./open-cloud-store";
import type { SecretProtector } from "./secret-protector";

const KEY = "rbx-OpenCloudKey_ABCDEF0123456789";

const protector = (available = true): SecretProtector => ({
  isEncryptionAvailable: () => available,
  encryptString: (value) => Buffer.from(`sealed:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^sealed:/, ""),
});

async function withStore(run: (store: OpenCloudStore, file: string) => Promise<void>, available = true): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-open-cloud-"));
  const file = path.join(directory, "open-cloud.json");
  try {
    await run(new OpenCloudStore({ file, protector: protector(available), now: () => new Date(0) }), file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("the key is stored encrypted, reported only as present, and decrypted only on resolve", async () => {
  await withStore(async (store, file) => {
    assert.deepEqual(await store.get(), { hasKey: false, creator: null });
    const saved = await store.save({ apiKey: `  ${KEY}\n`, creator: { kind: "group", id: "4242" } });
    assert.deepEqual(saved, { hasKey: true, creator: { kind: "group", id: "4242" } });
    const onDisk = await fs.readFile(file, "utf8");
    assert.equal(onDisk.includes(KEY), false, "the key never reaches disk in the clear");
    assert.deepEqual(await store.resolve(), { apiKey: KEY, creator: { kind: "group", id: "4242" } });

    // Absent keeps the key; null removes it.
    await store.save({ creator: { kind: "user", id: "7" } });
    assert.equal((await store.resolve()).apiKey, KEY);
    assert.deepEqual(await store.save({ apiKey: null, creator: null }), { hasKey: false, creator: null });
    assert.equal((await store.resolve()).apiKey, null);
  });
});

test("without encrypted storage a key is refused rather than written in the clear", async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.save({ apiKey: KEY, creator: null }), /no encrypted storage/);
    assert.deepEqual(await store.save({ creator: { kind: "user", id: "7" } }), { hasKey: false, creator: { kind: "user", id: "7" } });
  }, false);
});

test("a damaged file is moved aside once and the user starts from nothing", async () => {
  await withStore(async (store, file) => {
    await fs.writeFile(file, "{\"schemaVersion\":1,\"creator\":{\"kind\":\"user\",\"id\":\"x\"}}", "utf8");
    assert.deepEqual(await store.get(), { hasKey: false, creator: null });
    const preserved = store.takeDamagedNotice();
    assert.ok(preserved?.includes(".damaged-"));
    assert.equal(store.takeDamagedNotice(), undefined);
    await fs.access(preserved!);
  });
});

test("settings from the renderer are validated, and a bad ID is explained", () => {
  assert.deepEqual(parseOpenCloudSave({ apiKey: ` ${KEY} `, creator: { kind: "user", id: "123" } }),
    { save: { apiKey: KEY, creator: { kind: "user", id: "123" } } });
  assert.deepEqual(parseOpenCloudSave({ creator: null }), { save: { creator: null } });
  assert.match((parseOpenCloudSave({ creator: { kind: "user", id: "me" } }) as { message: string }).message, /is a number/);
  assert.match((parseOpenCloudSave({ apiKey: "has space", creator: null }) as { message: string }).message, /whole key/);
  assert.ok("message" in parseOpenCloudSave({ creator: null, extra: true }));
});

test("the bridge gets saved settings in its environment, one creator, and inherited values otherwise", () => {
  const inherited = { PATH: "p", ROBLOX_OPEN_CLOUD_API_KEY: "shell-key", ROBLOX_CREATOR_GROUP_ID: "99" };
  assert.deepEqual(bridgeEnvironment(inherited, undefined), inherited);
  assert.deepEqual(bridgeEnvironment(inherited, { apiKey: null, creator: null }), inherited);
  assert.deepEqual(bridgeEnvironment(inherited, { apiKey: KEY, creator: { kind: "user", id: "7" } }), {
    PATH: "p",
    ROBLOX_OPEN_CLOUD_API_KEY: KEY,
    ROBLOX_CREATOR_USER_ID: "7",
  });
});

/** A fetch that answers the introspect call with the given status and body, and records the request. */
function roblox(status: number, body: unknown) {
  const sent: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const introspection = (overrides: Record<string, unknown> = {}) => ({
  name: "Roqer uploads",
  authorizedUserId: 234,
  scopes: [{ name: "asset", operations: ["read", "write"], groupIds: ["4242"], userIds: ["234"] }],
  enabled: true,
  expired: false,
  expirationTimeUtc: "2027-01-01T00:00:00.000Z",
  ...overrides,
});

test("a key that can publish as the chosen creator is reported so, from one introspect call", async () => {
  const { fetch, sent } = roblox(200, introspection());
  const check = await checkOpenCloudKey({ apiKey: KEY, creator: { kind: "group", id: "4242" }, fetch, now: () => new Date(0) });
  assert.deepEqual(check, {
    checkedAt: "1970-01-01T00:00:00.000Z",
    keyName: "Roqer uploads",
    authorizedUserId: "234",
    expiresAt: "2027-01-01T00:00:00.000Z",
    canRead: true,
    canWrite: true,
    canUpload: true,
    message: "Uploads will be published as group 4242.",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, INTROSPECT_URL);
  assert.equal(sent[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(sent[0].init?.body)), { apiKey: KEY });
});

test("each reason a key cannot publish is named", async () => {
  const check = async (body: unknown, creator: { kind: "user" | "group"; id: string } | null = { kind: "user", id: "234" }, status = 200) =>
    checkOpenCloudKey({ apiKey: KEY, creator, fetch: roblox(status, body).fetch });
  assert.match((await check(introspection({ enabled: false }))).message, /disabled/);
  assert.match((await check(introspection({ expired: true }))).message, /expired/);
  assert.match((await check(introspection({ scopes: [{ name: "asset", operations: ["read"] }] }))).message, /cannot publish assets/);
  assert.match((await check(introspection(), null)).message, /belongs to user 234/);
  assert.match((await check(introspection(), { kind: "group", id: "1" })).message, /cannot publish as group 1/);
  const wildcard = await check(introspection({ scopes: [{ name: "asset", operations: ["write"], groupIds: ["*"] }] }), { kind: "group", id: "1" });
  assert.equal(wildcard.canUpload, true);
  const refused = await check({ message: `Invalid key ${KEY}` }, undefined, 401);
  assert.equal(refused.canUpload, false);
  assert.match(refused.message, /did not accept this key: Invalid key \[key\]/);
  assert.equal(refused.message.includes(KEY), false);
});

test("not being able to ask Roblox is an error, not a verdict on the key", async () => {
  const failing = (async () => { throw new TypeError("fetch failed"); }) as typeof globalThis.fetch;
  await assert.rejects(() => checkOpenCloudKey({ apiKey: KEY, creator: null, fetch: failing }), /could not reach Roblox/);
  await assert.rejects(() => checkOpenCloudKey({ apiKey: KEY, creator: null, fetch: roblox(503, "").fetch }), /status 503/);
  await assert.rejects(() => checkOpenCloudKey({ apiKey: KEY, creator: null, fetch: roblox(429, "").fetch }), /limiting/);
});
