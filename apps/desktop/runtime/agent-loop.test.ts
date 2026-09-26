import assert from "node:assert/strict";
import test from "node:test";

import type { TurnEvent, TurnRequest } from "./model-api/turn-contract";
import {
  ContextOverflowError, isTurnRequest, MAX_TURN_IMAGE_BASE64, TransientTurnError, UnusableToolCallError,
} from "./model-api/turn-contract";

import type { AgentDefinition } from "./agent-definition";
import { buildConversationPrompt } from "./conversation-prompt";
import { COMPACTION_TRIGGER_MESSAGES } from "./agent-loop-history";
import {
  createAgentLoopPlanner,
  MALFORMED_CALL_RETRIES,
  REPEATED_CALL_TURNS,
  REPEATED_FAILURE_TURNS,
  type AgentLoopSession,
  type AgentLoopTelemetryEvent,
  type TurnTransport,
} from "./agent-loop";
import type { McpToolOutcome } from "./mcp-types";
import { ProviderSessionStore } from "./provider-sessions";
import { RunCancelledError, type PlannerContext } from "./run-engine";
import type { SkillLibrary } from "./skill-library";
import type { RunChange, RunEvidence } from "../shared/run-events";
import type { RunTask } from "../shared/tasks";

const AGENT: AgentDefinition = {
  id: "test-agent",
  version: "1",
  systemInstructions: "SYSTEM TEST INSTRUCTIONS",
  developerInstructions: "DEVELOPER TEST INSTRUCTIONS",
  skills: [{ name: "roblox-test", description: "Use for tests." }],
};
const SKILLS: SkillLibrary = {
  catalog: AGENT.skills,
  load: async (name, resource = "SKILL.md") => ({ name, resource, content: "# Test skill" }),
};

type Recorded = {
  calls: string[];
  said: string[];
  tasks: RunTask[][];
  changes: RunChange[];
  evidence: RunEvidence[];
  questions: Array<{ question: string; options: string[] }>;
  progress: string[];
  statuses: Array<{ label: string; detail?: string }>;
  /** Notes queued for the planner, drained by `takeSteers` the way the engine's are. */
  steers: string[];
};

function makeContext(controller: AbortController, outcome?: (tool: string) => McpToolOutcome) {
  const recorded: Recorded = {
    calls: [], said: [], tasks: [], changes: [], evidence: [], questions: [], progress: [], statuses: [], steers: [],
  };
  let currentTasks: RunTask[] = [];
  const context: PlannerContext = {
    prompt: "Read Main and tell me what it does",
    conversation: { messages: [], truncated: false },
    images: [],
    instanceId: "studio-1",
    autoPlaytest: true,
    signal: controller.signal,
    status: (label, detail) => recorded.statuses.push(detail === undefined ? { label } : { label, detail }),
    progress: (label) => recorded.progress.push(label),
    say: (text) => recorded.said.push(text),
    recordChange: (change) => {
      recorded.changes.push({ ...change, id: `change_${recorded.changes.length + 1}` });
    },
    recordEvidence: (item) => {
      recorded.evidence.push({ ...item, id: `evidence_${recorded.evidence.length + 1}` });
    },
    setTasks: (next) => {
      currentTasks = next;
      recorded.tasks.push(next);
    },
    tasks: () => currentTasks,
    changes: () => recorded.changes,
    evidence: () => recorded.evidence,
    decisions: () => recorded.questions.map(({ question, options }) => ({ question, answer: options[0] })),
    takeSteers: () => recorded.steers.splice(0),
    askUser: async (question, options) => {
      recorded.questions.push({ question, options });
      return options[0];
    },
    checkCompletion: () => ({ verified: true, issues: [] }),
    call: async (tool) => {
      recorded.calls.push(tool);
      return outcome?.(tool) ?? {
        ok: true,
        data: { source: "print('hi')", sourceRevision: "rev-1" },
        text: "",
        httpStatus: 200,
        durationMs: 1,
      };
    },
  };
  return { context, recorded };
}

/** A gateway that replays one scripted turn per request and records what it saw. */
function gateway(turns: readonly (readonly TurnEvent[])[]): TurnTransport & {
  requests: TurnRequest[];
} {
  const requests: TurnRequest[] = [];
  return {
    requests,
    async *streamTurn(request, signal) {
      // Structured-clone the request: the planner mutates its message list
      // between turns, so a stored reference would not show what was sent.
      requests.push(JSON.parse(JSON.stringify(request)) as TurnRequest);
      assert.equal(isTurnRequest(request), true, "the gateway must receive a valid turn");
      const scripted = turns[requests.length - 1];
      assert.ok(scripted, `no scripted turn ${requests.length}`);
      for (const event of scripted) {
        if (signal.aborted) return;
        yield event;
      }
    },
  };
}

function planner(
  gatewayImpl: TurnTransport,
  onTelemetry?: (event: AgentLoopTelemetryEvent) => void,
  stallMs?: number,
  skillLibrary: SkillLibrary = SKILLS,
) {
  return createAgentLoopPlanner({
    transport: gatewayImpl,
    runId: "run_test",
    modelId: "openai/gpt-5.6-luna",
    effort: "medium",
    agent: AGENT,
    skillLibrary,
    ...(onTelemetry === undefined ? {} : { onTelemetry }),
    ...(stallMs === undefined ? {} : { stallMs }),
  });
}

const DONE = (text: string): readonly TurnEvent[] => [
  { kind: "delta", text },
  { kind: "completed", stopReason: "end", usage: { inputTokens: 10, outputTokens: 2 } },
];

test("an answer cut off at the output limit is not passed off as a finished one", async () => {
  // The service catches the tool-call form of this, because arguments that stop
  // mid-JSON do not parse. Prose that stops mid-sentence produces no error at
  // all, so without reading the stop reason a truncated answer arrived as the
  // run's result with nothing to distinguish it from a complete one.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = gateway([[
    { kind: "delta", text: "Main prints a greeting and then" },
    { kind: "completed", stopReason: "max-output", usage: { inputTokens: 10, outputTokens: 2 } },
  ]]);

  const answer = await planner(bridge).run(context);
  assert.match(answer, /^Main prints a greeting and then/);
  assert.match(answer, /reached its output limit/);
  // Said in the reply, where the person who asked will read it, and recorded in
  // the timeline, where it is countable across runs.
  assert.deepEqual(recorded.statuses.map((status) => status.label), ["Turn ended early"]);
});

test("a refusal is reported as one rather than returned as an empty answer", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = gateway([[{ kind: "completed", stopReason: "refusal" }]]);

  assert.match(await planner(bridge).run(context), /declined to answer/);
  assert.deepEqual(recorded.statuses.map((status) => status.label), ["Turn ended early"]);
});

test("a turn cut off while still calling tools continues, and says so", async () => {
  // Survivable, because the next turn carries the tool results and the model can
  // pick up where it stopped. Worth recording all the same: a run that keeps
  // hitting the limit is one whose steps are too large.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = gateway([
    [
      {
        kind: "tool-call",
        call: { id: "call_1", name: "roblox_studio", arguments: { operation: "get_file_content", args: { path: "Main" } } },
      },
      { kind: "completed", stopReason: "max-output" },
    ],
    DONE("Main prints a greeting."),
  ]);

  assert.equal(await planner(bridge).run(context), "Main prints a greeting.");
  assert.deepEqual(recorded.statuses.map((status) => status.label), ["Turn reached its output limit"]);
});

test("a turn with no tool call returns the streamed prose as the answer", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = gateway([DONE("Main prints a greeting.")]);

  assert.equal(await planner(bridge).run(context), "Main prints a greeting.");
  assert.deepEqual(recorded.said, ["Main prints a greeting."]);
  assert.deepEqual(recorded.calls, []);

  const sent = bridge.requests[0];
  assert.equal(sent.runId, "run_test");
  assert.equal(sent.turnId, "run_test:turn:1");
  assert.equal(sent.modelId, "openai/gpt-5.6-luna");
  assert.equal(sent.reasoningEffort, "medium");
  assert.equal(sent.instructions.system, "SYSTEM TEST INSTRUCTIONS");
  // Run settings reach the model as trusted developer instructions, not as
  // transcript text the renderer could have written.
  assert.match(sent.instructions.developer ?? "", /DEVELOPER TEST INSTRUCTIONS/);
  assert.match(sent.instructions.developer ?? "", /Automatic playtesting is enabled/);
  assert.deepEqual(sent.tools.map((tool) => tool.name), [
    "roblox_studio", "load_skill", "resolve_icon", "update_task_list", "ask_user",
  ]);
  assert.deepEqual(sent.messages, [{
    role: "user",
    content: [{ kind: "text", text: "Read Main and tell me what it does" }],
  }]);
});

