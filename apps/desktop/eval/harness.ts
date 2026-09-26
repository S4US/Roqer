/**
 * The comparative-evaluation harness, thin slice.
 *
 * It does three things and no more: reset the place deterministically, drive a
 * real `RunSession` over a seeded task, and write every run event to a JSONL
 * trajectory beside a verdict. Token accounting, arms, and a factorial design
 * are deliberately absent — none of them are worth building before there is a
 * single reproducible trajectory to look at.
 *
 * Because it drives the real engine rather than a copy of it, everything the
 * engine enforces is exercised here too: policy, approvals, playtest cleanup,
 * and the completion gate. That is the point. A harness that reimplemented the
 * run loop would be measuring the harness.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { blenderVersion, detectBlender, isBlenderExecutablePath } from "../runtime/blender-settings";
import type { McpToolCaller } from "../runtime/mcp-types";
import { RunSession, type Planner, type PlannerImage } from "../runtime/run-engine";
import type { ApprovalMode } from "../shared/policy";
import { isKnownTool, TOOL_RISK } from "../shared/mcp-tools";
import type { ProviderId, ReasoningEffort } from "../shared/provider";
import type { RunEvent } from "../shared/run-events";
import { auditInterface, type InterfaceAudit, type InterfaceAuditOptions } from "./interface-audit";
import { probePlace, resetPlace } from "./reset";
import { isAllowedTarget, type EvalTask, type EvalVerdict } from "./tasks";
import type { EvalModelToolCall, EvalPlannerMetrics } from "./telemetry";

export type EvalRunOptions = {
  caller: McpToolCaller;
  /** Built per task, since a planner owns one turn. */
  createPlanner: (task: EvalTask, runId: string) => Planner;
  task: EvalTask;
  /** Directory for `<taskId>.jsonl`. Created if missing. */
  outputDirectory: string;
  instanceId: string | null;
  endpoint: string;
  /**
   * `Full auto` by default, because a run with nobody watching is exactly what
   * that mode is for: choosing it is the confirmation, given in advance, for
   * every action in the run.
   *
   * This defaulted to `Auto approve` on the belief that an irreversible action
   * nobody confirmed would be refused. It was not. The engine parks on a
   * `Deferred` that only a renderer resolves, so the first playtest an agent
   * proposed drained the event loop and the process exited 0 partway through,
   * with no trajectory written and nothing said about why.
   */
  approvalMode?: ApprovalMode;
  autoPlaytest?: boolean;
  provider?: ProviderId;
  model?: string | null;
  effort?: ReasoningEffort;
  /** Provider-specific numeric telemetry, read after the planner finishes. */
  plannerMetrics?: () => EvalPlannerMetrics;
  /** Injectable so a test can assert the file contents deterministically. */
  now?: () => string;
  /** Where a task's `referenceImage` is read from; `eval/fixtures` by default. */
  fixturesDirectory?: string;
  /** Timings for the harness's own interface audit; tests shorten them. */
  interfaceAuditOptions?: InterfaceAuditOptions;
};

const FIXTURE_MEDIA_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** The task's reference image, attached to the prompt as the app attaches a pasted one. */
async function referenceImages(task: EvalTask, fixturesDirectory: string): Promise<PlannerImage[]> {
  if (task.referenceImage === undefined) return [];
  const mediaType = FIXTURE_MEDIA_TYPES[path.extname(task.referenceImage).toLowerCase()];
  if (mediaType === undefined) throw new Error(`${task.id}'s reference image must be a PNG or JPEG.`);
  const bytes = await readFile(path.join(fixturesDirectory, task.referenceImage));
  return [{ name: task.referenceImage, mediaType, data: bytes.toString("base64") }];
}

