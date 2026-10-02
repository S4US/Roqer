import assert from "node:assert/strict";
import test from "node:test";
import type { McpCallOptions, McpToolCaller, McpToolOutcome } from "./mcp-types";
import { OutputTokenMeter, RunCancelledError, RunSession } from "./run-engine";
import type { Planner, PlannerContext } from "./run-engine";
import type { RunEvent, RunRequest } from "../shared/run-events";
import { isRunEvent } from "../shared/run-events";
import { DEFAULT_TOOL_TIMEOUT_MS, timeoutForTool } from "../shared/mcp-tools";

function outcome(overrides: Partial<McpToolOutcome> = {}): McpToolOutcome {
  return { ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1, ...overrides };
}

type Handler = (
  tool: string,
  args: Record<string, unknown>,
  options?: McpCallOptions,
) => Promise<McpToolOutcome>;

function makeCaller(handler: Handler): McpToolCaller & {
  calls: Array<{ tool: string; args: Record<string, unknown>; signal?: AbortSignal; timeoutMs?: number }>;
} {
  const calls: Array<{ tool: string; args: Record<string, unknown>; signal?: AbortSignal; timeoutMs?: number }> = [];
  return {
    calls,
    async callTool(tool, args, options) {
      calls.push({ tool, args, signal: options?.signal, timeoutMs: options?.timeoutMs });
      return handler(tool, args, options);
    },
  };
}

function planner(run: (context: PlannerContext) => Promise<string>): Planner {
  return { id: "test-planner", run };
}

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run-1",
    projectId: "project-1",
    chatId: "chat-1",
    prompt: "test prompt",
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

function assertAllValid(events: readonly RunEvent[]): void {
  for (const event of events) {
    assert.ok(isRunEvent(event), `event failed isRunEvent: ${JSON.stringify(event)}`);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("event order and seq monotonicity for a simple read-only run", async () => {
  const caller = makeCaller(async () => outcome());
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("get_place_info", {});
      return "all done";
    }),
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  const result = await session.execute();

  assert.equal(result, "completed");
  assert.equal(events[0]?.type, "run-started");
  assert.equal(events.at(-1)?.type, "run-completed");
  events.forEach((event, index) => {
    assert.equal(event.seq, index + 1);
    assert.equal(event.runId, "run-1");
  });
  assertAllValid(events);
});

test("a model's output count reaches the renderer at most once a second, with the provider's own figure always", () => {
  const meter = new OutputTokenMeter();
  assert.equal(meter.admit(10, false, 0), true, "the first estimate shows at once");
  assert.equal(meter.admit(40, false, 400), false, "an estimate within the second waits");
  assert.equal(meter.admit(90, false, 1_000), true);
  assert.equal(meter.admit(90, false, 5_000), false, "an unchanged figure says nothing new");
  assert.equal(meter.admit(120, true, 5_100), true, "the provider's count is never held back");
  assert.equal(meter.admit(8, false, 5_200), true, "a smaller count is a new response, and the old figure must not stand");
});

test("output counts travel as valid events and never as steps", async () => {
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller: makeCaller(async () => outcome()),
    planner: planner(async (ctx) => {
      ctx.outputTokens(12, false);
      ctx.outputTokens(13, false);
      ctx.outputTokens(-1, false);
      ctx.outputTokens(1.5, true);
      ctx.outputTokens(30, true);
      return "done";
    }),
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  await session.execute();
  assertAllValid(events);
  assert.deepEqual(
    events.flatMap((event) => event.type === "output-tokens" ? [{ tokens: event.tokens, exact: event.exact }] : []),
    [{ tokens: 12, exact: false }, { tokens: 30, exact: true }],
  );
});

test("context readings travel as valid events, each one once, and a malformed one never", async () => {
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller: makeCaller(async () => outcome()),
    planner: planner(async (ctx) => {
      ctx.contextUsage(10_050, null);
      ctx.contextUsage(10_050, 200_000);
      ctx.contextUsage(10_050, 200_000);
      ctx.contextUsage(-1, 200_000);
      ctx.contextUsage(1.5, null);
      ctx.contextUsage(20_000, 0);
      ctx.contextUsage(20_000, 200_000);
      return "done";
    }),
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  await session.execute();
  assertAllValid(events);
  assert.deepEqual(
    events.flatMap((event) => event.type === "context-usage" ? [{ usedTokens: event.usedTokens, windowTokens: event.windowTokens }] : []),
    [
      { usedTokens: 10_050, windowTokens: null },
      { usedTokens: 10_050, windowTokens: 200_000 },
      { usedTokens: 20_000, windowTokens: 200_000 },
    ],
  );

  // What arrives over IPC is checked the same way.
  const base = { runId: "run_1", seq: 1, at: "2026-01-01T00:00:00.000Z", type: "context-usage" };
  assert.equal(isRunEvent({ ...base, usedTokens: 5, windowTokens: null }), true);
  assert.equal(isRunEvent({ ...base, usedTokens: 5 }), false, "an unknown window is null, never absent");
  assert.equal(isRunEvent({ ...base, usedTokens: 5, windowTokens: 0 }), false);
  assert.equal(isRunEvent({ ...base, usedTokens: "5", windowTokens: null }), false);
});

