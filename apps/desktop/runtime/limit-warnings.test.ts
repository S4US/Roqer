import assert from "node:assert/strict";
import test from "node:test";

import { claudeLimitWarning, codexLimitWarnings, LimitWarnings } from "./limit-warnings";

test("a warning is said once per window in a run, with a reset only while it is ahead", () => {
  const said: Array<[string, string]> = [];
  const now = Date.UTC(2026, 8, 27, 12, 0);
  const warnings = new LimitWarnings("ChatGPT", (label, detail) => said.push([label, detail]), () => now);

  warnings.warn({ window: "5-hour", usedPercent: 84.4, resetsAt: now + 3 * 60 * 60_000 });
  warnings.warn({ window: "5-hour", usedPercent: 92, resetsAt: now + 3 * 60 * 60_000 });
  warnings.warn({ window: "Weekly", usedPercent: 81, resetsAt: now - 1 });

  assert.equal(said.length, 2);
  assert.equal(said[0][0], "Close to your ChatGPT usage limit");
  assert.match(said[0][1], /^5-hour limit: 84% used, resets .+\. The run stops if the limit is reached\.$/);
  assert.equal(said[1][1], "Weekly limit: 81% used. The run stops if the limit is reached.");
});

test("Codex warns from 80% up to a full window, in the bucket ordinary use is metered in", () => {
  const window = (usedPercent: number, minutes: number) => ({ usedPercent, windowDurationMins: minutes, resetsAt: 1_790_000_000 });
  assert.deepEqual(codexLimitWarnings({ primary: window(79, 300), secondary: window(80, 10_080) }), [
    { window: "Weekly", usedPercent: 80, resetsAt: 1_790_000_000_000 },
  ]);
  // A full window is left to the error Codex ends the turn with.
  assert.deepEqual(codexLimitWarnings({ primary: window(100, 300) }), []);
  assert.deepEqual(codexLimitWarnings({ limitId: "codex_other", primary: window(95, 300) }), []);
  assert.deepEqual(codexLimitWarnings("nothing"), []);
});

test("Claude warns only when Claude Code itself says the plan is close", () => {
  assert.equal(claudeLimitWarning({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1_790_000_000 }), null);
  assert.equal(claudeLimitWarning({ status: "rejected", rateLimitType: "five_hour" }), null);
  assert.deepEqual(claudeLimitWarning({ status: "allowed_warning", rateLimitType: "seven_day_opus", resetsAt: 1_790_000_000 }),
    { window: "Weekly Opus", usedPercent: null, resetsAt: 1_790_000_000_000 });
  assert.deepEqual(claudeLimitWarning({ status: "allowed_warning", resetsAt: 1_790_000_000_000 }),
    { window: "Plan", usedPercent: null, resetsAt: 1_790_000_000_000 });
  assert.deepEqual(claudeLimitWarning({ status: "allowed_warning", rateLimitType: "something_new", resetsAt: "soon" }),
    { window: "Plan", usedPercent: null, resetsAt: null });
});
