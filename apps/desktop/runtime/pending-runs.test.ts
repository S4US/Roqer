import assert from "node:assert/strict";
import test from "node:test";
import { PendingRuns } from "./pending-runs";

test("closing a window during preparation prevents the deferred run from starting", async () => {
  const starts = new PendingRuns();
  const pending = starts.begin(1, "start-1");
  let release!: () => void;
  const preparation = new Promise<void>((resolve) => { release = resolve; });
  let executed = false;
  const run = (async () => {
    await preparation;
    if (!pending.signal.aborted) executed = true;
    pending.finish();
  })();
  starts.cancelOwner(1);
  release();
  await run;
  assert.equal(executed, false);
});

test("stop targets only the matching owner's pending request", () => {
  const starts = new PendingRuns();
  const first = starts.begin(1, "a");
  const other = starts.begin(2, "a");
  starts.cancel(1, "a");
  assert.equal(first.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  first.finish();
  const next = starts.begin(1, "a");
  first.finish();
  starts.cancelAll();
  assert.equal(next.signal.aborted, true);
  assert.equal(other.signal.aborted, true);
});

test("a duplicate pending id cannot replace a cancellable request", () => {
  const starts = new PendingRuns();
  const pending = starts.begin(1, "a");
  assert.throws(() => starts.begin(1, "a"), /already starting/);
  starts.cancel(1, "a");
  assert.equal(pending.signal.aborted, true);
});
