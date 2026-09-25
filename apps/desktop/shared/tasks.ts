/**
 * The task list a run works through, and the rules that keep it trustworthy.
 *
 * A run's task list is the only place that records what the agent set out to
 * do, as distinct from what it happened to call. The completion gate reads it
 * to decide which work needed runtime evidence, the memory digest will
 * summarize it, and Activity shows it while the run is live.
 *
 * It is model-authored, so every field is validated in the main process before
 * it becomes a run event: a list the renderer renders and the gate trusts must
 * never be shaped by whatever the provider happened to emit.
 */

export type RunTaskStatus =
  /** Not started. */
  | "pending"
  /** Being worked on now. Exactly one task may hold this at a time. */
  | "active"
  /** Finished, and — when it required it — backed by evidence. */
  | "done"
  /** Cannot proceed. The reply must say why. */
  | "blocked";

/** The distinct observation dimensions a completed task may promise. */
export type RunEvidenceRequirement = "runtime" | "visual" | "interaction";

export const RUN_EVIDENCE_REQUIREMENTS: readonly RunEvidenceRequirement[] = [
  "runtime",
  "visual",
  "interaction",
];

export type RunTask = {
  /** Stable across updates, so a status change is not read as a new task. */
  id: string;
  title: string;
  status: RunTaskStatus;
  /**
   * True when finishing this task honestly needs runtime evidence — a
   * playtest, logs, a screenshot — rather than a successful write alone.
   * The agent declares this when it plans the task, before it knows whether
   * the evidence will be convenient to collect.
   */
  requiresRuntimeEvidence: boolean;
  /**
   * The observations this task needs before it may be called verified.
   *
   * Optional only for records written before typed evidence requirements were
   * introduced. New task-tool input is normalized to include this array, while
   * `requiresRuntimeEvidence` remains as a derived compatibility field for the
   * existing renderer and saved records.
   */
  requiredEvidence?: RunEvidenceRequirement[];
};

export const MAX_RUN_TASKS = 12;
export const MAX_TASK_TITLE_CHARS = 160;
export const MAX_TASK_ID_CHARS = 64;

const STATUSES: readonly RunTaskStatus[] = ["pending", "active", "done", "blocked"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isRunTaskStatus(value: unknown): value is RunTaskStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export function isRunTask(value: unknown): value is RunTask {
  const requiredEvidence = isRecord(value) ? value.requiredEvidence : undefined;
  return isRecord(value) &&
    typeof value.id === "string" && value.id !== "" && value.id.length <= MAX_TASK_ID_CHARS &&
    typeof value.title === "string" && value.title !== "" && value.title.length <= MAX_TASK_TITLE_CHARS &&
    isRunTaskStatus(value.status) &&
    typeof value.requiresRuntimeEvidence === "boolean" &&
    (requiredEvidence === undefined || (
      Array.isArray(requiredEvidence) &&
      requiredEvidence.length <= RUN_EVIDENCE_REQUIREMENTS.length &&
      requiredEvidence.every((item) =>
        typeof item === "string" && RUN_EVIDENCE_REQUIREMENTS.includes(item as RunEvidenceRequirement)) &&
      new Set(requiredEvidence).size === requiredEvidence.length &&
      value.requiresRuntimeEvidence === (requiredEvidence.length > 0)
    ));
}

/** Validate a whole list, including the cross-task rules `isRunTask` cannot see. */
export function isRunTaskList(value: unknown): value is RunTask[] {
  if (!Array.isArray(value) || value.length > MAX_RUN_TASKS) return false;
  if (!value.every(isRunTask)) return false;
  const ids = new Set(value.map((task) => (task as RunTask).id));
  if (ids.size !== value.length) return false;
  return value.filter((task) => (task as RunTask).status === "active").length <= 1;
}

/**
 * Parse a model-supplied task list, throwing a message the model can act on.
 *
 * The thrown text is the model's only feedback, so each rule explains what to
 * send instead rather than only naming what was wrong.
 */
export function parseRunTaskList(value: unknown): RunTask[] {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    throw new Error("update_task_list requires a `tasks` array.");
  }
  const raw = value.tasks;
  if (raw.length === 0) {
    throw new Error("The task list cannot be empty. Send at least one task, or do not call this tool at all.");
  }
  if (raw.length > MAX_RUN_TASKS) {
    throw new Error(`A run may track at most ${MAX_RUN_TASKS} tasks; ${raw.length} were supplied. Merge the smaller steps.`);
  }

  const tasks: RunTask[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const position = `Task ${index + 1}`;
    if (!isRecord(entry)) throw new Error(`${position} is not an object.`);
    const { id, title, status, requiresRuntimeEvidence } = entry;
    if (typeof id !== "string" || id === "" || id.length > MAX_TASK_ID_CHARS) {
      throw new Error(`${position} needs a stable non-empty \`id\` of at most ${MAX_TASK_ID_CHARS} characters. Reuse the same id when you update a task.`);
    }
    if (seen.has(id)) throw new Error(`${position} repeats the id "${id}". Every task needs its own id.`);
    seen.add(id);
    if (typeof title !== "string" || title.trim() === "" || title.length > MAX_TASK_TITLE_CHARS) {
      throw new Error(`${position} needs a \`title\` of 1-${MAX_TASK_TITLE_CHARS} characters.`);
    }
    if (!isRunTaskStatus(status)) {
      throw new Error(`${position} needs a \`status\` of ${STATUSES.join(", ")}.`);
    }
    let requiredEvidence: RunEvidenceRequirement[];
    if (entry.requiredEvidence !== undefined) {
      if (!Array.isArray(entry.requiredEvidence) ||
        entry.requiredEvidence.some((item) =>
          typeof item !== "string" || !RUN_EVIDENCE_REQUIREMENTS.includes(item as RunEvidenceRequirement))) {
        throw new Error(`${position} needs \`requiredEvidence\` as an array containing only runtime, visual, or interaction.`);
      }
      requiredEvidence = entry.requiredEvidence as RunEvidenceRequirement[];
      if (new Set(requiredEvidence).size !== requiredEvidence.length) {
        throw new Error(`${position} repeats an entry in \`requiredEvidence\`. List each requirement once.`);
      }
    } else if (typeof requiresRuntimeEvidence === "boolean") {
      // Compatibility for an in-flight older agent or a pre-migration test.
      requiredEvidence = requiresRuntimeEvidence ? ["runtime"] : [];
    } else {
      throw new Error(`${position} needs \`requiredEvidence\` as an array: runtime for executed behavior, visual for rendered appearance, and interaction for an exercised user action.`);
    }
    tasks.push({
      id,
      title: title.trim(),
      status,
      requiredEvidence,
      requiresRuntimeEvidence: requiredEvidence.length > 0,
    });
  }

  const active = tasks.filter((task) => task.status === "active");
  if (active.length > 1) {
    throw new Error(`Only one task may be "active" at a time; ${active.length} were sent. Mark the others "pending".`);
  }
  return tasks;
}

/** One line for the activity layer, e.g. "3 of 5 done · Wiring the prompt". */
export function summarizeTasks(tasks: readonly RunTask[]): string {
  const done = tasks.filter((task) => task.status === "done").length;
  const active = tasks.find((task) => task.status === "active");
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const parts = [`${done} of ${tasks.length} done`];
  if (active) parts.push(active.title);
  else if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(" · ");
}

/** Tasks that are neither finished nor explicitly blocked. */
export function unfinishedTasks(tasks: readonly RunTask[]): RunTask[] {
  return tasks.filter((task) => task.status === "pending" || task.status === "active");
}
