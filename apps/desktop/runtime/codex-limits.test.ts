import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerNotification } from "./codex-app-server";
import { CodexLimitsTracker, parseCodexRateLimitSnapshot } from "./codex-limits";

const SNAPSHOT = {
  limitId: "codex",
  primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_790_000_000 },
  secondary: { usedPercent: 12.6, windowDurationMins: 10_080, resetsAt: 1_790_500_000 },
  rateLimitReachedType: null,
};

function fakeSource(respond: (method: string, params: unknown) => unknown) {
  const requests: Array<{ method: string; params: unknown }> = [];
  let listener: ((notification: AppServerNotification) => void) | null = null;
  return {
    requests,
    push: (params: Record<string, unknown>) => listener?.({ method: "account/rateLimits/updated", params }),
    source: {
      request: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        return respond(method, params);
      },
      subscribe: (next: (notification: AppServerNotification) => void) => {
        listener = next;
        return () => { listener = null; };
      },
    },
  };
}

test("a Codex snapshot keeps both windows, in milliseconds, and drops what it cannot read", () => {
  assert.deepEqual(parseCodexRateLimitSnapshot(SNAPSHOT), {
    limitId: "codex",
    windows: [
      { usedPercent: 42, windowMinutes: 300, resetsAt: 1_790_000_000_000 },
      { usedPercent: 12.6, windowMinutes: 10_080, resetsAt: 1_790_500_000_000 },
    ],
    limitReached: false,
  });
  assert.deepEqual(parseCodexRateLimitSnapshot({ primary: { usedPercent: 104, windowDurationMins: null, resetsAt: null }, secondary: "x", rateLimitReachedType: "rateLimitReached" }), {
    limitId: null,
    windows: [{ usedPercent: 100, windowMinutes: null, resetsAt: null }],
    limitReached: true,
  });
  assert.equal(parseCodexRateLimitSnapshot({ primary: null, secondary: null }), null);
  assert.equal(parseCodexRateLimitSnapshot("limits"), null);
});

test("the tracker asks Codex at most once a minute and says when it last heard", async () => {
  let now = 1_000;
  const fake = fakeSource(() => ({ rateLimits: SNAPSHOT, ordinaryUsageAllowed: true }));
  const tracker = new CodexLimitsTracker({ source: fake.source, now: () => now });

  const first = await tracker.read();
  assert.equal(first.kind, "reported");
  assert.equal(first.kind === "reported" ? first.observedAt : null, 1_000);
  // `null`: older app-servers accept only that for this method.
  assert.deepEqual(fake.requests, [{ method: "account/rateLimits/read", params: null }]);

  now = 50_000;
  await tracker.read();
  assert.equal(fake.requests.length, 1);
  now = 62_000;
  await tracker.read();
  assert.equal(fake.requests.length, 2);
});

test("the backend's verdict on ordinary use marks the limit reached", async () => {
  const fake = fakeSource(() => ({ rateLimits: SNAPSHOT, ordinaryUsageAllowed: false }));
  const limits = await new CodexLimitsTracker({ source: fake.source }).read();
  assert.equal(limits.kind === "reported" ? limits.limitReached : null, true);
});

test("updates Codex pushes replace the meter, but not from another model's bucket", async () => {
  let now = 1_000;
  const fake = fakeSource(() => ({ rateLimits: SNAPSHOT }));
  const tracker = new CodexLimitsTracker({ source: fake.source, now: () => now });
  await tracker.read();

  now = 2_000;
  fake.push({ rateLimits: { ...SNAPSHOT, limitId: "codex_other", primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null } } });
  let limits = await tracker.read();
  assert.equal(limits.kind === "reported" ? limits.windows[0].usedPercent : null, 42);

  fake.push({ rateLimits: { ...SNAPSHOT, primary: { usedPercent: 57, windowDurationMins: 300, resetsAt: null } } });
  limits = await tracker.read();
  assert.equal(limits.kind === "reported" ? limits.windows[0].usedPercent : null, 57);
  assert.equal(limits.kind === "reported" ? limits.observedAt : null, 2_000);
  assert.equal(fake.requests.length, 1);
});

test("a failed read keeps the last report, and nothing is invented without one", async () => {
  let now = 0;
  let fail = true;
  const fake = fakeSource(() => {
    if (fail) throw new Error("Method not found");
    return { rateLimits: SNAPSHOT };
  });
  const tracker = new CodexLimitsTracker({ source: fake.source, now: () => now });
  assert.deepEqual(await tracker.read(), { kind: "none" });

  fail = false;
  now = 60_000;
  assert.equal((await tracker.read()).kind, "reported");
  fail = true;
  now = 120_000;
  const kept = await tracker.read();
  assert.equal(kept.kind === "reported" ? kept.observedAt : null, 60_000);
});

test("forgetting drops the report, and a read already under way cannot restore it", async () => {
  let release: (value: unknown) => void = () => undefined;
  const fake = fakeSource(() => new Promise((resolve) => { release = resolve; }));
  const tracker = new CodexLimitsTracker({ source: fake.source });

  const reading = tracker.read();
  await new Promise((resolve) => setImmediate(resolve));
  tracker.forget();
  release({ rateLimits: SNAPSHOT });
  assert.deepEqual(await reading, { kind: "none" });
});
