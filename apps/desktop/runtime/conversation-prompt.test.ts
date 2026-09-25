import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationPrompt, buildFollowUpPrompt, continuesConversation } from "./conversation-prompt";
import { MAX_CONVERSATION_MESSAGE_CHARS } from "../shared/conversation";

const EXCHANGE = {
  messages: [
    { role: "user" as const, text: "Earlier." },
    { role: "assistant" as const, text: "Earlier answer." },
    { role: "user" as const, text: "Build the shop." },
    { role: "assistant" as const, text: "Built." },
  ],
  truncated: false,
};

test("a kept session continues a chat whose newest exchange is the one it ran", () => {
  assert.equal(continuesConversation(EXCHANGE, "Build the shop."), true);
  // Attachment text is appended to the prompt the planner receives, not to the
  // words the chat records.
  assert.equal(continuesConversation(EXCHANGE, "Build the shop.\n\n[Attached file: shop.lua]"), true);
});

test("a kept session is stale when another exchange came after it", () => {
  assert.equal(continuesConversation(EXCHANGE, "Earlier."), false);
  assert.equal(continuesConversation(EXCHANGE, "Build the shop, and more."), false);
  assert.equal(continuesConversation({ messages: [], truncated: false }, "Build the shop."), false);
  assert.equal(continuesConversation({
    messages: [{ role: "user", text: "Build the shop." }], truncated: false,
  }, "Build the shop."), false, "an exchange with no reply did not finish");
});

test("a prompt the transcript bound shortened is matched on what it kept", () => {
  const long = "x".repeat(MAX_CONVERSATION_MESSAGE_CHARS + 100);
  const kept = `${long.slice(0, MAX_CONVERSATION_MESSAGE_CHARS - 1)}…`;
  assert.equal(continuesConversation({
    messages: [{ role: "user", text: kept }, { role: "assistant", text: "Done." }], truncated: true,
  }, long), true);
});

test("a follow-up to a kept session sends the prompt, not the transcript", () => {
  const prompt = buildFollowUpPrompt(EXCHANGE, "Now add a buy button.");
  assert.equal(prompt, "Now add a buy button.");
});

test("a follow-up carries Roqer's verdict on the previous run, which the model never saw", () => {
  const prompt = buildFollowUpPrompt({
    messages: [
      { role: "user", text: "Build the shop." },
      {
        role: "assistant",
        text: "Built.",
        run: { outcome: "completed", changes: [], unfinished: [], unverified: ["No playtest ran."], decisions: [] },
      },
    ],
    truncated: false,
  }, "Continue.");
  assert.match(prompt, /^\[Roqer's record of your previous run in this chat \(outcome: completed\)\.\]/);
  assert.match(prompt, /Left unverified:\n- No playtest ran\./);
  assert.match(prompt, /Current user message:\nContinue\.$/);
  assert.equal(prompt.includes("Build the shop."), false);
});

test("a follow-up keeps the UI-design route", () => {
  assert.match(buildFollowUpPrompt(EXCHANGE, "Make a stud themed potion shop"), /Roqer host route/);
});

test("a follow-up whose conversation still holds the UI skill is not told to load it again", () => {
  const asked: string[] = [];
  const prompt = buildFollowUpPrompt(EXCHANGE, "Make the shop panel wider", (name) => {
    asked.push(name);
    return true;
  });
  assert.deepEqual(asked, ["roblox-ui-design"]);
  assert.match(prompt, /Roqer host route: this request is UI-design work/);
  assert.match(prompt, /`roblox-ui-design` is already loaded in this conversation/);
  assert.doesNotMatch(prompt, /Load `roblox-ui-design` before/);
  assert.match(prompt, /Make the shop panel wider$/);

  const forgotten = buildFollowUpPrompt(EXCHANGE, "Make the shop panel wider", () => false);
  assert.match(forgotten, /Load `roblox-ui-design` before any Studio mutation/);
});

test("an empty non-UI conversation returns the current prompt byte-for-byte", () => {
  const prompt = "  Keep this spacing\nexactly as written.  ";
  assert.equal(buildConversationPrompt({ messages: [], truncated: false }, prompt), prompt);
});

test("clear UI design work receives the deterministic host route", () => {
  const prompt = buildConversationPrompt({ messages: [], truncated: false }, "Make a stud themed potion shop");
  assert.match(prompt, /Roqer host route: this request is UI-design work/);
  assert.match(prompt, /load `roblox-ui-design` before any Studio mutation/i);
  assert.match(prompt, /recovered active-theme parts .* `references\/selected\/<theme>\/<layout>\.md`/i);
  assert.match(prompt, /Make a stud themed potion shop$/);
});

test("non-design shop behavior does not get the visual route merely for saying shop", () => {
  const prompt = "Why does my shop purchase handler deduct the wrong amount?";
  assert.equal(buildConversationPrompt({ messages: [], truncated: false }, prompt), prompt);
});

test("a truncated conversation tells the provider that older context is missing", () => {
  const prompt = buildConversationPrompt({
    messages: [{ role: "assistant", text: "The latest answer." }],
    truncated: true,
  }, "Continue from there.");
  assert.match(prompt, /older messages .* omitted/i);
  assert.match(prompt, /Assistant:\nThe latest answer\./);
  assert.match(prompt, /Current user message:\nContinue from there\./);
});

test("a reply that came from a run carries the host's record of it", () => {
  const prompt = buildConversationPrompt({
    messages: [
      { role: "user", text: "Build the shop." },
      {
        role: "assistant",
        text: "The shop is built; the buy button still needs wiring.",
        run: {
          outcome: "completed",
          changes: ["script-source game.ServerScriptService.Shop at revision rev-8"],
          unfinished: ["[pending] Wire the buy button"],
          unverified: ["\"Wire the buy button\" was still open when the run ended."],
          decisions: [{ question: "Which currency should the shop charge?", answer: "Coins" }],
        },
      },
    ],
    truncated: false,
  }, "Continue.");

  const record = prompt.slice(prompt.indexOf("[Roqer's record"), prompt.indexOf("Current user message"));
  assert.match(record, /\(outcome: completed\)/);
  assert.match(record, /Changes it applied:\n- script-source game\.ServerScriptService\.Shop at revision rev-8/);
  assert.match(record, /Tasks not done when it ended:\n- \[pending\] Wire the buy button/);
  assert.match(record, /Left unverified:\n- "Wire the buy button" was still open/);
  assert.match(record, /Decisions the user made when asked:\n- Which currency should the shop charge\? → Coins/);
  assert.ok(prompt.indexOf("still needs wiring.") < prompt.indexOf("[Roqer's record"));
  assert.match(record, /read Studio before changing anything/);
});

test("a reply without a run renders exactly as it did before records existed", () => {
  const prompt = buildConversationPrompt({
    messages: [{ role: "assistant", text: "Just an answer." }],
    truncated: false,
  }, "Next.");
  assert.equal(prompt.includes("Roqer's record"), false);
  assert.match(prompt, /Assistant:\nJust an answer\.\n\nCurrent user message:\nNext\./);
});
