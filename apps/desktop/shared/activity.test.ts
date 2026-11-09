import assert from "node:assert/strict";
import test from "node:test";

import {
  activityFinding, activityKind, activityLabel, activityTarget, classifiedTools,
  evidenceActivityKind, evidenceDetailLabel, evidenceLabel,
  shortTarget, unclassifiedTools, MAX_FINDING_CHARS,
} from "./activity";
import { GATEWAY_TOOL_RISK } from "./gateway-operations";
import { LOCAL_TOOL_RISK, TOOL_RISK, summarizeToolCall } from "./mcp-tools";

test("every tool the risk table knows about is classified", () => {
  assert.deepEqual(unclassifiedTools(), []);
});

test("the classification table has no tool the MCP surface dropped", () => {
  // Roqer's own operations are classified too, without being MCP tools.
  const known = new Set([...Object.keys(TOOL_RISK), ...Object.keys(LOCAL_TOOL_RISK), ...Object.keys(GATEWAY_TOOL_RISK)]);
  assert.deepEqual(classifiedTools().filter((tool) => !known.has(tool)), []);
});

test("capturing moments reads as what it does, not as its operation name", () => {
  assert.equal(activityLabel("capture_moments", null, false), "Capturing an effect at several moments");
  assert.equal(activityLabel("capture_moments", "client-1", true), "Captured an effect at several moments");
});

test("a batch upload reads as uploading, and its card names every file it sends", () => {
  assert.equal(activityLabel("upload_assets", null, false), "Uploading assets");
  assert.equal(activityLabel("upload_assets", "upload 2 files to Roblox: Flash, Smoke", true), "Uploaded assets");
  assert.equal(activityKind("upload_assets"), "edit");
  assert.equal(
    summarizeToolCall("upload_assets", { uploads: [{ filePath: "C:/jobs/flash.png", displayName: "Flash" }, { filePath: "C:\\jobs\\smoke.png" }] }),
    "upload_assets · upload 2 files to Roblox: Flash, smoke.png",
  );
});

test("a Blender job reads as modeling, not as its operation name", () => {
  assert.equal(activityLabel("run_blender_script", null, false), "Modeling in Blender");
  assert.equal(activityLabel("run_blender_script", null, true), "Modeled in Blender");
  assert.equal(activityKind("run_blender_script"), "run");
});

test("an image job reads as generating, is approved like a spend, and is summarised by what it is for", () => {
  assert.equal(activityLabel("generate_image", null, false), "Generating images");
  assert.equal(activityLabel("generate_image", null, true), "Generated images");
  assert.equal(activityKind("generate_image"), "run");
  assert.equal(LOCAL_TOOL_RISK.generate_image, "irreversible");
  assert.equal(summarizeToolCall("generate_image", { prompt: "a soft glow", kind: "light", name: "rune_ring", count: 3 }), "generate_image · light rune_ring ×3");
  assert.equal(summarizeToolCall("generate_image", { prompt: "a soft glow", kind: "icon", name: "sword", count: 1 }), "generate_image · icon sword");
  assert.equal(summarizeToolCall("generate_image", { prompt: "a soft glow" }), "generate_image");
});

test("a closer look at a reference clip reads as looking, not as its operation name", () => {
  assert.equal(activityLabel("read_reference_clip", null, false), "Looking closer at the reference clip");
  assert.equal(activityLabel("read_reference_clip", null, true), "Looked closer at the reference clip");
  assert.equal(activityKind("read_reference_clip"), "read");
});

test("a tool nobody has classified is assumed to make something happen", () => {
  // The same conservative direction riskForTool takes: an operation this table
  // has not caught up with must never read as a harmless lookup.
  assert.equal(activityKind("some_future_tool"), "run");
});

test("tools are grouped by what a reader would say they did", () => {
  assert.equal(activityKind("get_script_source"), "read");
  assert.equal(activityKind("search_objects"), "search");
  assert.equal(activityKind("set_script_source"), "edit");
  assert.equal(activityKind("solo_playtest"), "run");
  assert.equal(activityKind("upload_asset", "upload"), "edit");
  assert.equal(activityKind("upload_asset", "status"), "read");
});