export type EvalMetrics = Readonly<{
  modelTurns: number | null;
  /** Turns ended because the model made no semantic progress. */
  stalledTurns: number | null;
  /** Tries at a turn the endpoint failed transiently, each followed by another try. */
  retriedAttempts: number | null;
  totalToolCalls: number;
  distinctTools: number;
  callsBeforeFirstMutation: number | null;
  reads: number;
  writes: number;
  skillLoads: number;
  taskUpdates: number;
  playtests: number;
  screenshots: number;
  uiInteractions: number;
  assetResolutionCalls: number;
  failedCalls: number;
  repairLoops: number;
  toolResultCharacters: number;
  /**
   * How the run's wall time divides, in milliseconds. Null for a provider whose
   * planner reports no telemetry. `streamTailMs` is the one to watch: it is what
   * a turn spends after the model has finished asking for its last tool, so it
   * is orchestration rather than inference and near zero is the correct value.
   */
  streamDurationMs: number | null;
  timeToFirstEventMs: number | null;
  streamTailMs: number | null;
  toolDurationMs: number | null;
  peakTurnContextCharacters: number | null;
  accumulatedContextTokens: number | null;
  measuredInputTokens: number | null;
  measuredOutputTokens: number | null;
  cachedInputTokens: number | null;
  measuredUsageTurns: number;
  stallDetected: boolean;
}>;

export type EvalResult = {
  taskId: string;
  verdict: EvalVerdict;
  outcome: string;
  verified: boolean;
  /** Issues the completion gate raised, if any. */
  gateIssues: string[];
  toolCallCount: number;
  failedToolCallCount: number;
  durationMs: number;
  /** Writes to instance paths the task did not declare. */
  offTargetWrites: string[];
  metrics: EvalMetrics;
  trajectoryPath: string;
  /**
   * Why the run ended before the agent finished, when it did: an expired
   * session, an unreachable model, a cancellation. The oracle still scores the
   * place, but that score describes an interrupted run, not the agent's result.
   */
  stoppedBy?: string;
};

/**
 * A tool call as the counting below needs it. Which model turn asked for it is
 * known only where the planner reports telemetry, and a call derived from the
 * run events instead is still perfectly countable without it.
 */
type CountedToolCall = Omit<EvalModelToolCall, "turn">;

function repairLoops(calls: readonly CountedToolCall[]): number {
  return calls.reduce((total, call, index) => {
    if (call.ok) return total;
    return calls.slice(index + 1).some((later) => later.ok && later.tool === call.tool) ? total + 1 : total;
  }, 0);
}

function deriveMetrics(
  events: readonly RunEvent[],
  planner: EvalPlannerMetrics | undefined,
): EvalMetrics {
  const eventCalls: CountedToolCall[] = events.flatMap((event) => event.type === "tool-result"
    ? [{
        tool: event.tool,
        ok: event.ok,
        durationMs: event.durationMs,
        resultCharacters: event.summary.length + (event.detail?.length ?? 0),
      }]
    : []);
  const calls: readonly CountedToolCall[] = planner?.modelToolCalls ?? eventCalls;
  const knownCalls = calls.filter((call) => isKnownTool(call.tool));
  const firstMutation = calls.findIndex((call) => isKnownTool(call.tool) && TOOL_RISK[call.tool] !== "read");
  const completion = [...events].reverse().find((event) => event.type === "run-completed");
  const failures = events.filter((event) => event.type === "failure")
    .map((event) => event.type === "failure" ? `${event.failure.code} ${event.failure.message}` : "")
    .join(" ");
  const terminalSummary = completion?.type === "run-completed" ? completion.summary : "";

  return {
    modelTurns: planner?.modelTurns ?? null,
    stalledTurns: planner?.stalledTurns ?? null,
    retriedAttempts: planner?.retriedAttempts ?? null,
    totalToolCalls: calls.length,
    distinctTools: new Set(calls.map((call) => call.tool)).size,
    callsBeforeFirstMutation: firstMutation < 0 ? null : firstMutation,
    reads: knownCalls.filter((call) => TOOL_RISK[call.tool] === "read").length,
    writes: knownCalls.filter((call) => TOOL_RISK[call.tool] !== "read").length,
    skillLoads: calls.filter((call) => call.tool === "load_skill").length,
    taskUpdates: calls.filter((call) => call.tool === "update_task_list").length,
    playtests: calls.filter((call) => call.tool === "solo_playtest" || call.tool === "multiplayer_playtest").length,
    screenshots: calls.filter((call) => call.tool === "capture_screenshot").length,
    uiInteractions: calls.filter((call) => call.tool === "interact_ui").length,
    assetResolutionCalls: calls.filter((call) => [
      "search_assets", "get_asset_details", "get_asset_thumbnail", "preview_asset",
    ].includes(call.tool)).length,
    failedCalls: calls.filter((call) => !call.ok).length,
    repairLoops: repairLoops(calls),
    toolResultCharacters: planner?.toolResultCharacters ??
      eventCalls.reduce((total, call) => total + call.resultCharacters, 0),
    streamDurationMs: planner?.streamDurationMs ?? null,
    timeToFirstEventMs: planner?.timeToFirstEventMs ?? null,
    streamTailMs: planner?.streamTailMs ?? null,
    toolDurationMs: planner?.toolDurationMs ?? null,
    peakTurnContextCharacters: planner?.peakTurnContextCharacters ?? null,
    accumulatedContextTokens: planner?.accumulatedContextTokens ?? null,
    measuredInputTokens: planner && planner.measuredUsageTurns > 0 ? planner.inputTokens : null,
    measuredOutputTokens: planner && planner.measuredUsageTurns > 0 ? planner.outputTokens : null,
    cachedInputTokens: planner && planner.measuredUsageTurns > 0 ? planner.cachedInputTokens : null,
    measuredUsageTurns: planner?.measuredUsageTurns ?? 0,
    stallDetected: /stopp?ed responding|without finishing|without completing|upstream[_ -]timeout/i
      .test(`${failures} ${terminalSummary}`),
  };
}

