import type { ApprovalMode, PolicyReason, ToolRisk } from "./policy";
import type { ConversationContext } from "./conversation";
import type { CompletionVerification, CompletionIssueCode } from "./completion";
import { isReasoningEffort, type ProviderId, type ReasoningEffort } from "./provider";
import { isRunQuestion, type RunQuestion } from "./question";
import { isRunDecision, type RunDecision } from "./run-digest";
import { MAX_STEER_CHARS, MAX_STEERS_PER_RUN, isSteerNote } from "./steer";
import { isModelPreviewId } from "./model-preview";
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
  /**
   * A preview of image evidence, as a data URL. Made by the host from what the
   * tool returned, never by the model or the renderer, and kept with the chat,
   * so it is bounded by `isEvidenceImage`.
   */
  imageDataUrl?: string;
  /**
   * The same preview's name in the picture store beside the chat
   * (`isEvidencePictureRef`). A live run carries both, so the picture shows at
   * once; a saved run keeps only this, and the renderer asks the main process
   * for the picture when it is shown.
   */
  imageRef?: string;
  /**
   * The 3D preview of a Blender result, by the opaque id the main process
   * serves it under. Never a path; the preview may have expired since.
   */
  modelPreviewId?: string;
  /**
   * What the picture is of, as the host knows it, so pictures of one thing
   * are versions of one picture. A Blender job that continued an earlier job's
   * scene is a later version of that job's model, whatever file either wrote.
   * Opaque, and never shown; at most `MAX_EVIDENCE_SUBJECT_CHARS`.
   */
  subject?: string;
  /**
   * Set when the run took a picture here that the saved chat does not keep:
   * past a run's picture budget (`MAX_RECORDED_EVIDENCE_IMAGES`), the picture
   * is dropped from the record and this says so, so the answer can count what
   * it no longer shows instead of dropping it silently.
   */
  previewNotKept?: true;
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
  /**
   * How much the model has written in the response it is producing now, for
   * the waiting line. Live state like a transient status: never a step, never
   * kept. `exact` is the provider's own count, reported once a response ends;
   * otherwise it is estimated from what has streamed, which leaves out
   * reasoning a model does not show. A later response starts again from zero.
   */
  | (RunEventBase & { type: "output-tokens"; tokens: number; exact: boolean })
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
  /**
   * The notes the user added while the run worked, in order. Optional for the
   * same reason as `decisions`, and kept for the same one: they are the user
   * speaking, and a follow-up in a fresh provider session has no other way to
   * hear them. They are what the chat shows under the run once it has ended.
   */
  notes?: string[];
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

/**
 * How large a saved evidence preview may be.
 *
 * A preview outlives the run, in the picture store beside the chat or, when
 * it could not be stored there, inline in the chat file, so each is bounded
 * here. The host aims well below this; a record over it is damaged, not saved.
 */
export const MAX_EVIDENCE_IMAGE_CHARACTERS = 128 * 1024;

/**
 * How many evidence previews one run shows and keeps.
 *
 * Spent on distinct things first: the latest picture of each animation, model
 * or screenshot, newest first, and only then earlier versions of them. So an
 * agent revising one model five times never pushes a different picture out.
 * Pictures live in the picture store beside the chat, not in the chat file,
 * so this bounds a run's disk use (about 40 × 90 KB at most), not the chat's.
 */
export const MAX_RECORDED_EVIDENCE_IMAGES = 40;

/**
 * How many of those a saved run may keep inline in the chat file: pictures
 * that have no stored file, because the picture store could not take them or
 * there is none (the renderer in a plain browser). Inline pictures grow the
 * chat file itself, which is bounded, so they keep the old, tighter budget.
 */
export const MAX_INLINE_EVIDENCE_IMAGES = 6;

/**
 * A stored preview's name in the picture store: the SHA-256 of its bytes and
 * its type. It names a picture by its content, never a path, so the renderer
 * can ask for a picture but cannot name a file, and the main process can check
 * that what it read is the picture that was stored.
 */
const EVIDENCE_PICTURE_REF = /^[0-9a-f]{64}\.(jpg|png)$/;

export function isEvidencePictureRef(value: unknown): value is string {
  return typeof value === "string" && EVIDENCE_PICTURE_REF.test(value);
}

/**
 * The title of a Blender job's preview. The answer labels a preview by where it
 * came from, and this is how it tells a render of a file from a Studio capture.
 */
export const BLENDER_PREVIEW_TITLE = "Blender result, before upload";

/**
 * The title of an animation's preview: the contact sheet the animation tool
 * drew, whose 3D view plays the same box rig.
 */
export const ANIMATION_PREVIEW_TITLE = "Animation preview";

/**
 * Metadata on an animation's preview: the animation's name. Previews of one
 * name are versions of one animation, and the card shows them as one.
 */
