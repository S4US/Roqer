import type { ApprovalMode, PolicyReason, ToolRisk } from "./policy";
import type { ConversationContext } from "./conversation";
import type { CompletionVerification, CompletionIssueCode } from "./completion";
import { isReasoningEffort, type ProviderId, type ReasoningEffort } from "./provider";
import { isRunQuestion, type RunQuestion } from "./question";
import { isRunDecision, type RunDecision } from "./run-digest";
import { MAX_STEER_CHARS } from "./steer";
import {
  isRunTaskList,
  RUN_EVIDENCE_REQUIREMENTS,
  type RunEvidenceRequirement,
  type RunTask,
} from "./tasks";

/**
 * The provider-neutral run event schema.
 *
 * Every agent run — whatever model provider drives it — is described as an
 * ordered stream of these events. The main process produces them, the IPC
 * channel forwards them, the renderer folds them into the activity timeline,
 * and a compacted subset is persisted with the chat. Nothing in this file knows
 * about a specific provider, about Electron, or about the DOM, so both sides of
 * the bridge can depend on it.
 *
 * Events are strictly ordered per run by `seq`, starting at 1. A renderer that
 * receives events out of order, or misses one, can detect it from the gap.
 */

export const RUN_EVENT_SCHEMA_VERSION = 1;

/** What the caller asks the main process to run. */
export type RunRequest = {
  runId: string;
  projectId: string;
  chatId: string;
  prompt: string;
  /** Prior messages from this same chat, bounded before crossing IPC. */
  conversation: ConversationContext;
  approvalMode: ApprovalMode;
  autoPlaytest: boolean;
  /** Loopback MCP endpoint, e.g. http://127.0.0.1:58741 */
  endpoint: string;
  /** Studio instance to target, or null to let the server resolve a default. */
  instanceId: string | null;
  /** Which managed sign-in drives the run. */
  provider: ProviderId;
  model: string | null;
  effort: ReasoningEffort;
};

/**
 * What the renderer sends. The main process mints the `runId` so that the
 * identity of a run is never chosen by the less-trusted side of the bridge.
 */
export type RunStartRequest = Omit<RunRequest, "runId"> & {
  /** Correlates a cancellable startup before the host has created a run. */
  startId?: string;
  /** Opaque handles issued by the native file picker; never filesystem paths. */
  attachmentIds?: string[];
};

export type RunOutcome =
  /** The agent finished the work it set out to do. */
  | "completed"
  /** The user stopped the run. */
  | "cancelled"
  /** The run hit an error it could not recover from. */
  | "failed"
  /** The agent explicitly ended because no permitted path remained after a refusal. */
  | "refused";

export type ToolProposal = {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** One-line human summary, safe to render directly. */
  summary: string;
  risk: ToolRisk;
};

export type RunChange = {
  id: string;
  kind: "script-source" | "properties" | "instance" | "asset";
  /** Full instance path of what changed. */
  target: string;
  /** Studio instance that received the change, when the run selected one. */
  instanceId?: string;
  summary: string;
  addedLines?: number;
  removedLines?: number;
  /**
   * Unified line diff of the change: `+` added, `-` removed, a leading space
   * for context, `@@ … @@` where unchanged lines were elided. Built by
   * `shared/text-diff.ts` beside the write, since only the producer has both
   * versions.
   */
  diff?: string;
  /**
   * The resulting source, for a change with nothing to diff against — a script
   * written for the first time, or one too long to diff.
   */
  code?: string;
  /** Language of `code` and `diff`, e.g. "lua". */
  language?: string;
  /** True when `code` or `diff` was cut to keep the event small. */
  truncated?: boolean;
  /** File coordinates where a localized diff starts. Defaults to line 1. */
  oldStartLine?: number;
  newStartLine?: number;
  /** Source revision fingerprints around a script write, when available. */
  revisionBefore?: string;
  revisionAfter?: string;
  /** Task that was active when the host recorded this change. */
  taskId?: string;
  /** Roblox upload result fields; present only for kind="asset". */
  assetId?: string;
  assetUrl?: string;
  assetType?: string;
  moderationState?: string;
  operationId?: string;
};

/**
 * A low-level fact about how a run reached its result — a source revision, an
 * expected-versus-actual fingerprint, an instance id.
 *
 * These are what makes a result auditable, not what makes it readable, so the
 * renderer keeps them behind a disclosure rather than in the prose.
 */
