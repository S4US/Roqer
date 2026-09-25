/**
 * What a long agent-loop run carries forward, and what it stops carrying.
 *
 * Every turn re-sends the whole conversation, so a run's cost grows with the
 * square of its length: a fiftieth turn pays again for all forty-nine tool
 * results before it. A measured eighteen-turn build settled 210,169 raw tokens
 * for that reason, most of them the same Studio output sent over and over.
 *
 * Two bounds are applied here, both to the message list the planner keeps
 * between turns. Neither drops anything the run's own record needs: Activity,
 * the change artifacts, the evidence cards, and the completion gate all read the
 * host's arrays, not this list. What is dropped is the model's verbatim memory
 * of tool output it has already acted on, and the replacement tells it so.
 *
 * Both bounds are deliberately hysteretic — they fire only above a high-water
 * mark and then cut well below it, rather than trimming a little every turn.
 * The provider serves a run's repeated prefix from an automatic prompt cache at
 * a tenth of the price, and a cache hit ends at the first token that changed, so
 * rewriting an early message every turn would trade a real discount for a
 * nominal saving. Firing rarely and cutting deeply keeps the prefix stable for
 * long stretches between the two moments it is not.
 */

import {
  MAX_TURN_MESSAGES,
  type TurnContent,
  type TurnMessage,
} from "./model-api/turn-contract";

import type { CompletionVerification } from "../shared/completion";
import { boundedLines, changeLine, taskLine, type RunDecision } from "../shared/run-digest";
import type { RunChange, RunEvidence } from "../shared/run-events";
import type { RunTask } from "../shared/tasks";

/**
 * Aggregate tool output the conversation carries, in characters, and the level
 * it is cut back to when that is exceeded. Roughly 100,000 tokens down to
 * 50,000: enough that an ordinary run never reaches it, and enough of a gap
 * that a run which does is not re-cut for many turns afterwards.
 */
const MAX_RETAINED_TOOL_RESULT_CHARACTERS = 400_000;
const RETAINED_TOOL_RESULT_LOW_WATER = 200_000;

/**
 * How long the conversation grows before older exchanges are folded away, and
 * how many exchanges survive the fold. An exchange is two messages: what the
 * model said, then what its tools returned.
 *
 * Well under the contract's own ceiling on purpose. Waiting for that ceiling
 * would make compaction an overflow valve that fires once, at the end of the
 * longest runs; firing at thirty exchanges makes it the working-window policy
 * it is meant to be, and is what keeps request size flat rather than growing
 * for the rest of the run.
 */
export const COMPACTION_TRIGGER_MESSAGES = 61;
export const RETAINED_EXCHANGES = 12;

/** The host's own record of the run, which outlives the messages describing it. */
export type RunStateSnapshot = {
  tasks: readonly RunTask[];
  changes: readonly RunChange[];
  evidence: readonly RunEvidence[];
  verification: CompletionVerification;
  /**
   * Answers the user gave when asked. The only entry here the host did not
   * observe itself, and the one a fold most needs to carry: the answer lives in
   * a single tool result, and a model that loses it will either ask again --
   * out of budget, so it cannot -- or guess.
   */
  decisions: readonly RunDecision[];
};

/** Bounded entries as bullets; the formatting lives with the digest in shared. */
function bulletList(lines: readonly string[]): string[] {
  return boundedLines(lines).map((line) => `- ${line}`);
}

function evidenceLine(item: RunEvidence): string {
  const verdict = item.passed === undefined ? "recorded" : item.passed ? "passed" : "did not pass";
  return `${item.kind} ${item.title} — ${verdict}`;
}

/**
 * The message that replaces the exchanges being folded away.
 *
 * Host-authored rather than model-authored: asking the model to summarize its
 * own history would cost a turn, could be wrong about what it actually changed,
 * and would be one more thing to validate. Everything below is read from the
 * arrays the host recorded while the work happened, so it is the same record the
 * completion gate is judged against.
 *
 * It is a user message because that is the only role a caller may send, and it
 * says plainly that the detail is gone so the model re-reads Studio rather than
 * answering from a memory it no longer has.
 */
export function describeRunState(snapshot: RunStateSnapshot, foldedMessages: number): string {
  const sections: string[] = [
    `[Roqer folded ${foldedMessages} earlier messages out of this conversation to keep it bounded. `
    + "What follows is the host's own record of the run so far, which is what the completion gate reads.]",
  ];

  const { tasks, changes, evidence, verification, decisions } = snapshot;
  if (tasks.length > 0) sections.push(["Tasks:", ...bulletList(tasks.map(taskLine))].join("\n"));
  if (changes.length > 0) {
    sections.push(["Changes applied so far:", ...bulletList(changes.map(changeLine))].join("\n"));
  }
  if (evidence.length > 0) {
    sections.push(["Evidence collected so far:", ...bulletList(evidence.map(evidenceLine))].join("\n"));
  }
  if (decisions.length > 0) {
    sections.push([
      "Decisions the user made when asked:",
      ...bulletList(decisions.map((decision) => `${decision.question} → ${decision.answer}`)),
    ].join("\n"));
  }
  if (!verification.verified && verification.issues.length > 0) {
    sections.push([
      "Still unverified if the run ended now:",
      ...bulletList(verification.issues.map((issue) => issue.detail)),
    ].join("\n"));
  }

  sections.push(
    "The tool results from those folded messages are gone. Read Studio again for anything you need "
    + "rather than answering from a memory of output that is no longer in front of you.",
  );
  return sections.join("\n\n");
}