/** Every event, one JSON object per line, in the order the engine emitted it. */
async function writeTrajectory(file: string, lines: readonly unknown[]): Promise<void> {
  await writeFile(file, "", "utf8");
  for (const line of lines) {
    await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
  }
}

/**
 * Run one seeded task end to end.
 *
 * A reset or probe failure throws rather than scoring: the difference between
 * "the agent failed" and "the harness could not see the place" is the whole
 * value of the measurement, and collapsing them would make every number
 * unreadable.
 */
/**
 * Answer anything the engine stops on, because nothing else here will.
 *
 * The engine is written for an interface with a person in front of it: an
 * approval and a question each park on a `Deferred` that only the renderer
 * resolves, and neither carries a timer. In a headless run that is not a
 * refusal, it is a hang — the event loop drains and the process exits partway
 * through with no trajectory and no error to say why. Both pending maps are
 * populated before their event is emitted, deliberately, so that a listener
 * answering synchronously cannot lose the race. This is that listener.
 *
 * An approval that still arrives under `Full auto` is a tool with no risk
 * classification, which that mode does not cover. It is refused rather than
 * allowed: an unclassified tool running unattended is the thing the rule exists
 * to prevent, and a refusal reaches the model as a tool result it can act on.
 *
 * A question is answered with the option the model itself listed first. No user
 * exists whose preference could be represented, and `resolveQuestion` accepts
 * only an index into the model's own options, so this is the one answer that
 * keeps the run moving. The `question-answered` event records which option it
 * was, so a trajectory never suggests a person chose it.
 */
function answerWithNobodyWatching(session: RunSession, event: RunEvent): void {
  if (event.type === "approval-requested") {
    session.resolveApproval(event.callId, "rejected");
    return;
  }
  if (event.type === "question-asked") {
    session.resolveQuestion(event.question.callId, 0);
  }
}

