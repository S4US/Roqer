import {
  activityFinding, activityLabel, activityPhase, evidencePhase, phaseTitle,
  type ActivityKind, type ActivityPhase,
} from "../shared/activity";
import type { ActivityStep } from "./run-view";

/**
 * The shape the activity layer is read in.
 *
 * `activitySteps` answers "what happened, in order" — one entry per tool call,
 * per note, per piece of evidence. That is the right record and the wrong
 * reading: a project inspection is ten reads, and ten rows of "Read
 * game.StarterPack" is a trace, not an account of what the agent did.
 *
 * This module folds that record into what a reader wants first — a handful of
 * phases, the one in flight obvious, each openable for the operations beneath
 * it — without dropping anything. Every step survives as a leaf, so the raw
 * operation, its arguments, its timing, and its output stay one click away.
 *
 * The fold is pure and lives apart from the component: which steps join a
 * group, what a group claims to have found, and what stays visible when it is
 * collapsed are decisions worth testing without React.
 */

/**
 * What a row is doing, said in terms of the reader rather than the engine.
 *
 * `ActivityState` is the engine's vocabulary — proposed, awaiting-approval,
 * rejected — and answers what the run did about a call. This answers what the
 * reader should feel about the row, which is a smaller and steadier set.
 */
export type StepStatus = "pending" | "active" | "completed" | "warning" | "failed" | "skipped";

export type ActivityNode = {
  key: string;
  status: StepStatus;
  /** What the agent is doing or did, in a reader's words. */
  title: string;
  /** What it learned, kept to a few words. Absent when there is nothing to say. */
  finding?: string;
  kind: ActivityKind;
  phase: ActivityPhase;
  /** Set on a group: how long its operations took in total. */
  durationMs?: number;
  /** Set on a leaf: the step it came from, carrying the raw detail. */
  step?: ActivityStep;
  /** The operations folded into this row, empty on a leaf. */
  children: ActivityNode[];
  /**
   * Children that failed, were skipped, or need attention. Rendered outside the
   * disclosure so a problem inside a collapsed group is never out of sight.
   */
  alerts: ActivityNode[];
};

/** How the engine's state for a step reads to someone watching. */
export function stepStatus(step: ActivityStep): StepStatus {
  switch (step.state) {
    case "proposed":
      return "pending";
    case "running":
      return "active";
    case "awaiting-approval":
      return "warning";
    case "rejected":
      return "skipped";
    // A check that did not pass arrives already marked failed, which is what it
    // is: "warning" is reserved for a row waiting on the reader.
    case "failed":
      return "failed";
    case "done":
      return "completed";
  }
}

