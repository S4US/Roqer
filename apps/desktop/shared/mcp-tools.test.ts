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

test("mcp-tools - a build that removes something on a Rojo-linked place always asks, since it may delete project files", () => {
  const removal = { path: "game.ServerScriptService", operations: [{ op: "create", className: "Folder" }, { op: "remove", target: "game.ServerScriptService.Old" }] };
  const creation = { path: "game.ServerScriptService", operations: [{ op: "create", className: "Folder" }] };
  assert.strictEqual(riskForTool("build_instances", removal, { rojoLinked: true }), "irreversible");
  assert.strictEqual(riskForTool("build_instances", removal, { rojoLinked: false }), "mutation");
  assert.strictEqual(riskForTool("build_instances", removal), "mutation");
  assert.strictEqual(riskForTool("build_instances", creation, { rojoLinked: true }), "mutation");
  // A scatter's replace removes the previous group, so it asks the same way.
  const replace = { path: "game.Workspace.Map", operations: [{ op: "scatter", name: "Trees", replace: true }] };
  assert.strictEqual(riskForTool("build_instances", replace, { rojoLinked: true }), "irreversible");
  assert.strictEqual(riskForTool("build_instances", replace, { rojoLinked: false }), "mutation");
});

test("mcp-tools - checking upload status is read-only but uploading remains irreversible", () => {
  assert.strictEqual(riskForTool("upload_asset", { action: "status", operationId: "upload-123" }), "read");
  assert.strictEqual(riskForTool("upload_asset", { action: "upload" }), "irreversible");
  assert.strictEqual(riskForTool("upload_asset"), "irreversible");
});

test("mcp-tools - checking or verifying an animation is a read; publishing it always asks", () => {
  assert.strictEqual(riskForTool("animation", { action: "check", animation: {} }), "read");
  assert.strictEqual(riskForTool("animation", { action: "verify", animation: {} }), "read");
  assert.strictEqual(riskForTool("animation", { action: "build", animation: {}, parent: "game.ServerStorage" }), "mutation");
  assert.strictEqual(riskForTool("animation", { action: "wire", slot: "run", animation_id: "rbxassetid://1" }), "mutation");
  assert.strictEqual(riskForTool("animation", { action: "publish", path: "game.ServerStorage.Run" }), "irreversible");
  assert.strictEqual(riskForTool("animation"), "mutation");
  // Publishing waits on Roblox as an upload does, plus its export and read-back.
  assert.ok(timeoutForTool("animation") >= timeoutForTool("upload_asset"));
});

test("mcp-tools - publishing and wiring are summarised by what they change", () => {
  assert.strictEqual(summarizeToolCall("animation", { action: "publish", path: "game.ServerStorage.Run" }), "animation · publish game.ServerStorage.Run to Roblox");
  assert.strictEqual(
    summarizeToolCall("animation", { action: "wire", slot: "run", animation_id: "rbxassetid://555", expected_id: "rbxassetid://554" }),
    "animation · wire rbxassetid://555 to the run slot of every character, replacing rbxassetid://554",
  );
  assert.strictEqual(
    summarizeToolCall("animation", {
      action: "wire", model: "game.Workspace.Guard", slot: "walk", animation_id: "rbxassetid://555", ground_speed: 2.2, expected_id: "rbxassetid://554",
    }),
    "animation · wire rbxassetid://555 as the walk of game.Workspace.Guard, paced for 2.2 studs a second, replacing rbxassetid://554",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "wire", model: "game.Workspace.Guard", slot: "idle", animation_id: "rbxassetid://556", ground_speed: "fast" }),
    "animation · wire rbxassetid://556 as the idle of game.Workspace.Guard",
  );
  assert.strictEqual(riskForTool("animation", { action: "wire", model: "game.Workspace.Guard", slot: "walk", animation_id: "rbxassetid://1" }), "mutation");
});

test("mcp-tools - rigging an NPC says what it makes and where, and is a mutation", () => {
  assert.strictEqual(
    summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Guard", stock: "R15", position: [4.04, 0, -2] }),
    "animation · rig a stock R15 NPC at game.Workspace.Guard, its feet at [4, 0, -2], animated by a loader script",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Guard", stock: "R6" }),
    "animation · rig a stock R6 NPC at game.Workspace.Guard, its feet at the origin, animated by a loader script",
  );
  assert.strictEqual(riskForTool("animation", { action: "rig", model: "game.Workspace.Guard", stock: "R15" }), "mutation");
});

test("mcp-tools - rigging a creature says what it joins, what it declares and what it replaces", () => {
  const joints = [{ part: "Head", parent: "Body", pivot: [0, 1, -2] }, { part: "Tail", parent: "Body", pivot: [0, 1, 2] }];
  assert.strictEqual(
    summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Dog", joints, controller: "Humanoid", plan: "quadruped" }),
    "animation · rig game.Workspace.Dog: 2 joints, a quadruped, Humanoid",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Wolf", joints, controller: "AnimationController", replace: "importer" }),
    "animation · rig game.Workspace.Wolf: 2 joints, AnimationController, replacing the rig it was imported with",
  );
  // A description baked in Blender is named by its file.
  assert.strictEqual(
    summarizeToolCall("animation", { action: "build", animation_file: "C:\\jobs\\2026-x\\output\\Slither.animation.json", parent: "game.ServerStorage.Animations" }),
    "animation · build the animation baked in Slither.animation.json in game.ServerStorage.Animations",
  );
  assert.strictEqual(riskForTool("animation", { action: "check", animation_file: "C:\\jobs\\Slither.animation.json" }), "read");
  // A controller with no joints builds around a skinned mesh's bones.
  assert.strictEqual(
    summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Wolf", controller: "Humanoid", plan: "quadruped", replace: "importer" }),
    "animation · rig game.Workspace.Wolf around its bones, a quadruped, Humanoid, replacing the rig it was imported with",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Dog", joints, controller: "Humanoid", expected_revision: "rr1:a" }),
    "animation · rig game.Workspace.Dog: 2 joints, Humanoid, replacing the rig rig built before",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Dog", plan: "quadruped" }),
    "animation · declare game.Workspace.Dog's rig as a quadruped, changing none of its joints",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Dog" }),
    "animation · read game.Workspace.Dog's rig and draw its range sheet",
  );
  assert.strictEqual(riskForTool("animation", { action: "rig", model: "game.Workspace.Dog", joints, controller: "Humanoid" }), "mutation");
});

