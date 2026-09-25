import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BlenderSettings, detectBlender, isBlenderExecutablePath } from "./blender-settings";

const BLENDER = path.resolve("/Program Files/Blender Foundation/Blender 5.2/blender.exe");

async function withFile(run: (file: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-blender-settings-"));
  try {
    await run(path.join(directory, "blender.json"), directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("a found Blender starts off, turns on once it has answered, and the choice persists", async () => {
  await withFile(async (file) => {
    let versionChecks = 0;
    const settings = new BlenderSettings({
      file,
      detect: async () => BLENDER,
      version: async () => { versionChecks += 1; return "Blender 5.2.1 LTS"; },
    });
    assert.deepEqual(await settings.get(), {
      enabled: false, executable: BLENDER, version: "Blender 5.2.1 LTS", state: "off",
      message: "Blender 5.2.1 LTS found. Turn it on to let the agent model assets with it.",
    });
    assert.equal(await settings.ready(), undefined, "off means no worker");
    assert.equal((await settings.setEnabled(true)).state, "ready");
    assert.equal(await settings.ready(), BLENDER);
    assert.equal(versionChecks, 1, "one --version per executable, not per look");

    const reopened = new BlenderSettings({ file, detect: async () => null, version: async () => "Blender 5.2.1 LTS" });
    assert.equal((await reopened.get()).state, "ready");
  });
});

test("the worker cannot be turned on without a Blender that answers", async () => {
  await withFile(async (file) => {
    const missing = new BlenderSettings({ file, detect: async () => null, version: async () => undefined });
    assert.equal((await missing.get()).state, "missing");
    await assert.rejects(() => missing.setEnabled(true), /working Blender/);

    const broken = new BlenderSettings({ file: `${file}.2`, detect: async () => BLENDER, version: async () => undefined });
    assert.equal((await broken.get()).state, "broken");
    await assert.rejects(() => broken.setEnabled(true), /working Blender/);
    assert.equal(await broken.ready(), undefined);
  });
});

test("only an absolute path to a file named like Blender is accepted, and a new one starts off", async () => {
  assert.equal(isBlenderExecutablePath(BLENDER), true);
  assert.equal(isBlenderExecutablePath("blender.exe"), false, "relative");
  assert.equal(isBlenderExecutablePath(path.resolve("/tools/python.exe")), false);
  await withFile(async (file) => {
    const settings = new BlenderSettings({ file, detect: async () => BLENDER, version: async () => "Blender 5.2.1 LTS" });
    await settings.setEnabled(true);
    await assert.rejects(() => settings.setExecutable(path.resolve("/tools/python.exe")), /blender\.exe/);
    const other = path.resolve("/Other/Blender 4.5/blender.exe");
    const changed = await settings.setExecutable(other);
    assert.deepEqual([changed.executable, changed.enabled], [other, false]);
  });
});

test("a damaged settings file starts over, off, from what is installed", async () => {
  await withFile(async (file) => {
    await fs.writeFile(file, "{\"schemaVersion\":1,\"enabled\":true,\"executable\":\"C:/tools/evil.exe\"}", "utf8");
    const settings = new BlenderSettings({ file, detect: async () => BLENDER, version: async () => "Blender 5.2.1 LTS" });
    const view = await settings.get();
    assert.deepEqual([view.executable, view.enabled], [BLENDER, false]);
  });
});

test("detection finds the newest installed Blender", async () => {
  await withFile(async (_file, directory) => {
    for (const version of ["Blender 4.10", "Blender 5.2", "Blender 3.6"]) {
      const folder = path.join(directory, "Blender Foundation", version);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "blender.exe"), "");
    }
    assert.equal(await detectBlender({ ProgramFiles: directory }, "win32"),
      path.join(directory, "Blender Foundation", "Blender 5.2", "blender.exe"));
    assert.equal(await detectBlender({ ProgramFiles: path.join(directory, "nowhere") }, "win32"), null);
  });
});
