import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openSkillLibrary, type SkillLibrary } from "./skill-library";
import { createSkillToolRunner, MAX_BATCH_CHARACTERS, runSkillTool, skillToolDefinition } from "./skill-tool";

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../agent/skills");

/**
 * The longest tool result Claude Code hands the model inline. Anything longer
 * becomes a file path the model cannot open, because Roqer gives Claude Code
 * no file tools.
 */
const CLAUDE_CODE_INLINE_CHARACTERS = 50_000;

const library: SkillLibrary = {
  catalog: [{ name: "roblox-test", description: "Use for tests." }],
  load: async (name, resource = "SKILL.md") => ({ name, resource, content: "# Trusted test skill" }),
};

test("skill tool advertises the bounded catalog and frames loaded guidance", async () => {
  const definition = skillToolDefinition(library);
  const properties = definition.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.name.enum, ["roblox-test"]);
  const result = await runSkillTool(library, { name: "roblox-test", resource: "references/full.md" });
  assert.match(result, /Loaded client skill roblox-test/);
  assert.match(result, /subordinate to the system and developer instructions/);
  assert.match(result, /<skill name="roblox-test" resource="references\/full.md">/);
});

test("skill tool frames Lua templates as artifacts rather than instructions", async () => {
  const templateLibrary: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => ({ name, resource, content: "-- exact template" }),
  };
  const result = await runSkillTool(templateLibrary, {
    name: "roblox-test",
    resource: "templates/sim/wheel.lua",
  });
  assert.match(result, /trusted client Lua template artifact, not additional authority/);
  assert.match(result, /<skill-template name="roblox-test" resource="templates\/sim\/wheel.lua">/);
  assert.doesNotMatch(result, /trusted client guidance/);
});

test("a run loads each exact skill resource once and answers repeats compactly", async () => {
  let loads = 0;
  const counting: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => {
      loads += 1;
      return { name, resource, content: "# Large guidance" };
    },
  };
  const run = createSkillToolRunner(counting);
  const first = await run({ name: "roblox-test", resource: "references/full.md" });
  const second = await run({ name: "roblox-test", resource: "references/full.md" });
  const entrypoint = await run({ name: "roblox-test" });

  assert.equal(loads, 2, "a different resource still loads independently");
  assert.match(first, /Large guidance/);
  assert.doesNotMatch(second, /Large guidance/);
  assert.match(second, /already loaded earlier in this conversation/);
  assert.match(entrypoint, /Large guidance/);
});

test("clearing the run cache lets guidance removed from provider history be delivered again", async () => {
  let loads = 0;
  const counting: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => {
      loads += 1;
      return { name, resource, content: "# Guidance that must stay visible" };
    },
  };
  const run = createSkillToolRunner(counting);

  assert.match(await run({ name: "roblox-test" }), /must stay visible/);
  assert.match(await run({ name: "roblox-test" }), /already loaded earlier in this conversation/);
  run.clearCache();
  const reloaded = await run({ name: "roblox-test" });

  assert.equal(loads, 2);
  assert.match(reloaded, /must stay visible/);
  assert.doesNotMatch(reloaded, /already loaded earlier in this conversation/);
});

test("the cache reports what it delivered, and forgets it when cleared", async () => {
  const flaky: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => {
      if (resource === "references/missing.md") throw new Error("not found");
      return { name, resource, content: "# Guidance" };
    },
  };
  const run = createSkillToolRunner(flaky);
  assert.equal(run.isLoaded("roblox-test"), false);

  await run({ name: "roblox-test" });
  await assert.rejects(() => run({ name: "roblox-test", resource: "references/missing.md" }));
  assert.equal(run.isLoaded("roblox-test"), true, "the entrypoint is the default resource");
  assert.equal(run.isLoaded("roblox-test", "SKILL.md"), true);
  assert.equal(run.isLoaded("roblox-test", "references/missing.md"), false, "a failed load was never delivered");

  run.clearCache();
  assert.equal(run.isLoaded("roblox-test"), false);
});