test("the run's usage is the latest well-formed total, recorded with run-completed whatever the outcome", async () => {
  const run = async (body: (ctx: PlannerContext) => Promise<string>) => {
    const events: RunEvent[] = [];
    await new RunSession({
      caller: makeCaller(async () => outcome()),
      planner: planner(body),
      request: makeRequest(),
      emit: (event) => events.push(event),
    }).execute();
    assertAllValid(events);
    const completed = events.at(-1);
    assert.equal(completed?.type, "run-completed");
    return completed?.type === "run-completed" ? completed : undefined;
  };

  const finished = await run(async (ctx) => {
    ctx.runUsage({ inputTokens: 10, outputTokens: 2 });
    ctx.runUsage({ inputTokens: 60, cacheReadTokens: 9_000, cacheWriteTokens: 120, outputTokens: 140, requests: 3, costUsd: 0.42 });
    // Malformed totals are ignored and the last good one stands.
    ctx.runUsage({ inputTokens: -1, outputTokens: 2 });
    ctx.runUsage({ inputTokens: 1, outputTokens: 2, costUsd: Number.NaN });
    ctx.runUsage({ inputTokens: 1, outputTokens: 2, requests: 1.5 });
    ctx.runUsage({ inputTokens: 1, outputTokens: 2, extra: "kept out" } as unknown as Parameters<PlannerContext["runUsage"]>[0]);
    ctx.runUsage("lots" as unknown as Parameters<PlannerContext["runUsage"]>[0]);
    return "done";
  });
  assert.deepEqual(finished?.usage, { inputTokens: 1, outputTokens: 2 }, "only the figures reach the record");

  const failed = await run(async (ctx) => {
    ctx.runUsage({ inputTokens: 5, cacheReadTokens: 50, outputTokens: 1, costUsd: 0.01 });
    throw new Error("turn failed");
  });
  assert.equal(failed?.outcome, "failed");
  assert.deepEqual(failed?.usage, { inputTokens: 5, cacheReadTokens: 50, outputTokens: 1, costUsd: 0.01 }, "a failed run was still paid for");

  const silent = await run(async () => "done");
  assert.equal(silent !== undefined && "usage" in silent, false, "a provider that reported nothing records nothing, not zero");

  // What arrives over IPC is checked the same way.
  const base = {
    runId: "run_1", seq: 2, at: "2026-01-01T00:00:00.000Z", type: "run-completed",
    outcome: "completed", summary: "done", verification: { verified: true, issues: [] },
  };
  assert.equal(isRunEvent(base), true);
  assert.equal(isRunEvent({ ...base, usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 } }), true);
  assert.equal(isRunEvent({ ...base, usage: { inputTokens: 1 } }), false);
  assert.equal(isRunEvent({ ...base, usage: { inputTokens: 1, outputTokens: 2, costUsd: -1 } }), false);
});

test("the planner receives the bounded conversation attached to its run", async () => {
  const conversation = {
    messages: [
      { role: "user" as const, text: "Build checkpoints" },
      { role: "assistant" as const, text: "I added them." },
    ],
    truncated: false,
  };
  let received = null as PlannerContext["conversation"] | null;
  let receivedAutoPlaytest = false;
  const session = new RunSession({
    caller: makeCaller(async () => outcome()),
    planner: planner(async (context) => {
      received = context.conversation;
      receivedAutoPlaytest = context.autoPlaytest;
      return "done";
    }),
    request: makeRequest({ conversation, autoPlaytest: true }),
    emit: () => undefined,
  });

  await session.execute();
  assert.deepEqual(received, conversation);
  assert.equal(receivedAutoPlaytest, true);
});

test("a successful solo playtest is stopped by the run before completion", async () => {
  const caller = makeCaller(async () => outcome());
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller,
    planner: planner(async (context) => {
      await context.call("solo_playtest", { action: "start", mode: "play" });
      return "playtest passed";
    }),
    request: makeRequest({
      approvalMode: "Auto approve",
      autoPlaytest: true,
      instanceId: "studio-1",
    }),
    emit: (event) => events.push(event),
  });

  assert.equal(await session.execute(), "completed");
  assert.deepEqual(caller.calls.map((call) => [call.tool, call.args.action]), [
    ["solo_playtest", "start"],
    ["solo_playtest", "stop"],
  ]);
  assert.equal(caller.calls[1].args.instance_id, "studio-1");
  assert.equal(caller.calls[1].signal, undefined, "cleanup does not inherit a cancelled run signal");
  assert.equal(caller.calls[1].timeoutMs, 20_000);
  const cleanupApproval = events.find((event) =>
    event.type === "approval-resolved" && event.reason === "run-cleanup");
  assert.ok(cleanupApproval);
  assert.equal(events.at(-1)?.type, "run-completed");
  assertAllValid(events);
});

