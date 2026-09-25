import assert from "node:assert/strict";
import test from "node:test";

import { summarizeToolCall } from "../shared/mcp-tools";
import type { RunEvent, RunEventBody } from "../shared/run-events";
import { activitySteps, applyRunEvent, createRunView, type ActivityStep, type RunView } from "./run-view";
import {
  activeStepTitle, aggregateDuration, buildActivityModel, currentNodeTitle, elapsedLabel,
  mergeFindings, stepStatus, type ActivityNode,
} from "./activity-model";

const RUN_ID = "run-1";

function fold(...bodies: RunEventBody[]): RunView {
  const events = bodies.map((body, index) => ({
    ...body,
    runId: RUN_ID,
    seq: index + 1,
    at: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
  }) as RunEvent);
  return events.reduce(applyRunEvent, createRunView(RUN_ID, "Inspect this project", "Ask first"));
}

const started: RunEventBody = {
  type: "run-started",
  prompt: "Inspect this project",
  approvalMode: "Ask first",
  autoPlaytest: false,
  endpoint: "http://127.0.0.1:3000",
  instanceId: "studio-1",
  model: "gpt-test",
  effort: "medium",
  planner: "chatgpt",
};

/** One whole read, from proposal to result, as the engine emits it. */
function read(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  result: { summary: string; ok?: boolean; durationMs?: number },
): RunEventBody[] {
  return [
    { type: "tool-proposed", proposal: { callId, tool, arguments: args, summary: summarizeToolCall(tool, args), risk: "read" } },
    { type: "approval-resolved", callId, decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId, tool },
    {
      type: "tool-result",
      callId,
      tool,
      ok: result.ok ?? true,
      durationMs: result.durationMs ?? 8,
      summary: result.summary,
    },
  ];
}

/** A write, proposed and put to the reader. */
function writeProposal(callId: string) {
  return {
    callId,
    tool: "set_script_source",
    arguments: { instancePath: "game.ServerScriptService.Main" },
    summary: summarizeToolCall("set_script_source", { instancePath: "game.ServerScriptService.Main" }),
    risk: "mutation" as const,
  };
}

function structureReads(): RunEventBody[] {
  return [
    ...read("c3", "get_project_structure", {}, { summary: "get_project_structure: 16 instances" }),
    ...read("c4", "get_project_structure", { path: "game.Workspace" }, { summary: "get_project_structure: 4 instances" }),
    ...read("c5", "get_project_structure", { path: "game.ServerScriptService" }, { summary: "get_project_structure: 7 instances" }),
    ...read("c6", "get_project_structure", { path: "game.StarterPlayer" }, { summary: "get_project_structure: 3 instances" }),
    ...read("c7", "get_project_structure", { path: "game.StarterPack" }, { summary: "get_project_structure: 0 instances" }),
  ];
}

/** The flow behind the "Inspect this project" suggestion, start to finish. */
function inspectProject(): RunEventBody[] {
  return [
    started,
    { type: "status", label: "Connecting to ChatGPT", transient: true },
    { type: "status", label: "Thinking with ChatGPT", transient: true },
    ...read("c1", "get_connected_instances", {}, { summary: "get_connected_instances: 1 instance" }),
    ...read("c2", "get_place_info", {}, { summary: "get_place_info: {\"placeId\":123,\"name\":\"Coffee Run\"}" }),
    ...structureReads(),
    { type: "status", label: "Thinking with ChatGPT", transient: true },
  ];
}

function model(view: RunView): ActivityNode[] {
  return buildActivityModel(activitySteps(view));
}

function leaves(nodes: readonly ActivityNode[]): ActivityNode[] {
  return nodes.flatMap((node) => (node.children.length === 0 ? [node] : node.children));
}

test("a project inspection reads as a few phases, not eleven operations", () => {
  const nodes = model(fold(...inspectProject()));

  assert.deepEqual(nodes.map((node) => [node.title, node.finding]), [
    ["Connected to Studio", "2 steps · 1 instance"],
    ["Understood the project", "5 steps · 30 instances"],
  ]);
});

