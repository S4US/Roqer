import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveClaudeExecutable } from "./claude-executable";

test("Claude executable discovery finds the native Windows install outside PATH", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-claude-"));
  try {
    const executable = path.join(temporary, ".local", "bin", "claude.exe");
    const shimDirectory = path.join(temporary, "shim");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.mkdir(shimDirectory, { recursive: true });
    await fs.writeFile(executable, "test");
    // A .cmd shim cannot be spawned with shell:false, so it must be skipped.
    await fs.writeFile(path.join(shimDirectory, "claude.cmd"), "@echo off");

    assert.equal(await resolveClaudeExecutable({
      env: { USERPROFILE: temporary, PATH: shimDirectory },
      platform: "win32",
    }), executable);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Claude executable discovery prefers PATH over the install location", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-claude-"));
  try {
    const onPath = path.join(temporary, "bin", "claude");
    const installed = path.join(temporary, ".local", "bin", "claude");
    await fs.mkdir(path.dirname(onPath), { recursive: true });
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.writeFile(onPath, "test");
    await fs.writeFile(installed, "test");

    assert.equal(await resolveClaudeExecutable({
      env: { HOME: temporary, PATH: path.dirname(onPath) },
      platform: "linux",
    }), onPath);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Claude executable discovery honors the explicit main-process override", async () => {
  assert.equal(await resolveClaudeExecutable({
    env: { WORKBENCH_CLAUDE_EXECUTABLE: "D:\\portable\\claude.exe" },
    platform: "win32",
  }), "D:\\portable\\claude.exe");
});

test("Claude executable discovery reports a usable error when nothing is installed", async () => {
  await assert.rejects(
    () => resolveClaudeExecutable({ env: { PATH: "", USERPROFILE: "Z:\\nonexistent" }, platform: "win32" }),
    /WORKBENCH_CLAUDE_EXECUTABLE/,
  );
});