/** Statuses that describe something already behind the run. */
function isPast(status: StepStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

function phaseOf(step: ActivityStep): ActivityPhase {
  if (step.evidence) return evidencePhase(step.evidence.kind);
  if (step.tool) return activityPhase(step.tool, step.target ?? null);
  return "note";
}

/**
 * The one line a step gets. A call in flight is named by what it is touching —
 * "Inspecting ServerScriptService…" — because that is the question a reader
 * watching a live run is asking.
 */
function titleOf(step: ActivityStep, status: StepStatus): string {
  if (step.tool) {
    const label = activityLabel(step.tool, step.target ?? null, isPast(status));
    return status === "active" ? `${label}…` : label;
  }
  return status === "active" ? `${step.label}…` : step.label;
}

function findingOf(step: ActivityStep, status: StepStatus): string | undefined {
  if (step.tool) {
    const finding = activityFinding(step.tool, step.resultSummary);
    if (finding !== null) return finding;
    // A failure with an unreadable message still has to say that it failed.
    return status === "failed" ? "Failed" : undefined;
  }
  // Notes and evidence already carry a short, written note.
  return step.note === "" ? undefined : step.note;
}

function leafNode(step: ActivityStep): ActivityNode {
  const status = stepStatus(step);
  return {
    key: step.key,
    status,
    title: titleOf(step, status),
    finding: findingOf(step, status),
    kind: step.kind,
    phase: phaseOf(step),
    step,
    children: [],
    alerts: [],
  };
}

/** The worst thing happening in a group is what the group reports. */
function rollUpStatus(children: readonly ActivityNode[]): StepStatus {
  if (children.some((child) => child.status === "failed")) return "failed";
  if (children.some((child) => child.status === "active")) return "active";
  if (children.some((child) => child.status === "warning")) return "warning";
  if (children.every((child) => child.status === "pending")) return "pending";
  if (children.every((child) => child.status === "skipped")) return "skipped";
  return "completed";
}

/** How many problem rows a collapsed group keeps on screen. */
export const MAX_VISIBLE_ALERTS = 3;

const COUNT_PATTERN = /^(\d+)\s+(\S+)(.*)$/;

/**
 * Add up the countable findings underneath a group.
 *
 * Children report things like "16 instances" and "42 lines of source"; a group
 * that says "58 instances, 12 lines of source" tells the reader what the phase
 * actually turned up. Findings that are not counts ("Empty", "source revision
 * recorded") stay on their own row, where they mean something.
 */
export function mergeFindings(findings: readonly string[]): string[] {
  const totals = new Map<string, { total: number; noun: string; rest: string }>();
  for (const finding of findings) {
    const match = COUNT_PATTERN.exec(finding);
    if (!match) continue;
    const noun = match[2].endsWith("s") ? match[2].slice(0, -1) : match[2];
    const rest = match[3];
    const key = `${noun}${rest}`;
    const seen = totals.get(key);
    if (seen) seen.total += Number(match[1]);
    else totals.set(key, { total: Number(match[1]), noun, rest });
  }
  return [...totals.values()].map(({ total, noun, rest }) =>
    `${total} ${noun}${total === 1 ? "" : "s"}${rest}`);
}

/** What a folded phase claims, in the fewest words that stay honest. */
function groupFinding(children: readonly ActivityNode[]): string | undefined {
  const parts = [`${children.length} steps`];
  parts.push(...mergeFindings(children.flatMap((child) => child.finding ?? [])));

  const failed = children.filter((child) => child.status === "failed").length;
  const skipped = children.filter((child) => child.status === "skipped").length;
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(" · ");
}

function totalDuration(children: readonly ActivityNode[]): number | undefined {
  const measured = children.filter((child) => child.step?.durationMs !== undefined);
  if (measured.length === 0) return undefined;
  return measured.reduce((total, child) => total + (child.step?.durationMs ?? 0), 0);
}

function groupNode(children: ActivityNode[]): ActivityNode {
  const status = rollUpStatus(children);
  const phase = children[0].phase;
  // While a phase is running, the specific operation is more use than the
  // phase's name; once it is done, the phase's name is the whole point.
  const active = children.find((child) => child.status === "active");
  return {
    key: `group-${children[0].key}`,
    status,
    title: active ? active.title : phaseTitle(phase, isPast(status)),
    finding: groupFinding(children),
    kind: children[0].kind,
    phase,
    durationMs: totalDuration(children),
    children,
    // Enough to see what went wrong without the collapsed group growing back
    // into the list it was folded out of; the count in the finding covers the rest.
    alerts: children
      .filter((child) => child.status === "failed" || child.status === "warning" || child.status === "skipped")
      .slice(0, MAX_VISIBLE_ALERTS),
  };
}

/**
 * Two kinds of row are never folded into a phase: a request for the reader's
 * decision, which must not be summarised away, and a piece of evidence, which
 * is what the run learned rather than one more thing it did. A note the planner
 * left is its own row too — it is there precisely because it was worth saying.
 */
function standsAlone(step: ActivityStep, status: StepStatus): boolean {
  return status === "warning" || step.evidence !== undefined || step.tool === undefined;
}

/** A row being assembled: either one phase's steps, or a single standalone step. */
type Slot = { phase: ActivityPhase; steps: ActivityStep[]; solo: boolean };

/**
 * Fold the steps of a run into the rows the activity layer renders.
 *
 * A phase appears once, where it was first entered, and every step of that
 * phase joins it wherever it happened. An agent that reads the project, writes
 * a script, then reads two more things does not produce a second "Understood
 * the project" row three lines below the first — a phase is a place to look,
 * not a run of adjacent calls. Order within a phase is untouched, and a phase
 * that produced a single step stays a single row rather than a group of one.
 */
export function buildActivityModel(steps: readonly ActivityStep[]): ActivityNode[] {
  const slots: Slot[] = [];

  for (const step of steps) {
    const phase = phaseOf(step);
    if (standsAlone(step, stepStatus(step))) {
      slots.push({ phase, steps: [step], solo: true });
      continue;
    }
    const section = slots.find((slot) => !slot.solo && slot.phase === phase);
    if (section) section.steps.push(step);
    else slots.push({ phase, steps: [step], solo: false });
  }

  return slots.map((slot) => {
    const children = slot.steps.map(leafNode);
    return children.length === 1 ? children[0] : groupNode(children);
  });
}

/**
 * The operation a live run is working on, or null when nothing is in flight.
 *
 * A run's status line answers "what is happening right now", and while a tool
 * is running the honest answer is the tool rather than the provider: saying
 * "Thinking with ChatGPT" through a forty-second playtest boot would be a
 * guess, and the wrong one. Between calls no operation is in flight, and the
 * provider's own state is the true answer.
 */
export function activeStepTitle(steps: readonly ActivityStep[]): string | null {
  return buildActivityModel(steps).find((node) => node.status === "active")?.title ?? null;
}

/**
 * The one row a closed Activity section shows: what is in flight, and when
 * nothing is, the last thing the run actually did.
 *
 * A finished phase is named by the phase ("Understood the project"), which is
 * the right label for a row you can open and the wrong one for "what just
 * happened" — so the last row reaches past the group to the operation itself.
 */
export function currentNodeTitle(nodes: readonly ActivityNode[]): string | null {
  const active = nodes.find((node) => node.status === "active");
  if (active) return active.title;
  const last = nodes[nodes.length - 1];
  if (last === undefined) return null;
  return last.children.length === 0 ? last.title : last.children[last.children.length - 1].title;
}

/**
 * A duration worth reading. Per-call milliseconds are debug detail, but the
 * second and a half a phase took is something a reader can feel, so only
 * durations at that scale are offered to the primary rows.
 */
export function aggregateDuration(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined || milliseconds < 1_000) return undefined;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

/**
 * A wait as it happens, for the counter shown while the model is working.
 *
 * Whole seconds rather than the tenths a finished phase reports: this one is
 * read repeatedly as it climbs, and a flickering decimal draws the eye to the
 * wrong thing. Past a minute it reads as a clock, because "94s" makes a reader
 * do arithmetic to learn how long they have been waiting.
 */
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
