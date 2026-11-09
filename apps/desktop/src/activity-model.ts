import {
  activityFinding, activityLabel, shortTarget,
  type ActivityKind,
} from "../shared/activity";
import type { ActivityStep } from "./run-view";

/**
 * The shape the activity layer is read in: a timeline.
 *
 * `activitySteps` answers "what happened, in order" — one entry per tool call,
 * per note, per piece of evidence. Read as it stands, ten reads in a row are ten
 * rows of "Read game.StarterPack", so neighbours of one kind fold into one row,
 * as does a playtest and an edit with its read-back. Nothing else moves: the order stays the order things happened in, so a failed
 * edit, the read that followed it and the edit that worked read as that story.
 * Every step survives as a leaf, so the raw operation, its arguments, its
 * timing, and its output stay one click away.
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

/**
 * The one line a step gets. A call in flight is named by what it is touching —
 * "Inspecting ServerScriptService…" — because that is the question a reader
 * watching a live run is asking.
 */
function titleOf(step: ActivityStep, status: StepStatus): string {
  if (step.tool) {
    // A failed call did not do what its past tense would claim.
    if (status === "failed") {
      const attempt = activityLabel(step.tool, step.target ?? null, false);
      return `Failed ${attempt.charAt(0).toLowerCase()}${attempt.slice(1)}`;
    }
    const label = activityLabel(step.tool, step.target ?? null, isPast(status));
    return status === "active" ? `${label}…` : label;
  }
  return status === "active" ? `${step.label}…` : step.label;
}

function findingOf(step: ActivityStep, status: StepStatus): string | undefined {
  if (step.tool) {
    const finding = activityFinding(step.tool, step.resultSummary);
    // A check that passed is the one thing folded evidence adds to the row itself.
    const checked = step.attached?.some((evidence) => evidence.kind === "verification" && evidence.passed === true) === true;
    if (finding !== null) return checked ? `${finding} · verified` : finding;
    if (checked) return "Verified";
    // A failure with an unreadable message still has to say that it failed.
    return status === "failed" ? "Failed" : undefined;
  }
  // Notes and evidence already carry a short, written note.
  return step.note === "" ? undefined : step.note;
}