/**
 * The docked status line asks this first and falls back to the provider's own
 * state, so "nothing in flight" has to be answerable rather than approximated.
 */
test("the live line names the operation in flight, and nothing between calls", () => {
  assert.equal(activeStepTitle(activitySteps(fold(...inspectProject()))), null);

  const inFlight = fold(
    ...inspectProject(),
    { type: "tool-proposed", proposal: writeProposal("c8") },
    { type: "approval-resolved", callId: "c8", decision: "approved", automatic: true, reason: "auto-approved" },
    { type: "tool-started", callId: "c8", tool: "set_script_source" },
  );
  const title = activeStepTitle(activitySteps(inFlight));
  assert.ok(title !== null && title.endsWith("…"), `expected the operation in flight, got ${title}`);
});

/**
 * The line a closed Activity section carries. A finished phase's own name is
 * the wrong answer to "what just happened", so the last row reaches past the
 * group to the operation inside it.
 */
test("the closed Activity line is the operation in flight, else the last one done", () => {
  const done = model(fold(...inspectProject()));
  const doneLeaves = leaves(done);
  assert.equal(currentNodeTitle(done), doneLeaves[doneLeaves.length - 1].title);
  assert.notEqual(currentNodeTitle(done), done[done.length - 1].title);

  const inFlight = model(fold(
    ...inspectProject(),
    { type: "tool-proposed", proposal: writeProposal("c8") },
    { type: "approval-resolved", callId: "c8", decision: "approved", automatic: true, reason: "auto-approved" },
    { type: "tool-started", callId: "c8", tool: "set_script_source" },
  ));
  const title = currentNodeTitle(inFlight);
  assert.ok(title !== null && title.endsWith("…"), `expected the operation in flight, got ${title}`);
});

test("every operation survives the fold, in the order it happened", () => {
  const view = fold(...inspectProject());
  const steps = activitySteps(view);
  const nodes = model(view);

  assert.deepEqual(
    leaves(nodes).map((node) => node.key),
    steps.map((step) => step.key),
    "grouping hides operations behind a disclosure; it never drops or reorders one",
  );
  assert.deepEqual(
    nodes[1].children.map((child) => child.title),
    [
      "Read the project structure",
      "Read Workspace",
      "Read ServerScriptService",
      "Read StarterPlayer",
      "Read StarterPack",
    ],
    "and each one is named by what it looked at, not by its operation",
  );
});

