import assert from "node:assert/strict";
import test from "node:test";
import {
  looksLikeArgumentError,
  requiredArgumentProblems,
  toolSchema,
  toolSchemaHint,
  toolSignature,
} from "./mcp-tool-help";

test("mcp-tool-help - a signature names required and optional arguments apart", () => {
  const signature = toolSignature("solo_playtest");

  assert.strictEqual(
    signature,
    "solo_playtest {action: 'start'|'stop'|'status', mode?: 'play'|'run', timeout?: number}",
  );
});

/**
 * The run engine addresses every Studio call at the instance the run started
 * against, so documenting `instance_id` would only invite a model to transcribe
 * an opaque id it cannot check. `manage_instance` keeps it: picking between
 * Studio processes is what that operation does.
 */
test("mcp-tool-help - the instance a run targets is not the model's to pass", () => {
  assert.ok(!(toolSignature("get_project_structure") ?? "").includes("instance_id"));
  assert.ok(!(toolSchemaHint("get_project_structure") ?? "").includes("instance_id"));
  assert.ok((toolSignature("manage_instance") ?? "").includes("instance_id"));
});

test("mcp-tool-help - a signature is undefined for an unknown operation", () => {
  assert.strictEqual(toolSignature("no_such_operation"), undefined);
});

test("mcp-tool-help - schema lookup is not fooled by inherited object properties", () => {
  assert.strictEqual(toolSchema("constructor"), undefined);
  assert.strictEqual(toolSchema("toString"), undefined);
  assert.deepStrictEqual(requiredArgumentProblems("constructor", {}), []);
});

test("mcp-tool-help - a hint carries the conditional requirement the schema cannot", () => {
  const hint = toolSchemaHint("solo_playtest");

  assert.ok(hint);
  assert.ok(hint.startsWith("Schema for solo_playtest {action: 'start'|'stop'|'status'"));
  assert.ok(hint.includes("- action (required, 'start'|'stop'|'status') Lifecycle action to run."));
  // The failure this whole path exists for: mode is required only for a start,
  // which lives in the description rather than in `required`.
  assert.ok(hint.includes('- mode (optional, \'play\'|\'run\') Required for action="start".'));
});

test("mcp-tool-help - upload branches name and enforce their own required arguments", () => {
  const signature = toolSignature("upload_asset");
  const hint = toolSchemaHint("upload_asset");

  assert.ok(signature?.includes("action='upload' requires filePath, assetType, displayName"));
  assert.ok(signature?.includes("action='status' requires operationId"));
  assert.ok(hint?.includes("- when action='upload' requires filePath, assetType, displayName"));
  assert.deepStrictEqual(
    requiredArgumentProblems("upload_asset", {
      action: "upload",
      path: "C:/Users/creator/Downloads/head.png",
      type: "Decal",
      name: "funny head",
    }),
    [
      { name: "filePath", reason: "missing" },
      { name: "assetType", reason: "missing" },
      { name: "displayName", reason: "missing" },
    ],
  );
  assert.deepStrictEqual(requiredArgumentProblems("upload_asset", {
    filePath: "C:/tmp/asset.png", assetType: "Decal", displayName: "asset",
  }), []);
  assert.deepStrictEqual(requiredArgumentProblems("upload_asset", { action: "status" }), [
    { name: "operationId", reason: "missing" },
  ]);
  assert.deepStrictEqual(requiredArgumentProblems("upload_asset", {
    action: "status", operationId: "upload-123",
  }), []);
});

test("mcp-tool-help - a hint reports an operation that takes no arguments", () => {
  const hint = toolSchemaHint("get_connected_instances");

  assert.ok(hint);
  assert.ok(hint.includes("- takes no arguments"));
});

test("mcp-tool-help - missing required arguments are reported in declaration order", () => {
  assert.deepStrictEqual(requiredArgumentProblems("solo_playtest", {}), [
    { name: "action", reason: "missing" },
  ]);
  assert.deepStrictEqual(requiredArgumentProblems("solo_playtest", { action: "start" }), []);
  assert.deepStrictEqual(
    requiredArgumentProblems("edit_script_lines", { instancePath: "game.Workspace.Script" }),
    [{ name: "old_string", reason: "missing" }, { name: "new_string", reason: "missing" }],
  );
});

test("mcp-tool-help - an empty value is rejected only where the server declares a minimum length", () => {
  // grep_scripts declares minLength on its pattern, and the server rejects an
  // empty one, so the call is answered here instead of over the bridge.
  assert.deepStrictEqual(requiredArgumentProblems("grep_scripts", { pattern: "" }), [
    { name: "pattern", reason: "empty" },
  ]);
  assert.deepStrictEqual(requiredArgumentProblems("grep_scripts", { pattern: "task.wait" }), []);
  // An empty source clears a script and an empty new_string deletes text, so
  // neither may be refused on emptiness alone.
  assert.deepStrictEqual(
    requiredArgumentProblems("set_script_source", {
      instancePath: "game.Workspace.Script", source: "", expectedRevision: "sr1",
    }),
    [],
  );
  assert.deepStrictEqual(
    requiredArgumentProblems("edit_script_lines", {
      instancePath: "game.Workspace.Script", old_string: "dead code", new_string: "",
    }),
    [],
  );
});

test("mcp-tool-help - a required argument set to null is missing rather than empty", () => {
  assert.deepStrictEqual(requiredArgumentProblems("get_script_source", { instancePath: null }), [
    { name: "instancePath", reason: "missing" },
  ]);
});

test("mcp-tool-help - an unknown operation is never rejected locally", () => {
  assert.deepStrictEqual(requiredArgumentProblems("operation_from_a_newer_server", {}), []);
});

test("mcp-tool-help - argument failures are told apart from everything else", () => {
  assert.ok(looksLikeArgumentError("solo_playtest requires action=start|stop|status"));
  assert.ok(looksLikeArgumentError("solo_playtest action=start requires mode=play|run"));
  assert.ok(looksLikeArgumentError("Invalid instancePath"));
  assert.ok(!looksLikeArgumentError("Roblox Studio is not connected"));
  assert.ok(!looksLikeArgumentError("The script source revision changed since it was read"));
});
