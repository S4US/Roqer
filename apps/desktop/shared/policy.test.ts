import assert from "node:assert/strict";
import test from "node:test";
import {
  decideToolPolicy,
  describePolicyReason,
  type ApprovalMode,
  type PolicyReason,
  type ToolRisk,
} from "./policy.js";

/**
 * Table-driven test covering all 12 combinations of approval mode × risk level.
 * This makes the full decision matrix visible at a glance.
 */
test("decideToolPolicy - full decision matrix", () => {
  const cases: Array<{
    mode: ApprovalMode;
    risk: ToolRisk;
    expectedOutcome: "allow" | "ask" | "deny";
    expectedReason: PolicyReason;
  }> = [
    // read risk → always allow
    { mode: "Read only", risk: "read", expectedOutcome: "allow", expectedReason: "read-allowed" },
    { mode: "Ask first", risk: "read", expectedOutcome: "allow", expectedReason: "read-allowed" },
    { mode: "Auto approve", risk: "read", expectedOutcome: "allow", expectedReason: "read-allowed" },
    { mode: "Full auto", risk: "read", expectedOutcome: "allow", expectedReason: "read-allowed" },

    // mutation risk
    { mode: "Read only", risk: "mutation", expectedOutcome: "deny", expectedReason: "read-only-mode" },
    { mode: "Ask first", risk: "mutation", expectedOutcome: "ask", expectedReason: "mutation-requires-approval" },
    { mode: "Auto approve", risk: "mutation", expectedOutcome: "allow", expectedReason: "auto-approved" },
    { mode: "Full auto", risk: "mutation", expectedOutcome: "allow", expectedReason: "full-auto-approved" },

    // irreversible risk
    { mode: "Read only", risk: "irreversible", expectedOutcome: "deny", expectedReason: "read-only-mode" },
    { mode: "Ask first", risk: "irreversible", expectedOutcome: "ask", expectedReason: "irreversible-requires-approval" },
    { mode: "Auto approve", risk: "irreversible", expectedOutcome: "ask", expectedReason: "irreversible-requires-approval" },
    // The one mode that waives the always-confirm rule, because selecting it is
    // itself the user's confirmation for the whole run.
    { mode: "Full auto", risk: "irreversible", expectedOutcome: "allow", expectedReason: "full-auto-approved" },
  ];

  for (const { mode, risk, expectedOutcome, expectedReason } of cases) {
    const decision = decideToolPolicy(mode, risk);
    assert.strictEqual(
      decision.outcome,
      expectedOutcome,
      `decideToolPolicy("${mode}", "${risk}") outcome should be ${expectedOutcome}, got ${decision.outcome}`,
    );
    assert.strictEqual(
      decision.reason,
      expectedReason,
      `decideToolPolicy("${mode}", "${risk}") reason should be ${expectedReason}, got ${decision.reason}`,
    );
  }
});

/**
 * Safety rule: Auto approve must never return "allow" for an irreversible action.
 * This is critical — auto approval covers ordinary, recoverable edits only.
 */
test("decideToolPolicy - irreversible actions always require approval even in Auto approve", () => {
  const decision = decideToolPolicy("Auto approve", "irreversible");
  assert.strictEqual(
    decision.outcome,
    "ask",
    "Auto approve + irreversible must return 'ask', never 'allow'",
  );
  assert.strictEqual(
    decision.reason,
    "irreversible-requires-approval",
    "Reason must be irreversible-requires-approval",
  );
});

/**
 * All policy reasons must have non-empty descriptions.
 */
test("describePolicyReason - covers all reasons with non-empty strings", () => {
  const reasons: PolicyReason[] = [
    "read-allowed",
    "auto-approved",
    "full-auto-approved",
    "run-cleanup",
    "previously-rejected",
    "equivalent-action-pending",
    "mutation-requires-approval",
    "irreversible-requires-approval",
    "read-only-mode",
  ];

  for (const reason of reasons) {
    const description = describePolicyReason(reason);
    assert.strictEqual(
      typeof description,
      "string",
      `describePolicyReason("${reason}") should return a string`,
    );
    assert.ok(
      description.length > 0,
      `describePolicyReason("${reason}") returned empty string`,
    );
  }
});
