import assert from "node:assert/strict";
import test from "node:test";

import type { TurnMessage } from "./model-api/turn-contract";

import {
  boundRetainedToolResults,
  compactHistory,
  describeRunState,
  COMPACTION_TRIGGER_MESSAGES,
  MESSAGE_CEILING,
  RETAINED_EXCHANGES,
  type RunStateSnapshot,
} from "./agent-loop-history";
import type { RunChange, RunEvidence } from "../shared/run-events";
import type { RunTask } from "../shared/tasks";

const SNAPSHOT: RunStateSnapshot = {
  tasks: [
    { id: "t1", title: "Build the shop panel", status: "done", requiresRuntimeEvidence: true, requiredEvidence: ["visual"] },
    { id: "t2", title: "Wire the buy button", status: "active", requiresRuntimeEvidence: false, requiredEvidence: [] },
  ],
  changes: [
    { id: "c1", kind: "script-source", target: "game.ServerScriptService.Shop", summary: "wrote", revisionAfter: "rev-8" },
  ],
  evidence: [
    { id: "e1", kind: "verification", title: "game.ServerScriptService.Shop", passed: true },
  ],
  verification: { verified: false, issues: [{ code: "task-incomplete", detail: "\"Wire the buy button\" was still open when the run ended." }] },
  decisions: [{ question: "Which currency should the shop charge?", answer: "Coins" }],
};

/** One exchange: what the model said, then what its tools returned. */
function exchange(index: number, resultCharacters = 10): TurnMessage[] {
  const callId = `call_${index}`;
  return [
    { role: "assistant", content: [{ kind: "tool-call", call: { id: callId, name: "roblox_studio", arguments: {} } }] },
    { role: "user", content: [{ kind: "tool-result", callId, content: "x".repeat(resultCharacters), failed: false }] },
  ];
}

function conversation(exchanges: number, resultCharacters?: number): TurnMessage[] {
  const messages: TurnMessage[] = [{ role: "user", content: [{ kind: "text", text: "Build a shop" }] }];
  for (let index = 0; index < exchanges; index += 1) messages.push(...exchange(index, resultCharacters));
  return messages;
}

test("a short conversation is left exactly as it is", () => {
  const messages = conversation(4);
  const before = JSON.parse(JSON.stringify(messages)) as TurnMessage[];
  assert.equal(compactHistory(messages, () => "summary"), false);
  assert.equal(boundRetainedToolResults(messages), false);
  assert.deepEqual(messages, before);
});

test("folding keeps the opening request, the newest exchanges, and one summary", () => {
  const messages = conversation(40);
  const opening = messages[0];
  const newest = messages[messages.length - 1];

  assert.equal(compactHistory(messages, (folded) => `folded ${folded}`), true);

  assert.equal(messages.length, 2 + RETAINED_EXCHANGES * 2);
  assert.deepEqual(messages[0], opening, "the request itself is never folded");
  assert.deepEqual(messages[1], { role: "user", content: [{ kind: "text", text: "folded 56" }] });
  assert.deepEqual(messages[messages.length - 1], newest, "the newest exchange survives untouched");
});

test("a folded conversation always resumes at an assistant message", () => {
  // A tool result whose call is no longer in the conversation is a message no
  // provider accepts, so the retained window may never open on a user turn.
  const messages = conversation(40);
  compactHistory(messages, () => "first fold");
  assert.equal(messages[2].role, "assistant");

  // The summary shifted every parity after it, so the second fold cannot find
  // the boundary by counting.
  for (let index = 0; index < 40; index += 1) messages.push(...exchange(100 + index));
  compactHistory(messages, () => "second fold");
  assert.equal(messages[2].role, "assistant");
  assert.equal(
    messages.filter((message) =>
      message.content.some((block) => block.kind === "text" && block.text === "first fold")).length,
    0,
    "the earlier summary is folded away rather than accumulating",
  );
});

test("every retained tool result still answers a call the conversation can see", () => {
  const messages = conversation(40);
  compactHistory(messages, () => "summary");
  const callIds = new Set(messages.flatMap((message) =>
    message.content.flatMap((block) => block.kind === "tool-call" ? [block.call.id] : [])));
  for (const message of messages) {
    for (const block of message.content) {
      if (block.kind !== "tool-result") continue;
      assert.ok(callIds.has(block.callId), `${block.callId} has no call left in the conversation`);
    }
  }
});

test("the summary carries the host's record rather than the model's recollection", () => {
  const text = describeRunState(SNAPSHOT, 55);
  assert.match(text, /folded 55 earlier messages/);
  assert.match(text, /\[done\] Build the shop panel \(needs visual evidence\)/);
  assert.match(text, /\[active\] Wire the buy button/);
  assert.match(text, /script-source game\.ServerScriptService\.Shop at revision rev-8/);
  assert.match(text, /verification game\.ServerScriptService\.Shop — passed/);
  assert.match(text, /was still open when the run ended/);
  // The answer is the one entry the host did not observe and cannot re-derive.
  assert.match(text, /Which currency should the shop charge\? → Coins/);
  assert.match(text, /Read Studio again/);
});

