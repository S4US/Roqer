import assert from "node:assert/strict";
import test from "node:test";

import {
  activityFinding, activityKind, activityLabel, activityPhase, activityTarget, classifiedTools,
  evidenceActivityKind, evidenceDetailLabel, evidenceLabel, evidencePhase, phaseTitle,
  shortTarget, unclassifiedTools, MAX_FINDING_CHARS, type ActivityPhase,
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

test("capturing moments reads as checking the result, not as its operation name", () => {
  assert.equal(activityLabel("capture_moments", null, false), "Capturing an effect at several moments");
  assert.equal(activityLabel("capture_moments", "client-1", true), "Captured an effect at several moments");
  assert.equal(activityPhase("capture_moments"), "verify");
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
  assert.equal(shortTarget("game"), "game", "a path with nothing after the prefix keeps it");
  assert.equal(shortTarget("Coffee Run"), "Coffee Run", "and a name that is not a path is left alone");
});

test("steps are grouped by the stage of the run they belong to", () => {
  assert.equal(activityPhase("get_connected_instances"), "connect");
  assert.equal(activityPhase("get_project_structure"), "explore");
  assert.equal(activityPhase("get_script_source"), "scripts");
  assert.equal(activityPhase("set_script_source"), "edit");
  assert.equal(activityPhase("solo_playtest"), "run");
  assert.equal(activityPhase("upload_asset", "status"), "explore");
  assert.equal(evidencePhase("verification"), "verify");
  // A tool nobody has phased still lands somewhere sensible, by its kind.
  assert.equal(activityPhase("some_future_tool"), "run");
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

test("every phase can name itself in both tenses", () => {
  const phases = [
    "connect", "explore", "scripts", "edit", "run", "verify", "note",
  ] as const satisfies readonly ActivityPhase[];
  for (const phase of phases) {
    assert.ok(phaseTitle(phase, false).length > 0, `${phase} has no present tense`);
    assert.ok(phaseTitle(phase, true).length > 0, `${phase} has no past tense`);
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
