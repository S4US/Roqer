import assert from "node:assert/strict";
import test from "node:test";

import {
  appUpdateMessage,
  canInstallUpdate,
  isAppUpdateState,
  updateInProgress,
  type AppUpdateState,
} from "./app-update";

test("only a downloaded update may be installed", () => {
  assert.equal(canInstallUpdate({ kind: "ready", version: "1.2.0" }), true);
  // Everything else is progress or nothing, and must not offer a restart.
  for (const state of [
    { kind: "idle" },
    { kind: "checking" },
    { kind: "available", version: "1.2.0" },
    { kind: "downloading", version: "1.2.0", percent: 99 },
    { kind: "unsupported", message: "no feed" },
    { kind: "failed", message: "nope" },
  ] as AppUpdateState[]) {
    assert.equal(canInstallUpdate(state), false, `${state.kind} must not offer an install`);
  }
});

test("an update on its way is shown as progress, and nothing else is", () => {
  // The download is the part that takes minutes, and the install button only
  // appears when it is over. These two states are the whole of that wait.
  assert.equal(updateInProgress({ kind: "available", version: "1.2.0" }), true);
  assert.equal(updateInProgress({ kind: "downloading", version: "1.2.0", percent: 12 }), true);
  // Checking is a second every few hours; a sidebar that flickered for it
  // would be noise. Ready has its own button. The rest have nothing to show.
  for (const state of [
    { kind: "idle" },
    { kind: "checking" },
    { kind: "ready", version: "1.2.0" },
    { kind: "unsupported", message: "no feed" },
    { kind: "failed", message: "nope" },
  ] as AppUpdateState[]) {
    assert.equal(updateInProgress(state), false, `${state.kind} is not progress`);
  }
});

test("update state that crossed the bridge is validated, not trusted", () => {
  assert.equal(isAppUpdateState({ kind: "idle" }), true);
  assert.equal(isAppUpdateState({ kind: "ready", version: "1.2.0" }), true);
  assert.equal(isAppUpdateState({ kind: "downloading", version: "1.2.0", percent: 0 }), true);

  assert.equal(isAppUpdateState({ kind: "ready" }), false);
  assert.equal(isAppUpdateState({ kind: "ready", version: "" }), false);
  // A percentage outside the range would render as a nonsense progress bar.
  assert.equal(isAppUpdateState({ kind: "downloading", version: "1.2.0", percent: 101 }), false);
  assert.equal(isAppUpdateState({ kind: "downloading", version: "1.2.0", percent: -1 }), false);
  assert.equal(isAppUpdateState({ kind: "downloading", version: "1.2.0", percent: Number.NaN }), false);
  assert.equal(isAppUpdateState({ kind: "installing" }), false);
  assert.equal(isAppUpdateState(null), false);
});

test("every state has something a person can read", () => {
  const states: AppUpdateState[] = [
    { kind: "idle" },
    { kind: "checking" },
    { kind: "available", version: "1.2.0" },
    { kind: "downloading", version: "1.2.0", percent: 42.6 },
    { kind: "ready", version: "1.2.0" },
    { kind: "unsupported", message: "This build has no update feed." },
    { kind: "failed", message: "Roqer could not check for updates." },
  ];
  for (const state of states) assert.ok(appUpdateMessage(state).length > 0, state.kind);

  // A fractional percentage from the provider is rounded rather than shown raw.
  assert.match(appUpdateMessage({ kind: "downloading", version: "1.2.0", percent: 42.6 }), /43%/);
  // The two states that carry their own wording say it verbatim.
  assert.equal(appUpdateMessage({ kind: "failed", message: "Roqer could not check for updates." }),
    "Roqer could not check for updates.");
});