test("an answer the user gave is never elided, however old it is", () => {
  // The elision notice says "run the call again". For an answer that is not
  // possible -- the question budget is spent -- so the model would be left to
  // guess at a decision the user already made.
  const messages = conversation(24, 30_000);
  messages[2] = {
    role: "user",
    content: [{ kind: "tool-result", callId: "call_0", content: "The user answered: Coins", failed: false }],
  };
  assert.equal(boundRetainedToolResults(messages, new Set(["call_0"])), true);
  const answer = messages[2].content[0];
  assert.equal(answer.kind === "tool-result" && answer.content, "The user answered: Coins");
  // The result right after it, not protected, went the ordinary way.
  const next = messages[4].content[0];
  assert.match(next.kind === "tool-result" ? next.content : "", /^\[Roqer elided/);
});

test("a result already elided is left alone by a later pass", () => {
  // Re-eliding an elided block would restate its size as the size of the
  // notice and rewrite a message the provider has already cached.
  const messages = conversation(24, 30_000);
  boundRetainedToolResults(messages);
  const notice = messages[2].content[0];
  assert.match(notice.kind === "tool-result" ? notice.content : "", /30000 characters/);

  // Enough new output to cross the high-water mark a second time.
  for (let index = 0; index < 12; index += 1) messages.push(...exchange(300 + index, 30_000));
  assert.equal(boundRetainedToolResults(messages), true);
  assert.deepEqual(messages[2].content[0], notice, "the first notice still names the original size");
});

test("the summary is bounded however much a run recorded", () => {
  const changes: RunChange[] = Array.from({ length: 60 }, (_, index) => ({
    id: `c${index}`,
    kind: "script-source",
    target: `game.ServerScriptService.Script${index}`,
    summary: "wrote",
  }));
  const text = describeRunState({ ...SNAPSHOT, changes }, 40);
  assert.match(text, /\(\+40 more\)/);
  assert.equal(text.includes("Script59"), false);
});

test("a run that recorded nothing still says what happened to its history", () => {
  const empty: RunStateSnapshot = { tasks: [], changes: [], evidence: [], verification: { verified: true, issues: [] }, decisions: [] };
  const text = describeRunState(empty, 12);
  assert.match(text, /folded 12 earlier messages/);
  assert.equal(text.includes("Tasks:"), false);
  assert.equal(text.includes("Changes applied"), false);
});

test("older tool output is elided once the conversation carries too much of it", () => {
  const messages = conversation(24, 30_000);
  assert.equal(boundRetainedToolResults(messages), true);

  const results = messages.flatMap((message) =>
    message.content.flatMap((block) => block.kind === "tool-result" ? [block] : []));
  const elided = results.filter((block) => block.content.startsWith("[Roqer elided"));
  assert.ok(elided.length > 0, "something was elided");
  assert.ok(elided.length < results.length, "the newest results survive");
  // Oldest-first: everything elided comes before everything kept.
  assert.equal(results.findIndex((block) => !block.content.startsWith("[Roqer elided")), elided.length);
  assert.match(elided[0].content, /30000 characters/);
});

test("an elided result keeps the call it answers and the verdict it carried", () => {
  const messages = conversation(24, 30_000);
  messages[2] = {
    role: "user",
    content: [{ kind: "tool-result", callId: "call_0", content: "y".repeat(30_000), failed: true }],
  };
  boundRetainedToolResults(messages);
  const first = messages[2].content[0];
  assert.equal(first.kind, "tool-result");
  assert.equal(first.kind === "tool-result" && first.callId, "call_0");
  assert.equal(first.kind === "tool-result" && first.failed, true, "a failure never quietly becomes a success");
});

test("eliding is monotonic, so the cached prefix settles instead of shifting every turn", () => {
  const messages = conversation(24, 30_000);
  assert.equal(boundRetainedToolResults(messages), true);
  const afterFirst = JSON.parse(JSON.stringify(messages)) as TurnMessage[];

  // A few more ordinary exchanges are not enough to reach the high-water mark
  // again, so nothing already sent is rewritten.
  for (let index = 0; index < 3; index += 1) messages.push(...exchange(200 + index, 1_000));
  assert.equal(boundRetainedToolResults(messages), false);
  assert.deepEqual(messages.slice(0, afterFirst.length), afterFirst);
});

test("folding fires far enough below the contract ceiling to keep every request valid", () => {
  // Compaction is what makes the planner's turn bound safe. If these two ever
  // disagree, a long run is refused by the service at its most invested point.
  assert.ok(COMPACTION_TRIGGER_MESSAGES + 2 <= MESSAGE_CEILING);
  assert.ok(RETAINED_EXCHANGES * 2 + 2 < COMPACTION_TRIGGER_MESSAGES);

  const messages = conversation(200);
  let folds = 0;
  for (let turn = 0; turn < 200; turn += 1) {
    if (compactHistory(messages, () => "summary")) folds += 1;
    assert.ok(messages.length <= MESSAGE_CEILING, `turn ${turn} carried ${messages.length} messages`);
    messages.push(...exchange(1_000 + turn));
  }
  assert.ok(folds > 1, "a long run folds more than once");
});

test("evidence with no verdict is reported as recorded rather than as a pass", () => {
  const evidence: RunEvidence[] = [{ id: "e1", kind: "inspection", title: "game.Workspace" }];
  assert.match(describeRunState({ ...SNAPSHOT, evidence }, 4), /inspection game\.Workspace — recorded/);
});

test("a pre-migration task without typed requirements still reports what it needs", () => {
  const tasks: RunTask[] = [{ id: "t1", title: "Old task", status: "done", requiresRuntimeEvidence: true }];
  assert.match(describeRunState({ ...SNAPSHOT, tasks }, 4), /\[done\] Old task \(needs runtime evidence\)/);
});
