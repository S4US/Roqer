import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_WINDOW_SIZE,
  earlierConversationWindowStart,
  initialConversationWindowStart,
} from "./conversation-window";

test("short conversations render in full", () => {
  assert.equal(initialConversationWindowStart(CONVERSATION_WINDOW_SIZE - 1), 0);
  assert.equal(initialConversationWindowStart(CONVERSATION_WINDOW_SIZE), 0);
});

test("long conversations open on the most recent page", () => {
  assert.equal(initialConversationWindowStart(CONVERSATION_WINDOW_SIZE + 17), 17);
});

test("earlier conversation pages reveal without crossing the beginning", () => {
  assert.equal(earlierConversationWindowStart(CONVERSATION_WINDOW_SIZE * 2 + 4), CONVERSATION_WINDOW_SIZE + 4);
  assert.equal(earlierConversationWindowStart(4), 0);
});
