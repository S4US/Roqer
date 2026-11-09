import assert from "node:assert/strict";
import test from "node:test";
import { imageToolDefinition, parseImageToolInput } from "./image-tool";
import { MAX_TOOL_DESCRIPTION_CHARS } from "./studio-tools";

test("an image call needs a prompt, a kind and a name, and gets the kind's defaults", () => {
  assert.deepEqual(parseImageToolInput({ prompt: "a soft white glow", kind: "light", name: "glow" }), {
    operation: "generate_image",
    args: { prompt: "a soft white glow", kind: "light", background: "black", size: "1024x1024", count: 1, name: "glow" },
  });
  assert.equal(parseImageToolInput({ prompt: "x", kind: "icon", name: "coin" }).args.size, "512x512");
  assert.equal(parseImageToolInput({ prompt: "x", kind: "icon", name: "coin" }).args.background, "transparent");
  assert.equal(parseImageToolInput({ prompt: "x", kind: "tile", name: "planks" }).args.background, "opaque");
  const full = parseImageToolInput({
    prompt: "a slash", kind: "matter", name: "slash", background: "transparent", size: "1024x1024", count: 3, quality: "high",
    reference: { output: "0a1b2c3d/slash.png" }, preview_in_studio: true,
  });
  assert.deepEqual(full.args, {
    prompt: "a slash", kind: "matter", background: "transparent", size: "1024x1024", count: 3, name: "slash", quality: "high",
    reference: { output: "0a1b2c3d/slash.png" }, preview_in_studio: true,
  });
});

test("a malformed image call says what was wrong, in the model's terms", () => {
  assert.throws(() => parseImageToolInput("glow"), /requires an object/);
  assert.throws(() => parseImageToolInput({ kind: "light", name: "x" }), /requires prompt/);
  assert.throws(() => parseImageToolInput({ prompt: "x", kind: "sprite", name: "x" }), /kind must be one of light, matter, icon, decal, tile/);
  assert.throws(() => parseImageToolInput({ prompt: "x", kind: "light", name: "Glow Ring" }), /name must be a file stem/);
  assert.throws(() => parseImageToolInput({ prompt: "x", kind: "light", name: "g", size: "2048x2048" }), /size must be one of/);
  assert.throws(() => parseImageToolInput({ prompt: "x", kind: "light", name: "g", count: 9 }), /count must be a whole number from 1 to 4/);
  assert.throws(() => parseImageToolInput({ prompt: "x", kind: "light", name: "g", quality: "ultra" }), /quality must be one of/);
  assert.throws(() => parseImageToolInput({ prompt: "x", kind: "light", name: "g", reference: { output: "../etc/passwd" } }), /reference\.output must be jobId\/file\.png/);
  assert.throws(() => parseImageToolInput({ prompt: "x", kind: "light", name: "g", reference: { output: "0a1b2c3d/glow.png/extra" } }), /reference\.output must be/);
  assert.throws(() => parseImageToolInput({ prompt: "x", kind: "light", name: "g", preview_in_studio: "yes" }), /preview_in_studio must be true or false/);
  assert.throws(() => parseImageToolInput({ prompt: "x".repeat(2_001), kind: "light", name: "g" }), /at most 2000 characters/);
});

test("the image tool's description fits what Claude Code passes on, and says what the tool is for and is not", () => {
  const tool = imageToolDefinition();
  assert.ok(tool.description.length <= MAX_TOOL_DESCRIPTION_CHARS, `${tool.description.length} characters`);
  assert.match(tool.description, /Render anything that moves frame to frame \(a flipbook\)/);
  assert.match(tool.description, /irreversible/);
  assert.match(tool.description, /vfx-generated-textures\.md/);
  const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(tool.inputSchema.required, ["prompt", "kind", "name"]);
  assert.deepEqual(properties.kind.enum, ["light", "matter", "icon", "decal", "tile"]);
  assert.equal(properties.count.maximum, 4);
});