test("the loop stays on the client: a tool call is executed here and fed back", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = gateway([
    [
      { kind: "delta", text: "Reading the script." },
      {
        kind: "tool-call",
        call: {
          id: "call_1",
          name: "roblox_studio",
          arguments: {
            operation: "get_script_source",
            arguments: { instancePath: "ServerScriptService.Main" },
          },
        },
      },
      { kind: "completed", stopReason: "tool-use", usage: { inputTokens: 10, outputTokens: 4 } },
    ],
    DONE("It prints a greeting."),
  ]);

  const answer = await planner(bridge).run(context);
  assert.equal(answer, "Reading the script.\n\nIt prints a greeting.");
  // The Studio call went through the engine's own context, not the service.
  assert.deepEqual(recorded.calls, ["get_script_source"]);

  const second = bridge.requests[1];
  assert.equal(second.runId, "run_test");
  assert.equal(second.turnId, "run_test:turn:2");
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.messages[1], {
    role: "assistant",
    content: [
      { kind: "text", text: "Reading the script." },
      {
        kind: "tool-call",
        call: {
          id: "call_1",
          name: "roblox_studio",
          arguments: {
            operation: "get_script_source",
            arguments: { instancePath: "ServerScriptService.Main" },
          },
        },
      },
    ],
  });
  const result = second.messages[2];
  assert.equal(result.role, "user");
  assert.equal(result.content[0].kind, "tool-result");
  if (result.content[0].kind !== "tool-result") return;
  assert.equal(result.content[0].callId, "call_1");
  assert.equal(result.content[0].failed, false);
});

test("numeric telemetry measures hosted turns and tools without exposing their content", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const bridge = gateway([
    [
      {
        kind: "tool-call",
        call: {
          id: "call_telemetry",
          name: "roblox_studio",
          arguments: {
            operation: "get_script_source",
            arguments: { instancePath: "ServerScriptService.SecretName" },
          },
        },
      },
      { kind: "completed", stopReason: "tool-use", usage: { inputTokens: 20, outputTokens: 5 } },
    ],
    DONE("Finished."),
  ]);

  const telemetry: AgentLoopTelemetryEvent[] = [];
  assert.equal(await planner(bridge, (event) => telemetry.push(event)).run(context), "Finished.");

  const turns = telemetry.filter((event) => event.kind === "turn");
  const tools = telemetry.filter((event) => event.kind === "tool");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].kind === "turn" && turns[0].usage?.inputTokens, 20);
  assert.equal(turns.every((event) => event.kind !== "turn" || event.requestCharacters > 0), true);
  assert.deepEqual(tools.map((event) => event.kind === "tool" ? event.tool : ""), ["get_script_source"]);
  assert.equal(tools[0].kind === "tool" && tools[0].resultCharacters > 0, true);
  assert.equal(JSON.stringify(telemetry).includes("SecretName"), false, "arguments stay out of telemetry");
});

test("consecutive Studio reads overlap while mutations remain ordered barriers", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const timeline: string[] = [];
  let active = 0;
  let peakActive = 0;
  context.call = async (tool) => {
    timeline.push(`start:${tool}`);
    active += 1;
    peakActive = Math.max(peakActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    timeline.push(`end:${tool}`);
    return {
      ok: true,
      data: { source: "print('ok')", sourceRevision: "rev-1" },
      text: tool,
      httpStatus: 200,
      durationMs: 5,
    };
  };
  const studio = (id: string, operation: string, args: Record<string, unknown> = {}): TurnEvent => ({
    kind: "tool-call",
    call: { id, name: "roblox_studio", arguments: { operation, arguments: args } },
  });
  const bridge = gateway([
    [
      studio("read_1", "get_script_source", { instancePath: "game.ServerScriptService.A" }),
      studio("read_2", "get_script_source", { instancePath: "game.ServerScriptService.B" }),
      studio("write_1", "set_properties", {
        instancePath: "game.Workspace.Part",
        properties: { Anchored: true },
      }),
      studio("read_3", "get_instance_properties", { instancePath: "game.Workspace.Part" }),
      studio("read_4", "search_objects", { query: "Part" }),
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("Finished."),
  ]);

  assert.equal(await planner(bridge).run(context), "Finished.");
  assert.equal(peakActive, 2, "only a read batch overlaps");
  const firstReadEnd = Math.max(timeline.indexOf("end:get_script_source"), timeline.lastIndexOf("end:get_script_source"));
  const writeStart = timeline.indexOf("start:set_properties");
  const writeEnd = timeline.indexOf("end:set_properties");
  const laterReadStart = Math.min(
    timeline.indexOf("start:get_instance_properties"),
    timeline.indexOf("start:search_objects"),
  );
  assert.ok(writeStart > firstReadEnd, "the mutation waits for the preceding reads");
  assert.ok(laterReadStart > writeEnd, "later reads wait for the mutation");

  const resultMessage = bridge.requests[1].messages[2];
  assert.deepEqual(resultMessage.content.flatMap((block) => block.kind === "tool-result" ? [block.callId] : []), [
    "read_1", "read_2", "write_1", "read_3", "read_4",
  ]);
});

test("a profiler capture that writes a file waits its turn instead of joining a read batch", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  let active = 0;
  let peakActive = 0;
  context.call = async (tool) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { ok: true, data: {}, text: tool, httpStatus: 200, durationMs: 5 };
  };
  const studio = (id: string, operation: string, args: Record<string, unknown>): TurnEvent => ({
    kind: "tool-call",
    call: { id, name: "roblox_studio", arguments: { operation, arguments: args } },
  });
  const bridge = gateway([
    [
      studio("read_1", "capture_micro_profiler", { frame_window: 240 }),
      studio("write_1", "capture_micro_profiler", { output_path: "C:/Users/creator/Documents/profile.json" }),
      studio("read_2", "capture_script_profiler", { max_functions: 20 }),
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("Finished."),
  ]);

  assert.equal(await planner(bridge).run(context), "Finished.");
  assert.equal(peakActive, 1, "the capture that writes a file is a barrier between the reads around it");
});

test("prose from separate turns is joined at the seam rather than run together", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = gateway([
    [
      { kind: "delta", text: "Wired it up in Studio." },
      { kind: "tool-call", call: { id: "call_1", name: "update_task_list", arguments: { tasks: [] } } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("There's one caveat."),
  ]);

  const answer = await planner(bridge).run(context);
  assert.equal(answer, "Wired it up in Studio.\n\nThere's one caveat.");
  assert.equal(recorded.said.join("").includes("Studio.There's"), false);
});

test("the client tools run here and their answers come back as tool results", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = gateway([
    [
      { kind: "tool-call", call: { id: "c1", name: "load_skill", arguments: { name: "roblox-test" } } },
      {
        kind: "tool-call",
        call: {
          id: "c2",
          name: "update_task_list",
          arguments: {
            tasks: [{ id: "t1", title: "Read Main", status: "active", requiresRuntimeEvidence: false }],
          },
        },
      },
      {
        kind: "tool-call",
        call: {
          id: "c3",
          name: "ask_user",
          arguments: { question: "Which script should I change?", options: ["Main", "Init"] },
        },
      },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("Done."),
  ]);

  await planner(bridge).run(context);
  assert.deepEqual(recorded.tasks[0]?.map((task) => task.title), ["Read Main"]);
  assert.deepEqual(recorded.questions, [{
    question: "Which script should I change?",
    options: ["Main", "Init"],
  }]);

  const results = bridge.requests[1].messages[2].content;
  assert.equal(results.length, 3);
  assert.equal(results.every((block) => block.kind === "tool-result" && !block.failed), true);
  assert.equal(results[0].kind === "tool-result" && results[0].content.includes("Test skill"), true);
  assert.equal(results[2].kind === "tool-result" && results[2].content.includes("Main"), true);
});

test("a bad or unknown tool call is recoverable rather than fatal", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const bridge = gateway([
    [
      { kind: "tool-call", call: { id: "c1", name: "roblox_studio", arguments: { operation: "not_a_tool" } } },
      { kind: "tool-call", call: { id: "c2", name: "invented_tool", arguments: {} } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("Recovered."),
  ]);

  assert.equal(await planner(bridge).run(context), "Recovered.");
  const results = bridge.requests[1].messages[2].content;
  assert.equal(results[0].kind === "tool-result" && results[0].failed, true);
  assert.equal(results[1].kind === "tool-result" && results[1].failed, true);
  assert.equal(results[1].kind === "tool-result" && results[1].content.includes("invented_tool"), true);
});

test("a failed turn ends the run without leaking the endpoint's own wording", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const bridge = gateway([[
    { kind: "delta", text: "partial" },
    { kind: "failed", code: "quota_exhausted", message: "account acct_123 over ceiling" },
  ]]);

  await assert.rejects(() => planner(bridge).run(context), (error: Error) => {
    assert.match(error.message, /usage limit was reached/);
    assert.equal(error.message.includes("acct_123"), false);
    return true;
  });
});

test("a provider rejection reaches the user as the service classified it", async () => {
  // The gateway restates the failures it can name locally, but a provider
  // rejection is one only the service can classify — it is the side that saw
  // the status and knows how many attempts it made. Rewriting it here would put
  // "the provider rejected this turn" back in front of the user.
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const bridge = gateway([[{
    kind: "failed",
    code: "upstream_error",
    message: "The model provider is rate-limiting requests. Roqer retried the turn 3 times, "
      + "but the provider kept refusing. (HTTP 429, 4 attempts)",
  }]]);

  await assert.rejects(() => planner(bridge).run(context), (error: Error) => {
    assert.match(error.message, /rate-limiting requests/);
    assert.match(error.message, /\(HTTP 429, 4 attempts\)/);
    return true;
  });
});

test("a turn that ends without completing is an error rather than a silent answer", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const bridge = gateway([[{ kind: "delta", text: "half an answer" }]]);
  await assert.rejects(() => planner(bridge).run(context), /without completing it/);
});

