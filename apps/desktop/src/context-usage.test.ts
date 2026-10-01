import assert from "node:assert/strict";
import test from "node:test";

import { compactTokenCount, contextMeterView, nextContextReading, type ContextReading } from "./context-usage";

const OBSERVED = Date.UTC(2026, 9, 1, 14, 5);
const reading = (overrides: Partial<ContextReading> = {}): ContextReading => ({
  provider: "claude", model: "claude-opus-5-5", usedTokens: 68_412, windowTokens: 200_000, observedAt: OBSERVED, ...overrides,
});
const NEXT = { provider: "claude" as const, model: "claude-opus-5-5" };

test("token counts are short enough for the toolbar", () => {
  assert.equal(compactTokenCount(950), "950");
  assert.equal(compactTokenCount(68_412), "68.4k");
  assert.equal(compactTokenCount(131_588), "132k");
  assert.equal(compactTokenCount(200_000), "200k");
  assert.equal(compactTokenCount(1_000_000), "1M");
  assert.equal(compactTokenCount(1_250_000), "1.3M");
});

test("a chat with nothing reported says so instead of guessing", () => {
  const none = contextMeterView(undefined, NEXT, "UTC");
  assert.equal(none.kind, "none");
  assert.match(none.kind === "none" ? none.message : "", /Nothing reported in this chat yet/);

  // A reading for another model is a share of another window.
  const other = contextMeterView(reading({ model: "claude-sonnet-5-5" }), NEXT, "UTC");
  assert.equal(other.kind, "none");
  assert.match(other.kind === "none" ? other.message : "", /for this model/);
  assert.equal(contextMeterView(reading(), { provider: "chatgpt", model: "claude-opus-5-5" }, "UTC").kind, "none");
});

test("a reported reading shows the share used, quietly until it is worth noticing", () => {
  const calm = contextMeterView(reading(), NEXT, "UTC");
  assert.equal(calm.kind, "reported");
  if (calm.kind !== "reported") return;
  assert.equal(calm.percent, 34);
  assert.equal(calm.tone, "normal");
  assert.equal(calm.label, "34%");
  assert.equal(calm.summary, "68.4k of 200k tokens");
  assert.equal(calm.left, "132k left");
  assert.equal(calm.usedTokens, "68,412");
  assert.equal(calm.windowTokens, "200,000");
  assert.equal(calm.advice, null);
  assert.equal(calm.ariaLabel, "Context: 34% used, 132k tokens left");
  assert.equal(calm.footnote, "Reported by Claude Code at 2:05 PM. Claude Code summarises older messages on its own as the window fills.");

  const warning = contextMeterView(reading({ usedTokens: 156_000 }), NEXT, "UTC");
  assert.equal(warning.kind === "reported" && warning.tone, "warning");
  assert.equal(warning.kind === "reported" && warning.label, "78%");
  assert.match(warning.kind === "reported" ? warning.advice ?? "" : "", /fresh chat/);

  // Near the end it counts what is left, which is the number that matters then.
  const danger = contextMeterView(reading({ usedTokens: 188_000 }), NEXT, "UTC");
  assert.equal(danger.kind === "reported" && danger.tone, "danger");
  assert.equal(danger.kind === "reported" && danger.label, "6% left");

  const over = contextMeterView(reading({ usedTokens: 230_000 }), NEXT, "UTC");
  assert.equal(over.kind === "reported" && over.percent, 100);
  assert.equal(over.kind === "reported" && over.left, "0 left");
});

test("without a reported window the meter shows tokens in use and claims no share", () => {
  const view = contextMeterView(reading({ windowTokens: null }), NEXT, "UTC");
  assert.equal(view.kind, "reported");
  if (view.kind !== "reported") return;
  assert.equal(view.percent, null);
  assert.equal(view.tone, "normal");
  assert.equal(view.label, "68.4k");
  assert.equal(view.summary, "68.4k tokens");
  assert.equal(view.left, null);
  assert.equal(view.windowTokens, null);
  assert.match(view.footnote, /has not said how large this model's window is/);

  const custom = contextMeterView(reading({ provider: "custom", model: "qwen", windowTokens: null }), { provider: "custom", model: "qwen" }, "UTC");
  assert.match(custom.kind === "reported" ? custom.footnote : "", /^Reported by your endpoint at 2:05 PM\. Set this model's context window in Settings/);
});

test("a report without a window keeps the one the same model reported before", () => {
  const earlier = reading();
  const mid = reading({ usedTokens: 70_000, windowTokens: null, observedAt: OBSERVED + 1_000 });
  assert.deepEqual(nextContextReading(earlier, mid), { ...mid, windowTokens: 200_000 });
  assert.deepEqual(nextContextReading(undefined, mid), mid);
  // Another model's window is not this one's.
  const switched = { ...mid, model: "claude-sonnet-5-5" };
  assert.deepEqual(nextContextReading(earlier, switched), switched);
  // A newly reported window replaces the old one.
  const bigger = reading({ windowTokens: 1_000_000 });
  assert.deepEqual(nextContextReading(earlier, bigger), bigger);
});
