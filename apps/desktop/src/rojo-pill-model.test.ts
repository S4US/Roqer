import assert from "node:assert/strict";
import test from "node:test";

import type { RojoView } from "../shared/rojo";
import {
  EMPTY_ROJO_VIEW, errorViewFromRejection, RojoPillSequence, rojoLinkedNote, rojoPillActionable, rojoPillLinked,
  rojoPillTone, rojoPillVisual, rojoPopoverHeadline, shortRojoMessage, viewFromResult,
} from "./rojo-pill-model";

const base: RojoView = { instanceId: "place:1", published: true, state: "no-place", recent: [] };

test("every pill state renders the design spec's §4.1 label, colour and emphasis", () => {
  assert.deepEqual(rojoPillVisual({ ...base, state: "no-place" }), { label: "Rojo · no place", dot: "none", dashed: false, muted: true });
  assert.deepEqual(rojoPillVisual({ ...base, state: "not-linked" }), { label: "Rojo · not linked", dot: "none", dashed: false, muted: true });
  assert.deepEqual(rojoPillVisual({ ...base, state: "detected" }), { label: "Link Rojo project", dot: "accent", dashed: true, muted: false });
  assert.deepEqual(
    rojoPillVisual({ ...base, state: "linked-running", project: { fileName: "default.project.json", folder: "/x" } }),
    { label: "Rojo · default.project.json", dot: "green", dashed: false, muted: false },
  );
  assert.deepEqual(rojoPillVisual({ ...base, state: "linked-stopped" }), { label: "Rojo not running", dot: "amber", dashed: false, muted: false });
  assert.deepEqual(rojoPillVisual({ ...base, state: "error", message: "rojo not found" }), { label: "Rojo · rojo not found", dot: "red", dashed: false, muted: false });
});

test("a linked pill with no project field yet still has a label, never blank", () => {
  assert.equal(rojoPillVisual({ ...base, state: "linked-running" }).label, "Rojo · a project");
});

test("shortRojoMessage trims a long one-line failure for the pill itself", () => {
  assert.equal(shortRojoMessage(undefined), "a problem");
  assert.equal(shortRojoMessage("  "), "a problem");
  assert.equal(shortRojoMessage("rojo not found"), "rojo not found");
  const long = "This Roqer bridge is older than the app; quit other Roqer or Codex bridges and restart Roqer.";
  const short = shortRojoMessage(long);
  assert.equal(short.length, 40);
  assert.ok(short.endsWith("…"));
});

test("only no-place has nothing to act on; only the two linked states use the linked layout", () => {
  assert.equal(rojoPillActionable("no-place"), false);
  for (const state of ["not-linked", "detected", "linked-running", "linked-stopped", "error"] as const) {
    assert.equal(rojoPillActionable(state), true);
  }
  assert.equal(rojoPillLinked("linked-running"), true);
  assert.equal(rojoPillLinked("linked-stopped"), true);
  for (const state of ["no-place", "not-linked", "detected", "error"] as const) {
    assert.equal(rojoPillLinked(state), false);
  }
});

test("the linked note names the published/unpublished lifetime the spec describes", () => {
  assert.match(rojoLinkedNote(true), /restart/);
  assert.match(rojoLinkedNote(false), /Studio session/);
});

test("the linked note names the place, as the approved mockup shows, and falls back without one", () => {
  assert.equal(rojoLinkedNote(true, "Creator Empire"), "Linked to Creator Empire · relinks automatically after a restart.");
  assert.equal(rojoLinkedNote(false, "Creator Empire"), "Linked to Creator Empire · until this Studio session closes.");
  assert.equal(rojoLinkedNote(true), "Linked to this place · relinks automatically after a restart.");
  assert.equal(rojoLinkedNote(true, undefined), "Linked to this place · relinks automatically after a restart.");
});

test("rojoPillTone maps each dot colour to the one soft-tint tone the pill and popover share", () => {
  assert.equal(rojoPillTone("none"), "none");
  assert.equal(rojoPillTone("accent"), "accent");
  assert.equal(rojoPillTone("green"), "success");
  assert.equal(rojoPillTone("amber"), "warning");
  assert.equal(rojoPillTone("red"), "danger");
});

test("rojoPopoverHeadline gives each state the approved mockup's exact wording, or nothing for the two quiet states", () => {
  assert.equal(rojoPopoverHeadline({ ...base, state: "no-place" }), undefined);
  assert.equal(rojoPopoverHeadline({ ...base, state: "not-linked" }), undefined);
  assert.equal(
    rojoPopoverHeadline({ ...base, state: "detected", server: { port: 34872, answering: true, projectName: "CreatorEmpire" } }),
    "Rojo is serving CreatorEmpire",
  );
  assert.equal(rojoPopoverHeadline({ ...base, state: "detected" }), "Rojo is serving a project");
  assert.equal(
    rojoPopoverHeadline({ ...base, state: "linked-running", project: { fileName: "default.project.json", folder: "/x" } }),
    "Synced with default.project.json",
  );
  assert.equal(rojoPopoverHeadline({ ...base, state: "linked-running" }), "Synced with a project");
  assert.equal(rojoPopoverHeadline({ ...base, state: "linked-stopped" }), "Rojo is not running");
  assert.equal(rojoPopoverHeadline({ ...base, state: "error", message: "rojo not found" }), "rojo not found");
  assert.equal(rojoPopoverHeadline({ ...base, state: "error" }), "Rojo could not complete that request.");
});

test("viewFromResult reads the attached view as-is on success", () => {
  const view: RojoView = { ...base, state: "linked-running" };
  assert.equal(viewFromResult({ ok: true, view }, "place:1"), view);
});