test("cancellation stops the loop instead of sending another turn", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const bridge = gateway([
    [
      { kind: "tool-call", call: { id: "c1", name: "update_task_list", arguments: { tasks: [] } } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("never sent"),
  ]);

  const running = planner(bridge).run(context);
  controller.abort();
  await assert.rejects(running, RunCancelledError);
  assert.equal(bridge.requests.length, 1);
});

test("a turn reports where its time went, not only how long it took", async () => {
  const { context } = makeContext(new AbortController());
  const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let turns = 0;
  const slow: TurnTransport = {
    async *streamTurn() {
      turns += 1;
      if (turns > 1) {
        yield { kind: "completed", stopReason: "end" };
        return;
      }
      // Silence first: authorization, the upstream connection, and the model's
      // own thinking all hide in here, and none of them look different from
      // the outside.
      await pause(60);
      yield { kind: "delta", text: "Reading it." };
      yield { kind: "tool-call", call: { id: "c1", name: "update_task_list", arguments: { tasks: [] } } };
      // Then the tail, which is the part that is nobody's inference.
      await pause(60);
      yield { kind: "completed", stopReason: "tool-use" };
    },
  };

  const events: AgentLoopTelemetryEvent[] = [];
  await planner(slow, (event) => events.push(event)).run(context);

  const first = events.find((event) => event.kind === "turn");
  assert.ok(first?.kind === "turn");
  assert.ok((first.firstEventMs ?? 0) >= 40, `first event after ${String(first.firstEventMs)}ms`);
  assert.ok(first.firstTextMs !== undefined && first.lastToolCallMs !== undefined);
  assert.ok(first.firstTextMs <= first.lastToolCallMs);
  // The whole point of the split: the tail is measurable on its own rather than
  // buried inside a single duration that reads as the model being slow.
  assert.ok(first.durationMs - first.lastToolCallMs >= 40, `tail of ${first.durationMs - first.lastToolCallMs}ms`);
});

test("a long run that keeps making progress is not cut off at any turn count", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  let turns = 0;
  const building: TurnTransport = {
    async *streamTurn() {
      turns += 1;
      if (turns > 150) {
        yield* DONE("Built and tested.");
        return;
      }
      // A different step every turn: work, not a loop.
      yield { kind: "tool-call", call: { id: `c${turns}`, name: "update_task_list", arguments: { tasks: [], step: turns } } };
      yield { kind: "completed", stopReason: "tool-use" };
    },
  };
  assert.equal(await planner(building).run(context), "Built and tested.");
  assert.equal(turns, 151);
});

test("a model repeating the same calls is asked for a report, and nothing more runs", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const requests: TurnRequest[] = [];
  const looping: TurnTransport = {
    async *streamTurn(request) {
      requests.push(JSON.parse(JSON.stringify(request)) as TurnRequest);
      if (requests.length === REPEATED_CALL_TURNS + 1) {
        // Told to report, it answers and still asks for the same step.
        yield { kind: "delta", text: "The kart drives; boost is untested." };
      }
      yield { kind: "tool-call", call: { id: `c${requests.length}`, name: "roblox_studio", arguments: { operation: "get_script_source", arguments: { instancePath: "ServerScriptService.Main" } } } };
      yield { kind: "completed", stopReason: "tool-use" };
    },
  };

  const answer = await planner(looping).run(context);

  assert.equal(requests.length, REPEATED_CALL_TURNS + 1, "stopped after the repeats, with one turn to report");
  assert.match(answer, /^The kart drives; boost is untested\.\n\nRoqer stopped this run because the model made the same calls 6 turns in a row\. Send "Continue"/);
  assert.match(JSON.stringify(requests.at(-1)?.messages.at(-1)), /same calls 6 turns in a row, so Roqer is stopping this run\. Do not call any tool/);
  assert.ok(recorded.statuses.some((entry) => entry.label === "Model is repeating itself"));

  // Silent when told to report: the run ends as a failure that says why.
  const silent = makeContext(new AbortController());
  let calls = 0;
  const mute: TurnTransport = {
    async *streamTurn() {
      calls += 1;
      yield { kind: "tool-call", call: { id: `c${calls}`, name: "roblox_studio", arguments: { operation: "get_script_source", arguments: { instancePath: "ServerScriptService.Main" } } } };
      yield { kind: "completed", stopReason: "tool-use" };
    },
  };
  await assert.rejects(() => planner(mute).run(silent.context), /made the same calls 6 turns in a row/);
});

test("the same failing call stops sooner, and a note from the user resets the count", async () => {
  const failing = (tool: string): McpToolOutcome => ({ ok: false, data: null, text: `${tool} failed`, httpStatus: 500, errorCode: "boom", message: "boom", durationMs: 1 });
  const { context } = makeContext(new AbortController(), failing);
  let turns = 0;
  const retrying: TurnTransport = {
    async *streamTurn() {
      turns += 1;
      if (turns > REPEATED_FAILURE_TURNS) {
        yield* DONE("It keeps failing.");
        return;
      }
      yield { kind: "tool-call", call: { id: `c${turns}`, name: "roblox_studio", arguments: { operation: "get_script_source", arguments: { instancePath: "ServerScriptService.Main" } } } };
      yield { kind: "completed", stopReason: "tool-use" };
    },
  };
  const answer = await planner(retrying).run(context);
  assert.equal(turns, REPEATED_FAILURE_TURNS + 1);
  assert.match(answer, /same failing calls 3 turns in a row/);

  // With a note from the user between tries, the same failing call is a new attempt.
  const noted = makeContext(new AbortController(), failing);
  let attempts = 0;
  const told: TurnTransport = {
    async *streamTurn() {
      attempts += 1;
      if (attempts <= REPEATED_FAILURE_TURNS) noted.recorded.steers.push(`try ${attempts}`);
      if (attempts > REPEATED_FAILURE_TURNS + 1) {
        yield* DONE("Done.");
        return;
      }
      yield { kind: "tool-call", call: { id: `c${attempts}`, name: "roblox_studio", arguments: { operation: "get_script_source", arguments: { instancePath: "ServerScriptService.Main" } } } };
      yield { kind: "completed", stopReason: "tool-use" };
    },
  };
  assert.equal(await planner(told).run(noted.context), "Done.");
});


/** A gateway that speaks once and then holds the connection open saying nothing. */
function stallingGateway(opening: readonly TurnEvent[] = []): TurnTransport {
  return {
    async *streamTurn(_request, signal) {
      for (const event of opening) yield event;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}


test("a turn that makes no progress is ended rather than held open forever", async () => {
  // The transport bound measures whether the connection is alive, and the
  // gateway's keep-alive frames keep it alive, so a model answering the socket
  // and saying nothing used to hold the app's single run slot open until
  // someone noticed and pressed stop.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);

  await assert.rejects(
    () => planner(stallingGateway(), undefined, 30).run(context),
    /stopped responding for 0 seconds.*Nothing was changed in Studio, so asking again is safe/s,
  );
  assert.ok(
    recorded.statuses.some((entry) => entry.label === "Model stopped making progress"),
    "the timeline says why the run ended",
  );
  assert.equal(context.signal.aborted, false, "a stall is not a cancellation");
});

test("a stall after work has landed says what was applied instead of inviting a repeat", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const applied: RunChange[] = [
    { id: "c1", kind: "script-source", target: "game.ServerScriptService.Shop", summary: "wrote" },
  ];
  const withChanges: PlannerContext = { ...context, changes: () => applied };

  await assert.rejects(
    () => planner(stallingGateway(), undefined, 30).run(withChanges),
    /1 change had already been applied and is left in place \(game\.ServerScriptService\.Shop\)\. Ask again to continue from the current state/,
  );
});

test("progress resets the stall interval, so a slow turn is not cut off", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const slow: TurnTransport = {
    async *streamTurn() {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { kind: "delta", text: "still working. " } as TurnEvent;
      }
      yield { kind: "completed", stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  // Six gaps of 20ms each with a 50ms bound: longer overall than the interval,
  // but never quiet for it.
  const answer = await planner(slow, undefined, 50).run(context);
  assert.match(answer, /still working/);
});

test("a stalled turn is reported to evaluation as a stall rather than as an ordinary turn", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const telemetry: AgentLoopTelemetryEvent[] = [];

  await assert.rejects(() =>
    planner(stallingGateway([{ kind: "delta", text: "Let me think." }]), (event) => telemetry.push(event), 30)
      .run(context));

  const turns = telemetry.filter((event) => event.kind === "turn");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind === "turn" && turns[0].stalled, true);
  assert.equal(turns[0].kind === "turn" && turns[0].completed, false);
});

test("cancelling a run still reads as a cancellation rather than as a stall", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);

  const running = planner(stallingGateway(), undefined, 60_000).run(context);
  controller.abort();
  await assert.rejects(running, RunCancelledError);
  assert.equal(
    recorded.statuses.some((entry) => entry.label === "Model stopped making progress"),
    false,
  );
});

