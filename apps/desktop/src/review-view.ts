import { reviewSeverityCounts, type ReviewSeverity } from "../shared/review";
import type { RunReview } from "../shared/run-events";

/**
 * How a review reads in the chat.
 *
 * Every line here says "review", never "verified": a review is a second
 * model's opinion, and the words for what the host checked stay the gate's.
 */

export const REVIEW_SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** "Review found 2 problems (1 high, 1 low)", "Review found no problems", "Review did not finish". */
export function reviewTitle(review: RunReview): string {
  if (review.verdict === "incomplete") return "Review did not finish";
  if (review.verdict === "passed") return "Review found no problems";
  const count = review.findings.length;
  return `Review found ${count} ${count === 1 ? "problem" : "problems"} (${reviewSeverityCounts(review.findings)})`;
}

/** Who reviewed, and what a review is worth: shown under every title. */
export function reviewByline(review: RunReview): string {
  const reviewer = review.model === null || review.model === "" ? "the same model" : review.model;
  return `A second pass by ${reviewer}, which could only read your place. This is its opinion; Roqer did not verify it.`;
}

/**
 * The findings as a message the user can send, edit first, or throw away.
 *
 * It goes into the message box and nowhere else: sending it is the user's own
 * act, so the reviewer's words reach the next run only as a prompt the user
 * read and chose to send.
 */
export function reviewFixPrompt(review: RunReview): string {
  return [
    "A review of your last run found these problems. Check each one in Studio, fix the ones that are real, and say which were not:",
    ...review.findings.map((finding, index) =>
      `${index + 1}. [${finding.severity}] ${finding.target === undefined ? "" : `${finding.target}: `}${finding.detail}`),
  ].join("\n");
}
