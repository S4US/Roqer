import assert from "node:assert/strict";
import test from "node:test";

import { createInitialWorkspace, type ChatMessage, type WorkspaceState } from "../src/model";
import type { RunRecord } from "../shared/run-events";
import { mergeRecoveredRuns, type RecoveredRun } from "./recovered-runs";

const date = "2026-01-01T00:00:00.000Z";

function run(runId: string): RunRecord {
  return {
    schemaVersion: 1,
    runId,
    planner: "inspection",
    approvalMode: "Ask first",
    outcome: "cancelled",
    startedAt: date,
    finishedAt: date,
    toolCalls: [],
    changes: [],
    evidence: [],
    failures: [],
    verification: { verified: false, issues: [] },
  };
}

function message(runId: string): ChatMessage {
  return { id: `message-${runId}`, role: "assistant", text: "Recovered work", createdAt: date, run: run(runId) };
}

function workspace(): WorkspaceState {
  const state = createInitialWorkspace();
  state.projects[0].chats = [{ id: "chat", title: "Original", createdAt: date, updatedAt: date, messages: [] }];
  state.selectedChatId = "chat";
  return state;
}

function recovered(runId: string, projectId = "default", chatId = "chat"): RecoveredRun {
  return { projectId, chatId, message: message(runId) };
}

test("merges a recovered run into its original chat", () => {
  const merged = mergeRecoveredRuns(workspace(), [recovered("run-1")]);
  assert.equal(merged.projects.length, 1);
  assert.equal(merged.projects[0].chats[0].messages[0].run?.runId, "run-1");
});

test("deduplicates a recovered run when a crash happened after workspace save", () => {
  const saved = mergeRecoveredRuns(workspace(), [recovered("run-1")]);
  const replayed = mergeRecoveredRuns(saved, [recovered("run-1"), recovered("run-1")]);
  assert.equal(replayed.projects[0].chats[0].messages.length, 1);
  assert.equal(replayed, saved);
});

test("preserves an orphaned run in a clearly named recovered-work folder", () => {
  const merged = mergeRecoveredRuns(workspace(), [recovered("orphan", "missing-project", "missing-chat")]);
  const folder = merged.projects.find((project) => project.name === "Recovered work");
  assert.ok(folder);
  assert.equal(folder.chats[0].title, "Recovered run");
  assert.equal(folder.chats[0].messages[0].run?.runId, "orphan");
});