/** A planner whose failed turns are tried again at once, so the retry tests do not wait out real backoff. */
function retryingPlanner(
  transport: TurnTransport,
  options: Readonly<{ turnRetries?: number; retryBaseMs?: number; onTelemetry?: (event: AgentLoopTelemetryEvent) => void }> = {},
) {
  return createAgentLoopPlanner({
    transport,
    runId: "run_test",
    modelId: "openai/gpt-5.6-luna",
    effort: "medium",
    agent: AGENT,
    skillLibrary: SKILLS,
    retryBaseMs: options.retryBaseMs ?? 1,
    ...(options.turnRetries === undefined ? {} : { turnRetries: options.turnRetries }),
    ...(options.onTelemetry === undefined ? {} : { onTelemetry: options.onTelemetry }),
  });
}

/** A transport that plays each attempt's script in turn; a script may end by throwing. */
function flakyGateway(attempts: ReadonlyArray<Readonly<{ events?: readonly TurnEvent[]; error?: Error }>>): TurnTransport & {
  requests: TurnRequest[];
} {
  const requests: TurnRequest[] = [];
  return {
    requests,
    async *streamTurn(request) {
      requests.push(JSON.parse(JSON.stringify(request)) as TurnRequest);
      const attempt = attempts[requests.length - 1];
      assert.ok(attempt, `no scripted attempt ${requests.length}`);
      for (const event of attempt.events ?? []) yield event;
      if (attempt.error !== undefined) throw attempt.error;
    },
  };
}

test("a turn the endpoint failed transiently is sent again, and the run carries on", async () => {
  // One overloaded response used to end the whole run, however far it had got.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const telemetry: AgentLoopTelemetryEvent[] = [];
  const read: TurnEvent = {
    kind: "tool-call",
    call: { id: "c1", name: "roblox_studio", arguments: { operation: "get_script_source", arguments: { instancePath: "ServerScriptService.Main" } } },
  };
  const bridge = flakyGateway([
    // Cut off partway through its reply, with some prose already on screen.
    { events: [{ kind: "delta", text: "Let me rea" }], error: new TransientTurnError("Anthropic returned status 529: Overloaded.") },
    { events: [{ kind: "delta", text: "Reading Main." }, read, { kind: "completed", stopReason: "tool-use" }] },
    { events: DONE("Main prints hi.") },
  ]);

  const answer = await retryingPlanner(bridge, { onTelemetry: (event) => telemetry.push(event) }).run(context);

  assert.match(answer, /Main prints hi\./);
  assert.deepEqual(recorded.calls, ["get_script_source"], "the retried turn's call ran once");
  const retried = recorded.statuses.filter((status) => status.label === "Model endpoint failed; trying the turn again");
  assert.equal(retried.length, 1);
  assert.match(retried[0].detail ?? "", /Overloaded\. Roqer tries again in 1 second \(1 of 4\)\./);
  // The same request went out twice, and the conversation that followed holds
  // only what the successful try said: the failed try's fragment is not the
  // model's turn.
  assert.deepEqual(bridge.requests[0], bridge.requests[1]);
  const assistant = bridge.requests[2].messages[1];
  assert.deepEqual(assistant.content[0], { kind: "text", text: "Reading Main." });
  // Evaluation counts the failed try apart from the turn it was trying.
  const turns = telemetry.filter((event) => event.kind === "turn");
  assert.deepEqual(turns.map((event) => event.kind === "turn" ? [event.turn, event.retried === true] : []), [
    [1, true], [1, false], [2, false],
  ]);
});

test("a turn that keeps failing transiently ends the run once the retries are spent", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const failing = new TransientTurnError("Endpoint returned status 503: Service Unavailable.");
  const bridge = flakyGateway([{ error: failing }, { error: failing }, { error: failing }]);

  await assert.rejects(
    () => retryingPlanner(bridge, { turnRetries: 2 }).run(context),
    /^Error: Endpoint returned status 503: Service Unavailable\. Roqer tried this turn 3 times\.$/,
  );
  assert.equal(bridge.requests.length, 3);
});

test("a failure the next try would only repeat is not tried again", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = flakyGateway([{ error: new Error("Endpoint returned status 401: Invalid key. Check the API key in Settings.") }]);

  await assert.rejects(() => retryingPlanner(bridge).run(context), /status 401/);
  assert.equal(bridge.requests.length, 1);
  assert.equal(recorded.statuses.some((status) => status.label === "Model endpoint failed; trying the turn again"), false);
});

test("an endpoint that asks for a long wait is reported rather than waited on", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const bridge = flakyGateway([{ error: new TransientTurnError("Endpoint returned status 429: Slow down.", { retryAfterMs: 3_600_000 }) }]);

  await assert.rejects(
    () => retryingPlanner(bridge).run(context),
    /Slow down\. It asked Roqer to wait 3600 seconds before trying again\./,
  );
  assert.equal(bridge.requests.length, 1);
});

test("cancelling during the pause before a retry ends the run as cancelled, at once", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = flakyGateway([{ error: new TransientTurnError("Overloaded.") }]);

  const running = retryingPlanner(bridge, { retryBaseMs: 60_000 }).run(context);
  while (!recorded.statuses.some((status) => status.label === "Model endpoint failed; trying the turn again")) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const cancelledAt = Date.now();
  controller.abort();
  await assert.rejects(running, RunCancelledError);
  assert.ok(Date.now() - cancelledAt < 1_000, "the minute-long pause did not hold the cancellation");
  assert.equal(bridge.requests.length, 1);
});

test("a model that reasons for longer than the stall interval is not stopped as stalled", async () => {
  // A local reasoning model thinks for minutes before its first word. Its
  // reasoning is never shown, but that it is arriving is progress.
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const thinking: TurnTransport = {
    async *streamTurn() {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { kind: "reasoning" } as TurnEvent;
      }
      yield { kind: "delta", text: "Main prints hi." };
      yield { kind: "completed", stopReason: "end" };
    },
  };

  assert.equal(await planner(thinking, undefined, 50).run(context), "Main prints hi.");
});

/** A planner that keeps its chat's conversation in `sessions`, as the Custom provider does. */
function keepingPlanner(transport: TurnTransport, sessions: ProviderSessionStore<AgentLoopSession>, transportKey = "endpoint-a") {
  return createAgentLoopPlanner({
    transport,
    runId: "run_test",
    modelId: "openai/gpt-5.6-luna",
    effort: "medium",
    agent: AGENT,
    skillLibrary: SKILLS,
    chatId: "chat-1",
    sessions,
    transportKey,
  });
}

const READ_MAIN: TurnEvent = {
  kind: "tool-call",
  call: { id: "c1", name: "roblox_studio", arguments: { operation: "get_script_source", arguments: { instancePath: "ServerScriptService.Main" } } },
};

/** The same context, one message later in the same chat. */
function followUp(context: PlannerContext, reply: string, prompt: string): PlannerContext {
  return {
    ...context,
    prompt,
    conversation: { messages: [{ role: "user", text: context.prompt }, { role: "assistant", text: reply }], truncated: false },
  };
}

test("a Custom chat's next message continues the conversation it left, tool results included", async () => {
  // Every follow-up used to replay the chat as plain text: what the last run
  // read was gone, so the next one re-read Studio before it could act.
  const sessions = new ProviderSessionStore<AgentLoopSession>();
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const first = gateway([
    [{ kind: "delta", text: "Reading Main." }, READ_MAIN, { kind: "completed", stopReason: "tool-use" }],
    DONE("Main prints hi."),
    DONE("It now prints bye."),
  ]);
  assert.equal(await keepingPlanner(first, sessions).run(context), "Reading Main.\n\nMain prints hi.");
  assert.equal(sessions.size, 1);

  // The next run is handed a new transport; the kept conversation's is the one
  // that holds what the endpoint produced, so that is the one used.
  const unused = gateway([]);
  const next = followUp(context, "Reading Main.\n\nMain prints hi.", "Make it print bye");
  assert.equal(await keepingPlanner(unused, sessions).run(next), "It now prints bye.");

  assert.equal(unused.requests.length, 0);
  const sent = first.requests[2].messages;
  // Everything the first run held, its final answer, then only the new message.
  assert.deepEqual(sent.slice(0, 3), first.requests[1].messages);
  assert.deepEqual(sent[3], { role: "assistant", content: [{ kind: "text", text: "Main prints hi." }] });
  assert.equal(sent.length, 5);
  const opening = sent[4].content[0];
  assert.equal(opening.kind === "text" && opening.text.includes("Make it print bye"), true);
  assert.equal(opening.kind === "text" && opening.text.includes("Prior conversation context"), false, "the chat is not replayed as text");
  assert.ok(recorded.progress.includes("Continuing with Roqer"));
});

