import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_RISK,
  riskForTool,
  isKnownTool,
  summarizeToolCall,
  timeoutForTool,
  truncate,
} from "./mcp-tools";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read the MCP tool definitions from the core package and extract tool names
 * and categories. This test ensures TOOL_RISK stays in sync with the server's
 * actual tool surface.
 */
function extractToolsFromDefinitions(): Map<string, "read" | "write"> {
  const definitionsPath = join(__dirname, "../../../packages/core/src/tools/definitions.ts");
  const content = readFileSync(definitionsPath, "utf-8");

  const tools = new Map<string, "read" | "write">();
  // Match: name: 'tool_name', followed by category: 'read'|'write'
  // Pattern handles both Unix (\n) and Windows (\r\n) line endings
  const regex = /name:\s*'([a-z0-9_]+)',\s*(?:\r?\n)\s*category:\s*'(read|write)'/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    tools.set(match[1], match[2] as "read" | "write");
  }
  return tools;
}

test("mcp-tools - extract tools from definitions", () => {
  const tools = extractToolsFromDefinitions();
  assert.ok(
    tools.size >= 40,
    `Expected at least 40 tools, found ${tools.size}. Regex may have broken.`,
  );
});

test("mcp-tools - TOOL_RISK coverage: all tools in definitions exist in TOOL_RISK", () => {
  const serverTools = extractToolsFromDefinitions();
  // Uses the same own-property check production uses, so a tool whose name
  // collides with an Object.prototype key cannot pass coverage vacuously.
  const missingTools = Array.from(serverTools.keys()).filter((tool) => !isKnownTool(tool));

  assert.strictEqual(
    missingTools.length,
    0,
    `Tools in definitions.ts but missing from TOOL_RISK: ${missingTools.join(", ")}`,
  );
});

test("mcp-tools - TOOL_RISK staleness: no extra tools in TOOL_RISK", () => {
  const serverTools = extractToolsFromDefinitions();
  const staleTools = Object.keys(TOOL_RISK).filter((tool) => !serverTools.has(tool));

  assert.strictEqual(
    staleTools.length,
    0,
    `Tools in TOOL_RISK but no longer in definitions.ts: ${staleTools.join(", ")}`,
  );
});

test("mcp-tools - never downgrade write tools: server write tools must not be classified as read", () => {
  const serverTools = extractToolsFromDefinitions();
  const downgradedTools: string[] = [];

  for (const [toolName, category] of serverTools) {
    if (category === "write" && TOOL_RISK[toolName] === "read") {
      downgradedTools.push(toolName);
    }
  }

  assert.strictEqual(
    downgradedTools.length,
    0,
    `Server write tools incorrectly classified as read in TOOL_RISK: ${downgradedTools.join(", ")}`,
  );
});

test("mcp-tools - riskForTool returns table value for known tool", () => {
  const risk = riskForTool("set_properties");
  assert.strictEqual(risk, "mutation");
});

test("mcp-tools - checking upload status is read-only but uploading remains irreversible", () => {
  assert.strictEqual(riskForTool("upload_asset", { action: "status", operationId: "upload-123" }), "read");
  assert.strictEqual(riskForTool("upload_asset", { action: "upload" }), "irreversible");
  assert.strictEqual(riskForTool("upload_asset"), "irreversible");
});

test("mcp-tools - a profiler capture is a read until it names a file on the user's disk", () => {
  assert.strictEqual(riskForTool("capture_script_profiler", { max_functions: 20 }), "read");
  assert.strictEqual(riskForTool("capture_script_profiler", { output_path: "C:/Users/creator/raw.json" }), "mutation");
  assert.strictEqual(riskForTool("capture_micro_profiler", { frame_window: 240 }), "read");
  for (const name of ["output_path", "summary_output_path", "baseline_path"]) {
    assert.strictEqual(riskForTool("capture_micro_profiler", { [name]: "C:/Users/creator/profile.json" }), "mutation", name);
  }
  // An inline baseline is not a file.
  assert.strictEqual(riskForTool("capture_micro_profiler", { baseline: { frames: 240 } }), "read");
});

test("mcp-tools - upload timeout covers the server's initial Roblox poll", () => {
  assert.strictEqual(timeoutForTool("upload_asset"), 75_000);
});

test("mcp-tools - riskForTool returns irreversible for unknown tool (fail-closed default)", () => {
  const risk = riskForTool("nonexistent_tool_12345");
  assert.strictEqual(
    risk,
    "irreversible",
    "Unknown tools must default to irreversible for safety",
  );
});

test("mcp-tools - isKnownTool returns true for real tool", () => {
  assert.strictEqual(isKnownTool("get_place_info"), true);
});

test("mcp-tools - isKnownTool returns false for unknown tool", () => {
  assert.strictEqual(isKnownTool("fake_tool_xyz"), false);
});

test("mcp-tools - isKnownTool not fooled by inherited object properties", () => {
  assert.strictEqual(isKnownTool("constructor"), false);
  assert.strictEqual(isKnownTool("toString"), false);
});

