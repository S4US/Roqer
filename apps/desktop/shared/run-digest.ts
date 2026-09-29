/**
 * What a finished run leaves behind for the runs that follow it.
 *
 * A follow-up prompt used to carry only the transcript: what the user typed and
 * what the agent said back. Everything the host recorded while the work
 * happened -- which scripts were changed and at what revision, which tasks were
 * still open, what the gate found unverified, and what the user answered when
 * asked -- stayed in the run record on the message and never reached the next
 * model turn. So "continue" started every time by rediscovering from Studio what
 * the previous run had already established, and a decision the user made in one
 * run had to be made again in the next.
 *
 * The digest is host-derived, never model-authored: it is read from the same
 * record the completion gate was judged against, so it cannot be wrong about
 * what happened the way a recollection can. It is also bounded by construction,
 * with the same entry ceiling as the summary that replaces folded history inside
 * a run, because both are answering the same question -- what does the model
 * need to know about work it can no longer see?
 *
 * Lines are formatted here, in shared code, so that the in-run fold summary and
 * the follow-up digest describe a task or a change in exactly the same words.
 */

import { MAX_OPTION_CHARS, MAX_QUESTION_CHARS, MAX_QUESTIONS_PER_RUN } from "./question";
import type { RunChange, RunFailure, RunOutcome, RunRecord } from "./run-events";
import { MAX_STEER_CHARS, MAX_STEERS_PER_RUN } from "./steer";
import type { RunTask } from "./tasks";

/** One answer the user gave to one question the run asked. */
export type RunDecision = {
  question: string;
  answer: string;
};

export type RunDigest = {
  outcome: RunOutcome;
  /** Tasks that were not done when the run ended, as `[status] title`. */
  unfinished: string[];
  /**
   * Every change the run applied, as `kind target at revision R`, or for an
   * upload `asset rbxassetid://N “name” (type)`, uploads first.
   */
  changes: string[];
  /** Why the gate would not call the run verified, when it would not. */
  unverified: string[];
  decisions: RunDecision[];
  /**
   * Why a run that did not complete stopped, when the record says: a usage
   * limit, a provider error, a lost bridge. Without it a follow-up cannot tell
   * work that broke from work that was merely interrupted.
   */
  stoppedBecause?: string;
  /** Tool calls that failed in a run that did not complete, as `tool: message`. */
  failedCalls?: string[];
  /** Notes the user added while the run worked, newest kept when they are long. */
  notes?: string[];
};

/** Entries of any one kind a digest lists before it counts the rest. */
export const MAX_DIGEST_ENTRIES = 20;
/** Longer than any line the formatters below can produce from validated input. */
export const MAX_DIGEST_LINE_CHARS = 400;

/**
 * How much of a digest the user's notes may take. A note may be long, and a
 * run may take twenty, which together would crowd the transcript out of the
 * bound; the newest are kept, since a later note usually refines an earlier one.
 */
export const MAX_DIGEST_NOTE_CHARS = 8_000;

const OUTCOMES: readonly string[] = ["completed", "cancelled", "failed", "refused"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function taskLine(task: RunTask): string {
  const requirements = task.requiredEvidence ?? (task.requiresRuntimeEvidence ? ["runtime"] : []);
  const needs = requirements.length > 0 ? ` (needs ${requirements.join(", ")} evidence)` : "";
  return `[${task.status}] ${task.title}${needs}`;
}

/** Both upload producers name the asset this way in the summary they record. */
const ASSET_NAME = /^(?:Uploaded|Published) “([^”]+)”/;
/** Roblox caps a display name at 50 characters; this keeps a line bounded regardless. */
const MAX_ASSET_NAME_CHARS = 100;
const MAX_ASSET_TYPE_CHARS = 40;

/**
 * An upload by id alone reads as a list of numbers: a later run cannot tell
 * the mist texture from a sky face, so it renders and uploads them again. The
 * name and type are what make an uploaded asset reusable.
 */
function assetLine(change: RunChange): string {
  const name = ASSET_NAME.exec(change.summary)?.[1];
  const label = name === undefined ? "" : ` “${name.slice(0, MAX_ASSET_NAME_CHARS)}”`;
  const type = change.assetType === undefined || change.assetType === ""
    ? ""
    : ` (${change.assetType.slice(0, MAX_ASSET_TYPE_CHARS)})`;
  return `asset ${change.target}${label}${type}`;
}

function changeLine(change: RunChange): string {
  if (change.kind === "asset") return assetLine(change);
  const revision = change.revisionAfter === undefined ? "" : ` at revision ${change.revisionAfter}`;
  return `${change.kind} ${change.target}${revision}`;
}

/**
 * The change lines a digest or fold lists, before bounding.
 *
 * Uploads come first. Studio shows every other change to a run that reads it,
 * but an asset that was uploaded and not yet placed exists only in this record,
 * so it is the entry a bound must not be the one to drop. Repeats of the same
 * line -- a property set tuned four times -- are listed once with a count, so
 * they do not spend the bound either.
 */
export function changeLines(changes: readonly RunChange[]): string[] {
  const ordered = [
    ...changes.filter((change) => change.kind === "asset"),
    ...changes.filter((change) => change.kind !== "asset"),
  ];
  const counts = new Map<string, number>();
  for (const line of ordered.map(changeLine)) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([line, count]) => (count > 1 ? `${line} (×${count})` : line));
}

/**
 * Keep the first entries and say how many more there were, so a run that
 * changed sixty scripts is reported as sixty rather than as twenty.
 */
