import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { BlenderWorker, scriptEnvironment, type SpawnProcess } from "./blender-worker";

/** What one fake Blender process does: optional work, printed output, and how it ends. */
type Behaviour = (args: readonly string[]) => Promise<{ output?: string; exitCode?: number; hang?: boolean }>;

function fakeBlender(behaviour: Behaviour) {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const killed: ChildProcess[] = [];
  const spawn: SpawnProcess = (_command, args, options) => {
    calls.push({ args, env: options.env });
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), pid: 4242, exitCode: null });
    child.kill = () => true;
    void behaviour(args).then(({ output = "", exitCode = 0, hang = false }) => {
      stdout.write(output);
      if (!hang) setImmediate(() => child.emit("close", exitCode));
      else child.once("killed", () => child.emit("close", null));
    });
    return child;
  };
  const killTree = (child: ChildProcess) => {
    killed.push(child);
    (child as unknown as EventEmitter).emit("killed");
  };
  return { spawn, killTree, calls, killed };
}

async function withJobs(run: (jobsRoot: string) => Promise<void>): Promise<void> {
  const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-blender-test-"));
  try {
    await run(jobsRoot);
  } finally {
    await fs.rm(jobsRoot, { recursive: true, force: true });
  }
}

const EXECUTABLE = path.resolve("/blender/blender.exe");
const argAfterDashes = (args: readonly string[], index = 0) => args[args.indexOf("--") + 1 + index];

test("a job exports a model, and Roqer's own pass measures it and returns its preview", async () => {
  await withJobs(async (jobsRoot) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const blender = fakeBlender(async (args) => {
      if (args.some((arg) => arg.endsWith("roqer_runner.py"))) {
        await fs.writeFile(path.join(argAfterDashes(args), "output", "crate.glb"), Buffer.alloc(2048));
        return { output: "Blender 5.2\nROQER_SCRIPT_DONE\n" };
      }
      await fs.writeFile(argAfterDashes(args, 1), png);
      return { output: `ROQER_INSPECT ${JSON.stringify({ meshes: 1, triangles: 12, materials: ["Wood"], size: [2, 2, 2], preview: true })}\n` };
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const outcome = await worker.run({ script: "import bpy\n# builds a crate" });

    assert.equal(outcome.ok, true, outcome.text);
    assert.equal(blender.calls.length, 2, "the script, then one inspection");
    assert.deepEqual(blender.calls[0].args.slice(0, 4), ["--background", "--factory-startup", "--python-exit-code", "1"]);
    const data = outcome.data as { files: Array<{ name: string; triangles: number; materials: string[]; size: number[] }>; jobDirectory: string };
    assert.deepEqual(data.files.map(({ name, triangles, materials, size }) => ({ name, triangles, materials, size })),
      [{ name: "crate.glb", triangles: 12, materials: ["Wood"], size: [2, 2, 2] }]);
    assert.equal(await fs.readFile(path.join(data.jobDirectory, "script.py"), "utf8"), "import bpy\n# builds a crate");
    assert.deepEqual(outcome.images, [{ data: png.toString("base64"), mediaType: "image/png" }]);
    assert.match(outcome.text, /12 triangles, 1 mesh, 1 material, 2\.00 × 2\.00 × 2\.00 Blender units/);
    assert.match(outcome.text, /upload_asset \{action: 'upload'/);
  });
});

test("a script that raises, or exports nothing, is a failed call the model can read", async () => {
  await withJobs(async (jobsRoot) => {
    const raising = fakeBlender(async () => ({ output: "Traceback...\nValueError: bad mesh\nROQER_SCRIPT_FAILED\n", exitCode: 1 }));
    const failed = await new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: raising.spawn, killTree: raising.killTree, env: {} })
      .run({ script: "raise ValueError('bad mesh')" });
    assert.equal(failed.ok, false);
    assert.equal(failed.errorCode, "script_failed");
    assert.match(failed.text, /ValueError: bad mesh/);
    assert.equal(raising.calls.length, 1, "nothing to inspect after a failure");

    const empty = fakeBlender(async () => ({ output: "ROQER_SCRIPT_DONE\n" }));
    const nothing = await new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: empty.spawn, killTree: empty.killTree, env: {} })
      .run({ script: "import bpy" });
    assert.equal(nothing.errorCode, "no_model_exported");
    assert.match(nothing.text, /export_scene\.gltf\(filepath=os\.path\.join\(OUTPUT_DIR/);
  });
});

