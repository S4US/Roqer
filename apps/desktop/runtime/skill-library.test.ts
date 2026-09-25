import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openSkillLibrary } from "./skill-library";

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-skills-test-"));
  await fs.mkdir(path.join(root, "roblox-test", "references"), { recursive: true });
  await fs.writeFile(path.join(root, "roblox-test", "SKILL.md"), [
    "---",
    "name: roblox-test",
    'description: "Use for a focused test."',
    "---",
    "",
    "# Test skill",
    "",
    "Read [details](references/full.md) when needed.",
  ].join("\n"));
  await fs.writeFile(path.join(root, "roblox-test", "references", "full.md"), "# Full reference\n");
  await fs.mkdir(path.join(root, "roblox-test", "templates", "sim"), { recursive: true });
  await fs.writeFile(path.join(root, "roblox-test", "templates", "sim", "wheel.lua"), "-- exact template\n");
  await fs.mkdir(path.join(root, "roblox-test", "scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "roblox-test", "scripts", "helper.lua"), "return true\n");
  return root;
}

test("skill library discovers frontmatter and loads entrypoints and linked references", async () => {
  const root = await fixture();
  try {
    const library = await openSkillLibrary(root);
    assert.deepEqual(library.catalog, [{ name: "roblox-test", description: "Use for a focused test." }]);
    assert.match((await library.load("roblox-test")).content, /# Test skill/);
    const reference = await library.load("roblox-test", "references/full.md");
    assert.equal(reference.resource, "references/full.md");
    assert.equal(reference.content, "# Full reference\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("skill library loads canonical Lua templates without opening arbitrary code files", async () => {
  const root = await fixture();
  try {
    const library = await openSkillLibrary(root);
    const template = await library.load("roblox-test", "templates/sim/wheel.lua");
    assert.equal(template.content, "-- exact template\n");
    await assert.rejects(
      () => library.load("roblox-test", "scripts/helper.lua"),
      /Lua files below templates/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("skill library rejects unknown skills, traversal, and unsupported resources", async () => {
  const root = await fixture();
  try {
    const library = await openSkillLibrary(root);
    await assert.rejects(() => library.load("missing"), /Unknown client skill/);
    await assert.rejects(() => library.load("roblox-test", "../SKILL.md"), /traversal/);
    await assert.rejects(() => library.load("roblox-test", "references/data.json"), /Only Markdown skill resources/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