test("the identifying argument is recovered from the call summary", () => {
  const summary = summarizeToolCall("get_script_source", { instancePath: "game.ServerScriptService.Main" });
  assert.equal(activityTarget("get_script_source", summary), "game.ServerScriptService.Main");
});

test("a call with no identifying argument has no target", () => {
  const summary = summarizeToolCall("get_place_info", {});
  assert.equal(summary, "get_place_info");
  assert.equal(activityTarget("get_place_info", summary), null);
});

test("a summary in some other shape is not mined for a target", () => {
  assert.equal(activityTarget("get_place_info", "something else entirely"), null);
});

test("a call with a target reads as a verb and that target", () => {
  // Every path in a place starts at `game`, so the prefix distinguishes nothing
  // and costs the width the rest of the path needs. The full path is still on
  // the step, and the row's details show it.
  assert.equal(
    activityLabel("get_script_source", "game.ServerScriptService.Main", true),
    "Read ServerScriptService.Main",
  );
  assert.equal(
    activityLabel("set_script_source", "game.ServerScriptService.Main", false),
    "Editing ServerScriptService.Main",
  );
  assert.equal(shortTarget("game.Workspace"), "Workspace");
  assert.equal(
    shortTarget("game.StarterPlayer.StarterPlayerScripts.AetherEngineClient"),
    "StarterPlayerScripts.AetherEngineClient",
    "a deep path keeps the end, which is what names the thing",
  );
  assert.equal(shortTarget("game"), "game", "a path with nothing after the prefix keeps it");
  assert.equal(shortTarget("Coffee Run"), "Coffee Run", "and a name that is not a path is left alone");
});

test("checking an upload operation reads as a lookup, not another upload", () => {
  assert.equal(activityLabel("upload_asset", "status", false), "Reading upload status");
  assert.equal(activityLabel("upload_asset", "status", true), "Read upload status");
  assert.equal(activityLabel("upload_asset", "upload", false), "Uploading an asset");
  assert.equal(activityLabel("upload_asset", null, true), "Edited an asset");
});

test("an animation reads as checking or building, whatever its summary says", () => {
  const animation = { name: "Run", rig: "R15", keyframes: [{ time: 0, joints: {} }] };
  const check = activityTarget("animation", summarizeToolCall("animation", { action: "check", animation }));
  const build = activityTarget("animation", summarizeToolCall("animation", { action: "build", animation, parent: "game.ServerStorage" }));
  assert.equal(activityLabel("animation", check, true), "Checked an animation");
  assert.equal(activityLabel("animation", build, false), "Building an animation");
  assert.equal(activityKind("animation", check), "read");
  assert.equal(activityKind("animation", build), "edit");
  const character = activityTarget("animation", summarizeToolCall("animation", { action: "verify", animation }));
  const model = activityTarget("animation", summarizeToolCall("animation", { action: "verify", model: "game.Workspace.Guard", position: [4, 0, 0] }));
  assert.equal(activityLabel("animation", character, true), "Verified an animation in the playtest");
  assert.equal(activityLabel("animation", model, false), "Verifying a model in the playtest");
  assert.equal(activityKind("animation", model), "run");
  const rig = activityTarget("animation", summarizeToolCall("animation", { action: "rig", model: "game.Workspace.Guard", stock: "R15" }));
  assert.equal(activityLabel("animation", rig, false), "Making an NPC");
  assert.equal(activityLabel("animation", rig, true), "Made an NPC");
  assert.equal(activityKind("animation", rig), "edit");
  // An action the tool refuses was no check: it reads as a call, and not as a read.
  for (const args of [{ action: "help" }, {}]) {
    const unknown = activityTarget("animation", summarizeToolCall("animation", args));
    assert.equal(activityLabel("animation", unknown, true), "Called the animation tool");
    assert.equal(activityLabel("animation", unknown, false), "Calling the animation tool");
    assert.equal(activityKind("animation", unknown), "edit");
  }
});