test("each tool call carries its own budget rather than one flat timeout", async () => {
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (context) => {
      await context.call("capture_screenshot", {});
      await context.call("get_place_info", {});
      return "done";
    }),
    request: makeRequest({ approvalMode: "Auto approve" }),
    emit: () => undefined,
  });

  assert.equal(await session.execute(), "completed");
  assert.equal(caller.calls[0].timeoutMs, timeoutForTool("capture_screenshot"));
  assert.equal(caller.calls[1].timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
  assert.ok(
    (caller.calls[0].timeoutMs ?? 0) > (caller.calls[1].timeoutMs ?? 0),
    "a screenshot must outlast an ordinary read",
  );
});

test("manual playtest teardown prevents duplicate run cleanup", async () => {
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (context) => {
      await context.call("multiplayer_playtest", { action: "start", numPlayers: 2 });
      await context.call("multiplayer_playtest", { action: "end" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Auto approve", instanceId: "studio-1" }),
    emit: () => undefined,
  });

  assert.equal(await session.execute(), "completed");
  assert.deepEqual(caller.calls.map((call) => call.args.action), ["start", "end"]);
});

test("an unconfirmed multiplayer end is retried during host cleanup", async () => {
  let endCalls = 0;
  const caller = makeCaller(async (_tool, args) => {
    if (args.action !== "end") return outcome();
    endCalls += 1;
    return outcome({ data: { teardownConfirmed: endCalls > 1 } });
  });
  const session = new RunSession({
    caller,
    planner: planner(async (context) => {
      await context.call("multiplayer_playtest", { action: "start", numPlayers: 2 });
      await context.call("multiplayer_playtest", { action: "end" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Auto approve", instanceId: "studio-1" }),
    emit: () => undefined,
  });

  assert.equal(await session.execute(), "completed");
  assert.deepEqual(caller.calls.map((call) => call.args.action), ["start", "end", "end"]);
});

test("planner failure and cancellation still clean up a playtest the run started", async () => {
  for (const terminal of ["failure", "cancellation"] as const) {
    const caller = makeCaller(async () => outcome());
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const session = new RunSession({
      caller,
      planner: planner(async (context) => {
        await context.call("solo_playtest", { action: "start", mode: "run" });
        started();
        if (terminal === "failure") throw new Error("provider failed");
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new RunCancelledError()), { once: true });
        });
        return "unreachable";
      }),
      request: makeRequest({ approvalMode: "Auto approve", instanceId: "studio-1" }),
      emit: () => undefined,
    });

    const executing = session.execute();
    await didStart;
    if (terminal === "cancellation") session.cancel();

    assert.equal(await executing, terminal === "failure" ? "failed" : "cancelled");
    assert.deepEqual(caller.calls.map((call) => call.args.action), ["start", "stop"]);
  }
});

test("a failed host cleanup is visible as a run warning", async () => {
  const events: RunEvent[] = [];
  const caller = makeCaller(async (_tool, args) => args.action === "stop"
    ? outcome({ ok: false, errorCode: "timeout", message: "Studio did not stop" })
    : outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (context) => {
      await context.call("solo_playtest", { action: "start", mode: "play" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Auto approve", instanceId: "studio-1" }),
    emit: (event) => events.push(event),
  });

  assert.equal(await session.execute(), "completed");
  const failure = events.find((event) =>
    event.type === "failure" && event.failure.code === "playtest_cleanup_failed");
  assert.ok(failure);
  assert.equal(events.at(-1)?.type, "run-completed");
  assertAllValid(events);
});

/**
 * The bridge as the run that prompted this saw it: fine for a while, then
 * nothing listening, for every call after.
 */
function callerWhoseBridgeDies(afterCalls: number) {
  let made = 0;
  let alive = true;
  const caller = makeCaller(async (tool) => {
    made += 1;
    if (made === afterCalls + 1) alive = false;
    return alive
      ? outcome()
      : outcome({
        ok: false,
        httpStatus: 0,
        errorCode: "request_failed",
        message: `Nothing is listening at http://127.0.0.1:1234. (${tool})`,
      });
  });
  return { caller, revive: () => { alive = true; } };
}

test("a call that reached nothing asks the host, and a restarted bridge is told to the model in plain words", async () => {
  const events: RunEvent[] = [];
  const bridge = callerWhoseBridgeDies(1);
  let recoveries = 0;
  const results: McpToolOutcome[] = [];
  const session = new RunSession({
    caller: bridge.caller,
    bridge: {
      recover: async () => {
        recoveries += 1;
        bridge.revive();
        return { kind: "restarted", studioConnected: true };
      },
    },
    planner: planner(async (context) => {
      await context.call("get_place_info", {});
      results.push(await context.call("get_script_source", { path: "game.StarterGui.Shop" }));
      results.push(await context.call("get_connected_instances", {}));
      return "done";
    }),
    request: makeRequest({ approvalMode: "Full auto" }),
    emit: (event) => events.push(event),
  });

  assert.equal(await session.execute(), "completed");
  assert.equal(recoveries, 1);
  // The failed call still failed -- nothing ran -- but what the model reads is
  // what happened, not undici's "fetch failed", and it is told Studio is fine.
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.errorCode, "bridge_restarted");
  assert.match(results[0]?.message ?? "", /Roqer's Studio bridge stopped and has been restarted/);
  assert.match(results[0]?.message ?? "", /Studio has connected to it again/);
  assert.match(results[0]?.message ?? "", /playtest that was running is still running/);
  // The next call went through to the replacement.
  assert.equal(results[1]?.ok, true);
  // The person sees it in the timeline, not only the model.
  const status = events.find((event) => event.type === "status" && !event.transient && /bridge stopped and was restarted/.test(event.label));
  assert.ok(status, "the restart should be recorded as a step");
  const failure = events.find((event) => event.type === "failure");
  assert.equal(failure?.type === "failure" && failure.failure.code, "bridge_restarted");
  assert.equal(failure?.type === "failure" && failure.failure.retryable, true);
  assertAllValid(events);
});

test("a bridge that could not come back ends the run as failed, with the reason, instead of letting the model probe a dead port", async () => {
  const events: RunEvent[] = [];
  const bridge = callerWhoseBridgeDies(2);
  let recoveries = 0;
  let plannerSawAbort = false;
  const session = new RunSession({
    caller: bridge.caller,
    bridge: {
      recover: async () => {
        recoveries += 1;
        return { kind: "unavailable", message: "The Studio bridge could not be started after 4 attempts." };
      },
    },
    planner: planner(async (context) => {
      await context.call("solo_playtest", { action: "start", mode: "play" });
      await context.call("inspect_ui", {});
      try {
        await context.call("get_script_source", { path: "game.StarterGui.Shop" });
      } catch (error) {
        // Planners rethrow cancellations; this one checks the abort is one.
        plannerSawAbort = error instanceof RunCancelledError;
        throw error;
      }
      // The model in the real run got six more turns of this.
      await context.call("edit_script_batch", {});
      return "unreachable";
    }),
    request: makeRequest({ approvalMode: "Full auto", instanceId: "studio-1" }),
    emit: (event) => events.push(event),
  });

  assert.equal(await session.execute(), "failed");
  assert.equal(plannerSawAbort, true);
  assert.equal(recoveries, 1, "one question to the host, not one per failed call");
  // Nothing after the abort reached the bridge except the run's own cleanup
  // of the playtest it started, which is still owed even to a dead bridge.
  assert.deepEqual(bridge.caller.calls.map((call) => call.tool), [
    "solo_playtest", "inspect_ui", "get_script_source", "solo_playtest",
  ]);
  const completed = events.at(-1);
  assert.equal(completed?.type, "run-completed");
  if (completed?.type === "run-completed") {
    assert.equal(completed.outcome, "failed");
    assert.match(completed.summary, /Roqer's Studio bridge stopped and could not be restarted/);
    assert.match(completed.summary, /could not be started after 4 attempts/);
    assert.match(completed.summary, /Restart the bridge/);
  }
  const toolFailure = events.find((event) => event.type === "failure" && event.failure.tool === "get_script_source");
  assert.equal(toolFailure?.type === "failure" && toolFailure.failure.code, "bridge_unavailable");
  assertAllValid(events);
});

test("a bridge that answers after all leaves the failure as it was", async () => {
  const events: RunEvent[] = [];
  const bridge = callerWhoseBridgeDies(1);
  let result: McpToolOutcome | undefined;
  const session = new RunSession({
    caller: bridge.caller,
    bridge: { recover: async () => ({ kind: "answering" }) },
    planner: planner(async (context) => {
      await context.call("get_place_info", {});
      result = await context.call("get_script_source", { path: "game.StarterGui.Shop" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Full auto" }),
    emit: (event) => events.push(event),
  });

  assert.equal(await session.execute(), "completed");
  // A refused connection while the bridge was busy is the model's to retry;
  // the host has nothing to add and must not claim a restart it did not do.
  assert.equal(result?.errorCode, "request_failed");
  assert.equal(events.some((event) => event.type === "status" && /restarted/.test(event.label)), false);
});

test("a run against a bridge the host does not supervise gets no recovery", async () => {
  const bridge = callerWhoseBridgeDies(0);
  let result: McpToolOutcome | undefined;
  const session = new RunSession({
    caller: bridge.caller,
    planner: planner(async (context) => {
      result = await context.call("get_place_info", {});
      return "done";
    }),
    request: makeRequest({ approvalMode: "Full auto" }),
    emit: () => undefined,
  });

  assert.equal(await session.execute(), "completed");
  assert.equal(result?.errorCode, "request_failed");
  assert.match(result?.message ?? "", /Nothing is listening/);
});

test("Read only returns a structured refusal and lets the planner continue", async () => {
  const events: RunEvent[] = [];
  let refused: McpToolOutcome | undefined;
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      refused = await ctx.call("set_properties", { instancePath: "x" });
      await ctx.call("get_place_info", {});
      return "continued with inspection";
    }),
    request: makeRequest({ approvalMode: "Read only" }),
    emit: (event) => events.push(event),
  });

  const result = await session.execute();

  assert.equal(result, "completed");
  assert.equal(refused?.ok, false);
  assert.equal(refused?.errorCode, "approval_rejected");
  assert.match(refused?.message ?? "", /permitted alternative/);
  assert.deepEqual(caller.calls.map(({ tool }) => tool), ["get_place_info"]);

  const resolved = events.find(
    (event): event is Extract<RunEvent, { type: "approval-resolved" }> => event.type === "approval-resolved",
  );
  assert.ok(resolved);
  assert.equal(resolved.decision, "rejected");
  assert.equal(resolved.automatic, true);
  assert.equal(resolved.reason, "read-only-mode");
  assert.equal(events.some((event) => event.type === "tool-started" && event.tool === "set_properties"), false);
  assertAllValid(events);
});

test("Read only allows an upload status check but still refuses an upload", async () => {
  const events: RunEvent[] = [];
  const caller = makeCaller(async () => outcome());
  let refused: McpToolOutcome | undefined;
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("upload_asset", { action: "status", operationId: "upload-123" });
      refused = await ctx.call("upload_asset", {
        action: "upload",
        filePath: "C:/tmp/model.rbxm",
        assetType: "Model",
        displayName: "Model",
      });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Read only" }),
    emit: (event) => events.push(event),
  });

  assert.equal(await session.execute(), "completed");
  assert.equal(refused?.errorCode, "approval_rejected");
  assert.deepEqual(caller.calls.map(({ tool, args }) => ({ tool, action: args.action })), [
    { tool: "upload_asset", action: "status" },
  ]);
  const proposals = events.filter(
    (event): event is Extract<RunEvent, { type: "tool-proposed" }> => event.type === "tool-proposed",
  );
  assert.deepEqual(proposals.map(({ proposal }) => proposal.risk), ["read", "irreversible"]);
  assert.equal(events.some((event) => event.type === "approval-requested"), false);
  assertAllValid(events);
});

test("Read only runs a profiler capture but refuses one that would write a file", async () => {
  const events: RunEvent[] = [];
  const caller = makeCaller(async () => outcome());
  let refused: McpToolOutcome | undefined;
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("capture_micro_profiler", { frame_window: 240 });
      refused = await ctx.call("capture_micro_profiler", { output_path: "C:/Users/creator/Documents/profile.json" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Read only" }),
    emit: (event) => events.push(event),
  });

  assert.equal(await session.execute(), "completed");
  assert.equal(refused?.errorCode, "approval_rejected");
  assert.deepEqual(caller.calls.map(({ tool, args }) => ({ tool, outputPath: args.output_path })), [
    { tool: "capture_micro_profiler", outputPath: undefined },
  ]);
  const proposals = events.filter(
    (event): event is Extract<RunEvent, { type: "tool-proposed" }> => event.type === "tool-proposed",
  );
  assert.deepEqual(proposals.map(({ proposal }) => proposal.risk), ["read", "mutation"]);
  assertAllValid(events);
});

test("Auto approve allows a mutation silently but still asks for an irreversible tool", async () => {
  const events: RunEvent[] = [];
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("set_properties", { instancePath: "x" });
      await ctx.call("execute_luau", { code: "print(1)" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Auto approve" }),
    emit: (event) => {
      events.push(event);
      if (event.type === "approval-requested") session.resolveApproval(event.callId, "approved");
    },
  });

  const result = await session.execute();
  assert.equal(result, "completed");

  const proposals = events.filter(
    (event): event is Extract<RunEvent, { type: "tool-proposed" }> => event.type === "tool-proposed",
  );
  const setPropertiesCallId = proposals.find((p) => p.proposal.tool === "set_properties")?.proposal.callId;
  const executeLuauCallId = proposals.find((p) => p.proposal.tool === "execute_luau")?.proposal.callId;
  assert.ok(setPropertiesCallId);
  assert.ok(executeLuauCallId);

  const requests = events.filter((event) => event.type === "approval-requested");
  assert.equal(requests.length, 1);

  const resolutions = events.filter(
    (event): event is Extract<RunEvent, { type: "approval-resolved" }> => event.type === "approval-resolved",
  );
  const setPropertiesResolution = resolutions.find((r) => r.callId === setPropertiesCallId);
  const executeLuauResolution = resolutions.find((r) => r.callId === executeLuauCallId);
  assert.equal(setPropertiesResolution?.automatic, true);
  assert.equal(executeLuauResolution?.automatic, false);
  assertAllValid(events);
});

test("Full auto runs an irreversible tool without asking", async () => {
  const events: RunEvent[] = [];
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("execute_luau", { code: "print(1)" });
      await ctx.call("upload_asset", { path: "C:/tmp/model.rbxm" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Full auto" }),
    emit: (event) => events.push(event),
  });

  const result = await session.execute();

  assert.equal(result, "completed");
  assert.equal(events.filter((event) => event.type === "approval-requested").length, 0);
  const resolutions = events.filter(
    (event): event is Extract<RunEvent, { type: "approval-resolved" }> => event.type === "approval-resolved",
  );
  assert.equal(resolutions.length, 2);
  for (const resolution of resolutions) {
    assert.equal(resolution.decision, "approved");
    assert.equal(resolution.automatic, true);
    assert.equal(resolution.reason, "full-auto-approved");
  }
  assert.deepEqual(caller.calls.map((call) => call.tool), ["execute_luau", "upload_asset"]);
  assertAllValid(events);
});

/**
 * Fail closed: `Full auto` waives confirmation for classified actions, and a
 * tool the risk table does not know has no classification to waive.
 */
test("Full auto still asks for a tool missing from the risk table", async () => {
  const events: RunEvent[] = [];
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("brand_new_tool", { instancePath: "x" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Full auto" }),
    emit: (event) => {
      events.push(event);
      if (event.type === "approval-requested") session.resolveApproval(event.callId, "rejected");
    },
  });

  const result = await session.execute();

  assert.equal(result, "completed");
  const requests = events.filter(
    (event): event is Extract<RunEvent, { type: "approval-requested" }> => event.type === "approval-requested",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.reason, "irreversible-requires-approval");
  assert.equal(caller.calls.length, 0);
  assertAllValid(events);
});

test("Ask first waits for resolveApproval and rejects a duplicate resolution", async () => {
  const events: RunEvent[] = [];
  let approvalCallId: string | undefined;
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("set_properties", { instancePath: "x" });
      return "done";
    }),
    request: makeRequest({ approvalMode: "Ask first" }),
    emit: (event) => {
      events.push(event);
      if (event.type === "approval-requested") approvalCallId = event.callId;
    },
  });

  const executePromise = session.execute();
  await flush();
  assert.ok(approvalCallId);

  const firstResolution = session.resolveApproval(approvalCallId!, "approved");
  assert.equal(firstResolution, true);
  const secondResolution = session.resolveApproval(approvalCallId!, "approved");
  assert.equal(secondResolution, false);

  const result = await executePromise;
  assert.equal(result, "completed");
  assertAllValid(events);
});

