/**
 * Command-line entry for the evaluation harness.
 *
 * Usage, from the repository root (`npm run eval -- <flags>`) or from
 * `apps/desktop` directly:
 *
 *   tsx eval/run.ts                      run every task on Claude Code
 *   tsx eval/run.ts --task T1-property-write
 *   tsx eval/run.ts --provider claude --model opus
 *   tsx eval/run.ts --provider endpoint --format openai --base-url https://openrouter.ai/api/v1 --model deepseek/deepseek-chat
 *   tsx eval/run.ts --task T11-world-adventure-edit --dry-run   seed and probe only, no model
 *   tsx eval/run.ts --task T12-model-prop --provider claude --model opus --blender auto
 *
 * `--provider endpoint` drives a model on an OpenAI-compatible or Anthropic
 * endpoint through Roqer's own agent loop, exactly as the app's Custom provider
 * does. Its key, when the endpoint needs one, is read from ROQER_EVAL_API_KEY
 * rather than a flag, so it stays out of shell history. `--images` and
 * `--reasoning` say what the model accepts, as the Custom model settings do.
 *
 * `--blender <path|auto>` offers the local Blender worker, as Settings →
 * Blender modeling does in the app; `auto` finds an installed Blender. A task
 * that needs it (T12) is skipped without the flag. Uploads use the Open Cloud
 * key of the bridge being driven, so a model task publishes a real asset.
 *
 * It needs a live MCP bridge with Roblox Studio connected, and for the Claude
 * provider a signed-in Claude Code CLI. Every task destroys and rebuilds
 * `ServerStorage.WorkbenchEval`, so never point it at a place you care about.
 */

import os from "node:os";
import path from "node:path";

import { BlenderWorker } from "../runtime/blender-worker";
import { ClaudeCodeClient, CLAUDE_DEFAULT_MODEL_ID } from "../runtime/claude-cli";
import { createClaudePlanner } from "../runtime/claude-planner";
import { createCustomTransport } from "../runtime/custom-provider";
import { loadAgentRuntime } from "../runtime/agent-definition";
import { createAgentLoopPlanner } from "../runtime/agent-loop";
import { withLocalOperations } from "../runtime/local-operations";
import { McpClient } from "../runtime/mcp-client";
import { BLENDER_OPERATION } from "../shared/blender";
import { CUSTOM_API_FORMATS, type CustomApiFormat, type CustomConnection } from "../shared/custom-providers";
import { isReasoningEffort, type ReasoningEffort } from "../shared/provider";
import { formatEvalResult, requireUploads, resolveBlender, runEvalTask, type EvalResult } from "./harness";
import { probePlace, resetPlace } from "./reset";
import { EVAL_TASKS, findEvalTask, type EvalTask } from "./tasks";
import { createEvalTelemetryCollector } from "./telemetry";

const DEFAULT_ENDPOINT = "http://127.0.0.1:58741";

type EndpointOptions = {
  format: CustomApiFormat;
  baseUrl: string;
  images: boolean;
  reasoning: boolean;
};

type Options = {
  endpoint: string;
  /** Seed and probe each task with no model, and score the untouched fixture. */
  dryRun: boolean;
  provider: "claude" | "endpoint";
  model?: string;
  effort?: ReasoningEffort;
  /** Where an `endpoint` run sends its turns. */
  modelEndpoint?: EndpointOptions;
  /** A Blender executable path, "auto" to find one, or absent for no worker. */
  blender?: string;
  outputDirectory: string;
  tasks: readonly EvalTask[];
};

