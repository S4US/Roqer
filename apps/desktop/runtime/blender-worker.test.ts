import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  BlenderWorker, HELPERS_SCRIPT, otherSideName, readSceneContents, RUNNER_SCRIPT, scriptEnvironment, type SpawnProcess,
} from "./blender-worker";
import { glbBytes } from "./test-glb";
import { png, sheet } from "./test-png";

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
    // Roqer's helpers sit beside the script, and the runner hands them to it as roqer.
    assert.equal(await fs.readFile(path.join(data.jobDirectory, "roqer_helpers.py"), "utf8"), HELPERS_SCRIPT);
    assert.deepEqual(outcome.images, [{ data: png.toString("base64"), mediaType: "image/png" }]);
    assert.match(outcome.text, /12 triangles, 1 mesh, 1 material, 2\.00 × 2\.00 × 2\.00 Blender units/);
    assert.match(outcome.text, /upload_asset \{action: 'upload'/);
    // Which way the model will face in Roblox is said where the model decides it.
    assert.match(outcome.text, /Blender \(x, y, z\) arrives at \(-x, z, y\): Blender -Y becomes Roblox's forward/);
  });
});

test("the inspection reports where UVs are, their range, and meshes a texture cannot map onto", async () => {
  await withJobs(async (jobsRoot) => {
    const reports: Record<string, unknown> = {
      "slash.glb": { meshes: 2, without: [], withoutCount: 0, low: [0, 0], high: [1, 1] },
      "sword.glb": { meshes: 1, without: ["Handle"], withoutCount: 1, low: [-0.5, 0], high: [2, 1] },
      "crate.glb": { meshes: 0, without: ["Crate"], withoutCount: 1 },
    };
    const blender = fakeBlender(async (args) => {
      if (args.some((arg) => arg.endsWith("roqer_runner.py"))) {
        for (const name of Object.keys(reports)) await fs.writeFile(path.join(argAfterDashes(args), "output", name), Buffer.alloc(64));
        return { output: "ROQER_SCRIPT_DONE\n" };
      }
      const uv = reports[path.basename(argAfterDashes(args))];
      return { output: `ROQER_INSPECT ${JSON.stringify({ meshes: 2, triangles: 64, materials: [], size: [1, 1, 1], uv })}\n` };
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const outcome = await worker.run({ script: "import bpy" });

    assert.equal(outcome.ok, true, outcome.text);
    // Each file's entry runs from its "- <path>" line to the next.
    const entry = (name: string) => {
      const lines = outcome.text.split("\n");
      const start = lines.findIndex((line) => line.startsWith("- ") && line.includes(name));
      const end = lines.findIndex((line, index) => index > start && !line.startsWith("  "));
      return lines.slice(start, end).join("\n");
    };
    assert.match(entry("slash.glb"), /UVs on 2 meshes, spanning U 0\.00 to 1\.00 and V 0\.00 to 1\.00\./);
    assert.match(entry("sword.glb"), /UVs on 1 mesh, spanning U -0\.50 to 2\.00 and V 0\.00 to 1\.00; outside 0 to 1 a texture repeats; no UVs on Handle, where a texture shows as one flat colour\./);
    assert.doesNotMatch(entry("crate.glb"), /UVs/, "a model with no UVs anywhere says nothing about textures");
  });
});

test("the runner gives the script Roqer's placement helpers, and only those", () => {
  assert.match(RUNNER_SCRIPT, /roqer_helpers\.py/);
  assert.match(RUNNER_SCRIPT, /"roqer": roqer/);
  for (const helper of ["box", "box_between", "cylinder_between", "cone_between", "join", "paint", "vertex_color_material", "flipbook",
    "vfx_arc", "vfx_ring", "vfx_cone", "vfx_swirl", "vfx_shell"]) {
    assert.match(HELPERS_SCRIPT, new RegExp(`^def ${helper}\\(`, "m"), helper);
  }
  // A helper places a part by its ends; it never asks the model for a rotation angle.
  assert.doesNotMatch(HELPERS_SCRIPT, /def \w+\([^)]*rotation/);
  assert.doesNotMatch(HELPERS_SCRIPT, /shade_smooth/);
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

test("a flipbook sheet is checked from its pixels, apart from ordinary renders, with its note read only as a claim", async () => {
  await withJobs(async (jobsRoot) => {
    const burst = sheet(8, (i) => (i >= 62 ? 0 : 6 + Math.min(i, 61 - i)));
    // Noise does not compress: this sheet is over the attachment limit, so its half-size copy is shown instead.
    let seed = 7;
    const noisy = png(1024, 1024, (x, y) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const inCell = x % 256 > 8 && x % 256 < 248 && y % 256 > 8 && y % 256 < 248;
      return inCell ? [seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, 255] : [0, 0, 0, 0];
    });
    const halfSize = png(512, 512, () => [128, 128, 128, 255]);
    const blender = fakeBlender(async (args) => {
      const output = path.join(argAfterDashes(args), "output");
      await fs.writeFile(path.join(output, "Burst.flipbook.png"), burst);
      await fs.writeFile(path.join(output, "Burst.flipbook.json"), JSON.stringify({
        name: "Burst", grid: 8, mode: "alpha", padding: 4, loop: false, fps: 32, engine: "BLENDER_EEVEE",
        renderSeconds: Array.from({ length: 64 }, () => 0.05),
      }));
      await fs.writeFile(path.join(output, "Noise.flipbook.png"), noisy);
      await fs.writeFile(path.join(output, "Noise.flipbook.json"), "{ not json");
      await fs.writeFile(path.join(output, "Noise.flipbook-preview.png"), halfSize);
      await fs.writeFile(path.join(output, "icon.png"), pngHeader(256, 256));
      return { output: "ROQER_SCRIPT_DONE\n" };
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const outcome = await worker.run({ script: "import bpy\nroqer.flipbook('Burst')" });

    assert.equal(outcome.ok, true, outcome.text);
    const data = outcome.data as {
      images: Array<{ name: string }>;
      otherFiles: string[];
      flipbooks: Array<{ name: string; report?: { ok: boolean; grid?: number; settings?: { FlipbookMode: string } } }>;
    };
    assert.deepEqual(data.images.map((image) => image.name), ["icon.png"], "sheets, notes and copies are not ordinary renders");
    assert.deepEqual(data.otherFiles, []);
    assert.deepEqual(data.flipbooks.map((flipbook) => flipbook.name), ["Burst.flipbook.png", "Noise.flipbook.png"]);
    const [checked, noise] = data.flipbooks;
    assert.equal(checked.report?.ok, true);
    assert.equal(checked.report?.settings?.FlipbookMode, "OneShot", "a burst played once, as its note says, may end faded out");
    assert.match(outcome.text, /Burst\.flipbook\.png: 1024 x 1024, transparent background, 8 x 8 grid \(its gutters agree\)/);
    assert.match(outcome.text, /FlipbookLayout = Grid8x8, FlipbookMode = OneShot, LightEmission = 0, Lifetime = 2/);
    assert.match(outcome.text, /64 frames rendered in 3\.2 s with BLENDER_EEVEE/);
    // An unreadable note claims nothing; the sheet is still checked from its pixels.
    assert.equal(noise.report?.grid, 4);
    assert.match(outcome.text, /half-size copy of it is attached instead/);
    assert.deepEqual(outcome.images?.map((image) => image.data), [pngHeader(256, 256), burst, halfSize].map((bytes) => bytes.toString("base64")));
    assert.match(outcome.text, /Do not go by FlipbookIncompatible/);
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

/**
 * A job that exports the given models, whose inspection of each does what
 * `inspect` says: writes a preview picture, writes the 3D preview it was
 * asked for (the argument after the picture), and prints its stats.
 */
function previewedJob(models: string[], inspect: (name: string) => { preview: boolean; glb?: Buffer }) {
  return fakeBlender(async (args) => {
    if (args.some((arg) => arg.endsWith("roqer_runner.py"))) {
      for (const name of models) await fs.writeFile(path.join(argAfterDashes(args), "output", name), Buffer.alloc(1024));
      return { output: "ROQER_SCRIPT_DONE\n" };
    }
    const { preview, glb } = inspect(path.basename(argAfterDashes(args)));
    if (preview) await fs.writeFile(argAfterDashes(args, 1), pngHeader(512, 384));
    const modelPreview = argAfterDashes(args, 2);
    if (glb !== undefined && modelPreview !== undefined) await fs.writeFile(modelPreview, glb);
    const stats = { meshes: 1, triangles: 12, materials: [], size: [2, 2, 2], preview, model3d: glb !== undefined && modelPreview !== undefined };
    return { output: `ROQER_INSPECT ${JSON.stringify(stats)}\n` };
  });
}

test("the pictured model's 3D preview is kept for the chat, under an id the model never reads", async () => {
  await withJobs(async (jobsRoot) => {
    const glb = glbBytes({ asset: { version: "2.0" }, buffers: [{ byteLength: 8 }] }, new Uint8Array(8));
    const blender = previewedJob(["crate.glb"], () => ({ preview: true, glb }));
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const outcome = await worker.run({ script: "import bpy" });

    assert.equal(outcome.ok, true, outcome.text);
    const data = outcome.data as { jobId: string; jobDirectory: string };
    assert.deepEqual(outcome.pictured, { name: "crate.glb", modelPreviewId: `${data.jobId}-0` });
    // Written where the host named it, inside the job's folder, from the model's position alone.
    assert.equal(argAfterDashes(blender.calls[1].args, 2), path.join(data.jobDirectory, "model-preview-0.glb"));
    assert.ok((await fs.readFile(path.join(data.jobDirectory, "model-preview-0.glb"))).equals(glb));
    assert.doesNotMatch(JSON.stringify(data) + outcome.text, /model-preview|modelPreviewId/);
  });
});

test("a 3D preview the viewer could not show is removed, and the picture stays", async () => {
  await withJobs(async (jobsRoot) => {
    const outside = glbBytes({ asset: { version: "2.0" }, images: [{ uri: "C:/Users/me/wood.png" }] });
    const blender = previewedJob(["crate.glb"], () => ({ preview: true, glb: outside }));
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const outcome = await worker.run({ script: "import bpy" });

    assert.equal(outcome.ok, true, outcome.text);
    assert.deepEqual(outcome.pictured, { name: "crate.glb" });
    assert.equal(outcome.images?.length, 1);
    const { jobDirectory } = outcome.data as { jobDirectory: string };
    await assert.rejects(fs.stat(path.join(jobDirectory, "model-preview-0.glb")), { code: "ENOENT" });
  });
});

test("only the model the chat pictures is exported in 3D", async () => {
  await withJobs(async (jobsRoot) => {
    const glb = glbBytes();
    // The first model's picture fails, so the second is the one the chat shows.
    const blender = previewedJob(["a-crate.glb", "b-barrel.glb", "c-lamp.glb"], (name) => ({ preview: name !== "a-crate.glb", glb }));
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const outcome = await worker.run({ script: "import bpy" });

    assert.equal(outcome.ok, true, outcome.text);
    const { jobId, jobDirectory } = outcome.data as { jobId: string; jobDirectory: string };
    assert.deepEqual(outcome.pictured, { name: "b-barrel.glb", modelPreviewId: `${jobId}-1` });
    assert.deepEqual((await fs.readdir(jobDirectory)).filter((name) => name.startsWith("model-preview")), ["model-preview-1.glb"]);
    // Once a picture is kept, the next model is not asked for a 3D preview at all.
    assert.equal(argAfterDashes(blender.calls[3].args, 2), undefined);
    assert.equal(outcome.images?.length, 2);
  });
});

/**
 * What Roqer's inspection printed for a real model: a go-kart a model built
 * from 77 primitives, re-imported and measured in Blender. Its headrest and
 * roll-hoop bar float off the body, its steering wheel reaches nothing, and its
 * side pods run into the wheels.
 */
const KART_LAYOUT = {
  pieces: 77, complete: true,
  loose: [
    { object: "Body", pieces: 1, size: [1.6, 0.16, 0.16], center: [0, -1.52, 3.4], gap: 0.18 },
    { object: "Body", pieces: 1, size: [1.1, 0.3, 0.55], center: [0, -1.38, 2.85], gap: 0.08 },
    { object: "SteeringWheel", pieces: 1, size: [0.8, 0.17, 0.17], center: [0, 0.42, 1.62], gap: 0.07 },
    { object: "SteeringWheel", pieces: 1, size: [1.1, 0.17, 0.17], center: [0, 0.88, 2.08], gap: 0.06 },
  ],
  looseCount: 4,
  isolated: [{ object: "SteeringWheel", gap: 0.39, nearest: "Body" }],
  isolatedCount: 1,
  overlaps: [
    { objects: ["Body", "Wheel_RL"], depth: 0.55, piece: { object: "Body", size: [0.14, 3.7, 0.14], center: [2.4, 0.1, 0.85] } },
    { objects: ["Body", "Wheel_RR"], depth: 0.55, piece: { object: "Body", size: [0.14, 3.7, 0.14], center: [-2.4, 0.1, 0.85] } },
    { objects: ["Body", "Wheel_FL"], depth: 0.38, piece: { object: "Body", size: [0.9, 3.6, 0.75], center: [1.9, 0.1, 0.95] } },
    { objects: ["Body", "Wheel_FR"], depth: 0.38, piece: { object: "Body", size: [0.9, 3.6, 0.75], center: [-1.9, 0.1, 0.95] } },
  ],
  overlapCount: 4,
};

/** A worker whose inspection prints the given stats for one exported model. */
function inspectedWorker(jobsRoot: string, stats: Record<string, unknown>) {
  const blender = fakeBlender(async (args) => {
    if (args.some((arg) => arg.endsWith("roqer_runner.py"))) {
      await fs.writeFile(path.join(argAfterDashes(args), "output", "model.glb"), Buffer.alloc(1024));
      return { output: "ROQER_SCRIPT_DONE\n" };
    }
    return { output: `ROQER_INSPECT ${JSON.stringify({ meshes: 6, triangles: 1772, materials: ["Paint"], preview: false, ...stats })}\n` };
  });
  return new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: blender.spawn, killTree: blender.killTree, env: {} });
}

test("the layout reaches the model as facts in the script's own coordinates", async () => {
  await withJobs(async (jobsRoot) => {
    const outcome = await inspectedWorker(jobsRoot, { min: [-3.08, -3.84, 0.01], layout: KART_LAYOUT }).run({ script: "import bpy" });

    assert.equal(outcome.ok, true, outcome.text);
    const file = (outcome.data as { files: Array<{ layout?: { looseCount: number; overlaps: unknown[] }; bottom?: number }> }).files[0];
    assert.equal(file.layout?.looseCount, 4);
    assert.equal(file.layout?.overlaps.length, 4);
    assert.equal(file.bottom, 0.01);
    // Each fact names a piece by the size and position the script gave it.
    assert.match(outcome.text, /in the script's Blender coordinates/);
    assert.match(outcome.text, /4 piece groups attached to nothing, usually a gap to close: in Body, a piece 1\.60 × 0\.16 × 0\.16 at \(0\.00, -1\.52, 3\.40\), 0\.18 from the rest of Body/);
    assert.match(outcome.text, /An object touching no other object \(right for a kit set.*\): SteeringWheel, 0\.39 from Body/);
    assert.match(outcome.text, /Body and Wheel_RL by 0\.55, deepest at the Body piece 0\.14 × 3\.70 × 0\.14 at \(2\.40, 0\.10, 0\.85\)/);
    assert.match(outcome.text, /Lowest point at Z 0\.01\./, "a model on the ground gets no advice about it");
    assert.doesNotMatch(outcome.text, /shading:/, "no shading line without smooth shading");
  });
});

test("a model of moving pieces is given as rig's joints, and its joints' overlaps are not findings", async () => {
  await withJobs(async (jobsRoot) => {
    const object = (name: string, low: number[], high: number[], origin: number[], parent?: string) => ({
      name, size: [high[0] - low[0], high[2] - low[2], high[1] - low[1]], origin, low, high, mesh: name, materials: 1, ...(parent ? { parent } : {}),
    });
    const outcome = await inspectedWorker(jobsRoot, {
      min: [-0.6, -1.6, 0],
      objects: [
        object("Body", [-0.6, -1.6, 1.5], [0.6, 1.6, 2.5], [0, 0, 0]),
        object("Tail", [-0.15, 1.5, 2.0], [0.15, 2.8, 2.3], [0, 1.55, 2.2], "Body"),
        object("Flag", [-0.1, -0.1, 2.4], [0.1, 0.1, 3.4], [0, 0, 2.45], "Body"),
      ],
      layout: {
        pieces: 3, complete: true, loose: [], looseCount: 0, isolated: [], isolatedCount: 0,
        overlaps: [{ objects: ["Body", "Tail"], depth: 0.1, piece: { object: "Body", size: [1.2, 3.2, 1], center: [0, 0, 2] } }],
        overlapCount: 1,
      },
    }).run({ script: "import bpy" });

    assert.equal(outcome.ok, true, outcome.text);
    const file = (outcome.data as { files: Array<{ articulation?: { root: string; joints: unknown[] } }> }).files[0];
    assert.equal(file.articulation?.root, "Body");
    assert.deepEqual(file.articulation?.joints, [
      { part: "Tail", parent: "Body", pivot: [0, 2.2, 1.55] },
      { part: "Flag", parent: "Body", pivot: [0, 2.45, 0] },
    ]);
    assert.match(outcome.text, /moving pieces: 3 pieces in a tree from Body/);
    assert.match(outcome.text, /All 3 pieces connected, and separate objects pass into each other only where one hangs from the other\./);
    assert.doesNotMatch(outcome.text, /fine where one is meant to sit inside the other/);
  });
});

test("the runner's piece helper is one of Roqer's helpers", () => {
  assert.match(HELPERS_SCRIPT, /^def piece\(obj, pivot, parent=None\):/m);
  // It moves the origin without moving the shape, and names the mesh as Roblox will name the part.
  assert.match(HELPERS_SCRIPT, /obj\.data\.transform\(Matrix\.Translation\(-local\)\)/);
  assert.match(HELPERS_SCRIPT, /obj\.data\.name = obj\.name/);
});

test("smooth shading across hard edges is reported, and malformed entries are dropped", async () => {
  await withJobs(async (jobsRoot) => {
    const outcome = await inspectedWorker(jobsRoot, {
      smoothShaded: [{ object: "GoKart", share: 0.92 }, { object: 3, share: 0.5 }, { object: "Lid", share: "most" }],
    }).run({ script: "import bpy" });
    assert.deepEqual((outcome.data as { files: Array<{ smoothShaded?: unknown }> }).files[0].smoothShaded, [{ object: "GoKart", share: 0.92 }]);
    assert.match(outcome.text, /shading: smooth across hard edges on GoKart \(92% of corners\).*remove shade_smooth/);
  });
});

test("a clean, a skipped or a malformed layout is reported for what it is", async () => {
  await withJobs(async (jobsRoot) => {
    const clean = await inspectedWorker(jobsRoot, {
      min: [0, 0, 1.5],
      layout: { pieces: 12, complete: true, loose: [], looseCount: 0, isolated: [], isolatedCount: 0, overlaps: [], overlapCount: 0 },
    }).run({ script: "import bpy" });
    assert.match(clean.text, /All 12 pieces connected, and no separate objects pass into each other/);
    assert.match(clean.text, /Lowest point at Z 1\.50; 0 stands it on the ground/);

    const skipped = await inspectedWorker(jobsRoot, { layout: { pieces: 400, skipped: "more than 300 separate pieces" } }).run({ script: "import bpy" });
    assert.match(skipped.text, /Layout not measured \(more than 300 separate pieces\); judge it from the preview/);

    const malformed = await inspectedWorker(jobsRoot, {
      layout: {
        pieces: 3, complete: false,
        loose: [{ object: "Body", size: [1, 2], center: [0, 0, 0], gap: 1 }, "junk", { object: 7, size: [1, 1, 1], center: [0, 0, 0], gap: 1 }],
        looseCount: 2,
        isolated: [{ object: "Lid", gap: "far" }],
        overlaps: [{ objects: ["A"], depth: 1, piece: { size: [1, 1, 1], center: [0, 0, 0] } }],
      },
    }).run({ script: "import bpy" });
    const layout = (malformed.data as { files: Array<{ layout?: { loose: unknown[]; isolated: unknown[]; overlaps: unknown[]; looseCount: number } }> }).files[0].layout;
    assert.deepEqual([layout?.loose.length, layout?.isolated.length, layout?.overlaps.length], [0, 0, 0], "no malformed entry survives");
    assert.equal(layout?.looseCount, 2, "the count still says pieces are loose");
    assert.match(malformed.text, /2 piece groups attached to nothing, usually a gap to close\./);
    assert.match(malformed.text, /The comparison stopped at its time limit/);

    const none = await inspectedWorker(jobsRoot, { layout: "not an object" }).run({ script: "import bpy" });
    assert.equal((none.data as { files: Array<{ layout?: unknown }> }).files[0].layout, undefined);
    assert.doesNotMatch(none.text, /layout/);
  });
});

test("an overdue or cancelled job takes Blender's process tree down", async () => {
  await withJobs(async (jobsRoot) => {
    const controller = new AbortController();
    // Cancelled once Blender is running, not after a fixed delay: on a busy
    // machine the job can take longer than any delay to reach the spawn.
    const hanging = fakeBlender(async () => {
      setImmediate(() => controller.abort());
      return { hang: true };
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, spawn: hanging.spawn, killTree: hanging.killTree, env: {} });
    const pending = worker.run({ script: "while True: pass" }, { signal: controller.signal });
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

const SCENE = {
  objects: [
    { name: "Chassis", type: "curve", size: [0.498, 3.026, 0.15], center: [0.201, 0, 0.225], triangles: 48 },
    { name: "Kart_Body", type: "mesh", size: [1, 2, 0.3], center: [0, 0, 0.45], triangles: 22, materials: ["Paint"], modifiers: ["mirror"] },
    { name: "Cutter", type: "mesh", hidden: true, size: [1, 1, 1], center: [0, 0, 2], triangles: 12 },
  ],
  count: 3,
  triangles: 82,
};

/**
 * A fake Blender whose script finishes and saves its scene, as the real runner
 * does, and whose inspection of that scene returns a preview.
 */
function savingBlender(scene: unknown = SCENE, options: Readonly<{ exports?: boolean }> = {}) {
  const preview = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
  const blender = fakeBlender(async (args) => {
    if (args.some((arg) => arg.endsWith("roqer_runner.py"))) {
      const jobDirectory = argAfterDashes(args);
      await fs.writeFile(path.join(jobDirectory, "scene.blend"), "BLENDER-v500");
      await fs.writeFile(path.join(jobDirectory, "scene.json"), JSON.stringify(scene));
      if (options.exports === true) await fs.writeFile(path.join(jobDirectory, "output", "kart.glb"), Buffer.alloc(64));
      return { output: "ROQER_SCENE_SAVED\nROQER_SCRIPT_DONE\n" };
    }
    await fs.writeFile(argAfterDashes(args, 1), preview);
    return { output: `ROQER_INSPECT ${JSON.stringify({ meshes: 2, triangles: 70, materials: ["Paint"], size: [1, 3.03, 0.45], min: [-0.5, -1.51, 0.15], preview: true })}\n` };
  });
  return { ...blender, preview };
}

const runnerCalls = (calls: ReadonlyArray<{ args: readonly string[] }>) =>
  calls.filter((call) => call.args.some((arg) => arg.endsWith("roqer_runner.py")));

test("a job saves its scene, and a later job in the same chat starts from it instead of an empty one", async () => {
  // A detailed model used to have to fit one script, written in one model
  // turn: a go-kart ran nine minutes and failed whole. Now each stage is its
  // own job, continuing the scene the one before it saved.
  await withJobs(async (jobsRoot) => {
    const blender = savingBlender();
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: blender.spawn, killTree: blender.killTree, env: {} });

    const frame = await worker.run({ script: "import bpy\n# the frame" });
    assert.equal(frame.ok, true, frame.text);
    const first = frame.data as { jobId: string; scene: { path: string; contents: { count: number } } };
    assert.match(first.jobId, /^[0-9a-f]{8}$/);
    assert.equal(first.scene.contents.count, 3);
    // Nothing was exported, so the saved scene is what is inspected and previewed.
    assert.equal(blender.calls.length, 2);
    assert.equal(argAfterDashes(blender.calls[1].args), first.scene.path);
    assert.deepEqual(frame.images, [{ data: blender.preview.toString("base64"), mediaType: "image/png" }]);
    assert.match(frame.text, /Nothing was exported, so Roqer checked the scene this job saved/);
    assert.match(frame.text, new RegExp(`Scene saved as job ${first.jobId}: 3 objects, 82 triangles`));
    assert.match(frame.text, /- Kart_Body \(mesh\): 1\.00 × 2\.00 × 0\.30 at \(0\.00, 0\.00, 0\.45\); 22 triangles; materials Paint; modifiers mirror/);
    assert.match(frame.text, new RegExp(`call blender again with continue_from: '${first.jobId}'`));
    assert.doesNotMatch(frame.text, /upload_asset/, "a scene is not something to upload");

    const body = await worker.run({ script: "import bpy\n# the body", continue_from: first.jobId });
    assert.equal(body.ok, true, body.text);
    const second = body.data as { jobId: string; continuedFrom: string };
    assert.notEqual(second.jobId, first.jobId);
    assert.equal(second.continuedFrom, first.jobId);
    // The runner is handed the earlier scene to open in place of an empty one.
    const runners = runnerCalls(blender.calls);
    assert.equal(runners[0].args.length, runners[0].args.indexOf("--") + 2, "the first job has no scene to start from");
    assert.equal(argAfterDashes(runners[1].args, 1), first.scene.path);
    assert.match(body.text, new RegExp(`Scene saved as job ${second.jobId}, continuing job ${first.jobId}`));
  });
});

test("a job exports only when asked, and its scene is saved either way", async () => {
  await withJobs(async (jobsRoot) => {
    const blender = savingBlender(SCENE, { exports: true });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: blender.spawn, killTree: blender.killTree, env: {} });
    const outcome = await worker.run({ script: "import bpy\n# export the kart" });
    assert.equal(outcome.ok, true, outcome.text);
    // The export is what is inspected, and the upload instructions apply to it.
    assert.match(argAfterDashes(blender.calls[1].args), /kart\.glb$/);
    assert.match(outcome.text, /Roqer re-imported each exported model/);
    assert.match(outcome.text, /upload_asset/);
    assert.match(outcome.text, /Scene saved as job [0-9a-f]{8}/);
  });
});

test("a scene is continued only by its own chat, and only when the job that saved it finished", async () => {
  await withJobs(async (jobsRoot) => {
    const saving = savingBlender();
    const chatA = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: saving.spawn, killTree: saving.killTree, env: {} });
    const saved = (await chatA.run({ script: "import bpy" })).data as { jobId: string };

    // Another chat cannot build on it, and cannot learn from the answer that it
    // exists: with no scene of its own, it starts from an empty one either way.
    const other = savingBlender();
    const freshChat = (scope: string) => new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope, spawn: other.spawn, killTree: other.killTree, env: {} });
    const borrowed = await freshChat("chat-b").run({ script: "import bpy", continue_from: saved.jobId });
    // A first job that names a placeholder for "nothing yet" runs too.
    const invented = await freshChat("chat-c").run({ script: "import bpy", continue_from: "00000000" });
    for (const [outcome, id] of [[borrowed, saved.jobId], [invented, "00000000"]] as const) {
      assert.equal(outcome.ok, true, outcome.text);
      assert.match(outcome.text, new RegExp(`Job ${id} was not continued: this chat has no saved Blender scene yet, so the script ran on an empty scene`));
      assert.doesNotMatch(outcome.text, /continuing job/);
      assert.equal((outcome.data as { continuedFrom?: string }).continuedFrom, undefined);
    }
    const runs = other.calls.filter((call) => call.args.some((arg) => arg.endsWith("roqer_runner.py")));
    assert.equal(runs.length, 2);
    for (const run of runs) assert.equal(argAfterDashes(run.args, 1), undefined, "no base scene is opened");
    // If that script then fails, the answer still says it did not continue anything.
    const failingFresh = fakeBlender(async () => ({ output: "KeyError: 'Chassis'\nROQER_SCRIPT_FAILED\n", exitCode: 1 }));
    const chatD = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-d", spawn: failingFresh.spawn, killTree: failingFresh.killTree, env: {} });
    const failedFresh = await chatD.run({ script: "bpy.data.objects['Chassis']", continue_from: "00000000" });
    assert.equal(failedFresh.errorCode, "script_failed");
    assert.match(failedFresh.text, /^Job 00000000 was not continued: .* The script failed in Blender/);

    // A script that failed saved nothing, so there is nothing to continue.
    const failing = fakeBlender(async () => ({ output: "Traceback\nROQER_SCRIPT_FAILED\n", exitCode: 1 }));
    const broken = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: failing.spawn, killTree: failing.killTree, env: {} });
    const failed = await broken.run({ script: "raise ValueError()", continue_from: saved.jobId });
    assert.equal(failed.errorCode, "script_failed");
    assert.match(failed.text, new RegExp(`nothing was saved; the scene of job ${saved.jobId} is unchanged`));
    const failedId = path.basename((failed.data as { jobDirectory: string }).jobDirectory).split("-").at(-1)!;
    assert.equal((await chatA.run({ script: "import bpy", continue_from: failedId })).errorCode, "scene_not_found");

    assert.equal((await chatA.run({ script: "import bpy", continue_from: "../../etc" })).errorCode, "invalid_arguments");
    // Once the chat has saved scenes, an unknown id is not guessed at: the answer names the real ones.
    const unknown = await chatA.run({ script: "import bpy", continue_from: "0123abcd" });
    assert.equal(unknown.errorCode, "scene_not_found");
    assert.match(unknown.text, new RegExp(`no saved scene from job 0123abcd in this chat. This chat's saved scenes, newest first: ${saved.jobId}\\.`));
    assert.deepEqual((unknown.data as { savedJobs: string[] }).savedJobs, [saved.jobId]);
  });
});

test("clearing old jobs never clears the scene a job is continuing from", async () => {
  await withJobs(async (jobsRoot) => {
    let clock = Date.parse("2026-09-26T10:00:00Z");
    const blender = savingBlender();
    const worker = new BlenderWorker({
      executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: blender.spawn, killTree: blender.killTree, env: {}, now: () => clock,
    });
    const base = (await worker.run({ script: "import bpy" })).data as { jobId: string; scene: { path: string } };
    // Forty-five newer jobs, more than are kept, put the base among the oldest.
    for (let index = 0; index < 45; index += 1) {
      await fs.mkdir(path.join(jobsRoot, `2026-09-26T11-${String(index).padStart(2, "0")}-00-000Z-${String(index).padStart(8, "0")}`));
    }
    clock = Date.parse("2026-09-26T12:00:00Z");
    const continued = await worker.run({ script: "import bpy", continue_from: base.jobId });
    assert.equal(continued.ok, true, continued.text);
    assert.equal((await fs.stat(base.scene.path)).isFile(), true);
  });
});

test("hidden objects in a saved scene are named, because an export would carry them", async () => {
  await withJobs(async (jobsRoot) => {
    const blender = savingBlender();
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: blender.spawn, killTree: blender.killTree, env: {} });
    const outcome = await worker.run({ script: "import bpy" });
    assert.match(outcome.text, /- Cutter \(mesh\): .*; hidden/);
    assert.match(outcome.text, /Hidden objects \(Cutter\) are not in this preview, but an export includes them unless it passes use_visible=True/);
  });
});