export function boundedLines(lines: readonly string[]): string[] {
  // A line is clipped rather than trusted to fit: the digest is validated at
  // the main process, and one over-long instance path there would refuse every
  // later message in the chat, not just this line.
  const shown = lines.slice(0, MAX_DIGEST_ENTRIES).map(clipLine);
  const hidden = lines.length - shown.length;
  return hidden > 0 ? [...shown, `(+${hidden} more)`] : shown;
}

function clipLine(line: string): string {
  return line.length <= MAX_DIGEST_LINE_CHARS ? line : `${line.slice(0, MAX_DIGEST_LINE_CHARS - 1)}…`;
}

/**
 * Why a run that did not complete stopped. A failed run ends on its last
 * failure: the planner's error, or the tool failure that aborted it. A
 * cancelled run is the user's own doing unless the host cancelled it because
 * it could no longer save.
 */
function stoppedBecause(record: RunRecord): string | undefined {
  if (record.outcome === "completed") return undefined;
  const last: RunFailure | undefined = record.failures.at(-1);
  if (last === undefined) return undefined;
  if (record.outcome === "cancelled" && last.code !== "persistence-failed") return undefined;
  return clipLine(last.message);
}

/** The failed calls of a run that did not complete, each distinct one once. */
function failedCalls(record: RunRecord): string[] {
  if (record.outcome === "completed") return [];
  const counts = new Map<string, number>();
  for (const failure of record.failures) {
    if (failure.tool === undefined) continue;
    const line = `${failure.tool}: ${failure.message}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, count]) => (count > 1 ? `${line} (×${count})` : line));
}

/** The newest notes that fit the note budget, with a count of any left out. */
function boundedNotes(notes: readonly string[]): string[] {
  const kept: string[] = [];
  let total = 0;
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index].slice(0, MAX_STEER_CHARS);
    if (kept.length >= MAX_STEERS_PER_RUN || total + note.length > MAX_DIGEST_NOTE_CHARS) break;
    kept.unshift(note);
    total += note.length;
  }
  const hidden = notes.length - kept.length;
  return hidden > 0 ? [`(+${hidden} earlier notes)`, ...kept] : kept;
}

/** The digest of a persisted run record, already bounded. */
export function digestRun(record: RunRecord): RunDigest {
  const unfinished = (record.tasks ?? []).filter((task) => task.status !== "done").map(taskLine);
  const unverified = record.verification !== undefined && !record.verification.verified
    ? record.verification.issues.map((issue) => issue.detail)
    : [];
  const stopped = stoppedBecause(record);
  const failed = failedCalls(record);
  const notes = boundedNotes(record.notes ?? []);
  return {
    outcome: record.outcome,
    unfinished: boundedLines(unfinished),
    changes: boundedLines(changeLines(record.changes)),
    unverified: boundedLines(unverified),
    decisions: (record.decisions ?? []).slice(0, MAX_QUESTIONS_PER_RUN),
    ...(stopped === undefined ? {} : { stoppedBecause: stopped }),
    ...(failed.length === 0 ? {} : { failedCalls: boundedLines(failed) }),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/** Whether a digest says anything a follow-up run could use. */
export function digestIsEmpty(digest: RunDigest): boolean {
  return digest.unfinished.length === 0 && digest.changes.length === 0 &&
    digest.unverified.length === 0 && digest.decisions.length === 0 &&
    digest.stoppedBecause === undefined && (digest.failedCalls ?? []).length === 0 &&
    (digest.notes ?? []).length === 0;
}

/**
 * How much of a prompt budget a digest will occupy, measured the same way the
 * transcript is: characters of what will be rendered.
 */
export function digestChars(digest: RunDigest): number {
  const lines = [
    ...digest.unfinished, ...digest.changes, ...digest.unverified,
    ...(digest.failedCalls ?? []), ...(digest.notes ?? []), digest.stoppedBecause ?? "",
  ];
  return lines.reduce((total, line) => total + line.length, 0) +
    digest.decisions.reduce((total, decision) => total + decision.question.length + decision.answer.length, 0);
}

function isLineList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_DIGEST_ENTRIES + 1 &&
    value.every((line) => typeof line === "string" && line.length <= MAX_DIGEST_LINE_CHARS);
}

export function isRunDecision(value: unknown): value is RunDecision {
  return isRecord(value) &&
    typeof value.question === "string" && value.question !== "" &&
    value.question.length <= MAX_QUESTION_CHARS &&
    typeof value.answer === "string" && value.answer !== "" &&
    value.answer.length <= MAX_OPTION_CHARS;
}

/** Validate a renderer-provided digest at the main-process trust boundary. */
export function isRunDigest(value: unknown): value is RunDigest {
  return isRecord(value) &&
    OUTCOMES.includes(value.outcome as string) &&
    isLineList(value.unfinished) &&
    isLineList(value.changes) &&
    isLineList(value.unverified) &&
    Array.isArray(value.decisions) &&
    value.decisions.length <= MAX_QUESTIONS_PER_RUN &&
    value.decisions.every(isRunDecision) &&
    (value.stoppedBecause === undefined ||
      (typeof value.stoppedBecause === "string" && value.stoppedBecause.length <= MAX_DIGEST_LINE_CHARS)) &&
    (value.failedCalls === undefined || isLineList(value.failedCalls)) &&
    (value.notes === undefined || isNoteList(value.notes));
}

function isNoteList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_STEERS_PER_RUN + 1) return false;
  let total = 0;
  for (const note of value) {
    if (typeof note !== "string" || note.length > MAX_STEER_CHARS) return false;
    total += note.length;
  }
  // The count line is short; the budget is what bounds the rest.
  return total <= MAX_DIGEST_NOTE_CHARS + MAX_DIGEST_LINE_CHARS;
}