function parseArguments(argv: readonly string[]): Options {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const taskId = flag("task");
  if (taskId !== undefined && findEvalTask(taskId) === undefined) {
    throw new Error(`Unknown task "${taskId}". Known tasks: ${EVAL_TASKS.map((task) => task.id).join(", ")}`);
  }
  const provider = flag("provider") ?? "claude";
  if (provider !== "claude" && provider !== "endpoint") {
    throw new Error(`Unknown provider "${provider}". Use claude or endpoint.`);
  }
  const effort = flag("effort");
  if (effort !== undefined && !isReasoningEffort(effort)) {
    throw new Error(`Unknown reasoning effort "${effort}".`);
  }

  let modelEndpoint: EndpointOptions | undefined;
  if (provider === "endpoint") {
    const format = flag("format") ?? "openai";
    if (!(CUSTOM_API_FORMATS as readonly string[]).includes(format)) {
      throw new Error(`Unknown endpoint format "${format}". Use ${CUSTOM_API_FORMATS.join(" or ")}.`);
    }
    const baseUrl = flag("base-url");
    if (baseUrl === undefined) throw new Error("An endpoint run needs --base-url, e.g. https://openrouter.ai/api/v1.");
    if (flag("model") === undefined) throw new Error("An endpoint run needs --model, the id the endpoint knows the model by.");
    modelEndpoint = {
      format: format as CustomApiFormat,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      images: argv.includes("--images"),
      reasoning: argv.includes("--reasoning"),
    };
  }

  return {
    endpoint: flag("endpoint") ?? DEFAULT_ENDPOINT,
    dryRun: argv.includes("--dry-run"),
    provider,
    ...(flag("model") === undefined ? {} : { model: flag("model") }),
    ...(effort === undefined ? {} : { effort }),
    ...(modelEndpoint === undefined ? {} : { modelEndpoint }),
    ...(flag("blender") === undefined ? {} : { blender: flag("blender") }),
    outputDirectory: flag("out") ?? path.join(process.cwd(), "eval", "results"),
    tasks: taskId === undefined ? EVAL_TASKS : [findEvalTask(taskId)!],
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const client = new McpClient({ endpoint: options.endpoint });

  const health = await client.health();
  if (!health.reachable) {
    throw new Error(`The MCP bridge at ${options.endpoint} is not reachable: ${health.message}`);
  }
  if (!health.pluginConnected) {
    throw new Error("The MCP bridge is running but no Roblox Studio instance is connected.");
  }
  const instanceId = health.instances[0]?.instanceId ?? null;

  // A new task's Luau is only ever checked by Studio, and finding a typo in a
  // seed after a paid model run is the expensive way to find it. This runs the
  // seed and probe alone and scores the untouched fixture, which every task
  // should fail, for the reason its seeded state implies.
  if (options.dryRun) {
    for (const task of options.tasks) {
      await resetPlace(client, task, instanceId);
      const probe = await probePlace(client, task, instanceId);
      const verdict = task.oracle({ probe, outcome: "completed", verified: false, toolCalls: [], changedTargets: [] });
      process.stdout.write(`${task.id} · seeded and probed · untouched fixture: ${verdict.detail}\n${JSON.stringify(probe)}\n`);
    }
    return;
  }

  // The same worker and routing the app uses when Blender is turned on, so a
  // modeling task measures the shipped path rather than a stand-in.
  const worker = options.blender === undefined
    ? undefined
    : new BlenderWorker({ executable: await resolveBlender(options.blender), jobsRoot: path.join(os.tmpdir(), "roqer-eval-blender-jobs") });
  const caller = worker === undefined
    ? client
    : withLocalOperations(client, new Map([[BLENDER_OPERATION, (args, call) => worker.run(args, call)]]));
  const blender = worker !== undefined;
  if (blender && options.tasks.some((task) => task.needsBlender === true)) {
    await requireUploads(client, instanceId, options.endpoint);
  }

  // `agent/` sits beside the built main process at runtime and beside this file
  // in the repository; the repository layout is the one a CLI run sees.
  const agentRuntime = await loadAgentRuntime(path.join(process.cwd(), "agent"));

  const claude = options.provider === "claude" ? new ClaudeCodeClient({ cwd: os.tmpdir() }) : undefined;
  if (claude !== undefined) {
    const status = await claude.getStatus();
    if (status.kind !== "signed-in") throw new Error(`Claude Code is not usable: ${status.message}`);
  }

  const model = options.model ?? CLAUDE_DEFAULT_MODEL_ID;
  const effort = options.effort ?? "medium";
  // Claude Code says which models take an effort only when asked for its list.
  if (claude !== undefined) {
    const claudeCatalog = await claude.listModels();
    // Claude Code lists its picker names ("opus"), not full ids ("claude-opus-5-5"),
    // so name them: the full id of a model the account has is refused here too.
    if (!claudeCatalog.models.some((entry) => entry.id === model)) {
      const offered = claudeCatalog.models.map((entry) => `${entry.id} (${entry.displayName})`).join(", ");
      throw new Error(`Claude Code does not list "${model}". Pass one of its model names: ${offered || "none listed"}.`);
    }
  }
  const supportsEffort = claude?.modelSupportsEffort(model) ?? false;

  const modelEndpoint = options.modelEndpoint;
  const connection: CustomConnection | undefined = modelEndpoint === undefined ? undefined : {
    id: "eval",
    name: new URL(modelEndpoint.baseUrl).host,
    format: modelEndpoint.format,
    baseUrl: modelEndpoint.baseUrl,
    models: [{ id: model, displayName: model, images: modelEndpoint.images, reasoning: modelEndpoint.reasoning }],
  };
  const apiKey = process.env.ROQER_EVAL_API_KEY?.trim() || null;

  const results: EvalResult[] = [];
  const skipped: string[] = [];
  for (const task of options.tasks) {
    if (task.needsBlender === true && !blender) {
      process.stdout.write(`\n→ ${task.id} · skipped: it needs the Blender worker; pass --blender auto or a path\n`);
      skipped.push(task.id);
      continue;
    }
    process.stdout.write(`\n→ ${task.id}\n`);
    const telemetry = createEvalTelemetryCollector();
    const result = await runEvalTask({
      caller,
      createPlanner: (_task, runId) => connection !== undefined
        ? createAgentLoopPlanner({
            // A new transport per run, as the app makes one: the Anthropic one
            // remembers the latest turn's thinking.
            transport: createCustomTransport({ connection, model: connection.models[0], apiKey }),
            runId,
            modelId: model,
            effort,
            agent: agentRuntime.definition,
            skillLibrary: agentRuntime.skillLibrary,
            plannerId: "custom-endpoint",
            label: connection.name,
            images: connection.models[0].images,
            onTelemetry: telemetry.observe,
            blender,
          })
        : createClaudePlanner({
            launcher: claude!,
            getStatus: () => claude!.getStatus(),
            cwd: os.tmpdir(),
            model,
            effort,
            supportsEffort,
            agent: agentRuntime.definition,
            skillLibrary: agentRuntime.skillLibrary,
            blender,
          }),
      task,
      outputDirectory: options.outputDirectory,
      instanceId,
      endpoint: options.endpoint,
      provider: options.provider === "endpoint" ? "custom" : "claude",
      model,
      effort,
      ...(connection !== undefined ? { plannerMetrics: telemetry.snapshot } : {}),
    });
    results.push(result);
    process.stdout.write(`${formatEvalResult(result)}\n`);
  }

  const passed = results.filter((result) => result.verdict.passed).length;
  const skippedNote = skipped.length > 0 ? ` · ${skipped.length} skipped (${skipped.join(", ")})` : "";
  process.stdout.write(`\n${passed}/${results.length} passed${skippedNote} · trajectories in ${options.outputDirectory}\n`);
  // A failing suite is a failing exit code, so this can gate anything later.
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
