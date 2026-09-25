import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDITED_AFTER_LABEL, describeGateForModel, evaluateCompletion, isInterfaceTarget, summarizeGate, REVISION_AFTER_LABEL,
  UI_AUDIT_TITLE, type GateChange, type GateEvidence, type GateInput,
} from "./completion";
import type { RunTask } from "./tasks";

const SCRIPT = "game.ServerScriptService.Main";

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    outcome: "completed",
    tasks: [],
    changes: [],
    evidence: [],
    failureCount: 0,
    ...overrides,
  };
}

function scriptChange(revisionAfter?: string): GateChange {
  return { kind: "script-source", target: SCRIPT, revisionAfter };
}

function verification(passed: boolean, revision?: string): GateEvidence {
  return {
    kind: "verification",
    title: SCRIPT,
    passed,
    ...(revision ? { metadata: [{ label: REVISION_AFTER_LABEL, value: revision }] } : {}),
  };
}

function task(overrides: Partial<RunTask> = {}): RunTask {
  return { id: "t1", title: "Fix the door", status: "done", requiresRuntimeEvidence: false, ...overrides };
}

test("a clean read-only run is verified", () => {
  const result = evaluateCompletion(input());
  assert.equal(result.verified, true);
  assert.deepEqual(result.issues, []);
});

test("a script write read back at the same revision is verified", () => {
  const result = evaluateCompletion(input({
    changes: [scriptChange("rev-2")],
    evidence: [verification(true, "rev-2")],
  }));
  assert.equal(result.verified, true);
});

test("a script write read back at a different revision is not verified", () => {
  const result = evaluateCompletion(input({
    changes: [scriptChange("rev-2")],
    evidence: [verification(true, "rev-3")],
  }));
  assert.equal(result.verified, false);
  assert.equal(result.issues[0].code, "unverified-change");
  assert.match(result.issues[0].detail, /not read back at the revision/);
});

test("a script write with no read-back at all is not verified", () => {
  const result = evaluateCompletion(input({ changes: [scriptChange("rev-2")], evidence: [] }));
  assert.equal(result.verified, false);
  assert.equal(result.issues[0].code, "unverified-change");
});

test("a failed read-back counts against the run twice over", () => {
  const result = evaluateCompletion(input({
    changes: [scriptChange("rev-2")],
    evidence: [verification(false, "rev-2")],
  }));
  assert.equal(result.verified, false);
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("unverified-change"), "the change is still unverified");
  assert.ok(codes.includes("failed-evidence"), "and the failing check is named");
});

test("a later passing read-back resolves the earlier failed attempt", () => {
  const result = evaluateCompletion(input({
    changes: [scriptChange("rev-2")],
    evidence: [verification(false, "rev-2"), verification(true, "rev-2")],
  }));
  assert.equal(result.verified, true);
  assert.deepEqual(result.issues, []);
});

test("a property change needs host-recorded verification", () => {
  const unverified = evaluateCompletion(input({
    changes: [{ kind: "properties", target: "game.Workspace.Part" }],
  }));
  assert.equal(unverified.verified, false);
  assert.equal(unverified.issues[0].code, "unverified-change");

  const verified = evaluateCompletion(input({
    changes: [{ kind: "properties", target: "game.Workspace.Part" }],
    evidence: [{
      kind: "verification",
      changeKind: "properties",
      title: "game.Workspace.Part",
      passed: true,
    }],
  }));
  assert.equal(verified.verified, true);
});