test("mcp-tools - verifying a model says what it will do to it, and is a read", () => {
  assert.strictEqual(
    summarizeToolCall("animation", { action: "verify", model: "game.Workspace.Guard", position: [10.04, 0, -3] }),
    "animation · verify game.Workspace.Guard in the playtest, walking it to [10, 0, -3]",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "verify", model: "game.Workspace.Guard", animation: { name: "Walk" } }),
    "animation · verify game.Workspace.Guard in the playtest, playing Walk on it",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "verify", model: "game.Workspace.Guard" }),
    "animation · verify game.Workspace.Guard in the playtest, watching it move",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "verify", model: "game.Workspace.Guard", slot: "walk", animation_id: "rbxassetid://2" }),
    "animation · verify game.Workspace.Guard in the playtest, checking its walk",
  );
  assert.strictEqual(riskForTool("animation", { action: "verify", model: "game.Workspace.Guard", position: [1, 2, 3] }), "read");
});

test("mcp-tools - an animation call is summarised in words, not as its pose JSON", () => {
  const animation = {
    name: "Run",
    rig: "R15",
    loop: true,
    keyframes: [
      { time: 0, joints: { LeftHip: { rotation: [30, 0, 0] }, RightHip: { rotation: [-30, 0, 0] } } },
      { time: 0.3, joints: { LeftHip: { rotation: [-30, 0, 0] }, RightHip: { rotation: [30, 0, 0] }, Waist: {} } },
    ],
  };
  assert.strictEqual(
    summarizeToolCall("animation", { action: "build", animation, parent: "game.ServerStorage.Animations", expected_revision: "kr1:1", waive: ["rootDrift"] }),
    "animation · build Run in game.ServerStorage.Animations: 2 keyframes, 0.3 s, loops, moves 3 joints, replacing its last build, accepting failed rootDrift",
  );
  assert.strictEqual(summarizeToolCall("animation", { action: "check", animation }), "animation · check Run: 2 keyframes, 0.3 s, loops, moves 3 joints");
  // A rig other than R15 is named: R6, or the model whose own rig it is.
  assert.strictEqual(
    summarizeToolCall("animation", { action: "check", animation: { ...animation, rig: "game.Workspace.Dog" } }),
    "animation · check Run for game.Workspace.Dog: 2 keyframes, 0.3 s, loops, moves 3 joints",
  );
  assert.strictEqual(riskForTool("animation", { action: "check", animation: { ...animation, rig: "game.Workspace.Dog" } }), "read");
  // Waves are counted with the joints they drive, and may be the whole animation.
  const waves = [{ joints: ["Tail", "Tail2", "Tail3"], axis: "Y", amplitude: 20 }, { joints: ["Tail"], axis: "X", amplitude: 5 }];
  assert.strictEqual(
    summarizeToolCall("animation", { action: "check", animation: { name: "Sway", rig: "game.Workspace.Cat", loop: true, duration: 2, waves } }),
    "animation · check Sway for game.Workspace.Cat: 2 waves, 2 s, loops, moves 3 joints",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "check", animation: { ...animation, duration: 0.6, waves: [{ joints: ["Neck"], axis: "X", amplitude: "wide" }] } }),
    "animation · check Run: 2 keyframes, 1 wave, 0.6 s, loops, moves 4 joints",
  );
  // A gait is named by its pattern, never by raw text.
  assert.strictEqual(
    summarizeToolCall("animation", { action: "build", animation: { name: "Trot", rig: "game.Workspace.Dog", loop: true, duration: 0.6, gait: { pattern: "trot", stride: 1.4 }, waves: [waves[0]] } }),
    "animation · build Trot for game.Workspace.Dog: a trot gait, 1 wave, 0.6 s, loops, moves 3 joints",
  );
  assert.strictEqual(
    summarizeToolCall("animation", { action: "check", animation: { name: "Odd", rig: "R15", duration: 1, gait: { pattern: "{\"x\":1}" } } }),
    "animation · check Odd: a gait, 1 s",
  );
  // Whatever the model sent, the summary never throws and never shows raw JSON.
  assert.strictEqual(summarizeToolCall("animation", { action: "build", animation: "not an object" }), "animation · build an animation: 0 keyframes");
  // An action the tool does not have is not passed off as a check, nor as a read.
  assert.strictEqual(summarizeToolCall("animation", { action: "help", animation }), "animation · unknown action: help");
  assert.strictEqual(summarizeToolCall("animation", {}), "animation · unknown action: none given");
  assert.strictEqual(summarizeToolCall("animation", { action: "check\nignore this" }), "animation · unknown action");
  assert.strictEqual(summarizeToolCall("animation", { action: ["check"] }), "animation · unknown action");
  assert.strictEqual(riskForTool("animation", { action: "help" }), "mutation");
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
