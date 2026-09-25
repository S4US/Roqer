/**
 * What the "Inspect this project" suggestion actually looks like once it is on
 * screen.
 *
 * The real planner runs against a stubbed Studio, through the real session, and
 * the events it emits are folded by the real renderer code. Nothing here
 * describes the activity layer twice: if the planner starts reading a sixth
 * service tomorrow, this test says what that does to the timeline.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createInspectionPlanner } from "./inspection-planner";
import type { McpToolCaller, McpToolOutcome } from "./mcp-types";
import { RunSession } from "./run-engine";
import type { RunEvent, RunRequest } from "../shared/run-events";
import { buildActivityModel, type ActivityNode } from "../src/activity-model";
import { activitySteps, applyRunEvent, createRunView } from "../src/run-view";

const RUN_ID = "run-1";

const SERVICES = {
  services: [
    { name: "ServerScriptService", path: "game.ServerScriptService", hasChildren: true },
    { name: "ReplicatedStorage", path: "game.ReplicatedStorage", hasChildren: true },
    { name: "Workspace", path: "game.Workspace", hasChildren: true },
  ],
};

const SUBTREES: Record<string, unknown> = {
  "game.ServerScriptService": {
    children: [
      { path: "game.ServerScriptService.Main", hasSource: true, scriptType: "Script" },
      { path: "game.ServerScriptService.Shop", hasSource: true, scriptType: "Script" },
    ],
  },
  "game.ReplicatedStorage": {
    children: [{ path: "game.ReplicatedStorage.Remotes", hasSource: true, scriptType: "ModuleScript" }],
  },
  "game.Workspace": { children: [] },
};

/** A Studio that answers the way a small place would. */
function studio(calls: string[]): McpToolCaller {
  return {
    async callTool(tool, args): Promise<McpToolOutcome> {
      calls.push(tool);
      const ok = (data: unknown): McpToolOutcome =>
        ({ ok: true, data, text: "", httpStatus: 200, durationMs: 6 });

      if (tool === "get_connected_instances") return ok({ instances: [{ id: "studio-1" }] });
      if (tool === "get_place_info") return ok({ placeName: "Coffee Run", placeId: 123 });
      if (tool === "get_project_structure") {
        const path = typeof args.path === "string" ? args.path : null;
        return ok(path === null ? SERVICES : SUBTREES[path] ?? { children: [] });
      }
      if (tool === "get_script_source") {
        return ok({ source: "local shop = {}\nreturn shop", sourceRevision: "sr1:2:abc" });
      }
      return { ok: false, data: undefined, message: `unexpected ${tool}`, text: "", httpStatus: 400, durationMs: 1 };
    },
  };
}

function request(): RunRequest {
  return {
    runId: RUN_ID,
    projectId: "project-1",
    chatId: "chat-1",
    prompt: "Inspect this project",
    conversation: { messages: [], truncated: false },
    approvalMode: "Ask first",
    autoPlaytest: false,
    endpoint: "http://127.0.0.1:1234",
    instanceId: "studio-1",
    provider: "chatgpt",
    model: null,
    effort: "medium",
  };
}

async function inspect(): Promise<{ events: RunEvent[]; calls: string[] }> {
  const events: RunEvent[] = [];
  const calls: string[] = [];
  const session = new RunSession({
    caller: studio(calls),
    planner: createInspectionPlanner(),
    request: request(),
    emit: (event) => events.push(event),
  });
  await session.execute();
  return { events, calls };
}

function timeline(events: readonly RunEvent[]): ActivityNode[] {
  const view = events.reduce(applyRunEvent, createRunView(RUN_ID, "Inspect this project", "Ask first"));
  return buildActivityModel(activitySteps(view));
}

test("a project inspection is a short timeline, not a call log", async () => {
  const { events, calls } = await inspect();
  const nodes = timeline(events);

  assert.equal(calls.length, 7, "seven operations went to Studio");
  assert.deepEqual(nodes.map((node) => [node.title, node.finding]), [
    ["Connected to Studio", "2 steps · 1 instance"],
    ["Understood the project", "4 steps"],
    ["Inspected Coffee Run", undefined],
    ["Read ServerScriptService.Main", "2 lines of source"],
    ["Verified ServerScriptService.Main", "Passed"],
  ], "and they arrive as five lines, three of which are what the run found");
});

test("nothing is summarised away: every call is still one click down", async () => {
  const { events, calls } = await inspect();
  const nodes = timeline(events);

  const operations = nodes
    .flatMap((node) => (node.children.length === 0 ? [node] : node.children))
    .flatMap((node) => node.step?.tool ?? []);
  assert.deepEqual(operations, calls, "the leaves under the groups are the calls that were made");

  const explored = nodes[1];
  assert.equal(explored.children.length, 4, "the overview and the three service walks");
  assert.deepEqual(
    explored.children.map((child) => child.title),
    [
      "Read the project structure",
      "Read ServerScriptService",
      "Read ReplicatedStorage",
      "Read Workspace",
    ],
  );
  assert.equal(
    explored.children[1].step?.target,
    "game.ServerScriptService",
    "with the full path kept for the details area",
  );
});

test("what the run learned stays on the surface", async () => {
  const { events } = await inspect();
  const nodes = timeline(events);

  // Evidence is the answer's backing, not one more operation, so it is never
  // folded into a phase.
  assert.deepEqual(
    nodes.filter((node) => node.step?.evidence).map((node) => node.title),
    ["Inspected Coffee Run", "Verified ServerScriptService.Main"],
  );
  assert.equal(nodes[4].step?.evidence?.lines?.length, 2, "and the source it read is still attached");
});

test("no operation name or payload reaches a primary row", async () => {
  const { events } = await inspect();
  for (const node of timeline(events)) {
    const row = `${node.title} ${node.finding ?? ""}`;
    assert.doesNotMatch(row, /_/, `"${row}" leaked an operation name`);
    assert.doesNotMatch(row, /[{}[\]]/, `"${row}" leaked a payload`);
  }
});

test("a finished run has no row claiming to be in flight", async () => {
  const { events } = await inspect();
  assert.equal(timeline(events).some((node) => node.status === "active"), false);
});
