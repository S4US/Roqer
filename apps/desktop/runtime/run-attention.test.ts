import assert from "node:assert/strict";
import test from "node:test";

import type { RunEvent, RunEventBody } from "../shared/run-events";
import { MAX_NOTICE_BODY_CHARS, RunAttention, type AttentionNotice, type AttentionSurface } from "./run-attention";

/** A window and a notification centre that record what was asked of them. */
class FakeSurface implements AttentionSurface {
  focusedNow = false;
  supported = true;
  flashes: boolean[] = [];
  notices: { notice: AttentionNotice; onClick: () => void; closed: boolean }[] = [];
  broughtForward = 0;

  isFocused(): boolean { return this.focusedNow; }
  flash(on: boolean): void { this.flashes.push(on); }
  notify(notice: AttentionNotice, onClick: () => void) {
    if (!this.supported) return null;
    const entry = { notice, onClick, closed: false };
    this.notices.push(entry);
    return { close: () => { entry.closed = true; } };
  }
  bringForward(): void { this.broughtForward += 1; }

  get flashing(): boolean { return this.flashes.at(-1) === true; }
}

let seq = 0;
function event(runId: string, body: RunEventBody): RunEvent {
  seq += 1;
  return { ...body, runId, seq, at: "2026-10-05T12:00:00.000Z" } as RunEvent;
}

const asked = (runId: string, callId: string, question = "Replace the old Trail, or keep both?"): RunEvent =>
  event(runId, { type: "question-asked", question: { callId, question, options: ["Replace it", "Keep both"] } });
const answered = (runId: string, callId: string): RunEvent =>
  event(runId, { type: "question-answered", callId, answerIndex: 0, answer: "Replace it", cancelled: false });
const approvalAsked = (runId: string, callId: string, summary = "Set Workspace.Sword.Handle.Trail.Enabled"): RunEvent =>
  event(runId, {
    type: "approval-requested",
    callId,
    proposal: { callId, tool: "set_property", arguments: {}, summary, risk: "mutation" },
    reason: "mutation-requires-approval",
  });
const approvalResolved = (runId: string, callId: string): RunEvent =>
  event(runId, { type: "approval-resolved", callId, decision: "approved", automatic: false, reason: "mutation-requires-approval" });
const completed = (runId: string): RunEvent =>
  event(runId, { type: "run-completed", outcome: "cancelled", summary: "Stopped.", verification: { verified: true, issues: [] } });

test("a question asked while the window is away flashes the taskbar and says what is being asked", () => {
  const surface = new FakeSurface();
  const attention = new RunAttention(surface);

  attention.observe(asked("run-1", "q-1"));

  assert.deepEqual(surface.flashes, [true]);
  assert.equal(surface.notices.length, 1);
  assert.deepEqual(surface.notices[0].notice, { title: "Roqer needs a decision", body: "Replace the old Trail, or keep both?" });

  // The notification only brings the window forward; the answer is given there.
  surface.notices[0].onClick();
  assert.equal(surface.broughtForward, 1);

  attention.observe(answered("run-1", "q-1"));
  assert.equal(surface.notices[0].closed, true);
  assert.deepEqual(surface.flashes, [true, false]);
});

test("someone already looking at the window is not told again", () => {
  const surface = new FakeSurface();
  surface.focusedNow = true;
  const attention = new RunAttention(surface);

  attention.observe(asked("run-1", "q-1"));
  attention.observe(approvalAsked("run-1", "a-1"));
  attention.observe(answered("run-1", "q-1"));
  attention.observe(approvalResolved("run-1", "a-1"));

  assert.deepEqual(surface.flashes, []);
  assert.equal(surface.notices.length, 0);
});

