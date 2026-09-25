/**
 * Approval policy for agent-driven Roblox Studio work.
 *
 * The policy engine is deliberately pure. It takes the execution mode the user
 * selected and the risk of one proposed tool call, and returns a decision. The
 * run engine owns the consequences — asking the user, refusing, or proceeding —
 * so these rules can be reasoned about and tested without a live MCP server or
 * a running Studio instance.
 *
 * `Auto approve` covers ordinary, recoverable project edits only: an
 * irreversible action still requires an explicit confirmation there, and that
 * rule must not be relaxed. `Full auto` is the one mode that waives it, and it
 * waives it because choosing the mode *is* the confirmation — the user is
 * saying, in advance and for every action in the run, that Roqer may
 * publish, spend, and run arbitrary Luau unattended. Nothing else may widen
 * what a mode covers; only the user picking this one.
 */

export type ApprovalMode = "Ask first" | "Auto approve" | "Full auto" | "Read only";

/**
 * How much damage one tool call can do.
 *
 * - `read`         inspects Studio without changing it.
 * - `mutation`     an ordinary project edit that Studio's change history can undo.
 * - `irreversible` publishing, spending, arbitrary code execution, Studio
 *                  lifecycle control, or a broad multi-script rewrite. These
 *                  leave the undo stack or the local machine, so the user must
 *                  confirm each one.
 */
export type ToolRisk = "read" | "mutation" | "irreversible";

export type PolicyReason =
  | "read-allowed"
  | "auto-approved"
  | "full-auto-approved"
  | "run-cleanup"
  | "previously-rejected"
  | "equivalent-action-pending"
  | "mutation-requires-approval"
  | "irreversible-requires-approval"
  | "read-only-mode";

export type PolicyOutcome = "allow" | "ask" | "deny";

export type PolicyDecision = {
  outcome: PolicyOutcome;
  reason: PolicyReason;
};

/** Decide whether a tool call may run, needs confirmation, or must be refused. */
export function decideToolPolicy(mode: ApprovalMode, risk: ToolRisk): PolicyDecision {
  if (risk === "read") return { outcome: "allow", reason: "read-allowed" };
  if (mode === "Read only") return { outcome: "deny", reason: "read-only-mode" };
  // Checked ahead of the irreversible rule, and only here: this is the mode the
  // user selects to run a whole session unattended.
  if (mode === "Full auto") return { outcome: "allow", reason: "full-auto-approved" };
  if (risk === "irreversible") return { outcome: "ask", reason: "irreversible-requires-approval" };
  if (mode === "Auto approve") return { outcome: "allow", reason: "auto-approved" };
  return { outcome: "ask", reason: "mutation-requires-approval" };
}

/** Short sentence explaining a decision, shown next to the approval prompt. */
export function describePolicyReason(reason: PolicyReason): string {
  switch (reason) {
    case "read-allowed":
      return "Reading Studio state does not change your project.";
    case "auto-approved":
      return "Auto approve covers ordinary, recoverable project edits.";
    case "full-auto-approved":
      return "Full auto runs every permitted action without asking, including ones that cannot be undone.";
    case "run-cleanup":
      return "Roqer is restoring playtest state created by this run.";
    case "previously-rejected":
      return "The same effective action was already rejected during this run.";
    case "equivalent-action-pending":
      return "The same effective action is already awaiting a decision.";
    case "mutation-requires-approval":
      return "This changes your project, and the current mode asks first.";
    case "irreversible-requires-approval":
      return "This action cannot be undone from Studio, so it always needs confirmation.";
    case "read-only-mode":
      return "Read only mode blocks every change to your project.";
  }
}
