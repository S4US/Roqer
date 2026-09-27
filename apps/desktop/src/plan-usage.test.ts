import assert from "node:assert/strict";
import test from "node:test";

import { planUsageView } from "./plan-usage";

const NOW = Date.UTC(2026, 8, 27, 12, 0);

test("no report shows no meter, not an empty one", () => {
  assert.equal(planUsageView({ kind: "none" }, "Codex", NOW), null);
  assert.equal(planUsageView({ kind: "reported", observedAt: NOW, windows: [], limitReached: false }, "Codex", NOW), null);
});

test("windows read shortest first, with a reset only while it is ahead", () => {
  const view = planUsageView({
    kind: "reported",
    observedAt: NOW - 5 * 60_000,
    limitReached: false,
    windows: [
      { usedPercent: 83.4, windowMinutes: 10_080, resetsAt: NOW - 60_000 },
      { usedPercent: 42, windowMinutes: 300, resetsAt: Date.UTC(2026, 8, 27, 15, 40) },
    ],
  }, "Codex", NOW, "UTC")!;

  assert.deepEqual(view.rows.map((row) => [row.label, row.percent, row.tone]), [
    ["5-hour limit", 42, "normal"],
    ["Weekly limit", 83, "warning"],
  ]);
  assert.match(view.rows[0].detail, /^42% used · resets 3:40/);
  // The weekly reset has passed with no new report: it is not assumed to have reset.
  assert.equal(view.rows[1].detail, "83% used");
  assert.match(view.footnote, /everywhere you use Codex on this account, as of 11:55/);
  assert.equal(view.reached, false);
});

test("a full window reads as danger and a reached limit is said", () => {
  const view = planUsageView({
    kind: "reported",
    observedAt: NOW,
    limitReached: true,
    windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: null }],
  }, "Codex", NOW, "UTC")!;
  assert.equal(view.rows[0].tone, "danger");
  assert.equal(view.reached, true);
});
