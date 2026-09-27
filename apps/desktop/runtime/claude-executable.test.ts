import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveClaudeExecutable } from "./claude-executable";
import { ClientNotInstalledError } from "./client-not-installed";

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

async function writeFile(file: string, content: string | Buffer = "test"): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** Large enough to pass for the native binary, not the npm placeholder. */
const NATIVE_BINARY = Buffer.alloc(8192);

test("Claude executable discovery finds the native binary inside a Windows npm global install", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-claude-"));
  try {
    const prefix = path.join(temporary, "npm");
    await writeFile(path.join(prefix, "claude.cmd"), "@echo off");
    const executable = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    await writeFile(executable, NATIVE_BINARY);

    assert.equal(await resolveClaudeExecutable({
      env: { PATH: prefix, USERPROFILE: temporary },
      platform: "win32",
      arch: "x64",
    }), executable);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Claude executable discovery skips the npm placeholder for the platform package's binary", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-claude-"));
  try {
    const root = path.join(temporary, "npm", "node_modules", "@anthropic-ai", "claude-code");
    // The postinstall did not run, so bin/claude.exe is still the error-printing stub.
    await writeFile(path.join(root, "bin", "claude.exe"), "echo \"Error: claude native binary not installed.\" >&2\nexit 1\n");
    const executable = path.join(root, "node_modules", "@anthropic-ai", "claude-code-win32-arm64", "claude.exe");
    await writeFile(executable, NATIVE_BINARY);

    assert.equal(await resolveClaudeExecutable({
      env: { PATH: "", APPDATA: temporary, USERPROFILE: temporary },
      platform: "win32",
      arch: "arm64",
    }), executable);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Claude executable discovery prefers the native install over an npm install", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-claude-"));
  try {
    const native = path.join(temporary, ".local", "bin", "claude.exe");
    await writeFile(native);
    await writeFile(path.join(temporary, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), NATIVE_BINARY);

    assert.equal(await resolveClaudeExecutable({
      env: { PATH: "", APPDATA: temporary, USERPROFILE: temporary },
      platform: "win32",
      arch: "x64",
    }), native);
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
    (error) => error instanceof ClientNotInstalledError && /WORKBENCH_CLAUDE_EXECUTABLE/.test(error.message),
  );
});