test("a rejected action returns to the planner and its canonical equivalent never prompts again", async () => {
  const events: RunEvent[] = [];
  const results: McpToolOutcome[] = [];
  let approvalRequests = 0;
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      results.push(await ctx.call("set_properties", {
        instancePath: "x",
        properties: { Transparency: 0.5, Anchored: true },
      }));
      results.push(await ctx.call("set_properties", {
        properties: { Anchored: true, Transparency: 0.5 },
        instancePath: "x",
      }));
      results.push(await ctx.call("set_properties", {
        instancePath: "x",
        properties: { Transparency: 0.75, Anchored: true },
      }));
      return "used a permitted alternative";
    }),
    request: makeRequest({ approvalMode: "Ask first" }),
    emit: (event) => {
      events.push(event);
      if (event.type === "approval-requested") {
        approvalRequests += 1;
        session.resolveApproval(event.callId, approvalRequests === 1 ? "rejected" : "approved");
      }
    },
  });

  const result = await session.execute();
  assert.equal(result, "completed");
  assert.equal(approvalRequests, 2, "the reordered repeat must not ask again");
  assert.deepEqual(results.map(({ ok, errorCode }) => ({ ok, errorCode })), [
    { ok: false, errorCode: "approval_rejected" },
    { ok: false, errorCode: "approval_rejected" },
    { ok: true, errorCode: undefined },
  ]);
  assert.match(results[1].message ?? "", /already rejected earlier in this run/);
  assert.equal(caller.calls.length, 1);
  assert.deepEqual(caller.calls[0].args.properties, { Transparency: 0.75, Anchored: true });
  const repeated = events.find((event) =>
    event.type === "approval-resolved" && event.reason === "previously-rejected");
  assert.ok(repeated);
  assert.equal(events.some((event) => event.type === "failure"), false);
  assertAllValid(events);
});