test("viewFromResult keeps a failure's attached view but lays its message onto it, rather than dropping the message", () => {
  const view: RojoView = { ...base, state: "linked-running", project: { fileName: "default.project.json", folder: "/x" } };
  const failed = viewFromResult({ ok: false, message: "Already linked to another place", view }, "place:1");
  assert.deepEqual(failed, { ...view, message: "Already linked to another place" });
});

test("viewFromResult falls back to an error view, never silence, when a refusal carries no view", () => {
  const view = viewFromResult({ ok: false, message: "That place is not connected." }, "place:2");
  assert.equal(view.state, "error");
  assert.equal(view.instanceId, "place:2");
  assert.equal(view.message, "That place is not connected.");
});

test("errorViewFromRejection turns a thrown error into an error view carrying its message", () => {
  const view = errorViewFromRejection(new Error("The link channel disconnected."), "place:1");
  assert.equal(view.state, "error");
  assert.equal(view.instanceId, "place:1");
  assert.equal(view.message, "The link channel disconnected.");
  assert.deepEqual(view.recent, []);
});

test("errorViewFromRejection falls back to a plain message for a non-Error rejection", () => {
  const view = errorViewFromRejection("boom", null);
  assert.equal(view.state, "error");
  assert.equal(view.instanceId, null);
  assert.equal(view.message, "Rojo could not complete that request.");
});

test("EMPTY_ROJO_VIEW is the quiet no-place pill, for before anything has loaded", () => {
  assert.equal(EMPTY_ROJO_VIEW.state, "no-place");
  assert.equal(EMPTY_ROJO_VIEW.instanceId, null);
});

/**
 * Reproduces the real bug: the pill has two independent sources for its
 * view -- the periodic background refresh (`refreshSignal` ticking, see
 * `App.tsx`'s 5s interval) and an explicit action (Retry, Choose a
 * project..., Unlink, ...) -- and nothing orders their `setView` calls
 * against each other. A background refresh issued right before the user
 * clicks Retry is still in flight when Retry's own result comes back, and
 * can resolve afterwards: the pill then shows the stale, pre-retry view
 * (the error Retry was supposed to clear) right after the fresh one.
 *
 * `RojoPillSequence` is the fix: a ticket an action bumps past (on start and
 * on resolve) so a background refresh issued before or during it is
 * recognised as stale and discarded once it finally resolves.
 */
function viewOf(state: RojoView["state"], message?: string): RojoView {
  return { instanceId: "place:1", published: true, state, recent: [], ...(message !== undefined ? { message } : {}) };
}

test(
  "without RojoPillSequence, a background refresh that resolves after Retry's own success clobbers it with the stale error",
  () => {
    const views: RojoView[] = [];
    const set = (view: RojoView) => views.push(view);

    // The background refresh was issued while the pill still showed the
    // error (before Retry was clicked), so its own result -- fetched then,
    // delivered later -- still carries that error.
    const refreshResult = viewOf("error", "No project file at C:\\Rojo Fixture\\default.project.json");
    const retrySuccess = viewOf("linked-running");

    // Retry resolves first (fast bridge call)...
    set(retrySuccess);
    // ...but the slower background refresh, already in flight when Retry was
    // clicked, resolves after it and wins with no guard against it.
    set(refreshResult);

    assert.deepEqual(views.at(-1), refreshResult, "demonstrates the bug: the stale error ends up on screen last");
  },
);

test("RojoPillSequence discards a background refresh issued before an action that resolves after it", () => {
  const sequence = new RojoPillSequence();
  const views: RojoView[] = [];
  const apply = (view: RojoView, ticket?: number) => {
    if (ticket === undefined || sequence.isCurrent(ticket)) views.push(view);
  };

  // The background refresh starts first (still showing the error)...
  const refreshTicket = sequence.startRefresh();
  // ...then the user clicks Retry: this must supersede that refresh even
  // though the refresh hasn't resolved yet.
  sequence.bump();

  // Retry resolves and applies unconditionally -- it is always authoritative.
  sequence.bump();
  apply(viewOf("linked-running"));

  // The background refresh finally resolves, carrying what it saw before
  // Retry ran (still the error) -- it must be discarded, not applied.
  apply(viewOf("error", "No project file at C:\\Rojo Fixture\\default.project.json"), refreshTicket);

  assert.deepEqual(views, [viewOf("linked-running")], "the stale refresh never reaches the view");
});

test("RojoPillSequence discards a background refresh issued during an action, once the action resolves", () => {
  const sequence = new RojoPillSequence();
  const views: RojoView[] = [];
  const apply = (view: RojoView, ticket?: number) => {
    if (ticket === undefined || sequence.isCurrent(ticket)) views.push(view);
  };

  // Retry starts (bumps past any earlier refresh)...
  sequence.bump();
  // ...and while it is still in flight, a background refresh starts too,
  // capturing a ticket that is current *right now*.
  const refreshTicket = sequence.startRefresh();

  // Retry resolves: it supersedes that refresh (which read stale,
  // pre-success state) and applies its own result unconditionally.
  sequence.bump();
  apply(viewOf("linked-running"));

  // The refresh resolves after Retry, but its ticket is now stale.
  apply(viewOf("error", "No project file at C:\\Rojo Fixture\\default.project.json"), refreshTicket);

  assert.deepEqual(views, [viewOf("linked-running")], "a refresh started mid-action is still discarded once the action wins");
});

test("RojoPillSequence applies a background refresh normally when nothing else is happening", () => {
  const sequence = new RojoPillSequence();
  const views: RojoView[] = [];
  const apply = (view: RojoView, ticket: number) => { if (sequence.isCurrent(ticket)) views.push(view); };

  const ticket = sequence.startRefresh();
  apply(viewOf("linked-running"), ticket);

  assert.deepEqual(views, [viewOf("linked-running")]);
});
