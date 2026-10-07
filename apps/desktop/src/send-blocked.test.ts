import assert from "node:assert/strict";
import test from "node:test";

import { sendBlockedNotice } from "./send-blocked";

test("a signed-out account is named, and the message is said to be kept", () => {
  assert.equal(
    sendBlockedNotice("chatgpt", { kind: "signed-out", message: "Connect your ChatGPT subscription" }),
    "Your message wasn't sent. Connect your ChatGPT account below to send it. It's still in the box.",
  );
});

test("a missing or failing client says what the provider reported", () => {
  assert.equal(
    sendBlockedNotice("claude", { kind: "not-installed", message: "Claude Code was not found on this computer. Install it to use Claude." }),
    "Your message wasn't sent. Claude Code was not found on this computer. Install it to use Claude. It's still in the box.",
  );
  assert.equal(
    sendBlockedNotice("claude", { kind: "unavailable", message: "Claude Code did not answer" }),
    "Your message wasn't sent. Claude Code did not answer. It's still in the box.",
  );
});

test("a signed-in account with no model says why there is none when the catalog did", () => {
  assert.equal(
    sendBlockedNotice("chatgpt", { kind: "signed-in", message: "Signed in" }, "The ChatGPT model list could not be loaded."),
    "Your message wasn't sent. The ChatGPT model list could not be loaded. It's still in the box.",
  );
  assert.equal(
    sendBlockedNotice("chatgpt", { kind: "signed-in", message: "Signed in" }),
    "Your message wasn't sent. ChatGPT has no model Roqer can run right now. It's still in the box.",
  );
});

test("custom endpoints are spoken of as endpoints, not an account", () => {
  assert.equal(
    sendBlockedNotice("custom", { kind: "signed-out", message: "Add an endpoint for your own models in Settings → Models." }),
    "Your message wasn't sent. Add an endpoint for your own models in Settings → Models. It's still in the box.",
  );
  assert.equal(
    sendBlockedNotice("custom", { kind: "checking", message: "Checking provider" }),
    "Your message wasn't sent. Roqer is still checking your endpoints. Try again in a moment. It's still in the box.",
  );
});
