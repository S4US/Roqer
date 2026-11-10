import type { CompletionVerification } from "../shared/completion";
import type { ConversationContext } from "../shared/conversation";
import type { RunDecision } from "../shared/run-digest";
import type { RunChange, RunEvidence } from "../shared/run-events";
import type { RunTask } from "../shared/tasks";
import type { McpToolOutcome } from "./mcp-types";

/**
 * What a review pass is given and how it is bounded.
 *
 * The reviewer is a second planner run with a fresh conversation. It does not
 * see the worker's conversation, only this packet: the host's own record of
 * the run. That keeps it from inheriting the worker's view of its own work,
 * and it means every line the reviewer reads is one the host recorded.
 *
 * The bounds here are enforced by the run engine, not asked of the model: a
 * review that keeps reading is refused further calls, and one that runs long
 * is stopped.
 */

/** Studio calls one review may make before further calls are refused. */
export const REVIEW_CALL_BUDGET = 24;
/** How long one review may take before it is stopped and recorded as incomplete. */
export const REVIEW_TIME_LIMIT_MS = 10 * 60_000;

/** How much of the chat before this run the reviewer is shown, newest last. */
const MAX_REVIEW_CONVERSATION_MESSAGES = 6;
const MAX_PACKET_PROMPT_CHARS = 16_000;
const MAX_PACKET_REPLY_CHARS = 8_000;
/** One change's diff or source; a longer one is cut and the reviewer told to read the script. */
const MAX_PACKET_CHANGE_CHARS = 6_000;
/** Every change's diff or source together; later changes are then listed without theirs. */
const MAX_PACKET_CHANGES_CHARS = 48_000;
const MAX_PACKET_CHANGES = 60;
const MAX_PACKET_EVIDENCE = 60;
const MAX_PACKET_LINE_CHARS = 400;

export type ReviewPacketInput = {
  /** The run's prompt as the worker received it. */
  prompt: string;
  /** Notes the user added while the run worked, oldest first. */
  notes: readonly string[];
  decisions: readonly RunDecision[];
  tasks: readonly RunTask[];
  changes: readonly RunChange[];
  evidence: readonly RunEvidence[];
  verification: CompletionVerification;
  /** The worker's final reply. */
  reply: string;
};