test("parallel equivalent proposals share one approval prompt and never execute twice", async () => {
  const events: RunEvent[] = [];
  let approvalCallId: string | undefined;
  let duplicate: McpToolOutcome | undefined;
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      const first = ctx.call("set_properties", {
        instancePath: "x",
        properties: { Anchored: true, Transparency: 0.5 },
      });
      duplicate = await ctx.call("set_properties", {
        properties: { Transparency: 0.5, Anchored: true },
        instancePath: "x",
      });
      await first;
      return "done";
    }),
    request: makeRequest({ approvalMode: "Ask first" }),
    emit: (event) => {
      events.push(event);
      if (event.type === "approval-requested") approvalCallId = event.callId;
    },
  });

  const executing = session.execute();
  await flush();
  assert.ok(approvalCallId);
  assert.equal(session.resolveApproval(approvalCallId!, "approved"), true);
  assert.equal(await executing, "completed");
  assert.equal(duplicate?.errorCode, "equivalent_action_pending");
  assert.equal(events.filter((event) => event.type === "approval-requested").length, 1);
  assert.equal(caller.calls.length, 1);
  assertAllValid(events);
});

test("cancel() during a pending approval cancels the run and blocks further calls", async () => {
  const events: RunEvent[] = [];
  let firstCallError: unknown;
  let secondCallAttempted = false;
  let secondCallError: unknown;
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      try {
        await ctx.call("set_properties", { instancePath: "x" });
      } catch (error) {
        firstCallError = error;
      }
      secondCallAttempted = true;
      try {
        await ctx.call("get_place_info", {});
      } catch (error) {
        secondCallError = error;
      }
      return "done";
    }),
    request: makeRequest({ approvalMode: "Ask first" }),
    emit: (event) => events.push(event),
  });

  const executePromise = session.execute();
  await flush();
  session.cancel();
  const result = await executePromise;

  assert.equal(result, "cancelled");
  assert.ok(firstCallError instanceof RunCancelledError);
  assert.equal(secondCallAttempted, true);
  assert.ok(secondCallError instanceof RunCancelledError);
  assert.equal(
    events.some((event) => event.type === "tool-proposed" && event.proposal.tool === "get_place_info"),
    false,
  );
  assertAllValid(events);
});

