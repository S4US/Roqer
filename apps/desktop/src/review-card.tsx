import React, { createContext, useContext } from "react";
import { AlertCircle, Check, CornerDownLeft, SearchCheck } from "lucide-react";
import type { RunReview } from "../shared/run-events";
import { REVIEW_SEVERITY_LABEL, reviewByline, reviewFixPrompt, reviewTitle } from "./review-view";
import { usageLabel } from "./run-view";

/**
 * Puts text in the message box for the user to send. Provided by the app
 * around the conversation; absent, the card offers no way to act on findings.
 */
export const PromptDraftContext = createContext<((text: string) => void) | null>(null);

/**
 * What the review pass said about a finished run.
 *
 * Kept apart from the outcome line and the gate's issues above it, and
 * worded as an opinion throughout, so "Applied and verified" keeps meaning
 * what the host checked and nothing a model said.
 */
export function ReviewCard({ review, latest }: { review: RunReview; latest: boolean }) {
  const draftPrompt = useContext(PromptDraftContext);
  return <section className="run-review" data-verdict={review.verdict} aria-label="Review of this run">
    <p className="run-review-title">
      {review.verdict === "passed"
        ? <Check size={14} aria-hidden="true" />
        : review.verdict === "issues" ? <SearchCheck size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}
      <strong>{reviewTitle(review)}</strong>
    </p>
    <p className="run-review-byline">{reviewByline(review)}</p>
    {review.summary !== undefined && <p className="run-review-summary">{review.summary}</p>}
    {review.reason !== undefined && <p className="run-review-summary">{review.reason}</p>}
    {review.findings.length > 0 && <ol className="run-review-findings">
      {review.findings.map((finding, index) => <li key={index}>
        <span className="run-review-severity" data-severity={finding.severity}>{REVIEW_SEVERITY_LABEL[finding.severity]}</span>
        {finding.target !== undefined && <code>{finding.target}</code>}
        <span className="run-review-detail">{finding.detail}</span>
      </li>)}
    </ol>}
    {latest && review.verdict === "issues" && draftPrompt !== null && <button
      type="button"
      className="secondary-action run-review-action"
      onClick={() => draftPrompt(reviewFixPrompt(review))}
    ><CornerDownLeft size={13} aria-hidden="true" /> Put these in the message box</button>}
    {review.usage !== undefined && <p className="run-review-usage">Review: {usageLabel(review.usage).replace(/^Used /, "used ")}</p>}
  </section>;
}
