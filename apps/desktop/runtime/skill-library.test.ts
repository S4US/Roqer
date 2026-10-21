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

test("a resource checked out with Windows line endings loads as the same text as on Linux", async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, "roblox-test", "references", "full.md"), "# Full reference\r\n\r\nA line.\r\n");
    const library = await openSkillLibrary(root);
    const reference = await library.load("roblox-test", "references/full.md");
    assert.equal(reference.content, "# Full reference\n\nA line.\n");
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

test("a module below templates/install is read only for a template write, and may be larger than a document", async () => {
  const root = await fixture();
  try {
    const kit = path.join(root, "roblox-test", "templates", "install");
    await fs.mkdir(kit, { recursive: true });
    // Larger than any document may be, as an icon registry is.
    const registry = `return {\n${"\tIcon = \"rbxassetid://1\",\n".repeat(4_000)}}\n`;
    assert.ok(registry.length > 64 * 1024);
    await fs.writeFile(path.join(kit, "Registry.lua"), registry);
    await fs.writeFile(path.join(kit, "Huge.lua"), "-".repeat(256 * 1024 + 1));
    const library = await openSkillLibrary(root);

    await assert.rejects(
      () => library.load("roblox-test", "templates/install/Registry.lua"),
      /installs unchanged with set_script_source \{template: "roblox-test\/templates\/install\/Registry\.lua"\}, so it is not loaded/,
    );
    assert.equal((await library.load("roblox-test", "templates/install/Registry.lua", { write: true })).content, registry);
    await assert.rejects(
      () => library.load("roblox-test", "templates/install/Huge.lua", { write: true }),
      /no larger than 262144 bytes/,
    );
    // Every other template keeps the document limit, written or read.
    await fs.writeFile(path.join(root, "roblox-test", "templates", "sim", "wheel.lua"), registry);
    await assert.rejects(
      () => library.load("roblox-test", "templates/sim/wheel.lua", { write: true }),
      /no larger than 65536 bytes/,
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
