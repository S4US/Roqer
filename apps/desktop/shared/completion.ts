/**
 * The host-owned completion gate.
 *
 * A run that finishes is not the same as a run whose claims are backed by
 * evidence, and until now only the renderer knew the difference — it recomputed
 * a badge from the changes and evidence it happened to receive. That put the
 * judgement on the least trusted side of the bridge and left the model with no
 * feedback at all.
 *
 * This module is the single answer to "is this run's result trustworthy", and
 * the main process computes it before `run-completed` leaves the engine. A run
 * may still finish with an honest caveat; what it may not do is present a clean
 * verified state while required evidence is missing, failed, stale, or tied to
 * a revision other than the one the write reported.
 *
 * It deliberately imports no run-event types — only the structural fields it
 * reads — so the event schema can depend on this rather than the other way
 * round.
 */

import {
  unfinishedTasks,
  type RunEvidenceRequirement,
  type RunTask,
} from "./tasks";

/** Metadata label under which a write records the revision it produced. */
export const REVISION_AFTER_LABEL = "Revision after write";
/** The title of the evidence an `inspect_ui` audit records. */
export const UI_AUDIT_TITLE = "Interface audit";
/** On an audit: the id of the run's latest change when it ran, or "none". */
export const AUDITED_AFTER_LABEL = "Latest change before audit";

/** Whether a change's target is interface: anything under StarterGui or a PlayerGui. */
export function isInterfaceTarget(target: string): boolean {
  return /^game\.StarterGui(\.|$)/.test(target) || /\.PlayerGui(\.|$)/.test(target);
}

export type CompletionIssueCode =
  /** A script was written but never read back at the revision the write reported. */
  | "unverified-change"
  /** A task that declared it needed runtime evidence finished without any. */
  | "missing-runtime-evidence"
  /** Evidence was collected and it failed. */
  | "failed-evidence"
  /** A tool call or the run itself reported a failure. */
  | "tool-failure"
  /** The run ended with tasks still open. */
  | "task-incomplete"
  /** Interface changed and no clean UI audit followed the last change. */
  | "unaudited-interface";

export type CompletionIssue = {
  code: CompletionIssueCode;
  /** One sentence, safe to show the user and to hand back to the model. */
  detail: string;
};

export type CompletionVerification = {
  /** True only when nothing below was found. */
  verified: boolean;
  issues: CompletionIssue[];
};

/** The fields of a run change the gate reads. `RunChange` satisfies this. */
export type GateChange = {
  id?: string;
  kind: string;
  target: string;
  revisionAfter?: string;
  taskId?: string;
};

/** The fields of run evidence the gate reads. `RunEvidence` satisfies this. */
export type GateEvidence = {
  kind: string;
  title: string;
  passed?: boolean;
  metadata?: ReadonlyArray<{ label: string; value: string }>;
  requirement?: RunEvidenceRequirement;
  taskId?: string;
  afterChangeId?: string;
  changeKind?: string;
};

export type GateInput = {
  outcome: string;
  tasks: readonly RunTask[];
  changes: readonly GateChange[];
  evidence: readonly GateEvidence[];
  failureCount: number;
};

/**
 * Whether one script write was read back at the revision it produced.
 *
 * A verification whose recorded revision disagrees with the write's is not a
 * weaker pass, it is evidence about a different version of the file, so it does
 * not count. A write that reported no revision at all can only be matched by
 * target, which is the most the bridge gave us to work with.
 */
function changeIsVerified(change: GateChange, evidence: readonly GateEvidence[]): boolean {
  // Property writes and builds are checked by Studio inside the call itself,
  // so their evidence is a verification of the same kind for the same target.
  if (change.kind === "properties" || change.kind === "instance") {
    return evidence.some((item) =>
      item.kind === "verification" &&
      item.changeKind === change.kind &&
      item.title === change.target &&
      item.passed === true);
  }
  return evidence.some((item) =>
    item.kind === "verification" &&
    (item.changeKind === undefined || item.changeKind === "script-source") &&
    item.title === change.target &&
    item.passed === true &&
    (change.revisionAfter === undefined ||
      item.metadata?.some((entry) =>
        entry.label === REVISION_AFTER_LABEL && entry.value === change.revisionAfter) === true));
}

