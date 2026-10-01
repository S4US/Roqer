import type { ApprovalMode, PolicyReason, ToolRisk } from "../shared/policy";
import {
  activityKind, activityLabel, activityTarget, evidenceActivityKind, evidenceLabel,
  type ActivityKind,
} from "../shared/activity";
import { evaluateCompletion, type CompletionVerification } from "../shared/completion";
import type { RunQuestion } from "../shared/question";
import type { RunDecision } from "../shared/run-digest";
import type { RunTask } from "../shared/tasks";
import {
  MAX_INLINE_EVIDENCE_IMAGES, MAX_RECORDED_EVIDENCE_IMAGES, RUN_EVENT_SCHEMA_VERSION,
  type RunChange, type RunEvent, type RunEvidence, type RunFailure,
  type RunOutcome, type RunRecord, type ToolProposal,
} from "../shared/run-events";
import { keptPreviewIds, pictureCategory, type PictureCategory } from "./preview-layout";

/**
 * Folds the run event stream into what the conversation renders.
 *
 * The reducer is pure and lives apart from the component so the ordering rules
 * — which activity a result belongs to, when an approval stops being pending,
 * what happens to an out-of-order event — can be tested without React.
 */

export type ActivityState =
  | "proposed"
  | "awaiting-approval"
  | "rejected"
  | "running"
  | "done"
  | "failed";

export type RunActivity = {
  callId: string;
  tool: string;
  summary: string;
  risk: ToolRisk;
  state: ActivityState;
  durationMs?: number;
  resultSummary?: string;
  detail?: string;
};

export type PendingApproval = {
  callId: string;
  proposal: ToolProposal;
  reason: PolicyReason;
};

/**
 * One position in the activity layer, in the order it happened.
 *
 * Entries point at the tool call or evidence they describe rather than copying
 * it, so a later `tool-result` updates the entry that is already on screen. The
 * ordering has to be recorded as events arrive — a tool call and the evidence
 * it produced cannot be interleaved correctly after the fact.
 */
export type TimelineEntry =
  | { type: "tool"; key: string; callId: string }
  | { type: "note"; key: string; label: string; detail?: string }
  | { type: "evidence"; key: string; evidenceId: string };

/** One rendered line of the activity layer, resolved and ready to display. */
export type ActivityStep = {
  key: string;
  kind: ActivityKind;
  state: ActivityState;
  /** Verb plus subject, e.g. "Read ServerScriptService.Main". */
  label: string;
  /** Short result, shown beside the label. */
  note?: string;
  durationMs?: number;
  /** Raw tool output, shown only when expanded. */
  detail?: string;
  /** Present on an evidence entry, whose payload the step can disclose. */
  evidence?: RunEvidence;
  /**
   * The operation behind the step, on the steps that came from one. The
   * grouping model needs the operation and its target rather than the finished
   * label, so it can phrase the row for the state it is in and put the full
   * path and the raw summary in the details.
   */
  tool?: string;
  target?: string | null;
  /** The host's own summary of the result, unedited. */
  resultSummary?: string;
};

export type RunView = {
  runId: string;
  prompt: string;
  planner: string;
  approvalMode: ApprovalMode;
  status: { label: string; detail?: string } | null;
  /**
   * How much the model has written in the response it is producing now. Live
   * state for the waiting line: anything that hands the turn to a tool, an
   * approval, or the user clears it, since the next response counts afresh.
   */
  outputTokens: { tokens: number; exact: boolean } | null;
  text: string;
  activities: RunActivity[];
  /** What the agent did, in order. Resolve it with `activitySteps`. */
  timeline: TimelineEntry[];
  pendingApproval: PendingApproval | null;
  /** What the agent said it would do. Empty for a run that never planned. */
  tasks: RunTask[];
  /** Set while the agent is waiting on the user's answer. */
  pendingQuestion: RunQuestion | null;
  /** Every question answered, with the answer, so the record can keep them. */
  decisions: RunDecision[];
  /** Every note the user added, so the record can keep them. */
  notes: string[];
  changes: RunChange[];
  evidence: RunEvidence[];
  failures: RunFailure[];
  outcome: RunOutcome | null;
  summary: string;
  /**
   * The host's completion verdict, delivered with `run-completed`. The renderer
   * displays this rather than deciding for itself whether a run is verified.
   */
  verification: CompletionVerification | null;
  startedAt: string;
  finishedAt: string;
  lastSeq: number;
  /**
   * Set when an event arrives with an unexpected sequence number. The run is
   * still rendered, but the interface should stop claiming the timeline is
   * complete.
   */
  desynchronized: boolean;
};