export async function runEvalTask(options: EvalRunOptions): Promise<EvalResult> {
  const { caller, task, instanceId } = options;
  const now = options.now ?? (() => new Date().toISOString());

  await mkdir(options.outputDirectory, { recursive: true });
  const images = await referenceImages(task, options.fixturesDirectory ?? path.join(process.cwd(), "eval", "fixtures"));
  await resetPlace(caller, task, instanceId);

  const events: RunEvent[] = [];
  const startedAt = Date.now();
  const runId = `eval-${task.id}-${randomUUID()}`;
  const approvalMode = options.approvalMode ?? "Full auto";
  const session: RunSession = new RunSession({
    caller,
    ...(images.length > 0 ? { images } : {}),
    planner: options.createPlanner(task, runId),
    request: {
      runId,
      projectId: "eval",
      chatId: task.id,
      prompt: task.prompt,
      conversation: { messages: [], truncated: false },
      approvalMode,
      autoPlaytest: options.autoPlaytest ?? true,
      endpoint: options.endpoint,
      instanceId,
      provider: options.provider ?? "claude",
      model: options.model ?? null,
      effort: options.effort ?? "medium",
    },
    emit: (event) => {
      events.push(event);
      // Naming `session` inside its own initializer is safe here: the engine
      // emits nothing from its constructor, and the first event it can produce
      // comes from `execute()` below, long after this binding is set.
      answerWithNobodyWatching(session, event);
    },
  });

  const outcome = await session.execute();
  const durationMs = Date.now() - startedAt;

  const completion = events.find((event) => event.type === "run-completed");
  const verification = completion?.type === "run-completed" ? completion.verification : undefined;
  const stoppedBy = outcome !== "completed" && completion?.type === "run-completed" ? completion.summary : undefined;
  const toolResults = events.filter((event) => event.type === "tool-result");
  const toolCalls = toolResults.map((event) =>
    event.type === "tool-result"
      ? { tool: event.tool, ok: event.ok, detail: event.detail ?? event.summary }
      : { tool: "", ok: false });

  // An upload creates an asset in the user's Roblox account, not an instance
  // in the place, so its `rbxassetid://` target is no instance path to judge.
  const changedTargets = events.flatMap((event) =>
    event.type === "change" && event.change.kind !== "asset" ? [event.change.target] : []);
  const offTargetWrites = [...new Set(changedTargets.filter((target) => !isAllowedTarget(task, target)))];

  // Before the probe: the audit's playtest ends in edit mode, where the probe reads.
  const interfaceAudit: InterfaceAudit | undefined = task.auditInterface === undefined
    ? undefined
    : await auditInterface(caller, instanceId, task.auditInterface, options.interfaceAuditOptions);
  const probe = await probePlace(caller, task, instanceId);
  const verified = verification?.verified === true;
  const verdict = task.oracle({
    probe, outcome, verified, toolCalls, changedTargets, ...(interfaceAudit === undefined ? {} : { interfaceAudit }),
  });
  const plannerMetrics = options.plannerMetrics?.();
  const metrics = deriveMetrics(events, plannerMetrics);

  const trajectoryPath = path.join(options.outputDirectory, `${task.id}.jsonl`);
  await writeTrajectory(trajectoryPath, [
    {
      kind: "run",
      taskId: task.id,
      prompt: task.prompt,
      ...(task.referenceImage === undefined ? {} : { referenceImage: task.referenceImage }),
      model: options.model ?? null,
      effort: options.effort ?? "medium",
      approvalMode,
      autoPlaytest: options.autoPlaytest ?? true,
      provider: options.provider ?? "claude",
      at: now(),
    },
    ...events.map((event) => ({ kind: "event", event })),
    // One line per model turn, before the verdict's totals. The totals say
    // where the run's time went; these say whether it was getting worse, which
    // is the difference between a fixed cost upstream and one that grows with
    // what is being sent. Absent for a provider that reports no telemetry.
    ...(plannerMetrics?.turns ?? []).map((turn) => ({ kind: "turn", taskId: task.id, turn })),
    {
      kind: "verdict",
      taskId: task.id,
      passed: verdict.passed,
      detail: verdict.detail,
      outcome,
      verified,
      gateIssues: verification?.issues.map((issue) => issue.detail) ?? [],
      offTargetWrites,
      toolCallCount: toolCalls.length,
      durationMs,
      metrics,
      probe,
      ...(interfaceAudit === undefined ? {} : { interfaceAudit }),
      ...(stoppedBy === undefined ? {} : { stoppedBy }),
    },
  ]);

  return {
    taskId: task.id,
    verdict,
    outcome,
    verified,
    gateIssues: verification?.issues.map((issue) => issue.detail) ?? [],
    toolCallCount: toolCalls.length,
    failedToolCallCount: toolCalls.filter((call) => !call.ok).length,
    durationMs,
    offTargetWrites,
    metrics,
    trajectoryPath,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
  };
}