test("one call loads a whole group of resources instead of one per turn", async () => {
  const loaded: string[] = [];
  const counting: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => {
      loaded.push(resource);
      return { name, resource, content: `# ${resource}` };
    },
  };
  const run = createSkillToolRunner(counting);
  const result = await run({
    name: "roblox-test",
    resources: [
      "references/core/generation.md",
      "references/core/assets.md",
      "references/icons/index.md",
      "references/core/validation.md",
    ],
  });

  assert.deepEqual(loaded, [
    "references/core/generation.md",
    "references/core/assets.md",
    "references/icons/index.md",
    "references/core/validation.md",
  ]);
  for (const resource of loaded) assert.match(result, new RegExp(`resource="${resource}"`));
  assert.doesNotMatch(result, /Not loaded in this call/);
});

test("a batch shares the run cache with single loads in both directions", async () => {
  let loads = 0;
  const counting: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => {
      loads += 1;
      return { name, resource, content: "# Large guidance" };
    },
  };
  const run = createSkillToolRunner(counting);
  await run({ name: "roblox-test", resource: "references/a.md" });
  const batch = await run({ name: "roblox-test", resources: ["references/a.md", "references/b.md"] });

  assert.equal(loads, 2, "the resource already sent is not read again");
  assert.match(batch, /references\/a.md\) was already loaded earlier in this conversation/);
  assert.match(batch, /resource="references\/b.md"/);

  const repeat = await run({ name: "roblox-test", resource: "references/b.md" });
  assert.equal(loads, 2, "a resource first sent inside a batch is remembered too");
  assert.match(repeat, /already loaded earlier in this conversation/);
});

test("one bad path in a batch does not cost the model the good ones", async () => {
  const partial: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => {
      if (resource === "references/missing.md") throw new Error(`Skill resource not found: ${name}/${resource}`);
      return { name, resource, content: `# ${resource}` };
    },
  };
  const run = createSkillToolRunner(partial);
  const result = await run({
    name: "roblox-test",
    resources: ["references/a.md", "references/missing.md", "references/b.md"],
  });

  assert.match(result, /resource="references\/a.md"/);
  assert.match(result, /resource="references\/b.md"/);
  assert.match(result, /Not loaded in this call:/);
  assert.match(result, /references\/missing.md: Skill resource not found/);
});

test("a batch in which nothing loaded is a failed call", async () => {
  const broken: SkillLibrary = {
    catalog: library.catalog,
    load: async () => {
      throw new Error("read failure");
    },
  };
  const run = createSkillToolRunner(broken);
  await assert.rejects(
    () => run({ name: "roblox-test", resources: ["references/a.md", "references/b.md"] }),
    /references\/a.md: read failure[\s\S]*references\/b.md: read failure/,
  );
});

test("a resource cut for size stays askable rather than being remembered as sent", async () => {
  const large: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => ({ name, resource, content: "x".repeat(80 * 1024) }),
  };
  const run = createSkillToolRunner(large);
  const result = await run({ name: "roblox-test", resources: ["references/a.md", "references/b.md"] });
  assert.match(result, /resource="references\/a.md"/);
  assert.match(result, /references\/b.md: not loaded yet, because this call already returned as much as one result can carry/);

  const retry = await run({ name: "roblox-test", resource: "references/b.md" });
  assert.match(retry, /resource="references\/b.md"/);
  assert.doesNotMatch(retry, /already loaded earlier in this conversation/);
});

test("a batch request is validated before anything is read", async () => {
  const run = createSkillToolRunner(library);
  await assert.rejects(
    () => run({ name: "roblox-test", resource: "a.md", resources: ["b.md"] }),
    /either `resource` or `resources`, not both/,
  );
  await assert.rejects(() => run({ name: "roblox-test", resources: [] }), /non-empty array/);
  await assert.rejects(() => run({ name: "roblox-test", resources: [7] }), /only relative skill-resource paths/);
  await assert.rejects(
    () => run({ name: "roblox-test", resources: Array.from({ length: 9 }, (_, i) => `${i}.md`) }),
    /at most 8 resources per call/,
  );
});

