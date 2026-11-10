/**
 * Engine coverage for the review pass: when it runs, what the reviewer is
 * given, what it is refused, and that nothing it does reaches the run's own
 * record or the gate's verdict.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAgentRuntime } from "./agent-definition";
import { createAgentLoopPlanner, type TurnTransport } from "./agent-loop";
import type { McpToolCaller, McpToolOutcome } from "./mcp-types";
import type { TurnEvent, TurnRequest } from "./model-api/turn-contract";
import { REVIEW_CALL_BUDGET } from "./review";
import { RunSession } from "./run-engine";
import type { Planner, PlannerContext } from "./run-engine";
import { isRunEvent, type RunEvent, type RunRequest, type RunReview } from "../shared/run-events";

type Call = { tool: string; args: Record<string, unknown> };

function caller(calls: Call[] = [], result: Partial<McpToolOutcome> = {}): McpToolCaller {
  return {
    async callTool(tool, args): Promise<McpToolOutcome> {
      calls.push({ tool, args });
      return { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1, ...result };
    },
  };
}

function planner(id: string, run: (context: PlannerContext) => Promise<string>): Planner {
  return { id, run };
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run-1",
    projectId: "project-1",
    chatId: "chat-1",
    prompt: "Make the door open when touched",
    conversation: { messages: [], truncated: false },
    approvalMode: "Full auto",
    autoPlaytest: false,
    endpoint: "http://127.0.0.1:1234",
    instanceId: null,
    provider: "custom",
    model: "model-a",
    effort: "medium",
    ...overrides,
  };
}

/** A worker that changes one thing, so there is something to review. */
const worker = planner("worker", async (context) => {
  context.recordChange({ kind: "properties", target: "Workspace.Door", summary: "Set CanCollide to false" });
  context.say("The door opens now.");
  return "The door opens now.";
});

