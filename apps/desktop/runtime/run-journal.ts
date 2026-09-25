import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalMode } from "../shared/policy";
import {
  RUN_EVENT_SCHEMA_VERSION,
  isRunEvent,
  isRunRecord,
  type RunChange,
  type RunEvent,
  type RunEvidence,
  type RunFailure,
  type RunRecord,
} from "../shared/run-events";
import type { RunTask } from "../shared/tasks";
import type { ChatMessage } from "../src/model";

const JOURNAL_VERSION = 1;
const WRITE_DELAY_MS = 250;
const MAX_TEXT = 32_000;
const MAX_ITEMS = 50;
const MAX_ITEM_TEXT = 4_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

type Target = { projectId: string; chatId: string };
type ToolCall = RunRecord["toolCalls"][number];

type Snapshot = {
  version: typeof JOURNAL_VERSION;
  runId: string;
  target: Target;
  prompt: string;
  approvalMode: ApprovalMode;
  startedAt: string;
  planner: string;
  text: string;
  toolCalls: ToolCall[];
  changes: RunChange[];
  evidence: RunEvidence[];
  failures: RunFailure[];
  tasks?: RunTask[];
  completion?: Extract<RunEvent, { type: "run-completed" }>;
  clipped: boolean;
};

const modes: readonly string[] = ["Ask first", "Auto approve", "Full auto", "Read only"];
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bounded = (text: string, max = MAX_ITEM_TEXT): string => text.length <= max ? text : `${text.slice(0, max - 14)}… [truncated]`;
const fileFor = (runId: string): string => `${createHash("sha256").update(runId).digest("hex")}.json`;

function validSnapshot(value: unknown): value is Snapshot {
  if (!object(value) || value.version !== JOURNAL_VERSION || typeof value.runId !== "string") return false;
  if (!object(value.target) || typeof value.target.projectId !== "string" || typeof value.target.chatId !== "string") return false;
  if (typeof value.prompt !== "string" || !modes.includes(value.approvalMode as string)) return false;
  if (typeof value.startedAt !== "string" || typeof value.planner !== "string" || typeof value.text !== "string") return false;
  if (!Array.isArray(value.toolCalls) || !Array.isArray(value.changes) || !Array.isArray(value.evidence) || !Array.isArray(value.failures)) return false;
  const record: RunRecord = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    runId: value.runId,
    planner: value.planner,
    approvalMode: value.approvalMode as ApprovalMode,
    outcome: "cancelled",
    startedAt: value.startedAt,
    finishedAt: value.startedAt,
    toolCalls: value.toolCalls as ToolCall[],
    changes: value.changes as RunChange[],
    evidence: value.evidence as RunEvidence[],
    failures: value.failures as RunFailure[],
    tasks: value.tasks as RunTask[] | undefined,
  };
  return isRunRecord(record) && typeof value.clipped === "boolean" &&
    (value.completion === undefined || (isRunEvent(value.completion) && value.completion.type === "run-completed"));
}

function append<T>(items: T[], item: T, snapshot: Snapshot): void {
  if (items.length < MAX_ITEMS) items.push(item);
  else snapshot.clipped = true;
}

function compactChange(change: RunChange): RunChange {
  return {
    ...change,
    id: bounded(change.id, 500),
    target: bounded(change.target, 1_000),
    instanceId: change.instanceId === undefined ? undefined : bounded(change.instanceId, 500),
    summary: bounded(change.summary),
    diff: change.diff === undefined ? undefined : bounded(change.diff),
    code: change.code === undefined ? undefined : bounded(change.code),
    truncated: change.truncated || (change.diff?.length ?? 0) > MAX_ITEM_TEXT || (change.code?.length ?? 0) > MAX_ITEM_TEXT,
  };
}

function compactEvidence(evidence: RunEvidence): RunEvidence {
  return {
    ...evidence,
    id: bounded(evidence.id, 500),
    title: bounded(evidence.title, 1_000),
    detail: evidence.detail === undefined ? undefined : bounded(evidence.detail),
    lines: evidence.lines?.slice(0, 40).map((line) => bounded(line, 500)),
    imageDataUrl: undefined,
    metadata: evidence.metadata?.slice(0, 20).map((item) => ({ label: bounded(item.label, 200), value: bounded(item.value, 500) })),
  };
}

