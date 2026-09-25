import assert from "node:assert/strict";
import test from "node:test";

import { providerCard } from "./provider-card";

test("a subscription card names the plan once and the app it runs through", () => {
  const claude = providerCard("claude", { kind: "signed-in", message: "Pro connected through Claude Code", planType: "pro" }, true);
  assert.deepEqual(claude, { title: "Claude Pro", detail: "Through Claude Code" });
  assert.deepEqual(providerCard("chatgpt", { kind: "signed-in", message: "Plus connected through Codex", planType: "plus" }, true),
    { title: "ChatGPT Plus", detail: "Through Codex" });
  assert.deepEqual(providerCard("claude", { kind: "signed-in", message: "Claude connected through Claude Code" }, true),
    { title: "Claude", detail: "Through Claude Code" });
});

test("your own models say what is set up, and a signed-out card says what to do", () => {
  assert.deepEqual(providerCard("custom", { kind: "signed-in", message: "2 connections, 2 models", planType: "Your endpoint" }, true),
    { title: "Your own models", detail: "2 connections, 2 models" });
  assert.deepEqual(providerCard("claude", { kind: "signed-out", message: "Connect Claude in Settings." }, true),
    { title: "Studio access", detail: "Connect Claude in Settings.", badge: "Local" });
  assert.equal(providerCard("claude", { kind: "signed-out", message: "x" }, false).badge, "Demo");
});