test("a kept conversation is not continued under other settings, after a failed run, or once the chat moved on", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const replay = (request: TurnRequest) => {
    const text = request.messages[0].content[0];
    return text.kind === "text" && text.text.includes("Prior conversation context");
  };

  // Another endpoint, model, or key: the conversation belongs to the transport it was held on.
  const sessions = new ProviderSessionStore<AgentLoopSession>();
  await keepingPlanner(gateway([DONE("Main prints hi.")]), sessions, "endpoint-a").run(context);
  const other = gateway([DONE("Done.")]);
  await keepingPlanner(other, sessions, "endpoint-b").run(followUp(context, "Main prints hi.", "Again"));
  assert.equal(other.requests[0].messages.length, 1);
  assert.equal(replay(other.requests[0]), true);

  // A chat that has moved on without this conversation, here by a run on another provider.
  const moved = new ProviderSessionStore<AgentLoopSession>();
  await keepingPlanner(gateway([DONE("Main prints hi.")]), moved).run(context);
  const later = gateway([DONE("Done.")]);
  await keepingPlanner(later, moved).run({
    ...followUp(context, "Main prints hi.", "Again"),
    conversation: {
      messages: [
        { role: "user", text: context.prompt }, { role: "assistant", text: "Main prints hi." },
        { role: "user", text: "Asked elsewhere" }, { role: "assistant", text: "Answered elsewhere" },
      ],
      truncated: false,
    },
  });
  assert.equal(replay(later.requests[0]), true);

  // A run that failed leaves a conversation the chat does not describe.
  const failed = new ProviderSessionStore<AgentLoopSession>();
  await assert.rejects(() => keepingPlanner(flakyGateway([{ error: new Error("status 401") }]), failed).run(context));
  assert.equal(failed.size, 0);
});

/** A turn that reads one script, with a distinct call id per turn so none of them looks repeated. */
const readTurn = (index: number, usage?: Readonly<{ inputTokens: number; outputTokens: number }>): Readonly<{ events: readonly TurnEvent[] }> => ({
  events: [
    {
      kind: "tool-call",
      call: { id: `read_${index}`, name: "roblox_studio", arguments: { operation: "get_script_source", arguments: { instancePath: `ServerScriptService.Script${index}` } } },
    },
    usage === undefined ? { kind: "completed", stopReason: "tool-use" } : { kind: "completed", stopReason: "tool-use", usage },
  ],
});

const TOO_LONG = new ContextOverflowError("Endpoint returned status 400: This model's maximum context length is 32000 tokens.");

test("a turn refused as too long for the model is sent again once the conversation has been cut", async () => {
  // A long run used to end here, with the endpoint's refusal as its answer.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const bridge = flakyGateway([
    ...Array.from({ length: 8 }, (_, index) => readTurn(index)),
    { error: TOO_LONG },
    { events: DONE("Done.") },
  ]);

  assert.equal(await retryingPlanner(bridge).run(context), "Done.");

  const refused = bridge.requests[8].messages;
  const resent = bridge.requests[9].messages;
  assert.equal(refused.length, 17);
  // The request, the host's record of the folded work, and the last four exchanges.
  assert.equal(resent.length, 10);
  assert.deepEqual(resent[0], refused[0]);
  const summary = resent[1].content[0];
  assert.equal(summary.kind === "text" && summary.text.startsWith("[Roqer folded 8 earlier messages"), true);
  assert.ok(recorded.statuses.some((status) => status.label === "Conversation too long for the model"));
});

test("a turn still too long after the conversation was cut ends the run and says what to do", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const long = flakyGateway([...Array.from({ length: 8 }, (_, index) => readTurn(index)), { error: TOO_LONG }, { error: TOO_LONG }]);
  await assert.rejects(
    () => retryingPlanner(long).run(context),
    /maximum context length is 32000 tokens\. Roqer shortened the conversation and it still does not fit\. Start a new chat/,
  );
  assert.equal(long.requests.length, 10);

  // With nothing before the request to cut, there is no second try at all.
  const first = flakyGateway([{ error: TOO_LONG }]);
  await assert.rejects(
    () => retryingPlanner(first).run(makeContext(new AbortController()).context),
    /There is nothing earlier in the conversation left to shorten\. Send a shorter request/,
  );
  assert.equal(first.requests.length, 1);
});

test("a conversation crowding a model's context window is folded before the model refuses it", async () => {
  // The fold used to wait for sixty-one messages, which a model with a small
  // window never reaches before the endpoint refuses the turn.
  const crowding = { inputTokens: 13_000, outputTokens: 50 };
  const script = () => [...Array.from({ length: 12 }, (_, index) => readTurn(index, crowding)), { events: DONE("Done.") }];
  const run = async (contextWindow: number | undefined) => {
    const { context, recorded } = makeContext(new AbortController());
    const bridge = flakyGateway(script());
    await createAgentLoopPlanner({
      transport: bridge, runId: "run_test", modelId: "local-model", effort: "medium", agent: AGENT, skillLibrary: SKILLS,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }).run(context);
    return { bridge, folded: recorded.statuses.some((status) => status.label === "Earlier conversation folded") };
  };

  const small = await run(16_000);
  assert.equal(small.folded, true);
  const lengths = small.bridge.requests.map((request) => request.messages.length);
  // Folded down to the request, the record, and six exchanges once there were enough to fold.
  assert.ok(Math.max(...lengths) <= 1 + (6 + 4) * 2 + 2, `requests grew to ${Math.max(...lengths)} messages`);
  assert.ok(lengths.includes(1 + 1 + 6 * 2));

  // Without a known window the usual bound applies, and twelve exchanges are nowhere near it.
  const unknown = await run(undefined);
  assert.equal(unknown.folded, false);
});

test("a tool call Roqer cannot use is sent back to the model with why, not made the end of the run", async () => {
  // The run that prompted this: nine minutes writing one Blender script for a
  // whole go-kart, which arrived too large to use and ended the run as "a tool
  // call Roqer could not read", with nothing built and nothing the model could act on.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const tooLarge = new UnusableToolCallError(
    "OpenRouter sent a blender call larger than Roqer accepts (more than 262,144 characters).",
    "the arguments of your blender call passed 262,144 characters, the most one call may carry. Make the same step again as smaller calls.",
  );
  const bridge = flakyGateway([
    { events: [{ kind: "delta", text: "One complete Blender job." }], error: tooLarge },
    readTurn(1),
    { events: DONE("Built in parts.") },
  ]);

  assert.equal(await retryingPlanner(bridge).run(context), "One complete Blender job.\n\nBuilt in parts.");

  // Not retried as the same request: the model is told, and asked again.
  const told = bridge.requests[1].messages;
  assert.deepEqual(told[1], { role: "assistant", content: [{ kind: "text", text: "One complete Blender job." }] });
  const note = told[2].content[0];
  assert.equal(note.kind === "text" && note.text.startsWith("[Roqer, the host: your last tool call could not be used, so nothing ran: the arguments of your blender call passed 262,144 characters"), true);
  assert.deepEqual(recorded.calls, ["get_script_source"]);
  const status = recorded.statuses.find((entry) => entry.label === "Model sent a tool call Roqer could not use");
  assert.match(status?.detail ?? "", /larger than Roqer accepts .* Nothing ran; Roqer asked the model for the step again \(1 of 3\)\./);
});

test("a model that keeps sending unusable tool calls is stopped after a few, with the reason", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const broken = new UnusableToolCallError("OpenRouter sent a blender call whose arguments are not valid JSON.", "the arguments were not valid JSON.");
  const bridge = flakyGateway(Array.from({ length: 4 }, () => ({ error: broken })));
  await assert.rejects(
    () => retryingPlanner(bridge).run(context),
    /^Error: OpenRouter sent a blender call whose arguments are not valid JSON\. That was 4 unusable tool calls in a row, so Roqer stopped the run/,
  );
  assert.equal(bridge.requests.length, 4);
});

test("a long run folds its own history and sends the host's record in its place", async () => {
  // Every turn re-sends the whole conversation, so without this a fortieth turn
  // pays again for all thirty-nine sets of tool output before it.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const turns: (readonly TurnEvent[])[] = [];
  for (let index = 0; index < 34; index += 1) {
    turns.push([
      {
        kind: "tool-call",
        call: {
          id: `read_${index}`,
          name: "roblox_studio",
          arguments: {
            operation: "get_script_source",
            // A different script each turn: a long run of work, not a loop.
            arguments: { instancePath: `game.ServerScriptService.Main${index}` },
          },
        },
      },
      { kind: "completed", stopReason: "tool-use" },
    ]);
  }
  turns.push(DONE("Finished."));

  const bridge = gateway(turns);
  assert.equal(await planner(bridge).run(context), "Finished.");

  const last = bridge.requests[bridge.requests.length - 1];
  assert.ok(last.messages.length < COMPACTION_TRIGGER_MESSAGES, `history grew to ${last.messages.length}`);
  assert.deepEqual(last.messages[0].content[0], {
    kind: "text",
    text: buildConversationPrompt(context.conversation, context.prompt),
  }, "the request itself is never folded away");

  const summary = last.messages[1].content[0];
  assert.equal(summary.kind, "text");
  assert.match(summary.kind === "text" ? summary.text : "", /Roqer folded \d+ earlier messages/);
  assert.match(summary.kind === "text" ? summary.text : "", /Read Studio again/);

  // A tool result whose call was folded away is a message no provider accepts.
  const callIds = new Set(last.messages.flatMap((message) =>
    message.content.flatMap((block) => block.kind === "tool-call" ? [block.call.id] : [])));
  for (const message of last.messages) {
    for (const block of message.content) {
      if (block.kind !== "tool-result") continue;
      assert.ok(callIds.has(block.callId), `${block.callId} answers a call that is gone`);
    }
  }

  assert.ok(
    recorded.statuses.some((entry) => entry.label === "Earlier conversation folded"),
    "the reader is told why the agent went back to re-read Studio",
  );
});