function applyEvent(snapshot: Snapshot, event: RunEvent): void {
  if (event.runId !== snapshot.runId) return;
  switch (event.type) {
    case "run-started": snapshot.planner = bounded(event.planner, 200); break;
    case "message-delta": {
      const room = MAX_TEXT - snapshot.text.length;
      if (event.text.length > room) snapshot.clipped = true;
      if (room > 0) snapshot.text += event.text.slice(0, room);
      break;
    }
    case "tool-result": append(snapshot.toolCalls, {
      tool: bounded(event.tool, 200), ok: event.ok, durationMs: event.durationMs, summary: bounded(event.summary),
    }, snapshot); break;
    case "change": append(snapshot.changes, compactChange(event.change), snapshot); break;
    case "evidence": append(snapshot.evidence, compactEvidence(event.evidence), snapshot); break;
    case "failure": append(snapshot.failures, { ...event.failure, message: bounded(event.failure.message) }, snapshot); break;
    case "tasks": snapshot.tasks = event.tasks.slice(0, MAX_ITEMS).map((task) => ({ ...task, title: bounded(task.title, 500) })); if (event.tasks.length > MAX_ITEMS) snapshot.clipped = true; break;
    case "run-completed": snapshot.completion = {
      ...event,
      summary: bounded(event.summary),
      verification: {
        ...event.verification,
        issues: event.verification.issues.slice(0, MAX_ITEMS).map((issue) => ({ ...issue, detail: bounded(issue.detail) })),
      },
    }; break;
  }
}

function serializeBounded(snapshot: Snapshot): string {
  let serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_SNAPSHOT_BYTES) return serialized;
  snapshot.clipped = true;
  snapshot.text = bounded(snapshot.text, 8_000);
  for (const evidence of snapshot.evidence) {
    evidence.lines = evidence.lines?.slice(0, 5);
    evidence.metadata = evidence.metadata?.slice(0, 5);
    evidence.detail = evidence.detail === undefined ? undefined : bounded(evidence.detail, 1_000);
  }
  serialized = JSON.stringify(snapshot);
  while (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES && snapshot.evidence.length > 0) {
    snapshot.evidence.pop();
    serialized = JSON.stringify(snapshot);
  }
  while (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES && snapshot.toolCalls.length > 0) {
    snapshot.toolCalls.pop();
    serialized = JSON.stringify(snapshot);
  }
  while (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES && snapshot.changes.length > 0) {
    snapshot.changes.pop();
    serialized = JSON.stringify(snapshot);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("Run journal snapshot exceeds its 2 MB safety limit.");
  }
  return serialized;
}

function recoveredMessage(snapshot: Snapshot): ChatMessage {
  const interrupted = snapshot.completion === undefined;
  const clipped = snapshot.clipped;
  const finishedAt = snapshot.completion?.at ?? new Date().toISOString();
  let summary = snapshot.completion?.summary ??
    "Interrupted before the agent finished. Previous changes may already exist in Studio; inspect them before continuing.";
  if (clipped) summary = `${summary}\n\nSome run details were clipped by the recovery journal. Inspect Studio before treating this result as complete.`;
  const verification = snapshot.clipped ? {
    verified: false,
    issues: [{ code: "tool-failure" as const, detail: "Some recovery details were clipped, so this run cannot be verified from the journal." }],
  } : snapshot.completion?.verification ?? {
    verified: false,
    issues: snapshot.changes.length > 0 ? [{ code: "unverified-change" as const, detail: "The interrupted run changed Studio and did not finish verification." }] : [],
  };
  const run: RunRecord = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    runId: snapshot.runId,
    planner: snapshot.planner,
    approvalMode: snapshot.approvalMode,
    outcome: interrupted ? "cancelled" : clipped ? "failed" : snapshot.completion!.outcome,
    startedAt: snapshot.startedAt,
    finishedAt,
    toolCalls: snapshot.toolCalls,
    changes: snapshot.changes,
    evidence: snapshot.evidence,
    failures: clipped
      ? [...snapshot.failures, { code: "journal-clipped", message: "Some recovery details exceeded journal limits.", retryable: false }]
      : snapshot.failures,
    tasks: snapshot.tasks,
    verification,
  };
  const text = snapshot.text.trim() ? `${snapshot.text.trim()}\n\n${summary}` : summary;
  return { id: `recovered-${snapshot.runId}`, role: "assistant", text, createdAt: finishedAt, run };
}

/** Main-process-owned, bounded recovery checkpoints for runs in progress. */
export class RunJournal {
  private readonly snapshots = new Map<string, Snapshot>();
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private dirty = new Set<string>();

