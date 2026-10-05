import assert from "node:assert/strict";
import test from "node:test";

import { accountDetail } from "./account-detail";

test("a signed-in account names the client it runs through, with the version that client reported", () => {
  assert.equal(accountDetail({ kind: "signed-in", message: "Plus connected through Codex", planType: "plus", email: "me@example.com", clientVersion: "0.160.0" }, "Codex"),
    "Plus · me@example.com · through Codex 0.160.0");
  assert.equal(accountDetail({ kind: "signed-in", message: "Max connected through Claude Code", planType: "max", clientVersion: "2.1.289" }, "Claude Code"),
    "Max · through Claude Code 2.1.289");
  // A client that did not answer is still named, without a version.
  assert.equal(accountDetail({ kind: "signed-in", message: "Pro connected through Claude Code", planType: "pro" }, "Claude Code"),
    "Pro · through Claude Code");
});

test("an account that is not signed in keeps its message, followed by the client's version when known", () => {
  assert.equal(accountDetail({ kind: "signed-out", message: "Connect your ChatGPT subscription", clientVersion: "0.160.0" }, "Codex"),
    "Connect your ChatGPT subscription · Codex 0.160.0");
  assert.equal(accountDetail({ kind: "unavailable", message: "Codex app-server is unavailable: closed.", clientVersion: "0.149.0" }, "Codex"),
    "Codex app-server is unavailable: closed. · Codex 0.149.0");
  assert.equal(accountDetail({ kind: "signed-out", message: "Connect your Claude subscription" }, "Claude Code"),
    "Connect your Claude subscription");
  assert.equal(accountDetail({ kind: "not-installed", message: "Codex was not found on this computer. Install it to use ChatGPT.", installable: true }, "Codex"),
    "Codex was not found on this computer. Install it to use ChatGPT.");
  assert.equal(accountDetail({ kind: "checking", message: "Checking…" }, "Codex"), "Checking…");
});
