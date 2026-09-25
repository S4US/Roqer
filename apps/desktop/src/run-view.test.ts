import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCompletion, type CompletionVerification } from "../shared/completion";
import type { RunTask } from "../shared/tasks";
import type {
  RunChange, RunEvent, RunEventBody, RunEvidence, RunOutcome, ToolProposal,
} from "../shared/run-events";
import {
  activitySteps, applyRunEvent, createRunView, describeActivityState, describeOutcome,
  recordAppliedAndVerified, recordGateIssues, recordHasWarnings, recordOnlyAnswered, recordSteps,
  runAppliedAndVerified, runGateIssues, runHasWarnings, runOnlyAnswered, toRunRecord,
  type RunView,
} from "./run-view";

const RUN_ID = "run-1";

function proposal(callId: string, tool = "get_place_info"): ToolProposal {
  return { callId, tool, arguments: {}, summary: `${tool} · sample`, risk: "read" };
}

/**
 * A `run-completed` body whose gate verdict the test does not care about.
 *
 * Most tests here are about folding, not about verification, so `stream` fills
 * the verdict in from the events that came before it — the same inputs the
 * engine would have used. A test that is about the gate passes its own.
 */
type CompletedBody = {
  type: "run-completed";
  outcome: RunOutcome;
  summary: string;
  verification?: CompletionVerification;
};

type TestEventBody = Exclude<RunEventBody, { type: "run-completed" }> | CompletedBody;

/** Numbers the events so a test declares intent, not bookkeeping. */
function stream(...bodies: TestEventBody[]): RunEvent[] {
  const changes: RunChange[] = [];
  const evidence: RunEvidence[] = [];
  let tasks: readonly RunTask[] = [];
  let failureCount = 0;

  return bodies.map((body, index) => {
    if (body.type === "change") changes.push(body.change);
    if (body.type === "evidence") evidence.push(body.evidence);
    if (body.type === "tasks") tasks = body.tasks;
    if (body.type === "failure") failureCount += 1;

    const filled = body.type === "run-completed" && body.verification === undefined
      ? {
        ...body,
        verification: evaluateCompletion({
          outcome: body.outcome, tasks, changes, evidence, failureCount,
        }),
      }
      : body;

    return {
      ...filled,
      runId: RUN_ID,
      seq: index + 1,
      at: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    } as RunEvent;
  });
}

function fold(events: RunEvent[], view = createRunView(RUN_ID, "Inspect this project", "Ask first")): RunView {
  return events.reduce(applyRunEvent, view);
}

const started: RunEventBody = {
  type: "run-started",
  prompt: "Inspect this project",
  approvalMode: "Ask first",
  autoPlaytest: false,
  endpoint: "http://127.0.0.1:58741",
  instanceId: null,
  model: null,
  effort: "medium",
  planner: "inspection",
};

/**
 * The completion card is a receipt for work. A greeting is not work, and
 * "Completed · 0 tool calls" under a one-line answer makes a conversation look
 * like a build.
 */
test("a run that only answered carries no completion card, live or recorded", () => {
  const answered = fold(stream(
    started,
    { type: "message-delta", text: "Hi! What are we building?" },
    { type: "run-completed", outcome: "completed", summary: "Answered." },
  ));

  assert.equal(runOnlyAnswered(answered), true);
  const record = toRunRecord(answered);
  assert.ok(record);
  assert.equal(recordOnlyAnswered(record, answered.text), true);
});

test("the completion card stays for anything the reply alone does not show", () => {
  const withWork = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1") },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_place_info" },
    { type: "tool-result", callId: "c1", tool: "get_place_info", ok: true, durationMs: 4, summary: "1 place" },
    { type: "message-delta", text: "Coffee Run." },
    { type: "run-completed", outcome: "completed", summary: "Inspected." },
  ));
  assert.equal(runOnlyAnswered(withWork), false, "a run that called a tool has something to report");

  const refused = fold(stream(
    started,
    { type: "message-delta", text: "Read only mode blocks that." },
    { type: "run-completed", outcome: "refused", summary: "Refused." },
  ));
  assert.equal(runOnlyAnswered(refused), false, "an ending other than a clean completion is reported");

  const silent = fold(stream(
    started,
    { type: "run-completed", outcome: "completed", summary: "Nothing to do." },
  ));
  assert.equal(runOnlyAnswered(silent), false, "a run with no answer would otherwise show nothing");
});

