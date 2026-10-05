import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ClientVersionReader, parseClientVersion, versionEnvironment, type VersionSpawn } from "./client-version";

test("a client's version is read from what that client prints, and nothing else counts", () => {
  assert.equal(parseClientVersion("codex", "codex-cli 0.160.0\r\n"), "0.160.0");
  assert.equal(parseClientVersion("codex", "codex-cli 0.155.0-alpha.16.3\n"), "0.155.0-alpha.16.3");
  assert.equal(parseClientVersion("claude", "2.1.289 (Claude Code)\n"), "2.1.289");
  // Another program, or the other client, is not shown as this one.
  assert.equal(parseClientVersion("codex", "2.1.289 (Claude Code)\n"), null);
  assert.equal(parseClientVersion("claude", "codex-cli 0.160.0\n"), null);
  assert.equal(parseClientVersion("claude", "Blender 4.5.0\n"), null);
  assert.equal(parseClientVersion("codex", "codex-cli <script>\n"), null);
  assert.equal(parseClientVersion("codex", `codex-cli 1.2.3-${"a".repeat(80)}\n`), null);
});

test("a version check does not carry the bridge's credential", () => {
  const environment = versionEnvironment({ PATH: "C:\\bin", ROBLOX_STUDIO_AUTH_TOKEN: "secret" });
  assert.equal(environment.ROBLOX_STUDIO_AUTH_TOKEN, undefined);
  assert.equal(environment.PATH, "C:\\bin");
});

type FakeChild = EventEmitter & { stdout: PassThrough; killed: boolean; kill: () => boolean };

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), killed: false }) as FakeChild;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

/** A spawn that answers each `--version` with the next output given, or never when it is undefined. */
function answering(outputs: Array<string | undefined>) {
  const calls: Array<{ executable: string; args: readonly string[]; child: FakeChild }> = [];
  const spawnProcess: VersionSpawn = (executable, args) => {
    const child = fakeChild();
    calls.push({ executable, args, child });
    const output = outputs.shift();
    if (output !== undefined) {
      setImmediate(() => {
        child.stdout.write(output);
        child.emit("close", 0);
      });
    }
    return child as unknown as ChildProcess;
  };
  return { calls, spawnProcess };
}

test("the version is asked once per file, and again when an update changes the file", async () => {
  const { calls, spawnProcess } = answering(["2.1.288 (Claude Code)\n", "2.1.289 (Claude Code)\n", "codex-cli 0.160.0\n"]);
  let file = { mtimeMs: 1, size: 100 };
  const reader = new ClientVersionReader({ spawnProcess, stat: async () => file });

  assert.equal(await reader.read("claude", "C:\\Users\\me\\.local\\bin\\claude.exe"), "2.1.288");
  assert.equal(await reader.read("claude", "C:\\Users\\me\\.local\\bin\\claude.exe"), "2.1.288");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--version"]);

  // `claude update` replaces the file in place.
  file = { mtimeMs: 2, size: 101 };
  assert.equal(await reader.read("claude", "C:\\Users\\me\\.local\\bin\\claude.exe"), "2.1.289");
  assert.equal(calls.length, 2);

  // Each client keeps its own answer.
  assert.equal(await reader.read("codex", "C:\\codex\\codex.exe"), "0.160.0");
  assert.equal(await reader.read("claude", "C:\\Users\\me\\.local\\bin\\claude.exe"), "2.1.289");
  assert.equal(calls.length, 3);
});

test("a newer copy in another folder is asked, as the Codex app installs one", async () => {
  const { calls, spawnProcess } = answering(["codex-cli 0.155.0\n", "codex-cli 0.160.0\n"]);
  const reader = new ClientVersionReader({ spawnProcess, stat: async () => ({ mtimeMs: 1, size: 1 }) });
  assert.equal(await reader.read("codex", "C:\\Codex\\bin\\80f7\\codex.exe"), "0.155.0");
  assert.equal(await reader.read("codex", "C:\\Codex\\bin\\f544\\codex.exe"), "0.160.0");
  assert.deepEqual(calls.map((call) => call.executable), ["C:\\Codex\\bin\\80f7\\codex.exe", "C:\\Codex\\bin\\f544\\codex.exe"]);
});

test("reads that arrive together share one check", async () => {
  const { calls, spawnProcess } = answering(["codex-cli 0.160.0\n"]);
  const reader = new ClientVersionReader({ spawnProcess, stat: async () => ({ mtimeMs: 1, size: 1 }) });
  const versions = await Promise.all([reader.read("codex", "C:\\codex.exe"), reader.read("codex", "C:\\codex.exe")]);
  assert.deepEqual(versions, ["0.160.0", "0.160.0"]);
  assert.equal(calls.length, 1);
});

test("a client that does not answer shows no version, and is asked again after a minute", async () => {
  let now = 0;
  const { calls, spawnProcess } = answering(["Usage: something else\n", "codex-cli 0.160.0\n"]);
  const reader = new ClientVersionReader({ spawnProcess, stat: async () => ({ mtimeMs: 1, size: 1 }), now: () => now });
  assert.equal(await reader.read("codex", "C:\\codex.exe"), null);
  now = 30_000;
  assert.equal(await reader.read("codex", "C:\\codex.exe"), null);
  assert.equal(calls.length, 1);
  now = 61_000;
  assert.equal(await reader.read("codex", "C:\\codex.exe"), "0.160.0");
  assert.equal(calls.length, 2);
});

test("a check that hangs is stopped, and a missing file or failed start shows no version", async () => {
  const hanging = answering([undefined]);
  const reader = new ClientVersionReader({ spawnProcess: hanging.spawnProcess, stat: async () => ({ mtimeMs: 1, size: 1 }), timeoutMs: 10 });
  assert.equal(await reader.read("claude", "C:\\claude.exe"), null);
  assert.equal(hanging.calls[0].child.killed, true);

  const missing = answering(["codex-cli 0.160.0\n"]);
  const gone = new ClientVersionReader({
    spawnProcess: missing.spawnProcess,
    stat: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  });
  assert.equal(await gone.read("codex", "C:\\codex.exe"), null);
  assert.equal(missing.calls.length, 0);

  const refusing = new ClientVersionReader({
    spawnProcess: () => { throw new Error("spawn EACCES"); },
    stat: async () => ({ mtimeMs: 1, size: 1 }),
  });
  assert.equal(await refusing.read("codex", "C:\\codex.exe"), null);
});