export type RunMetadata = { label: string; value: string };

export type RunEvidence = {
  id: string;
  kind: "inspection" | "verification" | "playtest" | "screenshot" | "logs" | "interaction";
  title: string;
  /** Present when the evidence is a pass/fail check. */
  passed?: boolean;
  detail?: string;
  /** Short, already-compacted lines. Large payloads never reach the renderer. */
  lines?: string[];
  /** How `lines` should read: prose by default, or verbatim source. */
  format?: "text" | "code";
  /** Data URL for image evidence. Producers must keep this small. */
  imageDataUrl?: string;
  /** Shown only when the reader expands the card. */
  metadata?: RunMetadata[];
  /** Observation dimension this evidence is allowed to satisfy. */
  requirement?: RunEvidenceRequirement;
  /** Task that was active when the host recorded this evidence. */
  taskId?: string;
  /** Latest change for that task when this observation was recorded. */
  afterChangeId?: string;
  /** Mutation kind this evidence verifies directly, when applicable. */
  changeKind?: RunChange["kind"];
};

export type RunFailure = {
  code: string;
  message: string;
  retryable: boolean;
  tool?: string;
};

type RunEventBase = {
  runId: string;
  /** 1-based, strictly increasing within a run. */
  seq: number;
  at: string;
};

export type RunEvent =
  | (RunEventBase & {
    type: "run-started";
    prompt: string;
    approvalMode: ApprovalMode;
    autoPlaytest: boolean;
    endpoint: string;
    instanceId: string | null;
    model: string | null;
    effort: ReasoningEffort;
    /** Identifies which agent produced the run, e.g. "inspection". */
    planner: string;
  })
  /**
   * Progress the user should see while waiting; not part of the transcript.
   *
   * `transient` marks the provider's own state — connecting, thinking — which
   * says what is happening now rather than recording something that happened.
   * The interface shows it as the run's live state and never keeps it as a
   * completed step, because "Thinking with ChatGPT" is what the agent does for
   * the whole run, not one of the things it did.
   */
  | (RunEventBase & { type: "status"; label: string; detail?: string; transient?: boolean })
  /** A chunk of assistant prose. Concatenating deltas rebuilds the reply. */
  | (RunEventBase & { type: "message-delta"; text: string })
  | (RunEventBase & { type: "tool-proposed"; proposal: ToolProposal })
  | (RunEventBase & {
    type: "approval-requested";
    callId: string;
    proposal: ToolProposal;
    reason: PolicyReason;
  })
  | (RunEventBase & {
    type: "approval-resolved";
    callId: string;
    decision: "approved" | "rejected";
    /** True when policy decided without asking the user. */
    automatic: boolean;
    reason: PolicyReason;
  })
  | (RunEventBase & { type: "tool-started"; callId: string; tool: string })
  | (RunEventBase & {
    type: "tool-result";
    callId: string;
    tool: string;
    ok: boolean;
    durationMs: number;
    /** Compacted result summary. The full payload stays in the main process. */
    summary: string;
    detail?: string;
  })
  | (RunEventBase & { type: "change"; change: RunChange })
  | (RunEventBase & { type: "evidence"; evidence: RunEvidence })
  | (RunEventBase & { type: "failure"; failure: RunFailure })
  /**
   * The run's task list, in full, every time it changes. Sending the whole list
   * rather than a patch means a dropped event costs one stale render instead of
   * permanently desynchronizing the renderer from the engine.
   */
  | (RunEventBase & { type: "tasks"; tasks: RunTask[] })
  /**
   * A note the user added while the run was working, as the engine accepted
   * it. Emitted when queued, not when read: the timeline shows what was said
   * and when, and the planner records separately when the model saw it.
   */
  | (RunEventBase & { type: "steer"; text: string })
  | (RunEventBase & { type: "question-asked"; question: RunQuestion })
  | (RunEventBase & {
    type: "question-answered";
    callId: string;
    /** Index into the question's own options; never renderer-authored text. */
    answerIndex: number;
    answer: string;
    /** True when the run ended before the user chose. */
    cancelled: boolean;
  })
  | (RunEventBase & {
    type: "run-completed";
    outcome: RunOutcome;
    summary: string;
    /** The host-owned gate's verdict. Absent only on pre-gate history. */
    verification: CompletionVerification;
  });

