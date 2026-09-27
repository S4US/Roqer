import assert from "node:assert/strict";
import test from "node:test";

import { isProviderStatus } from "./provider";

test("a missing client is a status the renderer accepts, apart from a failing one", () => {
  assert.equal(isProviderStatus({ kind: "not-installed", message: "Codex was not found on this computer." }), true);
  assert.equal(isProviderStatus({ kind: "unavailable", message: "Codex app-server is unavailable." }), true);
  assert.equal(isProviderStatus({ kind: "missing", message: "x" }), false);
  assert.equal(isProviderStatus({ kind: "not-installed" }), false);
});