  constructor(private readonly root: string, private readonly onError?: (error: Error) => void) {}

  async start(runId: string, target: Target, prompt: string, approvalMode: ApprovalMode): Promise<void> {
    if (!runId || runId.length > 1_000 || !target.projectId || target.projectId.length > 1_000 || !target.chatId || target.chatId.length > 1_000) {
      throw new Error("Run journal identifiers must be non-empty and at most 1000 characters.");
    }
    const snapshot: Snapshot = {
      version: JOURNAL_VERSION, runId, target, prompt: bounded(prompt), approvalMode,
      startedAt: new Date().toISOString(), planner: "unknown", text: "", toolCalls: [], changes: [], evidence: [], failures: [], clipped: false,
    };
    this.snapshots.set(runId, snapshot);
    this.dirty.add(runId);
    await this.flush();
  }

  record(event: RunEvent): void {
    const snapshot = this.snapshots.get(event.runId);
    if (!snapshot) return;
    applyEvent(snapshot, event);
    this.dirty.add(event.runId);
    const urgent = event.type === "change" || event.type === "failure" || event.type === "run-completed";
    if (urgent) this.flushInBackground();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flushInBackground(); }, WRITE_DELAY_MS);
  }

  async drain(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.flush();
    await this.queue;
  }

  async recover(): Promise<Array<{ projectId: string; chatId: string; message: ChatMessage }>> {
    await this.drain();
    await mkdir(this.root, { recursive: true });
    const files = (await readdir(this.root)).filter((file) => file.endsWith(".json"));
    const recovered: Array<{ projectId: string; chatId: string; message: ChatMessage }> = [];
    for (const file of files) {
      const path = join(this.root, file);
      try {
        if ((await stat(path)).size > MAX_SNAPSHOT_BYTES) throw new Error("Run journal snapshot exceeds its 2 MB safety limit.");
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!validSnapshot(value) || file !== fileFor(value.runId)) throw new Error("Invalid run journal snapshot");
        this.snapshots.set(value.runId, value);
        recovered.push({ ...value.target, message: recoveredMessage(value) });
      } catch {
        const backup = `${path}.corrupt-${Date.now()}`;
        await copyFile(path, backup).catch(() => undefined);
      }
    }
    return recovered;
  }

  async acknowledge(runIds: string[]): Promise<void> {
    await this.drain();
    for (const runId of new Set(runIds)) {
      await unlink(join(this.root, fileFor(runId))).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.snapshots.delete(runId);
      this.dirty.delete(runId);
    }
  }

  /**
   * Write every dirty snapshot, in order, without letting one failure end the
   * journal.
   *
   * The queue is what serialises writes, so it is also what a rejection would
   * poison: `then` on an already-rejected promise never runs its callback, so a
   * single failed write used to make every later flush a silent no-op, with the
   * ids it was carrying already dropped from the dirty set. Crash recovery then
   * looked healthy and recorded nothing for the rest of the session, which is
   * the worst way for a recovery mechanism to fail.
   *
   * So the chain is kept settled whatever an attempt does, and failed work goes
   * back to the dirty set to be picked up once storage recovers. The caller
   * still sees the rejection: `drain` is entitled to know the snapshot on disk
   * is not the one in memory.
   */
  private async flush(): Promise<void> {
    const ids = [...this.dirty];
    if (ids.length === 0) return this.queue;
    ids.forEach((id) => this.dirty.delete(id));
    const attempt = this.queue.then(async () => {
      await mkdir(this.root, { recursive: true });
      for (const id of ids) {
        const snapshot = this.snapshots.get(id);
        if (!snapshot) continue;
        const path = join(this.root, fileFor(id));
        const temporary = `${path}.tmp`;
        await writeFile(temporary, serializeBounded(snapshot), "utf8");
        await rename(temporary, path);
      }
    });
    this.queue = attempt.catch(() => {
      // A run acknowledged in the meantime is deliberately not restored: its
      // file is already gone and rewriting it would resurrect a finished run.
      for (const id of ids) if (this.snapshots.has(id)) this.dirty.add(id);
    });
    return attempt;
  }

  private flushInBackground(): void {
    void this.flush().catch((value: unknown) => {
      const error = value instanceof Error ? value : new Error(String(value));
      try {
        this.onError?.(error);
      } catch {
        // The journal already retains the write failure for drain(); an error
        // reporter must not turn a handled background failure into a process-level rejection.
      }
    });
  }
}