test("skill guidance can be loaded again after conversation compaction removes its result", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  let skillLoads = 0;
  const countingSkills: SkillLibrary = {
    catalog: AGENT.skills,
    load: async (name, resource = "SKILL.md") => {
      skillLoads += 1;
      return { name, resource, content: "# Guidance needed after the fold" };
    },
  };
  const turns: (readonly TurnEvent[])[] = [[
    { kind: "tool-call", call: { id: "skill_before", name: "load_skill", arguments: { name: "roblox-test" } } },
    { kind: "completed", stopReason: "tool-use" },
  ]];
  for (let index = 1; index < 30; index += 1) {
    turns.push([
      {
        kind: "tool-call",
        call: {
          id: `read_${index}`,
          name: "roblox_studio",
          arguments: {
            operation: "get_script_source",
            // A different script each turn: a long run of work, not a loop.
            arguments: { instancePath: `game.ServerScriptService.Main${index}` },
          },
        },
      },
      { kind: "completed", stopReason: "tool-use" },
    ]);
  }
  turns.push([
    { kind: "tool-call", call: { id: "skill_after", name: "load_skill", arguments: { name: "roblox-test" } } },
    { kind: "completed", stopReason: "tool-use" },
  ]);
  turns.push(DONE("Finished."));

  const bridge = gateway(turns);
  assert.equal(await planner(bridge, undefined, undefined, countingSkills).run(context), "Finished.");
  assert.equal(skillLoads, 2, "the post-fold request receives the document instead of a stale cache pointer");

  const finalRequest = bridge.requests[bridge.requests.length - 1];
  const reloaded = finalRequest.messages.flatMap((message) => message.content)
    .find((block) => block.kind === "tool-result" && block.callId === "skill_after");
  assert.equal(reloaded?.kind, "tool-result");
  assert.match(reloaded?.kind === "tool-result" ? reloaded.content : "", /Guidance needed after the fold/);
});

test("skill guidance can be loaded again after retained tool output is elided", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller, () => ({
    ok: true,
    data: undefined,
    text: "x ".repeat(15_000),
    httpStatus: 200,
    durationMs: 1,
  }));
  let skillLoads = 0;
  const countingSkills: SkillLibrary = {
    catalog: AGENT.skills,
    load: async (name, resource = "SKILL.md") => {
      skillLoads += 1;
      return { name, resource, content: "# Guidance needed after elision" };
    },
  };
  const turns: (readonly TurnEvent[])[] = [[
    { kind: "tool-call", call: { id: "skill_before", name: "load_skill", arguments: { name: "roblox-test" } } },
    { kind: "completed", stopReason: "tool-use" },
  ]];
  for (let index = 0; index < 18; index += 1) {
    turns.push([
      {
        kind: "tool-call",
        call: {
          id: `large_${index}`,
          name: "roblox_studio",
          arguments: {
            operation: "get_script_source",
            arguments: { instancePath: `game.ServerScriptService.Main${index}` },
          },
        },
      },
      { kind: "completed", stopReason: "tool-use" },
    ]);
  }
  turns.push([
    { kind: "tool-call", call: { id: "skill_after", name: "load_skill", arguments: { name: "roblox-test" } } },
    { kind: "completed", stopReason: "tool-use" },
  ]);
  turns.push(DONE("Finished."));

  const bridge = gateway(turns);
  assert.equal(await planner(bridge, undefined, undefined, countingSkills).run(context), "Finished.");
  assert.equal(skillLoads, 2, "the post-elision request receives the document instead of a stale cache pointer");

  const finalRequest = bridge.requests[bridge.requests.length - 1];
  const reloaded = finalRequest.messages.flatMap((message) => message.content)
    .find((block) => block.kind === "tool-result" && block.callId === "skill_after");
  assert.equal(reloaded?.kind, "tool-result");
  assert.match(reloaded?.kind === "tool-result" ? reloaded.content : "", /Guidance needed after elision/);
});