export type RunEventType = RunEvent["type"];

/**
 * One run event without the fields its emitter fills in.
 *
 * Distributing over the union matters: a plain `Omit<RunEvent, ...>` collapses
 * the union to the keys every variant shares — just `type` — so every other
 * field silently becomes an excess property. Producers should build events as
 * a `RunEventBody` so each variant's own required fields stay checked.
 */
export type RunEventBody = RunEvent extends infer Variant
  ? Variant extends RunEvent ? Omit<Variant, "runId" | "seq" | "at"> : never
  : never;

/**
 * A compacted run, persisted alongside the assistant message it produced, so a
 * finished run still reads correctly after a restart. Live-only events
 * (`status`, `message-delta`) are not kept.
 */
export type RunRecord = {
  schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  runId: string;
  planner: string;
  approvalMode: ApprovalMode;
  outcome: RunOutcome;
  startedAt: string;
  finishedAt: string;
  toolCalls: Array<{
    tool: string;
    ok: boolean;
    durationMs: number;
    summary: string;
    /** What the call was about, so history can label it the way the live run did. */
    target?: string;
  }>;
  changes: RunChange[];
  evidence: RunEvidence[];
  failures: RunFailure[];
  /**
   * Optional so records written before the task lifecycle and the completion
   * gate existed still validate. History from those runs simply has no task
   * list, and the renderer falls back to computing its own verdict.
   */
  tasks?: RunTask[];
  verification?: CompletionVerification;
  /**
   * What the user answered when the run asked. Optional for the same reason as
   * `tasks`. Kept on the record because it is the one thing here the host did
   * not observe from Studio: a decision only the user could make, which a
   * follow-up run would otherwise have to ask for again.
   */
  decisions?: RunDecision[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const APPROVAL_MODES: readonly string[] = ["Ask first", "Auto approve", "Full auto", "Read only"];
const RISKS: readonly string[] = ["read", "mutation", "irreversible"];
const OUTCOMES: readonly string[] = ["completed", "cancelled", "failed", "refused"];

function isProposal(value: unknown): value is ToolProposal {
  return isRecord(value) &&
    isString(value.callId) &&
    isString(value.tool) &&
    isString(value.summary) &&
    RISKS.includes(value.risk as string) &&
    isRecord(value.arguments);
}

/** Optional, so absent is valid; present but of the wrong type is not. */
const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);
const isOptionalAssetId = (value: unknown): boolean =>
  value === undefined || (isString(value) && /^\d+$/.test(value));
const isOptionalAssetUrl = (value: unknown): boolean =>
  value === undefined || (isString(value) && /^https:\/\/create\.roblox\.com\/store\/asset\/\d+$/.test(value));
const isOptionalLineNumber = (value: unknown): boolean =>
  value === undefined || (Number.isInteger(value) && (value as number) >= 1);

function isChange(value: unknown): value is RunChange {
  return isRecord(value) &&
    isString(value.id) &&
    isString(value.target) &&
    isOptionalString(value.instanceId) &&
    isString(value.summary) &&
    isOptionalString(value.diff) &&
    isOptionalString(value.code) &&
    isOptionalString(value.language) &&
    isOptionalString(value.taskId) &&
    isOptionalAssetId(value.assetId) &&
    isOptionalAssetUrl(value.assetUrl) &&
    isOptionalString(value.assetType) &&
    isOptionalString(value.moderationState) &&
    isOptionalString(value.operationId) &&
    isOptionalLineNumber(value.oldStartLine) &&
    isOptionalLineNumber(value.newStartLine) &&
    ["script-source", "properties", "instance", "asset"].includes(value.kind as string);
}

/** Optional, so absent is valid; present but malformed is not. */
function isMetadataList(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) &&
    value.every((entry) => isRecord(entry) && isString(entry.label) && isString(entry.value));
}

function isEvidence(value: unknown): value is RunEvidence {
  return isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    ["inspection", "verification", "playtest", "screenshot", "logs", "interaction"].includes(value.kind as string) &&
    (value.format === undefined || value.format === "text" || value.format === "code") &&
    (value.requirement === undefined ||
      RUN_EVIDENCE_REQUIREMENTS.includes(value.requirement as RunEvidenceRequirement)) &&
    isOptionalString(value.taskId) &&
    isOptionalString(value.afterChangeId) &&
    (value.changeKind === undefined ||
      ["script-source", "properties", "instance", "asset"].includes(value.changeKind as string)) &&
    isMetadataList(value.metadata);
}