test("a completed read-only run folds into activities, evidence, and an outcome", () => {
  const view = fold(stream(
    started,
    { type: "status", label: "Checking the connected place" },
    { type: "tool-proposed", proposal: proposal("c1") },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_place_info" },
    { type: "tool-result", callId: "c1", tool: "get_place_info", ok: true, durationMs: 42, summary: "1 place" },
    { type: "evidence", evidence: { id: "e1", kind: "inspection", title: "Coffee Run", lines: ["Script: game.X"] } },
    { type: "message-delta", text: "I inspected " },
    { type: "message-delta", text: "Coffee Run." },
    { type: "run-completed", outcome: "completed", summary: "Inspected Coffee Run." },
  ));

  assert.equal(view.planner, "inspection");
  assert.equal(view.desynchronized, false);
  assert.equal(view.text, "I inspected Coffee Run.");
  assert.equal(view.status, null, "a finished run shows no progress line");
  assert.equal(view.outcome, "completed");
  assert.deepEqual(view.activities, [{
    callId: "c1",
    tool: "get_place_info",
    summary: "get_place_info · sample",
    risk: "read",
    state: "done",
    durationMs: 42,
    resultSummary: "1 place",
    detail: undefined,
  }]);
  assert.equal(view.evidence.length, 1);
});

test("an approval is pending until it is resolved", () => {
  const events = stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1", "set_script_source") },
    { type: "approval-requested", callId: "c1", proposal: proposal("c1", "set_script_source"), reason: "mutation-requires-approval" },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: false, reason: "mutation-requires-approval" },
  );

  const waiting = fold(events.slice(0, 3));
  assert.equal(waiting.pendingApproval?.callId, "c1");
  assert.equal(waiting.activities[0].state, "awaiting-approval");

  assert.equal(fold(events).pendingApproval, null);
});

test("resolving a different call leaves the pending approval alone", () => {
  const waiting = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1", "set_script_source") },
    { type: "approval-requested", callId: "c1", proposal: proposal("c1", "set_script_source"), reason: "mutation-requires-approval" },
    { type: "approval-resolved", callId: "other", decision: "approved", automatic: true, reason: "read-allowed" },
  ));
  assert.equal(waiting.pendingApproval?.callId, "c1");
});

test("a denied call is marked rejected and never starts", () => {
  const view = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1", "set_script_source") },
    { type: "approval-resolved", callId: "c1", decision: "rejected", automatic: true, reason: "read-only-mode" },
    { type: "run-completed", outcome: "refused", summary: "Read only mode blocked the change." },
  ));
  assert.equal(view.activities[0].state, "rejected");
  assert.equal(view.activities[0].durationMs, undefined);
  assert.equal(view.outcome, "refused");
});

test("a failed tool call is recorded without ending the run", () => {
  const view = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1") },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_place_info" },
    { type: "tool-result", callId: "c1", tool: "get_place_info", ok: false, durationMs: 7, summary: "request_failed" },
    { type: "failure", failure: { code: "request_failed", message: "MCP is not running", retryable: true } },
  ));
  assert.equal(view.activities[0].state, "failed");
  assert.equal(view.failures.length, 1);
  assert.equal(view.outcome, null);
});

test("events from another run are ignored", () => {
  const view = createRunView(RUN_ID, "Inspect", "Ask first");
  const foreign = { ...started, runId: "run-2", seq: 1, at: new Date().toISOString() } as RunEvent;
  assert.equal(applyRunEvent(view, foreign), view);
});

test("a sequence gap marks the view desynchronized but still applies", () => {
  const view = createRunView(RUN_ID, "Inspect", "Ask first");
  const skipped = { ...started, runId: RUN_ID, seq: 3, at: new Date().toISOString() } as RunEvent;
  const next = applyRunEvent(view, skipped);
  assert.equal(next.desynchronized, true);
  assert.equal(next.planner, "inspection");
  assert.equal(next.lastSeq, 3);
});

