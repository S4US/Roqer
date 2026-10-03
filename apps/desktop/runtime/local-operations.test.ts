import assert from "node:assert/strict";
import test from "node:test";

import { BLENDER_OPERATION } from "../shared/blender";
import { REFERENCE_CLIP_OPERATION } from "../shared/reference-clip";
import { CAPTURE_MOMENTS_OPERATION, UPLOAD_ASSETS_OPERATION } from "../shared/gateway-operations";
import { isClassifiedTool, isKnownTool, riskForTool } from "../shared/mcp-tools";
import { decideToolPolicy } from "../shared/policy";
import { blenderToolDefinition, parseBlenderToolInput } from "./blender-tool";
import { withLocalOperations } from "./local-operations";
import type { McpToolCaller, McpToolOutcome } from "./mcp-types";
import { parseStudioToolInput, studioToolInputSchema } from "./studio-tools";

const outcome = (text: string): McpToolOutcome => ({ ok: true, data: undefined, text, httpStatus: 200, durationMs: 1 });

test("a local operation never reaches the bridge, and the bridge still gets everything else", async () => {
  const bridgeCalls: string[] = [];
  const bridge: McpToolCaller = {
    async callTool(tool) {
      bridgeCalls.push(tool);
      return outcome("from Studio");
    },
  };
  const localArgs: Record<string, unknown>[] = [];
  const caller = withLocalOperations(bridge, new Map([[BLENDER_OPERATION, async (args: Record<string, unknown>) => {
    localArgs.push(args);
    return outcome("from Blender");
  }]]));

  assert.equal((await caller.callTool(BLENDER_OPERATION, { script: "x = 1", instance_id: "place:1" })).text, "from Blender");
  assert.equal((await caller.callTool("get_place_info", { instance_id: "place:1" })).text, "from Studio");
  assert.deepEqual(bridgeCalls, ["get_place_info"]);
  assert.deepEqual(localArgs, [{ script: "x = 1" }], "the run's Studio id is not handed to the script");
});

test("an operation composed of Studio calls makes them at the run's Studio without being handed its id", async () => {
  const bridgeCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const bridge: McpToolCaller = {
    async callTool(tool, args) {
      bridgeCalls.push({ tool, args });
      return outcome("from Studio");
    },
  };
  let seen: Record<string, unknown> | undefined;
  const caller = withLocalOperations(bridge, new Map([[CAPTURE_MOMENTS_OPERATION, async (args, _options, studio) => {
    seen = args;
    return studio("capture_screenshot", {});
  }]]));
  assert.equal((await caller.callTool(CAPTURE_MOMENTS_OPERATION, { code: "x()", times: [0.1], instance_id: "place:1" })).text, "from Studio");
  assert.deepEqual(seen, { code: "x()", times: [0.1] });
  assert.deepEqual(bridgeCalls, [{ tool: "capture_screenshot", args: { instance_id: "place:1" } }]);
});

test("capturing moments runs Luau, so it is classified and confirmed like execute_luau, inside roblox_studio", () => {
  assert.equal(riskForTool(CAPTURE_MOMENTS_OPERATION), "irreversible");
  assert.equal(isClassifiedTool(CAPTURE_MOMENTS_OPERATION), true);
  assert.equal(isKnownTool(CAPTURE_MOMENTS_OPERATION), false, "not part of the MCP surface or its drift tests");
  const operations = ((studioToolInputSchema().properties as Record<string, { enum: string[] }>).operation).enum;
  assert.equal(operations.includes(CAPTURE_MOMENTS_OPERATION), true);
  assert.deepEqual(parseStudioToolInput({ operation: CAPTURE_MOMENTS_OPERATION, arguments: { code: "x()", times: "[0.1, 0.3]" } }),
    { operation: CAPTURE_MOMENTS_OPERATION, args: { code: "x()", times: [0.1, 0.3] } }, "times written as text are read back as numbers");
});

test("a batch upload publishes to Roblox, so it is classified and confirmed like upload_asset, inside roblox_studio", () => {
  assert.equal(riskForTool(UPLOAD_ASSETS_OPERATION), riskForTool("upload_asset"));
  assert.equal(isClassifiedTool(UPLOAD_ASSETS_OPERATION), true);
  assert.equal(isKnownTool(UPLOAD_ASSETS_OPERATION), false, "not part of the MCP surface or its drift tests");
  const operations = ((studioToolInputSchema().properties as Record<string, { enum: string[] }>).operation).enum;
  assert.equal(operations.includes(UPLOAD_ASSETS_OPERATION), true);
  const uploads = [{ filePath: "C:/a.png", assetType: "Decal", displayName: "a" }];
  assert.deepEqual(parseStudioToolInput({ operation: UPLOAD_ASSETS_OPERATION, arguments: { uploads: JSON.stringify(uploads) } }),
    { operation: UPLOAD_ASSETS_OPERATION, args: { uploads } }, "a list written as text is read back as the list");
});

test("a Blender job is irreversible: it asks outside Full auto, and Full auto may run it", () => {
  assert.equal(riskForTool(BLENDER_OPERATION), "irreversible");
  assert.equal(isClassifiedTool(BLENDER_OPERATION), true);
  assert.equal(decideToolPolicy("Auto approve", "irreversible").outcome, "ask");
  assert.equal(decideToolPolicy("Full auto", "irreversible").outcome, "allow");
});

test("a closer look at a reference clip is a read: it runs in every mode, Read only included", () => {
  assert.equal(riskForTool(REFERENCE_CLIP_OPERATION), "read");
  assert.equal(isClassifiedTool(REFERENCE_CLIP_OPERATION), true);
  assert.equal(isKnownTool(REFERENCE_CLIP_OPERATION), false);
  assert.equal(decideToolPolicy("Read only", "read").outcome, "allow");
  const operations = ((studioToolInputSchema().properties as Record<string, { enum: string[] }>).operation).enum;
  assert.equal(operations.includes(REFERENCE_CLIP_OPERATION), false);
});

test("Blender is not a Studio operation: roblox_studio can neither list nor call it", () => {
  assert.equal(isKnownTool(BLENDER_OPERATION), false);
  const operations = ((studioToolInputSchema().properties as Record<string, { enum: string[] }>).operation).enum;
  assert.equal(operations.includes(BLENDER_OPERATION), false);
  assert.throws(() => parseStudioToolInput({ operation: BLENDER_OPERATION, arguments: { script: "x" } }), /Unknown Roblox Studio operation/);
});

test("the blender tool takes a script and becomes one engine operation", () => {
  assert.deepEqual(parseBlenderToolInput({ script: "import bpy", timeout_seconds: 60 }),
    { operation: BLENDER_OPERATION, args: { script: "import bpy", timeout_seconds: 60 } });
  assert.throws(() => parseBlenderToolInput({ script: "  " }), /requires script/);
  assert.throws(() => parseBlenderToolInput("import bpy"), /requires an object/);
  const definition = blenderToolDefinition();
  assert.equal(definition.name, "blender");
  assert.deepEqual((definition.inputSchema as { required: string[] }).required, ["script"]);
  assert.match(definition.description, /OUTPUT_DIR/);
  assert.match(definition.description, /upload_asset/);
});