function cut(text: string, limit: number, note: string): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[${note}]`;
}

function oneLine(text: string, limit = MAX_PACKET_LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/** A fence longer than any run of backticks in the text, so the text cannot close it. */
function fenced(text: string, language = ""): string {
  const longest = (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function changeHeading(change: RunChange): string {
  const lines = change.addedLines !== undefined || change.removedLines !== undefined
    ? ` (+${change.addedLines ?? 0} -${change.removedLines ?? 0})`
    : "";
  const asset = change.kind === "asset" && change.assetId !== undefined
    ? ` asset ${change.assetId}${change.assetType === undefined ? "" : ` (${change.assetType})`}`
    : "";
  return `- ${change.kind} ${oneLine(change.target)}${lines}${asset}: ${oneLine(change.summary)}`;
}

function describeChanges(changes: readonly RunChange[]): string[] {
  if (changes.length === 0) return ["(none recorded)"];
  const lines: string[] = [];
  let spent = 0;
  for (const change of changes.slice(0, MAX_PACKET_CHANGES)) {
    lines.push(changeHeading(change));
    const body = change.diff ?? change.code;
    if (body === undefined || body === "") continue;
    if (spent >= MAX_PACKET_CHANGES_CHARS) {
      lines.push("  [Its diff is left out to keep this packet bounded. Read the current source in Studio.]");
      continue;
    }
    const shown = cut(body, MAX_PACKET_CHANGE_CHARS, "Cut here. Read the current source in Studio for the rest.");
    spent += shown.length;
    const cutNote = change.truncated === true ? "\n[Roqer recorded only part of this change. Read the current source in Studio.]" : "";
    lines.push(fenced(shown, change.diff !== undefined ? "diff" : change.language ?? "") + cutNote);
  }
  if (changes.length > MAX_PACKET_CHANGES) lines.push(`[${changes.length - MAX_PACKET_CHANGES} more changes are not listed.]`);
  return lines;
}

function describeEvidence(evidence: readonly RunEvidence[]): string[] {
  if (evidence.length === 0) return ["(none recorded)"];
  // The newest evidence describes the final state, so it is what is kept.
  const shown = evidence.slice(-MAX_PACKET_EVIDENCE);
  const lines = shown.map((item) => {
    const verdict = item.passed === undefined ? "recorded" : item.passed ? "passed" : "FAILED";
    const detail = item.detail === undefined || item.detail === "" ? "" : `: ${oneLine(item.detail, 240)}`;
    return `- [${verdict}] ${item.kind}: ${oneLine(item.title, 200)}${detail}`;
  });
  return evidence.length > shown.length
    ? [`[${evidence.length - shown.length} earlier pieces of evidence are not listed.]`, ...lines]
    : lines;
}

/**
 * The reviewer's whole brief, written by the host from its own record.
 *
 * Each part is labelled for what it is, because the parts differ in how far
 * they can be trusted: the request is the user's words, the record is what the
 * host observed, and the worker's reply is a claim to check.
 */
export function buildReviewPacket(input: ReviewPacketInput): string {
  const sections: string[] = [
    "Roqer review packet. Roqer, the host, wrote this from its own record of a run that has just finished. Review that run as your instructions describe. This packet is not a new request from the user.",
    `## What the user asked\n${fenced(cut(input.prompt, MAX_PACKET_PROMPT_CHARS, "The rest of the request is cut."))}`,
  ];
  if (input.notes.length > 0) {
    sections.push(`## Notes the user added while the run worked\n${input.notes.map((note) => `- ${oneLine(note, 2_000)}`).join("\n")}`);
  }
  if (input.decisions.length > 0) {
    sections.push(`## Questions the run asked, and the user's answers\n${input.decisions
      .map((decision) => `- ${oneLine(decision.question)} Answer: ${oneLine(decision.answer)}`).join("\n")}`);
  }
  if (input.tasks.length > 0) {
    sections.push(`## The worker's task list\n${input.tasks.map((task) => `- [${task.status}] ${oneLine(task.title)}`).join("\n")}`);
  }
  sections.push(`## Changes Roqer recorded\n${describeChanges(input.changes).join("\n")}`);
  sections.push(`## Evidence Roqer recorded\n${describeEvidence(input.evidence).join("\n")}`);
  sections.push(input.verification.verified
    ? "## Roqer's completion gate\nSatisfied: every recorded change was read back and no promised evidence is missing. The gate checks that the work was verified, not that it is what the user asked for."
    : `## Roqer's completion gate\nNot satisfied:\n${input.verification.issues.map((issue) => `- ${oneLine(issue.detail)}`).join("\n")}`);
  sections.push(`## The worker's reply (a claim to check, not a fact)\n${fenced(cut(input.reply, MAX_PACKET_REPLY_CHARS, "The rest of the reply is cut."))}`);
  return sections.join("\n\n");
}

/**
 * The chat before this run, for a reviewer that has to know what "it" in
 * "make it bigger" refers to: the last few messages only, and no compact
 * record, since the packet carries everything about the run itself.
 */
export function reviewConversation(conversation: ConversationContext): ConversationContext {
  const cut = conversation.messages.length > MAX_REVIEW_CONVERSATION_MESSAGES || conversation.summary !== undefined;
  return {
    messages: conversation.messages.slice(-MAX_REVIEW_CONVERSATION_MESSAGES),
    truncated: conversation.truncated || cut,
  };
}

/** What a reviewer is told when it asks for one call too many. */
export function reviewBudgetOutcome(tool: string): McpToolOutcome {
  const message = `Roqer did not run ${tool}: this review has used its ${REVIEW_CALL_BUDGET} Studio calls. Write the verdict now from what you have read, and list anything you could not check as a low finding.`;
  return {
    ok: false,
    data: { success: false, errorCode: "review_budget_spent", tool },
    text: "",
    httpStatus: 0,
    errorCode: "review_budget_spent",
    message,
    durationMs: 0,
  };
}
