import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findStudioContentDirectories, MAX_KEPT_PREVIEWS, PREVIEW_RETENTION_MS, PREVIEW_URI_PREFIX, prunePreviews, stageStudioPreviews,
} from "./studio-preview";

async function withTemp(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-studio-preview-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** A fake LOCALAPPDATA with Roblox version folders; `studio` says which hold Studio. */
async function versions(root: string, folders: Record<string, { studio: boolean; content: boolean }>): Promise<void> {
  for (const [name, { studio, content }] of Object.entries(folders)) {
    const install = path.join(root, "Roblox", "Versions", name);
    await fs.mkdir(install, { recursive: true });
    if (studio) await fs.writeFile(path.join(install, "RobloxStudioBeta.exe"), "");
    if (content) await fs.mkdir(path.join(install, "content"));
  }
}

test("only Windows Studio installs with a content folder are found", async () => {
  await withTemp(async (root) => {
    await versions(root, {
      "version-aaa": { studio: true, content: true },
      "version-bbb": { studio: false, content: true }, // the player, not Studio
      "version-ccc": { studio: true, content: false },
      "other": { studio: true, content: true },
    });
    const found = await findStudioContentDirectories({ LOCALAPPDATA: root }, "win32");
    assert.deepEqual(found, [path.join(root, "Roblox", "Versions", "version-aaa", "content")]);
    // macOS keeps content inside the signed app bundle, which is never written.
    assert.deepEqual(await findStudioContentDirectories({ LOCALAPPDATA: root }, "darwin"), []);
    assert.deepEqual(await findStudioContentDirectories({}, "win32"), []);
  });
});

test("staging copies each texture into every install under a name unique to the job", async () => {
  await withTemp(async (root) => {
    const a = path.join(root, "a", "content");
    const b = path.join(root, "b", "content");
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });
    const sheet = path.join(root, "Fire Burst.flipbook.png");
    const icon = path.join(root, "icon.png");
    await fs.writeFile(sheet, "sheet");
    await fs.writeFile(icon, "icon");

    const previews = await stageStudioPreviews(
      [{ name: "Fire Burst.flipbook.png", path: sheet }, { name: "icon.png", path: icon }, { name: "icon.png", path: icon }],
      "0a1b2c3d", [a, b], Date.now(),
    );

    assert.deepEqual(previews.map((preview) => preview.uri), [
      `${PREVIEW_URI_PREFIX}0a1b2c3d-Fire_Burst.png`,
      `${PREVIEW_URI_PREFIX}0a1b2c3d-icon.png`,
      `${PREVIEW_URI_PREFIX}0a1b2c3d-icon_2.png`,
    ]);
    for (const content of [a, b]) {
      const folder = path.join(content, "textures", "roqer-preview");
      assert.deepEqual((await fs.readdir(folder)).sort(), ["0a1b2c3d-Fire_Burst.png", "0a1b2c3d-icon.png", "0a1b2c3d-icon_2.png"]);
      assert.equal(await fs.readFile(path.join(folder, "0a1b2c3d-Fire_Burst.png"), "utf8"), "sheet");
    }
    assert.deepEqual(await stageStudioPreviews([{ name: "icon.png", path: icon }], "0a1b2c3d", []), [], "no install, nothing staged");
    await assert.rejects(stageStudioPreviews([{ name: "icon.png", path: icon }], "../evil", [a]), /not a job id/);
  });
});

test("pruning removes old and surplus previews, and nothing that is not a preview", async () => {
  await withTemp(async (folder) => {
    const now = Date.now();
    const write = async (name: string, ageMs: number) => {
      const file = path.join(folder, name);
      await fs.writeFile(file, "x");
      await fs.utimes(file, (now - ageMs) / 1000, (now - ageMs) / 1000);
    };
    await write("0a1b2c3d-old.png", PREVIEW_RETENTION_MS + 60_000);
    await write("0a1b2c3d-new.png", 60_000);
    await write("sparkles_main.dds", PREVIEW_RETENTION_MS * 2);
    await write("notes.txt", PREVIEW_RETENTION_MS * 2);
    for (let i = 0; i < MAX_KEPT_PREVIEWS + 3; i++) await write(`${(0x10000000 + i).toString(16)}-f.png`, 120_000 + i * 1000);

    await prunePreviews(folder, now);

    const left = await fs.readdir(folder);
    assert.ok(!left.includes("0a1b2c3d-old.png"), "past retention");
    assert.ok(left.includes("sparkles_main.dds") && left.includes("notes.txt"), "files Roqer did not name are left alone");
    assert.equal(left.filter((name) => name.endsWith(".png")).length, MAX_KEPT_PREVIEWS);
    assert.ok(left.includes("0a1b2c3d-new.png"), "the newest are kept");
  });
});