export function createRunView(runId: string, prompt: string, approvalMode: ApprovalMode): RunView {
  return {
    runId,
    prompt,
    planner: "",
    approvalMode,
    status: null,
    outputTokens: null,
    text: "",
    activities: [],
    timeline: [],
    pendingApproval: null,
    tasks: [],
    pendingQuestion: null,
    decisions: [],
    notes: [],
    changes: [],
    evidence: [],
    failures: [],
    outcome: null,
    summary: "",
    verification: null,
    startedAt: "",
    finishedAt: "",
    lastSeq: 0,
    desynchronized: false,
  };
}

function updateActivity(
  view: RunView,
  callId: string,
  change: Partial<RunActivity>,
): RunActivity[] {
  return view.activities.map((activity) =>
    activity.callId === callId ? { ...activity, ...change } : activity);
}

export function applyRunEvent(view: RunView, event: RunEvent): RunView {
  if (event.runId !== view.runId) return view;

  const base: RunView = {
    ...view,
    lastSeq: event.seq,
    desynchronized: view.desynchronized || event.seq !== view.lastSeq + 1,
  };

  switch (event.type) {
    case "run-started":
      return {
        ...base,
        prompt: event.prompt,
        planner: event.planner,
        approvalMode: event.approvalMode,
        startedAt: event.at,
      };
    // Provider state is what the run is doing, not something it did: it belongs
    // to the live status line and leaves nothing behind in the timeline.
    case "status":
      return {
        ...base,
        status: { label: event.label, detail: event.detail },
        timeline: event.transient ? base.timeline : [...base.timeline, {
          type: "note",
          key: `note-${event.seq}`,
          label: event.label,
          detail: event.detail,
        }],
      };
    case "output-tokens":
      return { ...base, outputTokens: { tokens: event.tokens, exact: event.exact } };
    case "message-delta":
      return { ...base, text: base.text + event.text };
    case "tool-proposed":
      return {
        ...base,
        outputTokens: null,
        activities: [...base.activities, {
          callId: event.proposal.callId,
          tool: event.proposal.tool,
          summary: event.proposal.summary,
          risk: event.proposal.risk,
          state: "proposed",
        }],
        timeline: [...base.timeline, {
          type: "tool",
          key: `tool-${event.seq}`,
          callId: event.proposal.callId,
        }],
      };
    case "approval-requested":
      return {
        ...base,
        pendingApproval: { callId: event.callId, proposal: event.proposal, reason: event.reason },
        outputTokens: null,
        activities: updateActivity(base, event.callId, { state: "awaiting-approval" }),
      };
    case "approval-resolved":
      return {
        ...base,
        pendingApproval: base.pendingApproval?.callId === event.callId ? null : base.pendingApproval,
        activities: event.decision === "rejected"
          ? updateActivity(base, event.callId, { state: "rejected" })
          : base.activities,
      };
    case "tool-started":
      return { ...base, activities: updateActivity(base, event.callId, { state: "running" }) };
    case "tool-result":
      return {
        ...base,
        outputTokens: null,
        activities: updateActivity(base, event.callId, {
          state: event.ok ? "done" : "failed",
          durationMs: event.durationMs,
          resultSummary: event.summary,
          detail: event.detail,
        }),
      };
    case "change":
      return { ...base, changes: [...base.changes, event.change] };
    case "evidence":
      return {
        ...base,
        evidence: [...base.evidence, event.evidence],
        timeline: [...base.timeline, {
          type: "evidence",
          key: `evidence-${event.seq}`,
          evidenceId: event.evidence.id,
        }],
      };
    case "failure":
      return { ...base, failures: [...base.failures, event.failure] };
    // The plan is a layer of its own. Echoing "Planned the work · 2 of 5 done"
    // into the activity layer every time a task moves says nothing the plan is
    // not already saying, and on a long run it says it a dozen times.
    case "tasks":
      return { ...base, tasks: event.tasks };
    // What the person said mid-run sits in the timeline at the moment they said
    // it; the planner adds its own note when the model actually reads it.
    case "steer":
      return {
        ...base,
        notes: [...base.notes, event.text],
        timeline: [...base.timeline, { type: "note", key: `note-${event.seq}`, label: "You added a note", detail: event.text }],
      };
    case "question-asked":
      return {
        ...base,
        pendingQuestion: event.question,
        outputTokens: null,
        timeline: [...base.timeline, {
          type: "note",
          key: `note-${event.seq}`,
          label: "Asked you a question",
          detail: event.question.question,
        }],
      };
    case "question-answered": {
      // The question's text lives on the pending entry; an answer to a call
      // that is not the one pending has nothing to be recorded against.
      const answered = !event.cancelled && base.pendingQuestion?.callId === event.callId
        ? [{ question: base.pendingQuestion.question, answer: event.answer }]
        : [];
      return {
        ...base,
        pendingQuestion: base.pendingQuestion?.callId === event.callId ? null : base.pendingQuestion,
        decisions: [...base.decisions, ...answered],
        timeline: [...base.timeline, {
          type: "note",
          key: `note-${event.seq}`,
          label: event.cancelled ? "Question went unanswered" : "You answered",
          detail: event.cancelled ? "The run stopped first." : event.answer,
        }],
      };
    }
    case "run-completed":
      return {
        ...base,
        outcome: event.outcome,
        summary: event.summary,
        verification: event.verification,
        finishedAt: event.at,
        status: null,
        outputTokens: null,
        // A finished run has nothing left to approve or ask.
        pendingApproval: null,
        pendingQuestion: null,
      };
  }
}