test("a finding is what a call learned, never the payload it learned it from", () => {
  assert.equal(activityFinding("get_project_structure", "get_project_structure: 16 instances"), "16 instances");
  assert.equal(activityFinding("get_place_info", "get_place_info succeeded"), null);
  assert.equal(activityFinding("get_place_info", undefined), null);
  assert.equal(
    activityFinding("get_place_info", "get_place_info: {\"placeId\":123}"),
    null,
    "compacted JSON belongs in the details, not on the row",
  );
  assert.equal(
    activityFinding("get_script_source", "get_script_source failed (not-found): No instance at game.X."),
    "No instance at game.X.",
    "a failure says what went wrong, without repeating the operation name",
  );
  const long = activityFinding("grep_scripts", `grep_scripts: ${"pattern matched everywhere ".repeat(5)}`);
  assert.ok(long && long.length <= MAX_FINDING_CHARS, "a row's finding stays a few words");
  assert.match(long ?? "", /…$/);
});

test("a call with no target never falls back to its operation name", () => {
  // The operation name is exactly the internal detail this layer exists to
  // keep out of sight, so every routine no-argument call has a phrase.
  for (const tool of ["get_place_info", "get_connected_instances", "get_project_structure"]) {
    const label = activityLabel(tool, null, true);
    assert.doesNotMatch(label, /_/, `${tool} leaked its operation name into "${label}"`);
  }
});

test("evidence reads as its own kind of activity", () => {
  assert.equal(evidenceActivityKind("verification"), "verify");
  assert.equal(evidenceActivityKind("playtest"), "run");
  assert.equal(
    evidenceLabel({ id: "e1", kind: "verification", title: "game.ServerScriptService.Main" }),
    "Verified ServerScriptService.Main",
  );
  assert.equal(evidenceDetailLabel("verification"), "Read-back");
});

test("no tool reads as its operation name, in either tense", () => {
  for (const tool of classifiedTools()) {
    assert.doesNotMatch(activityLabel(tool, null, true), /_/, `${tool} shows its name when finished`);
    assert.doesNotMatch(activityLabel(tool, null, false), /_/, `${tool} shows its name while running`);
  }
});

test("calls read as what they did, not as their kind's verb", () => {
  assert.equal(activityLabel("solo_playtest", "start", true), "Started a playtest");
  assert.equal(activityLabel("solo_playtest", "stop", false), "Stopping the playtest");
  assert.equal(activityLabel("eval_client_runtime", null, true), "Ran code on the client");
  assert.equal(activityLabel("insert_asset", null, true), "Inserted an asset");
  assert.equal(activityLabel("get_runtime_logs", "client-1", true), "Read output from client-1");
  assert.equal(activityLabel("selection", "get", true), "Read your selection");
  assert.equal(activityLabel("selection", "game.Workspace.Tower", true), "Framed Workspace.Tower in Studio");
});

test("a failure reads by its reason, without the plugin's path, and a count reads properly", () => {
  assert.equal(
    activityFinding("selection", "focus failed: user_MCPPlugin.rbxmx.MCPPlugin.modules.handlers.MetadataHandlers:300: Cannot frame a Folder: it has no 3D bounding box."),
    "Cannot frame a Folder: it has no 3D bounding box.",
  );
  assert.equal(activityFinding("capture_moments", "capture_moments failed (error): Tool call failed."), "Tool call failed.");
  assert.equal(activityFinding("grep_scripts", "grep_scripts: 1 results"), "1 result");
  assert.equal(activityFinding("get_runtime_logs", "get_runtime_logs: 1 entries"), "1 entry");
  assert.equal(activityFinding("search_assets", "search_assets: 0 results"), "0 results");
});

test("a search scoped to an instance says where it looked, not that it searched for a path", () => {
  assert.equal(activityLabel("grep_scripts", "game.ReplicatedStorage.VFX", true), "Searched ReplicatedStorage.VFX");
  assert.equal(activityLabel("search_assets", "magic chime", true), "Searched for “magic chime”");
});