/**
 * Fold the oldest exchanges into one host-authored summary.
 *
 * The opening message is never folded: it carries the request itself and any
 * picture the user attached with it, and a run that forgets what it was asked
 * for has lost more than it saved.
 *
 * The retained window is opened at an assistant message, found by walking back
 * rather than by index parity, because a previous fold left a summary message
 * behind and shifted every parity after it. Starting anywhere else would leave a
 * tool result whose call is no longer in the conversation, which no provider
 * accepts.
 *
 * Returns true when it folded, so the caller can say so.
 */
export function compactHistory(
  messages: TurnMessage[],
  describe: (foldedMessages: number) => string,
): boolean {
  if (messages.length < COMPACTION_TRIGGER_MESSAGES) return false;

  let start = messages.length - RETAINED_EXCHANGES * 2;
  while (start > 1 && messages[start].role !== "assistant") start -= 1;
  if (start <= 1) return false;

  const folded = start - 1;
  messages.splice(1, folded, { role: "user", content: [{ kind: "text", text: describe(folded) }] });
  return true;
}

/** What an elided result says in place of the output it is standing in for. */
const ELISION_MARKER = "[Roqer elided this earlier result";

function elisionText(characters: number): string {
  return `${ELISION_MARKER} (${characters} characters) to keep the conversation bounded. `
    + "Run the call again if you still need what it returned.]";
}

/**
 * Drop the oldest tool output once the conversation carries too much of it.
 *
 * The result block itself stays, with its call id and its failed flag: a
 * conversation missing the answer to a call it can see having been made is one
 * the provider refuses, and a failure that quietly became a success would be
 * worse than a verbose one. Only the text goes.
 *
 * Elision runs oldest-first from a fixed budget rather than newest-first from a
 * moving one, so a block that has been elided stays elided and the prefix
 * settles instead of shifting every turn. A block already elided is left
 * exactly as it is on a later pass: rewriting it would restate the original
 * size as the size of the notice, and move the cached prefix for nothing.
 *
 * `keep` names results that are never elided however old they are. The notice
 * says "run the call again", and for an answer the user gave that is not
 * possible -- the question budget is spent -- and not what anyone wants.
 */
export type ToolOutputBudget = Readonly<{ max: number; lowWater: number }>;

export const DEFAULT_TOOL_OUTPUT_BUDGET: ToolOutputBudget = {
  max: MAX_RETAINED_TOOL_RESULT_CHARACTERS,
  lowWater: RETAINED_TOOL_RESULT_LOW_WATER,
};

/**
 * The tool-output budget for a model that holds `contextWindow` tokens.
 *
 * About a third of the window, at four characters a token, and never more
 * than the default: a small local model has to keep room for the instructions,
 * the tool schemas, and its own answer, and one long script read would
 * otherwise fill it on the next turn.
 */
export function toolOutputBudgetFor(contextWindow: number | undefined): ToolOutputBudget {
  if (contextWindow === undefined) return DEFAULT_TOOL_OUTPUT_BUDGET;
  const max = Math.min(MAX_RETAINED_TOOL_RESULT_CHARACTERS, Math.max(8_000, Math.floor(contextWindow * 4 * 0.35)));
  return { max, lowWater: Math.floor(max / 2) };
}

export function boundRetainedToolResults(
  messages: TurnMessage[],
  keep: ReadonlySet<string> = new Set(),
  budget: ToolOutputBudget = DEFAULT_TOOL_OUTPUT_BUDGET,
): boolean {
  const lengths: number[] = [];
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.kind !== "tool-result") continue;
      lengths.push(block.content.length);
      total += block.content.length;
    }
  }
  if (total <= budget.max) return false;

  // Newest-first only to find where the cut falls; the cut itself is applied to
  // everything older, in place.
  let kept = 0;
  let keepFrom = lengths.length;
  for (let index = lengths.length - 1; index >= 0; index -= 1) {
    if (kept + lengths[index] > budget.lowWater) break;
    kept += lengths[index];
    keepFrom = index;
  }

  let seen = 0;
  let elided = false;
  for (const [index, message] of messages.entries()) {
    if (!message.content.some((block) => block.kind === "tool-result")) continue;
    const content = message.content.map((block): TurnContent => {
      if (block.kind !== "tool-result") return block;
      const position = seen;
      seen += 1;
      if (position >= keepFrom || keep.has(block.callId) || block.content.startsWith(ELISION_MARKER)) return block;
      elided = true;
      return { ...block, content: elisionText(block.content.length) };
    });
    messages[index] = { ...message, content };
  }
  return elided;
}

/**
 * The message ceiling compaction has to stay under, re-exported so the test
 * that ties the two together reads them from one place. Compaction is what
 * makes the planner's turn bound safe: if they ever disagree, a long run would
 * be refused by the turn contract's own validation at the point of most invested work.
 */
export const MESSAGE_CEILING = MAX_TURN_MESSAGES;