test("cancel() during an in-flight tool call aborts the signal handed to callTool", async () => {
  let capturedSignal: AbortSignal | undefined;
  let resolveCall!: (value: McpToolOutcome) => void;
  const pendingCall = new Promise<McpToolOutcome>((resolve) => {
    resolveCall = resolve;
  });
  const caller = makeCaller(async (_tool, _args, options) => {
    capturedSignal = options?.signal;
    return pendingCall;
  });
  const events: RunEvent[] = [];
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("get_place_info", {});
      return "done";
    }),
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  const executePromise = session.execute();
  await flush();

  assert.ok(capturedSignal);
  assert.equal(capturedSignal?.aborted, false);
  session.cancel();
  assert.equal(capturedSignal?.aborted, true);

  resolveCall(outcome());
  const result = await executePromise;
  assert.equal(result, "cancelled");
});

test("a failing tool outcome still reaches the planner and emits a failure event", async () => {
  const events: RunEvent[] = [];
  let receivedOutcome: McpToolOutcome | undefined;
  const caller = makeCaller(async () => outcome({ ok: false, errorCode: "timeout", message: "took too long" }));
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      receivedOutcome = await ctx.call("get_place_info", {});
      return "done";
    }),
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  const result = await session.execute();
  assert.equal(result, "completed");
  assert.equal(receivedOutcome?.ok, false);

  const toolResult = events.find(
    (event): event is Extract<RunEvent, { type: "tool-result" }> => event.type === "tool-result",
  );
  assert.ok(toolResult);
  assert.equal(toolResult.ok, false);

  const failure = events.find(
    (event): event is Extract<RunEvent, { type: "failure" }> => event.type === "failure",
  );
  assert.ok(failure);
  assert.equal(failure.failure.code, "timeout");
  assert.equal(failure.failure.retryable, true);
  assertAllValid(events);
});