test("mcp-tools - riskForTool not fooled by inherited object properties", () => {
  const riskConstructor = riskForTool("constructor");
  assert.strictEqual(
    riskConstructor,
    "irreversible",
    "inherited property 'constructor' should not be in TOOL_RISK",
  );
  const riskToString = riskForTool("toString");
  assert.strictEqual(
    riskToString,
    "irreversible",
    "inherited property 'toString' should not be in TOOL_RISK",
  );
});

test("mcp-tools - summarizeToolCall includes tool name", () => {
  const summary = summarizeToolCall("set_properties", { some: "arg" });
  assert.ok(
    summary.includes("set_properties"),
    "Summary must include the tool name",
  );
});

test("mcp-tools - summarizeToolCall prefers instancePath over other identifying arguments", () => {
  const summary = summarizeToolCall("set_properties", {
    instancePath: "Workspace.Part",
    query: "other_value",
    name: "another_value",
  });
  assert.ok(
    summary.includes("Workspace.Part"),
    "Summary should prefer instancePath",
  );
  assert.ok(
    !summary.includes("other_value") && !summary.includes("another_value"),
    "Summary should not include other arguments when instancePath is present",
  );
});

test("mcp-tools - summarizeToolCall uses first non-empty identifying argument in order", () => {
  const summary = summarizeToolCall("search_objects", {
    query: "Part",
  });
  assert.ok(
    summary.includes("Part"),
    "Summary should include query value",
  );
});

test("mcp-tools - summarizeToolCall falls back to bare tool name when no identifying argument present", () => {
  const summary = summarizeToolCall("get_place_info", { instance_id: "", other: 123 });
  assert.strictEqual(
    summary,
    "get_place_info",
    "Should fall back to bare tool name",
  );
});

test("mcp-tools - summarizeToolCall truncates very long values", () => {
  const longPath = "A".repeat(200);
  const summary = summarizeToolCall("set_properties", { instancePath: longPath });
  assert.ok(
    summary.length < longPath.length,
    "Summary must truncate long values",
  );
  assert.ok(
    summary.endsWith("…"),
    "Truncated summary must end with … character",
  );
});

test("mcp-tools - timeoutForTool covers the plugin bridge timeout by default", () => {
  // The bridge gives a plugin request 30s. Anything shorter here abandons the
  // call before the server can report what Studio actually said.
  assert.ok(DEFAULT_TOOL_TIMEOUT_MS > 30_000);
  assert.strictEqual(timeoutForTool("get_place_info"), DEFAULT_TOOL_TIMEOUT_MS);
  assert.strictEqual(timeoutForTool("nonexistent_tool_12345"), DEFAULT_TOOL_TIMEOUT_MS);
});

test("mcp-tools - timeoutForTool gives a screenshot both of its bridge round trips", () => {
  // A play-mode capture is capture-begin on the client plus capture-read on
  // edit, so one bridge timeout is not enough on its own.
  assert.ok(timeoutForTool("capture_screenshot") > 60_000);
  assert.ok(timeoutForTool("capture_screenshot") > DEFAULT_TOOL_TIMEOUT_MS);
});

test("mcp-tools - timeoutForTool outlasts the wait a playtest performs server-side", () => {
  // solo_playtest action=start waits up to 60s for the runtime peers.
  assert.ok(timeoutForTool("solo_playtest", { action: "start", mode: "play" }) > 60_000);
});

test("mcp-tools - timeoutForTool honours a caller-supplied wait, in either spelling", () => {
  const seconds = timeoutForTool("solo_playtest", { action: "start", timeout: 200 });
  assert.ok(seconds > 200_000, "a 200s wait must not be cut off at the table default");
  const milliseconds = timeoutForTool("generate_model", { timeout_ms: 240_000 });
  assert.ok(milliseconds > 240_000);
});

test("mcp-tools - timeoutForTool never shortens a budget below the table value", () => {
  const base = timeoutForTool("solo_playtest");
  assert.strictEqual(timeoutForTool("solo_playtest", { timeout: 1 }), base);
});

test("mcp-tools - timeoutForTool ignores a nonsensical caller wait and stays capped", () => {
  const base = timeoutForTool("generate_model");
  assert.strictEqual(timeoutForTool("generate_model", { timeout_ms: -5 }), base);
  assert.strictEqual(timeoutForTool("generate_model", { timeout_ms: "soon" }), base);
  assert.strictEqual(timeoutForTool("generate_model", { timeout_ms: Number.POSITIVE_INFINITY }), base);
  assert.ok(timeoutForTool("generate_model", { timeout_ms: 9_000_000 }) <= 315_000);
});

test("mcp-tools - truncate respects limit and ends with …", () => {
  const result = truncate("a".repeat(100), 50);
  assert.strictEqual(result.length, 50);
  assert.ok(result.endsWith("…"));
});

test("mcp-tools - truncate returns unchanged value when within limit", () => {
  const short = "hello";
  const result = truncate(short, 50);
  assert.strictEqual(result, short);
});
