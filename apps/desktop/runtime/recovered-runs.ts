import { appendMessage, type ChatMessage, type WorkspaceState } from "../src/model";

export type RecoveredRun = { projectId: string; chatId: string; message: ChatMessage };

/** Keeps recovery idempotent, including a crash between saving and acknowledgement. */
export function mergeRecoveredRuns(state: WorkspaceState, recovered: RecoveredRun[]): WorkspaceState {
  let next = state;
  for (const entry of recovered) {
    const runId = entry.message.run?.runId;
    if (!runId || next.projects.some((project) => project.chats.some((chat) => chat.messages.some((message) => message.run?.runId === runId)))) continue;
    const target = next.projects.find((project) => project.id === entry.projectId);
    if (target?.chats.some((chat) => chat.id === entry.chatId)) {
      next = appendMessage(next, entry.projectId, entry.chatId, entry.message);
      continue;
    }
    // A crash can happen before the renderer's new chat reaches storage. Keep
    // the evidence in a clearly named recovery folder instead of dropping it.
    const now = entry.message.createdAt;
    const id = `recovery-${runId}`;
    next = { ...next, projects: [...next.projects, {
      id, name: "Recovered work", createdAt: now, updatedAt: now,
      chats: [{ id, title: "Recovered run", createdAt: now, updatedAt: now, messages: [entry.message] }],
    }] };
  }
  return next;
}
