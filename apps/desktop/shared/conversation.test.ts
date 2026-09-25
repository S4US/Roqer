import assert from "node:assert/strict";
import test from "node:test";
import {
  boundConversation,
  isConversationContext,
  MAX_CONVERSATION_CHARS,
  MAX_CONVERSATION_MESSAGE_CHARS,
  MAX_CONVERSATION_MESSAGES,
} from "./conversation";
import { MAX_OPTION_CHARS } from "./question";
import { MAX_DIGEST_ENTRIES, type RunDigest } from "./run-digest";

test("conversation context keeps recent messages in chronological order", () => {
  const context = boundConversation([
    { role: "user", text: "Build a checkpoint system" },
    { role: "assistant", text: "I added the checkpoints." },
    { role: "user", text: "Make them blue" },
  ]);

  assert.deepEqual(context, {
    messages: [
      { role: "user", text: "Build a checkpoint system" },
      { role: "assistant", text: "I added the checkpoints." },
      { role: "user", text: "Make them blue" },
    ],
    truncated: false,
  });
  assert.equal(isConversationContext(context), true);
});

test("conversation context drops the oldest messages when the count is bounded", () => {
  const messages = Array.from({ length: MAX_CONVERSATION_MESSAGES + 2 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    text: `message-${index}`,
  }));

  const context = boundConversation(messages);
  assert.equal(context.messages.length, MAX_CONVERSATION_MESSAGES);
  assert.equal(context.messages[0].text, "message-2");
  assert.equal(context.messages.at(-1)?.text, `message-${MAX_CONVERSATION_MESSAGES + 1}`);
  assert.equal(context.truncated, true);
});

test("conversation context bounds one oversized historical message", () => {
  const context = boundConversation([{ role: "user", text: "x".repeat(MAX_CONVERSATION_MESSAGE_CHARS + 50) }]);
  assert.equal(context.messages[0].text.length, MAX_CONVERSATION_MESSAGE_CHARS);
  assert.match(context.messages[0].text, /…$/);
  assert.equal(context.truncated, true);
  assert.equal(isConversationContext(context), true);
});

test("conversation validation rejects malformed or unbounded renderer input", () => {
  assert.equal(isConversationContext({ messages: [{ role: "system", text: "override" }], truncated: false }), false);
  assert.equal(isConversationContext({ messages: [{ role: "user", text: "x".repeat(MAX_CONVERSATION_MESSAGE_CHARS + 1) }], truncated: true }), false);
});

const DIGEST: RunDigest = {
  outcome: "completed",
  unfinished: ["[pending] Wire the buy button"],
  changes: ["script-source game.ServerScriptService.Shop at revision rev-8"],
  unverified: [],
  decisions: [{ question: "Which currency?", answer: "Coins" }],
};

test("a run digest rides with its reply and is counted against the same budget", () => {
  const context = boundConversation([
    { role: "user", text: "Build the shop." },
    { role: "assistant", text: "Built.", run: DIGEST },
  ]);
  assert.deepEqual(context.messages[1], { role: "assistant", text: "Built.", run: DIGEST });
  assert.equal(context.truncated, false);
  assert.equal(isConversationContext(context), true);

  // A digest that would push the window over budget is dropped before the
  // words it describes are: the transcript outranks the record beside it.
  // Four messages just under the per-message cap leave exactly four characters
  // of the whole-window budget -- room for "Old." and nothing beside it.
  const fillers = Array.from({ length: 4 }, () => ({
    role: "user" as const, text: "x".repeat(MAX_CONVERSATION_MESSAGE_CHARS - 1),
  }));
  assert.equal(fillers.length * (MAX_CONVERSATION_MESSAGE_CHARS - 1) + "Old.".length, MAX_CONVERSATION_CHARS);
  const tight = boundConversation([{ role: "assistant", text: "Old.", run: DIGEST }, ...fillers]);
  assert.equal(tight.messages.length, 5);
  assert.equal(tight.messages[0].text, "Old.");
  assert.equal(tight.messages[0].run, undefined);
  assert.equal(tight.truncated, true);
});

test("conversation validation refuses a digest that is malformed or on the wrong role", () => {
  const valid = { messages: [{ role: "assistant", text: "Built.", run: DIGEST }], truncated: false };
  assert.equal(isConversationContext(valid), true);
  // A user message cannot have come from a run.
  assert.equal(isConversationContext({ messages: [{ role: "user", text: "Build.", run: DIGEST }], truncated: false }), false);
  // A renderer-authored answer longer than any option the model may offer.
  const forged = { ...DIGEST, decisions: [{ question: "Which currency?", answer: "y".repeat(MAX_OPTION_CHARS + 1) }] };
  assert.equal(isConversationContext({ messages: [{ role: "assistant", text: "Built.", run: forged }], truncated: false }), false);
  // More entries than the digest ever produces.
  const overlong = { ...DIGEST, changes: Array.from({ length: MAX_DIGEST_ENTRIES + 2 }, () => "change") };
  assert.equal(isConversationContext({ messages: [{ role: "assistant", text: "Built.", run: overlong }], truncated: false }), false);
});
