import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCodexExecutable } from "./codex-executable";

test("Codex executable discovery finds the versioned Windows desktop install", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-"));
  try {
    const executable = path.join(temporary, "OpenAI", "Codex", "bin", "build-hash", "codex.exe");
    const shimDirectory = path.join(temporary, "shim");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.mkdir(shimDirectory, { recursive: true });
    await fs.writeFile(executable, "test");
    await fs.writeFile(path.join(shimDirectory, "codex.cmd"), "@echo off");

    assert.equal(await resolveCodexExecutable({
      env: { LOCALAPPDATA: temporary, PATH: shimDirectory },
      platform: "win32",
    }), executable);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Codex executable discovery honors the explicit main-process override", async () => {
  assert.equal(await resolveCodexExecutable({
    env: { WORKBENCH_CODEX_EXECUTABLE: "D:\\portable\\codex.exe" },
    platform: "win32",
  }), "D:\\portable\\codex.exe");
});

async function withTemporary(run: (directory: string) => Promise<void>): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-"));
  try {
    await run(temporary);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function writeFile(file: string, content = "test"): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test("Codex executable discovery finds the standalone installer's Windows location before the desktop app", async () => {
  await withTemporary(async (temporary) => {
    const installed = path.join(temporary, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    await writeFile(installed);
    await writeFile(path.join(temporary, "OpenAI", "Codex", "bin", "codex.exe"));

    assert.equal(await resolveCodexExecutable({
      env: { LOCALAPPDATA: temporary, PATH: "" },
      platform: "win32",
    }), installed);
  });
});

test("Codex executable discovery finds the native binary inside a Windows npm global install", async () => {
  await withTemporary(async (temporary) => {
    const prefix = path.join(temporary, "npm");
    // npm puts only the shim on PATH; the executable is in the platform package.
    await writeFile(path.join(prefix, "codex.cmd"), "@echo off");
    const executable = path.join(prefix, "node_modules", "@openai", "codex", "node_modules", "@openai",
      "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    await writeFile(executable);

    assert.equal(await resolveCodexExecutable({
      env: { PATH: prefix, LOCALAPPDATA: path.join(temporary, "local") },
      platform: "win32",
      arch: "x64",
    }), executable);
  });
});

test("Codex executable discovery finds an older npm layout in npm's default prefix off PATH", async () => {
  await withTemporary(async (temporary) => {
    const executable = path.join(temporary, "npm", "node_modules", "@openai", "codex", "vendor",
      "aarch64-pc-windows-msvc", "codex", "codex.exe");
    await writeFile(executable);

    assert.equal(await resolveCodexExecutable({
      env: { PATH: "", APPDATA: temporary },
      platform: "win32",
      arch: "arm64",
    }), executable);
  });
});

test("Codex executable discovery finds the install script's location outside a graphical app's PATH", async () => {
  await withTemporary(async (temporary) => {
    const executable = path.join(temporary, ".local", "bin", "codex");
    await writeFile(executable);

    assert.equal(await resolveCodexExecutable({
      env: { HOME: temporary, PATH: "" },
      platform: "darwin",
    }), executable);
  });
});

test("Codex executable discovery reports a usable error when nothing is installed", async () => {
  await withTemporary(async (temporary) => {
    await writeFile(path.join(temporary, "npm", "codex.cmd"), "@echo off");
    await assert.rejects(
      () => resolveCodexExecutable({
        env: { PATH: path.join(temporary, "npm"), APPDATA: temporary, LOCALAPPDATA: temporary },
        platform: "win32",
        arch: "x64",
      }),
      /WORKBENCH_CODEX_EXECUTABLE/,
    );
  });
});
