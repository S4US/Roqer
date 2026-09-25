/**
 * The planner-driven, policy-gated, cancellable run executor.
 *
 * A `RunSession` owns exactly one run: it hands the planner a `PlannerContext`
 * that mediates every tool call through `shared/policy.ts`, assigns strictly
 * increasing sequence numbers to every event, and guarantees the event stream
 * starts with `run-started` and ends with `run-completed` no matter how the
 * planner behaves (misbehaving planners that keep emitting after they resolve
 * are silently ignored, not surfaced as bugs downstream).
 *
 * The engine is deliberately the only place that knows about ordering,
 * cancellation, and policy consequences — the planner only decides *what* to
 * do, never *whether* it is allowed to.
 */

import { createHash } from "node:crypto";
import type { McpToolCaller, McpToolOutcome } from "./mcp-types";
import { decideToolPolicy, describePolicyReason } from "../shared/policy";
import type { PolicyReason } from "../shared/policy";
import { isClassifiedTool, riskForTool, summarizeToolCall, timeoutForTool } from "../shared/mcp-tools";
import type {
  RunChange,
  RunEvent,
  RunEventBody,
  RunEvidence,
  RunFailure,
  RunOutcome,
  RunRequest,
  ToolProposal,
} from "../shared/run-events";
import type { ConversationContext } from "../shared/conversation";
import {
  evaluateCompletion, evidenceBaselineChangeId, type CompletionVerification,
} from "../shared/completion";
import { isAnswerIndex, isEscapeAnswer, MAX_QUESTIONS_PER_RUN, QUESTION_ESCAPE_OPTION } from "../shared/question";
import type { RunDecision } from "../shared/run-digest";
import { MAX_STEERS_PER_RUN, normalizeSteer } from "../shared/steer";
import type { RunTask } from "../shared/tasks";
import { summarizeToolOutcome } from "./result-summary";

/** Thrown by `PlannerContext.call` when the run was cancelled. */
export class RunCancelledError extends Error {
  constructor() {
    super("Run was cancelled");
    this.name = "RunCancelledError";
  }
}

/**
 * Thrown by `PlannerContext.call` when the host ended the run itself: it lost
 * something the run cannot go on without. A cancellation as far as a planner is
 * concerned -- it unwinds the same way -- but the run's outcome is `failed`,
 * because nobody chose this.
 */
export class RunAbortedError extends RunCancelledError {
  constructor(message: string) {
    super();
    this.message = message;
    this.name = "RunAbortedError";
  }
}

/**
 * What the host found when a tool call reached nothing at the endpoint.
 *
 * A model told "fetch failed" cannot tell a dead bridge from a closed Studio,
 * and in the run that prompted this it spent six turns probing a port nothing
 * was listening on and then told the user to reconnect Studio. So the engine
 * asks the host before the model hears anything, and the host answers with one
 * of these.
 */
export type BridgeRecovery =
  /** The endpoint answers; the call can simply be tried again. */
  | Readonly<{ kind: "answering" }>
  /** The bridge had gone and a replacement is up; Studio's plugin may or may not have found it yet. */
  | Readonly<{ kind: "restarted"; studioConnected: boolean }>
  /** No bridge, and the host has stopped trying. `message` is for the person. */
  | Readonly<{ kind: "unavailable"; message: string }>;

/** The host's side of that question. Present only for a bridge the host supervises. */
export interface BridgeRecoveryHost {
  recover(): Promise<BridgeRecovery>;
}

/**
 * A picture attached to the message that started this run, ready to send.
 *
 * Run-scoped by construction: it is not part of `RunRequest`, so it never
 * reaches the run journal or the saved transcript, and a resumed or recovered
 * run does not re-send it.
 */
export type PlannerImage = Readonly<{ name: string; mediaType: string; data: string }>;

