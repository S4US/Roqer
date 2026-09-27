import assert from "node:assert/strict";
import test from "node:test";

import {
  ClientInstallRunner,
  clientInstallerFor,
  clientInstallSupported,
  installerEnvironment,
  installerFailureDetail,
  installerProcess,
  type ClientInstaller,
} from "./client-installer";
import { FakeChildProcess } from "./test-child-process";

const codex = clientInstallerFor("chatgpt")!;
const claude = clientInstallerFor("claude")!;

/** An installer whose client is found (or not) without touching the disk. */
function locating(installer: ClientInstaller, found: boolean): ClientInstaller {
  return {
    ...installer,
    locate: async () => {
      if (!found) throw new Error("not found");
      return "C:\\Users\\player\\.local\\bin\\claude.exe";
    },
  };
}

function runner(step: (child: FakeChildProcess) => void, options: { timeoutMs?: number } = {}) {
  const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const killed: FakeChildProcess[] = [];
  const children: FakeChildProcess[] = [];
  const install = new ClientInstallRunner({
    env: { SystemRoot: "C:\\Windows", ROBLOX_STUDIO_AUTH_TOKEN: "secret", PATH: "C:\\bin" },
    spawnProcess: (command, args, env) => {
      spawned.push({ command, args, env });
      const child = new FakeChildProcess();
      children.push(child);
      queueMicrotask(() => step(child));
      return child.asChild();
    },
    killTree: (child) => {
      const fake = children.find((candidate) => candidate.asChild() === child)!;
      killed.push(fake);
      fake.kill();
    },
    ...options,
  });
  return { install, spawned, killed };
}

test("only Codex and Claude Code have an installer, run only on Windows", () => {
  assert.equal(clientInstallerFor("custom"), null);
  assert.equal(codex.script, "https://chatgpt.com/codex/install.ps1");
  assert.equal(claude.script, "https://claude.ai/install.ps1");
  assert.equal(clientInstallSupported("win32"), true);
  assert.equal(clientInstallSupported("darwin"), false);
  assert.equal(clientInstallSupported("linux"), false);
});

test("the installer runs the vendor's documented command in Windows PowerShell by absolute path", () => {
  assert.deepEqual(installerProcess(claude, { SystemRoot: "D:\\Win" }), {
    command: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"],
  });
});

test("the installer never sees the bridge credential, and Codex's never stops to ask", () => {
  const environment = installerEnvironment(codex, { ROBLOX_STUDIO_AUTH_TOKEN: "secret", PATH: "C:\\bin" });
  assert.equal(environment.ROBLOX_STUDIO_AUTH_TOKEN, undefined);
  assert.equal(environment.CODEX_NON_INTERACTIVE, "1");
  assert.equal(environment.PATH, "C:\\bin");
  assert.equal(installerEnvironment(claude, {}).CODEX_NON_INTERACTIVE, undefined);
});

test("an install succeeds only when the client is then found", async () => {
  const { install, spawned } = runner((child) => {
    child.write("Claude Code successfully installed!\n");
    child.finish(0);
  });

  assert.deepEqual(await install.install(locating(claude, true)), { ok: true, message: "Claude Code is installed." });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].env.ROBLOX_STUDIO_AUTH_TOKEN, undefined);
  assert.equal(install.busy, false);
});

test("a clean exit that leaves no client is reported, with the command to run by hand", async () => {
  const { install } = runner((child) => child.finish(0));

  const result = await install.install(locating(codex, false));
  assert.equal(result.ok, false);
  assert.match(result.message, /finished, but Roqer still cannot find Codex/);
  assert.equal(result.ok ? undefined : result.command, "irm https://chatgpt.com/codex/install.ps1 | iex");
});

test("a failed install says what the installer said, without terminal colours", async () => {
  const { install } = runner((child) => {
    child.write("==> Downloading Codex\n");
    child.stderr.write("\u001b[31mDownload failed: 403 Forbidden\u001b[0m\n");
    child.finish(1);
  });

  const result = await install.install(locating(codex, true));
  assert.equal(result.ok, false);
  assert.equal(result.message, "The Codex installer failed: ==> Downloading Codex\nDownload failed: 403 Forbidden");
  assert.equal(result.ok ? undefined : result.command, "irm https://chatgpt.com/codex/install.ps1 | iex");
});

test("an installer that does not finish in time is stopped", async () => {
  const { install, killed } = runner(() => undefined, { timeoutMs: 20 });

  const result = await install.install(locating(claude, true));
  assert.equal(result.ok, false);
  assert.match(result.message, /did not finish/);
  assert.equal(killed.length, 1);
  assert.equal(install.busy, false);
});

test("one install runs at a time, and quitting stops it and refuses more", async () => {
  const { install, killed, spawned } = runner(() => undefined);

  const first = install.install(locating(codex, true));
  assert.equal(install.busy, true);
  assert.deepEqual(await install.install(locating(claude, true)), { ok: false, message: "Another install is already running." });

  install.stop();
  const stopped = await first;
  assert.equal(stopped.ok, false);
  assert.match(stopped.message, /Roqer is closing/);
  assert.equal(killed.length, 1);
  assert.deepEqual(await install.install(locating(claude, true)), { ok: false, message: "Roqer is closing." });
  assert.equal(spawned.length, 1);
});

test("installer output is shortened to its end", () => {
  const detail = installerFailureDetail(`${"x".repeat(1000)}\nthe actual error`);
  assert.ok(detail.length <= 301);
  assert.match(detail, /^….*the actual error$/s);
});
