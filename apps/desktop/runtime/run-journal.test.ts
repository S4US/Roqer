import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunEvent } from "../shared/run-events";
import { RunJournal } from "./run-journal";

async function temporaryJournal(): Promise<{ root: string; journal: RunJournal; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "roqer-run-journal-"));
  return { root, journal: new RunJournal(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

const event = <T extends RunEvent>(value: T): T => value;

test("recovers an interrupted run with changes and evidence truthfully", async () => {
  const fixture = await temporaryJournal();
  try {
    await fixture.journal.start("run-1", { projectId: "project", chatId: "chat" }, "make it", "Ask first");
    fixture.journal.record(event({
      type: "run-started", runId: "run-1", seq: 1, at: "2026-01-01T00:00:00.000Z", prompt: "make it",
      approvalMode: "Ask first", autoPlaytest: false, endpoint: "http://127.0.0.1", instanceId: null,
      model: null, effort: "medium", planner: "inspection",
    }));
    fixture.journal.record(event({ type: "message-delta", runId: "run-1", seq: 2, at: "2026-01-01T00:00:01.000Z", text: "I changed the script." }));
    fixture.journal.record(event({
      type: "change", runId: "run-1", seq: 3, at: "2026-01-01T00:00:02.000Z",
      change: { id: "c1", kind: "script-source", target: "game.ServerScriptService.Main", summary: "Updated Main" },
    }));
    fixture.journal.record(event({
      type: "evidence", runId: "run-1", seq: 4, at: "2026-01-01T00:00:03.000Z",
      evidence: { id: "e1", kind: "inspection", title: "Main", detail: "Source was inspected" },
    }));
    await fixture.journal.drain();

    const recovered = await new RunJournal(fixture.root).recover();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].projectId, "project");
    assert.equal(recovered[0].message.run?.outcome, "cancelled");
    assert.equal(recovered[0].message.run?.changes[0].target, "game.ServerScriptService.Main");
    assert.equal(recovered[0].message.run?.evidence[0].title, "Main");
    assert.match(recovered[0].message.text, /Previous changes may already exist in Studio/);
    assert.equal(recovered[0].message.run?.verification?.verified, false);
  } finally { await fixture.cleanup(); }
});

test("keeps a completed run until it is acknowledged", async () => {
  const fixture = await temporaryJournal();
  try {
    await fixture.journal.start("run-2", { projectId: "p", chatId: "c" }, "inspect", "Read only");
    fixture.journal.record(event({
      type: "run-completed", runId: "run-2", seq: 1, at: "2026-01-02T00:00:00.000Z",
      outcome: "completed", summary: "Inspection complete.", verification: { verified: true, issues: [] },
    }));
    await fixture.journal.drain();
    let recovered = await new RunJournal(fixture.root).recover();
    assert.equal(recovered[0].message.run?.outcome, "completed");
    assert.match(recovered[0].message.text, /Inspection complete/);

    await fixture.journal.acknowledge(["run-2", "run-2"]);
    recovered = await new RunJournal(fixture.root).recover();
    assert.deepEqual(recovered, []);
  } finally { await fixture.cleanup(); }
});

test("bounds persisted text and does not claim a clipped completion succeeded", async () => {
  const fixture = await temporaryJournal();
  try {
    await fixture.journal.start("run-3", { projectId: "p", chatId: "c" }, "large", "Full auto");
    fixture.journal.record(event({ type: "message-delta", runId: "run-3", seq: 1, at: "2026-01-01T00:00:00Z", text: "x".repeat(100_000) }));
    fixture.journal.record(event({
      type: "run-completed", runId: "run-3", seq: 2, at: "2026-01-01T00:00:01Z",
      outcome: "completed", summary: "Done", verification: { verified: true, issues: [] },
    }));
    await fixture.journal.drain();
    const [file] = (await readdir(fixture.root)).filter((name) => name.endsWith(".json"));
    assert.ok((await readFile(join(fixture.root, file), "utf8")).length < 40_000);
    const [recovered] = await new RunJournal(fixture.root).recover();
    assert.equal(recovered.message.run?.outcome, "failed");
    assert.equal(recovered.message.run?.verification?.verified, false);
    assert.match(recovered.message.text, /details were clipped/);
    assert.equal(recovered.message.run?.failures.at(-1)?.code, "journal-clipped");
  } finally { await fixture.cleanup(); }
});