function isFailure(value: unknown): value is RunFailure {
  return isRecord(value) &&
    isString(value.code) &&
    isString(value.message) &&
    typeof value.retryable === "boolean";
}

const ISSUE_CODES: readonly CompletionIssueCode[] = [
  "unverified-change",
  "missing-runtime-evidence",
  "failed-evidence",
  "tool-failure",
  "task-incomplete",
  "unaudited-interface",
];

export function isCompletionVerification(value: unknown): value is CompletionVerification {
  return isRecord(value) &&
    typeof value.verified === "boolean" &&
    Array.isArray(value.issues) &&
    value.issues.every((issue) => isRecord(issue) &&
      isString(issue.detail) &&
      (ISSUE_CODES as readonly string[]).includes(issue.code as string));
}

/**
 * Validate an event that arrived over IPC or came back from disk. The renderer
 * must not trust the shape of anything it did not construct itself.
 */
export function isRunEvent(value: unknown): value is RunEvent {
  if (!isRecord(value)) return false;
  if (!isString(value.runId) || !isString(value.at)) return false;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) return false;

  switch (value.type) {
    case "run-started":
      return isString(value.prompt) &&
        APPROVAL_MODES.includes(value.approvalMode as string) &&
        typeof value.autoPlaytest === "boolean" &&
        isString(value.endpoint) &&
        isString(value.planner) &&
        (value.model === null || isString(value.model)) &&
        isReasoningEffort(value.effort) &&
        (value.instanceId === null || isString(value.instanceId));
    case "status":
      return isString(value.label) &&
        (value.transient === undefined || typeof value.transient === "boolean");
    case "message-delta":
      return isString(value.text);
    case "tool-proposed":
      return isProposal(value.proposal);
    case "approval-requested":
      return isString(value.callId) && isProposal(value.proposal) && isString(value.reason);
    case "approval-resolved":
      return isString(value.callId) &&
        (value.decision === "approved" || value.decision === "rejected") &&
        typeof value.automatic === "boolean" &&
        isString(value.reason);
    case "tool-started":
      return isString(value.callId) && isString(value.tool);
    case "tool-result":
      return isString(value.callId) &&
        isString(value.tool) &&
        typeof value.ok === "boolean" &&
        typeof value.durationMs === "number" &&
        isString(value.summary);
    case "change":
      return isChange(value.change);
    case "evidence":
      return isEvidence(value.evidence);
    case "failure":
      return isFailure(value.failure);
    case "tasks":
      return isRunTaskList(value.tasks);
    case "steer":
      return isString(value.text) && value.text !== "" && value.text.length <= MAX_STEER_CHARS;
    case "question-asked":
      return isRunQuestion(value.question);
    case "question-answered":
      return isString(value.callId) &&
        isString(value.answer) &&
        typeof value.cancelled === "boolean" &&
        Number.isInteger(value.answerIndex) && (value.answerIndex as number) >= 0;
    case "run-completed":
      return OUTCOMES.includes(value.outcome as string) &&
        isString(value.summary) &&
        isCompletionVerification(value.verification);
    default:
      return false;
  }
}

export function isRunRecord(value: unknown): value is RunRecord {
  return isRecord(value) &&
    value.schemaVersion === RUN_EVENT_SCHEMA_VERSION &&
    isString(value.runId) &&
    isString(value.planner) &&
    isString(value.startedAt) &&
    isString(value.finishedAt) &&
    APPROVAL_MODES.includes(value.approvalMode as string) &&
    OUTCOMES.includes(value.outcome as string) &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every((call) => isRecord(call) && isString(call.tool) && typeof call.ok === "boolean") &&
    Array.isArray(value.changes) && value.changes.every(isChange) &&
    Array.isArray(value.evidence) && value.evidence.every(isEvidence) &&
    Array.isArray(value.failures) && value.failures.every(isFailure) &&
    (value.tasks === undefined || isRunTaskList(value.tasks)) &&
    (value.verification === undefined || isCompletionVerification(value.verification)) &&
    (value.decisions === undefined ||
      (Array.isArray(value.decisions) && value.decisions.every(isRunDecision)));
}