const verdict = (value: unknown) => `Checked.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const PASS = verdict({ verdict: "pass", summary: "Read the door.", findings: [] });

function completion(events: readonly RunEvent[]): Extract<RunEvent, { type: "run-completed" }> {
  const last = events.at(-1);
  assert.equal(last?.type, "run-completed");
  return last as Extract<RunEvent, { type: "run-completed" }>;
}

async function run(options: {
  reviewer?: Planner;
  worker?: Planner;
  request?: Partial<RunRequest>;
  calls?: Call[];
  result?: Partial<McpToolOutcome>;
  reviewTimeLimitMs?: number;
  onSession?: (session: RunSession) => void;
}): Promise<{ events: RunEvent[]; outcome: string; review: RunReview | undefined }> {
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller: caller(options.calls, options.result),
    planner: options.worker ?? worker,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    ...(options.reviewTimeLimitMs === undefined ? {} : { reviewTimeLimitMs: options.reviewTimeLimitMs }),
    request: request(options.request),
    emit: (event) => events.push(event),
  });
  options.onSession?.(session);
  const outcome = await session.execute();
  for (const event of events) assert.ok(isRunEvent(event), `event failed isRunEvent: ${JSON.stringify(event)}`);
  return { events, outcome, review: completion(events).review };
}

test("a run with no reviewer has no review and says nothing about one", async () => {
  const { events, review } = await run({});
  assert.equal(review, undefined);
  assert.equal(events[0].type === "run-started" && events[0].review, undefined);
});

test("the reviewer runs after the work and its verdict is recorded with the run", async () => {
  let packet = "";
  const { events, outcome, review } = await run({
    reviewer: planner("reviewer", async (context) => {
      packet = context.prompt;
      context.runUsage({ inputTokens: 900, outputTokens: 40 });
      return verdict({ verdict: "issues", findings: [{ severity: "high", target: "Workspace.Door", detail: "It never closes again." }] });
    }),
  });

  assert.equal(outcome, "completed");
  assert.deepEqual(review, {
    verdict: "issues",
    findings: [{ severity: "high", target: "Workspace.Door", detail: "It never closes again." }],
    planner: "reviewer",
    model: "model-a",
    usage: { inputTokens: 900, outputTokens: 40 },
  });
  assert.equal(events[0].type === "run-started" && events[0].review, true);
  // The reviewer is briefed from the host's record, not the worker's conversation.
  assert.match(packet, /Make the door open when touched/);
  assert.match(packet, /properties Workspace\.Door: Set CanCollide to false/);
  assert.match(packet, /The door opens now\./);
  // The review's cost is its own: the run reported no usage, and still has none.
  assert.equal(completion(events).usage, undefined);
  const marker = events.findIndex((event) => event.type === "status" && event.label === "Reviewing the result");
  assert.ok(marker > events.findIndex((event) => event.type === "change"), "the review is announced after the work");
});

test("a review does not change the gate's verdict, the reply, the tasks, the changes, or the evidence", async () => {
  const before = await run({});
  const after = await run({
    reviewer: planner("reviewer", async (context) => {
      context.say("REVIEWER PROSE");
      context.setTasks([{ id: "t", title: "invented", status: "blocked", requiresRuntimeEvidence: true }]);
      context.recordChange({ kind: "script-source", target: "Invented", summary: "never happened" });
      context.recordEvidence({ kind: "verification", title: "invented", passed: false });
      context.contextUsage(10, 100);
      assert.deepEqual(context.takeSteers(), []);
      await assert.rejects(context.askUser("Really?", ["Yes", "No"]), /cannot ask the user/);
      return verdict({ verdict: "issues", findings: [{ severity: "high", detail: "Everything is wrong." }] });
    }),
  });

  assert.deepEqual(completion(after.events).verification, completion(before.events).verification);
  const kinds = (events: RunEvent[]) => events
    .filter((event) => ["change", "evidence", "tasks", "message-delta", "context-usage", "question-asked", "failure"].includes(event.type))
    .map((event) => event.type);
  assert.deepEqual(kinds(after.events), kinds(before.events));
  assert.equal(after.review?.verdict, "issues");
});

test("a review is read-only in every mode: reads run, everything else is refused", async () => {
  const calls: Call[] = [];
  let refused: McpToolOutcome | undefined;
  let read: McpToolOutcome | undefined;
  const { events } = await run({
    calls,
    request: { approvalMode: "Full auto" },
    reviewer: planner("reviewer", async (context) => {
      read = await context.call("get_script_source", { path: "Workspace.Door.Script" });
      refused = await context.call("execute_luau", { code: "workspace.Door:Destroy()" });
      await context.call("set_properties", { path: "Workspace.Door", properties: { Transparency: 1 } });
      return PASS;
    }),
  });

  assert.equal(read?.ok, true);
  assert.equal(refused?.ok, false);
  assert.equal(refused?.errorCode, "approval_rejected");
  assert.deepEqual(calls.map((call) => call.tool), ["get_script_source"], "only the read reached Studio");
  const denied = events.filter((event) => event.type === "approval-resolved" && event.decision === "rejected");
  assert.equal(denied.length, 2);
  assert.ok(denied.every((event) => event.type === "approval-resolved" && event.reason === "read-only-mode" && event.automatic));
  assert.equal(events.some((event) => event.type === "approval-requested"), false, "a review never asks the user to approve anything");
});

test("a read the reviewer gets wrong is not a failure of the run", async () => {
  const { events, review } = await run({
    result: { ok: false, errorCode: "not_found", message: "No such instance" },
    reviewer: planner("reviewer", async (context) => {
      await context.call("get_instance_properties", { path: "Workspace.Missing" });
      return PASS;
    }),
  });
  assert.equal(events.some((event) => event.type === "failure"), false);
  assert.equal(events.some((event) => event.type === "tool-result" && !event.ok), true, "the failed call is still shown");
  assert.deepEqual(completion(events).verification, completion((await run({})).events).verification, "the gate was decided before the review");
  assert.equal(review?.verdict, "passed");
});

test("a review gets a bounded number of Studio calls", async () => {
  const calls: Call[] = [];
  let last: McpToolOutcome | undefined;
  await run({
    calls,
    reviewer: planner("reviewer", async (context) => {
      for (let index = 0; index <= REVIEW_CALL_BUDGET; index += 1) {
        last = await context.call("get_script_source", { path: `Workspace.S${index}` });
      }
      return PASS;
    }),
  });
  assert.equal(calls.length, REVIEW_CALL_BUDGET);
  assert.equal(last?.ok, false);
  assert.equal(last?.errorCode, "review_budget_spent");
});

test("nothing is reviewed when the run changed nothing, failed, or was stopped", async () => {
  let reviews = 0;
  const reviewer = planner("reviewer", async () => {
    reviews += 1;
    return PASS;
  });

  const answered = await run({ reviewer, worker: planner("worker", async () => "Hello.") });
  assert.equal(answered.review, undefined);

  const failed = await run({
    reviewer,
    worker: planner("worker", async (context) => {
      context.recordChange({ kind: "properties", target: "Workspace.Door", summary: "half done" });
      throw new Error("provider went away");
    }),
  });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.review, undefined);

  let session: RunSession | undefined;
  const stopped = await run({
    reviewer,
    onSession: (created) => { session = created; },
    worker: planner("worker", async (context) => {
      context.recordChange({ kind: "properties", target: "Workspace.Door", summary: "half done" });
      session?.cancel();
      return "stopped";
    }),
  });
  assert.equal(stopped.outcome, "cancelled");
  assert.equal(stopped.review, undefined);
  assert.equal(reviews, 0);
});

test("a reply that is not a verdict, or a reviewer that fails, is an incomplete review of a completed run", async () => {
  const vague = await run({ reviewer: planner("reviewer", async () => "Looks fine to me.") });
  assert.equal(vague.outcome, "completed");
  assert.equal(vague.review?.verdict, "incomplete");
  assert.match(vague.review?.reason ?? "", /did not end with a verdict/);

  const broken = await run({ reviewer: planner("reviewer", async () => { throw new Error("rate limited"); }) });
  assert.equal(broken.outcome, "completed");
  assert.deepEqual(broken.review, {
    verdict: "incomplete", findings: [], reason: "The review did not finish: rate limited", planner: "reviewer", model: "model-a",
  });
  assert.equal(broken.events.some((event) => event.type === "failure"), false);
  assert.deepEqual(completion(broken.events).verification, completion((await run({})).events).verification);
});

test("stopping during the review ends the review, not the work it was reviewing", async () => {
  let session: RunSession | undefined;
  let signal: AbortSignal | undefined;
  let late: Promise<McpToolOutcome> | undefined;
  const calls: Call[] = [];
  const { outcome, review } = await run({
    calls,
    onSession: (created) => { session = created; },
    reviewer: planner("reviewer", async (context) => {
      signal = context.signal;
      session?.cancel();
      late = context.call("get_script_source", { path: "Workspace.Door.Script" });
      await late;
      return PASS;
    }),
  });
  assert.equal(outcome, "completed");
  assert.equal(signal?.aborted, true);
  assert.equal(review?.verdict, "incomplete");
  assert.equal(review?.reason, "The review was stopped.");
  await assert.rejects(late!);
  assert.deepEqual(calls, [], "no call is made for a stopped review");
});

test("a review that runs past its time is stopped and recorded as incomplete", async () => {
  const { outcome, review } = await run({
    reviewTimeLimitMs: 10,
    reviewer: planner("reviewer", (context) => new Promise<string>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("Run was cancelled.")), { once: true });
    })),
  });
  assert.equal(outcome, "completed");
  assert.equal(review?.verdict, "incomplete");
  assert.equal(review?.reason, "The review ran out of time and was stopped.");
});

test("the reviewer is told what the user added and answered during the run", async () => {
  let packet = "";
  let session: RunSession | undefined;
  await run({
    onSession: (created) => { session = created; },
    worker: planner("worker", async (context) => {
      session?.steer("Make it slide, not swing");
      context.takeSteers();
      context.recordChange({ kind: "properties", target: "Workspace.Door", summary: "Slides open" });
      return "Done.";
    }),
    reviewer: planner("reviewer", async (context) => {
      packet = context.prompt;
      return PASS;
    }),
  });
  assert.match(packet, /Notes the user added while the run worked\n- Make it slide, not swing/);
});

/**
 * The same path a Custom-provider review takes in the app: Roqer's own agent
 * loop as the reviewer, with the shipped reviewing brief, driven through the
 * engine. Only the model endpoint is scripted.
 */
test("the agent loop reviews through the engine: its brief, the packet, a read, a refused write, a verdict", async () => {
  const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../agent");
  const runtime = await loadAgentRuntime(agentRoot);
  const studio = (id: string, operation: string, args: Record<string, unknown>): TurnEvent => ({
    kind: "tool-call", call: { id, name: "roblox_studio", arguments: { operation, arguments: args } },
  });
  const turns: TurnEvent[][] = [
    [
      studio("call_1", "get_instance_properties", { instancePath: "Workspace.Door" }),
      { kind: "completed", stopReason: "tool-use", usage: { inputTokens: 500, outputTokens: 20 } },
    ],
    [
      studio("call_2", "set_properties", { instancePath: "Workspace.Door", properties: { CanCollide: true } }),
      { kind: "completed", stopReason: "tool-use", usage: { inputTokens: 600, outputTokens: 20 } },
    ],
    [
      { kind: "delta", text: verdict({ verdict: "issues", findings: [{ severity: "medium", target: "Workspace.Door", detail: "CanCollide is false, so players walk through it." }] }) },
      { kind: "completed", stopReason: "end", usage: { inputTokens: 700, outputTokens: 60 } },
    ],
  ];
  const requests: TurnRequest[] = [];
  const transport: TurnTransport = {
    async *streamTurn(request) {
      requests.push(JSON.parse(JSON.stringify(request)) as TurnRequest);
      yield* turns[requests.length - 1];
    },
  };
  const calls: Call[] = [];
  const { events, outcome, review } = await run({
    calls,
    reviewer: createAgentLoopPlanner({
      transport,
      runId: "run-1:review",
      modelId: "model-a",
      effort: "medium",
      agent: runtime.reviewer,
      skillLibrary: runtime.skillLibrary,
      plannerId: "custom-endpoint",
    }),
  });

  assert.equal(outcome, "completed");
  assert.equal(requests.length, 3);
  // The reviewer starts from the reviewing brief and the host's packet, with no conversation of the worker's.
  assert.match(requests[0].instructions.developer ?? "", /^# Reviewing a finished run/);
  assert.equal(requests[0].messages.length, 1);
  const first = requests[0].messages[0].content.map((part) => part.kind === "text" ? part.text : "").join("");
  assert.match(first, /Roqer review packet\./);
  assert.match(first, /properties Workspace\.Door: Set CanCollide to false/);
  // The read reached Studio; the write was refused by the engine and the model was told.
  assert.deepEqual(calls.map((call) => call.tool), ["get_instance_properties"]);
  const refusal = JSON.stringify(requests[2].messages.at(-1));
  assert.match(refusal, /Read only mode blocks every change/);
  // The worker's reply is the run's reply; the reviewer's words became the verdict only.
  const said = events.filter((event) => event.type === "message-delta").map((event) => event.type === "message-delta" ? event.text : "").join("");
  assert.equal(said, "The door opens now.");
  assert.equal(review?.verdict, "issues");
  assert.equal(review?.planner, "custom-endpoint");
  assert.deepEqual(review?.findings, [{ severity: "medium", target: "Workspace.Door", detail: "CanCollide is false, so players walk through it." }]);
  assert.equal(review?.usage?.outputTokens, 100);
  assert.equal(completion(events).usage, undefined, "the review's tokens are not counted as the run's");
});