export const ANIMATION_NAME_LABEL = "Animation";

/**
 * Metadata on an animation's preview: the rig it was drawn on, "R15", "R6" or
 * the path of the model whose own rig it is. Previews recorded before it
 * existed have none.
 */
export const ANIMATION_RIG_LABEL = "Rig";

/**
 * Metadata on an animation's preview or a rig's range sheet: which MeshParts
 * the MCP drew as their boxes instead of their meshes, and why, as its result
 * says. Absent when every part is drawn as itself, so a preview never passes a
 * box off as the model.
 */
export const ANIMATION_BOXES_LABEL = "Drawn as boxes";

/**
 * The title of a rig's range sheet: every joint of a creature's rig at rest and
 * turned a little each way, which the animation tool's rig action draws. It is
 * not an animation of the creature, and no check judged it.
 */
export const RIG_RANGE_SHEET_TITLE = "Rig range sheet";

/**
 * Metadata on a Blender preview: the file the pictured model was written to,
 * or "scene.blend" when the job exported nothing and its scene was pictured.
 * Which previews are versions of one model is the evidence's `subject`; runs
 * saved before that existed fall back to grouping by this.
 */
export const BLENDER_MODEL_LABEL = "Model";

/** How long a picture's subject may be (`RunEvidence.subject`). */
export const MAX_EVIDENCE_SUBJECT_CHARS = 200;

/**
 * Metadata on an animation build's verification: whether every motion check
 * passed ("All passed"), and whether the gait checks ran, which they do only
 * when the motion was checked as a gait.
 */
export const ANIMATION_MOTION_CHECKS_LABEL = "Motion checks";
export const ANIMATION_ALL_CHECKS_PASSED = "All passed";
export const ANIMATION_GAIT_CHECKS_LABEL = "Gait checks";
export const ANIMATION_CHECKED_AS_GAIT = "Checked as a gait";

/**
 * Metadata on an animation build's verification, when the pose description
 * came from a file a Blender job baked instead of being written in the call.
 */
export const ANIMATION_DESCRIBED_BY_LABEL = "Described by";
export const ANIMATION_DESCRIBED_BY_BAKE = "A file baked in Blender";

/** Metadata on a playtest verification of an animation: what played, the published asset or a temporary clip. */
export const ANIMATION_PLAYED_FROM_LABEL = "Played from";
export const ANIMATION_PLAYED_PUBLISHED = "The published asset";

/**
 * Metadata on a model's playtest verification: what its loader played while
 * it moved and while it stood, such as "walk 100%", and what moved it: the
 * game's own scripts while verify watched it, or verify walking it itself.
 */
export const MODEL_WHILE_MOVING_LABEL = "While moving";
export const MODEL_WHILE_STANDING_LABEL = "While standing";
export const MODEL_MOVED_BY_LABEL = "Moved by";
export const MODEL_MOVED_BY_GAME = "The game's own scripts";
export const MODEL_MOVED_BY_VERIFY = "verify, walking it to a position";

/** Metadata on a model's playtest verification that also checked one of its loader's states, such as "idle state". */
export function modelStateLabel(state: string): string {
  return `${state} state`;
}
export const MODEL_STATE_WIRED = "Wired";

/** Metadata on a playtest verification that also checked a default Animate slot, such as "run slot". */
export function animationSlotLabel(slot: string): string {
  return `${slot} slot`;
}

/**
 * Metadata on a Studio screenshot taken while a playtest this run started was
 * running, so the answer can say the picture shows the playtest.
 */
export const SCREENSHOT_VIEW_LABEL = "View";
export const SCREENSHOT_VIEW_PLAYTEST = "Playtest";

/** A bounded PNG or JPEG data URL: the only previews the host produces. */
export function isEvidenceImage(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_EVIDENCE_IMAGE_CHARACTERS &&
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
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
    (value.imageDataUrl === undefined || isEvidenceImage(value.imageDataUrl)) &&
    (value.imageRef === undefined || isEvidencePictureRef(value.imageRef)) &&
    (value.modelPreviewId === undefined || isModelPreviewId(value.modelPreviewId)) &&
    (value.previewNotKept === undefined || value.previewNotKept === true) &&
    (value.subject === undefined || (isString(value.subject) && value.subject.length > 0 && value.subject.length <= MAX_EVIDENCE_SUBJECT_CHARS)) &&
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
    case "output-tokens":
      return typeof value.tokens === "number" && Number.isSafeInteger(value.tokens) && value.tokens >= 0 &&
        typeof value.exact === "boolean";
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
      (Array.isArray(value.decisions) && value.decisions.every(isRunDecision))) &&
    (value.notes === undefined ||
      (Array.isArray(value.notes) && value.notes.length <= MAX_STEERS_PER_RUN && value.notes.every(isSteerNote)));
}