test("a pending approval cannot survive completion", () => {
  const view = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1", "set_script_source") },
    { type: "approval-requested", callId: "c1", proposal: proposal("c1", "set_script_source"), reason: "mutation-requires-approval" },
    { type: "run-completed", outcome: "cancelled", summary: "Stopped." },
  ));
  assert.equal(view.pendingApproval, null);
});

test("toRunRecord compacts only a finished run", () => {
  const running = fold(stream(started, { type: "tool-proposed", proposal: proposal("c1") }));
  assert.equal(toRunRecord(running), null);

  const finished = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1") },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_place_info" },
    { type: "tool-result", callId: "c1", tool: "get_place_info", ok: true, durationMs: 12, summary: "1 place" },
    // Proposed but never resolved, so it is not a call that happened.
    { type: "tool-proposed", proposal: proposal("c2") },
    { type: "run-completed", outcome: "completed", summary: "done" },
  ));
  const record = toRunRecord(finished);
  assert.ok(record);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.planner, "inspection");
  // The target travels with the call so history can label it the way the live
  // run did, instead of falling back to the operation name.
  assert.deepEqual(record.toolCalls, [
    { tool: "get_place_info", ok: true, durationMs: 12, summary: "1 place", target: "sample" },
  ]);
  assert.equal(record.startedAt, finished.startedAt);
  assert.equal(record.finishedAt, finished.finishedAt);
});

test("a completed Roblox upload keeps its asset result in history", () => {
  const asset: RunChange = {
    id: "asset-1",
    kind: "asset",
    target: "rbxassetid://123456",
    summary: "Uploaded “Village Gate” to Roblox as asset 123456. Moderation: Approved.",
    assetId: "123456",
    assetUrl: "https://create.roblox.com/store/asset/123456",
    assetType: "Model",
    moderationState: "Approved",
    operationId: "upload-456",
  };
  const view = fold(stream(
    started,
    { type: "change", change: asset },
    { type: "run-completed", outcome: "completed", summary: "Uploaded Village Gate." },
  ));

  assert.deepEqual(view.changes, [asset]);
  assert.deepEqual(toRunRecord(view)?.changes, [asset]);
});

test("a note the user added mid-run is a timeline entry at the moment it was said", () => {
  const view = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1") },
    { type: "steer", text: "Also make it blue." },
    { type: "run-completed", outcome: "completed", summary: "done" },
  ));
  const notes = view.timeline.filter((entry) => entry.type === "note");
  assert.deepEqual(notes, [{ type: "note", key: "note-3", label: "You added a note", detail: "Also make it blue." }]);
  // Between the proposal and the end, where it happened.
  assert.deepEqual(view.timeline.map((entry) => entry.type), ["tool", "note"]);
});

test("an answered question is kept as a decision; an unanswered one is not", () => {
  // The answer used to live only in the timeline note and a tool result inside
  // the run. A follow-up needs it on the record, or it asks again.
  const question = { callId: "q1", question: "Which currency should the shop charge?", options: ["Coins", "Gems"] };
  const view = fold(stream(
    started,
    { type: "question-asked", question },
    { type: "question-answered", callId: "q1", answerIndex: 1, answer: "Gems", cancelled: false },
    { type: "question-asked", question: { ...question, callId: "q2", question: "Show prices with tax?" } },
    { type: "question-answered", callId: "q2", answerIndex: -1, answer: "", cancelled: true },
    { type: "run-completed", outcome: "cancelled", summary: "Run was cancelled." },
  ));
  assert.deepEqual(view.decisions, [{ question: "Which currency should the shop charge?", answer: "Gems" }]);
  const record = toRunRecord(view);
  assert.ok(record);
  assert.deepEqual(record.decisions, view.decisions);

  // No questions, no field: records from before decisions existed look the same.
  const plain = toRunRecord(fold(stream(started, { type: "run-completed", outcome: "completed", summary: "done" })));
  assert.equal(plain?.decisions, undefined);
});