test("the group in flight names the operation in flight, and only that row is active", () => {
  const nodes = model(fold(
    started,
    ...read("c1", "get_connected_instances", {}, { summary: "get_connected_instances: 1 instance" }),
    { type: "tool-proposed", proposal: {
      callId: "c2", tool: "get_project_structure", arguments: { path: "game.ServerScriptService" },
      summary: summarizeToolCall("get_project_structure", { path: "game.ServerScriptService" }), risk: "read",
    } },
    { type: "approval-resolved", callId: "c2", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c2", tool: "get_project_structure" },
  ));

  const active = nodes.filter((node) => node.status === "active");
  assert.equal(active.length, 1, "exactly one row claims to be happening now");
  assert.equal(active[0].title, "Reading ServerScriptService…");
  assert.equal(nodes[0].status, "completed");
});

test("a phase that produced one step stays one row rather than a group of one", () => {
  const nodes = model(fold(
    started,
    ...read("c1", "get_place_info", {}, { summary: "get_place_info: 1 instance" }),
    ...read("c2", "get_script_source", { instancePath: "game.ServerScriptService.Main" }, { summary: "get_script_source: 42 lines of source" }),
  ));

  assert.deepEqual(nodes.map((node) => [node.title, node.children.length]), [
    ["Read the place", 0],
    ["Read ServerScriptService.Main", 0],
  ]);
  assert.equal(nodes[1].finding, "42 lines of source");
});

test("a failure inside a collapsed group stays visible and colours the group", () => {
  const nodes = model(fold(
    started,
    ...structureReads(),
    ...read("c8", "get_project_structure", { path: "game.Lighting" }, {
      summary: "get_project_structure failed (not-found): No instance at game.Lighting.",
      ok: false,
    }),
  ));

  const [group] = nodes;
  assert.equal(group.status, "failed", "the worst thing inside is what the group reports");
  assert.match(group.finding ?? "", /1 failed/);
  assert.deepEqual(
    group.alerts.map((alert) => [alert.title, alert.finding]),
    [["Read Lighting", "No instance at game.Lighting."]],
    "so a reader who never opens the group still sees what went wrong",
  );
});

test("a rejected call is skipped, and an approval request is a row of its own", () => {
  const asking = model(fold(
    started,
    { type: "tool-proposed", proposal: writeProposal("c1") },
    { type: "approval-requested", callId: "c1", proposal: writeProposal("c1"), reason: "mutation-requires-approval" },
  ));
  assert.equal(asking[0].status, "warning", "a question addressed to the reader is never folded away");

  const rejected = model(fold(
    started,
    { type: "tool-proposed", proposal: writeProposal("c1") },
    { type: "approval-resolved", callId: "c1", decision: "rejected", automatic: true, reason: "read-only-mode" },
  ));
  assert.equal(rejected[0].status, "skipped");
});

test("a raw payload never reaches a row, and never stops being reachable", () => {
  const view = fold(
    started,
    ...read("c1", "get_place_info", {}, { summary: "get_place_info: {\"placeId\":123,\"name\":\"Coffee Run\"}" }),
  );
  const [node] = model(view);

  assert.equal(node.finding, undefined, "compacted JSON is debug output, not a finding");
  assert.equal(node.step?.resultSummary, "get_place_info: {\"placeId\":123,\"name\":\"Coffee Run\"}");
  assert.equal(node.step?.tool, "get_place_info");
});

test("the full instance path stays on the step the shortened title came from", () => {
  const view = fold(
    started,
    ...read("c1", "get_script_source", { instancePath: "game.ServerScriptService.Main" }, { summary: "get_script_source: 42 lines of source" }),
  );
  const [node] = model(view);

  assert.equal(node.title, "Read ServerScriptService.Main");
  assert.equal(node.step?.target, "game.ServerScriptService.Main");
});

test("what the provider is doing is a state, not a step it took", () => {
  const view = fold(
    started,
    { type: "status", label: "Connecting to ChatGPT", transient: true },
    { type: "status", label: "Thinking with ChatGPT", transient: true },
  );

  // "Thinking with ChatGPT" is true of the whole turn, so it is the run's live
  // status line and never a ticked-off row in the list.
  assert.deepEqual(model(view), []);
  assert.deepEqual(view.status, { label: "Thinking with ChatGPT", detail: undefined });
});

test("a note the planner left is kept, and kept out of the phases", () => {
  const nodes = model(fold(
    started,
    ...read("c1", "get_project_structure", {}, { summary: "get_project_structure: 16 instances" }),
    { type: "status", label: "Studio did not report a place name", detail: "Describing it generically." },
    ...read("c2", "get_project_structure", { path: "game.Workspace" }, { summary: "get_project_structure: 4 instances" }),
  ));

  assert.deepEqual(nodes.map((node) => [node.kind, node.title]), [
    ["read", "Understood the project"],
    ["note", "Studio did not report a place name"],
  ], "the note is its own row, and the read after it rejoins the phase above");
  assert.equal(nodes[0].children.length, 2);
});

test("a phase re-entered later rejoins its row instead of starting a second one", () => {
  const nodes = model(fold(
    started,
    ...read("c1", "get_project_structure", {}, { summary: "get_project_structure: 16 instances" }),
    ...read("c2", "get_script_source", { instancePath: "game.ServerScriptService.Main" }, { summary: "get_script_source: 42 lines of source" }),
    ...read("c3", "get_project_structure", { path: "game.Workspace" }, { summary: "get_project_structure: 4 instances" }),
    ...read("c4", "search_objects", { query: "Coin" }, { summary: "search_objects: 3 results" }),
  ));

  assert.deepEqual(nodes.map((node) => [node.title, node.finding]), [
    ["Understood the project", "3 steps · 20 instances · 3 results"],
    ["Read ServerScriptService.Main", "42 lines of source"],
  ], "a phase is a place to look, not a run of adjacent calls");
});

test("a search reads as a query, and a query with nothing in it names what was searched", () => {
  const nodes = model(fold(
    started,
    ...read("c1", "search_objects", { query: "Coin" }, { summary: "search_objects: 3 results" }),
    ...read("c2", "grep_scripts", { pattern: "." }, { summary: "grep_scripts: 9 results" }),
  ));

  assert.deepEqual(nodes.map((node) => node.title), [
    "Searched for “Coin”",
    "Searched the scripts",
  ]);
});

test("a finished run has nothing in flight", () => {
  const nodes = model(fold(...inspectProject()));
  assert.equal(nodes.some((node) => node.status === "active"), false);
});

test("a hundred routine reads stay a handful of rows", () => {
  const bodies: RunEventBody[] = [started];
  for (let index = 0; index < 100; index++) {
    bodies.push(...read(`c${index}`, "get_project_structure", { path: `game.Workspace.Model${index}` }, {
      summary: "get_project_structure: 2 instances",
    }));
  }
  const nodes = model(fold(...bodies));

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].children.length, 100);
  assert.equal(nodes[0].finding, "100 steps · 200 instances");
});