/** True when the run collected at least one passing runtime observation. */
function hasRuntimeEvidence(evidence: readonly GateEvidence[]): boolean {
  return evidence.some((item) =>
    (item.kind === "playtest" || item.kind === "logs" || item.kind === "screenshot") &&
    item.passed !== false);
}

/**
 * The change a task's evidence has to be newer than.
 *
 * A task's own last change, and failing that the run's. The fallback is the
 * whole point: a task that verifies rather than edits makes no changes by
 * definition, so "the last change by this task" is undefined for exactly the
 * tasks whose purpose is to observe — and both the stamp and the check that
 * used it silently stopped applying there. A run could mark "Visually verify
 * the updated preview" done against a screenshot with no stamp at all, and did.
 *
 * What such a task must be newer than is the state it claims to describe, which
 * is whatever the run last changed, whoever changed it.
 *
 * Exported because `RunSession` stamps evidence with this and the gate checks
 * it. Two copies of the rule would be free to disagree, and when they agreed by
 * accident before, they agreed on requiring nothing.
 */
export function evidenceBaselineChangeId(
  changes: readonly GateChange[],
  taskId: string | undefined,
): string | undefined {
  if (taskId === undefined) return undefined;
  const own = [...changes].reverse().find((change) => change.taskId === taskId);
  return (own ?? changes[changes.length - 1])?.id;
}

function typedEvidenceIsFresh(
  task: RunTask,
  requirement: RunEvidenceRequirement,
  changes: readonly GateChange[],
  evidence: readonly GateEvidence[],
): boolean {
  const baseline = evidenceBaselineChangeId(changes, task.id);
  return evidence.some((item) =>
    item.requirement === requirement &&
    item.taskId === task.id &&
    item.passed !== false &&
    (baseline === undefined || item.afterChangeId === baseline));
}

function metadataValue(item: GateEvidence, label: string): string | undefined {
  return item.metadata?.find((entry) => entry.label === label)?.value;
}

/** A later passing check of the same fact resolves an earlier failed attempt. */
function failedEvidenceIsUnresolved(
  failed: GateEvidence,
  index: number,
  evidence: readonly GateEvidence[],
): boolean {
  const failedRevision = metadataValue(failed, REVISION_AFTER_LABEL);
  return !evidence.slice(index + 1).some((later) =>
    later.passed === true &&
    later.kind === failed.kind &&
    later.title === failed.title &&
    later.requirement === failed.requirement &&
    later.taskId === failed.taskId &&
    later.changeKind === failed.changeKind &&
    (failedRevision === undefined || metadataValue(later, REVISION_AFTER_LABEL) === failedRevision));
}

/**
 * A run that changed interface must end on a clean UI audit taken after its
 * last interface change. A screenshot cannot stand in: a live shop passed its
 * own screenshot review with card titles under their badges and a row the
 * scroll could not reach, all of which the audit measures. The latest audit is
 * what counts, whichever task recorded it.
 */
function interfaceAuditIssue(changes: readonly GateChange[], evidence: readonly GateEvidence[]): CompletionIssue | undefined {
  let lastInterface = -1;
  changes.forEach((change, index) => {
    if (isInterfaceTarget(change.target)) lastInterface = index;
  });
  if (lastInterface < 0) return undefined;
  const changeIndex = new Map(changes.map((change, index) => [change.id, index]));
  const audits = evidence.filter((item) => item.kind === "inspection" && item.title === UI_AUDIT_TITLE);
  const fresh = audits.filter((item) => {
    const after = metadataValue(item, AUDITED_AFTER_LABEL);
    return after !== undefined && (changeIndex.get(after) ?? -1) >= lastInterface;
  });
  const latest = fresh.at(-1);
  const target = changes[lastInterface].target;
  if (latest === undefined) {
    return {
      code: "unaudited-interface",
      detail: `${target} changed, and no inspect_ui audit ran on the live interface afterwards.`,
    };
  }
  if (latest.passed !== true) {
    return {
      code: "unaudited-interface",
      detail: `The last inspect_ui audit after ${target} changed still reported problems.`,
    };
  }
  return undefined;
}

/**
 * Decide whether a finished run may claim a verified result.
 *
 * Only a `completed` run is assessed. A cancelled, failed, or refused run is
 * already labelled by its outcome, and piling evidence complaints on top of it
 * would describe work the run never claimed to have finished.
 */