test("every outcome has a label", () => {
  for (const outcome of ["completed", "cancelled", "failed", "refused"] as const) {
    assert.ok(describeOutcome(outcome).length > 0);
  }
  assert.equal(describeOutcome("completed"), "Completed");
  assert.equal(describeOutcome("completed", true), "Completed with warnings");
  // Only a completed run can be qualified; the rest already say what happened.
  assert.equal(describeOutcome("failed", true), "Failed");
});

test("a completed run whose tool call failed is a warning, not a clean pass", () => {
  const events = stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1") },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_place_info" },
    { type: "tool-result", callId: "c1", tool: "get_place_info", ok: false, durationMs: 7, summary: "request_failed" },
    { type: "failure", failure: { code: "request_failed", message: "MCP is not running", retryable: true } },
    { type: "run-completed", outcome: "completed", summary: "Answered from the structure I already had." },
  );

  const view = fold(events);
  assert.equal(view.outcome, "completed");
  assert.equal(runHasWarnings(view), true);

  const record = toRunRecord(view);
  assert.ok(record);
  assert.equal(recordHasWarnings(record), true);
});

test("a clean completed run carries no warning, and an unfinished one none either", () => {
  const clean = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1") },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_place_info" },
    { type: "tool-result", callId: "c1", tool: "get_place_info", ok: true, durationMs: 12, summary: "1 place" },
    { type: "run-completed", outcome: "completed", summary: "done" },
  ));
  assert.equal(runHasWarnings(clean), false);

  const running = fold(stream(started, { type: "tool-proposed", proposal: proposal("c1") }));
  assert.equal(runHasWarnings(running), false);
});

