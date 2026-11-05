import assert from "node:assert/strict";
import test from "node:test";

import { summarizeToolCall } from "../shared/mcp-tools";
import type { RunEvent, RunEventBody } from "../shared/run-events";
import { activitySteps, applyRunEvent, createRunView, type ActivityStep, type RunView } from "./run-view";
import {
  activeStepTitle, aggregateDuration, buildActivityModel, completedRunDetailsLabel, completedRunDurationLabel,
  completedRunMetadataLabel, currentNodeTitle, elapsedLabel, outputTokensLabel, mergeFindings, stepStatus, type ActivityNode,
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

test("neighbouring reads fold into one row, not eleven", () => {
  const nodes = model(fold(...inspectProject()));

  assert.deepEqual(nodes.map((node) => [node.title, node.finding]), [
    ["Read 7 items", "31 instances"],
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
    "merging hides operations behind a disclosure; it never drops or reorders one",
  );
  assert.deepEqual(
    nodes[0].children.slice(-5).map((child) => child.title),
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

test("a merged row in flight names the operation in flight, and only that row is active", () => {
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
  assert.equal(active[0].children.filter((child) => child.status === "active").length, 1);
});

test("a run of one stays one row rather than a group of one", () => {
  const nodes = model(fold(
    started,
    ...read("c1", "get_script_source", { instancePath: "game.ServerScriptService.Main" }, { summary: "get_script_source: 42 lines of source" }),
  ));

  assert.deepEqual(nodes.map((node) => [node.title, node.children.length]), [
    ["Read ServerScriptService.Main", 0],
  ]);
  assert.equal(nodes[0].finding, "42 lines of source");
});

test("a failure is its own row, says it failed, and splits the steps around it", () => {
  const nodes = model(fold(
    started,
    ...structureReads(),
    ...read("c8", "get_project_structure", { path: "game.Lighting" }, {
      summary: "get_project_structure failed (not-found): No instance at game.Lighting.",
      ok: false,
    }),
    ...read("c9", "get_project_structure", { path: "game.Lighting" }, { summary: "get_project_structure: 2 instances" }),
  ));

  assert.deepEqual(
    nodes.map((node) => [node.status, node.title, node.children.length]),
    [
      ["completed", "Read 5 items", 5],
      ["failed", "Failed reading Lighting", 0],
      ["completed", "Read Lighting", 0],
    ],
    "the row after a failure is not folded back over it, so the recovery can be seen",
  );
  assert.equal(nodes[1].finding, "No instance at game.Lighting.");
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

test("a note the planner left is its own row, where it was left", () => {
  const nodes = model(fold(
    started,
    ...read("c1", "get_project_structure", {}, { summary: "get_project_structure: 16 instances" }),
    { type: "status", label: "Studio did not report a place name", detail: "Describing it generically." },
    ...read("c2", "get_project_structure", { path: "game.Workspace" }, { summary: "get_project_structure: 4 instances" }),
  ));

  assert.deepEqual(nodes.map((node) => [node.kind, node.title]), [
    ["read", "Read the project structure"],
    ["note", "Studio did not report a place name"],
    ["read", "Read Workspace"],
  ]);
});

test("going back to an earlier kind of work starts a new row, so the order is kept", () => {
  const edit = (id: string): RunEventBody[] => [
    { type: "tool-proposed", proposal: writeProposal(id) },
    { type: "approval-resolved", callId: id, decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: id, tool: writeProposal(id).tool },
    { type: "tool-result", callId: id, tool: writeProposal(id).tool, ok: true, durationMs: 1, summary: `${writeProposal(id).tool}: done` },
  ];
  const nodes = model(fold(
    started,
    ...read("c1", "get_project_structure", {}, { summary: "get_project_structure: 16 instances" }),
    ...read("c2", "get_project_structure", { path: "game.Workspace" }, { summary: "get_project_structure: 4 instances" }),
    ...edit("c3"),
    ...read("c4", "get_project_structure", { path: "game.Lighting" }, { summary: "get_project_structure: 2 instances" }),
  ));

  assert.deepEqual(nodes.map((node) => [node.kind, node.children.length]), [
    ["read", 2],
    ["edit", 0],
    ["read", 0],
  ]);
  assert.equal(nodes[0].title, "Read 2 items");
});

test("a merged row's title comes from what its calls have in common", () => {
  const scripts = model(fold(
    started,
    ...read("c1", "get_script_source", { instancePath: "game.ServerScriptService.Main" }, { summary: "get_script_source: 42 lines of source" }),
    ...read("c2", "get_script_source", { instancePath: "game.ServerScriptService.Combat" }, { summary: "get_script_source: 8 lines of source" }),
  ));
  assert.deepEqual(scripts.map((node) => [node.title, node.finding]), [["Read 2 scripts", "50 lines of source"]]);
});

test("a search reads as a query, and a query with nothing in it names what was searched", () => {
  const nodes = model(fold(
    started,
    ...read("c1", "search_objects", { query: "Coin" }, { summary: "search_objects: 3 results" }),
    ...read("c2", "grep_scripts", { pattern: "." }, { summary: "grep_scripts: 9 results" }),
  ));

  assert.deepEqual(nodes[0].children.map((node) => node.title), [
    "Searched for “Coin”",
    "Searched the scripts",
  ]);
  assert.equal(nodes[0].title, "Ran 2 searches");
});

test("a finished run has nothing in flight", () => {
  const nodes = model(fold(...inspectProject()));
  assert.equal(nodes.some((node) => node.status === "active"), false);
});

test("a hundred routine reads stay one row", () => {
  const bodies: RunEventBody[] = [started];
  for (let index = 0; index < 100; index++) {
    bodies.push(...read(`c${index}`, "get_project_structure", { path: `game.Workspace.Model${index}` }, {
      summary: "get_project_structure: 2 instances",
    }));
  }
  const nodes = model(fold(...bodies));

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].children.length, 100);
  assert.equal(nodes[0].title, "Read 100 items");
  assert.equal(nodes[0].finding, "200 instances");
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

test("a completed run duration uses compact units", () => {
  const startedAt = "2026-10-13T10:00:00.000Z";
  assert.equal(completedRunDurationLabel(startedAt, "2026-10-13T10:00:42.000Z"), "42s");
  assert.equal(completedRunDurationLabel(startedAt, "2026-10-13T10:08:34.000Z"), "8m 34s");
  assert.equal(completedRunDurationLabel(startedAt, "2026-10-13T11:12:34.000Z"), "1h 12m");
  assert.equal(completedRunDurationLabel(startedAt, "2026-10-13T10:00:00.999Z"), "0s");
  assert.equal(completedRunDurationLabel(startedAt, "2026-10-13T10:01:00.000Z"), "1m");
  assert.equal(completedRunDurationLabel(startedAt, "2026-10-13T11:00:00.000Z"), "1h");
});

test("a completed run duration is omitted when its timestamps cannot be trusted", () => {
  const startedAt = "2026-10-13T10:00:00.000Z";
  assert.equal(completedRunDurationLabel("", ""), null);
  assert.equal(completedRunDurationLabel("not-a-date", "2026-10-13T10:00:42.000Z"), null);
  assert.equal(completedRunDurationLabel(startedAt, "not-a-date"), null);
  assert.equal(completedRunDurationLabel("2026-02-30T10:00:00.000Z", "2026-03-02T10:00:42.000Z"), null);
  assert.equal(completedRunDurationLabel("0", "1"), null);
  assert.equal(completedRunDurationLabel(startedAt, startedAt), null);
  assert.equal(completedRunDurationLabel(startedAt, "2026-10-13T09:59:59.000Z"), null);
});

test("completed run metadata keeps its label when duration is unavailable", () => {
  const startedAt = "2026-10-13T10:00:00.000Z";
  assert.equal(
    completedRunMetadataLabel("Full auto", startedAt, "2026-10-13T10:00:42.000Z"),
    "Full auto · 42s",
  );
  assert.equal(completedRunMetadataLabel("Demo", startedAt, "2026-10-13T10:00:42.000Z"), "Demo · 42s");
  assert.equal(completedRunMetadataLabel("Full auto", startedAt, ""), "Full auto");
});

test("completed run details keep metadata and usage on one line", () => {
  assert.equal(
    completedRunDetailsLabel("Full auto · 4s", "Used 2.3k tokens: 2.3k input, 56 output · 1 request"),
    "Full auto · 4s · Used 2.3k tokens: 2.3k input, 56 output · 1 request",
  );
  assert.equal(completedRunDetailsLabel("Full auto · 4s", null), "Full auto · 4s");
});

test("a live output count is marked as an estimate until the provider reports its own", () => {
  assert.equal(outputTokensLabel(78, false), "~78 tokens");
  assert.equal(outputTokensLabel(78, true), "78 tokens");
  assert.equal(outputTokensLabel(1, true), "1 token");
  // Thousands shorten, never rounding up past what has streamed.
  assert.equal(outputTokensLabel(1_000, false), "~1k tokens");
  assert.equal(outputTokensLabel(1_499, false), "~1.4k tokens");
  assert.equal(outputTokensLabel(9_999, false), "~9.9k tokens");
  assert.equal(outputTokensLabel(12_345, true), "12k tokens");
  assert.equal(outputTokensLabel(99_999, true), "99k tokens");
});