export type PlannerContext = {
  prompt: string;
  conversation: ConversationContext;
  /** Images the user attached to this message. Empty for most runs. */
  images: readonly PlannerImage[];
  instanceId: string | null;
  /** User preference for this run; provider adapters carry it as trusted guidance. */
  autoPlaytest: boolean;
  signal: AbortSignal;
  /** Run a read or write tool. Policy and approval are applied by the engine. */
  call(tool: string, args: Record<string, unknown>): Promise<McpToolOutcome>;
  /** Append assistant prose to the reply. */
  say(text: string): void;
  /** Something worth recording that was not a tool call; kept in the timeline. */
  status(label: string, detail?: string): void;
  /**
   * The provider's own state — connecting, thinking. Shown live while it lasts
   * and never kept as a step, because it describes the whole turn rather than
   * one thing the agent did.
   */
  progress(label: string, detail?: string): void;
  /** Record a change the agent made. */
  recordChange(change: Omit<RunChange, "id">): void;
  /** Record evidence supporting the result. */
  recordEvidence(evidence: Omit<RunEvidence, "id">): void;
  /** Replace the run's task list. Already validated by the caller. */
  setTasks(tasks: RunTask[]): void;
  /** The current task list, for a planner that needs to reread its own plan. */
  tasks(): readonly RunTask[];
  /**
   * What the host has recorded so far, oldest first.
   *
   * The same arrays the completion gate is judged against. A planner reads them
   * when its own conversation can no longer hold the whole run — a folded
   * history has to be replaced by the record, not by a recollection of it.
   */
  changes(): readonly RunChange[];
  evidence(): readonly RunEvidence[];
  /** Every question answered so far, with the answer, oldest first. */
  decisions(): readonly RunDecision[];
  /**
   * Notes the user added since the planner last asked, oldest first, and
   * cleared by the asking. A planner calls this at a turn boundary and puts
   * what it gets in front of the model as the user's words.
   */
  takeSteers(): string[];
  /**
   * Ask the user one bounded question and wait. Resolves with the chosen
   * option's text; rejects if the run is cancelled or the budget is spent.
   */
  askUser(question: string, options: string[]): Promise<string>;
  /**
   * What the completion gate would say if the run ended now.
   *
   * Exposed so a planner can learn it is about to finish unverified while it
   * still has a turn left to do something about it, rather than only after the
   * fact.
   */
  checkCompletion(): CompletionVerification;
};

export interface Planner {
  readonly id: string;
  run(context: PlannerContext): Promise<string>;
}

export type RunEngineOptions = {
  caller: McpToolCaller;
  /**
   * Who to ask when a call reaches nothing at the caller's endpoint. Absent
   * when the endpoint is not a bridge the host runs, in which case the failure
   * is the model's to read.
   */
  bridge?: BridgeRecoveryHost;
  planner: Planner;
  request: RunRequest;
  /** Images attached to the starting message; never persisted with the run. */
  images?: readonly PlannerImage[];
  emit: (event: RunEvent) => void;
  /** Injectable for tests; defaults to () => new Date().toISOString(). */
  now?: () => string;
  /** Injectable for tests; defaults to a counter-based id generator. */
  createId?: (prefix: string) => string;
};

const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(["timeout", "request_failed", "bridge_restarted"]);
const PLAYTEST_CLEANUP_TIMEOUT_MS = 20_000;

