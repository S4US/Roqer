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

test("a blender call may ask to preview its textures in Studio, only with a boolean", () => {
  assert.deepEqual(parseBlenderToolInput({ script: "import bpy", preview_in_studio: true }).args, { script: "import bpy", preview_in_studio: true });
  assert.deepEqual(parseBlenderToolInput({ script: "import bpy", preview_in_studio: false }).args, { script: "import bpy" });
  assert.throws(() => parseBlenderToolInput({ script: "import bpy", preview_in_studio: "yes" }), /preview_in_studio must be true or false/);
  const properties = blenderToolDefinition().inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.preview_in_studio.type, "boolean");
  assert.match(String(properties.preview_in_studio.description), /before it is uploaded/);
});

test("the blender tool says how to build in stages and what a script may be", () => {
  const tool = blenderToolDefinition();
  assert.match(tool.description, /one job per stage, each continuing from the last \(see continue_from\)/);
  assert.match(tool.description, /use_visible=True/);
  assert.match(tool.description, /at most 60,000 characters/);
  const properties = (tool.inputSchema.properties as Record<string, Record<string, unknown>>);
  assert.equal(properties.continue_from.pattern, "^[0-9a-f]{8}$");
  assert.match(String(properties.continue_from.description), /Every job whose script finishes saves its scene/);
  assert.match(String(properties.continue_from.description), /to undo a step, continue from an earlier job/);
  assert.match(String(properties.script.description), /roqer\.cylinder_between/);
});
