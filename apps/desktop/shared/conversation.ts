import { digestChars, isRunDigest, type RunDigest } from "./run-digest";

/** A prior message that the next model run may use as chat context. */
export type ConversationMessage = {
  role: "user" | "assistant";
  text: string;
  /**
   * The host's digest of the run that produced an assistant message: what it
   * changed, what it left open, what the user decided. Absent on user messages
   * and on replies that were not runs.
   */
  run?: RunDigest;
};

/**
 * A bounded slice of one chat's transcript.
 *
 * `truncated` is explicit so the model never mistakes a recent window for the
 * complete conversation.
 */
export type ConversationContext = {
  messages: ConversationMessage[];
  truncated: boolean;
};

export const MAX_CONVERSATION_MESSAGES = 48;
export const MAX_CONVERSATION_MESSAGE_CHARS = 16_000;
export const MAX_CONVERSATION_CHARS = 64_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Build the newest useful transcript window without creating an unbounded prompt.
 *
 * A digest is admitted with its message when both fit, and dropped before the
 * message when they do not: what the agent said is the transcript, and the
 * record beside it is worth less than the words it describes. Newest first
 * means the most recent run's record is the one most likely to be kept, which
 * is the one a follow-up is most likely to be about.
 */
export function boundConversation(messages: readonly ConversationMessage[]): ConversationContext {
  const boundedNewestFirst: ConversationMessage[] = [];
  let totalChars = 0;
  let truncated = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (boundedNewestFirst.length >= MAX_CONVERSATION_MESSAGES) {
      truncated = true;
      break;
    }

    const message = messages[index];
    const text = message.text.length > MAX_CONVERSATION_MESSAGE_CHARS
      ? `${message.text.slice(0, MAX_CONVERSATION_MESSAGE_CHARS - 1)}…`
      : message.text;
    if (text.length !== message.text.length) truncated = true;

    if (totalChars + text.length > MAX_CONVERSATION_CHARS) {
      truncated = true;
      break;
    }

    let run = message.run;
    if (run !== undefined && totalChars + text.length + digestChars(run) > MAX_CONVERSATION_CHARS) {
      run = undefined;
      truncated = true;
    }

    boundedNewestFirst.push({ role: message.role, text, ...(run === undefined ? {} : { run }) });
    totalChars += text.length + (run === undefined ? 0 : digestChars(run));
  }

  if (boundedNewestFirst.length < messages.length) truncated = true;
  return { messages: boundedNewestFirst.reverse(), truncated };
}

/** Validate the renderer-provided transcript at the main-process trust boundary. */
export function isConversationContext(value: unknown): value is ConversationContext {
  if (!isRecord(value) || typeof value.truncated !== "boolean" || !Array.isArray(value.messages)) return false;
  if (value.messages.length > MAX_CONVERSATION_MESSAGES) return false;

  let totalChars = 0;
  for (const message of value.messages) {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) return false;
    if (typeof message.text !== "string" || message.text.length > MAX_CONVERSATION_MESSAGE_CHARS) return false;
    totalChars += message.text.length;
    if (message.run !== undefined) {
      // A run belongs to a reply. A user message carrying one is not a shape
      // the renderer can produce, so it is refused rather than ignored.
      if (message.role !== "assistant" || !isRunDigest(message.run)) return false;
      totalChars += digestChars(message.run);
    }
    if (totalChars > MAX_CONVERSATION_CHARS) return false;
  }
  return true;
}