type OwnedPlaytest = {
  tool: "solo_playtest" | "multiplayer_playtest";
  cleanupAction: "stop" | "end";
  instanceId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) =>
      `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** Stable, bounded identity for one effective action; raw arguments never enter the ledger. */
function actionIdentity(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(tool).update("\0").update(canonicalValue(args)).digest("hex");
}

function refusedToolOutcome(
  tool: string,
  reason: PolicyReason,
  originalReason: PolicyReason = reason,
  rejectedByUser = false,
): McpToolOutcome {
  const repeated = reason === "previously-rejected";
  const pending = reason === "equivalent-action-pending";
  const message = repeated
    ? `Roqer did not run ${tool}: the same effective action was already rejected earlier in this run. Do not request it again; choose a different approach or explain the limitation.`
    : pending
      ? `Roqer did not run ${tool}: the same effective action is already awaiting a decision. Do not submit a duplicate.`
      : rejectedByUser
        ? `Roqer did not run ${tool}: the user rejected this proposed action. Do not request the same action again; continue with a permitted alternative or explain the limitation.`
        : `Roqer did not run ${tool}: ${describePolicyReason(reason)} Continue with a permitted alternative or explain the limitation.`;
  return {
    ok: false,
    data: {
      success: false,
      errorCode: pending ? "equivalent_action_pending" : "approval_rejected",
      tool,
      policyReason: reason,
      originalPolicyReason: originalReason,
      repeated,
    },
    text: "",
    httpStatus: 0,
    errorCode: pending ? "equivalent_action_pending" : "approval_rejected",
    message,
    durationMs: 0,
  };
}

/** An event before the engine stamps it with `runId`, `seq`, and `at`. */
type PendingEvent = RunEventBody;

function defaultIdGenerator(): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

/** A promise plus the callbacks needed to settle it from the outside. */
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class RunSession {
  readonly runId: string;

  private readonly caller: McpToolCaller;
  private readonly bridge: BridgeRecoveryHost | undefined;
  private readonly planner: Planner;
  private readonly request: RunRequest;
  private readonly images: readonly PlannerImage[];
  private readonly emitRaw: (event: RunEvent) => void;
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  private readonly abortController = new AbortController();
  private seq = 0;
  private completed = false;
  private cancelled = false;
  /** Set when the host ended the run; the outcome is then `failed` with this as the reason. */
  private abortReason: string | undefined;

  private readonly pendingApprovals = new Map<string, Deferred<"approved" | "rejected">>();
  private readonly pendingActionApprovals = new Set<string>();
  private readonly rejectedActions = new Map<string, PolicyReason>();
  private readonly ownedPlaytests = new Map<string, OwnedPlaytest>();

  /**
   * The gate reads changes, evidence, and failures, so the engine keeps them
   * rather than only forwarding them. They are the same objects the renderer
   * receives, so the two sides cannot drift.
   */
  private currentTasks: RunTask[] = [];
  private readonly recordedChanges: RunChange[] = [];
  private readonly recordedEvidence: RunEvidence[] = [];
  private failureCount = 0;

  private readonly pendingQuestions = new Map<string, {
    deferred: Deferred<number>;
    options: string[];
  }>();
  private questionsAsked = 0;
  private readonly recordedDecisions: RunDecision[] = [];
  private readonly pendingSteers: string[] = [];
  private steersAccepted = 0;

  constructor(options: RunEngineOptions) {
    this.caller = options.caller;
    this.bridge = options.bridge;
    this.planner = options.planner;
    this.request = options.request;
    this.images = options.images ?? [];
    this.emitRaw = options.emit;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? defaultIdGenerator();
    this.runId = options.request.runId;
  }

  /** Runs to completion. Never rejects — failures become events. */
  async execute(): Promise<RunOutcome> {
    this.emit({
      type: "run-started",
      prompt: this.request.prompt,
      approvalMode: this.request.approvalMode,
      autoPlaytest: this.request.autoPlaytest,
      endpoint: this.request.endpoint,
      instanceId: this.request.instanceId,
      model: this.request.model,
      effort: this.request.effort,
      planner: this.planner.id,
    });

    const context: PlannerContext = {
      prompt: this.request.prompt,
      conversation: this.request.conversation,
      images: this.images,
      instanceId: this.request.instanceId,
      autoPlaytest: this.request.autoPlaytest,
      signal: this.abortController.signal,
      call: (tool, args) => this.callTool(tool, args),
      say: (text) => this.emit({ type: "message-delta", text }),
      status: (label, detail) => this.emit({ type: "status", label, detail }),
      progress: (label, detail) => this.emit({ type: "status", label, detail, transient: true }),
      recordChange: (change) => {
        const taskId = this.currentTasks.find((task) => task.status === "active")?.id;
        const recorded: RunChange = {
          ...change,
          id: this.createId("change"),
          ...(change.taskId === undefined && taskId !== undefined ? { taskId } : {}),
        };
        this.recordedChanges.push(recorded);
        this.emit({ type: "change", change: recorded });
      },
      recordEvidence: (evidence) => {
        const taskId = evidence.taskId ?? this.currentTasks.find((task) => task.status === "active")?.id;
        const afterChangeId = evidence.afterChangeId ??
          evidenceBaselineChangeId(this.recordedChanges, taskId);
        const recorded: RunEvidence = {
          ...evidence,
          id: this.createId("evidence"),
          ...(taskId !== undefined ? { taskId } : {}),
          ...(afterChangeId !== undefined ? { afterChangeId } : {}),
        };
        this.recordedEvidence.push(recorded);
        this.emit({ type: "evidence", evidence: recorded });
      },
      setTasks: (tasks) => {
        this.currentTasks = tasks;
        this.emit({ type: "tasks", tasks });
      },
      tasks: () => this.currentTasks,
      changes: () => this.recordedChanges,
      evidence: () => this.recordedEvidence,
      decisions: () => this.recordedDecisions,
      takeSteers: () => this.pendingSteers.splice(0),
      askUser: (question, options) => this.askUser(question, options),
      // "completed" because the question is what the gate would say about a run
      // that ends well from here; a run heading for failure has no use for it.
      checkCompletion: () => this.evaluateGate("completed"),
    };

    let outcome: RunOutcome;
    let summary: string;

    try {
      summary = await this.planner.run(context);
      outcome = this.cancelled ? "cancelled" : "completed";
      // A planner that swallowed the abort and returned anyway does not get to
      // report a run the host ended as finished.
      if (this.abortReason !== undefined) {
        outcome = "failed";
        summary = this.abortReason;
      }
    } catch (error) {
      if (this.abortReason !== undefined) {
        outcome = "failed";
        summary = this.abortReason;
      } else if (this.cancelled || error instanceof RunCancelledError) {
        outcome = "cancelled";
        summary = "Run was cancelled.";
      } else {
        outcome = "failed";
        const message = error instanceof Error ? error.message : String(error);
        summary = message;
        this.emitFailure({ code: "planner_failed", message, retryable: false });
      }
    }

    // Cleanup runs first so a playtest this run started is stopped before the
    // gate looks at the evidence, and so a failed teardown counts against it.
    await this.cleanupOwnedPlaytests();
    const verification = this.evaluateGate(outcome);
    this.emit({ type: "run-completed", outcome, summary, verification });
    this.completed = true;
    return outcome;
  }

  /** Resolve a pending approval. Returns false if the callId is not pending. */
  resolveApproval(callId: string, decision: "approved" | "rejected"): boolean {
    const deferred = this.pendingApprovals.get(callId);
    if (!deferred) return false;
    this.pendingApprovals.delete(callId);
    deferred.resolve(decision);
    return true;
  }

  /**
   * Answer a pending question by index into the options it offered.
   *
   * Returns false for an unknown call or an index that does not address one of
   * those options, so a renderer that sends something else neither resumes the
   * run nor puts a string of its own choosing in front of the model.
   */
  resolveQuestion(callId: string, answerIndex: unknown): boolean {
    const pending = this.pendingQuestions.get(callId);
    if (!pending || !isAnswerIndex(answerIndex, pending.options)) return false;
    this.pendingQuestions.delete(callId);
    pending.deferred.resolve(answerIndex);
    return true;
  }

  /**
   * Queue a note from the user for the model's next turn.
   *
   * Returns false when there is nothing to queue -- the text is empty, over
   * the bound, or malformed -- when the run has already ended, or when the
   * run's budget of notes is spent. A refusal after the run ended is what lets
   * the renderer offer the same words as a fresh prompt instead of losing them.
   */
  steer(text: unknown): boolean {
    if (this.completed || this.cancelled) return false;
    const normalized = normalizeSteer(text);
    if (normalized === null || this.steersAccepted >= MAX_STEERS_PER_RUN) return false;
    this.steersAccepted += 1;
    this.pendingSteers.push(normalized);
    this.emit({ type: "steer", text: normalized });
    return true;
  }

  /**
   * End the run because the host can no longer serve it.
   *
   * Unwinds exactly as a cancellation does -- the same signal, the same
   * rejections -- and differs only in what the record says afterwards: the
   * outcome is `failed`, with the reason, rather than `cancelled`, which the
   * interface reads as the user's own doing.
   */
  private abort(message: string): void {
    if (this.completed || this.cancelled) return;
    this.abortReason = message;
    this.cancel();
  }

  /** Cancel the run: aborts in-flight work and blocks further tool calls. */
  cancel(reason?: string): void {
    if (this.completed || this.cancelled) return;
    if (reason) this.emitFailure({ code: "persistence-failed", message: reason, retryable: false });
    this.cancelled = true;
    this.abortController.abort();
    for (const [callId, deferred] of this.pendingApprovals) {
      this.pendingApprovals.delete(callId);
      deferred.reject(new RunCancelledError());
    }
    for (const [callId, pending] of this.pendingQuestions) {
      this.pendingQuestions.delete(callId);
      // Recorded before the rejection so history shows the question was asked
      // and why it never got an answer.
      this.emit({
        type: "question-answered",
        callId,
        answerIndex: -1,
        answer: "",
        cancelled: true,
      });
      pending.deferred.reject(new RunCancelledError());
    }
  }

  /** The gate's verdict over everything the run has recorded so far. */
  private evaluateGate(outcome: string): CompletionVerification {
    return evaluateCompletion({
      outcome,
      tasks: this.currentTasks,
      changes: this.recordedChanges,
      evidence: this.recordedEvidence,
      failureCount: this.failureCount,
    });
  }

  private async askUser(question: string, options: string[]): Promise<string> {
    if (this.cancelled) throw new RunCancelledError();
    if (this.questionsAsked >= MAX_QUESTIONS_PER_RUN) {
      throw new Error(
        `This run has already used its budget of ${MAX_QUESTIONS_PER_RUN} user questions. Proceed on a stated assumption and explain it in your reply.`,
      );
    }
    this.questionsAsked += 1;

    const callId = this.createId("question");
    const deferred = createDeferred<number>();
    // Registered before the event so a listener that answers synchronously, as
    // tests do, cannot beat the map entry.
    this.pendingQuestions.set(callId, { deferred, options });
    this.emit({ type: "question-asked", question: { callId, question, options } });

    let answerIndex: number;
    try {
      answerIndex = await deferred.promise;
    } finally {
      this.pendingQuestions.delete(callId);
    }

    // The escape is the host's option, so its text is the host's too.
    const answer = isEscapeAnswer(answerIndex, options) ? QUESTION_ESCAPE_OPTION : options[answerIndex];
    this.recordedDecisions.push({ question, answer });
    this.emit({ type: "question-answered", callId, answerIndex, answer, cancelled: false });
    return answer;
  }

  /**
   * Every failure the run reports, counted as it is emitted.
   *
   * The gate needs the count, and having one method own both the event and the
   * tally is what stops a new failure path from being added without the gate
   * ever hearing about it.
   */
  private emitFailure(failure: RunFailure): void {
    this.failureCount += 1;
    this.emit({ type: "failure", failure });
  }

  private emit(event: PendingEvent): void {
    if (this.completed) return;
    this.seq += 1;
    this.emitRaw({
      ...event,
      runId: this.runId,
      seq: this.seq,
      at: this.now(),
    } as RunEvent);
  }

  /**
   * Address every Studio call at the instance this run was started against.
   *
   * The run snapshots that instance when the user sends the prompt, and it is
   * the only instance the interface has claimed to be working on. A planner
   * that supplies its own `instance_id` is transcribing a long opaque string it
   * read out of a tool result, and a planner that transcribes it wrongly — one
   * hex digit is enough — spends the run being told "not connected" by a server
   * that cannot tell a typo from a closed Studio. So the run's own instance
   * wins over whatever the model passed.
   *
   * `manage_instance` is the exception, and the reason the override is not
   * blanket: its `instance_id` names the process to close or report on, which
   * is a genuine choice between instances, and it accepts a `launch_id` for a
   * Studio that has not finished connecting. Forcing the run's instance there
   * would close the wrong window.
   */
  private routeToRunInstance(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const instanceId = this.request.instanceId;
    if (instanceId === null) return args;
    if (tool === "manage_instance") {
      return args.instance_id === undefined && args.launch_id === undefined
        ? { ...args, instance_id: instanceId }
        : args;
    }
    return args.instance_id === instanceId ? args : { ...args, instance_id: instanceId };
  }

  private async callTool(tool: string, args: Record<string, unknown>): Promise<McpToolOutcome> {
    if (this.cancelled) {
      throw new RunCancelledError();
    }

    const effectiveArgs = this.routeToRunInstance(tool, args);

    const callId = this.createId("call");
    const risk = riskForTool(tool, effectiveArgs);
    const proposal: ToolProposal = {
      callId,
      tool,
      arguments: effectiveArgs,
      summary: summarizeToolCall(tool, effectiveArgs),
      risk,
    };

    this.emit({ type: "tool-proposed", proposal });

    const actionKey = actionIdentity(tool, effectiveArgs);
    const previousRejection = this.rejectedActions.get(actionKey);
    if (previousRejection !== undefined) {
      this.emit({
        type: "approval-resolved",
        callId,
        decision: "rejected",
        automatic: true,
        reason: "previously-rejected",
      });
      return refusedToolOutcome(tool, "previously-rejected", previousRejection);
    }

    if (this.pendingActionApprovals.has(actionKey)) {
      this.emit({
        type: "approval-resolved",
        callId,
        decision: "rejected",
        automatic: true,
        reason: "equivalent-action-pending",
      });
      return refusedToolOutcome(tool, "equivalent-action-pending");
    }

    // `Full auto` waives confirmation for the actions Roqer has classified.
    // A tool missing from the risk table has no classification to waive, so it
    // falls back to asking rather than running unattended on a guess.
    const mode = this.request.approvalMode === "Full auto" && !isClassifiedTool(tool)
      ? "Ask first"
      : this.request.approvalMode;
    const decision = decideToolPolicy(mode, risk);

    if (decision.outcome === "deny") {
      this.rejectedActions.set(actionKey, decision.reason);
      this.emit({
        type: "approval-resolved",
        callId,
        decision: "rejected",
        automatic: true,
        reason: decision.reason,
      });
      return refusedToolOutcome(tool, decision.reason);
    }

    if (decision.outcome === "ask") {
      // Registered before the event is emitted so a listener that reacts to
      // `approval-requested` synchronously (as tests do) can resolve it
      // immediately instead of racing the map entry below.
      const deferred = createDeferred<"approved" | "rejected">();
      this.pendingApprovals.set(callId, deferred);
      this.pendingActionApprovals.add(actionKey);

      this.emit({ type: "approval-requested", callId, proposal, reason: decision.reason });

      // A rejection here is cancel()'s RunCancelledError, which has already
      // dropped the deferred from the map, so it just propagates.
      let resolution: "approved" | "rejected";
      try {
        resolution = await deferred.promise;
      } finally {
        this.pendingActionApprovals.delete(actionKey);
      }

      if (resolution === "rejected") {
        this.rejectedActions.set(actionKey, decision.reason);
        this.emit({
          type: "approval-resolved",
          callId,
          decision: "rejected",
          automatic: false,
          reason: decision.reason,
        });
        return refusedToolOutcome(tool, decision.reason, decision.reason, true);
      }

      this.emit({
        type: "approval-resolved",
        callId,
        decision: "approved",
        automatic: false,
        reason: decision.reason,
      });
    } else {
      // "allow"
      this.emit({
        type: "approval-resolved",
        callId,
        decision: "approved",
        automatic: true,
        reason: decision.reason,
      });
    }

    // The wait for approval may have spanned a cancellation that landed
    // between the deferred settling and us resuming; re-check before we
    // actually dispatch anything to the caller.
    if (this.cancelled) {
      throw new RunCancelledError();
    }

    this.emit({ type: "tool-started", callId, tool });

    let outcome = await this.caller.callTool(tool, effectiveArgs, {
      signal: this.abortController.signal,
      // Per tool, because one budget for every tool is either too short for a
      // playtest or a screenshot, or long enough that a hung read stalls the run.
      timeoutMs: timeoutForTool(tool, effectiveArgs),
    });

    // A call that never reached the bridge is not the tool's failure, and not
    // something the model can act on. What the host finds replaces it, or
    // ends the run.
    let fatal: string | undefined;
    if (!outcome.ok && outcome.errorCode === "request_failed" && this.bridge !== undefined && !this.cancelled) {
      const recovered = await this.recoverBridge(this.bridge, tool, outcome);
      outcome = recovered.outcome;
      fatal = recovered.fatal;
    }

    this.trackPlaytestLifecycle(tool, effectiveArgs, outcome);

    const { summary, detail } = summarizeToolOutcome(tool, outcome);
    this.emit({
      type: "tool-result",
      callId,
      tool,
      ok: outcome.ok,
      durationMs: outcome.durationMs,
      summary,
      detail,
    });

    if (!outcome.ok) {
      const errorCode = outcome.errorCode ?? "tool_failed";
      this.emitFailure({
        code: errorCode,
        message: outcome.message ?? summary,
        retryable: RETRYABLE_ERROR_CODES.has(errorCode),
        tool,
      });
    }

    if (fatal !== undefined) {
      this.abort(fatal);
      throw new RunAbortedError(fatal);
    }

    return outcome;
  }

  /**
   * Ask the host what happened to the bridge, and turn the answer into what
   * the model should read -- or into the end of the run.
   *
   * A restarted bridge is told to the model in its own words, because "fetch
   * failed" is undici's, and because the model has to know that Studio itself
   * is fine: a playtest it started is still running there, and its instance is
   * the same one. A bridge that could not come back ends the run, since every
   * further call would fail the same way and the model would have nothing left
   * to do but narrate that.
   */
  private async recoverBridge(
    bridge: BridgeRecoveryHost,
    tool: string,
    outcome: McpToolOutcome,
  ): Promise<Readonly<{ outcome: McpToolOutcome; fatal?: string }>> {
    let recovery: BridgeRecovery;
    try {
      recovery = await bridge.recover();
    } catch {
      // A host that cannot even answer the question has nothing to add.
      return { outcome };
    }
    if (this.cancelled) return { outcome };

    switch (recovery.kind) {
      case "answering":
        return { outcome };
      case "restarted": {
        const studio = recovery.studioConnected
          ? "Studio has connected to it again."
          : "Studio has not connected to it again yet; it retries on its own every few seconds.";
        this.emit({
          type: "status",
          label: "The Studio bridge stopped and was restarted",
          detail: studio,
        });
        return {
          outcome: {
            ...outcome,
            errorCode: "bridge_restarted",
            message: `${tool} did not run: Roqer's Studio bridge stopped and has been restarted. ${studio} Studio itself did not close: a playtest that was running is still running, and the instance is the same. Call get_connected_instances, then continue from the last result you trust.`,
          },
        };
      }
      case "unavailable":
        return {
          outcome: {
            ...outcome,
            errorCode: "bridge_unavailable",
            message: `${tool} did not run: Roqer's Studio bridge stopped and could not be restarted.`,
          },
          fatal: `Roqer's Studio bridge stopped and could not be restarted. ${recovery.message} Open the Studio status at the top of the chat and choose "Restart the bridge", or restart Roqer, then send the prompt again.`,
        };
    }
  }

  private trackPlaytestLifecycle(
    tool: string,
    args: Record<string, unknown>,
    outcome: McpToolOutcome,
  ): void {
    if (!outcome.ok || (tool !== "solo_playtest" && tool !== "multiplayer_playtest")) return;

    const action = args.action;
    const instanceId = typeof args.instance_id === "string" ? args.instance_id : undefined;
    const key = `${tool}:${instanceId ?? "default"}`;

    if (action === "start") {
      this.ownedPlaytests.set(key, {
        tool,
        cleanupAction: tool === "solo_playtest" ? "stop" : "end",
        instanceId,
      });
      return;
    }

    const multiplayerEnded = tool === "multiplayer_playtest" &&
      action === "end" &&
      (!isRecord(outcome.data) || outcome.data.teardownConfirmed !== false);
    if ((tool === "solo_playtest" && action === "stop") || multiplayerEnded) {
      this.ownedPlaytests.delete(key);
    }
  }

  /**
   * Restore running state that this run successfully created.
   *
   * This deliberately bypasses normal cancellation and approval handling: the
   * matching start was already allowed, and cleanup must still run after the
   * planner, provider, or user cancels the ordinary agent loop.
   */
  private async cleanupOwnedPlaytests(): Promise<void> {
    const owned = [...this.ownedPlaytests.values()].reverse();
    this.ownedPlaytests.clear();

    for (const playtest of owned) {
      const args: Record<string, unknown> = { action: playtest.cleanupAction, timeout: 15 };
      if (playtest.instanceId !== undefined) args.instance_id = playtest.instanceId;

      const callId = this.createId("call");
      const proposal: ToolProposal = {
        callId,
        tool: playtest.tool,
        arguments: args,
        summary: summarizeToolCall(playtest.tool, args),
        risk: riskForTool(playtest.tool),
      };

      this.emit({ type: "tool-proposed", proposal });
      this.emit({
        type: "approval-resolved",
        callId,
        decision: "approved",
        automatic: true,
        reason: "run-cleanup",
      });
      this.emit({ type: "tool-started", callId, tool: playtest.tool });

      let outcome: McpToolOutcome;
      try {
        outcome = await this.caller.callTool(playtest.tool, args, {
          timeoutMs: PLAYTEST_CLEANUP_TIMEOUT_MS,
        });
      } catch (error) {
        outcome = {
          ok: false,
          data: undefined,
          text: "",
          httpStatus: 0,
          errorCode: "playtest_cleanup_failed",
          message: error instanceof Error ? error.message : String(error),
          durationMs: 0,
        };
      }

      const teardownConfirmed = playtest.tool !== "multiplayer_playtest" ||
        !isRecord(outcome.data) ||
        outcome.data.teardownConfirmed !== false;
      const cleanupOk = outcome.ok && teardownConfirmed;
      const { summary, detail } = summarizeToolOutcome(playtest.tool, outcome);
      this.emit({
        type: "tool-result",
        callId,
        tool: playtest.tool,
        ok: cleanupOk,
        durationMs: outcome.durationMs,
        summary,
        detail,
      });

      if (!cleanupOk) {
        this.emitFailure({
          code: "playtest_cleanup_failed",
          message: !teardownConfirmed
            ? "Roqer requested playtest teardown, but Studio did not confirm that it finished."
            : outcome.message ?? "Roqer could not stop the playtest it started.",
          retryable: false,
          tool: playtest.tool,
        });
      }
    }
  }
}