test("a request_failed error is retryable and other error codes are not", async () => {
  const events: RunEvent[] = [];
  const caller = makeCaller(async () => outcome({ ok: false, errorCode: "unauthorized" }));
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("get_place_info", {});
      return "done";
    }),
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  await session.execute();
  const failure = events.find(
    (event): event is Extract<RunEvent, { type: "failure" }> => event.type === "failure",
  );
  assert.ok(failure);
  assert.equal(failure.failure.retryable, false);
});

/**
 * A planner that passes its own `instance_id` has copied an opaque string out
 * of a tool result, and one wrong hex digit spends the run being told "not
 * connected". The run knows which Studio the user is working in, so it decides.
 */
test("every Studio call is addressed at the run's instance, whatever the planner passed", async () => {
  const events: RunEvent[] = [];
  const receivedArgs: Record<string, unknown>[] = [];
  const caller = makeCaller(async (_tool, args) => {
    receivedArgs.push(args);
    return outcome();
  });
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("get_place_info", {});
      await ctx.call("search_objects", { query: "x", instance_id: "anon:copied-wrong" });
      // The exception: this one names the process to act on.
      await ctx.call("manage_instance", { action: "close", instance_id: "another-studio" });
      return "done";
    }),
    request: makeRequest({ instanceId: "inst-1", approvalMode: "Full auto" }),
    emit: (event) => events.push(event),
  });

  await session.execute();

  const proposals = events.filter(
    (event): event is Extract<RunEvent, { type: "tool-proposed" }> => event.type === "tool-proposed",
  );
  // What the user is shown and what is sent must be the same call.
  assert.deepEqual(
    proposals.map((event) => event.proposal.arguments.instance_id),
    ["inst-1", "inst-1", "another-studio"],
  );
  assert.deepEqual(
    receivedArgs.map((args) => args.instance_id),
    ["inst-1", "inst-1", "another-studio"],
  );
  assertAllValid(events);
});

