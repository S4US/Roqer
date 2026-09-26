/**
 * The harness under a fake bridge.
 *
 * There is no Studio here, so the caller answers `execute_luau` with whatever
 * the test wants the place to look like. That is enough to pin the parts a
 * live run cannot check cheaply: that the fixture is reset before the agent
 * runs, that the oracle sees the probe, that off-target writes are noticed, and
 * that the trajectory file is a readable record rather than a summary.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { McpToolCaller, McpToolOutcome } from "../runtime/mcp-types";
import type { Planner, PlannerContext } from "../runtime/run-engine";
import { formatEvalResult, requireUploads, runEvalTask } from "./harness";
import { EVAL_TASKS, type EvalTask } from "./tasks";
import type { EvalPlannerMetrics } from "./telemetry";

type Call = { tool: string; args: Record<string, unknown> };

function fakeCaller(probeResult: unknown): McpToolCaller & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async callTool(tool, args): Promise<McpToolOutcome> {
      calls.push({ tool, args });
      const code = typeof args.code === "string" ? args.code : "";
      // The seed program creates the folder; the probe program reads it back.
      const isProbe = code.includes("if not root then return { missing = true } end");
      return {
        ok: true,
        data: isProbe ? { result: probeResult } : { result: { ok: true } },
        text: "",
        httpStatus: 200,
        durationMs: 1,
      };
    },
  };
}

function fakePlanner(body: (context: PlannerContext) => Promise<string>): Planner {
  return { id: "fake", run: body };
}

const PASSING_TASK: EvalTask = {
  id: "unit-task",
  prompt: "Do the thing",
  seed: "local marker = Instance.new('Folder') marker.Parent = root",
  probe: "return { done = true }",
  allowedTargets: ["game.ServerStorage.WorkbenchEval.Thing"],
  oracle: ({ probe, verified }) => {
    const done = typeof probe === "object" && probe !== null && (probe as { done?: unknown }).done === true;
    return done && verified
      ? { passed: true, detail: "Did the thing." }
      : { passed: false, detail: "Did not do the thing." };
  },
};

async function withTempDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-eval-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the fixture is reset before the agent runs and probed after", async () => {
  await withTempDirectory(async (directory) => {
    const caller = fakeCaller({ done: true });
    const order: string[] = [];

    await runEvalTask({
      caller,
      createPlanner: () => fakePlanner(async () => {
        order.push("agent");
        return "done";
      }),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: "studio-1",
      endpoint: "http://127.0.0.1:1234",
    });

    const luau = caller.calls.filter((call) => call.tool === "execute_luau");
    assert.equal(luau.length, 2, "one reset, one probe");
    assert.match(String(luau[0].args.code), /existing:Destroy\(\)/, "the reset destroys the old fixture first");
    assert.match(String(luau[0].args.code), /marker/, "and rebuilds from the task's own seed");
    assert.equal(luau[0].args.instance_id, "studio-1", "the selected instance is routed through");
    assert.deepEqual(order, ["agent"], "the agent ran between them");
  });
});

test("a passing run is scored from the probe and the completion gate", async () => {
  await withTempDirectory(async (directory) => {
    const result = await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async () => "done"),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
    });

    assert.equal(result.verdict.passed, true);
    assert.equal(result.verified, true);
    assert.deepEqual(result.gateIssues, []);
    assert.deepEqual(result.offTargetWrites, []);
  });
});

test("a probe returned as a JSON string is read, not scored as a missing fixture", async () => {
  await withTempDirectory(async (directory) => {
    // The shape the live bridge actually returns. Read wrongly it is invisible:
    // the probe succeeds, the oracle sees none of its fields, and a run that
    // did the work exactly is reported as having destroyed the fixture.
    const caller: McpToolCaller = {
      async callTool(_tool, args): Promise<McpToolOutcome> {
        const code = typeof args.code === "string" ? args.code : "";
        const isProbe = code.includes("if not root then return { missing = true } end");
        return {
          ok: true,
          data: isProbe
            ? { returnValue: JSON.stringify({ done: true }), message: "Code executed successfully", success: true }
            : { returnValue: "null", success: true },
          text: "",
          httpStatus: 200,
          durationMs: 1,
        };
      },
    };

    // Identical to the passing-run test above except for the probe's shape, so
    // a failure here can only be the reader.
    const result = await runEvalTask({
      caller,
      createPlanner: () => fakePlanner(async () => "done"),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: "studio-1",
      endpoint: "http://127.0.0.1:1234",
    });

    assert.equal(result.verdict.passed, true, result.verdict.detail);
  });
});

test("a run with nobody watching answers what the engine stops on instead of hanging", async () => {
  await withTempDirectory(async (directory) => {
    // Both of these park on a `Deferred` that only a renderer resolves. Before
    // the harness answered them, the first one an agent reached drained the
    // event loop and the process exited partway through the run, writing no
    // trajectory and saying nothing about why.
    let answer = "";
    let unclassified: McpToolOutcome | undefined;
    await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async (context) => {
        answer = await context.askUser("Which colour?", ["Red", "Blue"]);
        unclassified = await context.call("not_a_real_tool", {});
        return "done";
      }),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: "studio-1",
      endpoint: "http://127.0.0.1:1234",
    });

    // The model's own first option, never text the harness invented. Reaching
    // this line at all is most of the point: it means the run came back.
    assert.equal(answer, "Red");

    // `Full auto` covers every classified risk, so an approval that still
    // arrives is a tool nobody classified -- refused rather than run unattended.
    assert.equal(unclassified?.ok, false);
  });
});

test("provider telemetry adds model, context, token, and client-tool metrics", async () => {
  await withTempDirectory(async (directory) => {
    const plannerMetrics: EvalPlannerMetrics = {
      modelTurns: 3,
      stalledTurns: 1,
      retriedAttempts: 0,
      measuredUsageTurns: 2,
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 80,
      accumulatedContextTokens: 150,
      peakTurnContextCharacters: 1_200,
      toolResultCharacters: 90,
      streamDurationMs: 9_000,
      timeToFirstEventMs: 6_000,
      streamTailMs: 2_400,
      toolDurationMs: 7,
      modelToolCalls: [
        { turn: 1, tool: "load_skill", ok: true, durationMs: 1, resultCharacters: 40 },
        { turn: 2, tool: "get_script_source", ok: false, durationMs: 2, resultCharacters: 20 },
        { turn: 2, tool: "get_script_source", ok: true, durationMs: 1, resultCharacters: 20 },
        { turn: 3, tool: "set_properties", ok: true, durationMs: 3, resultCharacters: 10 },
      ],
      turns: [
        { turn: 1, durationMs: 3_000, firstEventMs: 2_000, requestCharacters: 400,
          estimatedInputTokens: 100, completed: true, toolsMs: 1, toolCalls: 1 },
        { turn: 2, durationMs: 3_000, firstEventMs: 2_000, requestCharacters: 800,
          estimatedInputTokens: 100, completed: true, toolsMs: 3, toolCalls: 2 },
        { turn: 3, durationMs: 3_000, firstEventMs: 2_000, requestCharacters: 1_200,
          estimatedInputTokens: 100, completed: true, toolsMs: 3, toolCalls: 1 },
      ],
    };
    const result = await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async () => "done"),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
      provider: "custom",
      plannerMetrics: () => plannerMetrics,
    });

    assert.equal(result.metrics.modelTurns, 3);
    assert.equal(result.metrics.totalToolCalls, 4);
    assert.equal(result.metrics.distinctTools, 3);
    assert.equal(result.metrics.callsBeforeFirstMutation, 3);
    assert.equal(result.metrics.reads, 2);
    assert.equal(result.metrics.writes, 1);
    assert.equal(result.metrics.skillLoads, 1);
    assert.equal(result.metrics.failedCalls, 1);
    assert.equal(result.metrics.repairLoops, 1);
    assert.equal(result.metrics.peakTurnContextCharacters, 1_200);
    // The latency split reaches the record and the summary line, so a run that
    // was slow waiting on the provider can be told from one that was slow
    // because Roqer sat on the answer after it arrived.
    assert.equal(result.metrics.timeToFirstEventMs, 6_000);
    assert.equal(result.metrics.streamTailMs, 2_400);
    assert.equal(result.metrics.toolDurationMs, 7);
    assert.match(formatEvalResult(result), /wait 6\.0s · tools 0\.0s · tail 2\.4s/);
    assert.equal(result.metrics.accumulatedContextTokens, 150);
    assert.equal(result.metrics.measuredInputTokens, 120);
    assert.equal(result.metrics.cachedInputTokens, 80);

    // The totals say where the run's time went; the per-turn lines say whether
    // it was getting worse. A wait that is flat and one that climbs with the
    // request sum identically and have different causes, so the trend has to
    // survive into the trajectory rather than being averaged away.
    const parsed = (await readFile(result.trajectoryPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { kind: string; turn?: Record<string, number> });
    const turns = parsed.filter((entry) => entry.kind === "turn").map((entry) => entry.turn!);
    assert.deepEqual(turns.map((turn) => turn.turn), [1, 2, 3]);
    assert.deepEqual(turns.map((turn) => turn.requestCharacters), [400, 800, 1_200]);
    assert.deepEqual(turns.map((turn) => turn.toolCalls), [1, 2, 1]);
    // They sit between the events and the verdict, so a reader walking the file
    // meets the run, then what happened, then the shape of it, then the score.
    assert.equal(parsed[0].kind, "run");
    assert.equal(parsed[parsed.length - 1].kind, "verdict");
    assert.equal(parsed[parsed.length - 4].kind, "turn");
  });
});

test("an unverified change fails the gate and the task with it", async () => {
  await withTempDirectory(async (directory) => {
    const result = await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async (context) => {
        context.recordChange({
          kind: "script-source",
          target: "game.ServerStorage.WorkbenchEval.Thing",
          summary: "Wrote it",
          revisionAfter: "rev-2",
        });
        return "done";
      }),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
    });

    assert.equal(result.verified, false);
    assert.equal(result.verdict.passed, false, "the oracle refuses an unverified run");
    assert.equal(result.gateIssues.length, 1);
  });
});

test("a run that stops partway is reported as stopped, with the reason, not as the agent failing", async () => {
  await withTempDirectory(async (directory) => {
    const result = await runEvalTask({
      caller: fakeCaller({ found: false }),
      createPlanner: () => fakePlanner(async () => {
        throw new Error("Your Roqer session is invalid or expired.");
      }),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
    });

    assert.equal(result.verdict.passed, false);
    assert.equal(result.stoppedBy, "Your Roqer session is invalid or expired.");
    assert.match(formatEvalResult(result), /^STOPPED unit-task · run ended early: Your Roqer session is invalid or expired\. · /);
    const verdictLine = JSON.parse((await readFile(result.trajectoryPath, "utf8")).trim().split("\n").at(-1)!) as { stoppedBy?: string };
    assert.equal(verdictLine.stoppedBy, "Your Roqer session is invalid or expired.");
  });
});

test("a write outside the task's declared targets is reported", async () => {
  await withTempDirectory(async (directory) => {
    const result = await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async (context) => {
        context.recordChange({ kind: "properties", target: "game.Workspace.SomethingElse", summary: "Oops" });
        return "done";
      }),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
    });

    assert.deepEqual(result.offTargetWrites, ["game.Workspace.SomethingElse"]);
  });
});

test("a task's reference image reaches the planner as an attached image and is named in the header", async () => {
  await withTempDirectory(async (directory) => {
    const fixtures = path.join(directory, "fixtures");
    await mkdir(fixtures);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await writeFile(path.join(fixtures, "style.png"), png);
    let seen: PlannerContext["images"] = [];
    const result = await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async (context) => {
        seen = context.images;
        return "done";
      }),
      task: { ...PASSING_TASK, referenceImage: "style.png" },
      outputDirectory: directory,
      fixturesDirectory: fixtures,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
    });
    assert.deepEqual(seen, [{ name: "style.png", mediaType: "image/png", data: png.toString("base64") }]);
    const header = JSON.parse((await readFile(result.trajectoryPath, "utf8")).split("\n")[0]) as { referenceImage?: string };
    assert.equal(header.referenceImage, "style.png");
  });
});

test("a task that names an interface is scored on the harness's own audit of it, recorded in the verdict line", async () => {
  await withTempDirectory(async (directory) => {
    const seen: Array<Record<string, unknown>> = [];
    const studio: McpToolCaller = {
      callTool: async (tool, args) => {
        if (tool === "get_connected_instances") return { ok: true, data: { instances: [{ id: "p", roles: ["client-1"] }] }, text: "", httpStatus: 200, durationMs: 1 };
        if (tool === "inspect_ui") {
          return { ok: true, data: {
            elements: [{ path: "Players.A.PlayerGui.Shop" }],
            audit: { success: true, issues: [{ code: "text_obscured", path: "Players.A.PlayerGui.Shop.Title" }] },
          }, text: "", httpStatus: 200, durationMs: 1 };
        }
        return fakeCaller({ done: true }).callTool(tool, args);
      },
    };
    const result = await runEvalTask({
      caller: studio,
      createPlanner: () => fakePlanner(async () => "done"),
      task: {
        ...PASSING_TASK,
        auditInterface: "Shop",
        oracle: (input) => {
          seen.push(input.interfaceAudit as Record<string, unknown>);
          return { passed: false, detail: "scored" };
        },
      },
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
      interfaceAuditOptions: { pollMs: 1, clientTimeoutMs: 50, guiTimeoutMs: 50 },
    });
    assert.deepEqual(seen, [{ ran: true, elements: 1, issues: [{ code: "text_obscured", path: "Players.A.PlayerGui.Shop.Title" }] }]);
    const verdictLine = JSON.parse((await readFile(result.trajectoryPath, "utf8")).trim().split("\n").at(-1)!) as { interfaceAudit?: unknown };
    assert.deepEqual(verdictLine.interfaceAudit, seen[0]);
  });
});

test("the shipped T13 reference image exists and is small enough to attach", async () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T13-reference-style")!;
  const bytes = await readFile(path.join(process.cwd(), "eval", "fixtures", task.referenceImage!));
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
  assert.ok(bytes.toString("base64").length <= 1_400_000, "within the per-image limit");
});

test("an upload is not a write to the place, and the header records the approval mode the run used", async () => {
  await withTempDirectory(async (directory) => {
    const result = await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async (context) => {
        context.recordChange({ kind: "asset", target: "rbxassetid://81943875412376", summary: "Uploaded", assetId: "81943875412376" });
        return "done";
      }),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
    });

    assert.deepEqual(result.offTargetWrites, []);
    const header = JSON.parse((await readFile(result.trajectoryPath, "utf8")).split("\n")[0]) as { approvalMode?: string };
    assert.equal(header.approvalMode, "Full auto");
  });
});

test("world evaluations allow isolated intent batches but report writes to a global registry", async () => {
  for (const task of EVAL_TASKS.filter((candidate) => candidate.id.startsWith("T7-") || candidate.id.startsWith("T8-"))) {
    await withTempDirectory(async (directory) => {
      const result = await runEvalTask({
        caller: fakeCaller({ done: true }),
        createPlanner: () => fakePlanner(async (context) => {
          for (const target of ["game.ServerStorage.WorkbenchEval.RoqerWorld", "game.ServerStorage.RoqerWorld"]) {
            context.recordChange({ kind: "instance", target, summary: "Saved world intent" });
          }
          return "done";
        }),
        task,
        outputDirectory: directory,
        instanceId: null,
        endpoint: "http://127.0.0.1:1234",
      });
      assert.deepEqual(result.offTargetWrites, ["game.ServerStorage.RoqerWorld"], task.id);
    });
  }
});

test("the village allows sub-roots of its own roots and nothing that merely shares a prefix", async () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T10-world-lowpoly-village")!;
  await withTempDirectory(async (directory) => {
    const result = await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async (context) => {
        for (const target of [
          "game.Workspace.WorkbenchEvalVillage",
          "game.Workspace.WorkbenchEvalVillage.Houses",
          "game.ServerStorage.WorkbenchEval.RoqerWorld.Kit",
          "game.Workspace.WorkbenchEvalVillageCopy",
          "game.ServerStorage.RoqerWorld",
        ]) {
          context.recordChange({ kind: "instance", target, summary: "Built" });
        }
        return "done";
      }),
      task,
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
    });
    assert.deepEqual(result.offTargetWrites, ["game.Workspace.WorkbenchEvalVillageCopy", "game.ServerStorage.RoqerWorld"]);
  });
});

test("the trajectory is every run event in order, between a header and a verdict", async () => {
  await withTempDirectory(async (directory) => {
    const result = await runEvalTask({
      caller: fakeCaller({ done: true }),
      createPlanner: () => fakePlanner(async (context) => {
        context.setTasks([{ id: "a", title: "Do it", status: "done", requiresRuntimeEvidence: false }]);
        return "done";
      }),
      task: PASSING_TASK,
      outputDirectory: directory,
      instanceId: null,
      endpoint: "http://127.0.0.1:1234",
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const lines = (await readFile(result.trajectoryPath, "utf8")).trim().split("\n");
    const parsed = lines.map((line) => JSON.parse(line) as { kind: string; event?: { type: string; seq: number } });

    assert.equal(parsed[0].kind, "run");
    assert.equal(parsed[parsed.length - 1].kind, "verdict");

    const events = parsed.filter((entry) => entry.kind === "event").map((entry) => entry.event!);
    assert.equal(events[0].type, "run-started");
    assert.equal(events[events.length - 1].type, "run-completed");
    assert.ok(events.some((event) => event.type === "tasks"), "the task list is in the record");
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
      "engine order is preserved exactly",
    );
  });
});

test("a reset the bridge rejects is an error, not a failing score", async () => {
  await withTempDirectory(async (directory) => {
    const failing: McpToolCaller = {
      async callTool(): Promise<McpToolOutcome> {
        return {
          ok: false, data: undefined, text: "", httpStatus: 500,
          errorCode: "tool_failed", message: "no Studio", durationMs: 1,
        };
      },
    };

    await assert.rejects(
      () => runEvalTask({
        caller: failing,
        createPlanner: () => fakePlanner(async () => "done"),
        task: PASSING_TASK,
        outputDirectory: directory,
        instanceId: null,
        endpoint: "http://127.0.0.1:1234",
      }),
      /Could not seed unit-task/,
    );
  });
});

test("every shipped task declares a prompt, a seed, a probe, and its targets", () => {
  assert.equal(EVAL_TASKS.length, 14);
  const ids = new Set(EVAL_TASKS.map((task) => task.id));
  assert.equal(ids.size, EVAL_TASKS.length, "task ids are unique");

  for (const task of EVAL_TASKS) {
    assert.ok(task.prompt.length > 0, `${task.id} has a prompt`);
    assert.ok(task.seed.trim().length > 0, `${task.id} has a seed`);
    assert.ok(task.probe.includes("return"), `${task.id} probes something back`);
    assert.ok(task.allowedTargets.length + (task.allowedRoots?.length ?? 0) > 0, `${task.id} declares its targets`);
  }
});

test("the runtime-evidence task fails a run that never observed anything", () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T3-runtime-evidence")!;
  const fixedSource = "local config = ServerStorage:WaitForChild(\"MissingConfig\", 5)\nif config then print(config.Name) end";

  const withoutPlaytest = task.oracle({
    probe: { found: true, source: fixedSource },
    outcome: "completed",
    verified: true,
    toolCalls: [{ tool: "set_script_source", ok: true }],
    changedTargets: [],
  });
  assert.equal(withoutPlaytest.passed, false);
  assert.match(withoutPlaytest.detail, /never observed at runtime/);

  const withPlaytest = task.oracle({
    probe: { found: true, source: fixedSource },
    outcome: "completed",
    verified: true,
    toolCalls: [{ tool: "set_script_source", ok: true }, { tool: "solo_playtest", ok: true }],
    changedTargets: [],
  });
  assert.equal(withPlaytest.passed, true);
});

test("the seeded-fault task recognises the dead local it planted", () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T2-seeded-fault")!;
  const unfixed = "local current = coins.Value\ncurrent = current + amount";
  const fixed = "coins.Value = coins.Value + amount";

  const before = task.oracle({
    probe: { found: true, source: unfixed },
    outcome: "completed", verified: true, toolCalls: [], changedTargets: [],
  });
  assert.equal(before.passed, false);
  assert.match(before.detail, /local that goes nowhere/);

  const after = task.oracle({
    probe: { found: true, source: fixed },
    outcome: "completed", verified: true, toolCalls: [], changedTargets: [],
  });
  assert.equal(after.passed, true);
});

test("the reference UI create requires six complete cards and both visual checks", () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T4-ui-create")!;
  const properties = {
    probe: { found: true, cards: 6, priced: 6, distinct: 6, imaged: 6 },
    outcome: "completed",
    verified: true,
    changedTargets: [],
  };
  assert.equal(task.oracle({ ...properties, toolCalls: [] }).passed, false);
  assert.equal(task.oracle({
    ...properties,
    toolCalls: [
      { tool: "solo_playtest", ok: true },
      { tool: "inspect_ui", ok: true },
      { tool: "capture_screenshot", ok: true },
    ],
  }).passed, true);
});

test("the reference UI edit checks the preview and its builder source", () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T5-ui-three-change-edit")!;
  const toolCalls = [
    { tool: "inspect_ui", ok: true },
    { tool: "capture_screenshot", ok: true },
  ];
  const common = { outcome: "completed", verified: true, toolCalls, changedTargets: [] };
  assert.equal(task.oracle({
    ...common,
    probe: {
      found: true,
      title: "Power Shop",
      cellWidth: 140,
      card6: "7500 Coins",
      source: "Power Shop UDim2.fromOffset(110, 90) 7500",
    },
  }).passed, false, "a preview-only edit is not enough");
  assert.equal(task.oracle({
    ...common,
    probe: {
      found: true,
      title: "Power Shop",
      cellWidth: 140,
      card6: "7500 Coins",
      source: "Power Shop UDim2.fromOffset(140, 90) 7500",
    },
  }).passed, true);
});

test("the purchase debug requires a dynamic price and two real interactions", () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T6-purchase-price-debug")!;
  const common = { outcome: "completed", verified: true, changedTargets: [] };
  const tools = [
    { tool: "solo_playtest", ok: true },
    { tool: "interact_ui", ok: true },
    { tool: "interact_ui", ok: true },
    { tool: "get_runtime_logs", ok: true },
  ];
  assert.equal(task.oracle({
    ...common,
    probe: { found: true, source: "balance.Value -= 100" },
    toolCalls: tools,
  }).passed, false);
  assert.equal(task.oracle({
    ...common,
    probe: { found: true, source: "balance.Value -= button:GetAttribute('Price')" },
    toolCalls: tools.slice(0, 3),
  }).passed, false, "logs are part of the runtime assertion");
  assert.equal(task.oracle({
    ...common,
    probe: { found: true, source: "balance.Value -= button:GetAttribute('Price')" },
    toolCalls: tools,
  }).passed, true);
});

test("the blocky island must be Part-built, at scale, and screenshotted", () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T7-world-blocky-island")!;
  const common = { outcome: "completed", verified: true, changedTargets: [] };
  const screenshot = [{ tool: "capture_screenshot", ok: true }];
  const island = {
    found: true, parts: 180, unanchored: 0, defaultGray: 0, trees: 7, spawns: 1,
    sizeX: 124, sizeY: 22, sizeZ: 118, terrainGrew: false,
  };
  assert.equal(task.oracle({ ...common, probe: island, toolCalls: screenshot }).passed, true);

  const terrain = task.oracle({ ...common, probe: { ...island, terrainGrew: true }, toolCalls: screenshot });
  assert.equal(terrain.passed, false);
  assert.match(terrain.detail, /Terrain instead of Parts/);
  // Terrain is judged even when the named root was never made: an agent that
  // answered with Terrain alone must be told that, not just "not built".
  const terrainOnly = task.oracle({ ...common, probe: { found: false, terrainGrew: true }, toolCalls: screenshot });
  assert.match(terrainOnly.detail, /Terrain instead of Parts/);

  assert.equal(task.oracle({ ...common, probe: { ...island, parts: 5000 }, toolCalls: screenshot }).passed, false);
  assert.equal(task.oracle({ ...common, probe: { ...island, defaultGray: 3 }, toolCalls: screenshot }).passed, false);
  assert.equal(task.oracle({ ...common, probe: { ...island, trees: 2 }, toolCalls: screenshot }).passed, false);
  assert.equal(task.oracle({ ...common, probe: { ...island, sizeX: 20, sizeZ: 20 }, toolCalls: screenshot }).passed, false);
  assert.equal(task.oracle({ ...common, probe: { ...island, sizeY: 2 }, toolCalls: screenshot }).passed, false);
  assert.equal(task.oracle({ ...common, probe: island, toolCalls: [] }).passed, false, "visual evidence is required");
  assert.equal(task.oracle({ ...common, verified: false, probe: island, toolCalls: screenshot }).passed, false);
});

test("the realistic meadow must add real Terrain and be screenshotted", () => {
  const task = EVAL_TASKS.find((candidate) => candidate.id === "T8-world-realistic-meadow")!;
  const common = { outcome: "completed", verified: true, changedTargets: [] };
  const screenshot = [{ tool: "capture_screenshot", ok: true }];
  assert.equal(task.oracle({ ...common, probe: { terrainAdded: 40_000, rootFound: true }, toolCalls: screenshot }).passed, true);
  const parts = task.oracle({ ...common, probe: { terrainAdded: 0, rootFound: true }, toolCalls: screenshot });
  assert.equal(parts.passed, false);
  assert.match(parts.detail, /not built with Terrain/);
  assert.equal(task.oracle({ ...common, probe: { terrainAdded: 120, rootFound: true }, toolCalls: screenshot }).passed, false);
  assert.equal(task.oracle({ ...common, probe: { terrainAdded: 40_000, rootFound: true }, toolCalls: [] }).passed, false);
});

test("a modeling run refuses a bridge with no Open Cloud key before any model is spent", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const bridge = (message: string): McpToolCaller => ({
    callTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: false, data: undefined, text: "", message, errorCode: "tool_failed", httpStatus: 200, durationMs: 1 };
    },
  });

  await assert.rejects(
    requireUploads(bridge("No Open Cloud API key is configured. Add one in Roqer Settings, then check the upload again."), "place:1", "http://127.0.0.1:58741"),
    /has no Roblox Open Cloud key/,
  );
  // With a key, the malformed ID is what fails, and nothing reached Roblox.
  await requireUploads(bridge("Asset upload operation ID is not valid."), "place:1", "http://127.0.0.1:58741");

  assert.deepEqual(calls[0], {
    tool: "upload_asset",
    args: { action: "status", operationId: "roqer eval preflight", instance_id: "place:1" },
  });
});