test("background write failures are reported without an unhandled rejection and drain surfaces them", async () => {
  const base = await mkdtemp(join(tmpdir(), "roqer-run-journal-error-"));
  const root = join(base, "journal");
  let reported: Error | undefined;
  const journal = new RunJournal(root, (error) => { reported = error; });
  let unhandled: unknown;
  const onUnhandled = (reason: unknown): void => { unhandled = reason; };
  process.once("unhandledRejection", onUnhandled);
  try {
    await journal.start("run-error", { projectId: "p", chatId: "c" }, "change", "Ask first");
    await rm(root, { recursive: true, force: true });
    await writeFile(root, "blocks directory recreation", "utf8");
    journal.record(event({
      type: "change", runId: "run-error", seq: 1, at: "2026-01-01T00:00:00Z",
      change: { id: "c", kind: "properties", target: "game.Workspace.Part", summary: "Changed Color" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(reported);
    assert.equal(unhandled, undefined);
    await assert.rejects(journal.drain());
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await rm(base, { recursive: true, force: true });
  }
});

test("a write failure does not stop the journal once storage recovers", async () => {
  // The queue that serialises writes is also what a rejection would poison, and
  // a journal that silently stopped recording would leave a crash looking like
  // a run that never happened.
  const base = await mkdtemp(join(tmpdir(), "roqer-run-journal-recover-"));
  const root = join(base, "journal");
  const errors: Error[] = [];
  const journal = new RunJournal(root, (error) => { errors.push(error); });
  try {
    await journal.start("run-back", { projectId: "p", chatId: "c" }, "change", "Ask first");
    // A file where the directory belongs makes the next write fail.
    await rm(root, { recursive: true, force: true });
    await writeFile(root, "blocks directory recreation", "utf8");
    journal.record(event({
      type: "change", runId: "run-back", seq: 1, at: "2026-01-01T00:00:00Z",
      change: { id: "c1", kind: "properties", target: "game.Workspace.Part", summary: "Changed Color" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(errors.length, 1);

    await rm(root, { force: true });
    journal.record(event({
      type: "change", runId: "run-back", seq: 2, at: "2026-01-01T00:00:01Z",
      change: { id: "c2", kind: "properties", target: "game.Workspace.Part", summary: "Changed Size" },
    }));
    await journal.drain();

    const recovered = await new RunJournal(root).recover();
    assert.equal(recovered.length, 1);
    // Both survive: the change the failed write was carrying went back to the
    // pending set rather than being dropped with the attempt that lost it.
    assert.deepEqual(recovered[0].message.run?.changes.map((change) => change.id), ["c1", "c2"]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("truncating a long prompt alone does not downgrade a completed run", async () => {
  const fixture = await temporaryJournal();
  try {
    await fixture.journal.start("run-prompt", { projectId: "p", chatId: "c" }, "p".repeat(20_000), "Read only");
    fixture.journal.record(event({
      type: "run-completed", runId: "run-prompt", seq: 1, at: "2026-01-01T00:00:00Z",
      outcome: "completed", summary: "Done", verification: { verified: true, issues: [] },
    }));
    await fixture.journal.drain();
    const [recovered] = await new RunJournal(fixture.root).recover();
    assert.equal(recovered.message.run?.outcome, "completed");
    assert.equal(recovered.message.run?.verification?.verified, true);
  } finally { await fixture.cleanup(); }
});

test("backs up corrupt and unsupported snapshots without deleting the source", async () => {
  const fixture = await temporaryJournal();
  try {
    const corrupt = join(fixture.root, "bad.json");
    const unsupported = join(fixture.root, "future.json");
    await writeFile(corrupt, "{broken", "utf8");
    await writeFile(unsupported, JSON.stringify({ version: 99 }), "utf8");
    assert.deepEqual(await fixture.journal.recover(), []);
    const files = await readdir(fixture.root);
    assert.ok(files.includes("bad.json"));
    assert.ok(files.includes("future.json"));
    assert.equal(files.filter((name) => name.includes(".corrupt-")).length, 2);
  } finally { await fixture.cleanup(); }
});

test("drain flushes queued deltas and mutation checkpoints", async () => {
  const fixture = await temporaryJournal();
  try {
    await fixture.journal.start("run-4", { projectId: "p", chatId: "c" }, "change", "Auto approve");
    fixture.journal.record(event({ type: "message-delta", runId: "run-4", seq: 1, at: "2026-01-01T00:00:00Z", text: "queued text" }));
    fixture.journal.record(event({
      type: "change", runId: "run-4", seq: 2, at: "2026-01-01T00:00:01Z",
      change: { id: "c", kind: "properties", target: "game.Workspace.Part", summary: "Changed Color" },
    }));
    await fixture.journal.drain();
    const [recovered] = await new RunJournal(fixture.root).recover();
    assert.match(recovered.message.text, /queued text/);
    assert.equal(recovered.message.run?.changes.length, 1);
  } finally { await fixture.cleanup(); }
});