export function evaluateCompletion(input: GateInput): CompletionVerification {
  if (input.outcome !== "completed") return { verified: false, issues: [] };

  const issues: CompletionIssue[] = [];

  for (const change of input.changes) {
    if (change.kind !== "script-source" && change.kind !== "properties" && change.kind !== "instance") continue;
    if (changeIsVerified(change, input.evidence)) continue;
    issues.push({
      code: "unverified-change",
      detail: change.kind === "properties"
        ? `${change.target} changed properties, but Studio's atomic value verification was not recorded.`
        : change.kind === "instance"
          ? `${change.target} was built, but Studio's read-back of the build was not recorded.`
          : `${change.target} was written but not read back at the revision the write reported.`,
    });
  }

  // Audits are judged together below: the latest one is what counts.
  const failedEvidence = input.evidence.filter((item, index) =>
    item.passed === false && item.title !== UI_AUDIT_TITLE && failedEvidenceIsUnresolved(item, index, input.evidence));
  for (const item of failedEvidence) {
    issues.push({
      code: "failed-evidence",
      detail: `A check on ${item.title} did not pass.`,
    });
  }

  const interfaceIssue = interfaceAuditIssue(input.changes, input.evidence);
  if (interfaceIssue !== undefined) issues.push(interfaceIssue);

  const evidenceTasks = input.tasks.filter(
    (task) => task.requiresRuntimeEvidence && task.status === "done");
  for (const task of evidenceTasks) {
    // A missing array identifies a saved pre-migration task. Preserve its old
    // global runtime semantics; every task produced by the current tool carries
    // typed, task-linked requirements through the branch below.
    if (task.requiredEvidence === undefined) {
      if (hasRuntimeEvidence(input.evidence)) continue;
      issues.push({
        code: "missing-runtime-evidence",
        detail: `"${task.title}" was marked done and declared that it needs runtime evidence, but the run collected none.`,
      });
      continue;
    }
    for (const requirement of task.requiredEvidence) {
      if (typedEvidenceIsFresh(task, requirement, input.changes, input.evidence)) continue;
      issues.push({
        code: "missing-runtime-evidence",
        detail: `"${task.title}" was marked done and requires fresh ${requirement} evidence linked to that task, but the run collected none.`,
      });
    }
  }

  for (const task of unfinishedTasks(input.tasks)) {
    issues.push({
      code: "task-incomplete",
      detail: `"${task.title}" was still open when the run ended.`,
    });
  }

  // Blocked is an honest status, not a passing one. The agent is expected to
  // explain the obstacle in its reply, and the run has still not done what it
  // set out to do, so it does not get to present a clean verified result.
  for (const task of input.tasks) {
    if (task.status !== "blocked") continue;
    issues.push({
      code: "task-incomplete",
      detail: `"${task.title}" was blocked and never finished.`,
    });
  }

  // Failures stay visible in the run's failure ledger, but a recovered attempt
  // is not itself evidence that the final state is wrong. Open tasks, missing
  // observations, failed final checks, and unverified changes remain blockers.

  return { verified: issues.length === 0, issues };
}

/**
 * What the model is told when the gate is not satisfied.
 *
 * The model receives this before it writes its reply, so the wording asks for
 * the missing work first and an honest caveat only as the fallback. Nothing
 * here forces a retry: a run is allowed to end unverified, it is just not
 * allowed to end unverified *and* quiet about it.
 */
export function describeGateForModel(verification: CompletionVerification): string | undefined {
  if (verification.verified || verification.issues.length === 0) return undefined;
  return [
    "Roqer's completion gate found the result is not fully backed by evidence:",
    ...verification.issues.map((issue) => `- ${issue.detail}`),
    "Collect the missing evidence if you still can. If you cannot, say so plainly in your reply rather than implying the work is verified.",
  ].join("\n");
}

/** One line for the completion card when the gate did not pass. */
export function summarizeGate(verification: CompletionVerification): string | undefined {
  if (verification.verified || verification.issues.length === 0) return undefined;
  const [first] = verification.issues;
  return verification.issues.length === 1
    ? first.detail
    : `${first.detail} (+${verification.issues.length - 1} more)`;
}
