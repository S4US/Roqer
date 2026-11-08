import assert from "node:assert/strict";
import test from "node:test";
import type { SkillLibrary } from "./skill-library";
import { MAX_WORKBENCH_TOOLS } from "./workbench-mcp-server";
import { workbenchMcpTools, workbenchToolNames } from "./workbench-tools";

const SKILLS: SkillLibrary = {
  catalog: [],
  load: async (name, resource = "SKILL.md") => ({ name, resource, content: "# Test skill" }),
};

test("the image tool is announced only while an image source is on, after Blender and before the clip and MCP tools", () => {
  assert.deepEqual(workbenchToolNames({ skillLibrary: SKILLS }), ["roblox_studio", "load_skill", "resolve_icon", "update_task_list", "ask_user", "open_link"]);
  assert.deepEqual(workbenchToolNames({ skillLibrary: SKILLS, imageGeneration: true }), [
    "roblox_studio", "load_skill", "resolve_icon", "update_task_list", "ask_user", "open_link", "image",
  ]);
  const everything = { skillLibrary: SKILLS, blender: true, imageGeneration: true, referenceClips: true, externalMcp: true };
  assert.deepEqual(workbenchToolNames(everything), [
    "roblox_studio", "load_skill", "resolve_icon", "update_task_list", "ask_user", "open_link", "blender", "image", "reference_clip", "external_mcp",
  ]);
  // The definitions follow the names, and all of them fit the workbench server.
  assert.deepEqual(workbenchMcpTools(everything).map((tool) => tool.name), workbenchToolNames(everything));
  assert.ok(workbenchToolNames(everything).length <= MAX_WORKBENCH_TOOLS);
});
