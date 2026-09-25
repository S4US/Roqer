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
