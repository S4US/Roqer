import assert from "node:assert/strict";
import test from "node:test";

import { digestIsEmpty, digestRun, isRunDigest, MAX_DIGEST_ENTRIES } from "./run-digest";
import { RUN_EVENT_SCHEMA_VERSION, isRunRecord, type RunRecord } from "./run-events";

const RECORD: RunRecord = {
  schemaVersion: RUN_EVENT_SCHEMA_VERSION,
  runId: "run_1",
  planner: "claude-code",
  approvalMode: "Auto approve",
  outcome: "completed",
  startedAt: "2026-09-12T10:00:00.000Z",
  finishedAt: "2026-09-12T10:04:00.000Z",
  toolCalls: [{ tool: "roblox_studio", ok: true, durationMs: 12, summary: "read" }],
  changes: [
    { id: "c1", kind: "script-source", target: "game.ServerScriptService.Shop", summary: "wrote", revisionAfter: "rev-8" },
  ],
  evidence: [{ id: "e1", kind: "verification", title: "game.ServerScriptService.Shop", passed: true }],
  failures: [],
  tasks: [
    { id: "t1", title: "Build the shop panel", status: "done", requiresRuntimeEvidence: false, requiredEvidence: [] },
    { id: "t2", title: "Wire the buy button", status: "blocked", requiresRuntimeEvidence: true, requiredEvidence: ["runtime"] },
  ],
  verification: {
    verified: false,
    issues: [{ code: "task-incomplete", detail: "\"Wire the buy button\" was still open when the run ended." }],
  },
  decisions: [{ question: "Which currency should the shop charge?", answer: "Coins" }],
};

test("a digest keeps what the next run needs and drops what it does not", () => {
  const digest = digestRun(RECORD);
  assert.deepEqual(digest, {
    outcome: "completed",
    // Done tasks are not carried: the changes say what was done.
    unfinished: ["[blocked] Wire the buy button (needs runtime evidence)"],
    changes: ["script-source game.ServerScriptService.Shop at revision rev-8"],
    unverified: ["\"Wire the buy button\" was still open when the run ended."],
    decisions: [{ question: "Which currency should the shop charge?", answer: "Coins" }],
  });
  assert.equal(isRunDigest(digest), true);
  assert.equal(digestIsEmpty(digest), false);
});

test("a verified run with everything done digests to its changes alone", () => {
  const digest = digestRun({
    ...RECORD,
    tasks: [RECORD.tasks![0]],
    verification: { verified: true, issues: [] },
    decisions: undefined,
  });
  assert.deepEqual(digest.unfinished, []);
  assert.deepEqual(digest.unverified, []);
  assert.deepEqual(digest.decisions, []);
  assert.equal(digest.changes.length, 1);
});

test("a run that recorded nothing digests to nothing, so no record is sent for it", () => {
  const digest = digestRun({ ...RECORD, changes: [], tasks: undefined, verification: undefined, decisions: undefined });
  assert.equal(digestIsEmpty(digest), true);
});

test("a digest is bounded however much a run changed, and still validates", () => {
  const changes = Array.from({ length: 60 }, (_, index) => ({
    id: `c${index}`, kind: "script-source" as const, target: `game.ServerScriptService.Script${index}`, summary: "wrote",
  }));
  const digest = digestRun({ ...RECORD, changes });
  assert.equal(digest.changes.length, MAX_DIGEST_ENTRIES + 1);
  assert.equal(digest.changes.at(-1), "(+40 more)");
  assert.equal(isRunDigest(digest), true);
});

test("a record written before decisions existed still validates, and one with them does too", () => {
  const older: Record<string, unknown> = { ...RECORD };
  delete older.decisions;
  assert.equal(isRunRecord(older), true);
  assert.equal(isRunRecord(RECORD), true);
  assert.equal(isRunRecord({ ...RECORD, decisions: [{ question: "", answer: "Coins" }] }), false);
});