/** One line per task, for reading a whole suite at a glance. */
export function formatEvalResult(result: EvalResult): string {
  // A run that stopped early is not a failed attempt at the task: T10's first
  // run lost its hosted session after 15 minutes, mid-build, and printed "FAIL
  // · WorkbenchEvalVillage was not built", which read as the model's result.
  const mark = result.verdict.passed ? "PASS" : result.stoppedBy === undefined ? "FAIL" : "STOPPED";
  const parts = [
    `${mark} ${result.taskId}`,
    ...(result.stoppedBy === undefined ? [] : [`run ended early: ${result.stoppedBy}`]),
    result.verdict.detail,
    `${result.metrics.totalToolCalls} calls`,
    `${(result.durationMs / 1000).toFixed(1)}s`,
  ];
  if (result.metrics.modelTurns !== null) parts.push(`${result.metrics.modelTurns} turns`);
  // On the line rather than left to the JSONL, because the whole point of
  // measuring it is to stop a slow run reading as a slow model: waiting, work,
  // and the orchestration tail between them have different fixes.
  const { timeToFirstEventMs, toolDurationMs, streamTailMs } = result.metrics;
  if (timeToFirstEventMs !== null && toolDurationMs !== null && streamTailMs !== null) {
    const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)}s`;
    parts.push(`wait ${seconds(timeToFirstEventMs)} · tools ${seconds(toolDurationMs)} · tail ${seconds(streamTailMs)}`);
  }
  // Named on the line rather than left to the JSONL: a stall is the reliability
  // property most easily mistaken for a slow arm when only averages are read.
  if (result.metrics.stalledTurns) parts.push(`${result.metrics.stalledTurns} stalled`);
  if (result.metrics.retriedAttempts) parts.push(`${result.metrics.retriedAttempts} retried`);
  if (!result.verified && result.gateIssues.length > 0) {
    parts.push(`gate: ${result.gateIssues.length} unmet`);
  }
  if (result.offTargetWrites.length > 0) {
    parts.push(`off-target: ${result.offTargetWrites.join(", ")}`);
  }
  return parts.join(" · ");
}

/**
 * A modeling task publishes through the driven bridge's own Open Cloud key, and
 * a bridge Roqer did not start has none unless its environment sets one. The
 * first T12 run spent 190 s of a paid model on exactly that before it could
 * fail. A status check with a malformed operation ID answers without reaching
 * Roblox: the bridge refuses a missing key before it validates the ID.
 */
export async function requireUploads(caller: McpToolCaller, instanceId: string | null, endpoint: string): Promise<void> {
  const outcome = await caller.callTool("upload_asset", {
    action: "status",
    operationId: "roqer eval preflight",
    ...(instanceId === null ? {} : { instance_id: instanceId }),
  });
  if (/No Open Cloud API key/i.test(`${outcome.message ?? ""} ${outcome.text}`)) {
    throw new Error(
      `The bridge at ${endpoint} has no Roblox Open Cloud key, so a modeling task cannot upload its model. `
      + "Roqer passes its saved key only to a bridge it starts: close any bridge you started yourself and let Roqer "
      + "start it, or start it with ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_CREATOR_USER_ID (or _GROUP_ID) set.",
    );
  }
}

/** The Blender to run jobs with, checked the way Settings checks one before it can be turned on. */
export async function resolveBlender(requested: string): Promise<string> {
  const executable = requested === "auto" ? await detectBlender() : requested;
  if (executable === null) throw new Error("--blender auto found no installed Blender. Pass the full path to blender.exe instead.");
  if (!isBlenderExecutablePath(executable)) {
    throw new Error(`--blender needs "auto" or an absolute path to blender or blender.exe, not "${executable}".`);
  }
  const version = await blenderVersion(executable);
  if (version === undefined) throw new Error(`${executable} did not answer --version as Blender.`);
  process.stdout.write(`Blender ${version} · ${executable}\n`);
  return executable;
}
