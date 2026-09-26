import assert from "node:assert/strict";
import test from "node:test";

import { blenderToolDefinition, parseBlenderToolInput } from "./blender-tool";

test("a blender call may name the earlier job whose scene it continues, and only in that job's own form", () => {
  assert.deepEqual(parseBlenderToolInput({ script: "import bpy", continue_from: "0a1b2c3d" }), {
    operation: "run_blender_script",
    args: { script: "import bpy", continue_from: "0a1b2c3d" },
  });
  assert.deepEqual(parseBlenderToolInput({ script: "import bpy", continue_from: null }).args, { script: "import bpy" });
  for (const bad of ["job-1", "../scene", "0A1B2C3D", 12345678]) {
    assert.throws(() => parseBlenderToolInput({ script: "import bpy", continue_from: bad }), /continue_from must be the id of an earlier job/);
  }
});

test("the blender tool says how to build in stages and what a script may be", () => {
  const tool = blenderToolDefinition();
  assert.match(tool.description, /with continue_from set to an earlier job's id, on the scene that job saved/);
  assert.match(tool.description, /use_visible=True/);
  assert.match(tool.description, /at most 60,000 characters/);
  const properties = (tool.inputSchema.properties as Record<string, Record<string, unknown>>);
  assert.equal(properties.continue_from.pattern, "^[0-9a-f]{8}$");
});
