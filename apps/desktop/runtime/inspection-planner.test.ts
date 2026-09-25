import assert from "node:assert/strict";
import test from "node:test";
import type { McpToolCaller, McpToolOutcome } from "./mcp-types";
import { RunSession } from "./run-engine";
import { createInspectionPlanner } from "./inspection-planner";
import { isRunEvent, type RunEvent, type RunRequest } from "../shared/run-events";
import { riskForTool } from "../shared/mcp-tools";

/** Rebuild the assistant's prose from a run's message deltas. */
function collectMessageText(events: readonly RunEvent[]): string {
  return events
    .filter((event) => event.type === "message-delta")
    .map((event) => (event.type === "message-delta" ? event.text : ""))
    .join("");
}

function outcome(overrides: Partial<McpToolOutcome> = {}): McpToolOutcome {
  return { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1, ...overrides };
}

type Fixture = McpToolOutcome | ((args: Record<string, unknown>) => McpToolOutcome);

/**
 * A fake caller driven by tool name. A fixture may be a function so that a tool
 * called more than once with different arguments — `get_project_structure` is
 * called for the service overview and then per service — can answer each call.
 */
function makeCaller(responses: Record<string, Fixture>): McpToolCaller & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async callTool(tool, args) {
      calls.push(tool);
      const fixture = responses[tool];
      if (fixture === undefined) {
        return outcome({ ok: false, errorCode: "unknown_tool", message: `no fixture for ${tool}` });
      }
      return typeof fixture === "function" ? fixture(args) : fixture;
    },
  };
}

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run-1",
    projectId: "project-1",
    chatId: "chat-1",
    prompt: "Explain how this project works",
    conversation: { messages: [], truncated: false },
    approvalMode: "Ask first",
    autoPlaytest: false,
    endpoint: "http://127.0.0.1:1234",
    instanceId: null,
    provider: "chatgpt",
    model: null,
    effort: "medium",
    ...overrides,
  };
}

async function runPlanner(
  caller: McpToolCaller,
  request: RunRequest,
): Promise<{ events: RunEvent[]; outcome: string }> {
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller,
    planner: createInspectionPlanner(),
    request,
    emit: (event) => events.push(event),
  });
  const runOutcome = await session.execute();
  return { events, outcome: runOutcome };
}

function evidenceOf(events: readonly RunEvent[]): Array<Extract<RunEvent, { type: "evidence" }>> {
  return events.filter((event): event is Extract<RunEvent, { type: "evidence" }> => event.type === "evidence");
}

// `get_project_structure` with no path returns this overview, never a tree, so
// the planner has to ask for each script-bearing service by path.
const overviewFixture = {
  type: "service_overview",
  services: [
    { name: "Workspace", className: "Workspace", path: "game.Workspace", childCount: 3, hasChildren: true },
    { name: "ServerScriptService", className: "ServerScriptService", path: "game.ServerScriptService", childCount: 2, hasChildren: true },
    { name: "ServerStorage", className: "ServerStorage", path: "game.ServerStorage", childCount: 0, hasChildren: false },
  ],
};

const serverScriptsFixture = {
  name: "ServerScriptService",
  className: "ServerScriptService",
  path: "game.ServerScriptService",
  children: [
    { name: "Main", className: "Script", path: "game.ServerScriptService.Main", hasSource: true, scriptType: "Script" },
    { name: "Utils", className: "ModuleScript", path: "game.ServerScriptService.Utils", hasSource: true, scriptType: "ModuleScript" },
  ],
};

/** Answers the overview call, then one subtree per requested service path. */
function structureResponder(subtrees: Record<string, unknown>): Fixture {
  return (args) => {
    const path = typeof args.path === "string" ? args.path : "";
    if (path === "") return outcome({ data: overviewFixture });
    return outcome({ data: subtrees[path] ?? { name: path, path, children: [] } });
  };
}

const scriptedStructure = structureResponder({ "game.ServerScriptService": serverScriptsFixture });
const emptyStructure = structureResponder({});