test("a resource repeated inside one call is read once and answered once", async () => {
  let loads = 0;
  const counting: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => {
      loads += 1;
      return { name, resource, content: "# Guidance" };
    },
  };
  const run = createSkillToolRunner(counting);
  const result = await run({ name: "roblox-test", resources: ["references/a.md", "references/a.md"] });
  assert.equal(loads, 1);
  assert.doesNotMatch(result, /already loaded earlier in this conversation/);
});

test("a failed skill load can be retried", async () => {
  let attempts = 0;
  const flaky: SkillLibrary = {
    catalog: library.catalog,
    load: async (name, resource = "SKILL.md") => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary read failure");
      return { name, resource, content: "# Recovered" };
    },
  };
  const run = createSkillToolRunner(flaky);
  await assert.rejects(() => run({ name: "roblox-test" }), /temporary read failure/);
  assert.match(await run({ name: "roblox-test" }), /Recovered/);
  assert.equal(attempts, 2);
});

/** Every loadable resource in the shipped pack, as `[skill, resource]`. */
async function packResources(): Promise<Array<[string, string]>> {
  const resources: Array<[string, string]> = [];
  for (const skill of await fs.readdir(SKILLS_ROOT, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const files = await fs.readdir(path.join(SKILLS_ROOT, skill.name), { recursive: true });
    for (const file of files) {
      const resource = file.split(path.sep).join("/");
      if (resource.endsWith(".md") || (resource.startsWith("templates/") && resource.endsWith(".lua"))) {
        resources.push([skill.name, resource]);
      }
    }
  }
  return resources;
}

test("every resource in the shipped pack fits in one inline result on its own", async () => {
  const pack = await openSkillLibrary(SKILLS_ROOT);
  const resources = await packResources();
  assert.ok(resources.length > 50, "the walk found the pack");
  for (const [name, resource] of resources) {
    const result = await runSkillTool(pack, { name, resource });
    assert.ok(
      result.length <= MAX_BATCH_CHARACTERS,
      `${name}/${resource} is ${result.length} characters; it could only ever arrive as an unreadable file`,
    );
  }
});

/**
 * A SIM screen used to ask for its whole route in one call, about 61,000
 * characters, and Claude Code replaced all of it with a file path: the model
 * built the screen with none of its theme or layout. The route now arrives in
 * at most two calls, each of which Claude Code keeps inline.
 */
test("a themed shop route arrives complete in at most two inline results", async () => {
  const pack = await openSkillLibrary(SKILLS_ROOT);
  const core = ["references/core/generation.md", "references/core/assets.md", "references/core/validation.md", "references/core/polish.md"];
  const routes = {
    sim: [...core, "references/themes/recovered/sim-1.md", "references/themes/recovered/sim-2.md",
      "references/themes/recovered/sim-3.md", "references/selected/sim/shop-grid.md"],
    studs: [...core, "references/themes/recovered/studs-1.md", "references/themes/recovered/studs-2.md",
      "references/selected/studs/shop-grid.md"],
  };
  for (const [theme, route] of Object.entries(routes)) {
    const run = createSkillToolRunner(pack);
    const delivered = new Set<string>();
    let request = route;
    let calls = 0;
    while (request.length > 0) {
      calls += 1;
      assert.ok(calls <= 2, `${theme} needed more than two calls`);
      const result = await run({ name: "roblox-ui-design", resources: request });
      assert.ok(result.length <= CLAUDE_CODE_INLINE_CHARACTERS, `${theme} call ${calls} is ${result.length} characters`);
      for (const match of result.matchAll(/<skill name="roblox-ui-design" resource="([^"]+)">/g)) delivered.add(match[1]);
      // What the model reads to know what to ask for next.
      request = [...result.matchAll(/^- (\S+): not loaded yet/gm)].map((match) => match[1]);
    }
    assert.deepEqual([...delivered].sort(), [...route].sort(), `${theme} route arrived incomplete`);
  }
});