test("a build needs Studio's read-back of the same root, not another kind of check", () => {
  const change = { kind: "instance", target: "game.Workspace.Island" };
  const unverified = evaluateCompletion(input({ changes: [change] }));
  assert.equal(unverified.verified, false);
  assert.match(unverified.issues[0].detail, /was built, but Studio's read-back/);

  // A property verification of the same path is evidence about something else.
  const wrongKind = evaluateCompletion(input({
    changes: [change],
    evidence: [{ kind: "verification", changeKind: "properties", title: "game.Workspace.Island", passed: true }],
  }));
  assert.equal(wrongKind.verified, false);

  const verified = evaluateCompletion(input({
    changes: [change],
    evidence: [{ kind: "verification", changeKind: "instance", title: "game.Workspace.Island", passed: true }],
  }));
  assert.equal(verified.verified, true);
});

test("a task that promised runtime evidence and has none fails the gate", () => {
  const result = evaluateCompletion(input({
    tasks: [task({ requiresRuntimeEvidence: true })],
  }));
  assert.equal(result.verified, false);
  assert.equal(result.issues[0].code, "missing-runtime-evidence");
  assert.match(result.issues[0].detail, /Fix the door/);
});

test("a passing playtest satisfies the runtime-evidence promise", () => {
  const result = evaluateCompletion(input({
    tasks: [task({ requiresRuntimeEvidence: true })],
    evidence: [{ kind: "playtest", title: "Door opens", passed: true }],
  }));
  assert.equal(result.verified, true);
});

test("typed evidence must match the task and required dimension", () => {
  const runtimeTask = task({ requiredEvidence: ["runtime"], requiresRuntimeEvidence: true });
  const screenshot = {
    kind: "screenshot",
    requirement: "visual" as const,
    taskId: "other-task",
    title: "Door",
    passed: true,
  };
  assert.equal(evaluateCompletion(input({ tasks: [runtimeTask], evidence: [screenshot] })).verified, false);

  const logs = { ...screenshot, kind: "logs", requirement: "runtime" as const };
  assert.equal(evaluateCompletion(input({ tasks: [runtimeTask], evidence: [logs] })).verified, false,
    "evidence attached to the wrong task must not satisfy this task");
  logs.taskId = "t1";
  assert.equal(evaluateCompletion(input({ tasks: [runtimeTask], evidence: [logs] })).verified, true);
});

test("typed evidence must be newer than the task's final change", () => {
  const visualTask = task({ requiredEvidence: ["visual"], requiresRuntimeEvidence: true });
  const change = { id: "change-2", kind: "properties", target: "game.Gui", taskId: visualTask.id };
  const propertyVerification = {
    kind: "verification",
    changeKind: "properties",
    title: "game.Gui",
    passed: true,
  };
  const stale = {
    kind: "screenshot",
    requirement: "visual" as const,
    taskId: visualTask.id,
    afterChangeId: "change-1",
    title: "Shop",
    passed: true,
  };
  assert.equal(evaluateCompletion(input({
    tasks: [visualTask], changes: [change], evidence: [propertyVerification, stale],
  })).verified, false);

  const fresh = { ...stale, afterChangeId: "change-2" };
  assert.equal(evaluateCompletion(input({
    tasks: [visualTask], changes: [change], evidence: [propertyVerification, fresh],
  })).verified, true);
});

test("a verifying task is held to the run's changes, not to its own", () => {
  // The shape a real run produces: one task edits, a second exists only to
  // observe. The observing task makes no changes, so "newer than this task's
  // last change" was vacuous for it -- and a screenshot carrying no stamp at
  // all was accepted as fresh visual evidence of work another task had done.
  const verifyTask = task({
    id: "verify", title: "Visually verify the preview",
    requiredEvidence: ["visual"], requiresRuntimeEvidence: true,
  });
  const change = { id: "change-19", kind: "properties", target: "game.Gui.Card6", taskId: "update" };
  const propertyVerification = {
    kind: "verification", changeKind: "properties", title: "game.Gui.Card6", passed: true,
  };
  const unstamped = {
    kind: "screenshot", requirement: "visual" as const, taskId: "verify",
    title: "Studio screenshot", passed: true,
  };

  const result = evaluateCompletion(input({
    tasks: [verifyTask], changes: [change], evidence: [propertyVerification, unstamped],
  }));
  assert.equal(result.verified, false);
  assert.equal(result.issues[0].code, "missing-runtime-evidence");

  // Stamped against the run's last change, it is evidence of the final state.
  const stamped = { ...unstamped, afterChangeId: "change-19" };
  assert.equal(evaluateCompletion(input({
    tasks: [verifyTask], changes: [change], evidence: [propertyVerification, stamped],
  })).verified, true);

  // And a screenshot taken before the last edit is stale, which is the whole
  // point: it cannot show what the run finished doing.
  const stale = { ...unstamped, afterChangeId: "change-13" };
  assert.equal(evaluateCompletion(input({
    tasks: [verifyTask], changes: [change], evidence: [propertyVerification, stale],
  })).verified, false);
});

test("a failed playtest does not satisfy the promise", () => {
  const result = evaluateCompletion(input({
    tasks: [task({ requiresRuntimeEvidence: true })],
    evidence: [{ kind: "playtest", title: "Door opens", passed: false }],
  }));
  assert.equal(result.verified, false);
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("missing-runtime-evidence"));
  assert.ok(codes.includes("failed-evidence"));
});

test("a blocked task is reported as unfinished, and its evidence promise is not yet due", () => {
  const result = evaluateCompletion(input({
    tasks: [task({ status: "blocked", requiresRuntimeEvidence: true })],
  }));
  assert.equal(result.verified, false);
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ["task-incomplete"],
    "blocked work is incomplete, but it did not promise evidence it now owes",
  );
  assert.match(result.issues[0].detail, /blocked and never finished/);
});

test("tasks left open when the run ended are reported", () => {
  const result = evaluateCompletion(input({
    tasks: [task({ id: "a", status: "done" }), task({ id: "b", title: "Wire the button", status: "pending" })],
  }));
  assert.equal(result.verified, false);
  assert.equal(result.issues[0].code, "task-incomplete");
  assert.match(result.issues[0].detail, /Wire the button/);
});

test("a recovered tool failure stays visible without poisoning completion", () => {
  const result = evaluateCompletion(input({ failureCount: 2 }));
  assert.equal(result.verified, true);
  assert.deepEqual(result.issues, []);
});