test("countable findings add up; the rest stay on their own rows", () => {
  assert.deepEqual(mergeFindings(["16 instances", "4 instances", "42 lines of source"]), [
    "20 instances",
    "42 lines of source",
  ]);
  assert.deepEqual(mergeFindings(["1 instance"]), ["1 instance"]);
  assert.deepEqual(mergeFindings(["Empty", "source revision recorded"]), []);
});

test("only a duration a reader can feel is offered to a row", () => {
  assert.equal(aggregateDuration(undefined), undefined);
  assert.equal(aggregateDuration(28), undefined, "per-call milliseconds are details, not headlines");
  assert.equal(aggregateDuration(1_412), "1.4s");
});

test("every engine state has a reader-facing status", () => {
  const step = (state: ActivityStep["state"]): ActivityStep => ({
    key: "k", kind: "read", state, label: "Read the place",
  });
  assert.deepEqual(
    (["proposed", "awaiting-approval", "rejected", "running", "done", "failed"] as const).map((state) =>
      stepStatus(step(state))),
    ["pending", "warning", "skipped", "active", "completed", "failed"],
  );
});

test("a check that did not pass reads as a failure, not a silent tick", () => {
  const nodes = model(fold(
    started,
    { type: "evidence", evidence: {
      id: "e1", kind: "verification", title: "game.ServerScriptService.Main", passed: false,
    } },
  ));

  assert.equal(nodes[0].status, "failed");
  assert.equal(nodes[0].title, "Verified ServerScriptService.Main");
  assert.equal(nodes[0].finding, "Failed");
});

test("a live wait reads as whole seconds, and as a clock once it passes a minute", () => {
  // Read repeatedly as it climbs, so no flickering decimal: the counter is
  // there to show movement, not to measure anything.
  assert.equal(elapsedLabel(0), "0s");
  assert.equal(elapsedLabel(4_900), "4s");
  assert.equal(elapsedLabel(59_999), "59s");
  // Past a minute, seconds alone make a reader do arithmetic to learn how long
  // they have been waiting.
  assert.equal(elapsedLabel(60_000), "1:00");
  assert.equal(elapsedLabel(94_000), "1:34");
  assert.equal(elapsedLabel(600_000), "10:00");
  // A clock that disagrees with itself between ticks would print a negative.
  assert.equal(elapsedLabel(-5_000), "0s");
});