test("the activity layer keeps notes, calls, and evidence in the order they happened", () => {
  const view = fold(stream(
    started,
    { type: "status", label: "Connecting to ChatGPT" },
    { type: "tool-proposed", proposal: proposal("c1", "get_project_structure") },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_project_structure" },
    { type: "tool-result", callId: "c1", tool: "get_project_structure", ok: true, durationMs: 30, summary: "3 services" },
    { type: "evidence", evidence: { id: "e1", kind: "inspection", title: "Coffee Run" } },
    { type: "tool-proposed", proposal: proposal("c2", "get_script_source") },
    { type: "approval-resolved", callId: "c2", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c2", tool: "get_script_source" },
    { type: "tool-result", callId: "c2", tool: "get_script_source", ok: true, durationMs: 12, summary: "2 lines of source" },
  ));

  // Evidence between two calls has to stay between them; that interleaving
  // cannot be reconstructed from the separate lists after the fact.
  assert.deepEqual(activitySteps(view).map((step) => [step.kind, step.label]), [
    ["note", "Connecting to ChatGPT"],
    ["read", "Read sample"],
    ["inspect", "Inspected Coffee Run"],
    ["read", "Read sample"],
  ]);
});

test("a step reads as a verb and a subject, never as an operation name", () => {
  const view = fold(stream(
    started,
    { type: "tool-proposed", proposal: {
      callId: "c1", tool: "get_script_source", arguments: {},
      summary: "get_script_source · game.ServerScriptService.Main", risk: "read",
    } },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_script_source" },
  ));

  const [step] = activitySteps(view);
  assert.equal(step.kind, "read");
  assert.equal(step.state, "running");
  // Present tense while it is still happening.
  assert.equal(step.label, "Reading ServerScriptService.Main");
  assert.equal(step.note, "Working");
  // The operation and the full path travel with the step, so grouping can
  // rephrase the row and the details can still show exactly what was called.
  assert.equal(step.tool, "get_script_source");
  assert.equal(step.target, "game.ServerScriptService.Main");

  const done = fold(stream({
    type: "tool-result", callId: "c1", tool: "get_script_source",
    ok: true, durationMs: 9, summary: "2 lines of source",
  }), view);
  assert.equal(activitySteps(done)[0].label, "Read ServerScriptService.Main");
  assert.equal(activitySteps(done)[0].note, "2 lines of source");
  assert.equal(activitySteps(done)[0].resultSummary, "2 lines of source");
});

test("evidence becomes a step that carries its payload for disclosure", () => {
  const evidence = {
    id: "e1" as const,
    kind: "verification" as const,
    title: "game.ServerScriptService.Main",
    passed: false,
    lines: ["print(1)"],
    metadata: [{ label: "Source revision", value: "rev-abc" }],
  };
  const view = fold(stream(started, { type: "evidence", evidence }));

  const [step] = activitySteps(view);
  assert.equal(step.kind, "verify");
  assert.equal(step.state, "failed");
  assert.equal(step.label, "Verified ServerScriptService.Main");
  assert.equal(step.note, "Failed");
  // The revision travels with the step so it can be disclosed, never inlined.
  assert.deepEqual(step.evidence, evidence);
});

test("the plan does not narrate itself into the activity layer", () => {
  const task = (id: string, status: RunTask["status"]): RunTask =>
    ({ id, title: `Task ${id}`, status, requiresRuntimeEvidence: false });
  const view = fold(stream(
    started,
    { type: "tasks", tasks: [task("a", "active"), task("b", "pending")] },
    { type: "tasks", tasks: [task("a", "done"), task("b", "active")] },
  ));

  // Plan is goals and activity is execution. A "2 of 5 done" line in both says
  // it twice, and on a long run it says it once per task that moves.
  assert.equal(view.tasks.length, 2);
  assert.deepEqual(activitySteps(view), []);
});

test("a step whose target went missing is dropped, not rendered blank", () => {
  const view = fold(stream(started, { type: "tool-proposed", proposal: proposal("c1") }));
  const orphaned: RunView = { ...view, activities: [] };
  assert.deepEqual(activitySteps(orphaned), []);
});

test("history rebuilds the same steps a live run showed", () => {
  const view = fold(stream(
    started,
    { type: "tool-proposed", proposal: {
      callId: "c1", tool: "get_script_source", arguments: {},
      summary: "get_script_source · game.ServerScriptService.Main", risk: "read",
    } },
    { type: "approval-resolved", callId: "c1", decision: "approved", automatic: true, reason: "read-allowed" },
    { type: "tool-started", callId: "c1", tool: "get_script_source" },
    { type: "tool-result", callId: "c1", tool: "get_script_source", ok: true, durationMs: 9, summary: "2 lines of source" },
    { type: "evidence", evidence: { id: "e1", kind: "verification", title: "game.ServerScriptService.Main", passed: true } },
    { type: "run-completed", outcome: "completed", summary: "done" },
  ));

  const record = toRunRecord(view);
  assert.ok(record);
  assert.deepEqual(recordSteps(record).map((step) => step.label), [
    "Read ServerScriptService.Main",
    "Verified ServerScriptService.Main",
  ]);
});

test("every activity state has a label", () => {
  for (const state of ["proposed", "awaiting-approval", "rejected", "running", "done", "failed"] as const) {
    assert.ok(describeActivityState(state).length > 0);
  }
});

test("a rejected call is a policy decision, not a warning on the result", () => {
  const view = fold(stream(
    started,
    { type: "tool-proposed", proposal: proposal("c1", "set_script_source") },
    { type: "approval-resolved", callId: "c1", decision: "rejected", automatic: false, reason: "mutation-requires-approval" },
    { type: "run-completed", outcome: "completed", summary: "Reported what I found instead." },
  ));
  assert.equal(runHasWarnings(view), false);
});

test("an edited script uses the compact success state only after matching verification", () => {
  const view = fold(stream(
    started,
    { type: "change", change: {
      id: "change-1", kind: "script-source", target: "game.ServerScriptService.Main",
      summary: "Updated source", diff: "-old\n+new", language: "lua",
    } },
    { type: "evidence", evidence: {
      id: "evidence-1", kind: "verification", title: "game.ServerScriptService.Main", passed: true,
    } },
    { type: "run-completed", outcome: "completed", summary: "Updated Main." },
  ));

  assert.equal(runAppliedAndVerified(view), true);
  const record = toRunRecord(view);
  assert.ok(record);
  assert.equal(recordAppliedAndVerified(record), true);

  // The verdict now travels with `run-completed`, so these are separate runs
  // rather than a folded view with its evidence taken back out: mutating the
  // view no longer models anything the engine could actually produce.
  const scriptChange: RunChange = {
    id: "change-1", kind: "script-source", target: "game.ServerScriptService.Main",
    summary: "Updated source", diff: "-old\n+new", language: "lua",
  };

  const withoutEvidence = fold(stream(
    started,
    { type: "change", change: scriptChange },
    { type: "run-completed", outcome: "completed", summary: "Updated Main." },
  ));
  assert.equal(runAppliedAndVerified(withoutEvidence), false, "a write with no read-back is not verified");

  const withFailure = fold(stream(
    started,
    { type: "change", change: scriptChange },
    { type: "evidence", evidence: {
      id: "evidence-1", kind: "verification", title: "game.ServerScriptService.Main", passed: true,
    } },
    { type: "failure", failure: { code: "readback", message: "failed", retryable: false } },
    { type: "run-completed", outcome: "completed", summary: "Updated Main." },
  ));
  assert.equal(
    runAppliedAndVerified(withFailure),
    true,
    "the failure stays visible, but a verified final state is still compactable",
  );
});

test("the renderer shows the host's verdict rather than recomputing one", () => {
  // The engine is the only thing that sees every change, every piece of
  // evidence, and every failure. When it says a run is not verified, the
  // renderer says so too, even if the events it happened to receive look clean.
  const view = fold(stream(
    started,
    { type: "change", change: {
      id: "change-1", kind: "script-source", target: "game.ServerScriptService.Main",
      summary: "Updated source",
    } },
    { type: "evidence", evidence: {
      id: "evidence-1", kind: "verification", title: "game.ServerScriptService.Main", passed: true,
    } },
    {
      type: "run-completed",
      outcome: "completed",
      summary: "Updated Main.",
      verification: {
        verified: false,
        issues: [{ code: "missing-runtime-evidence", detail: "\"Playtest the door\" collected none." }],
      },
    },
  ));

  assert.equal(runAppliedAndVerified(view), false);
  assert.deepEqual(runGateIssues(view), ["\"Playtest the door\" collected none."]);

  const record = toRunRecord(view);
  assert.ok(record);
  assert.equal(recordAppliedAndVerified(record), false, "and the verdict survives into history");
  assert.deepEqual(recordGateIssues(record), ["\"Playtest the door\" collected none."]);
});

test("verification is tied to the revision of each write and failed evidence survives history", () => {
  const view = fold(stream(
    started,
    { type: "change", change: {
      id: "change-1", kind: "script-source", target: "game.ServerScriptService.Main",
      summary: "Updated source", revisionAfter: "r2",
    } },
    { type: "evidence", evidence: {
      id: "evidence-1", kind: "verification", title: "game.ServerScriptService.Main", passed: true,
      metadata: [{ label: "Revision after write", value: "r1" }],
    } },
    { type: "run-completed", outcome: "completed", summary: "Updated Main." },
  ));

  assert.equal(runAppliedAndVerified(view), false, "evidence for an older write must not verify a newer one");

  const revisionedChange: RunChange = {
    id: "change-1", kind: "script-source", target: "game.ServerScriptService.Main",
    summary: "Updated source", revisionAfter: "r2",
  };
  const matching = fold(stream(
    started,
    { type: "change", change: revisionedChange },
    { type: "evidence", evidence: {
      id: "evidence-1", kind: "verification", title: "game.ServerScriptService.Main", passed: true,
      metadata: [{ label: "Revision after write", value: "r2" }],
    } },
    { type: "run-completed", outcome: "completed", summary: "Updated Main." },
  ));
  assert.equal(runAppliedAndVerified(matching), true);

  const failed = fold(stream(
    started,
    { type: "change", change: revisionedChange },
    { type: "evidence", evidence: {
      id: "evidence-1", kind: "verification", title: "game.ServerScriptService.Main", passed: false,
      metadata: [{ label: "Revision after write", value: "r2" }],
    } },
    { type: "run-completed", outcome: "completed", summary: "Updated Main." },
  ));
  assert.equal(runHasWarnings(failed), true);
  const record = toRunRecord(failed);
  assert.ok(record);
  assert.equal(recordHasWarnings(record), true);
});
