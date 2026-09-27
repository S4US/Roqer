import assert from "node:assert/strict";
import test from "node:test";

import { formatResetTime, isProviderLimits, usageWindowLabel } from "./provider-limits";

test("only well-formed usage reaches the renderer", () => {
  const window = { usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_000_000 };
  assert.equal(isProviderLimits({ kind: "none" }), true);
  assert.equal(isProviderLimits({ kind: "reported", observedAt: 1, windows: [window], limitReached: false }), true);
  assert.equal(isProviderLimits({ kind: "reported", observedAt: 1, windows: [{ ...window, windowMinutes: null, resetsAt: null }], limitReached: true }), true);
  assert.equal(isProviderLimits({ kind: "reported", observedAt: 1, windows: [{ ...window, usedPercent: 140 }], limitReached: false }), false);
  assert.equal(isProviderLimits({ kind: "reported", observedAt: 1, windows: [{ ...window, usedPercent: Number.NaN }], limitReached: false }), false);
  assert.equal(isProviderLimits({ kind: "reported", observedAt: 1, windows: Array(9).fill(window), limitReached: false }), false);
  assert.equal(isProviderLimits({ kind: "reported", windows: [window], limitReached: false }), false);
  assert.equal(isProviderLimits({ kind: "estimated" }), false);
});

test("a window is named by its length", () => {
  assert.equal(usageWindowLabel(300), "5-hour");
  assert.equal(usageWindowLabel(10_080), "Weekly");
  assert.equal(usageWindowLabel(1_440), "1-day");
  assert.equal(usageWindowLabel(90), "90-minute");
  assert.equal(usageWindowLabel(null), "Usage");
});

test("a reset time says which day once it is not today", () => {
  const now = Date.UTC(2026, 8, 27, 12, 0);
  const soon = formatResetTime(Date.UTC(2026, 8, 27, 15, 40), now, "UTC");
  const later = formatResetTime(Date.UTC(2026, 8, 30, 9, 0), now, "UTC");
  const far = formatResetTime(Date.UTC(2026, 9, 20, 9, 0), now, "UTC");
  assert.match(soon, /3:40/);
  assert.doesNotMatch(soon, /Sep|Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  assert.match(later, /Wed/);
  assert.match(far, /Oct/);
});
