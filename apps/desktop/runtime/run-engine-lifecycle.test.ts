/**
 * Engine coverage for the task lifecycle, user questions, and the completion
 * gate — the three things a run now owns that a planner cannot fake.
 *
 * These live apart from `run-engine.test.ts` because they are about what the
 * session *decides*, not about the ordering guarantees that file exists to pin.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { McpToolCaller, McpToolOutcome } from "./mcp-types";
import { RunSession } from "./run-engine";
import type { Planner, PlannerContext } from "./run-engine";
import { MAX_QUESTIONS_PER_RUN, QUESTION_ESCAPE_OPTION } from "../shared/question";
import { runQuestionTool } from "./question-tool";
import { MAX_STEER_CHARS } from "../shared/steer";
import type { RunTask } from "../shared/tasks";
import { isRunEvent, type RunEvent, type RunRequest } from "../shared/run-events";

const REVISION_LABEL = "Revision after write";

function caller(): McpToolCaller {
  return {
    async callTool(): Promise<McpToolOutcome> {
      return { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 };
    },
  };
}

function planner(run: (context: PlannerContext) => Promise<string>): Planner {
  return { id: "lifecycle-test", run };
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run-1",
    projectId: "project-1",
    chatId: "chat-1",
    prompt: "test prompt",
    conversation: { messages: [], truncated: false },
    approvalMode: "Auto approve",
    autoPlaytest: false,
    endpoint: "http://127.0.0.1:1234",
    instanceId: null,
    provider: "chatgpt",
    model: null,
    effort: "medium",
    ...overrides,
  };
}

function task(overrides: Partial<RunTask> = {}): RunTask {
  return { id: "t1", title: "Fix the door", status: "done", requiresRuntimeEvidence: false, ...overrides };
}

function completionOf(events: readonly RunEvent[]) {
  const event = events.find((candidate) => candidate.type === "run-completed");
  assert.ok(event && event.type === "run-completed", "the run must complete");
  return event;
}

function run(planLogic: (context: PlannerContext) => Promise<string>, overrides: Partial<RunRequest> = {}) {
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller: caller(),
    planner: planner(planLogic),
    request: request(overrides),
    emit: (event) => events.push(event),
  });
  return { session, events };
}

test("a task list is emitted as an event and every event stays valid", async () => {
  const { session, events } = run(async (context) => {
    context.setTasks([task({ id: "a", status: "active" })]);
    context.setTasks([task({ id: "a", status: "done" })]);
    return "done";
  });
  await session.execute();

  const taskEvents = events.filter((event) => event.type === "tasks");
  assert.equal(taskEvents.length, 2, "each update is its own event");
  for (const event of events) assert.ok(isRunEvent(event), JSON.stringify(event));
});

test("a persistence failure explains cancellation and prevents subsequent Studio calls", async () => {
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  let calls = 0;
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller: { async callTool() { calls += 1; return { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 0 }; } },
    request: request(),
    planner: planner(async (context) => { await paused; await context.call("get_place_info", {}); return "done"; }),
    emit: (event) => events.push(event),
  });
  const execution = session.execute();
  session.cancel("Run progress could not be saved.");
  resume();
  assert.equal(await execution, "cancelled");
  assert.equal(calls, 0);
  assert.ok(events.some((event) => event.type === "failure" && event.failure.code === "persistence-failed"));
  assert.equal(completionOf(events).verification.verified, false);
  assert.ok(events.every(isRunEvent));
});

test("the planner can read back the task list it set", async () => {
  let seen: readonly RunTask[] = [];
  const { session } = run(async (context) => {
    context.setTasks([task({ id: "a" }), task({ id: "b", status: "pending" })]);
    seen = context.tasks();
    return "done";
  });
  await session.execute();
  assert.deepEqual(seen.map((entry) => entry.id), ["a", "b"]);
});

test("a run with an unverified script write is not verified", async () => {
  const { session, events } = run(async (context) => {
    context.recordChange({
      kind: "script-source", target: "game.X", summary: "Wrote it", revisionAfter: "rev-2",
    });
    return "done";
  });
  await session.execute();

  const completion = completionOf(events);
  assert.equal(completion.outcome, "completed");
  assert.equal(completion.verification.verified, false);
  assert.equal(completion.verification.issues[0].code, "unverified-change");
});

test("a matching read-back makes the same run verified", async () => {
  const { session, events } = run(async (context) => {
    context.recordChange({
      kind: "script-source", target: "game.X", summary: "Wrote it", revisionAfter: "rev-2",
    });
    context.recordEvidence({
      kind: "verification",
      title: "game.X",
      passed: true,
      metadata: [{ label: REVISION_LABEL, value: "rev-2" }],
    });
    return "done";
  });
  await session.execute();
  assert.equal(completionOf(events).verification.verified, true);
});

test("a task that promised runtime evidence blocks a clean result", async () => {
  const { session, events } = run(async (context) => {
    context.setTasks([task({ requiresRuntimeEvidence: true })]);
    return "done";
  });
  await session.execute();

  const completion = completionOf(events);
  assert.equal(completion.verification.verified, false);
  assert.equal(completion.verification.issues[0].code, "missing-runtime-evidence");
});

test("checkCompletion warns the planner while it can still act", async () => {
  let mid: string[] = [];
  const { session, events } = run(async (context) => {
    context.setTasks([task({ status: "active", requiredEvidence: ["runtime"], requiresRuntimeEvidence: true })]);
    mid = context.checkCompletion().issues.map((issue) => issue.code);
    context.recordEvidence({
      kind: "logs", requirement: "runtime", title: "Door opens", passed: true,
    });
    context.setTasks([task({ status: "done", requiredEvidence: ["runtime"], requiresRuntimeEvidence: true })]);
    return "done";
  });
  await session.execute();

  assert.deepEqual(mid, ["task-incomplete"], "the gate is readable while the task is active");
  assert.equal(completionOf(events).verification.verified, true, "and acting on it clears the gate");
});

test("the host links evidence to the active task and its latest change", async () => {
  const { session, events } = run(async (context) => {
    context.setTasks([task({ status: "active", requiredEvidence: ["visual"], requiresRuntimeEvidence: true })]);
    context.recordChange({ kind: "properties", target: "game.Gui", summary: "Changed the UI" });
    context.recordEvidence({
      kind: "verification", changeKind: "properties", title: "game.Gui", passed: true,
    });
    context.recordEvidence({
      kind: "screenshot", requirement: "visual", title: "Shop", passed: true,
    });
    context.setTasks([task({ status: "done", requiredEvidence: ["visual"], requiresRuntimeEvidence: true })]);
    return "done";
  });
  await session.execute();

  const change = events.find((event) => event.type === "change");
  const screenshot = events.find((event) =>
    event.type === "evidence" && event.evidence.kind === "screenshot");
  assert.ok(change && change.type === "change");
  assert.ok(screenshot && screenshot.type === "evidence");
  assert.equal(change.change.taskId, "t1");
  assert.equal(screenshot.evidence.taskId, "t1");
  assert.equal(screenshot.evidence.afterChangeId, change.change.id);
  assert.equal(completionOf(events).verification.verified, true);
});

test("evidence from a task that changed nothing is stamped against the run", async () => {
  // The shape a real run produces: one task edits, a second only observes. The
  // observing task has no change of its own, so it used to be stamped with
  // nothing -- and the gate, applying the same rule, then asked for nothing.
  const editing = task({ id: "update", title: "Apply the change", status: "active" });
  const verifying = task({
    id: "verify", title: "Visually verify", status: "active",
    requiredEvidence: ["visual"], requiresRuntimeEvidence: true,
  });
  const { session, events } = run(async (context) => {
    context.setTasks([editing, { ...verifying, status: "pending" }]);
    context.recordChange({ kind: "properties", target: "game.Gui", summary: "Changed the UI" });
    context.recordEvidence({
      kind: "verification", changeKind: "properties", title: "game.Gui", passed: true,
    });
    context.setTasks([{ ...editing, status: "done" }, verifying]);
    context.recordEvidence({ kind: "screenshot", requirement: "visual", title: "Shop", passed: true });
    context.setTasks([{ ...editing, status: "done" }, { ...verifying, status: "done" }]);
    return "done";
  });
  await session.execute();

  const change = events.find((event) => event.type === "change");
  const screenshot = events.find((event) =>
    event.type === "evidence" && event.evidence.kind === "screenshot");
  assert.ok(change && change.type === "change");
  assert.ok(screenshot && screenshot.type === "evidence");
  assert.equal(screenshot.evidence.taskId, "verify");
  assert.equal(change.change.taskId, "update");
  // Stamped across the task boundary, so the gate has something to check.
  assert.equal(screenshot.evidence.afterChangeId, change.change.id);
  assert.equal(completionOf(events).verification.verified, true);
});

test("a cancelled run is never verified and raises no evidence complaints", async () => {
  const { session, events } = run(async (context) => {
    context.recordChange({ kind: "script-source", target: "game.X", summary: "Wrote it" });
    session.cancel();
    return "done";
  });
  await session.execute();

  const completion = completionOf(events);
  assert.equal(completion.outcome, "cancelled");
  assert.equal(completion.verification.verified, false);
  assert.deepEqual(completion.verification.issues, []);
});

test("a question suspends the run until the renderer answers by index", async () => {
  const events: RunEvent[] = [];
  let answer = "";
  let decisions: readonly { question: string; answer: string }[] = [];
  const session = new RunSession({
    caller: caller(),
    planner: planner(async (context) => {
      assert.deepEqual(context.decisions(), [], "nothing decided yet");
      answer = await context.askUser("Shop or inventory?", ["The shop", "The inventory"]);
      decisions = context.decisions();
      return "done";
    }),
    request: request(),
    emit: (event) => {
      events.push(event);
      if (event.type === "question-asked") {
        // Answering synchronously from the listener is the tightest race the
        // renderer can create; the deferred must already be registered.
        assert.equal(session.resolveQuestion(event.question.callId, 1), true);
      }
    },
  });
  await session.execute();

  assert.equal(answer, "The inventory", "the model's own option text comes back, chosen by index");
  // The decision is on the host's record from the moment it is made, so a
  // fold later in the run can carry it after the tool result is gone.
  assert.deepEqual(decisions, [{ question: "Shop or inventory?", answer: "The inventory" }]);
  const answered = events.find((event) => event.type === "question-answered");
  assert.ok(answered && answered.type === "question-answered");
  assert.equal(answered.answerIndex, 1);
  assert.equal(answered.cancelled, false);
  for (const event of events) assert.ok(isRunEvent(event), JSON.stringify(event));
});

test("a note is queued for the planner, recorded as an event, and refused once the run has ended", async () => {
  const events: RunEvent[] = [];
  let taken: string[] = [];
  let acceptedMidRun: boolean[] = [];
  const session = new RunSession({
    caller: caller(),
    planner: planner(async (context) => {
      assert.deepEqual(context.takeSteers(), [], "nothing queued yet");
      acceptedMidRun = [
        session.steer("  Also make it blue.  "),
        session.steer(""),
        session.steer("x".repeat(MAX_STEER_CHARS + 1)),
        session.steer("bad\u0000byte"),
        session.steer(42),
      ];
      taken = context.takeSteers();
      assert.deepEqual(context.takeSteers(), [], "taking drains the queue");
      return "done";
    }),
    request: request(),
    emit: (event) => events.push(event),
  });
  await session.execute();

  assert.deepEqual(acceptedMidRun, [true, false, false, false, false]);
  assert.deepEqual(taken, ["Also make it blue."], "trimmed, and only the one that was valid");
  const steered = events.filter((event) => event.type === "steer");
  assert.equal(steered.length, 1);
  assert.equal(steered[0].type === "steer" && steered[0].text, "Also make it blue.");
  // After the run, the same words should go out as a new prompt instead.
  assert.equal(session.steer("Too late."), false);
  for (const event of events) assert.ok(isRunEvent(event), JSON.stringify(event));
});

test("an out-of-range or non-integer answer is refused and does not resume the run", async () => {
  const events: RunEvent[] = [];
  const rejected: boolean[] = [];
  const session = new RunSession({
    caller: caller(),
    planner: planner(async (context) => `answered ${await context.askUser("Which?", ["a", "b"])}`),
    request: request(),
    emit: (event) => {
      events.push(event);
      if (event.type === "question-asked") {
        const { callId } = event.question;
        // Two options: 0 and 1 are the model's, 2 is the host's escape, 3 is
        // nothing.
        rejected.push(session.resolveQuestion(callId, 3));
        rejected.push(session.resolveQuestion(callId, -1));
        rejected.push(session.resolveQuestion(callId, "1"));
        rejected.push(session.resolveQuestion("not-a-call", 0));
        assert.equal(session.resolveQuestion(callId, 0), true, "a real index still works");
      }
    },
  });
  await session.execute();

  assert.deepEqual(rejected, [false, false, false, false]);
});

test("the host's escape answers with its own text and points the model at the note", async () => {
  // The user chose none of the model's options and typed their answer instead.
  // The renderer queues the note first and answers second, so the turn the
  // model resumes into carries both: the result says to read the note, and
  // the note is in the same message.
  const events: RunEvent[] = [];
  let result = "";
  let taken: string[] = [];
  const session = new RunSession({
    caller: caller(),
    planner: planner(async (context) => {
      result = await runQuestionTool(context, { question: "Shop or inventory?", options: ["The shop", "The inventory"] });
      taken = context.takeSteers();
      return "done";
    }),
    request: request(),
    emit: (event) => {
      events.push(event);
      if (event.type === "question-asked") {
        assert.equal(session.steer("Neither — the trading post, it's a third thing."), true);
        assert.equal(session.resolveQuestion(event.question.callId, event.question.options.length), true);
      }
    },
  });
  await session.execute();

  assert.match(result, /chose none of the offered options/);
  assert.match(result, /follows in this message as a note/);
  assert.deepEqual(taken, ["Neither — the trading post, it's a third thing."]);
  const answered = events.find((event) => event.type === "question-answered");
  assert.ok(answered && answered.type === "question-answered");
  assert.equal(answered.answerIndex, 2);
  assert.equal(answered.answer, QUESTION_ESCAPE_OPTION, "the record shows the host's option, never renderer text");
  for (const event of events) assert.ok(isRunEvent(event), JSON.stringify(event));
});

test("cancelling a run records the unanswered question and ends it", async () => {
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller: caller(),
    planner: planner(async (context) => `answered ${await context.askUser("Which?", ["a", "b"])}`),
    request: request(),
    emit: (event) => {
      events.push(event);
      if (event.type === "question-asked") session.cancel();
    },
  });
  const outcome = await session.execute();

  assert.equal(outcome, "cancelled");
  const answered = events.find((event) => event.type === "question-answered");
  assert.ok(answered && answered.type === "question-answered");
  assert.equal(answered.cancelled, true);
});

test("a run may not interrogate the user past its budget", async () => {
  let error: unknown;
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller: caller(),
    planner: planner(async (context) => {
      try {
        for (let index = 0; index <= MAX_QUESTIONS_PER_RUN; index += 1) {
          await context.askUser(`Question ${index}?`, ["a", "b"]);
        }
      } catch (caught) {
        error = caught;
      }
      return "done";
    }),
    request: request(),
    emit: (event) => {
      events.push(event);
      if (event.type === "question-asked") session.resolveQuestion(event.question.callId, 0);
    },
  });
  await session.execute();

  assert.ok(error instanceof Error);
  assert.match(error.message, /budget of 2 user questions/);
  assert.equal(
    events.filter((event) => event.type === "question-asked").length,
    MAX_QUESTIONS_PER_RUN,
    "the over-budget question never reaches the user",
  );
});