test("attached images ride the first user turn and stay there", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const withImages: PlannerContext = {
    ...context,
    images: [
      { name: "shot.png", mediaType: "image/png", data: "QUJD" },
      // A format the wire contract does not accept is dropped here rather than
      // failing the whole turn at the service.
      { name: "diagram.svg", mediaType: "image/svg+xml", data: "QUJD" },
    ],
  };
  const bridge = gateway([
    [
      { kind: "tool-call", call: { id: "call_1", name: "studio", arguments: { operation: "get_script_source", args: { path: "Main" } } } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("The button is misaligned."),
  ]);

  assert.equal(await planner(bridge).run(withImages), "The button is misaligned.");

  const first = bridge.requests[0].messages[0];
  assert.equal(first.role, "user");
  assert.deepEqual(first.content[0].kind, "text");
  assert.deepEqual(first.content.slice(1), [{ kind: "image", mediaType: "image/png", data: "QUJD" }]);

  // The second request replays that same first message, picture included, and
  // adds the tool exchange. The picture rides message zero for the whole run:
  // it is never copied onto a later message, and it is never taken off the one
  // it came in on, because the run is still working on what it shows.
  const second = bridge.requests[1];
  assert.deepEqual(second.messages[0].content.slice(1), [
    { kind: "image", mediaType: "image/png", data: "QUJD" },
  ]);
  assert.equal(
    second.messages.slice(1).some((message) => message.content.some((block) => block.kind === "image")),
    false,
  );
});

test("a screenshot survives the turns between capturing it and describing it", async () => {
  // The failure this exists to catch: an agent captures on one turn, stops the
  // playtest on the next, and describes on the one after that. An image retired
  // after a single turn is always gone by the turn that needed it, and the tool
  // result still reports the dimensions, so the run looks like it worked.
  const controller = new AbortController();
  const shot = Buffer.from("the playtest viewport").toString("base64");
  const { context } = makeContext(controller, (tool) => tool === "capture_screenshot"
    ? {
        ok: true,
        data: undefined,
        text: "Screenshot 1245x761",
        images: [{ mediaType: "image/png", data: shot }],
        httpStatus: 200,
        durationMs: 1,
      }
    : { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 });
  const studio = (id: string, operation: string): TurnEvent => ({
    kind: "tool-call",
    call: { id, name: "roblox_studio", arguments: { operation, arguments: {} } },
  });
  const bridge = gateway([
    [studio("shot_1", "capture_screenshot"), { kind: "completed", stopReason: "tool-use" }],
    [studio("stop_1", "solo_playtest"), { kind: "completed", stopReason: "tool-use" }],
    DONE("A red spawn platform over blue water."),
  ]);

  assert.equal(await planner(bridge).run(context), "A red spawn platform over blue water.");

  const carries = (request: TurnRequest): boolean => request.messages
    .some((message) => message.content.some((block) => block.kind === "image" && block.data === shot));
  assert.equal(carries(bridge.requests[0]), false, "nothing captured yet");
  assert.equal(carries(bridge.requests[1]), true, "the turn that stops the playtest");
  assert.equal(carries(bridge.requests[2]), true, "the turn that describes it");
});

test("screenshots accumulate, then are cut back to the newest in one step", async () => {
  // Evicting the previous capture on every new one rewrote an earlier message
  // each time, and the provider re-billed everything after it at full price.
  // Now history is left alone until the high-water mark, then cut deeply once.
  const controller = new AbortController();
  // Nine-tenths of a turn's image budget each, rounded to a multiple of four,
  // because the wire contract checks that the data is real base64 first.
  const size = Math.floor((MAX_TURN_IMAGE_BASE64 * 9) / 10 / 4) * 4;
  const shots = ["A", "B", "C", "D", "E"].map((letter) => letter.repeat(size));
  let captures = 0;
  const { context } = makeContext(controller, (tool) => tool === "capture_screenshot"
    ? {
        ok: true,
        data: undefined,
        text: "Screenshot",
        images: [{ mediaType: "image/png", data: shots[captures++] }],
        httpStatus: 200,
        durationMs: 1,
      }
    : { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 });
  const shoot = (id: string): TurnEvent => ({
    kind: "tool-call",
    call: { id, name: "roblox_studio", arguments: { operation: "capture_screenshot", arguments: {} } },
  });
  const bridge = gateway([
    ...shots.map((_, index): readonly TurnEvent[] => [shoot(`shot_${index + 1}`), { kind: "completed", stopReason: "tool-use" }]),
    DONE("Done."),
  ]);

  await planner(bridge).run(context);

  const data = (request: TurnRequest): string[] => request.messages
    .flatMap((message) => message.content.flatMap((block) => block.kind === "image" ? [block.data] : []));
  // Three captures ride along untouched: before, after, and one more.
  assert.deepEqual(data(bridge.requests[1]), [shots[0]]);
  assert.deepEqual(data(bridge.requests[2]), [shots[0], shots[1]]);
  assert.deepEqual(data(bridge.requests[3]), [shots[0], shots[1], shots[2]]);
  // Every request until then repeats the one before it exactly, which is what
  // lets the provider serve it from its cache.
  for (const index of [2, 3]) {
    assert.deepEqual(bridge.requests[index].messages.slice(0, bridge.requests[index - 1].messages.length), bridge.requests[index - 1].messages);
  }
  // The fourth crosses the byte budget, and the run keeps only the newest.
  assert.deepEqual(data(bridge.requests[4]), [shots[3]]);
  assert.deepEqual(data(bridge.requests[5]), [shots[3], shots[4]]);
});

test("a Studio screenshot reaches the next model turn", async () => {
  const controller = new AbortController();
  const screenshot = Buffer.from("studio screenshot").toString("base64");
  const { context } = makeContext(controller, (tool) => tool === "capture_screenshot"
    ? {
        ok: true,
        data: undefined,
        text: "Screenshot 800x600",
        images: [{ mediaType: "image/jpeg", data: screenshot }],
        httpStatus: 200,
        durationMs: 1,
      }
    : { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 });
  const bridge = gateway([
    [
      {
        kind: "tool-call",
        call: {
          id: "shot_1",
          name: "roblox_studio",
          arguments: { operation: "capture_screenshot", arguments: {} },
        },
      },
      { kind: "completed", stopReason: "tool-use" },
    ],
    [
      { kind: "tool-call", call: { id: "task_1", name: "update_task_list", arguments: { tasks: [] } } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("The screenshot shows the UI."),
  ]);

  assert.equal(await planner(bridge).run(context), "The screenshot shows the UI.");
  const screenshotResult = bridge.requests[1].messages[2];
  assert.deepEqual(screenshotResult.content, [
    {
      kind: "tool-result",
      callId: "shot_1",
      content: '{"operation":"capture_screenshot","ok":true,"text":"Screenshot 800x600"}',
      failed: false,
    },
    { kind: "image", mediaType: "image/jpeg", data: screenshot },
  ]);
});

test("an attached picture is still there on the turn that acts on it", async () => {
  // Screenshots are dropped once enough newer ones have arrived, because they
  // describe a moment that has passed. An attachment is the request itself: someone who hands over a mockup
  // and says "build this" needs it present on the turn that builds, which is
  // never the first one.
  const controller = new AbortController();
  const mockup = Buffer.from("a mockup of the shop UI").toString("base64");
  const { context } = makeContext(controller);
  context.images = [{ name: "shop-mockup.png", mediaType: "image/png", data: mockup }];
  const bridge = gateway([
    [
      { kind: "tool-call", call: { id: "task_1", name: "update_task_list", arguments: { tasks: [] } } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    [
      {
        kind: "tool-call",
        call: {
          id: "write_1",
          name: "roblox_studio",
          arguments: { operation: "get_file_content", args: { path: "Shop" } },
        },
      },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("Built the shop from the mockup."),
  ]);

  await planner(bridge).run(context);

  const carriesMockup = (request: TurnRequest): boolean => request.messages
    .some((message) => message.content
      .some((block) => block.kind === "image" && block.data === mockup));
  assert.equal(bridge.requests.length, 3);
  for (const [index, request] of bridge.requests.entries()) {
    assert.equal(carriesMockup(request), true, `turn ${index + 1} lost the attachment`);
  }
});

test("an attached reference and a run of screenshots still fit one model turn", async () => {
  // The two bounds used to disagree: retention exempted the opening message
  // from its count while the wire contract counted every image in the request.
  // One attached reference plus four kept screenshots made five, and the run
  // died with "Roqer built an invalid model turn" on the turn after its fourth
  // capture -- which is to say, the runs that verified most carefully died first.
  const controller = new AbortController();
  const reference = Buffer.from("the shop mockup").toString("base64");
  let captures = 0;
  const shots: string[] = [];
  const { context } = makeContext(controller, (tool) => {
    if (tool !== "capture_screenshot") return { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 };
    const shot = Buffer.from(`viewport ${++captures}`).toString("base64");
    shots.push(shot);
    return { ok: true, data: undefined, text: "Screenshot", images: [{ mediaType: "image/png", data: shot }], httpStatus: 200, durationMs: 1 };
  });
  context.images = [{ name: "reference.png", mediaType: "image/png", data: reference }];
  const shoot = (id: string): TurnEvent => ({
    kind: "tool-call",
    call: { id, name: "roblox_studio", arguments: { operation: "capture_screenshot", arguments: {} } },
  });
  const bridge = gateway([
    [shoot("shot_1"), { kind: "completed", stopReason: "tool-use" }],
    [shoot("shot_2"), { kind: "completed", stopReason: "tool-use" }],
    [shoot("shot_3"), { kind: "completed", stopReason: "tool-use" }],
    [shoot("shot_4"), { kind: "completed", stopReason: "tool-use" }],
    [shoot("shot_5"), { kind: "completed", stopReason: "tool-use" }],
    DONE("Matches the reference."),
  ]);

  // The gateway stub refuses any request the contract would, so reaching the
  // answer is the assertion that every turn was valid.
  assert.equal(await planner(bridge).run(context), "Matches the reference.");

  const data = (request: TurnRequest): string[] => request.messages
    .flatMap((message) => message.content.flatMap((block) => block.kind === "image" ? [block.data] : []));
  // The reference is never evicted; the screenshots share what it leaves, and
  // once they fill it they are cut back to the newest, then accumulate again.
  assert.deepEqual(data(bridge.requests[3]), [reference, shots[0], shots[1], shots[2]]);
  assert.deepEqual(data(bridge.requests[4]), [reference, shots[3]]);
  assert.deepEqual(data(bridge.requests[5]), [reference, shots[3], shots[4]]);
});

test("attachments that fill every slot leave a screenshot reported, not the run refused", async () => {
  const controller = new AbortController();
  const shot = Buffer.from("the viewport").toString("base64");
  const { context, recorded } = makeContext(controller, (tool) => tool === "capture_screenshot"
    ? { ok: true, data: undefined, text: "Screenshot", images: [{ mediaType: "image/png", data: shot }], httpStatus: 200, durationMs: 1 }
    : { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 });
  context.images = ["a", "b", "c", "d"].map((name) => ({
    name: `${name}.png`, mediaType: "image/png", data: Buffer.from(`mockup ${name}`).toString("base64"),
  }));
  const bridge = gateway([
    [
      { kind: "tool-call", call: { id: "shot_1", name: "roblox_studio", arguments: { operation: "capture_screenshot", arguments: {} } } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("I could not see the screenshot."),
  ]);

  await planner(bridge).run(context);

  const sent = bridge.requests[1].messages[2];
  assert.equal(sent.content.some((block) => block.kind === "image"), false);
  // The model is told, with the reason: it has to know the attachments are
  // what is in the way, or it will retry the capture as if it had failed.
  const result = sent.content[0];
  assert.equal(result.kind, "tool-result");
  assert.match(result.kind === "tool-result" ? result.content : "", /4 are attached to the request/);
  // And so is the person.
  const status = recorded.statuses.find((entry) => entry.label === "Screenshot not sent to the model");
  assert.ok(status, "the timeline says why the model could not see");
  assert.match(status.detail ?? "", /4 are attached to the request/);
});

test("a note typed while tools run reaches the model with their results, as the user's words", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller, () => {
    // Typed while the read was in flight: queued, not injected.
    recorded.steers.push("Also make the button blue.");
    return { ok: true, data: { source: "print('hi')", sourceRevision: "rev-1" }, text: "", httpStatus: 200, durationMs: 1 };
  });
  const bridge = gateway([
    [
      { kind: "tool-call", call: { id: "read_1", name: "roblox_studio", arguments: { operation: "get_project_structure", arguments: {} } } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("Read it, and made the button blue."),
  ]);

  await planner(bridge).run(context);

  const results = bridge.requests[1].messages[2];
  assert.equal(results.role, "user");
  // The call is answered first, then the person speaks: a provider sees every
  // tool result before anything else in the message.
  assert.equal(results.content[0].kind, "tool-result");
  const note = results.content[1];
  assert.equal(note.kind, "text");
  assert.match(note.kind === "text" ? note.text : "", /from the user, not from a tool/);
  assert.match(note.kind === "text" ? note.text : "", /Also make the button blue\./);
  // And the timeline says the model saw it, which is the moment that matters
  // to someone who typed it thirty seconds ago.
  assert.deepEqual(recorded.statuses.filter((entry) => entry.label === "Read your note"), [
    { label: "Read your note", detail: "Also make the button blue." },
  ]);
});

test("a note the model had not read when it finished earns one more turn", async () => {
  // The run would otherwise end with the last thing the user said unread. So
  // the reply so far becomes an assistant turn and the note the next user one.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const requests: TurnRequest[] = [];
  const bridge: TurnTransport = {
    async *streamTurn(request) {
      requests.push(JSON.parse(JSON.stringify(request)) as TurnRequest);
      assert.equal(isTurnRequest(request), true);
      if (requests.length === 1) {
        // Typed as the model was finishing.
        recorded.steers.push("Wait — the server script, not the client one.");
        yield* DONE("Done: edited the client script.");
      } else {
        yield* DONE("Moved the change to the server script.");
      }
    },
  };

  const answer = await planner(bridge).run(context);

  assert.equal(requests.length, 2, "one more turn, not a new run");
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "assistant", content: [{ kind: "text", text: "Done: edited the client script." }] },
    { role: "user", content: [{ kind: "text", text: `[Roqer relays a note the user typed while you were working. It is from the user, not from a tool:]\nWait — the server script, not the client one.` }] },
  ]);
  assert.equal(answer, "Done: edited the client script.\n\nMoved the change to the server script.");
  assert.ok(recorded.statuses.some((entry) => entry.label === "Read your note"));
});

test("a broken tool call is retried as a smaller one, then fails saying so", async () => {
  const BROKEN: readonly TurnEvent[] = [{ kind: "completed", stopReason: "malformed-tool-call" }];
  const { context, recorded } = makeContext(new AbortController());
  const recovering = gateway([BROKEN, BROKEN, DONE("Wrote the controller in two parts.")]);
  assert.equal(await planner(recovering).run(context), "Wrote the controller in two parts.");
  assert.match(JSON.stringify(recovering.requests[1].messages.at(-1)), /last tool call could not be formed.*smaller call/);
  assert.ok(recorded.statuses.some((entry) => entry.label === "Model sent a broken tool call"));

  const hopeless = makeContext(new AbortController());
  const failing = gateway(Array.from({ length: MALFORMED_CALL_RETRIES + 1 }, () => BROKEN));
  await assert.rejects(() => planner(failing).run(hopeless.context), /could not form a tool call 4 times in a row/);
  assert.equal(failing.requests.length, MALFORMED_CALL_RETRIES + 1);
});

test("a model that ends a turn silently is asked once to continue", async () => {
  const SILENT: readonly TurnEvent[] = [{ kind: "completed", stopReason: "end", usage: { inputTokens: 10, outputTokens: 0 } }];
  const task = (title: string, status: RunTask["status"]): RunTask => ({ id: title, title, status, requiresRuntimeEvidence: false });

  // Open work and an empty turn: one host note, then the model carries on.
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  context.setTasks([task("Build the track", "done"), task("Test the kart in Play mode", "active")]);
  const resumed = gateway([SILENT, DONE("Tested it: the kart drives.")]);
  assert.equal(await planner(resumed).run(context), "Tested it: the kart drives.");
  assert.equal(resumed.requests.length, 2);
  const note = resumed.requests[1].messages.at(-1);
  assert.equal(note?.role, "user");
  assert.match(JSON.stringify(note), /Roqer, the host: you ended your turn with no reply.*\\"Test the kart in Play mode\\"/);
  assert.doesNotMatch(JSON.stringify(note), /Build the track/, "finished tasks are not listed");
  assert.ok(recorded.statuses.some((entry) => entry.label === "Model stopped without a reply"));

  // Asked once only: silent again, and the run ends as before.
  const again = makeContext(new AbortController());
  again.context.setTasks([task("Test the kart in Play mode", "active")]);
  const twice = gateway([SILENT, SILENT]);
  assert.equal(await planner(twice).run(again.context), "The model returned no answer for this turn.");
  assert.equal(twice.requests.length, 2);

  // Silent before any plan exists: still asked once, to continue the request.
  const early = makeContext(new AbortController());
  const unplanned = gateway([SILENT, DONE("Here is the kart.")]);
  assert.equal(await planner(unplanned).run(early.context), "Here is the kart.");
  assert.match(JSON.stringify(unplanned.requests[1].messages.at(-1)), /no reply and no tool call\. Continue working on the user's request/);

  // A turn that answers is never nudged, whatever is left open.
  const answered = makeContext(new AbortController());
  answered.context.setTasks([task("Test the kart in Play mode", "active")]);
  const replied = gateway([DONE("I could not start a playtest.")]);
  assert.equal(await planner(replied).run(answered.context), "I could not start a playtest.");
  assert.equal(replied.requests.length, 1);
});

test("a screenshot too large to send is reported to the person, not only to the model", async () => {
  // A PNG of a play-mode viewport clears the tool's own budget and still misses
  // the hosted one by a wide margin. Dropping it quietly leaves an agent saying
  // it cannot see, with nothing anywhere to say why, which is indistinguishable
  // from the feature not being installed at all.
  const controller = new AbortController();
  const huge = "A".repeat(MAX_TURN_IMAGE_BASE64 + 4);
  const { context, recorded } = makeContext(controller, (tool) => tool === "capture_screenshot"
    ? {
        ok: true,
        data: undefined,
        text: "Screenshot 1245x761",
        images: [{ mediaType: "image/png", data: huge }],
        httpStatus: 200,
        durationMs: 1,
      }
    : { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 });
  const bridge = gateway([
    [
      {
        kind: "tool-call",
        call: {
          id: "shot_1",
          name: "roblox_studio",
          arguments: { operation: "capture_screenshot", arguments: { format: "png" } },
        },
      },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("I could not see the screenshot."),
  ]);

  await planner(bridge).run(context);

  const sent = bridge.requests[1].messages[2];
  assert.equal(sent.content.some((block) => block.kind === "image"), false);
  const [toolResult] = sent.content;
  assert.equal(toolResult.kind, "tool-result");
  // The model is told how to get an image that fits rather than that it failed.
  assert.match(toolResult.content, /too large for a model turn/);
  assert.match(toolResult.content, /JPEG at lower quality/);

  const status = recorded.statuses.find((entry) => entry.label === "Screenshot not sent to the model");
  assert.ok(status, "the drop must appear in the timeline");
  assert.match(status.detail ?? "", /too large for a model turn/);
  // The capture itself worked, and saying otherwise would send someone looking
  // at Studio instead of at the size ceiling.
  assert.match(status.detail ?? "", /tool itself succeeded/);
});

/**
 * A model on the user's own endpoint that takes no images. Sending one would
 * fail the turn on most text-only servers, so attachments and screenshots are
 * held back, and the model is told to read the interface another way.
 */
test("a model that accepts no images is sent none, and told to stop capturing", async () => {
  const controller = new AbortController();
  const shot = Buffer.from("studio screenshot").toString("base64");
  const { context, recorded } = makeContext(controller, (tool) => tool === "capture_screenshot"
    ? { ok: true, data: undefined, text: "Screenshot 800x600", images: [{ mediaType: "image/jpeg", data: shot }], httpStatus: 200, durationMs: 1 }
    : { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 });
  const withAttachment: PlannerContext = { ...context, images: [{ name: "mockup.png", mediaType: "image/png", data: "QUJD" }] };
  const bridge = gateway([
    [
      { kind: "tool-call", call: { id: "shot_1", name: "roblox_studio", arguments: { operation: "capture_screenshot", arguments: {} } } },
      { kind: "completed", stopReason: "tool-use" },
    ],
    DONE("Read the interface instead."),
  ]);
  const textOnly = createAgentLoopPlanner({
    transport: bridge,
    runId: "run_test",
    // The fake gateway holds requests to the hosted contract, whose model ids
    // have no colon; a real custom endpoint is not held to it.
    modelId: "local/qwen2.5-coder",
    effort: "none",
    agent: AGENT,
    skillLibrary: SKILLS,
    plannerId: "custom-endpoint",
    label: "Ollama",
    images: false,
  });

  assert.equal(textOnly.id, "custom-endpoint");
  assert.equal(await textOnly.run(withAttachment), "Read the interface instead.");
  for (const request of bridge.requests) {
    assert.equal(request.messages.some((message) => message.content.some((block) => block.kind === "image")), false);
  }
  const result = bridge.requests[1].messages[2].content.find((block) => block.kind === "tool-result");
  assert.match(result?.kind === "tool-result" ? result.content : "", /does not accept images[\s\S]*inspect_ui/);
  assert.ok(recorded.statuses.some((status) => status.label === "Images not sent to the model"));
  assert.ok(recorded.progress.includes("Thinking with Ollama"));
});

test("the blender tool is offered only while enabled, and a call becomes one engine operation with its preview", async () => {
  const preview = { data: "iVBORw0KGgo=", mediaType: "image/png" as const };
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller, (tool) => ({
    ok: true, data: { files: [] }, text: "Blender job finished.", images: tool === "run_blender_script" ? [preview] : undefined,
    httpStatus: 200, durationMs: 1,
  }));
  const call = { id: "call_1", name: "blender", arguments: { script: "import bpy" } };
  const enabledBridge = gateway([
    [{ kind: "tool-call", call }, { kind: "completed", stopReason: "tool-use" }],
    DONE("Modeled."),
  ]);
  const enabled = createAgentLoopPlanner({
    transport: enabledBridge, runId: "run_test", modelId: "openai/gpt-5.6-luna", effort: "medium",
    agent: AGENT, skillLibrary: SKILLS, blender: true,
  });

  assert.equal(await enabled.run(context), "Modeled.");
  assert.deepEqual(enabledBridge.requests[0].tools.map((tool) => tool.name), [
    "roblox_studio", "blender", "load_skill", "resolve_icon", "update_task_list", "ask_user",
  ]);
  assert.deepEqual(recorded.calls, ["run_blender_script"]);
  const fedBack = enabledBridge.requests[1].messages.at(-1)!.content;
  assert.ok(fedBack.some((block) => block.kind === "image" && block.data === preview.data), "the preview reaches the model");

  // Off: the tool is not offered, and a model that names it anyway gets nothing run.
  const off = makeContext(new AbortController());
  const offBridge = gateway([
    [{ kind: "tool-call", call }, { kind: "completed", stopReason: "tool-use" }],
    DONE("Could not."),
  ]);
  await planner(offBridge).run(off.context);
  assert.equal(offBridge.requests[0].tools.some((tool) => tool.name === "blender"), false);
  assert.deepEqual(off.recorded.calls, []);
});