/** The smallest PNG header readPngSize accepts: signature, IHDR length and type, width, height. */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("a job that renders an image for UI returns it, measured from the file and attached", async () => {
  await withJobs(async (jobsRoot) => {
    const icon = pngHeader(512, 512);
    const blender = fakeBlender(async (args) => {
      const output = path.join(argAfterDashes(args), "output");
      await fs.writeFile(path.join(output, "barrel-icon.png"), icon);
      await fs.writeFile(path.join(output, "huge.png"), pngHeader(2048, 2048));
      await fs.writeFile(path.join(output, "fake.png"), "not a png");
      return { output: "ROQER_SCRIPT_DONE\n" };
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const outcome = await worker.run({ script: "import bpy\n# renders an icon" });

    assert.equal(outcome.ok, true, outcome.text);
    assert.equal(blender.calls.length, 1, "an image is not re-imported");
    const data = outcome.data as { files: unknown[]; images: Array<{ name: string; width?: number; height?: number; error?: string }> };
    assert.deepEqual(data.files, []);
    assert.deepEqual(data.images.map(({ name, width, height, error }) => ({ name, width, height, error })), [
      { name: "barrel-icon.png", width: 512, height: 512, error: undefined },
      { name: "fake.png", width: undefined, height: undefined, error: "Not a readable PNG." },
      { name: "huge.png", width: 2048, height: 2048, error: undefined },
    ]);
    assert.equal(outcome.images?.length, 2, "both real PNGs are attached; the fake is not");
    assert.equal(outcome.images?.[0].data, icon.toString("base64"));
    assert.match(outcome.text, /512 × 512 pixels/);
    assert.match(outcome.text, /2048 × 2048 pixels; Roblox keeps at most 1024 pixels a side/);
    assert.match(outcome.text, /assetType: 'Decal'/);
    assert.match(outcome.text, /imageId/);
    assert.doesNotMatch(outcome.text, /assetType: 'Model'/, "no model upload advice without a model");
  });
});

test("model previews come before rendered images in what the model sees", async () => {
  await withJobs(async (jobsRoot) => {
    const preview = pngHeader(512, 384);
    const icon = pngHeader(256, 256);
    const blender = fakeBlender(async (args) => {
      if (args.some((arg) => arg.endsWith("roqer_runner.py"))) {
        const output = path.join(argAfterDashes(args), "output");
        await fs.writeFile(path.join(output, "barrel.glb"), Buffer.alloc(1024));
        await fs.writeFile(path.join(output, "barrel-icon.png"), icon);
        return { output: "ROQER_SCRIPT_DONE\n" };
      }
      await fs.writeFile(argAfterDashes(args, 1), preview);
      return { output: `ROQER_INSPECT ${JSON.stringify({ meshes: 1, triangles: 48, materials: ["Wood"], size: [3, 4, 3], preview: true, colorSource: "vertex", objects: [{ name: "KitTree", size: [4, 9.25, 4] }, { name: "KitRock", size: [2.5, 2.5, 2.5] }] })}\n` };
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const outcome = await worker.run({ script: "import bpy" });

    assert.equal(outcome.ok, true, outcome.text);
    assert.deepEqual(outcome.images?.map((image) => image.data), [preview.toString("base64"), icon.toString("base64")]);
    assert.match(outcome.text, /assetType: 'Model'/);
    assert.match(outcome.text, /assetType: 'Decal'/);
    // Where the colour lives decides whether the agent repaints in Studio.
    assert.match(outcome.text, /coloured by vertex colours, which Roblox keeps: leave the MeshParts' Color white/);
    assert.equal((outcome.data as { files: Array<{ colorSource?: string }> }).files[0].colorSource, "vertex");
    // A kit set in one file lists each piece, so the pieces can be split into templates after upload.
    assert.match(outcome.text, /its own MeshPart named after it: KitTree 4\.00 × 9\.25 × 4\.00; KitRock 2\.50 × 2\.50 × 2\.50/);
  });
});

test("an overdue or cancelled job takes Blender's process tree down", async () => {
  await withJobs(async (jobsRoot) => {
    const hanging = fakeBlender(async () => ({ hang: true }));
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: hanging.spawn, killTree: hanging.killTree, env: {} });
    const controller = new AbortController();
    const pending = worker.run({ script: "while True: pass" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const cancelled = await pending;
    assert.equal(cancelled.errorCode, "cancelled");
    assert.equal(hanging.killed.length, 1);

    const already = new AbortController();
    already.abort();
    assert.equal((await worker.run({ script: "x = 1" }, { signal: already.signal })).errorCode, "cancelled");
  });
});

test("arguments are checked before anything runs, and the timeout is clamped", async () => {
  await withJobs(async (jobsRoot) => {
    const blender = fakeBlender(async () => ({ output: "ROQER_SCRIPT_DONE\n" }));
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });
    assert.equal((await worker.run({})).errorCode, "invalid_arguments");
    assert.equal((await worker.run({ script: "x".repeat(60_001) })).errorCode, "invalid_arguments");
    assert.equal(blender.calls.length, 0);
  });
});

test("a model-written script never sees credentials or Roqer's own settings", () => {
  const env = scriptEnvironment({
    PATH: "p",
    APPDATA: "a",
    ROBLOX_OPEN_CLOUD_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    ROBLOSECURITY: "secret",
    WORKBENCH_USER_DATA: "x",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.deepEqual(env, { PATH: "p", APPDATA: "a" });
});
