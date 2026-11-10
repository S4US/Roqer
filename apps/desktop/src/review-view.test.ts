import assert from "node:assert/strict";
import test from "node:test";

import type { RunReview } from "../shared/run-events";
import { reviewByline, reviewFixPrompt, reviewTitle } from "./review-view";

const base = { planner: "claude-code", model: "Claude Sonnet" };
const issues: RunReview = {
  ...base,
  verdict: "issues",
  findings: [
    { severity: "high", target: "ServerScriptService.Shop:42", detail: "The price comes from the client." },
    { severity: "low", detail: "Not checked: buying needs a playtest." },
  ],
};

test("a review's title says what it found, and never that anything was verified", () => {
  assert.equal(reviewTitle(issues), "Review found 2 problems (1 high, 1 low)");
  assert.equal(reviewTitle({ ...issues, findings: [issues.findings[0]] }), "Review found 1 problem (1 high)");
  assert.equal(reviewTitle({ ...base, verdict: "passed", findings: [] }), "Review found no problems");
  assert.equal(reviewTitle({ ...base, verdict: "incomplete", findings: [], reason: "stopped" }), "Review did not finish");
  for (const review of [issues, { ...base, verdict: "passed" as const, findings: [] }]) {
    assert.doesNotMatch(reviewTitle(review), /verif/i);
  }
});

test("the byline names the reviewer and says the review is an opinion", () => {
  assert.match(reviewByline(issues), /A second pass by Claude Sonnet, which could only read your place\./);
  assert.match(reviewByline(issues), /opinion; Roqer did not verify it/);
  assert.match(reviewByline({ ...issues, model: null }), /by the same model/);
});

test("the findings become a message the user can send, numbered and asking for a check first", () => {
  assert.equal(reviewFixPrompt(issues), [
    "A review of your last run found these problems. Check each one in Studio, fix the ones that are real, and say which were not:",
    "1. [high] ServerScriptService.Shop:42: The price comes from the client.",
    "2. [low] Not checked: buying needs a playtest.",
  ].join("\n"));
});