export function leafNode(step: ActivityStep): ActivityNode {
  const status = stepStatus(step);
  return {
    key: step.key,
    status,
    title: titleOf(step, status),
    finding: findingOf(step, status),
    kind: step.kind,
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

const singular = (noun: string) => (noun.endsWith("ies") ? `${noun.slice(0, -3)}y` : noun.endsWith("s") ? noun.slice(0, -1) : noun);
const plural = (noun: string) => (noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : noun.endsWith("ch") ? `${noun}es` : `${noun}s`);

/**
 * Add up the countable findings underneath a group.
 *
 * Children report things like "16 instances" and "42 lines of source"; a group
 * that says "58 instances, 12 lines of source" tells the reader what those
 * calls actually turned up. Findings that are not counts ("Empty", "source revision
 * recorded") stay on their own row, where they mean something.
 */
export function mergeFindings(findings: readonly string[]): string[] {
  const totals = new Map<string, { total: number; noun: string; rest: string }>();
  for (const finding of findings) {
    const match = COUNT_PATTERN.exec(finding);
    if (!match) continue;
    const noun = singular(match[2]);
    const rest = match[3];
    const key = `${noun}${rest}`;
    const seen = totals.get(key);
    if (seen) seen.total += Number(match[1]);
    else totals.set(key, { total: Number(match[1]), noun, rest });
  }
  return [...totals.values()].map(({ total, noun, rest }) =>
    `${total} ${total === 1 ? noun : plural(noun)}${rest}`);
}

/** What a merged row claims, in the fewest words that stay honest. */
function groupFinding(children: readonly ActivityNode[]): string | undefined {
  const findings = children.flatMap((child) => child.finding ?? []);
  const parts = mergeFindings(findings.map((finding) => finding.replace(/ · verified$/, "")));
  if (findings.some((finding) => finding === "Verified" || finding.endsWith(" · verified"))) parts.push("verified");

  const failed = children.filter((child) => child.status === "failed").length;
  const skipped = children.filter((child) => child.status === "skipped").length;
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** What a read is of, for a row that says so. A screenshot is taken, not read. */
const READ_NOUN: Readonly<Record<string, string>> = {
  get_script_source: "script",
  get_instance_properties: "instance",
  get_runtime_logs: "log",
};

/** "a, b and c", keeping the list short enough to read on one row. */
function listed(parts: readonly string[]): string {
  const shown = parts.length > 3 ? [...parts.slice(0, 2), `${parts.length - 2} more`] : parts;
  return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const counted = (count: number, noun: string) => `${count} ${count === 1 ? noun : plural(noun)}`;

/** The last part of an instance path, or null for anything that is not one. */
function instanceName(target: string | null | undefined): string | null {
  if (!target?.startsWith("game.")) return null;
  return target.slice(target.lastIndexOf(".") + 1);
}

/**
 * A count, then what it was of. The count comes first because a long row is cut
 * off at its end, and the row should still say how many.
 */
function namedAfter(head: string, names: readonly (string | null)[]): string {
  const distinct = [...new Set(names.flatMap((name) => name ?? []))];
  if (distinct.length === 0) return head;
  // The ellipsis also covers calls with no name, so a list never reads as complete when it is not.
  const more = distinct.length > 2 || names.includes(null);
  return `${head}: ${distinct.slice(0, 2).join(", ")}${more ? ", …" : ""}`;
}

function readTitle(children: readonly ActivityNode[]): string {
  const reads = children.filter((child) => child.step?.tool !== "capture_screenshot");
  const shots = children.length - reads.length;
  const nouns = new Map<string, number>();
  for (const child of reads) {
    const noun = READ_NOUN[child.step?.tool ?? ""] ?? "item";
    nouns.set(noun, (nouns.get(noun) ?? 0) + 1);
  }
  // Two kinds still read as a list; past that, or with unnamed reads, it is a count.
  const kinds = nouns.size > 2 || (nouns.size > 1 && nouns.has("item"))
    ? counted(reads.length, "item")
    : listed([...nouns].map(([noun, count]) => counted(count, noun)));
  const took = shots === 1 ? "Took a screenshot" : `Took ${shots} screenshots`;
  if (shots > 0) return reads.length === 0 ? took : `${took} and read ${kinds}`;
  return namedAfter(`Read ${kinds}`, reads.map((child) => instanceName(child.step?.target)));
}

/** A merged row says what was done and how many times, from what the calls have in common. */
function mergedTitle(children: readonly ActivityNode[]): string {
  const count = children.length;
  const names = children.map((child) => instanceName(child.step?.target));
  const targets = new Set(children.map((child) => child.step?.target ?? ""));
  const target = targets.size === 1 ? [...targets][0] : "";
  switch (children[0].kind) {
    case "edit": return target === "" ? namedAfter(`Made ${count} edits`, names) : `Made ${count} edits to ${shortTarget(target)}`;
    // A search's target is what was searched for, unless it names where it looked.
    case "search": return namedAfter(`Ran ${count} searches`, children.map((child) => {
      const query = child.step?.target;
      return query && /[\p{L}\p{N}]/u.test(query) ? instanceName(query) ?? `“${query}”` : null;
    }));
    case "verify": return target === "" ? namedAfter(`Made ${count} checks`, names) : `Made ${count} checks on ${shortTarget(target)}`;
    case "read": return readTitle(children);
    case "run": {
      const labels = [...new Set(children.map((child) => child.title))];
      if (labels.length === 1) return `${labels[0]} (${count} times)`;
      const [first, ...rest] = labels;
      return listed([first, ...rest.map((label) => `${label.charAt(0).toLowerCase()}${label.slice(1)}`)]);
    }
    default: return `Inspected ${count} items`;
  }
}

function totalDuration(children: readonly ActivityNode[]): number | undefined {
  const measured = children.filter((child) => child.step?.durationMs !== undefined);
  if (measured.length === 0) return undefined;
  return measured.reduce((total, child) => total + (child.step?.durationMs ?? 0), 0);
}

/** Enough to see what went wrong without a closed row growing back into the list it folds. */
function alertsOf(children: readonly ActivityNode[]): ActivityNode[] {
  return children
    .filter((child) => child.status === "failed" || child.status === "warning" || child.status === "skipped")
    .slice(0, MAX_VISIBLE_ALERTS);
}

function groupNode(children: ActivityNode[]): ActivityNode {
  const status = rollUpStatus(children);
  // While the row is running, the specific operation is more use than a count.
  const active = children.find((child) => child.status === "active");
  return {
    key: `group-${children[0].key}`,
    status,
    title: active ? active.title : mergedTitle(children),
    finding: groupFinding(children),
    kind: children[0].kind,
    durationMs: totalDuration(children),
    children,
    alerts: alertsOf(children),
  };
}

/** An edit and the read that checked it. The row is the edit; the read says what it found. */
function readBackNode(children: ActivityNode[]): ActivityNode {
  const verified = children[1].finding === "Verified" || children[1].finding?.endsWith(" · verified") === true;
  return {
    key: `group-${children[0].key}`,
    status: rollUpStatus(children),
    title: children[0].title,
    finding: verified ? "Read back · verified" : "Read back",
    kind: "edit",
    durationMs: totalDuration(children),
    children,
    alerts: alertsOf(children),
  };
}

/**
 * One stretch of a playtest. A step inside that failed does not make the playtest
 * a failure, so the row keeps its own status and the failure is listed under it.
 */
function playtestNode(children: ActivityNode[], part: PlaytestPart): ActivityNode {
  const active = children.find((child) => child.status === "active");
  const waiting = children.some((child) => child.status === "warning");
  const failed = children.filter((child) => child.status === "failed").length;
  const title = part.stopped
    ? (part.continued ? "Finished the playtest" : "Ran a playtest")
    : (part.continued ? "Continued the playtest" : "Started a playtest");
  return {
    key: `group-${children[0].key}`,
    status: active ? "active" : waiting ? "warning" : "completed",
    title: active ? active.title : title,
    finding: `${children.length} steps${failed > 0 ? ` · ${failed} failed` : ""}`,
    kind: "run",
    durationMs: totalDuration(children),
    children,
    alerts: alertsOf(children),
  };
}

/**
 * Rows that are never merged. A request for the reader's decision must not be
 * summarised away; a note is there because it was worth saying; evidence that
 * no call claims is what the run learned by itself; and a failure or a rejection
 * is the turning point of the story, so it splits the steps around it.
 */
function standsAlone(step: ActivityStep, status: StepStatus): boolean {
  return status === "warning" || status === "failed" || status === "skipped" || step.evidence !== undefined || step.tool === undefined;
}

/**
 * Evidence that passed goes inside the call it came from. A playtest that started
 * and a playtest proven started are one thing that happened, and listing both
 * doubled the length of a long run. Evidence that failed keeps its own row, and
 * nothing is lost: what a call proved opens with the call.
 */
function withEvidenceOnItsCall(steps: readonly ActivityStep[]): ActivityStep[] {
  const out: ActivityStep[] = [];
  for (const step of steps) {
    const previous = out[out.length - 1];
    if (step.evidence !== undefined && step.evidence.passed !== false && previous?.tool !== undefined && previous.state === "done") {
      out[out.length - 1] = { ...previous, attached: [...(previous.attached ?? []), step.evidence] };
    } else {
      out.push(step);
    }
  }
  return out;
}

type PlaytestPart = { continued: boolean; stopped: boolean };
type Row = { steps: ActivityStep[]; playtest?: PlaytestPart; readBack?: true };

function isPlaytestCall(step: ActivityStep, action: "start" | "stop"): boolean {
  return (step.tool === "solo_playtest" || step.tool === "multiplayer_playtest") && step.target === action;
}

/** A start that worked, or is still trying to, opens a playtest. */
function opensPlaytest(step: ActivityStep): boolean {
  return isPlaytestCall(step, "start") && (step.state === "done" || step.state === "running");
}

/** The read right after an edit, of what it edited: checking the edit, not new work. */
function readsBack(row: Row | undefined, step: ActivityStep): boolean {
  const edit = row?.steps.length === 1 && row.playtest === undefined ? row.steps[0] : undefined;
  return edit?.kind === "edit" && edit.state === "done" && Boolean(edit.target)
    && step.kind === "read" && step.state === "done" && step.target === edit.target;
}

/**
 * Fold the steps of a run into the rows the activity layer renders.
 *
 * The rows keep the order the steps happened in. A step joins the row before it
 * only when that row is the same kind of work and neither stands alone, so going
 * back to reading after an edit starts a new row rather than rejoining an earlier
 * one. A run of one stays a single row rather than a group of one.
 *
 * Two stretches of different kinds of work are also one thing that happened: an
 * edit and its read-back, and a playtest from its start to its stop. An edit or
 * something the model said splits a playtest rather than folding into it, so the
 * closed rows never hide a change or an explanation; a failure stays in the
 * playtest and is listed under its row.
 */
export function buildActivityModel(steps: readonly ActivityStep[]): ActivityNode[] {
  const rows: Row[] = [];
  let open = false;
  let playtest: Row | null = null;

  for (const step of withEvidenceOnItsCall(steps)) {
    if (opensPlaytest(step)) {
      playtest = { steps: [step], playtest: { continued: false, stopped: false } };
      rows.push(playtest);
      open = false;
      continue;
    }
    if (playtest !== null) {
      if (step.kind === "note" || step.kind === "edit") {
        rows.push({ steps: [step] });
        playtest = { steps: [], playtest: { continued: true, stopped: false } };
        continue;
      }
      if (playtest.steps.length === 0) rows.push(playtest);
      playtest.steps.push(step);
      if (isPlaytestCall(step, "stop") && step.state === "done") {
        playtest.playtest!.stopped = true;
        playtest = null;
      }
      continue;
    }
    const previous = rows[rows.length - 1];
    if (readsBack(previous, step)) {
      previous.steps.push(step);
      previous.readBack = true;
      open = false;
    } else if (standsAlone(step, stepStatus(step))) {
      rows.push({ steps: [step] });
      open = false;
    } else if (open && previous !== undefined && previous.steps[0].kind === step.kind) {
      previous.steps.push(step);
    } else {
      rows.push({ steps: [step] });
      open = true;
    }
  }

  return rows.map((row) => {
    const children = row.steps.map(leafNode);
    if (children.length === 1) return children[0];
    if (row.playtest !== undefined) return playtestNode(children, row.playtest);
    return row.readBack ? readBackNode(children) : groupNode(children);
  });
}

/** How many things a run did, as a reader would count its rows opened up: notes are commentary. */
export function countedActions(nodes: readonly ActivityNode[]): number {
  return nodes.flatMap((node) => (node.children.length === 0 ? [node] : node.children)).filter((node) => node.kind !== "note").length;
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
 * A merged row is named by a count ("Read 7 items"), which is the right label
 * for a row you can open and the wrong one for "what just happened" — so the
 * last row reaches past the group to the operation itself.
 */
export function currentNodeTitle(nodes: readonly ActivityNode[]): string | null {
  const active = nodes.find((node) => node.status === "active");
  if (active) return active.title;
  // Something the model said is not something the run did.
  const last = [...nodes].reverse().find((node) => node.kind !== "note");
  if (last === undefined) return null;
  return last.children.length === 0 ? last.title : last.children[last.children.length - 1].title;
}

/**
 * The line a finished run's closed Activity row shows: the work that changed
 * something, counted from what the calls did rather than what the model said. A
 * run of one row is named by it, and a run that only looked is counted by that.
 */
export function finishedRunSummary(nodes: readonly ActivityNode[]): string | null {
  const rows = nodes.filter((node) => node.kind !== "note");
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].title;
  const done = rows
    .flatMap((node) => (node.children.length === 0 ? [node] : node.children))
    .filter((node) => node.status === "completed" && node.step?.tool !== undefined);
  const count = (matches: (step: ActivityStep) => boolean) => done.filter((node) => matches(node.step!)).length;
  const part = (total: number, noun: string) => (total === 0 ? [] : [counted(total, noun)]);
  const isUpload = (step: ActivityStep) => step.tool === "upload_assets" || step.tool === "upload_asset";
  const changed = [
    // The Results row counts uploads by what was uploaded, which a call does not say.
    ...part(count((step) => step.kind === "edit" && !isUpload(step)), "edit"),
    ...part(count((step) => isPlaytestCall(step, "start")), "playtest"),
    ...part(count((step) => step.tool === "run_blender_script"), "Blender run"),
  ];
  const parts = changed.length > 0 ? changed : [
    ...part(count((step) => step.kind === "read"), "read"),
    ...part(count((step) => step.kind === "search"), "search"),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * A duration worth reading. Per-call milliseconds are debug detail, but the
 * second and a half a merged row took is something a reader can feel, so only
 * durations at that scale are offered to the primary rows.
 */
export function aggregateDuration(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined || milliseconds < 1_000) return undefined;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

/**
 * A wait as it happens, for the counter shown while the model is working.
 *
 * Whole seconds rather than the tenths a finished row reports: this one is
 * read repeatedly as it climbs, and a flickering decimal draws the eye to the
 * wrong thing. Past a minute it reads as a clock, because "94s" makes a reader
 * do arithmetic to learn how long they have been waiting.
 */
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The wall-clock time a completed run took, derived from its persisted event
 * timestamps. Old or damaged records stay unlabeled rather than presenting an
 * invalid measurement as real run evidence.
 */
function persistedTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

export function completedRunDurationLabel(startedAt: string, finishedAt: string): string | null {
  const started = persistedTimestamp(startedAt);
  const finished = persistedTimestamp(finishedAt);
  if (started === null || finished === null || finished <= started) return null;

  const seconds = Math.floor((finished - started) / 1_000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m${remainingSeconds === 0 ? "" : ` ${remainingSeconds}s`}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes === 0 ? "" : ` ${remainingMinutes}m`}`;
}

/** Elapsed time when the interval is trustworthy, after a label only a demo run needs. */
export function completedRunMetadataLabel(label: string | null, startedAt: string, finishedAt: string): string {
  const duration = completedRunDurationLabel(startedAt, finishedAt);
  return [label, duration].filter((part) => part !== null).join(" · ");
}

/** Completion metadata and optional provider usage as one reader-facing line. */
export function completedRunDetailsLabel(metadata: string, usage: string | null): string {
  return [metadata, usage].filter((part) => part !== null && part !== "").join(" · ");
}

/**
 * How much the model has written so far, beside the waiting clock.
 *
 * An estimate carries a `~`: it is counted from the characters that streamed,
 * so it is rough, and it misses reasoning a model does not show. The
 * provider's own figure, once reported, is printed without one. Thousands
 * shorten to one decimal, since the figure is read as it climbs.
 */
export function outputTokensLabel(tokens: number, exact: boolean): string {
  const whole = Math.max(0, Math.floor(tokens));
  const count = whole < 1_000
    ? String(whole)
    : whole < 10_000
      ? `${(Math.floor(whole / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`
      : `${Math.floor(whole / 1_000)}k`;
  return `${exact ? "" : "~"}${count} ${whole === 1 ? "token" : "tokens"}`;
}
