import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeLimitsTracker, parseClaudeUsage } from "./claude-limits";

const USAGE = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 38, resets_at: "2026-09-27T15:40:00Z" },
    seven_day: { utilization: 71.5, resets_at: "2026-09-30T09:00:00Z" },
    seven_day_opus: { utilization: 90, resets_at: "2026-09-30T09:00:00Z" },
  },
};

test("the five-hour and weekly windows are read from get_usage, times in milliseconds", () => {
  assert.deepEqual(parseClaudeUsage(USAGE), {
    windows: [
      { usedPercent: 38, windowMinutes: 300, resetsAt: Date.UTC(2026, 8, 27, 15, 40) },
      { usedPercent: 71.5, windowMinutes: 10_080, resetsAt: Date.UTC(2026, 8, 30, 9, 0) },
    ],
    limitReached: false,
  });
});

test("anything get_usage does not document reads as nothing, not as a guess", () => {
  // Plan limits do not apply to an API key or a cloud provider.
  assert.equal(parseClaudeUsage({ rate_limits_available: false, rate_limits: null }), null);
  assert.equal(parseClaudeUsage({ rate_limits_available: true, rate_limits: null }), null);
  // A reshaped answer, such as a list of rows, is not read.
  assert.equal(parseClaudeUsage({ rate_limits_available: true, rate_limits: { limits: [{ kind: "session", percent: 40 }] } }), null);
  assert.equal(parseClaudeUsage("usage"), null);
  assert.deepEqual(parseClaudeUsage({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 104, resets_at: "soon" } },
  }), { windows: [{ usedPercent: 100, windowMinutes: 10_080, resetsAt: null }], limitReached: false });
});

test("Claude Code is asked at most every five minutes, and a failed read keeps the last report", async () => {
  let now = 0;
  let reads = 0;
  let answer: () => unknown = () => USAGE;
  const tracker = new ClaudeLimitsTracker({ source: { readUsage: async () => { reads += 1; return answer(); } }, now: () => now });

  const first = await tracker.read();
  assert.equal(first.kind === "reported" ? first.windows.length : null, 2);
  now = 4 * 60_000;
  await tracker.read();
  assert.equal(reads, 1);

  answer = () => { throw new Error("Unknown control request subtype: get_usage"); };
  now = 5 * 60_000;
  const kept = await tracker.read();
  assert.equal(reads, 2);
  assert.equal(kept.kind === "reported" ? kept.observedAt : null, 0);

  tracker.forget();
  assert.deepEqual(await tracker.read(), { kind: "none" });
});