test("geometry an export would fail on is named with its cause, and the rest of the list survives it", async () => {
  // A bevel over overlapping vertices put an engine's vertices at NaN. The
  // listing then held NaN, which is not JSON, so the whole of it vanished for
  // two jobs, and the export failed three times on an error naming no object.
  await withJobs(async (jobsRoot) => {
    const blender = savingBlender({
      objects: [
        { name: "Engine", type: "mesh", size: [1.37, 1.31, 0.94], center: [0.06, 1.84, 0.88], triangles: 5172, modifiers: ["bevel"], invalid: 56, invalidFrom: "modifiers" },
        { name: "Spring", type: "curve", size: [0.2, 0.2, 0.5], center: [0, 0, 0.5], triangles: 400, invalid: 3, invalidFrom: "geometry" },
      ],
      count: 2,
      triangles: 5572,
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: blender.spawn, killTree: blender.killTree, env: {} });
    const outcome = await worker.run({ script: "import bpy" });
    assert.equal(outcome.ok, true, outcome.text);
    assert.match(outcome.text, /- Engine \(mesh\): 1\.37 × 1\.31 × 0\.94 at .*; modifiers bevel; 56 vertices at invalid \(NaN\) positions/);
    assert.match(outcome.text, /Invalid geometry, which a glTF export fails on \("cannot convert float NaN to integer"\): Engine \(56 vertices, made by its modifiers: bevel\); Spring \(3 vertices, made by its own geometry\)\./);
    assert.match(outcome.text, /merge them before the modifier runs \(bmesh\.ops\.remove_doubles/);
    assert.match(outcome.text, /the script computed those positions as NaN/);
  });
});

test("a list Roqer cannot read is said to be missing, not left out in silence", async () => {
  await withJobs(async (jobsRoot) => {
    const saving = fakeBlender(async (args) => {
      if (args.some((arg) => arg.endsWith("roqer_runner.py"))) {
        const jobDirectory = argAfterDashes(args);
        await fs.writeFile(path.join(jobDirectory, "scene.blend"), "BLENDER-v500");
        await fs.writeFile(path.join(jobDirectory, "scene.json"), '{"objects": [{"name": "Engine", "type": "mesh", "size": [NaN, NaN, NaN]}]}');
        return { output: "ROQER_SCENE_SAVED\nROQER_SCRIPT_DONE\n" };
      }
      return { output: "" };
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: saving.spawn, killTree: saving.killTree, env: {} });
    const outcome = await worker.run({ script: "import bpy" });
    assert.match(outcome.text, /Scene saved as job [0-9a-f]{8}\. Roqer could not read the list of its objects this time/);
  });
});

test("left and right pairs placed on one side, or in one place, are named; mirrored pairs are not", async () => {
  // From a real go-kart: a fender placed by a sign the script forgot to flip
  // sat on top of its twin for ten jobs, as did a pair of headlights.
  await withJobs(async (jobsRoot) => {
    const mesh = (name: string, center: number[], size = [0.4, 0.8, 0.4]) => ({ name, type: "mesh", size, center, triangles: 100 });
    const blender = savingBlender({
      objects: [
        mesh("Tire_Front_L", [1.56, -2.05, 0.72], [0.76, 1.43, 1.43]),
        mesh("Tire_Front_R", [-1.56, -2.05, 0.72], [0.76, 1.43, 1.43]),
        mesh("Rim_Front_L", [1.575, -2.05, 0.72], [0.64, 0.79, 0.79]),
        mesh("Rim_Front_R", [-1.545, -2.05, 0.72], [0.64, 0.79, 0.79]),
        mesh("Left_Side_Pod", [1.42, 0.47, 0.93], [1.28, 1.69, 0.71]),
        mesh("Right_Side_Pod", [-1.42, 0.47, 0.93], [1.28, 1.69, 0.71]),
        mesh("Rear_Left_Wheel", [1.66, 2.05, 0.8]),
        mesh("Rear_Right_Wheel", [-1.66, 2.05, 0.8]),
        mesh("Front_Fender_L", [1.56, -2.105, 1.263], [0.91, 1.735, 0.97]),
        mesh("Front_Fender_R", [1.56, -2.105, 1.263], [0.91, 1.735, 0.97]),
        mesh("Nose_Vent_L", [0.742, -1.542, 0.792]),
        mesh("Nose_Vent_R", [0.657, -1.539, 0.916]),
        mesh("Mirror.L", [0.9, 0.2, 1.4]),
        mesh("Mirror.R", [-0.9, 0.6, 1.4]),
        { ...mesh("Cutter_L", [3, 3, 3]), hidden: true },
        mesh("Leftover", [2, 2, 2]),
      ],
      count: 16,
      triangles: 1600,
    });
    const worker = new BlenderWorker({ executable: EXECUTABLE, jobsRoot, scope: "chat-a", spawn: blender.spawn, killTree: blender.killTree, env: {} });
    const outcome = await worker.run({ script: "import bpy" });
    const line = outcome.text.split("\n").find((text) => text.startsWith("Left and right pairs"));
    assert.ok(line, outcome.text);
    assert.match(line, /across the model's centre \(X = 0\.00\)/);
    assert.match(line, /Front_Fender_L and Front_Fender_R are in the same place, at \(1\.56, -2\.10, 1\.26\)/);
    assert.match(line, /Nose_Vent_L at \(0\.74, -1\.54, 0\.79\) and Nose_Vent_R at \(0\.66, -1\.54, 0\.92\) are on the same side/);
    assert.match(line, /Mirror\.L at \(0\.90, 0\.20, 1\.40\) and Mirror\.R at \(-0\.90, 0\.60, 1\.40\) do not mirror each other/);
    for (const fine of ["Tire", "Rim", "Side_Pod", "Wheel", "Cutter", "Leftover"]) assert.doesNotMatch(line, new RegExp(fine));
  });
});

test("an object's other side is found only from a name that marks one side as its own word", () => {
  assert.equal(otherSideName("Front_Fender_L"), "Front_Fender_R");
  assert.equal(otherSideName("Hand.R"), "Hand.L");
  assert.equal(otherSideName("Rear_Left_Wheel"), "Rear_Right_Wheel");
  assert.equal(otherSideName("left arm"), "right arm");
  assert.equal(otherSideName("Headlight_L.001"), "Headlight_R.001");
  assert.equal(otherSideName("Leftover"), undefined);
  assert.equal(otherSideName("Wheel_FL"), undefined);
  assert.equal(otherSideName("L_Strut_R"), undefined);
  assert.equal(otherSideName("Chassis"), undefined);
});

test("a scene list the runner wrote is read as data: malformed entries are dropped, and a long one is bounded", async () => {
  await withJobs(async (jobsRoot) => {
    const file = path.join(jobsRoot, "scene.json");
    await fs.writeFile(file, JSON.stringify({
      objects: [
        { name: "Wheel", type: "mesh", size: [1, 1, 1], center: [0, 0, 0], triangles: 44.7, materials: ["Rubber", 7], parent: "Kart" },
        { name: "Engine", type: "mesh", invalid: 56.2, invalidFrom: "somewhere" },
        { name: "Pipe", type: "mesh", invalid: 0, invalidFrom: "modifiers" },
        { name: 5, type: "mesh" },
        { name: "Bad", type: "mesh", size: [1, "x", 1] },
        ...Array.from({ length: 200 }, (_, index) => ({ name: `Bolt_${index}`, type: "mesh" })),
      ],
      count: 205,
      triangles: 900,
    }));
    const contents = await readSceneContents(file);
    assert.deepEqual(contents?.objects[0], { name: "Wheel", type: "mesh", parent: "Kart", size: [1, 1, 1], center: [0, 0, 0], triangles: 44, materials: ["Rubber"] });
    assert.deepEqual(contents?.objects[1], { name: "Engine", type: "mesh", invalid: 56, invalidFrom: "geometry" });
    assert.deepEqual(contents?.objects[2], { name: "Pipe", type: "mesh" });
    assert.deepEqual(contents?.objects[3], { name: "Bad", type: "mesh" });
    assert.ok((contents?.objects.length ?? 0) <= 120);
    assert.equal(contents?.count, 205);
    await fs.writeFile(file, "not json");
    assert.equal(await readSceneContents(file), undefined);
  });
});
