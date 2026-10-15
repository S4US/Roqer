import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OpenCodeClient, parseOpenCodeModels } from "./opencode-cli";
import { resolveOpenCodeExecutable } from "./opencode-executable";
import { ClientNotInstalledError } from "./client-not-installed";
import { parseClientVersion } from "./client-version";
import { isProviderModelCatalog, isProviderStatus } from "../shared/provider";
import { FakeChildProcess } from "./test-child-process";

const metadata = (name: string, input = 0) => ({ name, status: "active", cost: { input, output: 0 }, capabilities: { toolcall: true } });
const modelOutput = `opencode/free\n${JSON.stringify(metadata("Free"), null, 2)}\nopencode/paid\n${JSON.stringify(metadata("Paid", 1), null, 2)}\n`;

function clientWith(step: (child: FakeChildProcess) => void, timeoutMs?: number, now?: () => number) {
  const children: FakeChildProcess[] = [];
  const client = new OpenCodeClient({
    resolveExecutable: async () => "opencode.exe",
    timeoutMs,
    now,
    spawnProcess: (executable, args, env, cwd) => {
      assert.equal(executable, "opencode.exe");
      assert.deepEqual(args, ["models", "opencode", "--verbose", "--pure"]);
      assert.equal(env.HOME, cwd);
      assert.equal(env.USERPROFILE, cwd);
      assert.equal(env.ROBLOX_STUDIO_AUTH_TOKEN, undefined);
      const child = new FakeChildProcess();
      children.push(child);
      queueMicrotask(() => step(child));
      return child.asChild();
    },
  });
  return { client, children };
}

test("OpenCode Windows lookup skips npm shims and discovers native binary at a custom npm prefix", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-opencode-lookup-"));
  try {
    const executable = path.join(temporary, "node_modules", "opencode-ai", "bin", "opencode.exe");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "native fixture");
    await fs.writeFile(path.join(temporary, "opencode.cmd"), "@echo off");
    assert.equal(await resolveOpenCodeExecutable({ platform: "win32", env: { PATH: temporary } }), executable);
    await fs.rm(executable);
    await assert.rejects(resolveOpenCodeExecutable({ platform: "win32", env: { PATH: temporary } }), ClientNotInstalledError);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("OpenCode overrides cannot launch Windows command shims", async () => {
  await assert.rejects(resolveOpenCodeExecutable({ platform: "win32", executable: "opencode.cmd" }), /native .exe/);
  assert.equal(await resolveOpenCodeExecutable({ platform: "win32", executable: "D:\\tools\\opencode.exe" }), "D:\\tools\\opencode.exe");
});

test("parseClientVersion parses opencode version", () => {
  assert.equal(parseClientVersion("opencode", "1.18.32\n"), "1.18.32");
});

test("OpenCode model metadata excludes paid, inactive and non-tool models", () => {
  assert.deepEqual(parseOpenCodeModels(modelOutput).map((model) => model.id), ["opencode/free"]);
  for (const model of [metadata("Paid", 2), { ...metadata("Retired"), status: "deprecated" }, { ...metadata("No tools"), capabilities: { toolcall: false } }, { name: "Missing price" }]) {
    assert.throws(() => parseOpenCodeModels(`opencode/model\n${JSON.stringify(model)}\n`), /any free models/);
  }
  assert.throws(() => parseOpenCodeModels("opencode/broken\n{"));
  assert.throws(() => parseOpenCodeModels(`opencode/cache-paid\n${JSON.stringify({ ...metadata("Cache paid"), cost: { input: 0, output: 0, cache: { read: 1, write: 0 } } })}\n`), /any free models/);
});

test("OpenCode advertises only reported, supported variants and context limits", () => {
  const parse = (extra: object) => parseOpenCodeModels(`opencode/free\n${JSON.stringify({ ...metadata("Free"), ...extra })}\n`)[0];
  const model = parse({ variants: { high: {}, low: {}, medium: {}, custom: {}, max: null }, limit: { context: 262144 } });
  assert.deepEqual(model.supportedReasoningEfforts, ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })));
  assert.equal(model.defaultReasoningEffort, "medium");
  assert.equal(model.contextWindow, 262144);
  assert.equal(isProviderModelCatalog({ models: [model], defaultModelId: model.id }), true);
  assert.equal(parse({ variants: { low: {}, high: {} } }).defaultReasoningEffort, "low");
  assert.deepEqual(parse({ variants: {} }).supportedReasoningEfforts, [{ reasoningEffort: "none" }]);
  for (const context of [0, -1, 1.5, "200000", null]) assert.equal(parse({ limit: { context } }).contextWindow, undefined);
});