export function isRunFinished(view: RunView): boolean {
  return view.outcome !== null;
}

/** Short label for a step that has not reported a result of its own. */
export function describeActivityState(state: ActivityState): string {
  switch (state) {
    case "proposed":
      return "Queued";
    case "awaiting-approval":
      return "Waiting for your approval";
    case "rejected":
      return "Not permitted";
    case "running":
      return "Working";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
  }
}

/** A call that has reported back is described in the past tense. */
function isSettled(state: ActivityState): boolean {
  return state === "done" || state === "failed" || state === "rejected";
}

function evidenceStep(key: string, evidence: RunEvidence): ActivityStep {
  return {
    key,
    kind: evidenceActivityKind(evidence.kind),
    state: evidence.passed === false ? "failed" : "done",
    label: evidenceLabel(evidence),
    note: evidence.passed === undefined ? undefined : evidence.passed ? "Passed" : "Failed",
    evidence,
  };
}

/**
 * Resolve the run's timeline into the lines the activity layer renders.
 *
 * Entries whose target is missing are skipped rather than rendered empty: a
 * dropped event should shorten the timeline, not put a blank row in it.
 */
export function activitySteps(view: Pick<RunView, "timeline" | "activities" | "evidence">): ActivityStep[] {
  const byCallId = new Map(view.activities.map((activity) => [activity.callId, activity]));
  const byEvidenceId = new Map(view.evidence.map((evidence) => [evidence.id, evidence]));
  const steps: ActivityStep[] = [];

  for (const entry of view.timeline) {
    if (entry.type === "note") {
      steps.push({ key: entry.key, kind: "note", state: "done", label: entry.label, note: entry.detail });
      continue;
    }
    if (entry.type === "evidence") {
      const evidence = byEvidenceId.get(entry.evidenceId);
      if (evidence) steps.push(evidenceStep(entry.key, evidence));
      continue;
    }
    const activity = byCallId.get(entry.callId);
    if (!activity) continue;
    const target = activityTarget(activity.tool, activity.summary);
    steps.push({
      key: entry.key,
      kind: activityKind(activity.tool, target),
      state: activity.state,
      label: activityLabel(activity.tool, target, isSettled(activity.state)),
      note: activity.resultSummary ?? describeActivityState(activity.state),
      durationMs: activity.durationMs,
      detail: activity.detail,
      tool: activity.tool,
      target,
      resultSummary: activity.resultSummary,
    });
  }
  return steps;
}

/**
 * The same lines for a run restored from chat history.
 *
 * The record keeps calls and evidence in separate lists rather than one
 * timeline, so history shows every call and then everything they proved. That
 * loses the interleaving, which is worth the smaller record.
 */
export function recordSteps(record: RunRecord): ActivityStep[] {
  return [
    ...record.toolCalls.map((call, index): ActivityStep => ({
      key: `call-${index}`,
      kind: activityKind(call.tool, call.target ?? null),
      state: call.ok ? "done" : "failed",
      label: activityLabel(call.tool, call.target ?? null, true),
      note: call.summary,
      durationMs: call.durationMs,
      tool: call.tool,
      target: call.target ?? null,
      resultSummary: call.summary,
    })),
    // What the person said stays under the run once it has ended, as it sat
    // in the live timeline; the record keeps no interleaving to place it by.
    ...(record.notes ?? []).map((text, index): ActivityStep => ({
      key: `note-${index}`, kind: "note", state: "done", label: "You added a note", note: text,
    })),
    ...record.evidence.map((evidence, index) => evidenceStep(`evidence-${index}`, evidence)),
  ];
}