test("manage_instance keeps a launch_id rather than being redirected to the run's instance", async () => {
  const receivedArgs: Record<string, unknown>[] = [];
  const caller = makeCaller(async (_tool, args) => {
    receivedArgs.push(args);
    return outcome();
  });
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      await ctx.call("manage_instance", { action: "status", launch_id: "launch-9" });
      return "done";
    }),
    request: makeRequest({ instanceId: "inst-1", approvalMode: "Full auto" }),
    emit: () => undefined,
  });

  await session.execute();

  assert.equal(receivedArgs[0]?.launch_id, "launch-9");
  assert.equal(receivedArgs[0]?.instance_id, undefined);
});

test("nothing is emitted after run-completed even if the planner keeps calling say()", async () => {
  const events: RunEvent[] = [];
  let lateContext: PlannerContext | undefined;
  const caller = makeCaller(async () => outcome());
  const session = new RunSession({
    caller,
    planner: planner(async (ctx) => {
      lateContext = ctx;
      return "done";
    }),
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  await session.execute();
  const countBefore = events.length;

  lateContext?.say("too late");
  lateContext?.status("too late");
  lateContext?.recordChange({ kind: "properties", target: "x", summary: "too late" });
  lateContext?.recordEvidence({ kind: "inspection", title: "too late" });

  assert.equal(events.length, countBefore);
  assertAllValid(events);
});


test("the host's preview encoder reaches the planner, and an oversized preview is dropped", async () => {
  const events: RunEvent[] = [];
  const previewed: string[] = [];
  const valid = "data:image/jpeg;base64,cHJldmlldw==";
  const session = new RunSession({
    caller: makeCaller(async () => outcome()),
    planner: planner(async (ctx) => {
      const made = await ctx.previewImage?.({ data: "QUJD", mediaType: "image/png" });
      ctx.recordEvidence({ kind: "screenshot", title: "kept", imageDataUrl: made });
      ctx.recordEvidence({ kind: "screenshot", title: "oversized", imageDataUrl: `data:image/jpeg;base64,${"A".repeat(200_000)}` });
      ctx.recordEvidence({ kind: "screenshot", title: "not an image", imageDataUrl: "javascript:alert(1)" });
      return "done";
    }),
    previewImage: async (image) => { previewed.push(image.data); return valid; },
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  await session.execute();

  const evidence = events.flatMap((event) => (event.type === "evidence" ? [event.evidence] : []));
  assert.deepEqual(previewed, ["QUJD"]);
  assert.deepEqual(evidence.map((item) => [item.title, item.imageDataUrl]), [
    ["kept", valid],
    ["oversized", undefined],
    ["not an image", undefined],
  ]);
  assertAllValid(events);
});

test("a preview the host stores carries its ref, and only a picture the run stored gets one", async () => {
  const events: RunEvent[] = [];
  const stored = "data:image/jpeg;base64,c3RvcmVk";
  const refused = "data:image/jpeg;base64,cmVmdXNlZA==";
  const ref = `${"a".repeat(64)}.jpg`;
  const outputs = [stored, refused];
  const session = new RunSession({
    caller: makeCaller(async () => outcome()),
    planner: planner(async (ctx) => {
      const first = await ctx.previewImage?.({ data: "QUJD", mediaType: "image/png" });
      const second = await ctx.previewImage?.({ data: "REVG", mediaType: "image/png" });
      ctx.recordEvidence({ kind: "screenshot", title: "stored", imageDataUrl: first });
      ctx.recordEvidence({ kind: "screenshot", title: "the same picture again", imageDataUrl: first });
      ctx.recordEvidence({ kind: "screenshot", title: "not stored", imageDataUrl: second });
      // A planner cannot point evidence at a stored picture of its choosing.
      ctx.recordEvidence({ kind: "screenshot", title: "named by the planner", imageRef: `${"b".repeat(64)}.jpg` });
      return "done";
    }),
    previewImage: async () => outputs.shift(),
    storePicture: async (url) => (url === stored ? ref : undefined),
    request: makeRequest(),
    emit: (event) => events.push(event),
  });

  await session.execute();

  const evidence = events.flatMap((event) => (event.type === "evidence" ? [event.evidence] : []));
  assert.deepEqual(evidence.map((item) => [item.title, item.imageDataUrl, item.imageRef]), [
    ["stored", stored, ref],
    ["the same picture again", stored, ref],
    ["not stored", refused, undefined],
    ["named by the planner", undefined, undefined],
  ]);
  assertAllValid(events);
});

test("a planner context has no preview encoder when the host supplied none", async () => {
  let context: PlannerContext | undefined;
  const session = new RunSession({
    caller: makeCaller(async () => outcome()),
    planner: planner(async (ctx) => { context = ctx; return "done"; }),
    request: makeRequest(),
    emit: () => undefined,
  });

  await session.execute();

  assert.equal(context?.previewImage, undefined);
});