test("only a completed run is assessed", () => {
  for (const outcome of ["cancelled", "failed", "refused"]) {
    const result = evaluateCompletion(input({ outcome, changes: [scriptChange("rev-1")] }));
    assert.equal(result.verified, false, `${outcome} is never verified`);
    assert.deepEqual(result.issues, [], `${outcome} is labelled by its outcome, not by evidence complaints`);
  }
});

test("the model is told what to do about a failed gate", () => {
  const failing = evaluateCompletion(input({ changes: [scriptChange("rev-2")] }));
  const message = describeGateForModel(failing);
  assert.ok(message);
  assert.match(message, /not fully backed by evidence/);
  assert.match(message, /say so plainly/);
  assert.equal(describeGateForModel({ verified: true, issues: [] }), undefined);
});

test("the one-line summary counts the rest", () => {
  assert.equal(summarizeGate({ verified: true, issues: [] }), undefined);
  assert.equal(
    summarizeGate({ verified: false, issues: [{ code: "tool-failure", detail: "One step failed." }] }),
    "One step failed.",
  );
  assert.equal(
    summarizeGate({
      verified: false,
      issues: [
        { code: "tool-failure", detail: "One step failed." },
        { code: "task-incomplete", detail: "\"x\" was still open." },
      ],
    }),
    "One step failed. (+1 more)",
  );
});

const SHOP = "game.StarterGui.ShopGui";
const shopBuild = (id: string): GateChange => ({ id, kind: "instance", target: SHOP });
const shopVerified: GateEvidence = { kind: "verification", changeKind: "instance", title: SHOP, passed: true };
const audit = (passed: boolean, after: string, taskId?: string): GateEvidence => ({
  kind: "inspection", title: UI_AUDIT_TITLE, requirement: "visual", passed,
  metadata: [{ label: "Problems", value: passed ? "0" : "3" }, { label: AUDITED_AFTER_LABEL, value: after }],
  ...(taskId === undefined ? {} : { taskId }),
});

test("interface is recognised under StarterGui or a PlayerGui, and nowhere else", () => {
  assert.equal(isInterfaceTarget("game.StarterGui"), true);
  assert.equal(isInterfaceTarget("game.StarterGui.ShopGui.Frame"), true);
  assert.equal(isInterfaceTarget("game.Players.Ada.PlayerGui.ShopGui"), true);
  assert.equal(isInterfaceTarget("game.Workspace.StarterGuiSign"), false);
  assert.equal(isInterfaceTarget("game.ReplicatedStorage.UI"), false);
});

test("interface changed with no audit afterwards is not verified, whatever the screenshot showed", () => {
  const screenshot: GateEvidence = { kind: "screenshot", title: "Studio screenshot", requirement: "visual", passed: true };
  const result = evaluateCompletion(input({ changes: [shopBuild("c1")], evidence: [shopVerified, screenshot] }));
  assert.equal(result.verified, false);
  assert.deepEqual(result.issues.map((item) => item.code), ["unaudited-interface"]);
  assert.match(result.issues[0].detail, /no inspect_ui audit ran/);
});

test("a clean audit after the last interface change verifies it; one before a later change does not", () => {
  assert.equal(evaluateCompletion(input({ changes: [shopBuild("c1")], evidence: [shopVerified, audit(true, "c1")] })).verified, true);
  const stale = evaluateCompletion(input({
    changes: [shopBuild("c1"), shopBuild("c2")], evidence: [shopVerified, audit(true, "c1")],
  }));
  assert.deepEqual(stale.issues.map((item) => item.code), ["unaudited-interface"]);
  // A later change elsewhere in the place does not make the audit stale.
  const elsewhere = evaluateCompletion(input({
    changes: [shopBuild("c1"), { id: "c2", kind: "script-source", target: SCRIPT }],
    evidence: [shopVerified, audit(true, "c2"), verification(true)],
  }));
  assert.equal(elsewhere.verified, true, JSON.stringify(elsewhere.issues));
});

test("the latest audit is what counts: problems left unfixed fail, a later clean audit from any task passes", () => {
  const unfixed = evaluateCompletion(input({ changes: [shopBuild("c1")], evidence: [shopVerified, audit(false, "c1")] }));
  assert.deepEqual(unfixed.issues.map((item) => item.code), ["unaudited-interface"]);
  assert.match(unfixed.issues[0].detail, /still reported problems/);
  const fixed = evaluateCompletion(input({
    changes: [shopBuild("c1"), shopBuild("c2")],
    evidence: [shopVerified, audit(false, "c1", "build"), audit(true, "c2", "verify")],
  }));
  assert.equal(fixed.verified, true, JSON.stringify(fixed.issues));
  // A run that never touched interface needs no audit.
  assert.equal(evaluateCompletion(input({ changes: [scriptChange()], evidence: [verification(true)] })).verified, true);
});