test("OpenCode client discovers a truthful catalog and readiness in an isolated environment", async () => {
  const { client } = clientWith((child) => { child.write(modelOutput); child.finish(0); });
  const status = await client.getStatus();
  assert.equal(isProviderStatus(status), true);
  assert.equal(status.kind, "signed-in");
  assert.equal("planType" in status, false);
  const catalog = await client.models();
  assert.equal(isProviderModelCatalog(catalog), true);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.defaultModelId, "opencode/free");
});

test("OpenCode missing install is reported without offering a nonexistent installer", async () => {
  const client = new OpenCodeClient({ resolveExecutable: async () => { throw new ClientNotInstalledError("Install OpenCode."); } });
  assert.deepEqual(await client.getStatus(), { kind: "not-installed", message: "Install OpenCode." });
  assert.deepEqual(await client.models(), { models: [], defaultModelId: null, message: "Install OpenCode." });
});

test("OpenCode catalog failures do not return fabricated fallback models", async () => {
  const { client } = clientWith((child) => { child.write(modelOutput); child.finish(1); });
  assert.equal((await client.getStatus()).kind, "unavailable");
  const catalog = await client.models();
  assert.equal(catalog.models.length, 0);
  assert.match(catalog.message!, /exit 1/);
});

test("OpenCode discovery stops on timeout and output overflow", async () => {
  const timed = clientWith(() => {}, 5);
  assert.match((await timed.client.models()).message!, /timed out/);
  assert.equal(timed.children[0].killed, true);
  const overflowing = clientWith((child) => child.write("x".repeat(256 * 1024 + 1)));
  assert.match((await overflowing.client.models()).message!, /output limit/);
  assert.equal(overflowing.children[0].killed, true);
});

test("OpenCode discovery reports spawn failures and close prevents subsequent launches", async () => {
  const client = new OpenCodeClient({ resolveExecutable: async () => "opencode.exe", spawnProcess: () => { throw new Error("spawn EINVAL"); } });
  assert.match((await client.models()).message!, /EINVAL/);
  client.close();
  assert.match((await client.models()).message!, /closing/);
});

test("OpenCode shares concurrent discovery and caches only successful catalogs for one minute", async () => {
  let now = 1_000;
  const { client, children } = clientWith((child) => { child.write(modelOutput); child.finish(0); }, undefined, () => now);
  const [status, catalog] = await Promise.all([client.getStatus(), client.models(), client.models()]);
  assert.equal(status.kind, "signed-in");
  assert.equal(catalog.models.length, 1);
  assert.equal(children.length, 1);
  assert.equal(children[0].stdin.writableEnded, true);
  now += 59_999;
  await client.models();
  assert.equal(children.length, 1);
  now += 1;
  await client.models();
  assert.equal(children.length, 2);
  const failing = clientWith((child) => child.finish(1));
  await failing.client.models();
  await failing.client.models();
  assert.equal(failing.children.length, 2);
});

test("OpenCode close waits for in-flight process closure before cleaning its home", async () => {
  let child!: FakeChildProcess;
  let home = "";
  let launched!: () => void;
  const ready = new Promise<void>((resolve) => { launched = resolve; });
  const client = new OpenCodeClient({
    resolveExecutable: async () => "opencode.exe",
    spawnProcess: (_executable, _args, _env, cwd) => {
      home = cwd;
      child = new FakeChildProcess();
      child.kill = () => { child.killed = true; return true; };
      launched();
      return child.asChild();
    },
  });
  let settled = false;
  const result = client.models().then((catalog) => { settled = true; return catalog; });
  await ready;
  client.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.killed, true);
  assert.equal(settled, false);
  assert.equal((await fs.stat(home)).isDirectory(), true);
  child.finish(null);
  assert.match((await result).message!, /closing/);
  await assert.rejects(fs.stat(home), { code: "ENOENT" });
});

test("OpenCode asynchronous spawn and stream errors are reported after process closure", async () => {
  const spawnFailure = clientWith((child) => { child.emit("error", new Error("spawn ENOENT")); });
  assert.match((await spawnFailure.client.models()).message!, /spawn ENOENT/);
  const streamFailure = clientWith((child) => { child.stdout.emit("error", new Error("read failure")); });
  assert.match((await streamFailure.client.models()).message!, /read failure/);
});
