import assert from "node:assert/strict";
import test from "node:test";

import type { RojoView } from "../shared/rojo";
import {
  EMPTY_ROJO_VIEW, errorViewFromRejection, rojoLinkedNote, rojoPillActionable, rojoPillLinked, rojoPillVisual,
  shortRojoMessage, viewFromResult,
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