/** Whether evidence carries a picture: inline, stored beside the chat, or both. */
export function hasPicture(evidence: RunEvidence): boolean {
  return evidence.imageDataUrl !== undefined || evidence.imageRef !== undefined;
}

/**
 * The ids of the pictures a run shows and keeps; see `keptPreviewIds`. Of
 * those, a picture with no stored file would be kept inside the chat file,
 * which is bounded, so only the most useful few of those stay.
 */
function keptImageIds(evidence: readonly RunEvidence[]): Set<string> {
  const pictures = evidence.filter(hasPicture);
  const kept = keptPreviewIds(pictures, MAX_RECORDED_EVIDENCE_IMAGES);
  const inline = pictures.filter((item) => kept.has(item.id) && item.imageRef === undefined);
  if (inline.length <= MAX_INLINE_EVIDENCE_IMAGES) return kept;
  const inlineKept = keptPreviewIds(inline, MAX_INLINE_EVIDENCE_IMAGES);
  return new Set(pictures
    .filter((item) => kept.has(item.id) && (item.imageRef !== undefined || inlineKept.has(item.id)))
    .map((item) => item.id));
}

/**
 * The evidence as it is saved: every item, but only the pictures within the
 * run's budget, and a stored picture by its ref alone.
 *
 * The latest picture of each thing is kept first, so what the run ended on
 * survives; a picture past the budget leaves its evidence behind, marked, so
 * the answer can say how many it no longer shows, and its stored file goes
 * once no chat refers to it.
 */
export function recordedEvidence(evidence: readonly RunEvidence[]): RunEvidence[] {
  const kept = keptImageIds(evidence);
  return evidence.map((item) => {
    if (!hasPicture(item)) return item;
    if (kept.has(item.id)) {
      if (item.imageRef === undefined || item.imageDataUrl === undefined) return item;
      const stored: RunEvidence = { ...item };
      delete stored.imageDataUrl;
      return stored;
    }
    const trimmed: RunEvidence = { ...item, previewNotKept: true };
    delete trimmed.imageDataUrl;
    delete trimmed.imageRef;
    return trimmed;
  });
}

/**
 * The evidence previews to show in an answer, oldest first: the same pictures
 * the saved chat keeps, so the card does not change when the run ends.
 */
export function evidenceImages(evidence: readonly RunEvidence[]): RunEvidence[] {
  const kept = keptImageIds(evidence);
  return evidence.filter((item) => hasPicture(item) && kept.has(item.id));
}

/**
 * How many pictures the run took that the answer does not show, live or saved;
 * with `category`, only those that belong in that tab. The budget is the whole
 * run's, so which pictures were kept is decided over all of them.
 */
export function previewsNotShown(evidence: readonly RunEvidence[], category?: PictureCategory): number {
  const kept = keptImageIds(evidence);
  return evidence.filter((item) => (category === undefined || pictureCategory(item) === category)
    && (hasPicture(item) ? !kept.has(item.id) : item.previewNotKept === true)).length;
}

/**
 * Compact a finished run for persistence. Live-only detail — progress lines and
 * the prose, which is kept as the message text — is dropped, so chat history
 * does not grow with every run.
 */
export function toRunRecord(view: RunView): RunRecord | null {
  if (view.outcome === null) return null;
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    runId: view.runId,
    planner: view.planner,
    approvalMode: view.approvalMode,
    outcome: view.outcome,
    startedAt: view.startedAt || view.finishedAt,
    finishedAt: view.finishedAt,
    toolCalls: view.activities
      .filter((activity) => activity.state === "done" || activity.state === "failed")
      .map((activity) => {
        const target = activityTarget(activity.tool, activity.summary);
        return {
          tool: activity.tool,
          ok: activity.state === "done",
          durationMs: activity.durationMs ?? 0,
          summary: activity.resultSummary ?? activity.summary,
          ...(target !== null ? { target } : {}),
        };
      }),
    changes: view.changes,
    evidence: recordedEvidence(view.evidence),
    failures: view.failures,
    ...(view.tasks.length > 0 ? { tasks: view.tasks } : {}),
    ...(view.verification ? { verification: view.verification } : {}),
    ...(view.decisions.length > 0 ? { decisions: view.decisions } : {}),
    ...(view.notes.length > 0 ? { notes: view.notes } : {}),
  };
}

/**
 * Whether a run reached its goal with something broken along the way.
 *
 * A planner can finish, and answer well, while a tool call it made failed —
 * a read that timed out, a property write Studio rejected. The run is not a
 * failure, but calling it a clean "Completed" hides the part the reader most
 * needs to check, so the two are labelled differently.
 */
