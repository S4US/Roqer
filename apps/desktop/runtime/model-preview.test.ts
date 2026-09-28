import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectGlb, isViewableGlb, modelPreviewFileName, readModelPreview } from "./model-preview";
import { glbBytes } from "./test-glb";
import { isModelPreviewId, isModelPreviewResult, MAX_MODEL_PREVIEW_BYTES } from "../shared/model-preview";

const view = (bytes: Buffer) => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const problem = (bytes: Buffer) => {
  const result = inspectGlb(view(bytes));
  return result.ok ? undefined : result.problem;
};

/** A mesh's worth of glTF: one buffer in the file's own binary chunk, and an image packed beside it. */
const MESH = {
  asset: { version: "2.0", generator: "Khronos glTF Blender I/O" },
  buffers: [{ byteLength: 8 }],
  bufferViews: [{ buffer: 0, byteLength: 8 }],
  images: [{ bufferView: 0, mimeType: "image/png" }],
};

test("a self-contained GLB passes, packed or with data URIs", () => {
  assert.equal(problem(glbBytes()), undefined);
  assert.equal(problem(glbBytes(MESH, new Uint8Array(8))), undefined);
  assert.equal(problem(glbBytes({ ...MESH, images: [{ uri: "data:image/png;base64,iVBORw0KGgo=" }] }, new Uint8Array(8))), undefined);
  // An extension the viewer decodes on its own may be required.
  assert.equal(problem(glbBytes({ ...MESH, extensionsRequired: ["KHR_texture_transform"] }, new Uint8Array(8))), undefined);
});

test("a file that is not a well-formed GLB is refused", () => {
  const good = glbBytes(MESH, new Uint8Array(8));
  const changed = (offset: number, value: number) => {
    const copy = Buffer.from(good);
    copy.writeUInt32LE(value, offset);
    return copy;
  };
  assert.match(problem(Buffer.alloc(12)) ?? "", /too short/);
  assert.match(problem(changed(0, 0x12345678)) ?? "", /not a GLB/);
  assert.match(problem(changed(4, 1)) ?? "", /not glTF 2\.0/);
  assert.match(problem(changed(8, good.length + 4)) ?? "", /length does not match/);
  assert.match(problem(Buffer.concat([good, Buffer.alloc(4)])) ?? "", /length does not match/);
  assert.match(problem(changed(16, 0x004e4942)) ?? "", /first chunk is not JSON/);
  assert.match(problem(changed(12, 0x7fffffff)) ?? "", /runs past the end/);

  const unreadable = Buffer.from(glbBytes({ asset: { version: "2.0" } }));
  unreadable.write("{", 20, "utf8");
  unreadable.write("{", 21, "utf8");
  assert.match(problem(unreadable) ?? "", /does not parse/);
  assert.match(problem(glbBytes([1, 2, 3])) ?? "", /not a glTF 2\.0 asset/);
  assert.match(problem(glbBytes({ asset: { version: "1.0" } })) ?? "", /not a glTF 2\.0 asset/);

  // A second binary chunk, which the format does not allow.
  const twice = glbBytes(MESH, new Uint8Array(8));
  const extra = Buffer.concat([twice, twice.subarray(twice.length - 16)]);
  extra.writeUInt32LE(extra.length, 8);
  assert.match(problem(extra) ?? "", /more than one binary chunk/);
});

test("a GLB that would make the viewer fetch or decode something it cannot is refused", () => {
  assert.match(problem(glbBytes({ ...MESH, buffers: [{ byteLength: 8, uri: "model.bin" }] })) ?? "", /outside itself/);
  assert.match(problem(glbBytes({ ...MESH, images: [{ uri: "https://example.com/wood.png" }] })) ?? "", /outside itself/);
  assert.match(problem(glbBytes({ ...MESH, images: [{ uri: "file:///etc/passwd" }] })) ?? "", /outside itself/);
  assert.match(problem(glbBytes({ ...MESH, images: ["wood.png"] })) ?? "", /outside itself/);
  assert.match(
    problem(glbBytes({ ...MESH, extensionsRequired: ["KHR_draco_mesh_compression"] })) ?? "",
    /needs KHR_draco_mesh_compression/,
  );
  assert.match(problem(glbBytes({ ...MESH, extensionsRequired: ["EXT_meshopt_compression"] })) ?? "", /needs EXT_meshopt_compression/);
  assert.match(problem(Buffer.alloc(MAX_MODEL_PREVIEW_BYTES + 1)) ?? "", /larger than a preview may be/);
});