test("happy path: inspects the place, records evidence, and reads a script", async () => {
  const caller = makeCaller({
    get_connected_instances: outcome({ data: { instances: [{ id: "inst-1", name: "Coffee Run", roles: ["edit"] }] } }),
    get_place_info: outcome({ data: { placeName: "Coffee Run", dataModelName: "CoffeeRun" } }),
    get_project_structure: scriptedStructure,
    get_script_source: outcome({
      data: {
        path: "game.ServerScriptService.Main",
        revision: "rev-abc",
        source: "print('hi')\nlocal x = 1",
      },
    }),
  });

  const { events, outcome: runOutcome } = await runPlanner(caller, makeRequest());

  assert.equal(runOutcome, "completed");
  // One overview call, then one per script-bearing service in priority order.
  assert.deepEqual(caller.calls, [
    "get_connected_instances",
    "get_place_info",
    "get_project_structure",
    "get_project_structure",
    "get_project_structure",
    "get_script_source",
  ]);

  const evidence = evidenceOf(events);
  const inspectionEvidence = evidence.find((event) => event.evidence.kind === "inspection");
  const verificationEvidence = evidence.find((event) => event.evidence.kind === "verification");
  assert.ok(inspectionEvidence, "expected inspection evidence");
  assert.ok(verificationEvidence, "expected verification evidence");
  assert.equal(verificationEvidence?.evidence.title, "game.ServerScriptService.Main");
  assert.equal(verificationEvidence?.evidence.passed, true);
  // The fingerprint is what proves the read; it belongs on the card's
  // expandable detail, not in the sentence the reader sees first.
  assert.doesNotMatch(verificationEvidence?.evidence.detail ?? "", /rev-abc/);
  assert.deepEqual(verificationEvidence?.evidence.metadata, [{ label: "Source revision", value: "rev-abc" }]);
  assert.equal(verificationEvidence?.evidence.format, "code");
  assert.ok((verificationEvidence?.evidence.lines?.length ?? 0) > 0);

  // The answer is one layer and the activity is another: the prose says what
  // was found, and never repeats a path, an operation, or a step the Activity
  // section already shows.
  const prose = collectMessageText(events);
  assert.match(prose, /Coffee Run/);
  assert.doesNotMatch(prose, /game\.ServerScriptService\.Main/);
  assert.doesNotMatch(prose, /get_|I read|I inspected|I'll |let me/i);

  // Every status the planner emits is a note about something unexpected, never
  // a restatement of a call the timeline already lists.
  const statuses = events.filter((event) => event.type === "status");
  assert.deepEqual(statuses, [], "a clean run has nothing to note");

  for (const event of events) assert.ok(isRunEvent(event), JSON.stringify(event));
});

test("a caveat goes to the activity layer and is admitted in the answer", async () => {
  const caller = makeCaller({
    get_connected_instances: outcome({ data: { instances: [] } }),
    get_place_info: outcome({ data: { placeName: "Coffee Run" } }),
    get_project_structure: scriptedStructure,
    get_script_source: outcome({ ok: false, errorCode: "request_failed", message: "timed out" }),
  });

  const { events, outcome: runOutcome } = await runPlanner(caller, makeRequest());

  assert.equal(runOutcome, "completed");
  const statuses = events.filter(
    (event): event is Extract<RunEvent, { type: "status" }> => event.type === "status",
  );
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].label, /Could not read a script/);

  const prose = collectMessageText(events);
  assert.match(prose, /Coffee Run/);
  assert.match(prose, /could not be read/i);
  // The path belongs to the note, not to the answer.
  assert.doesNotMatch(prose, /game\.ServerScriptService\.Main/);
});

test("a get_connected_instances failure ends the run honestly without further calls", async () => {
  const caller = makeCaller({
    get_connected_instances: outcome({ ok: false, errorCode: "request_failed", message: "no plugin connected" }),
  });

  const { events, outcome: runOutcome } = await runPlanner(caller, makeRequest());

  assert.equal(runOutcome, "completed");
  assert.deepEqual(caller.calls, ["get_connected_instances"]);

  const prose = collectMessageText(events);
  assert.ok(prose.length > 0, "expected an honest explanation in the prose");
  assert.equal(evidenceOf(events).length, 0);

  const completed = events.find(
    (event): event is Extract<RunEvent, { type: "run-completed" }> => event.type === "run-completed",
  );
  assert.ok(completed);
  assert.ok(completed.summary.length > 0);

  for (const event of events) assert.ok(isRunEvent(event), JSON.stringify(event));
});

test("a project with no scripts completes without trying to read anything", async () => {
  const caller = makeCaller({
    get_connected_instances: outcome({ data: { instances: [] } }),
    get_place_info: outcome({ data: { placeName: "Empty Place" } }),
    get_project_structure: emptyStructure,
  });

  const { events, outcome: runOutcome } = await runPlanner(caller, makeRequest());

  assert.equal(runOutcome, "completed");
  assert.deepEqual(caller.calls, [
    "get_connected_instances",
    "get_place_info",
    "get_project_structure",
    "get_project_structure",
    "get_project_structure",
  ]);

  const evidence = evidenceOf(events);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].evidence.kind, "inspection");
  assert.ok(evidence[0].evidence.lines?.some((line) => /no scripts/i.test(line)));

  for (const event of events) assert.ok(isRunEvent(event), JSON.stringify(event));
});

test("a script name mentioned in the prompt is looked up with search_objects", async () => {
  const caller = makeCaller({
    get_connected_instances: outcome({ data: { instances: [] } }),
    get_place_info: outcome({ data: { placeName: "Coffee Run" } }),
    get_project_structure: scriptedStructure,
    search_objects: outcome({
      data: {
        results: [{ name: "PlayerController", className: "Script", path: "game.StarterPlayer.PlayerController" }],
        count: 1,
      },
    }),
    get_script_source: outcome({ data: { revision: "rev-xyz", source: "return {}" } }),
  });

  const { events, outcome: runOutcome } = await runPlanner(
    caller,
    makeRequest({ prompt: "How does PlayerController decide when to respawn?" }),
  );

  assert.equal(runOutcome, "completed");
  assert.deepEqual(caller.calls, [
    "get_connected_instances",
    "get_place_info",
    "get_project_structure",
    "get_project_structure",
    "get_project_structure",
    "search_objects",
    "get_script_source",
  ]);

  const verificationEvidence = evidenceOf(events).find((event) => event.evidence.kind === "verification");
  assert.equal(verificationEvidence?.evidence.title, "game.StarterPlayer.PlayerController");

  for (const event of events) assert.ok(isRunEvent(event), JSON.stringify(event));
});

test("every tool the planner proposes is read-only", async () => {
  const caller = makeCaller({
    get_connected_instances: outcome({ data: { instances: [] } }),
    get_place_info: outcome({ data: { placeName: "Coffee Run" } }),
    get_project_structure: scriptedStructure,
    get_script_source: outcome({ data: { revision: "rev-abc", source: "print(1)" } }),
  });

  const { events } = await runPlanner(caller, makeRequest());

  const proposals = events.filter(
    (event): event is Extract<RunEvent, { type: "tool-proposed" }> => event.type === "tool-proposed",
  );
  assert.ok(proposals.length > 0, "expected at least one proposed tool call");
  for (const proposal of proposals) {
    assert.equal(riskForTool(proposal.proposal.tool), "read", `${proposal.proposal.tool} must be read-risk`);
  }
});
