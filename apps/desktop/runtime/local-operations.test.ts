import assert from "node:assert/strict";
import test from "node:test";

import { BLENDER_OPERATION } from "../shared/blender";
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

test("a Blender job is irreversible: it asks outside Full auto, and Full auto may run it", () => {
  assert.equal(riskForTool(BLENDER_OPERATION), "irreversible");
  assert.equal(isClassifiedTool(BLENDER_OPERATION), true);
  assert.equal(decideToolPolicy("Auto approve", "irreversible").outcome, "ask");
  assert.equal(decideToolPolicy("Full auto", "irreversible").outcome, "allow");
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
