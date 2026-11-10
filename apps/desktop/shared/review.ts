/**
 * The review pass: a second model's opinion of a finished run.
 *
 * The completion gate checks what the host can observe: that a write was read
 * back, that promised evidence exists, that an interface audit came back
 * clean. It cannot say whether the result does what the user asked. A review
 * is a separate model run, read-only, that is given the host's record of the
 * run and answers that question.
 *
 * A review is an opinion, never a fact the host verified, so it is kept apart
 * from the gate's verdict everywhere: its own field, its own card. It can
 * only ever add a doubt. A reply the host cannot read as a verdict is
 * `incomplete`, never `passed`.
 */

export type ReviewSeverity = "high" | "medium" | "low";

export type ReviewFinding = {
  severity: ReviewSeverity;
  /** Where the problem is: a script path and line, an instance path, a screenshot. */
  target?: string;
  /** What is wrong and what the reviewer saw that shows it. */
  detail: string;
};

/**
 * - `passed`      the reviewer checked the result and named nothing wrong.
 * - `issues`      the reviewer named at least one finding.
 * - `incomplete`  the review did not produce a verdict the host could read:
 *                 it was stopped, it failed, or its reply was not a verdict.
 */
export type ReviewVerdict = "passed" | "issues" | "incomplete";

export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["high", "medium", "low"];
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["passed", "issues", "incomplete"];

/** The most findings one review keeps: a review is a short list to act on, not an audit. */
export const MAX_REVIEW_FINDINGS = 5;
export const MAX_REVIEW_TARGET_CHARS = 300;
export const MAX_REVIEW_DETAIL_CHARS = 600;
export const MAX_REVIEW_SUMMARY_CHARS = 600;
export const MAX_REVIEW_REASON_CHARS = 300;

/** How much of a reviewer's reply is searched for its verdict, from the end. */
const MAX_VERDICT_SEARCH_CHARS = 24_000;
/** How many places in a reply are tried as the start of a verdict. */
const MAX_VERDICT_CANDIDATES = 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isReviewFinding(value: unknown): value is ReviewFinding {
  return isRecord(value) &&
    REVIEW_SEVERITIES.includes(value.severity as ReviewSeverity) &&
    (value.target === undefined ||
      (typeof value.target === "string" && value.target.length > 0 && value.target.length <= MAX_REVIEW_TARGET_CHARS)) &&
    typeof value.detail === "string" && value.detail.length > 0 && value.detail.length <= MAX_REVIEW_DETAIL_CHARS;
}

/** What a reviewer's reply said, once the host has read it. */
export type ParsedReview =
  | { verdict: "passed"; summary?: string; findings: [] }
  | { verdict: "issues"; summary?: string; findings: ReviewFinding[] }
  | { verdict: "incomplete"; reason: string };

function clip(text: string, limit: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Every JSON object a reply might end with, most likely first: fenced blocks
 * from the last backwards, then the reply's tail from each opening brace.
 */
function verdictCandidates(reply: string): string[] {
  const text = reply.length <= MAX_VERDICT_SEARCH_CHARS ? reply : reply.slice(-MAX_VERDICT_SEARCH_CHARS);
  const fenced = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((match) => match[1]).reverse();
  const end = text.lastIndexOf("}");
  const tails: string[] = [];
  if (end !== -1) {
    for (let index = text.lastIndexOf("{", end); index !== -1 && tails.length < MAX_VERDICT_CANDIDATES; index = text.lastIndexOf("{", index - 1)) {
      tails.push(text.slice(index, end + 1));
      if (index === 0) break;
    }
  }
  return [...fenced, ...tails].slice(0, MAX_VERDICT_CANDIDATES);
}

function parseFinding(value: unknown): ReviewFinding | undefined {
  if (!isRecord(value) || typeof value.detail !== "string" || value.detail.trim() === "") return undefined;
  if (!REVIEW_SEVERITIES.includes(value.severity as ReviewSeverity)) return undefined;
  const target = typeof value.target === "string" && value.target.trim() !== ""
    ? clip(value.target, MAX_REVIEW_TARGET_CHARS)
    : undefined;
  return {
    severity: value.severity as ReviewSeverity,
    ...(target === undefined ? {} : { target }),
    detail: clip(value.detail, MAX_REVIEW_DETAIL_CHARS),
  };
}

/**
 * Read a reviewer's reply as a verdict.
 *
 * The reply must carry one JSON object with `verdict` ("pass" or "issues"),
 * an optional `summary`, and `findings`. Everything about it fails closed:
 * - no readable object, or an unknown verdict, is `incomplete`;
 * - "pass" beside findings is `issues`, since a named problem is a problem;
 * - "issues" with no usable finding is `incomplete`, since there is nothing
 *   to act on and calling it a pass would be the host's invention.
 * Text is clipped to the bounds above rather than refused, and the findings
 * are kept most severe first, up to `MAX_REVIEW_FINDINGS`.
 */
export function parseReviewVerdict(reply: string): ParsedReview {
  for (const candidate of verdictCandidates(reply)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isRecord(value) || typeof value.verdict !== "string") continue;
    const verdict = value.verdict.trim().toLowerCase();
    if (verdict !== "pass" && verdict !== "passed" && verdict !== "issues") continue;

    const listed = Array.isArray(value.findings) ? value.findings : [];
    const findings = listed
      .map(parseFinding)
      .filter((finding): finding is ReviewFinding => finding !== undefined)
      .sort((left, right) => REVIEW_SEVERITIES.indexOf(left.severity) - REVIEW_SEVERITIES.indexOf(right.severity))
      .slice(0, MAX_REVIEW_FINDINGS);
    const summary = typeof value.summary === "string" && value.summary.trim() !== ""
      ? clip(value.summary, MAX_REVIEW_SUMMARY_CHARS)
      : undefined;
    const withSummary = summary === undefined ? {} : { summary };

    if (findings.length > 0) return { verdict: "issues", ...withSummary, findings };
    if (verdict === "issues" || listed.length > 0) {
      return { verdict: "incomplete", reason: "The reviewer reported problems but named none Roqer could read." };
    }
    return { verdict: "passed", ...withSummary, findings: [] };
  }
  return { verdict: "incomplete", reason: "The reviewer's reply did not end with a verdict Roqer could read." };
}

/** "1 high, 2 low": how many findings of each severity, most severe first. */
export function reviewSeverityCounts(findings: readonly ReviewFinding[]): string {
  return REVIEW_SEVERITIES
    .map((severity) => ({ severity, count: findings.filter((finding) => finding.severity === severity).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.severity}`)
    .join(", ");
}