export function runHasWarnings(view: RunView): boolean {
  if (view.outcome !== "completed") return false;
  return view.failures.length > 0 ||
    view.evidence.some((item) => item.passed === false) ||
    view.activities.some((activity) => activity.state === "failed");
}

/**
 * The completion verdict, from the host when it sent one.
 *
 * Runs recorded before the gate existed carry no verdict, so those are scored
 * here with the same shared rules rather than left permanently unverifiable.
 */
function verificationOf(
  source: { verification?: CompletionVerification | null; outcome: RunOutcome | null; tasks?: readonly RunTask[];
    changes: readonly RunChange[]; evidence: readonly RunEvidence[]; failures: readonly RunFailure[] },
): CompletionVerification {
  if (source.verification) return source.verification;
  return evaluateCompletion({
    outcome: source.outcome ?? "",
    tasks: source.tasks ?? [],
    changes: source.changes,
    evidence: source.evidence,
    failureCount: source.failures.length,
  });
}

/**
 * Whether the compact "applied and verified" state may be shown.
 *
 * The gate answers whether the result is trustworthy; this adds the two
 * presentation conditions the badge itself implies — that something was in fact
 * applied, and that it was code, which is the only kind of change the read-back
 * protocol covers.
 */
function appliedAndVerified(
  verification: CompletionVerification,
  changes: readonly RunChange[],
): boolean {
  return verification.verified &&
    changes.length > 0 &&
    changes.every((change) => change.kind === "script-source");
}

export function runAppliedAndVerified(view: RunView): boolean {
  return appliedAndVerified(verificationOf(view), view.changes);
}

export function recordAppliedAndVerified(record: RunRecord): boolean {
  return appliedAndVerified(verificationOf(record), record.changes);
}

/** The gate's complaints, for the completion card. Empty when it passed. */
export function runGateIssues(view: RunView): string[] {
  return view.outcome === "completed" ? verificationOf(view).issues.map((issue) => issue.detail) : [];
}

export function recordGateIssues(record: RunRecord): string[] {
  return record.outcome === "completed" ? verificationOf(record).issues.map((issue) => issue.detail) : [];
}

/** The same question for a run restored from chat history. */
export function recordHasWarnings(record: RunRecord): boolean {
  if (record.outcome !== "completed") return false;
  return record.failures.length > 0 ||
    record.evidence.some((item) => item.passed === false) ||
    record.toolCalls.some((call) => !call.ok);
}

/**
 * A run that only answered.
 *
 * The completion card is a receipt for work, and a receipt for no work is
 * noise: someone who said hello got a reply, and the reply is the entire
 * result. "Completed · 0 tool calls" underneath it says nothing they could not
 * already see, and makes a two-line conversation look like a build.
 *
 * The card is kept for every run carrying something the reply alone does not
 * show — anything the run touched, anything it promised in a plan, anything
 * that failed or went unverified, and any ending other than a clean completion.
 * It is also kept for a run that produced no answer at all, which would
 * otherwise finish with nothing on screen.
 */
function onlyAnswered(source: {
  outcome: RunOutcome | null;
  answered: boolean;
  toolCalls: number;
  changes: number;
  tasks: number;
  warnings: boolean;
  issues: number;
}): boolean {
  return source.outcome === "completed" &&
    source.answered &&
    source.toolCalls === 0 &&
    source.changes === 0 &&
    source.tasks === 0 &&
    !source.warnings &&
    source.issues === 0;
}

export function runOnlyAnswered(view: RunView): boolean {
  return onlyAnswered({
    outcome: view.outcome,
    answered: view.text.trim() !== "",
    toolCalls: view.activities.length,
    changes: view.changes.length,
    tasks: view.tasks.length,
    warnings: runHasWarnings(view),
    issues: runGateIssues(view).length,
  });
}

/** The same question for a run restored from chat history. */
export function recordOnlyAnswered(record: RunRecord, text: string): boolean {
  return onlyAnswered({
    outcome: record.outcome,
    answered: text.trim() !== "",
    toolCalls: record.toolCalls.length,
    changes: record.changes.length,
    tasks: (record.tasks ?? []).length,
    warnings: recordHasWarnings(record),
    issues: recordGateIssues(record).length,
  });
}

/** Short label for the run's terminal state, shown on the completion card. */
export function describeOutcome(outcome: RunOutcome, warnings = false): string {
  switch (outcome) {
    case "completed":
      return warnings ? "Completed with warnings" : "Completed";
    case "cancelled":
      return "Stopped";
    case "refused":
      return "Not permitted";
    case "failed":
      return "Failed";
  }
}