test("an approval is announced the same way, with its summary bounded", () => {
  const surface = new FakeSurface();
  const attention = new RunAttention(surface);

  attention.observe(approvalAsked("run-1", "a-1", `Run Luau ${"x".repeat(400)}`));

  const { notice } = surface.notices[0];
  assert.equal(notice.title, "Roqer needs your approval");
  assert.equal(notice.body.length, MAX_NOTICE_BODY_CHARS);
  assert.ok(notice.body.startsWith("Run Luau x"));
  assert.ok(notice.body.endsWith("…"));
  assert.ok(surface.flashing);
});

test("coming to the window stops the flashing, and the notification stays until the decision is made", () => {
  const surface = new FakeSurface();
  const attention = new RunAttention(surface);

  attention.observe(asked("run-1", "q-1"));
  attention.focused();
  assert.deepEqual(surface.flashes, [true, false]);
  assert.equal(surface.notices[0].closed, false);

  attention.observe(answered("run-1", "q-1"));
  assert.equal(surface.notices[0].closed, true);
  // Already stopped: the taskbar is not told twice.
  assert.deepEqual(surface.flashes, [true, false]);

  // A later decision, asked after the person looked away again, flashes again.
  surface.focusedNow = false;
  attention.observe(approvalAsked("run-1", "a-1"));
  assert.deepEqual(surface.flashes, [true, false, true]);
});

test("the flashing lasts until every decision the window is waiting on is made", () => {
  const surface = new FakeSurface();
  const attention = new RunAttention(surface);

  attention.observe(approvalAsked("run-1", "a-1"));
  attention.observe(asked("run-2", "q-1"));
  assert.deepEqual(surface.flashes, [true]);

  attention.observe(approvalResolved("run-1", "a-1"));
  assert.deepEqual(surface.flashes, [true]);
  attention.observe(answered("run-2", "q-1"));
  assert.deepEqual(surface.flashes, [true, false]);
});

test("a stopped run clears an approval that is never resolved by an event of its own", () => {
  const surface = new FakeSurface();
  const attention = new RunAttention(surface);

  attention.observe(approvalAsked("run-1", "a-1"));
  attention.observe(asked("run-2", "q-1"));
  // Cancelling rejects a pending approval without an approval-resolved event.
  attention.observe(completed("run-1"));

  assert.equal(surface.notices[0].closed, true);
  assert.equal(surface.notices[1].closed, false, "another run's question is still waiting");
  assert.ok(surface.flashing);

  // The session's own clean-up ends the run again; that is harmless.
  attention.endRun("run-1");
  attention.endRun("run-2");
  assert.equal(surface.notices[1].closed, true);
  assert.deepEqual(surface.flashes, [true, false]);
});

test("the same request seen twice is announced once", () => {
  const surface = new FakeSurface();
  const attention = new RunAttention(surface);

  attention.observe(asked("run-1", "q-1"));
  attention.observe(asked("run-1", "q-1"));

  assert.equal(surface.notices.length, 1);
  assert.deepEqual(surface.flashes, [true]);
});

test("without notifications the taskbar still flashes", () => {
  const surface = new FakeSurface();
  surface.supported = false;
  const attention = new RunAttention(surface);

  attention.observe(asked("run-1", "q-1"));
  assert.deepEqual(surface.flashes, [true]);

  attention.observe(answered("run-1", "q-1"));
  assert.deepEqual(surface.flashes, [true, false]);
});

test("closing the window takes down every notification and the flashing", () => {
  const surface = new FakeSurface();
  const attention = new RunAttention(surface);

  attention.observe(asked("run-1", "q-1"));
  attention.observe(approvalAsked("run-2", "a-1"));
  attention.clear();

  assert.ok(surface.notices.every((entry) => entry.closed));
  assert.deepEqual(surface.flashes, [true, false]);
});

test("events that ask nothing of the person are ignored", () => {
  const surface = new FakeSurface();
  const attention = new RunAttention(surface);

  attention.observe(event("run-1", { type: "message-delta", text: "Looking at the sword." }));
  attention.observe(approvalResolved("run-1", "never-asked"));
  attention.observe(completed("run-1"));

  assert.deepEqual(surface.flashes, []);
  assert.equal(surface.notices.length, 0);
});