async function withJobs(run: (jobsRoot: string, jobDirectory: string) => Promise<void>): Promise<void> {
  const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-model-preview-test-"));
  const jobDirectory = path.join(jobsRoot, "2026-09-28T10-00-00-000Z-a1b2c3d4");
  await fs.mkdir(jobDirectory);
  try {
    await run(jobsRoot, jobDirectory);
  } finally {
    await fs.rm(jobsRoot, { recursive: true, force: true });
  }
}

test("a preview is served by its id alone, from its own job's folder, and checked again", async () => {
  await withJobs(async (jobsRoot, jobDirectory) => {
    const file = glbBytes(MESH, new Uint8Array(8));
    await fs.writeFile(path.join(jobDirectory, modelPreviewFileName(0)), file);

    const served = await readModelPreview(jobsRoot, "a1b2c3d4-0");
    assert.equal(served.ok, true);
    assert.ok(served.ok && Buffer.from(served.bytes).equals(file));
    assert.ok(isModelPreviewResult(served));

    // Another model of the same job, or another job, was never kept or has been cleared.
    assert.deepEqual(await readModelPreview(jobsRoot, "a1b2c3d4-1"), { ok: false, reason: "expired" });
    assert.deepEqual(await readModelPreview(jobsRoot, "0badc0de-0"), { ok: false, reason: "expired" });
    assert.deepEqual(await readModelPreview(path.join(jobsRoot, "gone"), "a1b2c3d4-0"), { ok: false, reason: "expired" });
  });
});

test("an id that could name anything but a preview is refused before the disk is touched", async () => {
  await withJobs(async (jobsRoot) => {
    for (const id of ["../a1b2c3d4-0", "a1b2c3d4-0/..", "A1B2C3D4-0", "a1b2c3d4-10", "a1b2c3d4", "a1b2c3d4-0.glb", "", 7, null, undefined]) {
      assert.equal(isModelPreviewId(id), false, String(id));
      assert.deepEqual(await readModelPreview(jobsRoot, id), { ok: false, reason: "invalid" }, String(id));
    }
  });
});

test("a preview file that changed since it was checked is not served", async () => {
  await withJobs(async (jobsRoot, jobDirectory) => {
    await fs.writeFile(path.join(jobDirectory, modelPreviewFileName(0)), glbBytes({ ...MESH, buffers: [{ uri: "../../secret.bin" }] }));
    await fs.mkdir(path.join(jobDirectory, modelPreviewFileName(1)));
    await fs.writeFile(path.join(jobDirectory, modelPreviewFileName(2)), Buffer.from("not a model"));
    // A well-formed GLB elsewhere on disk, linked in where the preview would be,
    // where the system lets a test make a link (Windows asks for a privilege).
    const elsewhere = path.join(jobsRoot, "elsewhere.glb");
    await fs.writeFile(elsewhere, glbBytes());
    const linked = await fs.symlink(elsewhere, path.join(jobDirectory, modelPreviewFileName(4)), "file").then(() => true, () => false);

    assert.deepEqual(await readModelPreview(jobsRoot, "a1b2c3d4-0"), { ok: false, reason: "invalid" });
    assert.deepEqual(await readModelPreview(jobsRoot, "a1b2c3d4-1"), { ok: false, reason: "invalid" });
    assert.deepEqual(await readModelPreview(jobsRoot, "a1b2c3d4-2"), { ok: false, reason: "invalid" });
    if (linked) assert.deepEqual(await readModelPreview(jobsRoot, "a1b2c3d4-4"), { ok: false, reason: "invalid" });
    assert.equal(await isViewableGlb(path.join(jobDirectory, modelPreviewFileName(2))), false);
    assert.equal(await isViewableGlb(path.join(jobDirectory, modelPreviewFileName(3))), false);
  });
});

test("only a well-formed answer crosses to the renderer", () => {
  assert.equal(isModelPreviewResult({ ok: true, bytes: new Uint8Array(4) }), true);
  assert.equal(isModelPreviewResult({ ok: false, reason: "expired" }), true);
  assert.equal(isModelPreviewResult({ ok: true, bytes: [1, 2, 3] }), false);
  assert.equal(isModelPreviewResult({ ok: true, bytes: new Uint8Array(MAX_MODEL_PREVIEW_BYTES + 1) }), false);
  assert.equal(isModelPreviewResult({ ok: false, reason: "C:\\Users" }), false);
  assert.equal(isModelPreviewResult(undefined), false);
});
