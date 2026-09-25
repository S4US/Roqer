/**
 * Keep a long transcript useful without keeping every rich message mounted.
 *
 * Messages outside this window remain in the workspace and are still included
 * by the bounded provider-context builder. This only controls presentation.
 */
export const CONVERSATION_WINDOW_SIZE = 30;

/** First message shown when a chat is opened. */
export function initialConversationWindowStart(messageCount: number): number {
  return Math.max(0, messageCount - CONVERSATION_WINDOW_SIZE);
}

/** Move the visible window one page toward the start of the chat. */
export function earlierConversationWindowStart(currentStart: number): number {
  return Math.max(0, currentStart - CONVERSATION_WINDOW_SIZE);
}
