import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REVIEW_DETAIL_CHARS, MAX_REVIEW_FINDINGS, isReviewFinding, parseReviewVerdict, reviewSeverityCounts,
} from "./review";
import { isRunEvent, isRunRecord, isRunReview, RUN_EVENT_SCHEMA_VERSION, type RunReview } from "./run-events";

const block = (value: unknown) => `I read the shop script.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

test("a pass with no findings is a pass", () => {
  assert.deepEqual(parseReviewVerdict(block({ verdict: "pass", summary: "Read Shop and its remote.", findings: [] })), {
    verdict: "passed", summary: "Read Shop and its remote.", findings: [],
  });
});

test("findings are kept most severe first and bounded", () => {
  const findings = [
    { severity: "low", target: "A", detail: "minor" },
    { severity: "high", target: "ServerScriptService.Shop:42", detail: "price comes from the client" },
    { severity: "medium", detail: "debug print left in" },
    ...Array.from({ length: 6 }, (_, index) => ({ severity: "low", detail: `extra ${index}` })),
  ];
  const parsed = parseReviewVerdict(block({ verdict: "issues", findings }));
  assert.equal(parsed.verdict, "issues");
  assert.ok(parsed.verdict === "issues");
  assert.equal(parsed.findings.length, MAX_REVIEW_FINDINGS);
  assert.deepEqual(parsed.findings.slice(0, 2), [
    { severity: "high", target: "ServerScriptService.Shop:42", detail: "price comes from the client" },
    { severity: "medium", detail: "debug print left in" },
  ]);
  assert.ok(parsed.findings.every(isReviewFinding));
});

test("a pass that names a problem is not a pass", () => {
  const parsed = parseReviewVerdict(block({ verdict: "pass", findings: [{ severity: "high", detail: "the door never closes" }] }));
  assert.equal(parsed.verdict, "issues");
});

test("anything the host cannot read as a verdict is incomplete, never a pass", () => {
  for (const reply of [
    "",
    "Looks good to me.",
    "```json\n{not json}\n```",
    block({ verdict: "approved", findings: [] }),
    block({ findings: [] }),
    block(["pass"]),
    // Problems claimed, none readable: nothing to act on, and not a pass.
    block({ verdict: "issues", findings: [] }),
    block({ verdict: "issues", findings: [{ severity: "critical", detail: "x" }] }),
    block({ verdict: "pass", findings: [{ severity: "high" }] }),
  ]) {
    assert.equal(parseReviewVerdict(reply).verdict, "incomplete", reply);
  }
});

test("the verdict is the last object in the reply, fenced or not", () => {
  const earlier = "```json\n{\"verdict\":\"pass\",\"findings\":[]}\n```";
  const later = block({ verdict: "issues", findings: [{ severity: "medium", detail: "second thoughts" }] });
  assert.equal(parseReviewVerdict(`${earlier}\n\nOn reflection:\n${later}`).verdict, "issues");
  assert.equal(parseReviewVerdict("Checked it. {\"verdict\":\"pass\",\"summary\":\"fine\",\"findings\":[]}").verdict, "passed");
  // A script quoted in the reply does not hide the verdict after it.
  assert.equal(
    parseReviewVerdict("The script has `local t = {a = 1}`.\n{\"verdict\":\"pass\",\"findings\":[]}").verdict,
    "passed",
  );
});

test("long text is clipped to the bounds the record validates, not refused", () => {
  const parsed = parseReviewVerdict(block({
    verdict: "issues",
    summary: "s".repeat(5_000),
    findings: [{ severity: "high", target: "t".repeat(2_000), detail: "d".repeat(5_000) }],
  }));
  assert.ok(parsed.verdict === "issues");
  assert.equal(parsed.findings[0].detail.length, MAX_REVIEW_DETAIL_CHARS);
  const review: RunReview = { ...parsed, planner: "test", model: null };
  assert.ok(isRunReview(review));
});

test("severity counts read most severe first", () => {
  assert.equal(reviewSeverityCounts([
    { severity: "low", detail: "a" }, { severity: "high", detail: "b" }, { severity: "low", detail: "c" },
  ]), "1 high, 2 low");
});

test("a stored review must be whole, and its verdict must agree with its findings", () => {
  const finding = { severity: "high" as const, detail: "wrong" };
  assert.ok(isRunReview({ verdict: "passed", findings: [], planner: "claude-code", model: "m" }));
  assert.ok(isRunReview({ verdict: "issues", findings: [finding], summary: "s", planner: "p", model: null }));
  assert.ok(isRunReview({ verdict: "incomplete", findings: [], reason: "stopped", planner: "p", model: null }));
  assert.equal(isRunReview({ verdict: "passed", findings: [finding], planner: "p", model: null }), false);
  assert.equal(isRunReview({ verdict: "issues", findings: [], planner: "p", model: null }), false);
  assert.equal(isRunReview({ verdict: "verified", findings: [], planner: "p", model: null }), false);
  assert.equal(isRunReview({ verdict: "passed", findings: [], model: null }), false);
  assert.equal(isRunReview({ verdict: "issues", findings: [{ severity: "high", detail: "" }], planner: "p", model: null }), false);
  assert.equal(isRunReview({
    verdict: "issues", findings: Array.from({ length: MAX_REVIEW_FINDINGS + 1 }, () => finding), planner: "p", model: null,
  }), false);
  assert.equal(isRunReview({ verdict: "passed", findings: [], planner: "p", model: null, usage: { inputTokens: -1, outputTokens: 0 } }), false);
});

test("a review travels on run-completed and is kept on the run record", () => {
  const review: RunReview = { verdict: "issues", findings: [{ severity: "low", detail: "Not checked: needs a playtest" }], planner: "p", model: "m" };
  const completed = {
    runId: "run-1", seq: 3, at: "2026-11-10T00:00:00.000Z", type: "run-completed",
    outcome: "completed", summary: "done", verification: { verified: true, issues: [] },
  };
  assert.ok(isRunEvent({ ...completed, review }));
  assert.equal(isRunEvent({ ...completed, review: { ...review, verdict: "passed" } }), false);

  const record = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION, runId: "run-1", planner: "p", approvalMode: "Ask first", outcome: "completed",
    startedAt: "2026-11-10T00:00:00.000Z", finishedAt: "2026-11-10T00:00:01.000Z",
    toolCalls: [], changes: [], evidence: [], failures: [],
  };
  assert.ok(isRunRecord(record), "a record from before the review pass still validates");
  assert.ok(isRunRecord({ ...record, review }));
  assert.equal(isRunRecord({ ...record, review: { verdict: "passed" } }), false);
});
